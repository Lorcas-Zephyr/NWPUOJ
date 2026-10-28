'use strict';

const crypto = require('crypto');
const multer = require('multer');
const TypeORM = require('typeorm');
const contestMutation = require('../libs/contest-mutation');
const {
  ensureRegistrationProfileSchema,
  synchronizeTemporaryStudentIdScopes,
  temporaryStudentIdScope
} = require('../libs/registration-profile-schema');
const {
  appendPlayersToRanklist,
  csvCell,
  inputError,
  isLoginAllowed,
  normalizeRows,
  temporaryRoute,
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
    schemaPromise = (async () => {
      const connection = TypeORM.getConnection();
      await connection.query(`
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
      `);
      await ensureRegistrationProfileSchema();
      await synchronizeTemporaryStudentIdScopes(connection);
    })().catch(error => {
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
  // Keep the first character alphanumeric. CSV formula protection must not
  // alter a credential, and a safe prefix also keeps passwords convenient to
  // paste into spreadsheet-based login lists.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return alphabet[crypto.randomInt(alphabet.length)] + crypto.randomBytes(12).toString('base64url') + 'A1!';
}

function credentialsCsv(credentials) {
  return '\uFEFF' + [
    ['用户名','密码','姓名','学号','学院'],
    ...credentials.map(item => [item.username,item.password,item.name,item.studentId,item.college])
  ].map(row => row.map((value, index) => csvCell(value, { literal: index === 1 })).join(',')).join('\r\n') + '\r\n';
}

async function canManageContestRegistrations(contest, user) {
  if (!contest || !user) return false;
  const scope = `contest:${contest.id}`;
  const resource = { ownerId: Number(contest.holder_id), scope };
  const scoped = await syzoj.utils.authorizationV2.authorize(user, 'contest:registration.manage', resource, { scope });
  return !!scoped;
}

async function importTemporaryAccounts({ contestId, actor, rows, req }) {
  if (syzoj.utils.baseWorkspace && await syzoj.utils.baseWorkspace.contains('contest', contestId)) {
    throw inputError('基地比赛仅限基地成员参加，不能生成临时比赛账户。', 403);
  }
  await Promise.all([ensureSchema(), syzoj.utils.apiV2.ensureFoundationSchema()]);
  const preparedRows = await Promise.all(rows.map(async row => {
    const password = randomPassword();
    return { ...row, password, passwordHash: await syzoj.utils.hashPassword(password) };
  }));
  const release = await contestMutation.acquireContestLock(contestId);
  let result;
  try {
    result = await contestMutation.withTransactionRetry(async manager => {
      const contests = await manager.query('SELECT id,end_time,ranklist_id FROM contest WHERE id=? FOR UPDATE', [contestId]);
      if (!contests.length) throw inputError('无此比赛。', 404);
      const nowRows = await manager.query('SELECT UNIX_TIMESTAMP() AS now');
      const now = Number(nowRows[0].now);
      if (now >= Number(contests[0].end_time)) throw inputError('比赛已结束，不能生成临时账户。', 409);
      const studentIds = preparedRows.map(row => row.studentId);
      const studentIdScope = temporaryStudentIdScope(contestId);
      const conflicts = await manager.query(
        'SELECT student_id FROM user_registration_profile WHERE student_id_scope=? AND student_id IN (?) FOR UPDATE',
        [studentIdScope,studentIds]
      );
      if (conflicts.length) {
        throw inputError(`学号 ${conflicts[0].student_id} 已在本场比赛的临时账户中使用，未导入任何账户。`, 409);
      }
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
        const userResult = await manager.query(
          `INSERT INTO user
            (username,email,password,nickname,nameplate,information,ac_num,submit_num,is_admin,is_show,
             public_email,prefer_formatted_code,sex,rating,register_time)
           VALUES (?,NULL,?,?,'','临时比赛账户',0,0,0,1,0,1,0,?,?)`,
          [username,row.passwordHash,row.name,Number(syzoj.config.default.user.rating || 1500),now]
        );
        const userId = Number(userResult.insertId);
        await manager.query(
          `INSERT INTO user_registration_profile
            (user_id,student_id_scope,student_id,real_name,college,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?)`,
          [userId,studentIdScope,row.studentId,row.name,row.college,now,now]
        );
        await manager.query(
          `INSERT INTO temporary_contest_account (contest_id,user_id,expires_at,created_at,created_by)
           VALUES (?,?,?,?,?)`,
          [contestId,userId,Number(contests[0].end_time),now,actor.id]
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
      const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
        action: 'contest:temporary-account.import',
        resourceType: 'contest',
        resourceId: contestId,
        reason: syzoj.utils.operationReason(req, '批量创建临时参赛账户'),
        details: { created_count: created.length }
      }, manager);
      const eventPayload = { contest_id: contestId, created_count: created.length, audit_event_id: auditEventId };
      const eventResult = await manager.query(
        'INSERT INTO api_v2_event (stream,type,aggregate_id,actor_id,payload_json,created_at) VALUES (?,?,?,?,?,FROM_UNIXTIME(?))',
        [`contest:${contestId}`, 'contest.temporary-accounts.imported', String(contestId), actor.id, JSON.stringify(eventPayload), now]
      );
      return {
        credentials: created,
        auditEventId,
        event: {
          id: String(eventResult.insertId),
          stream: `contest:${contestId}`,
          type: 'contest.temporary-accounts.imported',
          aggregate_id: String(contestId),
          actor_id: Number(actor.id),
          payload: eventPayload,
          created_at: new Date(now * 1000).toISOString()
        }
      };
    });
  } finally {
    await release();
  }
  result.credentials.forEach(item => expiryByUserId.set(Number(item.userId), Number(item.expiresAt)));
  if (syzoj.utils.invalidateContestReadCache) syzoj.utils.invalidateContestReadCache(contestId);
  syzoj.utils.apiV2.publishEvent(result.event);
  return result;
}

syzoj.utils.temporaryContestAccounts = Object.freeze({
  canManageContestRegistrations,
  ensureSchema,
  importTemporaryAccounts,
  inputError,
  normalizeRows,
  upload
});

syzoj.utils.isTemporaryAccountLoginAllowed = async function isTemporaryAccountLoginAllowed(userId) {
  if (!expiryCacheReady) await refreshExpiryCache();
  return isLoginAllowed(expiryByUserId, userId);
};

syzoj.utils.isTemporaryContestAccount = async function isTemporaryContestAccount(userId) {
  if (!expiryCacheReady) await refreshExpiryCache();
  return expiryByUserId.has(Number(userId));
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

async function temporaryContestRegistration(userId, contestId) {
  if (!userId || !contestId) return false;
  await ensureSchema();
  const rows = await TypeORM.getConnection().query(
    `SELECT participant.id,participant.submitted_at,contest.end_time
       FROM contest_player participant
       JOIN contest ON contest.id=participant.contest_id
       JOIN temporary_contest_account account ON account.user_id=participant.user_id
       LEFT JOIN contest origin ON origin.id=account.contest_id
       LEFT JOIN contest_registration_removal removed
         ON removed.contest_id=participant.contest_id AND removed.user_id=participant.user_id
      WHERE participant.contest_id=? AND participant.user_id=?
        AND removed.user_id IS NULL
        AND COALESCE(origin.end_time,account.expires_at)>UNIX_TIMESTAMP()
        AND NOT EXISTS (SELECT 1 FROM contest_v2_state state WHERE state.contest_id=contest.id AND state.status='archived')
      LIMIT 1`,
    [Number(contestId), Number(userId)]
  );
  return rows[0] || null;
}

syzoj.utils.temporaryContestParticipant = async (userId, contestId) => !!await temporaryContestRegistration(userId, contestId);
syzoj.utils.temporaryContestContentAllowed = async (userId, contestId) => {
  const registration = await temporaryContestRegistration(userId, contestId);
  if (!registration) return false;
  return !registration.submitted_at || Number(registration.end_time) <= Math.floor(Date.now() / 1000);
};

function requestPath(req) {
  const raw = String(req.originalUrl || req.url || req.path || '/').split('?')[0];
  try { return decodeURIComponent(raw).toLowerCase(); } catch (_) { return raw.toLowerCase(); }
}

function temporaryAccessDenied(req, res) {
  const path = requestPath(req);
  if (/^\/api\//.test(path)) {
    return res.status(403).json({
      data: null,
      error: { code: 'TEMPORARY_CONTEST_SCOPE', message: '临时比赛账户只能访问已报名比赛。', fields: {} }
    });
  }
  return res.redirect(303, syzoj.utils.makeUrl(['contests']));
}

async function contestIdFromSubmission(submissionId) {
  const rows = await TypeORM.getConnection().query(
    'SELECT type,type_info FROM judge_state WHERE id=? LIMIT 1',
    [Number(submissionId)]
  );
  if (!rows.length || Number(rows[0].type) !== 1) return null;
  return Number(rows[0].type_info) || null;
}

// This module precedes every resource route, including legacy page adapters.
app.use(async (req, res, next) => {
  try {
    res.locals.temporaryContestSession = !!(res.locals.user && await syzoj.utils.isTemporaryContestAccount(res.locals.user.id));
    if (!res.locals.temporaryContestSession) return next();
    res.set('Cache-Control', 'private, no-store');
    const path = requestPath(req);
    const userId = Number(res.locals.user.id);
    const accounts = await TypeORM.getConnection().query(
      `SELECT COALESCE(contest.end_time,account.expires_at)>UNIX_TIMESTAMP() AS active
       FROM temporary_contest_account account LEFT JOIN contest ON contest.id=account.contest_id WHERE account.user_id=?`, [userId]);
    if (!accounts[0] || Number(accounts[0].active) !== 1) {
      res.locals.user = null;
      res.locals.temporaryContestSession = false;
      if (req.session) delete req.session.user_id;
      User.deleteFromCache(userId);
      if (/^\/api\//.test(path)) return res.status(401).json({ data: null, error: { code: 'AUTHENTICATION_REQUIRED', message: '临时比赛账户已过期，请重新登录。', fields: {} } });
      if (/^\/(login|logout)\/?$/.test(path)) return next();
      if ((req.method === 'GET' || req.method === 'HEAD') && /^\/legal\/(?:terms|privacy|competition|copyright)\/?$/.test(path)) return next();
      return res.redirect(303, syzoj.utils.makeUrl(['login']));
    }
    const route = temporaryRoute(req.method, req.originalUrl || req.url);
    if (!route) return temporaryAccessDenied(req, res);
    if (route.kind === 'session' || route.kind === 'submission-events') return next();
    const contestId = route.kind === 'submission'
      ? await contestIdFromSubmission(route.submissionId)
      : route.kind === 'problem-submit'
        ? Number(req.query.contest_id || req.body && req.body.contest_id || 0)
        : route.contestId;
    if (!contestId) return temporaryAccessDenied(req, res);
    const registration = await temporaryContestRegistration(userId, contestId);
    if (!registration) return temporaryAccessDenied(req, res);
    if (!route.afterHandIn && registration.submitted_at && Number(registration.end_time) > Math.floor(Date.now() / 1000)) {
      if (/^\/api\//.test(path)) return temporaryAccessDenied(req, res);
      return res.redirect(303, syzoj.utils.makeUrl(['contest', contestId, 'details']));
    }
    next();
  } catch (error) {
    next(error);
  }
});

app.use(async (req, res, next) => {
  try {
    res.locals.temporaryContestSession = false;
    if (!res.locals.user) return next();
    if (await syzoj.utils.isTemporaryAccountLoginAllowed(res.locals.user.id)) {
      res.locals.temporaryContestSession = await syzoj.utils.isTemporaryContestAccount(res.locals.user.id);
      return next();
    }
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
    if (!await canManageContestRegistrations(contest, res.locals.user)) throw inputError('您没有权限管理该比赛。', 403);
    const csv = '\uFEFF姓名,学号,学院\r\n张三,2026000001,计算机学院\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contest-${contestId}-temporary-accounts-template.csv"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(csv);
  } catch (error) {
    res.status(error.statusCode || 400).render('error', { err: error });
  }
});
