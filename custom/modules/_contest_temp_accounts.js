'use strict';

const crypto = require('crypto');
const multer = require('multer');
const TypeORM = require('typeorm');
const contestMutation = require('../libs/contest-mutation');
const {
  appendPlayersToRanklist,
  csvCell,
  inputError,
  isLoginAllowed,
  normalizeRows,
  uniqueUsername,
  usernamePart
} = require('../libs/contest-temp-accounts');

const Contest = syzoj.model('contest');
const User = syzoj.model('user');
const MAX_CSV_SIZE = 1024 * 1024;
const expiryByUserId = new Map();
let expiryCacheReady = false;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CSV_SIZE, files: 1 },
  fileFilter: (req, file, callback) => {
    if (/\.csv$/i.test(String(file.originalname || ''))) return callback(null, true);
    callback(inputError('仅支持 .csv 文件。'));
  }
}).single('accounts_csv');

let schemaPromise = null;
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = TypeORM.getConnection().query(`
      CREATE TABLE IF NOT EXISTS temporary_contest_account (
        contest_id INT NOT NULL,
        user_id INT NOT NULL,
        expires_at INT NOT NULL,
        created_at INT NOT NULL,
        created_by INT NOT NULL,
        PRIMARY KEY (contest_id,user_id),
        UNIQUE KEY uq_temporary_contest_account_user (user_id),
        KEY idx_temporary_contest_account_expiry (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `).catch(error => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

ensureSchema().catch(error => {
  syzoj.log('[temporary-contest-account] schema initialization failed: ' + (error.stack || error));
  process.exit(1);
});
syzoj.utils.ensureTemporaryContestAccountSchema = ensureSchema;

async function refreshExpiryCache() {
  await ensureSchema();
  const rows = await TypeORM.getConnection().query(
    `SELECT account.user_id,COALESCE(contest.end_time,account.expires_at) AS expires_at
     FROM temporary_contest_account account
     LEFT JOIN contest ON contest.id=account.contest_id`
  );
  expiryByUserId.clear();
  rows.forEach(row => expiryByUserId.set(Number(row.user_id), Number(row.expires_at)));
  expiryCacheReady = true;
}

ensureSchema().then(refreshExpiryCache).catch(error => syzoj.log('[temporary-contest-account] cache initialization failed: ' + error.message));
setInterval(() => refreshExpiryCache().catch(error => syzoj.log('[temporary-contest-account] cache refresh failed: ' + error.message)), 30000);

function randomPassword() {
  return crypto.randomBytes(12).toString('base64url') + 'A1!';
}

syzoj.utils.isTemporaryAccountLoginAllowed = async function isTemporaryAccountLoginAllowed(userId) {
  if (!expiryCacheReady) await refreshExpiryCache();
  return isLoginAllowed(expiryByUserId, userId);
};

syzoj.utils.expireTemporaryContestAccounts = async function expireTemporaryContestAccounts(contestId) {
  await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  await TypeORM.getConnection().query(
    'UPDATE temporary_contest_account SET expires_at=LEAST(expires_at,?) WHERE contest_id=?',
    [now,contestId]
  );
  await refreshExpiryCache();
};

app.use(async (req, res, next) => {
  try {
    if (!res.locals.user || await syzoj.utils.isTemporaryAccountLoginAllowed(res.locals.user.id)) return next();
    const expiredUserId = Number(res.locals.user.id);
    res.locals.user = null;
    if (req.session) delete req.session.user_id;
    User.deleteFromCache(expiredUserId);
    next();
  } catch (error) {
    next(error);
  }
});

app.get('/contest/:id/temporary-accounts/template', async (req, res) => {
  try {
    const contestId = Number(req.params.id);
    const contest = Number.isSafeInteger(contestId) && contestId > 0 ? await Contest.findById(contestId) : null;
    if (!contest) throw inputError('无此比赛。', 404);
    if (!res.locals.user || !await contest.isSupervisior(res.locals.user)) throw inputError('您没有权限管理该比赛。', 403);
    const csv = '\uFEFF姓名,学号,学院\r\n张三,2026000001,计算机学院\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contest-${contestId}-temporary-accounts-template.csv"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(csv);
  } catch (error) {
    res.status(error.statusCode || 400).render('error', { err: error });
  }
});

app.post('/contest/:id/temporary-accounts/import', (req, res) => {
  upload(req, res, async uploadError => {
    try {
      if (uploadError) throw inputError(uploadError.code === 'LIMIT_FILE_SIZE' ? 'CSV 文件不能超过 1 MiB。' : uploadError.message);
      const contestId = Number(req.params.id);
      const contest = Number.isSafeInteger(contestId) && contestId > 0 ? await Contest.findById(contestId) : null;
      if (!contest) throw inputError('无此比赛。', 404);
      if (!res.locals.user || !await contest.isSupervisior(res.locals.user)) throw inputError('您没有权限管理该比赛。', 403);
      if (!req.file) throw inputError('请选择 CSV 文件。');
      const expected = req.session && req.session.contestRegistrationCsrfToken;
      const actual = req.body && req.body.csrf_token;
      if (typeof expected !== 'string' || typeof actual !== 'string' || expected.length !== actual.length ||
          !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) {
        throw inputError('页面已失效，请刷新后重试。', 403);
      }
      const rows = normalizeRows(req.file.buffer);
      const preparedRows = await Promise.all(rows.map(async row => {
        const password = randomPassword();
        return { ...row, password, passwordHash: await syzoj.utils.hashPassword(password) };
      }));
      const release = await contestMutation.acquireContestLock(contestId);
      let credentials;
      try {
        credentials = await contestMutation.withTransactionRetry(async manager => {
          await ensureSchema();
          const contests = await manager.query('SELECT id,end_time,ranklist_id FROM contest WHERE id=? FOR UPDATE', [contestId]);
          if (!contests.length) throw inputError('无此比赛。', 404);
          const nowRows = await manager.query('SELECT UNIX_TIMESTAMP() AS now');
          const now = Number(nowRows[0].now);
          if (now >= Number(contests[0].end_time)) throw inputError('比赛已结束，不能生成临时账户。', 409);
          const studentIds = preparedRows.map(row => row.studentId);
          const conflicts = await manager.query(
            'SELECT student_id FROM user_registration_profile WHERE student_id IN (?) FOR UPDATE',
            [studentIds]
          );
          if (conflicts.length) throw inputError(`学号 ${conflicts[0].student_id} 已存在，未导入任何账户。`, 409);
          const ranklists = await manager.query('SELECT id,ranklist FROM contest_ranklist WHERE id=? FOR UPDATE', [contests[0].ranklist_id]);
          if (!ranklists.length) throw inputError('比赛排行榜不存在。', 500);
          const reserved = new Set();
          const created = [];
          for (const row of preparedRows) {
            const username = await uniqueUsername(
              manager,
              `${usernamePart(row.college)}-${usernamePart(row.name)}`,
              row.studentId,
              reserved
            );
            const result = await manager.query(
              `INSERT INTO user
                (username,email,password,nickname,nameplate,information,ac_num,submit_num,is_admin,is_show,
                 public_email,prefer_formatted_code,sex,rating,register_time)
               VALUES (?,NULL,?,?,'','临时比赛账户',0,0,0,1,0,1,0,?,?)`,
              [username,row.passwordHash,row.name,Number(syzoj.config.default.user.rating || 1500),now]
            );
            const userId = Number(result.insertId);
            await manager.query(
              `INSERT INTO user_registration_profile
                (user_id,student_id,real_name,college,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
              [userId,row.studentId,row.name,row.college,now,now]
            );
            await manager.query(
              `INSERT INTO temporary_contest_account (contest_id,user_id,expires_at,created_at,created_by)
               VALUES (?,?,?,?,?)`,
              [contestId,userId,Number(contests[0].end_time),now,res.locals.user.id]
            );
            const player = await manager.query(
              `INSERT INTO contest_player (contest_id,user_id,score,score_details,time_spent)
               VALUES (?,?,0,'{}',0)`,
              [contestId,userId]
            );
            created.push({
              userId,
              playerId: Number(player.insertId),
              username,
              expiresAt: Number(contests[0].end_time),
              ...row
            });
          }
          const current = typeof ranklists[0].ranklist === 'object'
            ? ranklists[0].ranklist
            : JSON.parse(ranklists[0].ranklist || '{"player_num":0}');
          const nextRanklist = appendPlayersToRanklist(current, created.map(item => item.playerId));
          await manager.query('UPDATE contest_ranklist SET ranklist=? WHERE id=?', [JSON.stringify(nextRanklist),ranklists[0].id]);
          return created;
        });
      } finally {
        await release();
      }
      credentials.forEach(item => expiryByUserId.set(Number(item.userId), Number(item.expiresAt)));
      if (syzoj.utils.invalidateContestReadCache) syzoj.utils.invalidateContestReadCache(contestId);
      const csv = '\uFEFF' + [
        ['用户名','密码','姓名','学号','学院'],
        ...credentials.map(item => [item.username,item.password,item.name,item.studentId,item.college])
      ].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="contest-${contestId}-temporary-accounts.csv"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(csv);
    } catch (error) {
      syzoj.log('[temporary-contest-account] import failed: ' + (error.stack || error));
      res.status(error.statusCode || 400).render('error', { err: error });
    }
  });
});
