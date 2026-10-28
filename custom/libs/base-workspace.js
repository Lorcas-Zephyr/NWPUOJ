'use strict';

const TypeORM = require('typeorm');
const { memo } = require('./request-read-cache');
const { parseCsv } = require('./contest-temp-accounts');
let schemaPromise;

function ensureSchema() {
  if (!schemaPromise) schemaPromise = (async () => {
    const db = TypeORM.getConnection();
    await db.query(`CREATE TABLE IF NOT EXISTS base_workspace_member (
      user_id INT NOT NULL PRIMARY KEY, added_by INT NOT NULL, created_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    for (const kind of ['problem', 'contest']) await db.query(`CREATE TABLE IF NOT EXISTS base_workspace_${kind} (
      ${kind}_id INT NOT NULL PRIMARY KEY, created_by INT NOT NULL, created_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await db.query(`CREATE TABLE IF NOT EXISTS base_workspace_problem_migration (
      source_problem_id INT NOT NULL PRIMARY KEY, target_problem_id INT NOT NULL,
      target_version_id BIGINT UNSIGNED NOT NULL, migrated_by INT NOT NULL, migrated_at DATETIME(3) NOT NULL,
      KEY idx_base_migration_target (target_problem_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await db.query(`CREATE TABLE IF NOT EXISTS base_workspace_problem_sync (
      source_problem_id INT NOT NULL PRIMARY KEY, target_problem_id INT NOT NULL,
      source_fingerprint CHAR(64) NULL, synced_at DATETIME(3) NULL,
      last_error TEXT NULL, attempted_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  })().catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}

// Legacy editor adapters use Object.create(user) with is_admin=true. That
// presentation-only flag must never become a workspace membership grant.
function identity(user) {
  while (user && Object.getPrototypeOf(user) && Object.getPrototypeOf(user).id === user.id) user = Object.getPrototypeOf(user);
  return user;
}
function isAdmin(user) {
  user = identity(user);
  return !!(user && (user.is_admin || Number(user.id) === Number(syzoj.siteOwnerUserId || 0)));
}
async function isMember(user) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  await ensureSchema();
  return memo(`base:member:${user.id}`, async () => {
    const rows = await TypeORM.getConnection().query('SELECT user_id FROM base_workspace_member WHERE user_id=? LIMIT 1', [Number(user.id)]);
    return rows.length > 0;
  });
}
async function contains(kind, id) {
  if (!['problem', 'contest'].includes(kind) || !Number.isSafeInteger(Number(id)) || Number(id) < 1) return false;
  await ensureSchema();
  return memo(`base:${kind}:${id}`, async () => {
    const rows = await TypeORM.getConnection().query(`SELECT ${kind}_id FROM base_workspace_${kind} WHERE ${kind}_id=? LIMIT 1`, [Number(id)]);
    return rows.length > 0;
  });
}
async function canReadProblem(problem, user) {
  return !!problem && await isMember(user) && (isAdmin(user) || !!problem.is_public || Number(problem.user_id) === Number(user && user.id));
}
async function canManage(kind, resource, user) {
  return !!resource && await isMember(user) && (isAdmin(user) || Number(kind === 'problem' ? resource.user_id : resource.holder_id) === Number(user && user.id));
}
async function canAccessContest(contestId, user) {
  return !await contains('contest', contestId) || await isMember(user);
}
async function canAccessSubmission(judge, user) {
  if (!judge) return false;
  if (Number(judge.type) === 1 && !await canAccessContest(judge.type_info, user)) return false;
  if (!await contains('problem', judge.problem_id)) return true;
  return canReadProblem(await syzoj.model('problem').findById(Number(judge.problem_id)), user);
}
const PROBLEM_ACTIONS = new Set(['problem:read', 'problem:edit', 'problem:delete', 'problem:publish', 'problem:archive', 'problem:testdata.write', 'problem:tag.assign']);
const CONTEST_ACTIONS = new Set(['contest:read', 'contest:edit', 'contest:delete', 'contest:publish', 'contest:start', 'contest:end', 'contest:freeze', 'contest:registration.manage', 'contest:standings.rebuild', 'contest:standings.export', 'contest:register', 'contest:submit']);
async function authorize(user, capability, resource, scope) {
  const match = /^(problem|contest):(\d+)$/.exec(String(scope || resource && resource.scope || ''));
  if (!match || !await contains(match[1], match[2])) return null;
  if (!await isMember(user)) return false;
  const kind = match[1];
  const entity = await syzoj.model(kind).findById(Number(match[2]));
  if (!entity) return false;
  if (kind === 'problem' && ['problem:read', 'submission:create'].includes(capability)) return canReadProblem(entity, user);
  if (kind === 'contest' && ['contest:read', 'contest:register', 'contest:submit'].includes(capability)) return true;
  if (!(kind === 'problem' ? PROBLEM_ACTIONS : CONTEST_ACTIONS).has(capability)) return false;
  return canManage(kind, entity, user);
}
async function allowCreate(req, user) {
  return !!(req.body && req.body.workspace === 'base' && await isMember(user));
}
async function validContestProblem(problem, baseContest) {
  const baseProblem = await contains('problem', problem.id);
  return baseContest ? baseProblem && !!problem.is_public : !baseProblem;
}
async function migrationStates(problemIds, manager = TypeORM.getConnection()) {
  if (!problemIds.length) return new Map();
  const rows = await manager.query(`SELECT m.source_problem_id,m.target_problem_id,p.title
    FROM base_workspace_problem_migration m JOIN problem p ON p.id=m.target_problem_id
    JOIN problem_v2_version v ON v.id=m.target_version_id AND v.problem_id=p.id
    LEFT JOIN problem_v2_state s ON s.problem_id=p.id
    WHERE m.source_problem_id IN (?) AND COALESCE(s.lifecycle_status,'draft')<>'archived'
      AND NOT EXISTS (SELECT 1 FROM base_workspace_problem b WHERE b.problem_id=p.id)`, [problemIds]);
  return new Map(rows.map(row => [Number(row.source_problem_id), { problem_id: Number(row.target_problem_id), title: row.title }]));
}
async function canReadOperation(operation, user) {
  const path = decodeURIComponent(String(operation.path || '').split('?')[0]).toLowerCase();
  if (/^\/api\/v2\/base(?:\/|$)/.test(path)) return isAdmin(user);
  let match = /^\/api\/v2\/(problems|contests)\/(\d+)(?:\/|$)/.exec(path);
  let data;
  try { data = JSON.parse(operation.response_json || '{}').data; } catch (_) { data = null; }
  if (!match && path === '/api/v2/problems' && data && data.problem) match = [null, 'problems', data.problem.id];
  if (!match && path === '/api/v2/contests' && data) match = [null, 'contests', data.id];
  if (!match) return true;
  if (match[1] === 'contests') return canAccessContest(Number(match[2]), user);
  if (!await contains('problem', match[2])) return true;
  return canReadProblem(await syzoj.model('problem').findById(Number(match[2])), user);
}
async function assertMayHideProblem(manager, problemId) {
  if (!await contains('problem', problemId)) return;
  await manager.query('SELECT id FROM problem WHERE id=? FOR UPDATE', [Number(problemId)]);
  const references = await manager.query(`SELECT c.id FROM contest c JOIN base_workspace_contest b ON b.contest_id=c.id
    WHERE CONCAT('|',COALESCE(c.problems,''),'|') LIKE ? LIMIT 1`, [`%|${Number(problemId)}|%`]);
  if (references.length) throw Object.assign(new Error('该题仍被基地比赛使用，请先从比赛移除，再取消公开或归档。'), { statusCode: 409, code: 'BASE_PROBLEM_IN_USE' });
}
async function validateContestSelection(manager, problemIds, baseContest) {
  if (!problemIds.length) return;
  const rows = await manager.query(`SELECT p.id,p.is_public,b.problem_id AS base_id FROM problem p
    LEFT JOIN base_workspace_problem b ON b.problem_id=p.id WHERE p.id IN (?) ORDER BY p.id FOR UPDATE`, [problemIds]);
  if (rows.length !== problemIds.length || rows.some(row => baseContest ? !row.base_id || !row.is_public : !!row.base_id)) {
    throw Object.assign(new Error('题目范围或公开状态已变更，请重新选择比赛题目。'), { statusCode: 422, code: 'CONTEST_PROBLEM_SCOPE_INVALID' });
  }
}
function outside(kind, expression) {
  if (!['problem', 'contest'].includes(kind)) throw new Error('Invalid workspace kind');
  return `NOT EXISTS (SELECT 1 FROM base_workspace_${kind} base_scope WHERE base_scope.${kind}_id=${expression})`;
}
function visibleSubmissions(alias, user) {
  const uid = Number(user && user.id || 0);
  if (isAdmin(user)) return '1=1';
  return `((${outside('contest', `${alias}.type_info`)} OR ${alias}.type<>1 OR EXISTS (SELECT 1 FROM base_workspace_member bm WHERE bm.user_id=${uid}))
    AND (${outside('problem', `${alias}.problem_id`)} OR EXISTS (SELECT 1 FROM base_workspace_member bm JOIN problem bp ON bp.id=${alias}.problem_id WHERE bm.user_id=${uid} AND (bp.is_public=1 OR bp.user_id=${uid}))))`;
}
// Practice history is scoped independently of contest submissions. During an
// active contest only the submission author, problem author, or site admin may
// see practice results for its problems. Both list SQL and status streams use
// this rule; a signed stream token is not a permanent permission grant.
function practiceSubmissionScope(alias, user) {
  const uid = Number(user && user.id || 0);
  const scope = `(${alias}.type=0 AND EXISTS (SELECT 1 FROM base_workspace_problem b WHERE b.problem_id=${alias}.problem_id))`;
  if (isAdmin(user)) return scope;
  return `${scope} AND ${visibleSubmissions(alias, user)} AND (${alias}.user_id=${uid}
    OR EXISTS (SELECT 1 FROM problem p WHERE p.id=${alias}.problem_id AND p.user_id=${uid})
    OR NOT EXISTS (SELECT 1 FROM contest active_contest WHERE active_contest.end_time>UNIX_TIMESTAMP()
      AND CONCAT('|',COALESCE(active_contest.problems,''),'|') LIKE CONCAT('%|',${alias}.problem_id,'|%')))`;
}
async function canReadPracticeSubmission(judge, user) {
  if (!judge || Number(judge.type) !== 0 || !await contains('problem', judge.problem_id)) return false;
  const problem = await syzoj.model('problem').findById(Number(judge.problem_id));
  if (!await canReadProblem(problem, user)) return false;
  if (isAdmin(user) || Number(judge.user_id) === Number(user.id) || Number(problem.user_id) === Number(user.id)) return true;
  const rows = await TypeORM.getConnection().query(`SELECT id FROM contest WHERE end_time>UNIX_TIMESTAMP()
    AND CONCAT('|',COALESCE(problems,''),'|') LIKE ? LIMIT 1`, [`%|${Number(judge.problem_id)}|%`]);
  return !rows.length;
}
function csvEntries(buffer) {
  const rows = parseCsv(buffer.toString('utf8'));
  const index = (rows.shift() || []).findIndex(value => ['学号', 'student_id', 'studentid'].includes(value.trim().toLowerCase()));
  if (index < 0) throw new Error('CSV 表头必须包含“学号”。');
  if (!rows.length || rows.length > 1000) throw new Error('CSV 需要包含 1 至 1000 行学号。');
  const seen = new Set();
  return rows.map((row, i) => {
    const student_id = String(row[index] || '').trim();
    const reason = !/^\d{10}$/.test(student_id) ? '学号必须为 10 位数字' : seen.has(student_id) ? '文件中重复' : null;
    seen.add(student_id);
    return { row: i + 2, student_id, reason };
  });
}
// Close active long-lived connections when membership is revoked.
const connections = new Map();
function trackConnection(userId, res) {
  if (!userId) return;
  const id = Number(userId);
  if (!connections.has(id)) connections.set(id, new Set());
  const set = connections.get(id); set.add(res);
  res.once('close', () => { set.delete(res); if (!set.size) connections.delete(id); });
}
function revokeConnections(ids) {
  for (const id of ids) for (const res of connections.get(Number(id)) || []) res.end();
}

module.exports = { ensureSchema, identity, isAdmin, isMember, contains, canReadProblem, canManage, canAccessContest,
  canAccessSubmission, authorize, allowCreate, validContestProblem, canReadOperation, assertMayHideProblem, validateContestSelection,
  outside, visibleSubmissions, practiceSubmissionScope, canReadPracticeSubmission, migrationStates, csvEntries, trackConnection, revokeConnections };
