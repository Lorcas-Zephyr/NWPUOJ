const crypto = require('crypto');
const TypeORM = require('typeorm');
const Contest = syzoj.model('contest');
const User = syzoj.model('user');
const Problem = syzoj.model('problem');
const contestMutation = require('../libs/contest-mutation');
const contestDeletion = require('../libs/contest-deletion');
const { contestConfigurationLocked, resolveContestStatus, snapshotRefreshAllowed, standingsVisibility, transitionAllowed } = require('../libs/contest-lifecycle');
const { advanceStandingsPointers, calculateStandingRows, serializeStandingRow } = require('../libs/contest-standings');

let schemaPromise = null;
const STATUS_ORDER = ['draft', 'review', 'scheduled', 'running', 'frozen', 'ended', 'rated', 'archived'];

async function addColumnIfMissing(connection, table, column, definition) {
  const rows = await connection.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  if (!rows.length) await connection.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function ensureContestV2Schema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const connection = TypeORM.getConnection();
    await connection.query(`CREATE TABLE IF NOT EXISTS contest_v2_state (
      contest_id INT NOT NULL PRIMARY KEY, status VARCHAR(20) NOT NULL,
      revision INT NOT NULL DEFAULT 0, frozen_at DATETIME(3) NULL,
      rated_at DATETIME(3) NULL, archived_at DATETIME(3) NULL,
      updated_at DATETIME(3) NOT NULL, updated_by INT NULL,
      KEY idx_contest_v2_state_status(status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS contest_v2_problem_snapshot (
      id VARCHAR(80) NOT NULL PRIMARY KEY, contest_id INT NOT NULL,
      problem_id INT NOT NULL, ordinal INT NOT NULL, alias VARCHAR(12) NOT NULL,
      score DECIMAL(10,2) NOT NULL DEFAULT 1, penalty INT NOT NULL DEFAULT 20,
      problem_snapshot_id VARCHAR(80) NULL, snapshot_hash CHAR(64) NOT NULL, created_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_contest_v2_problem(contest_id,problem_id),
      UNIQUE KEY uq_contest_v2_alias(contest_id,alias)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await addColumnIfMissing(connection, 'contest_v2_problem_snapshot', 'problem_snapshot_id', 'VARCHAR(80) NULL AFTER penalty');
    await connection.query(`CREATE TABLE IF NOT EXISTS contest_v2_standings_version (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      contest_id INT NOT NULL, version_number INT UNSIGNED NOT NULL,
      kind VARCHAR(24) NOT NULL, contest_status VARCHAR(20) NOT NULL,
      source_submission_id BIGINT UNSIGNED NULL, row_count INT UNSIGNED NOT NULL DEFAULT 0,
      content_hash CHAR(64) NOT NULL, reason VARCHAR(512) NULL,
      created_by INT NULL, created_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_contest_v2_standings_version(contest_id,version_number),
      KEY idx_contest_v2_standings_kind(contest_id,kind,id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS contest_v2_standing_row (
      version_id BIGINT UNSIGNED NOT NULL, position INT UNSIGNED NOT NULL,
      standing_rank INT UNSIGNED NOT NULL, participant_id INT NOT NULL, user_id INT NOT NULL,
      username VARCHAR(256) NOT NULL, score DECIMAL(16,3) NOT NULL DEFAULT 0,
      penalty BIGINT NOT NULL DEFAULT 0, details_json LONGTEXT NOT NULL,
      diagnostics_json LONGTEXT NOT NULL,
      PRIMARY KEY(version_id,position), UNIQUE KEY uq_contest_v2_standing_participant(version_id,participant_id),
      KEY idx_contest_v2_standing_user(version_id,user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS contest_v2_standings_current (
      contest_id INT NOT NULL PRIMARY KEY, live_version_id BIGINT UNSIGNED NULL,
      public_version_id BIGINT UNSIGNED NULL, frozen_version_id BIGINT UNSIGNED NULL,
      final_version_id BIGINT UNSIGNED NULL, updated_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS contest_v2_config (
      contest_id INT NOT NULL PRIMARY KEY, timezone VARCHAR(64) NOT NULL,
      rules_json LONGTEXT NOT NULL, scoring_json LONGTEXT NOT NULL,
      visibility VARCHAR(16) NOT NULL, security_json LONGTEXT NOT NULL,
      registration_json LONGTEXT NOT NULL, teams_json LONGTEXT NOT NULL,
      rated_profile VARCHAR(32) NULL, revision INT UNSIGNED NOT NULL DEFAULT 1,
      updated_by INT NULL, updated_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS contest_v2_standings_job (
      id CHAR(36) NOT NULL PRIMARY KEY, contest_id INT NOT NULL,
      state VARCHAR(24) NOT NULL, stage VARCHAR(32) NOT NULL,
      processed INT UNSIGNED NOT NULL DEFAULT 0, total INT UNSIGNED NOT NULL DEFAULT 0,
      current_user_id INT NULL, actor_id INT NOT NULL, reason VARCHAR(1000) NOT NULL,
      cancel_requested TINYINT(1) NOT NULL DEFAULT 0,
      result_version_id BIGINT UNSIGNED NULL, error_json LONGTEXT NULL,
      created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
      completed_at DATETIME(3) NULL,
      KEY idx_contest_v2_standings_job(contest_id,updated_at),
      KEY idx_contest_v2_standings_job_state(state,updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  })().catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}

function iso(seconds) { return seconds == null ? null : new Date(Number(seconds) * 1000).toISOString(); }
function databaseIso(value) {
  if (value == null) return null;
  if (typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value)) return new Date(value).toISOString();
  if (value instanceof Date) return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate(), value.getHours(), value.getMinutes(), value.getSeconds(), value.getMilliseconds())).toISOString();
  return new Date(`${String(value).replace(' ', 'T')}Z`).toISOString();
}
function instant(value, fallbackSeconds) {
  if (value == null || value === '') return fallbackSeconds == null ? NaN : Number(fallbackSeconds) * 1000;
  if (typeof value === 'number') return value < 100000000000 ? value * 1000 : value;
  return Date.parse(value);
}
function parseJson(value, fallback) { try { return typeof value === 'object' ? value : JSON.parse(value || ''); } catch (_) { return fallback; } }
function lifecycleFor(contest, state) {
  return resolveContestStatus(contest, state);
}
function serializeContest(contest, state, canManage) {
  const parsedProblemIds = parseJson(contest.problems, null);
  const problemIds = Array.isArray(parsedProblemIds)
    ? parsedProblemIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0)
    : String(contest.problems || '').split('|').filter(Boolean).map(Number);
  return {
    id: Number(contest.id), title: contest.title, subtitle: contest.subtitle || '',
    information: contest.information || '', type: contest.type || 'acm',
    status: lifecycleFor(contest, state), start_at: iso(contest.start_time), end_at: iso(contest.end_time),
    visibility: contest.is_public ? 'public' : 'private', hide_statistics: !!contest.hide_statistics,
    holder_id: Number(contest.holder_id), problem_ids: problemIds,
    admins: String(contest.admins || '').split('|').filter(Boolean).map(Number),
    can_manage: !!canManage,
    revision: state ? Number(state.revision || 0) : 0
  };
}

async function stateFor(contestId) {
  await ensureContestV2Schema();
  const rows = await TypeORM.getConnection().query('SELECT * FROM contest_v2_state WHERE contest_id=? LIMIT 1', [contestId]);
  return rows[0] || null;
}

function configResource(row) {
  return {
    contest_id: Number(row.contest_id), timezone: row.timezone,
    rules: parseJson(row.rules_json, {}), scoring: parseJson(row.scoring_json, {}),
    visibility: row.visibility, security: parseJson(row.security_json, {}),
    registration: parseJson(row.registration_json, {}), teams: parseJson(row.teams_json, {}),
    rated_profile: row.rated_profile || null, revision: Number(row.revision || 0),
    updated_by: row.updated_by == null ? null : Number(row.updated_by),
    updated_at: databaseIso(row.updated_at)
  };
}

function serializeContestProblemSnapshot(row) {
  return {
    id: String(row.id), contest_id: Number(row.contest_id), problem_id: Number(row.problem_id),
    problem_snapshot_id: row.problem_snapshot_id || null, ordinal: Number(row.ordinal), alias: row.alias,
    score: Number(row.score), penalty: Number(row.penalty), snapshot_hash: row.snapshot_hash,
    created_at: databaseIso(row.created_at)
  };
}

async function loadContestConfig(contest) {
  await ensureContestV2Schema();
  const connection = TypeORM.getConnection();
  let rows = await connection.query('SELECT * FROM contest_v2_config WHERE contest_id=? LIMIT 1', [contest.id]);
  if (rows.length) return configResource(rows[0]);
  const problemIds = (await contest.getProblems()).map(Number);
  const ranklists = await connection.query('SELECT ranking_params FROM contest_ranklist WHERE id=? LIMIT 1', [contest.ranklist_id]);
  const weights = parseJson(ranklists[0] && ranklists[0].ranking_params, {});
  let allowLate = false;
  let isRated = false;
  try {
    const registration = await connection.query('SELECT allow_late_registration FROM contest_registration_setting WHERE contest_id=? LIMIT 1', [contest.id]);
    allowLate = !!(registration[0] && registration[0].allow_late_registration);
    const rating = await connection.query('SELECT is_rated FROM contest_rating_config WHERE contest_id=? LIMIT 1', [contest.id]);
    isRated = !!(rating[0] && rating[0].is_rated);
  } catch (_) {
    // Legacy auxiliary tables are initialized later during a clean installation.
  }
  const rules = { mode: ['acm', 'ioi', 'noi'].includes(contest.type) ? contest.type : 'acm', tie_break: contest.type === 'acm' ? 'penalty' : 'score' };
  const scoring = {
    penalty_minutes: 20,
    problems: problemIds.map((problemId, index) => ({ problem_id: problemId, alias: String.fromCharCode(65 + index), score: Number(weights[problemId] == null ? 1 : weights[problemId]), penalty: 20 }))
  };
  const security = { result_visibility: 'public_after_end', submission_visibility: 'own_during_contest', allow_vjudge: false };
  const registration = { enabled: true, allow_late_registration: allowLate, approval_required: false };
  const teams = { enabled: false, minimum_size: 1, maximum_size: 1 };
  await connection.query(`INSERT IGNORE INTO contest_v2_config
    (contest_id,timezone,rules_json,scoring_json,visibility,security_json,registration_json,teams_json,rated_profile,revision,updated_by,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,1,?,UTC_TIMESTAMP(3))`, [contest.id, 'Asia/Shanghai', JSON.stringify(rules), JSON.stringify(scoring), contest.is_public ? 'public' : 'private', JSON.stringify(security), JSON.stringify(registration), JSON.stringify(teams), isRated ? (contest.type === 'ioi' || contest.type === 'noi' ? 'ioi' : 'icpc') : null, contest.holder_id || null]);
  rows = await connection.query('SELECT * FROM contest_v2_config WHERE contest_id=? LIMIT 1', [contest.id]);
  return configResource(rows[0]);
}

function plainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function jsonSize(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
function validTimezone(value) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch (_) { return false; }
}
function normalizedContestConfig(body, current, problemIds) {
  const timezone = body.timezone == null ? current.timezone : String(body.timezone).trim();
  const rules = body.rules == null ? current.rules : body.rules;
  const scoring = body.scoring == null ? current.scoring : body.scoring;
  const visibility = body.visibility == null ? current.visibility : String(body.visibility);
  const security = body.security == null ? current.security : body.security;
  const registration = body.registration == null ? current.registration : body.registration;
  const teams = body.teams == null ? current.teams : body.teams;
  const ratedProfile = body.rated_profile === undefined ? current.rated_profile : (body.rated_profile == null || body.rated_profile === '' ? null : String(body.rated_profile));
  if (!validTimezone(timezone)) throw Object.assign(new Error('A valid IANA timezone is required.'), { code: 'CONTEST_CONFIG_INVALID', statusCode: 422 });
  if (![rules, scoring, security, registration, teams].every(plainObject) || [rules, scoring, security, registration, teams].some(value => jsonSize(value) > 20000)) throw Object.assign(new Error('Contest configuration sections must be objects no larger than 20 KB.'), { code: 'CONTEST_CONFIG_INVALID', statusCode: 422 });
  if (!['acm', 'ioi', 'noi', 'custom'].includes(String(rules.mode || ''))) throw Object.assign(new Error('Contest rule mode must be acm, ioi, noi, or custom.'), { code: 'CONTEST_CONFIG_INVALID', statusCode: 422 });
  if (!['public', 'private'].includes(visibility)) throw Object.assign(new Error('Contest visibility must be public or private.'), { code: 'CONTEST_CONFIG_INVALID', statusCode: 422 });
  if (ratedProfile && !['icpc', 'ioi', 'practice', 'vjudge'].includes(ratedProfile)) throw Object.assign(new Error('Unknown Rating profile.'), { code: 'CONTEST_CONFIG_INVALID', statusCode: 422 });
  const configuredProblems = Array.isArray(scoring.problems) ? scoring.problems : [];
  if (configuredProblems.length !== problemIds.length) throw Object.assign(new Error('Scoring must configure every contest problem exactly once.'), { code: 'CONTEST_CONFIG_INVALID', statusCode: 422 });
  const seenProblems = new Set();
  const seenAliases = new Set();
  const normalizedProblems = configuredProblems.map((item, index) => {
    const problemId = Number(item && item.problem_id);
    const alias = String(item && item.alias || String.fromCharCode(65 + index)).trim().toUpperCase();
    const score = Number(item && item.score);
    const penalty = Number(item && item.penalty != null ? item.penalty : scoring.penalty_minutes);
    if (!problemIds.includes(problemId) || seenProblems.has(problemId) || !/^[A-Z0-9]{1,12}$/.test(alias) || seenAliases.has(alias) || !Number.isFinite(score) || score < 0 || score > 100000 || !Number.isSafeInteger(penalty) || penalty < 0 || penalty > 600) throw Object.assign(new Error('Problem scoring contains an invalid problem, alias, score, or penalty.'), { code: 'CONTEST_SCORING_INVALID', statusCode: 422 });
    seenProblems.add(problemId); seenAliases.add(alias);
    return { problem_id: problemId, alias, score, penalty };
  });
  const minimumSize = Number(teams.minimum_size == null ? 1 : teams.minimum_size);
  const maximumSize = Number(teams.maximum_size == null ? 1 : teams.maximum_size);
  if (![minimumSize, maximumSize].every(Number.isSafeInteger) || minimumSize < 1 || maximumSize < minimumSize || maximumSize > 20) throw Object.assign(new Error('Team size must be between 1 and 20.'), { code: 'CONTEST_TEAMS_INVALID', statusCode: 422 });
  const penaltyMinutes = Number(scoring.penalty_minutes == null ? 20 : scoring.penalty_minutes);
  if (!Number.isSafeInteger(penaltyMinutes) || penaltyMinutes < 0 || penaltyMinutes > 600) throw Object.assign(new Error('Default penalty must be an integer from 0 to 600 minutes.'), { code: 'CONTEST_SCORING_INVALID', statusCode: 422 });
  return {
    timezone, rules: Object.assign({}, rules, { mode: String(rules.mode) }),
    scoring: Object.assign({}, scoring, { penalty_minutes: penaltyMinutes, problems: normalizedProblems }),
    visibility, security, registration: Object.assign({}, registration, { enabled: registration.enabled !== false, allow_late_registration: !!registration.allow_late_registration, approval_required: !!registration.approval_required }),
    teams: Object.assign({}, teams, { enabled: !!teams.enabled, minimum_size: minimumSize, maximum_size: maximumSize }), rated_profile: ratedProfile
  };
}
async function requireManager(contest, user, action, res) {
  if (!user) { syzoj.utils.apiV2.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); return false; }
  const scoped = user && (await contest.isSupervisior(user)) && await syzoj.utils.authorizationV2.authorize(user, action, { ownerId: contest.holder_id, scope: `contest:${contest.id}` }, { scope: `contest:${contest.id}` });
  const global = user && await syzoj.utils.authorizationV2.authorize(user, action, null, { scope: 'global' });
  const allowed = !!(scoped || global);
  if (!allowed) { syzoj.utils.apiV2.fail(res, 403, 'CAPABILITY_REQUIRED', `Capability required: ${action}.`); return false; }
  return true;
}
async function canManageContest(contest, user, action) {
  if (!user) return false;
  const scoped = (await contest.isSupervisior(user)) && await syzoj.utils.authorizationV2.authorize(user, action, { ownerId: contest.holder_id, scope: `contest:${contest.id}` }, { scope: `contest:${contest.id}` });
  return !!(scoped || await syzoj.utils.authorizationV2.authorize(user, action, null, { scope: 'global' }));
}
async function isActiveParticipant(contestId, user) {
  if (!user) return false;
  const rows = await TypeORM.getConnection().query(
    `SELECT participant.id FROM contest_player participant
     LEFT JOIN contest_registration_removal removal
       ON removal.contest_id=participant.contest_id AND removal.user_id=participant.user_id
     WHERE participant.contest_id=? AND participant.user_id=? AND removal.user_id IS NULL LIMIT 1`,
    [contestId, user.id]
  );
  return rows.length > 0;
}
async function writeState(contest, status, user, reason, req) {
  await ensureContestV2Schema();
  const connection = TypeORM.getConnection();
  const current = await stateFor(contest.id);
  const currentStatus = lifecycleFor(contest, current);
  if (current && currentStatus === status && current.status === status) return current;
  if (!transitionAllowed(currentStatus, status)) {
    const error = new Error(`Invalid contest transition: ${currentStatus} -> ${status}`); error.statusCode = 409; throw error;
  }
  await connection.query(`INSERT INTO contest_v2_state (contest_id,status,revision,frozen_at,rated_at,archived_at,updated_at,updated_by)
    VALUES (?,?,1,?,?,?,UTC_TIMESTAMP(3),?) ON DUPLICATE KEY UPDATE status=VALUES(status),revision=revision+1,
    frozen_at=CASE WHEN VALUES(status)='frozen' THEN VALUES(frozen_at) ELSE frozen_at END,
    rated_at=CASE WHEN VALUES(status)='rated' THEN VALUES(rated_at) ELSE rated_at END,
    archived_at=CASE WHEN VALUES(status)='archived' THEN VALUES(archived_at) ELSE archived_at END,
    updated_at=VALUES(updated_at),updated_by=VALUES(updated_by)`,
    [contest.id, status, status === 'frozen' ? new Date() : null, status === 'rated' ? new Date() : null, status === 'archived' ? new Date() : null, user && user.id]);
  const fromStatus = current ? current.status : currentStatus;
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: `contest:${status}`, resourceType: 'contest', resourceId: contest.id, reason: reason || null, details: { from: fromStatus, to: status } });
  await syzoj.utils.apiV2.appendEvent({ stream: `contest:${contest.id}`, type: `contest.${status}`, aggregateId: contest.id, actor: user, payload: { contest_id: Number(contest.id), from: fromStatus, to: status, audit_event_id: auditEventId } });
  if (req && req.res) req.res.setHeader('X-Audit-Event-ID', auditEventId);
  const updated = await stateFor(contest.id);
  if (updated) updated.audit_event_id = auditEventId;
  return updated;
}

async function snapshotProblems(contest, user, req, options) {
  await ensureContestV2Schema();
  const connection = TypeORM.getConnection();
  const ids = await contest.getProblems();
  const config = await loadContestConfig(contest);
  const scoringByProblem = new Map((config.scoring.problems || []).map(item => [Number(item.problem_id), item]));
  if (options && options.refresh) await connection.query('DELETE FROM contest_v2_problem_snapshot WHERE contest_id=?', [contest.id]);
  const existing = await connection.query('SELECT id,problem_id,problem_snapshot_id FROM contest_v2_problem_snapshot WHERE contest_id=?', [contest.id]);
  const existingByProblem = new Map(existing.map(row => [Number(row.problem_id), row]));
  for (let index = 0; index < ids.length; index++) {
    const problemId = Number(ids[index]);
    const existingSnapshot = existingByProblem.get(problemId);
    if (existingSnapshot && existingSnapshot.problem_snapshot_id) continue;
    const problem = await syzoj.model('problem').findById(problemId);
    if (!problem) continue;
    const scoring = scoringByProblem.get(problemId) || { alias: String.fromCharCode(65 + index), score: 1, penalty: 20 };
    const problemSnapshotId = await syzoj.utils.problemV2.ensureCurrentSnapshot(problem, user && user.id || problem.user_id);
    const snapshots = await connection.query('SELECT id,content_hash FROM problem_v2_snapshot WHERE id=? AND problem_id=? LIMIT 1', [problemSnapshotId, problemId]);
    if (!snapshots.length) throw Object.assign(new Error('The immutable problem snapshot could not be loaded.'), { code: 'PROBLEM_SNAPSHOT_REQUIRED', statusCode: 409 });
    const sourceSnapshot = snapshots[0];
    const snapshotId = `contest_${contest.id}_${problemId}_${String(sourceSnapshot.content_hash).slice(0, 16)}`;
    // Old rows only stored a derived hash. Replace them before the contest starts,
    // so every live contest row links to an immutable ProblemSnapshot.
    if (existingSnapshot) await connection.query('DELETE FROM contest_v2_problem_snapshot WHERE id=?', [existingSnapshot.id]);
    await connection.query('INSERT INTO contest_v2_problem_snapshot (id,contest_id,problem_id,ordinal,alias,score,penalty,problem_snapshot_id,snapshot_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))', [snapshotId, contest.id, problemId, index, scoring.alias, scoring.score, scoring.penalty, sourceSnapshot.id, sourceSnapshot.content_hash]);
  }
  await syzoj.utils.authorizationV2.recordAudit(req, { action: 'contest:snapshot', resourceType: 'contest', resourceId: contest.id, reason: 'Lock contest problem set', details: { actor_id: user && user.id, count: ids.length, immutable_problem_snapshots: true } });
}

async function loadContestProblemSnapshot(contestId, problemId) {
  await ensureContestV2Schema();
  const rows = await TypeORM.getConnection().query(
    'SELECT problem_snapshot_id,snapshot_hash FROM contest_v2_problem_snapshot WHERE contest_id=? AND problem_id=? LIMIT 1',
    [Number(contestId), Number(problemId)]
  );
  return rows[0] || null;
}

function standingsKind(status, requested) {
  if (requested) return requested;
  if (status === 'frozen') return 'frozen';
  if (['ended', 'rated', 'archived'].includes(status)) return 'final';
  return 'realtime';
}

async function standingSource(manager, contest) {
  const players = await manager.query(
    `SELECT cp.id AS participant_id,cp.user_id,u.username,cp.score_details
     FROM contest_player cp INNER JOIN user u ON u.id=cp.user_id
     LEFT JOIN contest_registration_removal removal
       ON removal.contest_id=cp.contest_id AND removal.user_id=cp.user_id
     WHERE cp.contest_id=? AND removal.user_id IS NULL`,
    [contest.id]
  );
  const ranklists = await manager.query('SELECT ranking_params FROM contest_ranklist WHERE id=? LIMIT 1', [contest.ranklist_id]);
  const rankingParams = parseJson(ranklists[0] && ranklists[0].ranking_params, {});
  const judgeIds = [];
  for (const player of players) {
    const details = parseJson(player.score_details, {});
    for (const detail of Object.values(details)) if (detail && detail.judge_id) judgeIds.push(Number(detail.judge_id));
  }
  const judgeTimes = new Map();
  if (judgeIds.length) {
    const judges = await manager.query('SELECT id,submit_time FROM judge_state WHERE id IN (?)', [Array.from(new Set(judgeIds))]);
    judges.forEach(row => judgeTimes.set(Number(row.id), Number(row.submit_time || 0)));
  }
  const watermarkRows = await manager.query('SELECT MAX(id) AS id FROM judge_state WHERE type=1 AND type_info=?', [contest.id]);
  const rows = calculateStandingRows({ type: contest.type, startTime: contest.start_time, rankingParams, judgeTimes, players });
  rows.forEach(row => {
    row.diagnostics = {
      source_submission_ids: Object.values(row.details).map(detail => Number(detail && detail.judge_id)).filter(Number.isSafeInteger)
    };
  });
  return { rows, sourceSubmissionId: watermarkRows[0] && watermarkRows[0].id == null ? null : Number(watermarkRows[0].id) };
}

async function insertStandingRows(manager, versionId, rows) {
  for (let offset = 0; offset < rows.length; offset += 200) {
    const chunk = rows.slice(offset, offset + 200);
    const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',');
    const params = [];
    chunk.forEach((row, index) => params.push(
      versionId, offset + index + 1, row.rank, row.participant_id, row.user_id,
      row.username, row.score, row.penalty, JSON.stringify(row.details), JSON.stringify(row.diagnostics || {})
    ));
    await manager.query(`INSERT INTO contest_v2_standing_row
      (version_id,position,standing_rank,participant_id,user_id,username,score,penalty,details_json,diagnostics_json)
      VALUES ${placeholders}`, params);
  }
}

async function projectStandings(contestId, options) {
  options = options || {};
  await ensureContestV2Schema();
  const result = await TypeORM.getConnection().transaction('READ COMMITTED', async manager => {
    const contests = await manager.query('SELECT * FROM contest WHERE id=? FOR UPDATE', [Number(contestId)]);
    if (!contests.length) throw Object.assign(new Error('Contest was not found.'), { statusCode: 404, code: 'CONTEST_NOT_FOUND' });
    const contest = contests[0];
    let states = await manager.query('SELECT * FROM contest_v2_state WHERE contest_id=? FOR UPDATE', [contest.id]);
    if (!states.length) {
      const initialStatus = lifecycleFor(contest, null);
      await manager.query('INSERT INTO contest_v2_state (contest_id,status,revision,updated_at,updated_by) VALUES (?,?,0,UTC_TIMESTAMP(3),?)', [contest.id, initialStatus, options.actor && options.actor.id || null]);
      states = await manager.query('SELECT * FROM contest_v2_state WHERE contest_id=? FOR UPDATE', [contest.id]);
    }
    const status = lifecycleFor(contest, states[0]);
    const kind = standingsKind(status, options.kind);
    if (!['initial', 'realtime', 'frozen', 'unfrozen', 'final', 'rebuild'].includes(kind)) {
      throw Object.assign(new Error('Invalid standings projection kind.'), { statusCode: 422, code: 'STANDINGS_KIND_INVALID' });
    }
    const source = await standingSource(manager, contest);
    const contentHash = crypto.createHash('sha256').update(JSON.stringify(source.rows.map(row => ({
      participant_id: row.participant_id, user_id: row.user_id, rank: row.rank,
      score: row.score, penalty: row.penalty, details: row.details
    })))).digest('hex');
    const latest = await manager.query('SELECT * FROM contest_v2_standings_version WHERE contest_id=? ORDER BY version_number DESC LIMIT 1', [contest.id]);
    if ((kind === 'realtime' || options.deduplicate) && latest.length && latest[0].content_hash === contentHash && latest[0].contest_status === status && (!options.deduplicate || latest[0].kind === kind)) {
      return { created: false, contest, version: latest[0], rows: source.rows };
    }
    const versionNumber = latest.length ? Number(latest[0].version_number) + 1 : 1;
    const inserted = await manager.query(`INSERT INTO contest_v2_standings_version
      (contest_id,version_number,kind,contest_status,source_submission_id,row_count,content_hash,reason,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`, [contest.id, versionNumber, kind, status, source.sourceSubmissionId, source.rows.length, contentHash, options.reason || null, options.actor && options.actor.id || null]);
    const versionId = Number(inserted.insertId);
    await insertStandingRows(manager, versionId, source.rows);
    const currents = await manager.query('SELECT * FROM contest_v2_standings_current WHERE contest_id=? FOR UPDATE', [contest.id]);
    const pointers = advanceStandingsPointers(currents[0], versionId, kind, status);
    await manager.query(`INSERT INTO contest_v2_standings_current
      (contest_id,live_version_id,public_version_id,frozen_version_id,final_version_id,updated_at)
      VALUES (?,?,?,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE
      live_version_id=VALUES(live_version_id),public_version_id=VALUES(public_version_id),
      frozen_version_id=VALUES(frozen_version_id),final_version_id=VALUES(final_version_id),updated_at=UTC_TIMESTAMP(3)`,
    [contest.id, pointers.live_version_id, pointers.public_version_id, pointers.frozen_version_id, pointers.final_version_id]);
    return { created: true, contest, version: Object.assign({}, {
      id: versionId, contest_id: contest.id, version_number: versionNumber, kind,
      contest_status: status, source_submission_id: source.sourceSubmissionId,
      row_count: source.rows.length, content_hash: contentHash, reason: options.reason || null,
      created_by: options.actor && options.actor.id || null, created_at: new Date().toISOString()
    }), rows: source.rows };
  });
  if (result.created) {
    await syzoj.utils.apiV2.appendEvent({
      stream: `contest:${contestId}`, type: 'contest.standings.projected', aggregateId: contestId,
      actor: options.actor || null,
      payload: { contest_id: Number(contestId), version: Number(result.version.version_number), version_id: Number(result.version.id), kind: result.version.kind, row_count: Number(result.version.row_count), content_hash: result.version.content_hash }
    });
  }
  if (syzoj.utils.invalidateContestReadCache) syzoj.utils.invalidateContestReadCache(contestId);
  return result;
}

const projectionTimers = new Map();
function scheduleStandingsProjection(contestId, options) {
  const id = Number(contestId);
  if (projectionTimers.has(id)) clearTimeout(projectionTimers.get(id));
  const timer = setTimeout(() => {
    projectionTimers.delete(id);
    projectStandings(id, options).catch(error => syzoj.log(`[contest-standings-v2] projection failed for #${id}: ${error.stack || error.message}`));
  }, 250);
  if (timer.unref) timer.unref();
  projectionTimers.set(id, timer);
}

function serializeStandingsJob(row) {
  return {
    id: row.id, contest_id: Number(row.contest_id), state: row.state, stage: row.stage,
    progress: { processed: Number(row.processed || 0), total: Number(row.total || 0), failed: row.state === 'failed' ? 1 : 0 },
    current_user_id: row.current_user_id == null ? null : Number(row.current_user_id),
    actor_id: Number(row.actor_id), reason: row.reason,
    result_version_id: row.result_version_id == null ? null : Number(row.result_version_id),
    error: parseJson(row.error_json, null), created_at: databaseIso(row.created_at),
    updated_at: databaseIso(row.updated_at), completed_at: databaseIso(row.completed_at)
  };
}

async function runStandingsRebuildJob(jobId) {
  await ensureContestV2Schema();
  const connection = TypeORM.getConnection();
  const claimed = await connection.query("UPDATE contest_v2_standings_job SET state='running',stage='rebuilding',updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state='queued' AND cancel_requested=0", [jobId]);
  if (!claimed.affectedRows) return;
  const rows = await connection.query('SELECT * FROM contest_v2_standings_job WHERE id=? LIMIT 1', [jobId]);
  if (!rows.length) return;
  const job = rows[0];
  await syzoj.utils.apiV2.appendEvent({ stream: `standings-job:${jobId}`, type: 'standings.rebuild.running', aggregateId: jobId, actor: { id: job.actor_id }, payload: { contest_id: Number(job.contest_id) } });
  const cancelled = async () => {
    const state = await connection.query('SELECT cancel_requested FROM contest_v2_standings_job WHERE id=? LIMIT 1', [jobId]);
    return !state.length || !!state[0].cancel_requested;
  };
  try {
    const participantCount = await contestMutation.rebuildContestStandings(job.contest_id, {
      shouldCancel: cancelled,
      onProgress: progress => connection.query("UPDATE contest_v2_standings_job SET processed=?,total=?,current_user_id=?,updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state='running'", [progress.processed, progress.total, progress.userId, jobId])
    });
    if (await cancelled()) throw Object.assign(new Error('Standings rebuild was cancelled.'), { code: 'JOB_CANCELLED' });
    await connection.query("UPDATE contest_v2_standings_job SET stage='projecting',processed=?,total=?,current_user_id=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [participantCount, participantCount, jobId]);
    const projection = await projectStandings(job.contest_id, { kind: 'rebuild', actor: { id: job.actor_id }, reason: job.reason });
    await connection.query("UPDATE contest_v2_standings_job SET state='completed',stage='completed',processed=?,total=?,result_version_id=?,error_json=NULL,completed_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3) WHERE id=?", [participantCount, participantCount, projection.version.id, jobId]);
    await syzoj.utils.apiV2.appendEvent({ stream: `contest:${job.contest_id}`, type: 'contest.standings.rebuild.completed', aggregateId: job.contest_id, actor: { id: job.actor_id }, payload: { job_id: jobId, version_id: Number(projection.version.id), version: Number(projection.version.version_number), participant_count: participantCount } });
    await syzoj.utils.apiV2.appendEvent({ stream: `standings-job:${jobId}`, type: 'standings.rebuild.completed', aggregateId: jobId, actor: { id: job.actor_id }, payload: { contest_id: Number(job.contest_id), version_id: Number(projection.version.id), participant_count: participantCount } });
  } catch (error) {
    if (error.code === 'JOB_CANCELLED') {
      await connection.query("UPDATE contest_v2_standings_job SET state='cancelled',stage='cancelled',current_user_id=NULL,completed_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
      await syzoj.utils.apiV2.appendEvent({ stream: `standings-job:${jobId}`, type: 'standings.rebuild.cancelled', aggregateId: jobId, actor: { id: job.actor_id }, payload: { contest_id: Number(job.contest_id) } });
    } else {
      await connection.query("UPDATE contest_v2_standings_job SET state='failed',stage='failed',current_user_id=NULL,error_json=?,completed_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3) WHERE id=?", [JSON.stringify({ code: error.code || 'STANDINGS_REBUILD_FAILED', message: error.message }), jobId]);
      await syzoj.utils.apiV2.appendEvent({ stream: `standings-job:${jobId}`, type: 'standings.rebuild.failed', aggregateId: jobId, actor: { id: job.actor_id }, payload: { contest_id: Number(job.contest_id), code: error.code || 'STANDINGS_REBUILD_FAILED' } });
    }
  }
}

async function recoverStandingsJobs() {
  await ensureContestV2Schema();
  const connection = TypeORM.getConnection();
  await connection.query("UPDATE contest_v2_standings_job SET state='cancelled',stage='cancelled',current_user_id=NULL,completed_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3) WHERE state IN ('queued','running','cancelling') AND cancel_requested=1");
  await connection.query("UPDATE contest_v2_standings_job SET state='queued',stage='recovery',current_user_id=NULL,updated_at=UTC_TIMESTAMP(3) WHERE state IN ('running','cancelling') AND cancel_requested=0");
  const jobs = await connection.query("SELECT id FROM contest_v2_standings_job WHERE state='queued' AND cancel_requested=0 ORDER BY created_at ASC");
  for (const job of jobs) await runStandingsRebuildJob(job.id);
}

function serializeVersion(row) {
  return {
    id: Number(row.id), contest_id: Number(row.contest_id), version: Number(row.version_number),
    kind: row.kind, contest_status: row.contest_status,
    source_submission_id: row.source_submission_id == null ? null : Number(row.source_submission_id),
    row_count: Number(row.row_count), content_hash: row.content_hash, reason: row.reason || null,
    created_by: row.created_by == null ? null : Number(row.created_by), created_at: databaseIso(row.created_at)
  };
}

async function loadStandingVersion(versionId, req, scope, contestType) {
  const api = syzoj.utils.apiV2;
  const limit = api.parseLimit(req, 100, 200);
  const cursor = Number(api.decodeCursor(req.query.cursor) || 0);
  const versions = await TypeORM.getConnection().query('SELECT * FROM contest_v2_standings_version WHERE id=? LIMIT 1', [versionId]);
  if (!versions.length) return null;
  const rows = await TypeORM.getConnection().query(`SELECT position,standing_rank AS rank,participant_id,user_id,username,score,penalty,details_json,diagnostics_json
    FROM contest_v2_standing_row WHERE version_id=? AND position>? ORDER BY position ASC LIMIT ?`, [versionId, cursor, limit + 1]);
  const hasMore = rows.length > limit;
  req.res.locals.apiMeta.limit = limit;
  req.res.locals.apiMeta.next_cursor = hasMore ? api.encodeCursor(Number(rows[limit - 1].position)) : null;
  return {
    version: serializeVersion(versions[0]),
    rows: rows.slice(0, limit).map(row => serializeStandingRow({
      rank: row.rank, participant_id: row.participant_id, user_id: row.user_id,
      username: row.username, score: row.score, penalty: row.penalty,
      details: parseJson(row.details_json, {}), diagnostics: parseJson(row.diagnostics_json, {})
    }, { type: contestType, scope }))
  };
}

syzoj.utils.contestStandingsV2 = {
  ensureSchema: ensureContestV2Schema,
  project: projectStandings,
  schedule: scheduleStandingsProjection,
  runRebuildJob: runStandingsRebuildJob
};
syzoj.utils.contestV2 = {
  ensureSchema: ensureContestV2Schema,
  ensureConfig: loadContestConfig,
  getProblemSnapshot: loadContestProblemSnapshot,
  status: lifecycleFor,
  state: stateFor,
  transition: writeState
};

app.get('/api/v2/contests', async (req, res) => {
  const api = syzoj.utils.apiV2;
  await ensureContestV2Schema();
  const limit = api.parseLimit(req, 30, 100); const cursor = Number(api.decodeCursor(req.query.cursor) || 0);
  const items = [];
  let scanAfter = cursor;
  while (items.length <= limit) {
    const rows = await TypeORM.getConnection().query('SELECT * FROM contest WHERE id>? ORDER BY id ASC LIMIT 200', [scanAfter]);
    if (!rows.length) break;
    for (const contest of rows) {
      scanAfter = Number(contest.id);
      const manager = await canManageContest(contest, res.locals.user, 'contest:edit');
      const state = await stateFor(contest.id);
      if (lifecycleFor(contest, state) !== 'archived' && (contest.is_public || manager)) items.push(serializeContest(contest, state, manager));
      if (items.length > limit) break;
    }
    if (rows.length < 200 || items.length > limit) break;
  }
  const hasMore = items.length > limit; res.locals.apiMeta.next_cursor = hasMore ? api.encodeCursor(items[limit - 1].id) : null; res.locals.apiMeta.limit = limit;
  return api.send(res, items.slice(0, limit));
});

app.get('/api/v2/contests/:id', async (req, res) => {
  const api = syzoj.utils.apiV2; const contest = await Contest.findById(Number(req.params.id));
  if (!contest) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  const manager = await canManageContest(contest, res.locals.user, 'contest:edit');
  const participant = await isActiveParticipant(contest.id, res.locals.user);
  if (!contest.is_public && !manager && !participant) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  return api.send(res, serializeContest(contest, await stateFor(contest.id), manager));
});

app.get('/api/v2/contests/:id/config', async (req, res) => {
  const api = syzoj.utils.apiV2;
  const contest = await Contest.findById(Number(req.params.id));
  if (!contest) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  const manager = await canManageContest(contest, res.locals.user, 'contest:edit');
  const participant = await isActiveParticipant(contest.id, res.locals.user);
  if (!contest.is_public && !manager && !participant) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  const config = await loadContestConfig(contest);
  if (manager) return api.send(res, config);
  const status = lifecycleFor(contest, await stateFor(contest.id));
  const canSeeProblemConfiguration = ['ended', 'rated', 'archived'].includes(status) || (participant && ['running', 'frozen'].includes(status));
  const scoring = canSeeProblemConfiguration ? config.scoring : {
    penalty_minutes: config.scoring.penalty_minutes == null ? 20 : Number(config.scoring.penalty_minutes),
    problem_count: Array.isArray(config.scoring.problems) ? config.scoring.problems.length : 0
  };
  return api.send(res, {
    contest_id: config.contest_id, timezone: config.timezone, rules: config.rules,
    scoring, visibility: config.visibility,
    security: {
      result_visibility: config.security.result_visibility || 'public_after_end',
      submission_visibility: config.security.submission_visibility || 'own_during_contest',
      allow_vjudge: !!config.security.allow_vjudge
    },
    registration: config.registration, teams: config.teams, rated_profile: config.rated_profile,
    revision: config.revision, updated_at: config.updated_at
  });
});

app.get('/api/v2/contests/:id/problem-snapshots', async (req, res) => {
  const api = syzoj.utils.apiV2;
  const contest = await Contest.findById(Number(req.params.id));
  if (!contest) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  if (!await canManageContest(contest, res.locals.user, 'contest:edit')) {
    return api.fail(res, res.locals.user ? 403 : 401, res.locals.user ? 'CAPABILITY_REQUIRED' : 'AUTHENTICATION_REQUIRED', res.locals.user ? 'Capability required: contest:edit.' : 'Authentication is required.');
  }
  await ensureContestV2Schema();
  const limit = api.parseLimit(req, 30, 100);
  const cursor = Number(api.decodeCursor(req.query.cursor) || -1);
  const rows = await TypeORM.getConnection().query(
    'SELECT * FROM contest_v2_problem_snapshot WHERE contest_id=? AND ordinal>? ORDER BY ordinal ASC LIMIT ?',
    [contest.id, Number.isSafeInteger(cursor) ? cursor : -1, limit + 1]
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  res.locals.apiMeta.next_cursor = hasMore && page.length ? api.encodeCursor(Number(page[page.length - 1].ordinal)) : null;
  res.locals.apiMeta.limit = limit;
  return api.send(res, page.map(serializeContestProblemSnapshot));
});

app.put('/api/v2/contests/:id/config', async (req, res) => {
  const api = syzoj.utils.apiV2;
  const contest = await Contest.findById(Number(req.params.id));
  if (!contest) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  if (!(await requireManager(contest, res.locals.user, 'contest:edit', res))) return null;
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api.fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again before changing contest configuration.');
  const reason = syzoj.utils.operationReason(req, '更新比赛配置');
  try {
    const current = await loadContestConfig(contest);
    if (!req.get('If-Match')) return api.fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when editing contest configuration.', { if_match: 'required' });
    if (!api.ifMatch(req, current)) return api.fail(res, 412, 'ETAG_MISMATCH', 'The contest configuration changed. Refresh it and try again.');
    const problemIds = (await contest.getProblems()).map(Number);
    const next = normalizedContestConfig(req.body || {}, current, problemIds);
    const updated = await contestMutation.withContestLock(contest.id, () => TypeORM.getConnection().transaction('READ COMMITTED', async manager => {
      const contestRows = await manager.query('SELECT * FROM contest WHERE id=? FOR UPDATE', [contest.id]);
      const configRows = await manager.query('SELECT * FROM contest_v2_config WHERE contest_id=? FOR UPDATE', [contest.id]);
      if (!contestRows.length || !configRows.length) throw Object.assign(new Error('Contest configuration was not found.'), { code: 'CONTEST_CONFIG_NOT_FOUND', statusCode: 404 });
      const locked = configResource(configRows[0]);
      if (locked.revision !== current.revision) throw Object.assign(new Error('The contest configuration changed. Refresh it and try again.'), { code: 'ETAG_MISMATCH', statusCode: 412 });
      const stateRows = await manager.query('SELECT * FROM contest_v2_state WHERE contest_id=? FOR UPDATE', [contest.id]);
      const status = lifecycleFor(contestRows[0], stateRows[0] || null);
      const criticalChanged = JSON.stringify(locked.rules) !== JSON.stringify(next.rules) ||
        JSON.stringify(locked.scoring) !== JSON.stringify(next.scoring) ||
        JSON.stringify(locked.teams) !== JSON.stringify(next.teams) || locked.rated_profile !== next.rated_profile;
      if (contestConfigurationLocked(status) && criticalChanged) throw Object.assign(new Error('Rules, scoring, teams, and Rated profile are locked after the contest starts.'), { code: 'CONTEST_LOCKED', statusCode: 409 });
      await manager.query(`UPDATE contest_v2_config SET timezone=?,rules_json=?,scoring_json=?,visibility=?,security_json=?,registration_json=?,teams_json=?,rated_profile=?,revision=revision+1,updated_by=?,updated_at=UTC_TIMESTAMP(3) WHERE contest_id=?`,
        [next.timezone, JSON.stringify(next.rules), JSON.stringify(next.scoring), next.visibility, JSON.stringify(next.security), JSON.stringify(next.registration), JSON.stringify(next.teams), next.rated_profile, res.locals.user.id, contest.id]);
      const legacyMode = ['acm', 'ioi', 'noi'].includes(next.rules.mode) ? next.rules.mode : contestRows[0].type;
      await manager.query('UPDATE contest SET type=?,is_public=? WHERE id=?', [legacyMode, next.visibility === 'public' ? 1 : 0, contest.id]);
      const weights = Object.fromEntries(next.scoring.problems.map(item => [item.problem_id, item.score]));
      await manager.query('UPDATE contest_ranklist SET ranking_params=? WHERE id=?', [JSON.stringify(weights), contestRows[0].ranklist_id]);
      await manager.query(`INSERT INTO contest_registration_setting (contest_id,allow_late_registration,revision,updated_at)
        VALUES (?,?,1,UNIX_TIMESTAMP()) ON DUPLICATE KEY UPDATE allow_late_registration=VALUES(allow_late_registration),revision=revision+1,updated_at=VALUES(updated_at)`, [contest.id, next.registration.allow_late_registration ? 1 : 0]);
      await manager.query(`INSERT INTO contest_rating_config (contest_id,is_rated,updated_at,updated_by)
        VALUES (?,?,UNIX_TIMESTAMP(),?) ON DUPLICATE KEY UPDATE is_rated=VALUES(is_rated),updated_at=VALUES(updated_at),updated_by=VALUES(updated_by)`, [contest.id, next.rated_profile ? 1 : 0, res.locals.user.id]);
      if (!contestConfigurationLocked(status)) {
        await manager.query("UPDATE contest_v2_problem_snapshot SET alias=CONCAT('_',ordinal) WHERE contest_id=?", [contest.id]);
        for (let ordinal = 0; ordinal < next.scoring.problems.length; ordinal++) {
          const item = next.scoring.problems[ordinal];
          await manager.query('UPDATE contest_v2_problem_snapshot SET ordinal=?,alias=?,score=?,penalty=? WHERE contest_id=? AND problem_id=?', [ordinal, item.alias, item.score, item.penalty, contest.id, item.problem_id]);
        }
      }
      const fresh = await manager.query('SELECT * FROM contest_v2_config WHERE contest_id=? LIMIT 1', [contest.id]);
      return configResource(fresh[0]);
    }));
    const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'contest:config.update', resourceType: 'contest', resourceId: contest.id, reason, details: { from_revision: current.revision, to_revision: updated.revision } });
    await api.appendEvent({ stream: `contest:${contest.id}`, type: 'contest.config.updated', aggregateId: contest.id, actor: res.locals.user, payload: { revision: updated.revision, audit_event_id: auditEventId } });
    res.set('X-Audit-Event-ID', String(auditEventId));
    return api.send(res, Object.assign(updated, { audit_event_id: auditEventId }));
  } catch (error) {
    return api.fail(res, error.statusCode || 422, error.code || 'CONTEST_CONFIG_INVALID', error.message);
  }
});

async function saveContestV2(req, res, contestId) {
  const api = syzoj.utils.apiV2; const user = res.locals.user; if (!user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  const existing = contestId ? await Contest.findById(contestId) : null;
  if (existing && !(await requireManager(existing, user, 'contest:edit', res))) return null;
  if (!existing && !await syzoj.utils.authorizationV2.authorize(user, 'contest:create', null, {})) return api.fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: contest:create.');
  const currentState = existing ? await stateFor(existing.id) : null;
  const current = existing ? serializeContest(existing, currentState, true) : null;
  if (current && !req.get('If-Match')) return api.fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when editing a contest.', { if_match: 'required' });
  if (current && !api.ifMatch(req, current)) return api.fail(res, 412, 'ETAG_MISMATCH', 'The contest changed. Refresh it and try again.');
  const body = req.body || {};
  const existingConfig = existing ? await loadContestConfig(existing) : null;
  const title = String(body.title == null && existing ? existing.title : body.title || '').trim();
  const start = instant(body.start_at == null ? body.start_time : body.start_at, existing && existing.start_time);
  const end = instant(body.end_at == null ? body.end_time : body.end_at, existing && existing.end_time);
  if (!title || title.length > 80 || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) return api.fail(res, 422, 'VALIDATION_FAILED', 'A title no longer than 80 characters and valid start/end times are required.', { title: !title ? 'required' : title.length > 80 ? 'maximum 80 characters' : undefined });
  const priorProblemIds = existing ? (await existing.getProblems()).map(Number) : [];
  const requestedProblemIds = body.problem_ids === undefined ? priorProblemIds : (Array.isArray(body.problem_ids) ? body.problem_ids : []);
  const problemIds = Array.from(new Set(requestedProblemIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0)));
  if (body.problem_ids !== undefined && (!Array.isArray(body.problem_ids) || problemIds.length !== body.problem_ids.length)) return api.fail(res, 422, 'VALIDATION_FAILED', 'Problem IDs must be unique positive integers.', { problem_ids: 'unique positive integers' });
  for (const problemId of problemIds) {
    const problem = await Problem.findById(problemId);
    if (!problem || !await problem.isAllowedUseBy(user)) return api.fail(res, 422, 'CONTEST_PROBLEM_INVALID', `Problem #${problemId} does not exist or is not available to this manager.`, { problem_ids: String(problemId) });
    if (syzoj.utils.contestSubmissionEnabled && !syzoj.utils.contestSubmissionEnabled(problem)) return api.fail(res, 422, 'CONTEST_PROBLEM_UNAVAILABLE', `Problem #${problemId} is not enabled for contest submissions.`, { problem_ids: String(problemId) });
  }
  const type = body.type == null && existing ? existing.type : (['noi', 'ioi', 'acm'].includes(body.type) ? body.type : 'acm');
  const visibility = body.visibility == null && existing ? (existing.is_public ? 'public' : 'private') : (body.visibility === 'private' ? 'private' : 'public');
  const allowLateRegistration = body.allow_late_registration === undefined ? !!(existingConfig && existingConfig.registration.allow_late_registration) : !!body.allow_late_registration;
  const isRated = body.is_rated === undefined ? !!(existingConfig && existingConfig.rated_profile) : !!body.is_rated;
  const priorWeights = existingConfig ? Object.fromEntries((existingConfig.scoring.problems || []).map(item => [item.problem_id, item.score])) : {};
  const rankingParams = body.ranking_params === undefined ? Object.fromEntries(problemIds.map(id => [id, priorWeights[id] == null ? 1 : priorWeights[id]])) : body.ranking_params;
  if (!plainObject(rankingParams)) return api.fail(res, 422, 'VALIDATION_FAILED', 'Ranking parameters must be an object.', { ranking_params: 'object' });
  const normalizedRankingParams = {};
  for (const [problemId, multiplier] of Object.entries(rankingParams)) {
    const numericProblemId = Number(problemId);
    const numericMultiplier = Number(multiplier);
    if (!problemIds.includes(numericProblemId) || !Number.isFinite(numericMultiplier) || numericMultiplier <= 0 || numericMultiplier > 1000) return api.fail(res, 422, 'CONTEST_RANKING_INVALID', 'Ranking parameters may contain only selected problems with weights greater than 0 and at most 1000.', { ranking_params: String(problemId) });
    normalizedRankingParams[problemId] = numericMultiplier;
  }
  if (existing && contestConfigurationLocked(current.status)) {
    const oldWeights = Object.fromEntries(priorProblemIds.map(id => [id, Number(priorWeights[id] == null ? 1 : priorWeights[id])]));
    const newWeights = Object.fromEntries(problemIds.map(id => [id, Number(normalizedRankingParams[id] == null ? 1 : normalizedRankingParams[id])]));
    const criticalChanged = JSON.stringify(priorProblemIds) !== JSON.stringify(problemIds) || Number(existing.start_time) !== Math.floor(start / 1000) || Number(existing.end_time) !== Math.floor(end / 1000) || existing.type !== type || !!existingConfig.rated_profile !== isRated || JSON.stringify(oldWeights) !== JSON.stringify(newWeights);
    if (criticalChanged) return api.fail(res, 409, 'CONTEST_LOCKED', 'Problem set, time, scoring rules, and Rated state are locked after the contest starts.');
  }
  let mutationRevision = 0;
  if (existing) {
    const revisionRows = await TypeORM.getConnection().query('SELECT revision FROM contest_registration_setting WHERE contest_id=? LIMIT 1', [existing.id]);
    mutationRevision = revisionRows.length ? Number(revisionRows[0].revision || 0) : 0;
  }
  const requestedAdmins = body.admins === undefined && existing ? String(existing.admins || '').split('|').filter(Boolean).map(Number) : body.admins;
  const admins = Array.isArray(requestedAdmins) ? Array.from(new Set(requestedAdmins.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))) : [];
  if (body.admins !== undefined && (!Array.isArray(body.admins) || admins.length !== body.admins.length)) return api.fail(res, 422, 'VALIDATION_FAILED', 'Administrator IDs must be unique positive integers.', { admins: 'unique positive integers' });
  for (const adminId of admins) if (!await User.findById(adminId)) return api.fail(res, 422, 'CONTEST_ADMIN_INVALID', `Administrator #${adminId} does not exist.`, { admins: String(adminId) });
  await Promise.all([ensureContestV2Schema(), api.ensureFoundationSchema()]);
  const id = await contestMutation.saveContest({ id: contestId || 0, actorId: user.id, title, subtitle: String(body.subtitle == null && existing ? existing.subtitle || '' : body.subtitle || ''), information: String(body.information == null && existing ? existing.information || '' : body.information || ''), problems: problemIds.join('|'), admins: admins.join('|'), type, rankingParams: normalizedRankingParams, startTime: Math.floor(start / 1000), endTime: Math.floor(end / 1000), hideStatistics: body.hide_statistics === undefined && existing ? !!existing.hide_statistics : !!body.hide_statistics, isPublic: visibility === 'public', allowLateRegistration, isRated, revision: mutationRevision });
  const saved = await Contest.findById(id);
  let state = await stateFor(id);
  return api.send(res, serializeContest(saved, state, true), existing ? 200 : 201);
}
app.post('/api/v2/contests', (req, res) => saveContestV2(req, res, 0));
app.patch('/api/v2/contests/:id', (req, res) => saveContestV2(req, res, Number(req.params.id)));
app.delete('/api/v2/contests/:id', async (req, res) => {
  const api = syzoj.utils.apiV2;
  const contest = await Contest.findById(Number(req.params.id));
  if (!contest) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  if (!await contestDeletion.canDeleteContest(res.locals.user, contest)) return api.fail(res, res.locals.user ? 403 : 401, res.locals.user ? 'CAPABILITY_REQUIRED' : 'AUTHENTICATION_REQUIRED', res.locals.user ? 'Capability required: contest:publish.' : 'Authentication is required.');
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api.fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again before deleting a contest.');
  try {
    const result = await contestDeletion.deleteContest(req, contest, res.locals.user);
    res.set('X-Audit-Event-ID', String(result.audit_event_id));
    return api.send(res, result);
  } catch (error) {
    return api.fail(res, error.statusCode || 409, error.code || 'CONTEST_DELETE_FAILED', error.message);
  }
});

app.post([
  '/api/v2/contests/:id/review', '/api/v2/contests/:id/publish', '/api/v2/contests/:id/start',
  '/api/v2/contests/:id/freeze', '/api/v2/contests/:id/unfreeze', '/api/v2/contests/:id/end',
  '/api/v2/contests/:id/rate', '/api/v2/contests/:id/archive'
], async (req, res) => {
  const api = syzoj.utils.apiV2; const contest = await Contest.findById(Number(req.params.id)); if (!contest) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  if (!(await requireManager(contest, res.locals.user, 'contest:publish', res))) return null;
  const action = req.path.split('/').filter(Boolean).pop();
  const target = { review: 'review', publish: 'scheduled', start: 'running', freeze: 'frozen', unfreeze: 'running', end: 'ended', rate: 'rated', archive: 'archived' }[action];
  try {
    const reason = syzoj.utils.operationReason(req, '更新比赛状态');
    if (['publish', 'start', 'end', 'rate', 'archive'].includes(action) && !syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api.fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again before this contest transition.');
    const problemIds = await contest.getProblems();
    if (['publish', 'start'].includes(action) && !problemIds.length) return api.fail(res, 409, 'CONTEST_PROBLEMS_REQUIRED', 'Add at least one problem before publishing or starting the contest.');
    if (action === 'rate') {
      const legacy = await TypeORM.getConnection().query("SELECT contest_id FROM contest_rating_finalization WHERE contest_id=? AND status='completed' LIMIT 1", [contest.id]);
      const modern = await TypeORM.getConnection().query("SELECT id FROM rating_v2_event WHERE contest_id=? AND kind='contest_published' LIMIT 1", [contest.id]);
      if (!legacy.length && !modern.length) return api.fail(res, 409, 'RATING_NOT_PUBLISHED', 'Publish a Rating preview before marking the contest as rated.');
    }
    if (['publish', 'start', 'freeze', 'end', 'rate'].includes(action)) await snapshotProblems(contest, res.locals.user, req, { refresh: snapshotRefreshAllowed(action) });
    const state = await writeState(contest, target, res.locals.user, reason, req);
    if (action === 'archive') {
      await TypeORM.getConnection().query('UPDATE contest SET is_public=0 WHERE id=?', [contest.id]);
      contest.is_public = false;
      if (syzoj.utils.invalidateContestReadCache) syzoj.utils.invalidateContestReadCache(contest.id);
    }
    const projectionKind = { start: 'realtime', freeze: 'frozen', unfreeze: 'unfrozen', end: 'final' }[action];
    const projection = projectionKind ? await projectStandings(contest.id, { kind: projectionKind, actor: res.locals.user, reason: reason || `Contest ${action}` }) : null;
    const resource = serializeContest(contest, state, true);
    if (projection) resource.standings_version = Number(projection.version.version_number);
    return api.send(res, resource);
  } catch (error) { return api.fail(res, error.statusCode || 409, error.code || 'CONTEST_TRANSITION_INVALID', error.message); }
});

app.post(['/api/v2/contests/:id/registration', '/api/v2/contests/:id/register'], async (req, res) => {
  const api = syzoj.utils.apiV2; const user = res.locals.user; if (!user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  const contest = await Contest.findById(Number(req.params.id)); if (!contest) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  const manager = await canManageContest(contest, user, 'contest:registration.manage');
  if (!contest.is_public && !manager) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  if (!await syzoj.utils.authorizationV2.authorize(user, 'contest:register', { scope: `contest:${contest.id}` }, { scope: `contest:${contest.id}` })) return api.fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: contest:register.');
  try { await contestMutation.registerUser(contest.id, user.id); await syzoj.utils.apiV2.appendEvent({ stream: `contest:${contest.id}`, type: 'contest.registration.created', aggregateId: contest.id, actor: user, payload: { user_id: user.id } }); return api.send(res, { contest_id: Number(contest.id), user_id: Number(user.id), registered: true }, 201); } catch (error) { return api.fail(res, error.statusCode || 409, 'REGISTRATION_FAILED', error.message); }
});
app.delete(['/api/v2/contests/:id/registration', '/api/v2/contests/:id/register'], async (req, res) => {
  const api = syzoj.utils.apiV2; const user = res.locals.user; if (!user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const contest = await Contest.findById(Number(req.params.id)); if (!contest) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  try { await contestMutation.unregisterUser(contest.id, user.id); await syzoj.utils.apiV2.appendEvent({ stream: `contest:${contest.id}`, type: 'contest.registration.removed', aggregateId: contest.id, actor: user, payload: { user_id: user.id } }); return api.send(res, { contest_id: Number(contest.id), user_id: Number(user.id), registered: false }); } catch (error) { return api.fail(res, error.statusCode || 409, 'UNREGISTRATION_FAILED', error.message); }
});

app.get('/api/v2/contests/:id/participants', async (req, res) => {
  const api = syzoj.utils.apiV2;
  const contest = await Contest.findById(Number(req.params.id));
  if (!contest) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  const manager = await canManageContest(contest, res.locals.user, 'contest:registration.manage');
  const participant = await isActiveParticipant(contest.id, res.locals.user);
  if (!contest.is_public && !manager && !participant) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  const limit = api.parseLimit(req, 50, 100);
  const cursor = Number(api.decodeCursor(req.query.cursor) || 0);
  const rows = await TypeORM.getConnection().query(`SELECT cp.id AS participant_id,cp.user_id,u.username,cp.score,cp.time_spent
    FROM contest_player cp INNER JOIN user u ON u.id=cp.user_id
    LEFT JOIN contest_registration_removal removal ON removal.contest_id=cp.contest_id AND removal.user_id=cp.user_id
    WHERE cp.contest_id=? AND cp.id>? AND removal.user_id IS NULL ORDER BY cp.id ASC LIMIT ?`, [contest.id, cursor, limit + 1]);
  const hasMore = rows.length > limit;
  res.locals.apiMeta.next_cursor = hasMore ? api.encodeCursor(rows[limit - 1].participant_id) : null;
  res.locals.apiMeta.limit = limit;
  res.locals.apiMeta.scope = manager ? 'contest_manager' : 'public';
  return api.send(res, rows.slice(0, limit).map(row => Object.assign({ participant_id: Number(row.participant_id), user_id: Number(row.user_id), username: row.username }, manager ? { score: Number(row.score || 0), time_spent: Number(row.time_spent || 0) } : {})));
});
app.post('/api/v2/contests/:id/participants/bulk-action', async (req, res) => {
  const api = syzoj.utils.apiV2;
  const contest = await Contest.findById(Number(req.params.id));
  if (!contest) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  if (!(await requireManager(contest, res.locals.user, 'contest:registration.manage', res))) return null;
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api.fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again before changing contest participants.');
  const action = String(req.body && req.body.action || '');
  const userIds = Array.from(new Set((Array.isArray(req.body && req.body.user_ids) ? req.body.user_ids : []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0)));
  const reason = syzoj.utils.operationReason(req, '批量调整比赛选手');
  if (!['add', 'remove', 'restore'].includes(action) || !userIds.length || userIds.length > 100) {
    return api.fail(res, 422, 'VALIDATION_FAILED', 'An action and 1-100 user IDs are required.', {
      action: 'add, remove, or restore', user_ids: '1-100 unique positive integers'
    });
  }
  const succeeded = [];
  const failed = [];
  for (const userId of userIds) {
    try {
      if (action === 'add') await contestMutation.registerUser(contest.id, userId);
      else if (action === 'remove') await contestMutation.removeUser(contest.id, userId, res.locals.user.id);
      else await contestMutation.restoreUser(contest.id, userId);
      succeeded.push(userId);
    } catch (error) {
      failed.push({ user_id: userId, code: error.code || 'PARTICIPANT_ACTION_FAILED', message: error.message });
    }
  }
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
    action: `contest:participants.${action}`, resourceType: 'contest', resourceId: contest.id, reason,
    details: { requested_user_ids: userIds, succeeded_user_ids: succeeded, failed }
  });
  await api.appendEvent({ stream: `contest:${contest.id}`, type: `contest.participants.${action}`, aggregateId: contest.id, actor: res.locals.user, payload: { succeeded_user_ids: succeeded, failed, audit_event_id: auditEventId } });
  if (syzoj.utils.contestStandingsV2) syzoj.utils.contestStandingsV2.schedule(contest.id, { kind: 'realtime', actor: res.locals.user, reason });
  res.set('X-Audit-Event-ID', String(auditEventId));
  return api.send(res, { contest_id: Number(contest.id), action, succeeded_user_ids: succeeded, failed, audit_event_id: auditEventId });
});
app.get('/api/v2/contests/:id/standings', async (req, res) => {
  const api = syzoj.utils.apiV2;
  const contest = await Contest.findById(Number(req.params.id));
  if (!contest) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  await ensureContestV2Schema();
  const user = res.locals.user;
  const manager = await canManageContest(contest, user, 'contest:standings.rebuild');
  const operator = !!(user && await syzoj.utils.authorizationV2.authorize(user, 'judge:read', null, { scope: 'global' }));
  const fullScope = manager || operator;
  const participants = user ? await TypeORM.getConnection().query('SELECT id FROM contest_player WHERE contest_id=? AND user_id=? LIMIT 1', [contest.id, user.id]) : [];
  const participant = participants.length > 0;
  const state = await stateFor(contest.id);
  const status = lifecycleFor(contest, state);
  const access = standingsVisibility({
    isPublic: !!contest.is_public,
    status,
    participant,
    fullScope,
    canSeeResults: !contest.allowedSeeingResult || !!contest.allowedSeeingResult(),
    canSeeOthers: !contest.allowedSeeingResult || !!contest.allowedSeeingOthers()
  });
  if (access === 'not_found') return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  if (access === 'hidden') return api.fail(res, 403, 'STANDINGS_HIDDEN', 'Standings are not visible in your contest scope.');

  let currents = await TypeORM.getConnection().query('SELECT * FROM contest_v2_standings_current WHERE contest_id=? LIMIT 1', [contest.id]);
  if (!currents.length || (!currents[0].live_version_id && fullScope) || (!currents[0].public_version_id && !fullScope)) {
    await projectStandings(contest.id, { kind: standingsKind(status), reason: 'Initial v2 standings projection' });
    currents = await TypeORM.getConnection().query('SELECT * FROM contest_v2_standings_current WHERE contest_id=? LIMIT 1', [contest.id]);
  }
  const current = currents[0] || {};
  let view = fullScope ? String(req.query.view || 'live') : 'public';
  if (!['live', 'public', 'frozen', 'final'].includes(view)) return api.fail(res, 422, 'VALIDATION_FAILED', 'Unknown standings view.', { view: 'live, public, frozen, or final' });
  const pointer = { live: current.live_version_id, public: current.public_version_id, frozen: current.frozen_version_id, final: current.final_version_id }[view];
  if (!pointer) return api.fail(res, 409, 'STANDINGS_NOT_READY', 'The requested standings projection is not ready.');
  const payload = await loadStandingVersion(pointer, req, fullScope ? 'manager' : 'public', contest.type);
  if (!payload) return api.fail(res, 409, 'STANDINGS_NOT_READY', 'The requested standings projection is not ready.');
  res.locals.apiMeta.limit = api.parseLimit(req, 100, 200);
  res.locals.apiMeta.scope = fullScope ? (manager ? 'contest_manager' : 'judge_operator') : (participant ? 'participant' : 'public');
  return api.send(res, { contest_id: Number(contest.id), view, frozen: status === 'frozen', ...payload });
});

app.get('/api/v2/contests/:id/standings/versions', async (req, res) => {
  const api = syzoj.utils.apiV2;
  const contest = await Contest.findById(Number(req.params.id));
  if (!contest) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  if (!await canManageContest(contest, res.locals.user, 'contest:standings.rebuild')) return api.fail(res, res.locals.user ? 403 : 401, res.locals.user ? 'CAPABILITY_REQUIRED' : 'AUTHENTICATION_REQUIRED', res.locals.user ? 'Capability required: contest:standings.rebuild.' : 'Authentication is required.');
  await ensureContestV2Schema();
  const limit = api.parseLimit(req, 30, 100);
  const cursor = Number(api.decodeCursor(req.query.cursor) || Number.MAX_SAFE_INTEGER);
  const rows = await TypeORM.getConnection().query('SELECT * FROM contest_v2_standings_version WHERE contest_id=? AND version_number<? ORDER BY version_number DESC LIMIT ?', [contest.id, cursor, limit + 1]);
  res.locals.apiMeta.next_cursor = rows.length > limit ? api.encodeCursor(Number(rows[limit - 1].version_number)) : null;
  res.locals.apiMeta.limit = limit;
  return api.send(res, rows.slice(0, limit).map(serializeVersion));
});

app.get('/api/v2/contests/:id/standings/versions/:version', async (req, res) => {
  const api = syzoj.utils.apiV2;
  const contest = await Contest.findById(Number(req.params.id));
  if (!contest) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  if (!await canManageContest(contest, res.locals.user, 'contest:standings.rebuild')) return api.fail(res, res.locals.user ? 403 : 401, res.locals.user ? 'CAPABILITY_REQUIRED' : 'AUTHENTICATION_REQUIRED', res.locals.user ? 'Capability required: contest:standings.rebuild.' : 'Authentication is required.');
  await ensureContestV2Schema();
  const versions = await TypeORM.getConnection().query('SELECT id FROM contest_v2_standings_version WHERE contest_id=? AND version_number=? LIMIT 1', [contest.id, Number(req.params.version)]);
  if (!versions.length) return api.fail(res, 404, 'STANDINGS_VERSION_NOT_FOUND', 'Standings version was not found.');
  const payload = await loadStandingVersion(versions[0].id, req, 'manager', contest.type);
  res.locals.apiMeta.limit = api.parseLimit(req, 100, 200);
  return api.send(res, { contest_id: Number(contest.id), ...payload });
});

app.post('/api/v2/contests/:id/standings/rebuild', async (req, res) => {
  const api = syzoj.utils.apiV2;
  const contest = await Contest.findById(Number(req.params.id));
  if (!contest) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  if (!(await requireManager(contest, res.locals.user, 'contest:standings.rebuild', res))) return null;
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api.fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again before rebuilding contest standings.');
  const reason = syzoj.utils.operationReason(req, '重建比赛排行榜');
  try {
    const jobId = crypto.randomUUID();
    await contestMutation.withContestLock(contest.id, async () => {
      const active = await TypeORM.getConnection().query("SELECT id FROM contest_v2_standings_job WHERE contest_id=? AND state IN ('queued','running','cancelling') LIMIT 1", [contest.id]);
      if (active.length) throw Object.assign(new Error('A standings rebuild is already active for this contest.'), { code: 'STANDINGS_REBUILD_ACTIVE', statusCode: 409 });
      await TypeORM.getConnection().query("INSERT INTO contest_v2_standings_job (id,contest_id,state,stage,actor_id,reason,created_at,updated_at) VALUES (?,?,'queued','queued',?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [jobId, contest.id, res.locals.user.id, reason]);
    });
    const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'contest:standings.rebuild', resourceType: 'contest', resourceId: contest.id, reason, details: { job_id: jobId } });
    await api.appendEvent({ stream: `contest:${contest.id}`, type: 'contest.standings.rebuild.queued', aggregateId: contest.id, actor: res.locals.user, payload: { job_id: jobId, audit_event_id: auditEventId } });
    await api.appendEvent({ stream: `standings-job:${jobId}`, type: 'standings.rebuild.queued', aggregateId: jobId, actor: res.locals.user, payload: { contest_id: Number(contest.id), audit_event_id: auditEventId } });
    setImmediate(() => runStandingsRebuildJob(jobId));
    res.set('X-Audit-Event-ID', String(auditEventId));
    return api.send(res, { id: jobId, kind: 'standings_rebuild', contest_id: Number(contest.id), state: 'queued', stage: 'queued', audit_event_id: auditEventId }, 202);
  } catch (error) {
    return api.fail(res, error.statusCode || 409, error.code || 'STANDINGS_REBUILD_FAILED', error.message);
  }
});
app.get('/api/v2/contests/:id/standings/rebuilds/:jobId', async (req, res) => {
  const api = syzoj.utils.apiV2;
  const contest = await Contest.findById(Number(req.params.id));
  if (!contest) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  if (!(await requireManager(contest, res.locals.user, 'contest:standings.rebuild', res))) return null;
  await ensureContestV2Schema();
  const rows = await TypeORM.getConnection().query('SELECT * FROM contest_v2_standings_job WHERE id=? AND contest_id=? LIMIT 1', [req.params.jobId, contest.id]);
  if (!rows.length) return api.fail(res, 404, 'STANDINGS_REBUILD_NOT_FOUND', 'Standings rebuild job was not found.');
  return api.send(res, serializeStandingsJob(rows[0]));
});
app.get('/api/v2/contests/:id/events', async (req, res) => {
  const api = syzoj.utils.apiV2; const contest = await Contest.findById(Number(req.params.id)); if (!contest) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  const manager = await canManageContest(contest, res.locals.user, 'contest:standings.rebuild');
  const operator = !!(res.locals.user && await syzoj.utils.authorizationV2.authorize(res.locals.user, 'judge:read', null, { scope: 'global' }));
  if (!res.locals.user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!manager && !operator) return api.fail(res, 403, 'CONTEST_FORBIDDEN', 'You cannot view contest events.');
  return api.sse(req, res, `contest:${contest.id}`);
});

ensureContestV2Schema().then(() => setImmediate(() => recoverStandingsJobs().catch(error => syzoj.log(`[contest-standings-v2] recovery failed: ${error.stack || error.message}`)))).catch(error => syzoj.log(`[contest-v2] schema initialization failed: ${error.stack || error.message}`));
