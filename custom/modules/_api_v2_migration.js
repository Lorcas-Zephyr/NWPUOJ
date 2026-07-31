const crypto = require('crypto');
const TypeORM = require('typeorm');
const Problem = syzoj.model('problem');
const Contest = syzoj.model('contest');
const problemDomain = require('../libs/problem-domain');
const submissionDomain = require('../libs/submission-domain');
const judgeStatus = require('../libs/judge-status');
const migrationConsistency = require('../libs/migration-consistency');
const migrationReleaseGate = require('../libs/migration-release-gate');
const migrationCycleEvidence = require('../libs/migration-cycle-evidence');
const RETRYABLE_MIGRATION_ERRORS = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', '1213', '1205']);
let schemaPromise = null;
async function ensureMigrationSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const connection = TypeORM.getConnection();
    await connection.query(`CREATE TABLE IF NOT EXISTS api_v2_migration_run (
      id CHAR(36) NOT NULL PRIMARY KEY, domain VARCHAR(32) NOT NULL, state VARCHAR(24) NOT NULL,
      processed INT NOT NULL DEFAULT 0, total INT NOT NULL DEFAULT 0, failure_count INT NOT NULL DEFAULT 0,
      failures_json LONGTEXT NULL, actor_id INT NOT NULL, reason VARCHAR(1000) NOT NULL,
      cancel_requested TINYINT(1) NOT NULL DEFAULT 0, current_object VARCHAR(160) NULL,
      created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
      KEY idx_api_v2_migration_domain(domain,created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const columns = await connection.query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='api_v2_migration_run'`);
    const names = new Set(columns.map(row => row.COLUMN_NAME));
    if (!names.has('cancel_requested')) await connection.query('ALTER TABLE api_v2_migration_run ADD COLUMN cancel_requested TINYINT(1) NOT NULL DEFAULT 0 AFTER reason');
    if (!names.has('current_object')) await connection.query('ALTER TABLE api_v2_migration_run ADD COLUMN current_object VARCHAR(160) NULL AFTER cancel_requested');
    const indexes = await connection.query(`SELECT DISTINCT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='api_v2_migration_run'`);
    const indexNames = new Set(indexes.map(row => row.INDEX_NAME));
    if (!indexNames.has('idx_api_v2_migration_active')) await connection.query('ALTER TABLE api_v2_migration_run ADD KEY idx_api_v2_migration_active(domain,state,created_at)');
    await connection.query(`CREATE TABLE IF NOT EXISTS api_v2_migration_lock (
      domain VARCHAR(32) NOT NULL PRIMARY KEY, updated_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query("INSERT IGNORE INTO api_v2_migration_lock (domain,updated_at) VALUES ('identity',UTC_TIMESTAMP(3)),('problem',UTC_TIMESTAMP(3)),('submission',UTC_TIMESTAMP(3)),('contest',UTC_TIMESTAMP(3)),('rating',UTC_TIMESTAMP(3))");
    await connection.query(`CREATE TABLE IF NOT EXISTS api_v2_migration_compatibility (
      scope VARCHAR(32) NOT NULL PRIMARY KEY, compatibility_started_at DATETIME(3) NULL,
      compatibility_started_by INT NULL, last_consistency_at DATETIME(3) NULL,
      last_consistency_json LONGTEXT NULL, rollback_rehearsed_at DATETIME(3) NULL,
      rollback_rehearsed_by INT NULL, updated_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const compatibilityColumns = await connection.query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='api_v2_migration_compatibility'`);
    const compatibilityNames = new Set(compatibilityColumns.map(row => row.COLUMN_NAME));
    if (!compatibilityNames.has('rollback_rehearsal_json')) await connection.query('ALTER TABLE api_v2_migration_compatibility ADD COLUMN rollback_rehearsal_json LONGTEXT NULL AFTER rollback_rehearsed_by');
    await migrationCycleEvidence.ensureSchema(connection);
  })().catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}
function api() { return syzoj.utils.apiV2; }
async function can(user) { return !!(user && await syzoj.utils.authorizationV2.authorize(user, 'admin:job.manage', null, {})); }
function serialize(row) { return { id: row.id, domain: row.domain, state: row.state, current_object: row.current_object || null, progress: { processed: Number(row.processed), total: Number(row.total), failed: Number(row.failure_count) }, failures: row.failures_json ? JSON.parse(row.failures_json) : [], created_at: api().databaseIso(row.created_at), updated_at: api().databaseIso(row.updated_at) }; }
function parseJson(value, fallback) { try { return value && typeof value === 'object' ? value : JSON.parse(value || ''); } catch (error) { return fallback; } }

async function assertMigrationActive(runId, currentObject) {
  if (currentObject != null) await TypeORM.getConnection().query('UPDATE api_v2_migration_run SET current_object=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [String(currentObject).slice(0, 160), runId]);
  const rows = await TypeORM.getConnection().query('SELECT cancel_requested FROM api_v2_migration_run WHERE id=? LIMIT 1', [runId]);
  if (!rows.length || rows[0].cancel_requested) throw Object.assign(new Error('Migration was cancelled.'), { code: 'JOB_CANCELLED' });
}

async function migrateProblemSource(connection, problem) {
  await connection.transaction(manager => problemDomain.syncSourceProjection(manager, problem));
}

async function retryMigrationStep(work) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await work();
    } catch (error) {
      const code = String(error && (error.code || error.errno) || '');
      if (!RETRYABLE_MIGRATION_ERRORS.has(code) || attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
}

async function ensureIdentityMigrationEvent(manager, row) {
  await manager.query(`
    INSERT INTO api_v2_event (stream,type,aggregate_id,actor_id,payload_json,created_at)
    SELECT CONCAT('identity:user:',legacy.id),'identity.projection.seeded',CAST(legacy.id AS CHAR),NULL,
           JSON_OBJECT('user_id',legacy.id,'account_status',state.status),
           FROM_UNIXTIME(COALESCE(NULLIF(legacy.register_time,0),UNIX_TIMESTAMP()))
      FROM user legacy
      INNER JOIN auth_user_state state ON state.user_id=legacy.id
     WHERE legacy.id=?
       AND NOT EXISTS (
         SELECT 1 FROM api_v2_event event
          WHERE event.stream=CONCAT('identity:user:',legacy.id)
            AND event.type IN ('user.registered','identity.projection.seeded')
       )`, [row.id]);
}

async function migrateIdentities(runId) {
  await Promise.all([
    syzoj.utils.ensureAccountStateSchema(),
    api().ensureFoundationSchema()
  ]);
  const connection = TypeORM.getConnection();
  const rows = await connection.query('SELECT id,register_time FROM user ORDER BY id ASC');
  let processed = 0;
  const failures = [];
  for (const row of rows) {
    await assertMigrationActive(runId, `identity:${row.id}`);
    try {
      await connection.transaction(async manager => {
        await manager.query(`INSERT IGNORE INTO auth_user_state (user_id,status,reason,changed_by,changed_at)
          VALUES (?,'active',NULL,NULL,FROM_UNIXTIME(COALESCE(NULLIF(?,0),UNIX_TIMESTAMP())))`, [row.id, row.register_time]);
        await ensureIdentityMigrationEvent(manager, row);
      });
    } catch (error) {
      if (failures.length < 100) failures.push({ id: row.id, code: error.code || 'MIGRATION_FAILED', message: error.message });
    }
    processed++;
    if (processed % 100 === 0) {
      await connection.query('UPDATE api_v2_migration_run SET processed=?,failure_count=?,failures_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [processed, failures.length, JSON.stringify(failures), runId]);
    }
  }
  return { processed, failures };
}

async function migrateProblems(runId) {
  await syzoj.utils.vjudgeV2.ensureSchema();
  const connection = TypeORM.getConnection();
  const problems = await Problem.find(); let processed = 0; const failures = [];
  for (const problem of problems) { await assertMigrationActive(runId, `problem:${problem.id}`); try { await retryMigrationStep(() => syzoj.utils.problemV2.ensureCurrentSnapshot(problem, null)); await retryMigrationStep(() => migrateProblemSource(connection, problem)); } catch (error) { if (failures.length < 100) failures.push({ id: problem.id, code: error.code || 'MIGRATION_FAILED', message: error.message }); } processed++; if (processed % 25 === 0) await connection.query('UPDATE api_v2_migration_run SET processed=?,failure_count=?,failures_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [processed, failures.length, JSON.stringify(failures), runId]); }
  return { processed, failures };
}

function migrationSubmissionStatus(row) {
  return judgeStatus.statusForJudge(row);
}

async function migrationSnapshotForSubmission(row) {
  if (row.current_snapshot_id) return String(row.current_snapshot_id);
  const problem = await Problem.findById(Number(row.problem_id));
  if (!problem) throw new Error(`Problem #${row.problem_id} was not found while migrating submission #${row.id}.`);
  return syzoj.utils.problemV2.ensureCurrentSnapshot(problem, null);
}

async function ensureSubmissionMigrationEvent(manager, submissionId) {
  await manager.query(`
    INSERT INTO api_v2_event (stream,type,aggregate_id,actor_id,payload_json,created_at)
    SELECT CONCAT('submission:',projection.submission_id),'submission.projection.seeded',
           CAST(projection.submission_id AS CHAR),projection.user_id,
           JSON_OBJECT(
             'submission_id',projection.submission_id,'problem_id',projection.problem_id,
             'snapshot_id',projection.snapshot_id,'code_version_id',projection.code_version_id,'user_id',projection.user_id,
             'contest_id',projection.contest_id,'language',projection.language,
             'source_visibility',projection.source_visibility,'status',projection.status,
             'attempts',projection.attempts,'last_error',projection.last_error,
             'next_retry_at',projection.next_retry_at,'dispatch_attempts',projection.dispatch_attempts,
             'dispatch_lease_until',projection.dispatch_lease_until,
             'dispatch_enabled',IF(projection.dispatch_enabled=1,TRUE,FALSE),
             'created_at',projection.created_at,'updated_at',projection.updated_at
           ),UTC_TIMESTAMP(3)
      FROM submission_v2_projection projection
     WHERE projection.submission_id=?
       AND NOT EXISTS (
         SELECT 1 FROM api_v2_event event
          WHERE event.stream=CONCAT('submission:',projection.submission_id)
            AND event.type IN ('submission.created','submission.projection.seeded')
       )`, [submissionId]);
}

async function ensureSubmissionCodeVersion(manager, row) {
  const existing = await manager.query('SELECT * FROM submission_v2_code_version WHERE submission_id=? LIMIT 1 FOR UPDATE', [row.id]);
  if (existing.length) return existing[0];
  const projections = await manager.query('SELECT source_visibility FROM submission_v2_projection WHERE submission_id=? LIMIT 1 FOR UPDATE', [row.id]);
  return submissionDomain.createCodeVersion(manager, {
    submissionId: row.id,
    userId: row.user_id,
    language: row.language,
    source: String(row.code == null ? '' : row.code),
    sourceVisibility: projections.length ? projections[0].source_visibility : 'private'
  });
}

async function ensureSubmissionCodeVersionEvent(manager, submissionId) {
  await manager.query(`
    INSERT INTO api_v2_event (stream,type,aggregate_id,actor_id,payload_json,created_at)
    SELECT CONCAT('submission:',projection.submission_id),'submission.code_version.backfilled',
           CAST(projection.submission_id AS CHAR),projection.user_id,
           JSON_OBJECT('submission_id',projection.submission_id,'code_version_id',projection.code_version_id,
             'source_visibility',projection.source_visibility),UTC_TIMESTAMP(3)
      FROM submission_v2_projection projection
     WHERE projection.submission_id=? AND projection.code_version_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM api_v2_event event
          WHERE event.stream=CONCAT('submission:',projection.submission_id)
            AND event.type='submission.code_version.backfilled'
       )`, [submissionId]);
}

async function migrateSubmissions(runId) {
  await syzoj.utils.submissionV2.ensureSchema();
  await syzoj.utils.problemV2.ensureSchema();
  const connection = TypeORM.getConnection();
  const rows = await connection.query(`SELECT judge.id,judge.problem_id,judge.user_id,judge.type,judge.type_info,judge.language,judge.code,judge.status,judge.pending,judge.submit_time,state.current_snapshot_id FROM judge_state judge LEFT JOIN problem_v2_state state ON state.problem_id=judge.problem_id ORDER BY judge.id`);
  let processed = 0;
  const failures = [];
  for (const row of rows) {
    await assertMigrationActive(runId, `submission:${row.id}`);
    try {
      const snapshotId = await migrationSnapshotForSubmission(row);
      const status = migrationSubmissionStatus(row);
      await connection.transaction(async manager => {
        const codeVersion = await ensureSubmissionCodeVersion(manager, row);
        await manager.query(`INSERT IGNORE INTO submission_v2_projection (submission_id,problem_id,snapshot_id,code_version_id,user_id,contest_id,language,source_visibility,status,attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?, 'private',?,0,FROM_UNIXTIME(?),UTC_TIMESTAMP(3))`, [row.id, row.problem_id, snapshotId, codeVersion.id, row.user_id, Number(row.type) === 1 ? row.type_info : null, row.language, status, row.submit_time]);
        await manager.query('UPDATE submission_v2_projection SET code_version_id=? WHERE submission_id=?', [codeVersion.id, row.id]);
        await ensureSubmissionMigrationEvent(manager, row.id);
        await ensureSubmissionCodeVersionEvent(manager, row.id);
      });
    } catch (error) {
      if (failures.length < 100) failures.push({ id: row.id, message: error.message });
    }
    processed++;
    if (processed % 100 === 0) await connection.query('UPDATE api_v2_migration_run SET processed=?,failure_count=?,failures_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [processed, failures.length, JSON.stringify(failures), runId]);
  }
  return { processed, failures };
}

async function removeOrphanContestProjections(connection) {
  return connection.transaction(async manager => {
    const rows = await manager.query(`
      SELECT contest_id FROM contest_v2_state WHERE NOT EXISTS (SELECT 1 FROM contest WHERE contest.id=contest_v2_state.contest_id)
      UNION SELECT contest_id FROM contest_v2_config WHERE NOT EXISTS (SELECT 1 FROM contest WHERE contest.id=contest_v2_config.contest_id)
      UNION SELECT contest_id FROM contest_v2_standings_current WHERE NOT EXISTS (SELECT 1 FROM contest WHERE contest.id=contest_v2_standings_current.contest_id)
      UNION SELECT contest_id FROM contest_v2_problem_snapshot WHERE NOT EXISTS (SELECT 1 FROM contest WHERE contest.id=contest_v2_problem_snapshot.contest_id)
      UNION SELECT contest_id FROM contest_v2_standings_version WHERE NOT EXISTS (SELECT 1 FROM contest WHERE contest.id=contest_v2_standings_version.contest_id)
      ORDER BY contest_id ASC`);
    const contestIds = rows.map(row => Number(row.contest_id)).filter(Number.isSafeInteger);
    if (!contestIds.length) return [];
    await manager.query('DELETE row FROM contest_v2_standing_row row INNER JOIN contest_v2_standings_version version ON version.id=row.version_id WHERE version.contest_id IN (?)', [contestIds]);
    await manager.query('DELETE FROM contest_v2_standings_current WHERE contest_id IN (?)', [contestIds]);
    await manager.query('DELETE FROM contest_v2_standings_version WHERE contest_id IN (?)', [contestIds]);
    await manager.query('DELETE FROM contest_v2_problem_snapshot WHERE contest_id IN (?)', [contestIds]);
    await manager.query('DELETE FROM contest_v2_config WHERE contest_id IN (?)', [contestIds]);
    await manager.query('DELETE FROM contest_v2_state WHERE contest_id IN (?)', [contestIds]);
    return contestIds;
  });
}
async function migrateContests(runId) {
  const connection = TypeORM.getConnection();
  await syzoj.utils.contestV2.ensureSchema();
  const removedOrphans = await removeOrphanContestProjections(connection);
  const contestIds = await connection.query('SELECT id FROM contest ORDER BY id ASC');
  let processed = 0;
  const failures = [];
  for (const item of contestIds) {
    const contestId = Number(item.id);
    await assertMigrationActive(runId, `contest:${contestId}`);
    try {
      await connection.query(`INSERT IGNORE INTO contest_v2_state (contest_id,status,revision,updated_at,updated_by)
        SELECT id,CASE WHEN end_time<=UNIX_TIMESTAMP() THEN 'ended' WHEN start_time<=UNIX_TIMESTAMP() THEN 'running' ELSE 'scheduled' END,0,UTC_TIMESTAMP(3),holder_id FROM contest WHERE id=?`, [contestId]);
      const contest = await Contest.findById(contestId);
      if (!contest) throw new Error('Contest disappeared during migration.');
      await syzoj.utils.contestV2.ensureConfig(contest);
      await syzoj.utils.contestStandingsV2.project(contestId, { reason: 'Legacy contest migration', deduplicate: true });
    } catch (error) {
      if (failures.length < 100) failures.push({ id: contestId, message: error.message });
    }
    processed++;
    if (processed % 10 === 0) await connection.query('UPDATE api_v2_migration_run SET processed=?,failure_count=?,failures_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [processed, failures.length, JSON.stringify(failures), runId]);
  }
  return { processed, failures, removed_orphans: removedOrphans };
}
async function migrateRatings() {
  await syzoj.utils.ratingV2.ensureSchema();
  const connection = TypeORM.getConnection();
  const result = await connection.query(`INSERT INTO rating_v2_event (profile_id,user_id,contest_id,kind,delta,rating_before,rating_after,reason,source_event_id,created_by,created_at)
    SELECT 'icpc',history.user_id,calc.contest_id,'legacy_import',0,NULL,history.rating_after,'Imported from legacy rating history',CONCAT('rating_history:',history.rating_calculation_id,':',history.user_id),NULL,FROM_UNIXTIME(COALESCE(contest.end_time,UNIX_TIMESTAMP()))
    FROM rating_history history
    INNER JOIN rating_calculation calc ON calc.id=history.rating_calculation_id
    LEFT JOIN contest ON contest.id=calc.contest_id
    LEFT JOIN rating_v2_event event ON event.source_event_id=CONCAT('rating_history:',history.rating_calculation_id,':',history.user_id)
    WHERE event.id IS NULL`);
  const projection = await connection.query(`INSERT INTO rating_v2_current (profile_id,user_id,rating,deviation,volatility,last_event_id,updated_at)
    SELECT event.profile_id,event.user_id,event.rating_after,COALESCE(event.deviation_after,350),COALESCE(event.volatility_after,0.06),event.id,UTC_TIMESTAMP(3)
    FROM rating_v2_event event
    INNER JOIN (
      SELECT user_id,MAX(id) AS event_id FROM rating_v2_event
      WHERE profile_id='icpc' GROUP BY user_id
    ) latest ON latest.event_id=event.id
    LEFT JOIN rating_v2_current current ON current.profile_id=event.profile_id AND current.user_id=event.user_id
    WHERE event.profile_id='icpc' AND current.user_id IS NULL`);
  const totals = await connection.query('SELECT COUNT(*) AS count FROM rating_history');
  return { processed: Number(totals[0].count), failures: [], inserted: Number(result.affectedRows || 0), projected: Number(projection.affectedRows || 0) };
}
async function runMigration(id, domain) {
  try {
    const claimed = await TypeORM.getConnection().query("UPDATE api_v2_migration_run SET state='running',updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state='queued'", [id]);
    if (!claimed.affectedRows) return;
    await api().appendEvent({ stream: `migration:${id}`, type: 'migration.running', aggregateId: id, payload: { domain } });
    await assertMigrationActive(id);
    const totals = await TypeORM.getConnection().query(`SELECT CASE ? WHEN 'identity' THEN (SELECT COUNT(*) FROM user) WHEN 'problem' THEN (SELECT COUNT(*) FROM problem) WHEN 'submission' THEN (SELECT COUNT(*) FROM judge_state) WHEN 'contest' THEN (SELECT COUNT(*) FROM contest) WHEN 'rating' THEN (SELECT COUNT(*) FROM rating_history) ELSE 0 END AS count`, [domain]);
    await TypeORM.getConnection().query('UPDATE api_v2_migration_run SET total=? WHERE id=?', [Number(totals[0].count), id]);
    const result = domain === 'identity' ? await migrateIdentities(id) : domain === 'problem' ? await migrateProblems(id) : domain === 'submission' ? await migrateSubmissions(id) : domain === 'contest' ? await migrateContests(id) : await migrateRatings(id);
    await assertMigrationActive(id);
    const terminalState = result.failures.length ? 'failed' : 'completed';
    await TypeORM.getConnection().query('UPDATE api_v2_migration_run SET state=?,processed=?,failure_count=?,failures_json=?,current_object=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [terminalState, result.processed, result.failures.length, JSON.stringify(result.failures), id]);
    await api().appendEvent({ stream: `migration:${id}`, type: terminalState === 'completed' ? 'migration.completed' : 'migration.failed', aggregateId: id, payload: { domain, processed: result.processed, failures: result.failures.length, removed_orphans: result.removed_orphans || [] } });
  } catch (error) {
    if (error.code === 'JOB_CANCELLED') {
      await TypeORM.getConnection().query("UPDATE api_v2_migration_run SET state='cancelled',current_object=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [id]);
      await api().appendEvent({ stream: `migration:${id}`, type: 'migration.cancelled', aggregateId: id, payload: { domain } });
    } else {
      await TypeORM.getConnection().query("UPDATE api_v2_migration_run SET state='failed',failure_count=failure_count+1,failures_json=?,current_object=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [JSON.stringify([{ message: error.message }]), id]);
      await api().appendEvent({ stream: `migration:${id}`, type: 'migration.failed', aggregateId: id, payload: { domain, code: error.code || 'MIGRATION_FAILED' } });
    }
  }
}

syzoj.utils.migrationV2 = { ensureSchema: ensureMigrationSchema, run: runMigration };

async function recoverMigrations() {
  await ensureMigrationSchema();
  const connection = TypeORM.getConnection();
  await connection.query("UPDATE api_v2_migration_run SET state='cancelled',current_object=NULL,updated_at=UTC_TIMESTAMP(3) WHERE state IN ('queued','running','cancelling') AND cancel_requested=1");
  await connection.query("UPDATE api_v2_migration_run SET state='queued',current_object=NULL,updated_at=UTC_TIMESTAMP(3) WHERE state IN ('running','cancelling') AND cancel_requested=0");
  const rows = await connection.query("SELECT id,domain FROM api_v2_migration_run WHERE state='queued' AND cancel_requested=0 ORDER BY created_at ASC");
  for (const row of rows) await runMigration(row.id, row.domain);
}

app.post('/api/v2/admin/migrations/:domain', async (req, res) => {
  const user = res.locals.user;
  const domain = req.params.domain;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!await can(user)) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: admin:job.manage.');
  if (!['identity', 'problem', 'submission', 'contest', 'rating'].includes(domain)) return api().fail(res, 404, 'MIGRATION_DOMAIN_NOT_FOUND', 'Migration domain was not found.');
  const reason = syzoj.utils.operationReason(req, '启动数据迁移');
  await ensureMigrationSchema();
  const result = await TypeORM.getConnection().transaction(async manager => {
    await manager.query('SELECT domain FROM api_v2_migration_lock WHERE domain=? FOR UPDATE', [domain]);
    const active = await manager.query("SELECT * FROM api_v2_migration_run WHERE domain=? AND state IN ('queued','running','cancelling') ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE", [domain]);
    if (active.length) return { created: false, run: serialize(active[0]), auditEventId: null };
    const id = crypto.randomUUID();
    await manager.query("INSERT INTO api_v2_migration_run (id,domain,state,actor_id,reason,created_at,updated_at) VALUES (?,?,'queued',?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [id, domain, user.id, reason]);
    const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
      action: 'admin:migration.start', resourceType: 'migration', resourceId: id, reason, details: { domain }
    }, manager);
    const timestamp = new Date().toISOString();
    return {
      created: true,
      run: { id, domain, state: 'queued', current_object: null, progress: { processed: 0, total: 0, failed: 0 }, failures: [], created_at: timestamp, updated_at: timestamp },
      auditEventId
    };
  });
  if (result.created) {
    await api().appendEvent({ stream: `migration:${result.run.id}`, type: 'migration.queued', aggregateId: result.run.id, actor: user, payload: { domain, audit_event_id: result.auditEventId } });
    setImmediate(() => runMigration(result.run.id, domain));
  }
  return api().send(res, { ...result.run, reused_existing_run: !result.created, audit_event_id: result.auditEventId }, result.created ? 202 : 200);
});
app.get('/api/v2/admin/migrations/:id([0-9a-fA-F-]{36})', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user)) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: admin:job.manage.'); await ensureMigrationSchema(); const rows = await TypeORM.getConnection().query('SELECT * FROM api_v2_migration_run WHERE id=? LIMIT 1', [req.params.id]); if (!rows.length) return api().fail(res, 404, 'MIGRATION_NOT_FOUND', 'Migration run was not found.'); return api().send(res, serialize(rows[0])); });
async function migrationConsistencyReport() {
  await Promise.all([
    syzoj.utils.ensureAccountStateSchema(),
    syzoj.utils.problemV2.ensureSchema(),
    syzoj.utils.vjudgeV2.ensureSchema(),
    syzoj.utils.submissionV2.ensureSchema(),
    syzoj.utils.contestV2.ensureSchema(),
    syzoj.utils.ratingV2.ensureSchema()
  ]);
  const expectedSubmissionStatusSql = judgeStatus.sqlStatusCase('legacy.status', 'legacy.pending');
  const rows = await TypeORM.getConnection().query(`SELECT
    (SELECT COUNT(*) FROM user) AS identities_legacy,
    (SELECT COUNT(*) FROM auth_user_state) AS identities_v2,
    (SELECT COUNT(*) FROM user legacy LEFT JOIN auth_user_state projection ON projection.user_id=legacy.id WHERE projection.user_id IS NULL) AS identities_legacy_missing_v2,
    (SELECT COUNT(*) FROM auth_user_state projection LEFT JOIN user legacy ON legacy.id=projection.user_id WHERE legacy.id IS NULL) AS identities_v2_orphaned,
    (SELECT COUNT(*) FROM auth_user_state projection WHERE projection.status NOT IN ('active','disabled')) AS identities_invalid_status,
    (SELECT COUNT(*) FROM user legacy INNER JOIN auth_user_state projection ON projection.user_id=legacy.id WHERE NOT EXISTS (SELECT 1 FROM api_v2_event event WHERE event.stream=CONCAT('identity:user:',legacy.id) AND event.type IN ('user.registered','identity.projection.seeded'))) AS identities_missing_event_baseline,
    (SELECT COUNT(*) FROM problem) AS problems_legacy,
    (SELECT COUNT(*) FROM problem_v2_state) AS problems_v2,
    (SELECT COUNT(*) FROM problem legacy LEFT JOIN problem_v2_state projection ON projection.problem_id=legacy.id WHERE projection.problem_id IS NULL) AS problems_legacy_missing_v2,
    (SELECT COUNT(*) FROM problem_v2_state projection LEFT JOIN problem legacy ON legacy.id=projection.problem_id WHERE legacy.id IS NULL) AS problems_v2_orphaned,
    (SELECT COUNT(*) FROM problem legacy INNER JOIN problem_v2_state projection ON projection.problem_id=legacy.id LEFT JOIN problem_v2_snapshot snapshot ON snapshot.id=projection.current_snapshot_id WHERE projection.current_snapshot_id IS NULL OR snapshot.id IS NULL) AS problems_missing_snapshot,
    (SELECT COUNT(*) FROM problem legacy LEFT JOIN vjudge_v2_remote_problem source ON source.provider=SUBSTRING(legacy.type,8) AND source.remote_id=legacy.vjudge_config AND source.local_problem_id=legacy.id WHERE legacy.type LIKE 'vjudge:%' AND legacy.vjudge_config IS NOT NULL AND legacy.vjudge_config<>'' AND source.local_problem_id IS NULL) AS problems_remote_source_missing,
    (SELECT COUNT(*) FROM vjudge_v2_remote_problem source LEFT JOIN problem legacy ON legacy.id=source.local_problem_id WHERE legacy.id IS NULL) AS problems_remote_source_orphaned,
    (SELECT COUNT(*) FROM vjudge_v2_remote_problem source INNER JOIN problem legacy ON legacy.id=source.local_problem_id WHERE legacy.type<>CONCAT('vjudge:',source.provider) OR NOT (legacy.vjudge_config <=> source.remote_id)) AS problems_remote_source_mismatch,
    (SELECT COUNT(*) FROM problem legacy WHERE legacy.type LIKE 'vjudge:%' AND (legacy.vjudge_config IS NULL OR legacy.vjudge_config='' OR CHAR_LENGTH(legacy.vjudge_config)>80)) AS problems_remote_source_invalid,
    (SELECT COALESCE(SUM(duplicates.duplicate_count-1),0) FROM (SELECT COUNT(*) AS duplicate_count FROM problem WHERE type LIKE 'vjudge:%' AND vjudge_config IS NOT NULL AND vjudge_config<>'' GROUP BY type,vjudge_config HAVING COUNT(*)>1) duplicates) AS problems_remote_source_duplicates,
    (SELECT COUNT(*) FROM judge_state) AS submissions_legacy,
    (SELECT COUNT(*) FROM submission_v2_projection) AS submissions_v2,
    (SELECT COUNT(*) FROM judge_state legacy LEFT JOIN submission_v2_projection projection ON projection.submission_id=legacy.id WHERE projection.submission_id IS NULL) AS submissions_legacy_missing_v2,
    (SELECT COUNT(*) FROM submission_v2_projection projection LEFT JOIN judge_state legacy ON legacy.id=projection.submission_id WHERE legacy.id IS NULL) AS submissions_v2_orphaned,
    (SELECT COUNT(*) FROM submission_v2_projection projection WHERE NOT EXISTS (SELECT 1 FROM api_v2_event event WHERE event.stream=CONCAT('submission:',projection.submission_id) AND event.type IN ('submission.created','submission.projection.seeded'))) AS submissions_missing_event_baseline,
    (SELECT COUNT(*) FROM submission_v2_projection projection LEFT JOIN problem_v2_snapshot snapshot ON snapshot.id=projection.snapshot_id WHERE projection.snapshot_id IS NULL OR snapshot.id IS NULL) AS submissions_missing_snapshot,
    (SELECT COUNT(*) FROM submission_v2_projection projection LEFT JOIN submission_v2_code_version code_version ON code_version.id=projection.code_version_id AND code_version.submission_id=projection.submission_id WHERE projection.code_version_id IS NULL OR code_version.id IS NULL) AS submissions_missing_code_version,
    (SELECT COUNT(*) FROM submission_v2_code_version code_version LEFT JOIN submission_v2_projection projection ON projection.code_version_id=code_version.id AND projection.submission_id=code_version.submission_id WHERE projection.submission_id IS NULL) AS submissions_code_version_orphaned,
    (SELECT COUNT(*) FROM submission_v2_projection projection INNER JOIN submission_v2_code_version code_version ON code_version.id=projection.code_version_id INNER JOIN judge_state legacy ON legacy.id=projection.submission_id WHERE code_version.submission_id<>projection.submission_id OR code_version.user_id<>projection.user_id OR NOT (code_version.language <=> projection.language) OR code_version.visibility<>projection.source_visibility OR code_version.source_hash<>SHA2(COALESCE(legacy.code,''),256)) AS submissions_code_version_mismatch,
    (SELECT COUNT(*) FROM submission_v2_projection projection WHERE projection.code_version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM api_v2_event event WHERE event.stream=CONCAT('submission:',projection.submission_id) AND event.type IN ('submission.created','submission.code_version.backfilled'))) AS submissions_code_version_event_missing,
    (SELECT COUNT(*) FROM judge_state legacy INNER JOIN submission_v2_projection projection ON projection.submission_id=legacy.id WHERE projection.status<>(${expectedSubmissionStatusSql})) AS submissions_status_mismatch,
    (SELECT COUNT(*) FROM judge_state legacy INNER JOIN submission_v2_projection projection ON projection.submission_id=legacy.id WHERE projection.problem_id<>legacy.problem_id OR projection.user_id<>legacy.user_id OR NOT (projection.contest_id <=> CASE WHEN legacy.type=1 THEN CAST(legacy.type_info AS UNSIGNED) ELSE NULL END) OR NOT (projection.language <=> legacy.language)) AS submissions_identity_mismatch,
    (SELECT COUNT(*) FROM contest) AS contests_legacy,
    (SELECT COUNT(*) FROM contest_v2_state) AS contests_state_v2,
    (SELECT COUNT(*) FROM contest_v2_config) AS contests_config_v2,
    (SELECT COUNT(*) FROM contest_v2_standings_current) AS contests_standings_v2,
    (SELECT COUNT(*) FROM contest legacy LEFT JOIN contest_v2_state projection ON projection.contest_id=legacy.id WHERE projection.contest_id IS NULL) AS contests_legacy_missing_state,
    (SELECT COUNT(*) FROM contest_v2_state projection LEFT JOIN contest legacy ON legacy.id=projection.contest_id WHERE legacy.id IS NULL) AS contests_state_orphaned,
    (SELECT COUNT(*) FROM contest legacy LEFT JOIN contest_v2_config projection ON projection.contest_id=legacy.id WHERE projection.contest_id IS NULL) AS contests_legacy_missing_config,
    (SELECT COUNT(*) FROM contest_v2_config projection LEFT JOIN contest legacy ON legacy.id=projection.contest_id WHERE legacy.id IS NULL) AS contests_config_orphaned,
    (SELECT COUNT(*) FROM contest legacy LEFT JOIN contest_v2_standings_current projection ON projection.contest_id=legacy.id WHERE projection.contest_id IS NULL) AS contests_legacy_missing_standings,
    (SELECT COUNT(*) FROM contest_v2_standings_current projection LEFT JOIN contest legacy ON legacy.id=projection.contest_id WHERE legacy.id IS NULL) AS contests_standings_orphaned,
    (SELECT COUNT(*) FROM rating_history) AS ratings_legacy,
    (SELECT COUNT(*) FROM rating_v2_event WHERE kind='legacy_import') AS ratings_v2,
    (SELECT COUNT(*) FROM rating_history legacy LEFT JOIN rating_v2_event projection ON projection.kind='legacy_import' AND projection.source_event_id=CONCAT('rating_history:',legacy.rating_calculation_id,':',legacy.user_id) WHERE projection.id IS NULL) AS ratings_legacy_missing_v2,
    (SELECT COUNT(*) FROM rating_v2_event projection LEFT JOIN rating_history legacy ON projection.source_event_id=CONCAT('rating_history:',legacy.rating_calculation_id,':',legacy.user_id) WHERE projection.kind='legacy_import' AND legacy.user_id IS NULL) AS ratings_v2_orphaned,
    (SELECT COUNT(*) FROM rating_history legacy INNER JOIN rating_calculation calculation ON calculation.id=legacy.rating_calculation_id INNER JOIN rating_v2_event projection ON projection.kind='legacy_import' AND projection.source_event_id=CONCAT('rating_history:',legacy.rating_calculation_id,':',legacy.user_id) WHERE projection.user_id<>legacy.user_id OR NOT (projection.contest_id <=> calculation.contest_id) OR NOT (projection.rating_after <=> legacy.rating_after)) AS ratings_value_mismatch,
    (SELECT COUNT(*) FROM (SELECT DISTINCT user_id FROM rating_history) legacy LEFT JOIN rating_v2_current projection ON projection.profile_id='icpc' AND projection.user_id=legacy.user_id WHERE projection.user_id IS NULL) AS ratings_current_missing,
    (SELECT COUNT(*) FROM rating_v2_current projection INNER JOIN user legacy ON legacy.id=projection.user_id WHERE projection.profile_id='icpc' AND ROUND(projection.rating)<>ROUND(legacy.rating)) AS ratings_current_value_mismatch`);
  const row = rows[0];
  const domains = [
    migrationConsistency.item('identity', row.identities_legacy, row.identities_v2, { legacy_missing_v2: row.identities_legacy_missing_v2, v2_orphaned: row.identities_v2_orphaned, invalid_status: row.identities_invalid_status, missing_event_baseline: row.identities_missing_event_baseline }),
    migrationConsistency.item('problems', row.problems_legacy, row.problems_v2, { legacy_missing_v2: row.problems_legacy_missing_v2, v2_orphaned: row.problems_v2_orphaned, missing_snapshot: row.problems_missing_snapshot, remote_source_missing: row.problems_remote_source_missing, remote_source_orphaned: row.problems_remote_source_orphaned, remote_source_mismatch: row.problems_remote_source_mismatch, remote_source_invalid: row.problems_remote_source_invalid, remote_source_duplicates: row.problems_remote_source_duplicates }),
    migrationConsistency.item('submissions', row.submissions_legacy, row.submissions_v2, { legacy_missing_v2: row.submissions_legacy_missing_v2, v2_orphaned: row.submissions_v2_orphaned, missing_event_baseline: row.submissions_missing_event_baseline, missing_snapshot: row.submissions_missing_snapshot, missing_code_version: row.submissions_missing_code_version, code_version_orphaned: row.submissions_code_version_orphaned, code_version_mismatch: row.submissions_code_version_mismatch, code_version_event_missing: row.submissions_code_version_event_missing, status_mismatch: row.submissions_status_mismatch, identity_mismatch: row.submissions_identity_mismatch }),
    migrationConsistency.item('contests', row.contests_legacy, row.contests_state_v2, { legacy_missing_state: row.contests_legacy_missing_state, state_orphaned: row.contests_state_orphaned, legacy_missing_config: row.contests_legacy_missing_config, config_orphaned: row.contests_config_orphaned, legacy_missing_standings: row.contests_legacy_missing_standings, standings_orphaned: row.contests_standings_orphaned }),
    migrationConsistency.item('ratings', row.ratings_legacy, row.ratings_v2, { legacy_missing_v2: row.ratings_legacy_missing_v2, v2_orphaned: row.ratings_v2_orphaned, value_mismatch: row.ratings_value_mismatch, current_missing: row.ratings_current_missing, current_value_mismatch: row.ratings_current_value_mismatch })
  ];
  return { domains, consistent: domains.every(item => item.consistent) };
}

async function migrationCompatibilityStatus(report) {
  await ensureMigrationSchema();
  await syzoj.utils.apiV2Rollout.ensureSchema();
  const connection = TypeORM.getConnection();
  const rows = await connection.query("SELECT * FROM api_v2_migration_compatibility WHERE scope='global' LIMIT 1");
  const current = rows[0] || {};
  const cycles = await migrationCycleEvidence.completedCycleSummary(connection, current.compatibility_started_at);
  const rollouts = await connection.query('SELECT domain,enabled,percentage FROM api_v2_rollout ORDER BY domain ASC');
  return migrationReleaseGate.releaseGate({
    domains: report.domains,
    compatibility_started_at: current.compatibility_started_at ? api().databaseIso(current.compatibility_started_at) : null,
    compatibility_started_by: current.compatibility_started_by,
    last_consistency_at: current.last_consistency_at ? api().databaseIso(current.last_consistency_at) : null,
    complete_contest_cycles: cycles.total,
    archived_contest_cycles: cycles.archived,
    rollback_rehearsed_at: current.rollback_rehearsed_at ? api().databaseIso(current.rollback_rehearsed_at) : null,
    rollback_rehearsed_by: current.rollback_rehearsed_by,
    rollback_rehearsal: parseJson(current.rollback_rehearsal_json, null),
    rollouts
  });
}

async function latestMigrationRuns() {
  await ensureMigrationSchema();
  const rows = await TypeORM.getConnection().query(`SELECT run.*
    FROM api_v2_migration_run run
    WHERE NOT EXISTS (
      SELECT 1 FROM api_v2_migration_run newer
      WHERE newer.domain=run.domain
        AND (newer.created_at>run.created_at OR (newer.created_at=run.created_at AND newer.id>run.id))
    )
    ORDER BY FIELD(run.domain,'identity','problem','submission','contest','rating'),run.created_at DESC`);
  return rows.map(serialize);
}

async function migrationStatusPayload() {
  const report = await migrationConsistencyReport();
  const [compatibility, runs] = await Promise.all([
    migrationCompatibilityStatus(report),
    latestMigrationRuns()
  ]);
  return { ...report, compatibility, runs };
}

app.get('/api/v2/admin/migrations/consistency', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!await can(user)) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: admin:job.manage.');
  return api().send(res, await migrationStatusPayload());
});

app.get('/api/v2/admin/migrations/compatibility', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!await can(user)) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: admin:job.manage.');
  return api().send(res, await migrationStatusPayload());
});

app.post('/api/v2/admin/migrations/compatibility/start', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!await can(user)) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: admin:job.manage.');
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again before starting the compatibility observation window.');
  const report = await migrationConsistencyReport();
  if (!report.consistent) return api().fail(res, 409, 'MIGRATION_NOT_CONSISTENT', 'Complete migration and fix every projection difference before starting the compatibility observation window.', { domains: report.domains.filter(domain => !domain.consistent).map(domain => domain.domain).join(',') });
  const gate = await migrationCompatibilityStatus(report);
  if (gate.incomplete_rollout_domains.length) return api().fail(res, 409, 'MIGRATION_ROLLOUT_INCOMPLETE', 'Enable every v2 rollout domain at 100% before starting the compatibility observation window.', { domains: gate.incomplete_rollout_domains.join(',') });
  await ensureMigrationSchema();
  const reason = syzoj.utils.operationReason(req, '开始旧接口兼容观察');
  const result = await TypeORM.getConnection().transaction(async manager => {
    const rows = await manager.query("SELECT * FROM api_v2_migration_compatibility WHERE scope='global' FOR UPDATE");
    const existing = rows[0] || null;
    if (!existing) {
      await manager.query("INSERT INTO api_v2_migration_compatibility (scope,compatibility_started_at,compatibility_started_by,updated_at) VALUES ('global',UTC_TIMESTAMP(3),?,UTC_TIMESTAMP(3))", [user.id]);
    }
    const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
      action: 'admin:migration.compatibility.start', resourceType: 'migration_compatibility', resourceId: 'global', reason,
      details: { resumed_existing_window: !!existing }
    }, manager);
    return { auditEventId, resumed: !!existing };
  });
  await api().appendEvent({ stream: 'migration:compatibility', type: 'migration.compatibility.started', aggregateId: 'global', actor: user, payload: { audit_event_id: result.auditEventId, resumed: result.resumed } });
  return api().send(res, { compatibility: await migrationCompatibilityStatus(report), audit_event_id: result.auditEventId }, result.resumed ? 200 : 201);
});

app.post('/api/v2/admin/migrations/compatibility/rehearse-rollback', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!await can(user)) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: admin:job.manage.');
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again before recording a rollback rehearsal.');
  const report = await migrationConsistencyReport();
  if (!report.consistent) return api().fail(res, 409, 'MIGRATION_NOT_CONSISTENT', 'Fix all projection differences before recording a rollback rehearsal.', { domains: report.domains.filter(domain => !domain.consistent).map(domain => domain.domain).join(',') });
  const gate = await migrationCompatibilityStatus(report);
  if (gate.incomplete_rollout_domains.length) return api().fail(res, 409, 'MIGRATION_ROLLOUT_INCOMPLETE', 'Enable every v2 rollout domain at 100% before rehearsing rollback.', { domains: gate.incomplete_rollout_domains.join(',') });
  await ensureMigrationSchema();
  const reason = syzoj.utils.operationReason(req, '执行迁移回退演练');
  const result = await TypeORM.getConnection().transaction(async manager => {
    const rows = await manager.query("SELECT * FROM api_v2_migration_compatibility WHERE scope='global' FOR UPDATE");
    if (!rows.length || !rows[0].compatibility_started_at) {
      const error = new Error('Start the compatibility observation window before recording a rollback rehearsal.');
      error.code = 'MIGRATION_COMPATIBILITY_NOT_STARTED'; error.statusCode = 409; throw error;
    }
    const rolloutRows = await manager.query('SELECT domain,enabled,percentage FROM api_v2_rollout ORDER BY domain ASC FOR UPDATE');
    const rolloutSnapshot = migrationReleaseGate.normalizeRollouts(rolloutRows);
    await manager.query('UPDATE api_v2_rollout SET enabled=0,percentage=0');
    const disabledRows = await manager.query('SELECT domain,enabled,percentage FROM api_v2_rollout ORDER BY domain ASC');
    const disabledSnapshot = migrationReleaseGate.normalizeRollouts(disabledRows);
    const disabledVerified = disabledSnapshot.length === rolloutSnapshot.length && disabledSnapshot.every(row => !row.enabled && row.percentage === 0);
    for (const rollout of rolloutSnapshot) await manager.query('UPDATE api_v2_rollout SET enabled=?,percentage=? WHERE domain=?', [rollout.enabled ? 1 : 0, rollout.percentage, rollout.domain]);
    const restoredRows = await manager.query('SELECT domain,enabled,percentage FROM api_v2_rollout ORDER BY domain ASC');
    const restoredSnapshot = migrationReleaseGate.normalizeRollouts(restoredRows);
    const restoredVerified = migrationReleaseGate.sameRollouts(rolloutSnapshot, restoredSnapshot);
    if (!disabledVerified || !restoredVerified) throw Object.assign(new Error('Rollout configuration did not disable and restore exactly during rollback rehearsal.'), { code: 'MIGRATION_ROLLBACK_REHEARSAL_FAILED', statusCode: 500 });
    const rehearsal = { version: 1, consistency_verified: true, disabled_verified: disabledVerified, restored_verified: restoredVerified, rollouts: rolloutSnapshot };
    await manager.query("UPDATE api_v2_migration_compatibility SET last_consistency_at=UTC_TIMESTAMP(3),last_consistency_json=?,rollback_rehearsed_at=UTC_TIMESTAMP(3),rollback_rehearsed_by=?,rollback_rehearsal_json=?,updated_at=UTC_TIMESTAMP(3) WHERE scope='global'", [JSON.stringify(report), user.id, JSON.stringify(rehearsal)]);
    const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
      action: 'admin:migration.compatibility.rollback_rehearsal', resourceType: 'migration_compatibility', resourceId: 'global', reason,
      details: { domains: report.domains.map(domain => domain.domain), disabled_verified: disabledVerified, restored_verified: restoredVerified, rollout_domains: rolloutSnapshot.map(row => row.domain) }
    }, manager);
    return { auditEventId };
  });
  await api().appendEvent({ stream: 'migration:compatibility', type: 'migration.compatibility.rollback_rehearsed', aggregateId: 'global', actor: user, payload: { audit_event_id: result.auditEventId } });
  return api().send(res, { compatibility: await migrationCompatibilityStatus(report), audit_event_id: result.auditEventId });
});
ensureMigrationSchema().then(() => setImmediate(() => recoverMigrations().catch(error => syzoj.log(`[migration-v2] recovery failed: ${error.stack || error.message}`)))).catch(error => syzoj.log(`[migration-v2] schema initialization failed: ${error.stack || error.message}`));
