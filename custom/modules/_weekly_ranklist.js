'use strict';

const TypeORM = require('typeorm');
const crypto = require('crypto');
const multer = require('multer');
const engine = require('../libs/weekly-standings');
const standingsEngine = require('../libs/contest-standings');
const classes = require('../libs/class-groups');
const { normalizeStudentIdRows } = require('../libs/contest-temp-accounts');
const { ensureRegistrationProfileSchema, ORDINARY_STUDENT_ID_SCOPE } = require('../libs/registration-profile-schema');
const api = () => syzoj.utils.apiV2;
const db = () => TypeORM.getConnection();
let schemaPromise, refreshPromise, refreshedAt = 0;
// Invalidate persisted projections when the response shape gains new fields.
const RESULT_SCHEMA_VERSION = 2;
const parse = (value, fallback) => { try { return typeof value === 'string' ? JSON.parse(value) : value || fallback; } catch (_) { return fallback; } };
const error = (message, statusCode = 422, code = 'WEEKLY_VALIDATION_FAILED') => Object.assign(new Error(message), { statusCode, code });
const canManage = user => classes.isUnrestricted(user);
const version = board => ({ id: 1, revision: Number(board.revision) });
// DATETIME stores UTC wall time, while the legacy connection parses Date
// values in server-local time. Select a UTC string to avoid subtracting 8h.
const selectBoard = "SELECT *,DATE_FORMAT(calculated_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS calculated_at_iso FROM weekly_ranklist WHERE id=1";

async function ensureSchema() {
  if (!schemaPromise) schemaPromise = (async () => {
    await classes.ensureSchema();
    await ensureRegistrationProfileSchema();
    await db().query(`CREATE TABLE IF NOT EXISTS weekly_ranklist (
      id INT NOT NULL PRIMARY KEY, title VARCHAR(100) NOT NULL,
      revision INT NOT NULL DEFAULT 1, rules_json TEXT NOT NULL,
      result_json MEDIUMTEXT NULL, source_hash CHAR(64) NULL, calculated_at DATETIME(3) NULL,
      updated_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await db().query(`CREATE TABLE IF NOT EXISTS weekly_ranklist_contest (
      contest_id INT NOT NULL PRIMARY KEY, added_by INT NOT NULL, created_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await db().query(`CREATE TABLE IF NOT EXISTS weekly_ranklist_member (
      user_id INT NOT NULL PRIMARY KEY, added_by INT NOT NULL, created_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await db().query(`CREATE TABLE IF NOT EXISTS weekly_ranklist_attendance (
      user_id INT NOT NULL, contest_id INT NOT NULL, onsite TINYINT(1) NOT NULL,
      recorded_by INT NOT NULL, updated_at DATETIME(3) NOT NULL,
      PRIMARY KEY (user_id,contest_id), KEY idx_weekly_attendance_contest (contest_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await db().query("INSERT IGNORE INTO weekly_ranklist (id,title,revision,rules_json,updated_at) VALUES (1,'周赛总榜',1,?,UTC_TIMESTAMP(3))", [JSON.stringify(engine.DEFAULT_RULES)]);
  })().catch(e => { schemaPromise = null; throw e; });
  return schemaPromise;
}

async function calculate(manager, board) {
  const members = await manager.query(`SELECT m.user_id,u.username,p.real_name,p.student_id
    FROM weekly_ranklist_member m INNER JOIN user u ON u.id=m.user_id
    LEFT JOIN user_registration_profile p ON p.user_id=u.id AND p.student_id_scope=? ORDER BY m.user_id`, [ORDINARY_STUDENT_ID_SCOPE]);
  const contests = await manager.query(`SELECT c.id,c.title,c.type,c.start_time,c.end_time,c.problems
    FROM weekly_ranklist_contest selected INNER JOIN contest c ON c.id=selected.contest_id
    ORDER BY c.start_time,c.id`);
  const attendance = await manager.query(`SELECT a.* FROM weekly_ranklist_attendance a
    INNER JOIN weekly_ranklist_member m ON m.user_id=a.user_id
    INNER JOIN weekly_ranklist_contest c ON c.contest_id=a.contest_id ORDER BY a.user_id,a.contest_id`);
  const now = Math.floor(Date.now() / 1000);
  const finished = contests.filter(c => c.type === 'acm' && Number(c.end_time) <= now);
  let submissions = [];
  if (members.length && finished.length) submissions = await manager.query(`
    SELECT j.id,j.type_info AS contest_id,j.user_id,j.problem_id,j.submit_time,j.status,j.score,j.pending,a.action_type
    FROM judge_state j INNER JOIN contest_player cp ON cp.contest_id=j.type_info AND cp.user_id=j.user_id
    LEFT JOIN contest_registration_removal removed ON removed.contest_id=cp.contest_id AND removed.user_id=cp.user_id
    LEFT JOIN judge_state_admin_action a ON a.judge_id=j.id
    WHERE j.type=1 AND j.type_info IN (?) AND j.user_id IN (?) AND removed.user_id IS NULL ORDER BY j.id`,
  [finished.map(c => c.id), members.map(m => m.user_id)]);
  const sourceHash = crypto.createHash('sha256').update(JSON.stringify([RESULT_SCHEMA_VERSION, board.rules_json, members, contests, attendance,
    submissions, finished.map(c => c.id)])).digest('hex');
  if (board.source_hash === sourceHash && board.result_json) return board;
  const standings = {};
  for (const contest of finished) {
    const source = submissions.filter(s => Number(s.contest_id) === Number(contest.id) && Number(s.submit_time) >= Number(contest.start_time) && Number(s.submit_time) < Number(contest.end_time));
    const disqualified = new Set(source.filter(s => s.action_type === 'cheated' || s.status === 'Cheated').map(s => Number(s.user_id)));
    const usable = source.filter(s => !disqualified.has(Number(s.user_id)));
    const details = standingsEngine.scoreDetailsBefore(usable, contest, Number(contest.end_time));
    // Disqualification zeroes the score, but is not an absence: otherwise it
    // would improve G2 by silently removing a zero-score attended round.
    const participated = new Set(source.filter(s => s.action_type !== 'cancelled' && s.status !== 'Cancelled').map(s => Number(s.user_id)));
    standings[contest.id] = standingsEngine.calculateStandingRows({ type: 'acm', startTime: contest.start_time,
      players: members.map(m => ({ user_id: m.user_id, participant_id: m.user_id, details: details.get(Number(m.user_id)) || {} }))
    }).map(row => ({ ...row, participated: participated.has(row.user_id) }));
  }
  // If a selected contest changes away from ACM, do not reinterpret IOI scores
  // as solve counts; show it as excluded until the manager corrects selection.
  const eligibleContests = contests.filter(c => c.type === 'acm');
  const result = engine.calculateWeeklyStandings({ members, contests: eligibleContests, standings, attendance, rules: parse(board.rules_json, {}), now });
  result.excluded_contests = contests.filter(c => c.type !== 'acm').map(c => ({ id: Number(c.id), title: c.title }));
  result.contests = result.contests.map(c => ({ id: Number(c.id), title: c.title, start_time: Number(c.start_time), end_time: Number(c.end_time) }));
  const calculatedAt = new Date().toISOString();
  await manager.query('UPDATE weekly_ranklist SET result_json=?,source_hash=?,calculated_at=? WHERE id=1', [JSON.stringify(result), sourceHash, calculatedAt.replace('T', ' ').replace('Z', '')]);
  return { ...board, result_json: result, source_hash: sourceHash, calculated_at_iso: calculatedAt };
}

async function refresh(force = false) {
  await ensureSchema();
  if (!force && Date.now() - refreshedAt < 15000) return (await db().query(selectBoard))[0];
  if (refreshPromise) return refreshPromise;
  refreshPromise = db().transaction(async manager => {
    const [board] = await manager.query(selectBoard + ' FOR UPDATE');
    return calculate(manager, board);
  }).then(board => { refreshedAt = Date.now(); return board; }).finally(() => { refreshPromise = null; });
  return refreshPromise;
}

function payload(board, manager) {
  const result = parse(board.result_json, { rows: [], contests: [], member_count: 0, finished_count: 0 });
  return { ...result, title: board.title, revision: Number(board.revision), edit_etag: api().etagFor(version(board)), calculated_at: board.calculated_at_iso ? new Date(board.calculated_at_iso).toISOString() : null,
    rules: parse(board.rules_json, engine.DEFAULT_RULES), can_manage: manager,
    rows: result.rows.map(row => manager ? row : Object.fromEntries(Object.entries(row).filter(([key]) => !['real_name', 'student_id'].includes(key)))) };
}

async function mutate(req, res, action, work) {
  if (!canManage(res.locals.user)) throw error('只有全站管理员或站长可以设置周赛总榜。', res.locals.user ? 403 : 401, 'CAPABILITY_REQUIRED');
  await ensureSchema();
  const saved = await db().transaction(async manager => {
    const [board] = await manager.query(selectBoard + ' FOR UPDATE');
    if (!api().ifMatch(req, version(board))) throw error('总榜设置已被修改，请刷新后再操作。', 412, 'ETAG_MISMATCH');
    const details = await work(manager, board) || {};
    await manager.query('UPDATE weekly_ranklist SET title=?,rules_json=?,revision=revision+1,source_hash=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=1', [board.title, board.rules_json]);
    board.revision = Number(board.revision) + 1; board.source_hash = null;
    const result = await calculate(manager, board);
    await syzoj.utils.authorizationV2.recordAudit(req, { action: 'weekly_ranklist:' + action,
      resourceType: 'weekly_ranklist', resourceId: 1, reason: '管理周赛总榜并完整重新计算', details }, manager);
    return { result, details };
  });
  refreshedAt = Date.now();
  api().setResourceEtag(res, version(saved.result));
  return api().send(res, { ...payload(saved.result, true), operation: saved.details });
}

const route = fn => async (req, res) => { try { return await fn(req, res); } catch (e) {
  if (!e.statusCode || e.statusCode >= 500) syzoj.log('[weekly-ranklist] ' + (e.stack || e.message));
  return api().fail(res, e.statusCode || 500, e.code || 'WEEKLY_OPERATION_FAILED', e.statusCode ? e.message : '周赛总榜暂时无法处理该操作，请稍后重试。');
} };
const ids = value => {
  if (!Array.isArray(value) || value.length > 5000 || value.some(id => !Number.isSafeInteger(Number(id)) || Number(id) < 1)) throw error('成员或比赛编号不正确。');
  return [...new Set(value.map(Number))];
};

for (const path of ['/weekly-ranklist', '/weekly-ranklist/settings']) app.get(path, async (req, res) => {
  if (path.endsWith('/settings') && !canManage(res.locals.user)) return res.status(res.locals.user ? 403 : 401).render('error', { err: new Error('只有全站管理员或站长可以设置周赛总榜。') });
  res.render('weekly_ranklist', { weeklySettings: path.endsWith('/settings'), weeklyManager: canManage(res.locals.user) });
});
app.get('/api/v2/weekly-ranklist', route(async (req, res) => {
  const board = await refresh();
  res.set('Cache-Control', 'private, no-store');
  api().setResourceEtag(res, version(board));
  return api().send(res, payload(board, canManage(res.locals.user)));
}));

app.get('/api/v2/weekly-ranklist/search/:kind', route(async (req, res) => {
  if (!canManage(res.locals.user)) throw error('只有全站管理员可以搜索总榜配置对象。', 403, 'CAPABILITY_REQUIRED');
  await ensureSchema();
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (!q) return api().send(res, []);
  const pattern = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
  let rows;
  if (req.params.kind === 'contests') rows = await db().query("SELECT id,title,start_time,end_time FROM contest WHERE type='acm' AND (id=? OR title LIKE ?) ORDER BY start_time DESC,id DESC LIMIT 30", [Number(q) || 0, pattern]);
  else if (req.params.kind === 'classes') rows = await db().query("SELECT g.id,g.name,COUNT(m.user_id) AS member_count FROM class_group g LEFT JOIN class_group_member m ON m.class_id=g.id WHERE g.status='active' AND (g.id=? OR g.name LIKE ?) GROUP BY g.id ORDER BY g.name LIMIT 30", [Number(q) || 0, pattern]);
  else if (req.params.kind === 'users') rows = await db().query(`SELECT u.id,u.username,p.real_name,p.student_id FROM user u
    LEFT JOIN user_registration_profile p ON p.user_id=u.id AND p.student_id_scope=?
    LEFT JOIN temporary_contest_account t ON t.user_id=u.id
    WHERE t.user_id IS NULL AND (u.id=? OR u.username LIKE ? OR p.student_id LIKE ? OR p.real_name LIKE ?) ORDER BY u.username LIMIT 30`, [ORDINARY_STUDENT_ID_SCOPE, Number(q) || 0, pattern, pattern, pattern]);
  else throw error('不支持的搜索类型。');
  return api().send(res, rows);
}));

app.post('/api/v2/weekly-ranklist/config', route((req, res) => mutate(req, res, 'settings', async (_manager, board) => {
  const title = String(req.body.title || '').trim();
  if (!title || Array.from(title).length > 100) throw error('总榜名称不能为空，且不能超过 100 个字符。');
  board.title = title; board.rules_json = JSON.stringify(engine.normalizeRules(req.body.rules));
  return { title, rules: parse(board.rules_json, {}) };
})));
app.post('/api/v2/weekly-ranklist/contests', route((req, res) => mutate(req, res, 'contests', async manager => {
  const selected = ids(req.body.contest_ids);
  if (!selected.length) throw error('请选择比赛。');
  if (req.body.remove === true) {
    await manager.query('DELETE FROM weekly_ranklist_attendance WHERE contest_id IN (?)', [selected]);
    await manager.query('DELETE FROM weekly_ranklist_contest WHERE contest_id IN (?)', [selected]);
  } else {
    const rows = await manager.query("SELECT id FROM contest WHERE id IN (?) AND type='acm'", [selected]);
    if (rows.length !== selected.length) throw error('仅支持已存在的 ACM 赛制比赛。');
    const existing = await manager.query('SELECT contest_id FROM weekly_ranklist_contest');
    if (new Set(existing.map(r => Number(r.contest_id)).concat(selected)).size > 100) throw error('一个总榜最多加入 100 场比赛。');
    await manager.query('INSERT IGNORE INTO weekly_ranklist_contest (contest_id,added_by,created_at) VALUES ' + selected.map(() => '(?,?,UTC_TIMESTAMP(3))').join(','), selected.flatMap(id => [id, res.locals.user.id]));
  }
  return { contest_ids: selected, remove: req.body.remove === true };
})));

async function addMembers(manager, userIds, actorId) {
  if (!userIds.length) throw error('没有匹配到可添加的普通用户。');
  const rows = await manager.query('SELECT u.id FROM user u LEFT JOIN temporary_contest_account t ON t.user_id=u.id WHERE u.id IN (?) AND t.user_id IS NULL', [userIds]);
  if (rows.length !== userIds.length) throw error('名单包含不存在的用户或临时比赛账户。');
  const existing = await manager.query('SELECT user_id FROM weekly_ranklist_member');
  if (new Set(existing.map(r => Number(r.user_id)).concat(userIds)).size > 5000) throw error('总榜成员不能超过 5000 人。');
  const added = await manager.query('INSERT IGNORE INTO weekly_ranklist_member (user_id,added_by,created_at) VALUES ' + userIds.map(() => '(?,?,UTC_TIMESTAMP(3))').join(','), userIds.flatMap(id => [id, actorId]));
  return { added_count: Number(added.affectedRows), existing_count: userIds.length - Number(added.affectedRows), user_ids: userIds };
}
app.post('/api/v2/weekly-ranklist/members', route((req, res) => mutate(req, res, 'members', async manager => {
  const selected = ids(req.body.user_ids);
  if (!selected.length) throw error('请选择用户。');
  if (req.body.remove !== true) return addMembers(manager, selected, res.locals.user.id);
  await manager.query('DELETE FROM weekly_ranklist_attendance WHERE user_id IN (?)', [selected]);
  await manager.query('DELETE FROM weekly_ranklist_member WHERE user_id IN (?)', [selected]);
  return { removed_user_ids: selected };
})));
app.post('/api/v2/weekly-ranklist/members/import-class', route((req, res) => mutate(req, res, 'members.import_class', async manager => {
  const selected = ids(req.body.class_ids);
  if (!selected.length) throw error('请选择班级。');
  const users = await manager.query(`SELECT DISTINCT m.user_id FROM class_group_member m
    INNER JOIN class_group g ON g.id=m.class_id AND g.status='active'
    INNER JOIN user u ON u.id=m.user_id LEFT JOIN temporary_contest_account t ON t.user_id=m.user_id
    WHERE m.class_id IN (?) AND t.user_id IS NULL`, [selected]);
  return { ...await addMembers(manager, users.map(u => Number(u.user_id)), res.locals.user.id), class_ids: selected };
})));
const csv = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1 } }).single('student_ids_csv');
app.post('/api/v2/weekly-ranklist/members/import-csv', (req, res) => {
  if (!canManage(res.locals.user)) return api().fail(res, 403, 'CAPABILITY_REQUIRED', '只有全站管理员可以导入总榜成员。');
  return csv(req, res, uploadError => route(async () => {
    if (uploadError || !req.file || !/\.csv$/i.test(req.file.originalname)) throw error('请上传不超过 1 MiB 的学号 CSV 文件。');
    let studentIds;
    try { studentIds = normalizeStudentIdRows(req.file.buffer); } catch (e) { throw error(e.message); }
    return mutate(req, res, 'members.import_csv', async manager => {
      const users = await manager.query(`SELECT p.user_id,p.student_id FROM user_registration_profile p INNER JOIN user u ON u.id=p.user_id
        LEFT JOIN temporary_contest_account t ON t.user_id=p.user_id WHERE p.student_id_scope=? AND p.student_id IN (?) AND t.user_id IS NULL`, [ORDINARY_STUDENT_ID_SCOPE, studentIds]);
      const found = new Set(users.map(u => String(u.student_id)));
      return { ...await addMembers(manager, [...new Set(users.map(u => Number(u.user_id)))], res.locals.user.id), missing_student_ids: studentIds.filter(id => !found.has(id)) };
    });
  })(req, res));
});
app.post('/api/v2/weekly-ranklist/attendance', route((req, res) => mutate(req, res, 'attendance', async manager => {
  const changes = req.body.changes;
  if (!Array.isArray(changes) || changes.length > 10000 || !changes.length) throw error('请选择需要更新的线下参赛记录。');
  const members = new Set((await manager.query('SELECT user_id FROM weekly_ranklist_member')).map(r => Number(r.user_id)));
  const contests = new Set((await manager.query('SELECT contest_id FROM weekly_ranklist_contest')).map(r => Number(r.contest_id)));
  const unique = new Map();
  for (const change of changes) {
    if (!members.has(Number(change.user_id)) || !contests.has(Number(change.contest_id)) || typeof change.onsite !== 'boolean') throw error('线下参赛记录不属于当前总榜名单或比赛。');
    unique.set(`${change.user_id}:${change.contest_id}`, change);
  }
  const entries = [...unique.values()];
  await manager.query('INSERT INTO weekly_ranklist_attendance (user_id,contest_id,onsite,recorded_by,updated_at) VALUES ' + entries.map(() => '(?,?,?,?,UTC_TIMESTAMP(3))').join(',') + ' ON DUPLICATE KEY UPDATE onsite=VALUES(onsite),recorded_by=VALUES(recorded_by),updated_at=VALUES(updated_at)', entries.flatMap(c => [Number(c.user_id), Number(c.contest_id), c.onsite ? 1 : 0, res.locals.user.id]));
  return { changes: entries };
})));
app.post('/api/v2/weekly-ranklist/recalculate', route((req, res) => mutate(req, res, 'recalculate', async () => ({ forced: true }))));

// Shared refresh, not per-visitor calculation. Mutations recalculate in the
// same transaction; timer refresh also picks up rejudges and contest edits.
const timer = setInterval(() => refresh(true).catch(e => syzoj.log('[weekly-ranklist] refresh failed: ' + e.message)), 30000);
if (timer.unref) timer.unref();
