const crypto = require('crypto');
const path = require('path');
const TypeORM = require('typeorm');
const vault = require('../libs/credential-vault');
const vjudgeJobRecovery = require('../libs/vjudge-job-recovery');
const vjudgeImportPolicy = require('../libs/vjudge-import-policy');
const vjudgeRemoteSubmission = require('../libs/vjudge-remote-submission');
const { createProviderScheduler } = require('../libs/vjudge-provider-scheduler');
const ProblemTag = syzoj.model('problem_tag');
const Problem = syzoj.model('problem');
const JudgeState = syzoj.model('judge_state');

const PROVIDERS = Object.freeze({
  uoj: { name: 'UOJ', problemType: 'vjudge:uoj', remotePrefix: 'U', rateLimitMs: 500, capabilities: ['problem_search', 'problem_import', 'remote_submission', 'submission_sync'] },
  hdu: { name: 'HDU', problemType: 'vjudge:hdu', remotePrefix: 'H', rateLimitMs: 500, capabilities: ['problem_search', 'problem_import', 'remote_submission', 'submission_sync'] },
  poj: { name: 'POJ', problemType: 'vjudge:poj', remotePrefix: 'P', rateLimitMs: 500, capabilities: ['problem_search', 'problem_import', 'remote_submission', 'submission_sync'] }
});
let schemaPromise = null;
let credentialKey = null;
const providerScheduler = createProviderScheduler();

function api() { return syzoj.utils.apiV2; }
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
async function can(user, capability) { return !!(user && await syzoj.utils.authorizationV2.authorize(user, capability, null, {})); }
function operationReason(req) {
  return syzoj.utils.operationReason(req, 'VJudge 管理操作');
}
function getCredentialKey() {
  if (!credentialKey) credentialKey = vault.loadOrCreateKey(path.join('/app/config', 'vjudge-v2-credential.key'), process.env.SYZOJ_VJUDGE_CREDENTIAL_KEY);
  return credentialKey;
}
function providerAdapter(provider) {
  const adapter = syzoj.utils.vjudgeImporters && syzoj.utils.vjudgeImporters[provider];
  return adapter && vjudgeRemoteSubmission.adapterMissingMethods(adapter).length === 0 &&
    ['withCredential', 'fetchProblemIds', 'importProblem'].every(method => typeof adapter[method] === 'function') ? adapter : null;
}
async function providerOperation(providerId, operation, options = {}) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw Object.assign(new Error('Provider was not found.'), { publicCode: 'VJUDGE_PROVIDER_NOT_FOUND' });
  const maxAttempts = options.retry === false ? 1 : 3;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await providerScheduler.run(providerId, provider.rateLimitMs, operation);
    } catch (error) {
      lastError = error;
      const failure = vjudgeImportPolicy.classifyFailure(error);
      if (attempt === maxAttempts || !vjudgeImportPolicy.retryableFailure(failure)) throw error;
      const delayMs = vjudgeImportPolicy.retryDelayMs(attempt, provider.rateLimitMs);
      if (options.onRetry) await options.onRetry({ attempt: attempt + 1, delay_ms: delayMs, failure });
      await delay(delayMs);
    }
  }
  throw lastError;
}
async function loadJobCredentialReference(job, connection = TypeORM.getConnection()) {
  const rows = await connection.query(`SELECT encrypted_ref,encryption_iv,encryption_tag
    FROM vjudge_v2_credential
    WHERE id=? AND user_id=? AND provider=? AND credential_ref=? AND status='active'
    LIMIT 1`, [job.credential_id, job.actor_id, job.provider, job.credential_fingerprint]);
  if (!rows.length) throw Object.assign(new Error('The import credential is unavailable or has changed.'), { publicCode: 'UPSTREAM_AUTH_FAILED' });
  try {
    return vault.decrypt({
      ciphertext: rows[0].encrypted_ref,
      iv: rows[0].encryption_iv,
      authTag: rows[0].encryption_tag
    }, getCredentialKey(), job.provider);
  } catch (error) {
    throw Object.assign(new Error('The import credential cannot be decrypted.'), { publicCode: 'UPSTREAM_AUTH_FAILED' });
  }
}
async function jobProviderOperation(job, adapter, operation, options = {}) {
  const reference = await loadJobCredentialReference(job);
  return adapter.withCredential(reference, () => providerOperation(job.provider, operation, options));
}
function safeJson(value, fallback) { try { return typeof value === 'object' ? value : JSON.parse(value || ''); } catch (error) { return fallback; } }
function serializeJob(row) {
  return {
    id: row.id, provider: row.provider, state: row.state, stage: row.stage,
    current_remote_id: row.current_remote_id || null,
    progress: { total: Number(row.total), processed: Number(row.processed), imported: Number(row.imported), skipped: Number(row.skipped), failed: Number(row.failed) },
    failures: safeJson(row.failures_json, []),
    error: row.error_json ? safeJson(row.error_json, { code: 'JOB_FAILED', message: 'The import job failed.' }) : null,
    created_at: api().databaseIso(row.created_at), updated_at: api().databaseIso(row.updated_at)
  };
}

async function addColumnIfMissing(connection, table, column, definition) {
  const rows = await connection.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  if (!rows.length) await connection.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function ensureVjudgeV2Schema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const connection = TypeORM.getConnection();
    await connection.query(`CREATE TABLE IF NOT EXISTS vjudge_v2_credential (
      id CHAR(36) NOT NULL PRIMARY KEY, user_id INT NOT NULL, provider VARCHAR(32) NOT NULL,
      credential_ref CHAR(64) NOT NULL, encrypted_ref LONGTEXT NULL, encryption_iv VARCHAR(32) NULL,
      encryption_tag VARCHAR(32) NULL, reference_hint VARCHAR(120) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active', tested_at DATETIME(3) NULL,
      last_error_code VARCHAR(80) NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_vjudge_credential_user_provider(user_id,provider)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await addColumnIfMissing(connection, 'vjudge_v2_credential', 'encrypted_ref', 'LONGTEXT NULL');
    await addColumnIfMissing(connection, 'vjudge_v2_credential', 'encryption_iv', 'VARCHAR(32) NULL');
    await addColumnIfMissing(connection, 'vjudge_v2_credential', 'encryption_tag', 'VARCHAR(32) NULL');
    await addColumnIfMissing(connection, 'vjudge_v2_credential', 'reference_hint', 'VARCHAR(120) NULL');
    await addColumnIfMissing(connection, 'vjudge_v2_credential', 'tested_at', 'DATETIME(3) NULL');
    await addColumnIfMissing(connection, 'vjudge_v2_credential', 'last_error_code', 'VARCHAR(80) NULL');
    await connection.query(`CREATE TABLE IF NOT EXISTS vjudge_v2_import_job (
      id CHAR(36) NOT NULL PRIMARY KEY, provider VARCHAR(32) NOT NULL, actor_id INT NOT NULL,
      credential_id CHAR(36) NULL, credential_fingerprint CHAR(64) NULL,
      state VARCHAR(24) NOT NULL, stage VARCHAR(32) NOT NULL, total INT NOT NULL DEFAULT 0,
      processed INT NOT NULL DEFAULT 0, imported INT NOT NULL DEFAULT 0, skipped INT NOT NULL DEFAULT 0,
      failed INT NOT NULL DEFAULT 0, cancel_requested TINYINT(1) NOT NULL DEFAULT 0,
      current_remote_id VARCHAR(80) NULL, cancelled_at DATETIME(3) NULL, failures_json LONGTEXT NULL,
      error_json LONGTEXT NULL, options_json LONGTEXT NOT NULL, created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL, KEY idx_vjudge_v2_job_actor(actor_id,created_at),
      KEY idx_vjudge_v2_job_state(state,updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await addColumnIfMissing(connection, 'vjudge_v2_import_job', 'cancel_requested', 'TINYINT(1) NOT NULL DEFAULT 0');
    await addColumnIfMissing(connection, 'vjudge_v2_import_job', 'current_remote_id', 'VARCHAR(80) NULL');
    await addColumnIfMissing(connection, 'vjudge_v2_import_job', 'failures_json', 'LONGTEXT NULL');
    await addColumnIfMissing(connection, 'vjudge_v2_import_job', 'credential_id', 'CHAR(36) NULL');
    await addColumnIfMissing(connection, 'vjudge_v2_import_job', 'credential_fingerprint', 'CHAR(64) NULL');
    await connection.query(`CREATE TABLE IF NOT EXISTS vjudge_v2_import_item (
      job_id CHAR(36) NOT NULL, remote_id VARCHAR(80) NOT NULL, state VARCHAR(24) NOT NULL,
      attempts TINYINT UNSIGNED NOT NULL DEFAULT 0, local_problem_id INT NULL,
      error_code VARCHAR(80) NULL, error_message VARCHAR(500) NULL, updated_at DATETIME(3) NOT NULL,
      PRIMARY KEY(job_id,remote_id), KEY idx_vjudge_v2_item_state(job_id,state,remote_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS vjudge_v2_remote_problem (
      provider VARCHAR(32) NOT NULL, remote_id VARCHAR(80) NOT NULL, local_problem_id INT NOT NULL,
      imported_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
      PRIMARY KEY(provider,remote_id), UNIQUE KEY uq_vjudge_v2_local_problem(local_problem_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS vjudge_v2_submission_sync (
      local_submission_id BIGINT UNSIGNED NOT NULL PRIMARY KEY, provider VARCHAR(32) NOT NULL,
      upstream_task_id VARCHAR(120) NULL, remote_problem_id VARCHAR(120) NULL, phase VARCHAR(24) NOT NULL,
      local_status VARCHAR(80) NOT NULL, marker_hash CHAR(64) NOT NULL, updated_at DATETIME(3) NOT NULL,
      KEY idx_vjudge_v2_sync_provider_task(provider,upstream_task_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  })().catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}

async function updateJobCounts(connection, jobId) {
  const counts = await connection.query(`SELECT COUNT(*) AS total,
    SUM(state IN ('imported','skipped','failed')) AS processed,
    SUM(state='imported') AS imported,SUM(state='skipped') AS skipped,SUM(state='failed') AS failed
    FROM vjudge_v2_import_item WHERE job_id=?`, [jobId]);
  const row = counts[0] || {};
  await connection.query('UPDATE vjudge_v2_import_job SET total=?,processed=?,imported=?,skipped=?,failed=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [Number(row.total || 0), Number(row.processed || 0), Number(row.imported || 0), Number(row.skipped || 0), Number(row.failed || 0), jobId]);
  return { total: Number(row.total || 0), processed: Number(row.processed || 0), imported: Number(row.imported || 0), skipped: Number(row.skipped || 0), failed: Number(row.failed || 0) };
}

async function applyRequestedTags(problemId, names) {
  for (const name of names || []) {
    const normalized = String(name).trim().slice(0, 80); if (!normalized) continue;
    let tag = await ProblemTag.findOne({ where: { name: normalized } });
    if (!tag) { tag = ProblemTag.create({ name: normalized, color: 'grey' }); await tag.save(); }
    await TypeORM.getConnection().query('INSERT IGNORE INTO problem_tag_map (problem_id,tag_id) VALUES (?,?)', [problemId, tag.id]);
  }
}

async function runImportJob(jobId) {
  const connection = TypeORM.getConnection();
  try {
    const claimed = await connection.query("UPDATE vjudge_v2_import_job SET state='running',stage='connecting',updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state='queued'", [jobId]);
    if (!claimed.affectedRows) return;
    const jobs = await connection.query('SELECT * FROM vjudge_v2_import_job WHERE id=? LIMIT 1', [jobId]); const job = jobs[0];
    const provider = PROVIDERS[job.provider]; const adapter = providerAdapter(job.provider);
    if (!adapter) throw Object.assign(new Error('Provider adapter is not loaded.'), { publicCode: 'PROVIDER_ADAPTER_UNAVAILABLE' });
    const options = safeJson(job.options_json, {});
    const retryEvent = async event => api().appendEvent({ stream: `vjudge-import:${jobId}`, type: 'vjudge.import.retrying', aggregateId: jobId, payload: event });
    await jobProviderOperation(job, adapter, () => adapter.checkAccount(), { onRetry: retryEvent });
    let remoteIds = vjudgeImportPolicy.normalizeRemoteIds(options.remote_ids);
    if (!remoteIds.length) remoteIds = vjudgeImportPolicy.normalizeRemoteIds(await jobProviderOperation(job, adapter, () => adapter.fetchProblemIds(), { onRetry: retryEvent }));
    await connection.query("UPDATE vjudge_v2_import_job SET stage='previewing',total=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [remoteIds.length, jobId]);
    for (const remoteId of remoteIds) {
      const existing = await Problem.findOne({ where: { type: provider.problemType, vjudge_config: remoteId } });
      const state = vjudgeImportPolicy.initialItemState(existing, options.conflict_policy);
      await connection.query('INSERT IGNORE INTO vjudge_v2_import_item (job_id,remote_id,state,attempts,local_problem_id,updated_at) VALUES (?,?,?,0,?,UTC_TIMESTAMP(3))', [jobId, remoteId, state, existing ? existing.id : null]);
      if (existing) await connection.query('INSERT INTO vjudge_v2_remote_problem (provider,remote_id,local_problem_id,imported_at,updated_at) VALUES (?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE local_problem_id=VALUES(local_problem_id),updated_at=UTC_TIMESTAMP(3)', [job.provider, remoteId, existing.id]);
    }
    let counts = await updateJobCounts(connection, jobId);
    if (options.preview_only) {
      await connection.query("UPDATE vjudge_v2_import_job SET state='paused',stage='awaiting_approval',updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
      await api().appendEvent({ stream: `vjudge-import:${jobId}`, type: 'vjudge.import.preview.ready', aggregateId: jobId, payload: { progress: counts } });
      return;
    }
    await connection.query("UPDATE vjudge_v2_import_job SET stage='importing',updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
    const items = await connection.query("SELECT * FROM vjudge_v2_import_item WHERE job_id=? AND state IN ('pending','retrying') ORDER BY remote_id ASC", [jobId]);
    const failures = [];
    for (const item of items) {
      const controls = await connection.query('SELECT cancel_requested,state FROM vjudge_v2_import_job WHERE id=? LIMIT 1', [jobId]);
      if (!controls.length || controls[0].cancel_requested || controls[0].state === 'cancelling') {
        await connection.query("UPDATE vjudge_v2_import_job SET state='cancelled',stage='cancelled',current_remote_id=NULL,cancelled_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
        await api().appendEvent({ stream: `vjudge-import:${jobId}`, type: 'vjudge.import.cancelled', aggregateId: jobId, payload: { progress: await updateJobCounts(connection, jobId) } });
        return;
      }
      await connection.query("UPDATE vjudge_v2_import_job SET current_remote_id=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [item.remote_id, jobId]);
      await connection.query("UPDATE vjudge_v2_import_item SET state='running',attempts=attempts+1,updated_at=UTC_TIMESTAMP(3) WHERE job_id=? AND remote_id=?", [jobId, item.remote_id]);
      try {
        // Importing can have local side effects, so it is rate-limited but never auto-replayed.
        const result = await jobProviderOperation(job, adapter, () => adapter.importProblem(item.remote_id, { userId: job.actor_id, isPublic: options.visibility === 'public', skipExisting: options.conflict_policy !== 'overwrite' }), { retry: false });
        const state = result.skipped ? 'skipped' : 'imported';
        await connection.query('UPDATE vjudge_v2_import_item SET state=?,local_problem_id=?,error_code=NULL,error_message=NULL,updated_at=UTC_TIMESTAMP(3) WHERE job_id=? AND remote_id=?', [state, result.localId, jobId, item.remote_id]);
        await connection.query('INSERT INTO vjudge_v2_remote_problem (provider,remote_id,local_problem_id,imported_at,updated_at) VALUES (?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE local_problem_id=VALUES(local_problem_id),updated_at=UTC_TIMESTAMP(3)', [job.provider, item.remote_id, result.localId]);
        await applyRequestedTags(result.localId, options.tags);
      } catch (error) {
        const failure = vjudgeImportPolicy.classifyFailure(error);
        await connection.query("UPDATE vjudge_v2_import_item SET state='failed',error_code=?,error_message=?,updated_at=UTC_TIMESTAMP(3) WHERE job_id=? AND remote_id=?", [failure.code, failure.message, jobId, item.remote_id]);
        if (failures.length < 100) failures.push({ remote_id: item.remote_id, ...failure });
      }
      counts = await updateJobCounts(connection, jobId);
      await connection.query('UPDATE vjudge_v2_import_job SET failures_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [JSON.stringify(failures), jobId]);
      await api().appendEvent({ stream: `vjudge-import:${jobId}`, type: 'vjudge.import.progress', aggregateId: jobId, payload: { current_remote_id: item.remote_id, progress: counts } });
    }
    counts = await updateJobCounts(connection, jobId);
    await connection.query("UPDATE vjudge_v2_import_job SET state='completed',stage='completed',current_remote_id=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
    await api().appendEvent({ stream: `vjudge-import:${jobId}`, type: 'vjudge.import.completed', aggregateId: jobId, payload: { progress: counts } });
  } catch (error) {
    const failure = vjudgeImportPolicy.classifyFailure(error);
    await connection.query("UPDATE vjudge_v2_import_job SET state='failed',stage='failed',current_remote_id=NULL,error_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [JSON.stringify(failure), jobId]).catch(() => {});
    await api().appendEvent({ stream: `vjudge-import:${jobId}`, type: 'vjudge.import.failed', aggregateId: jobId, payload: failure }).catch(() => {});
  }
}

async function listVjudgeSources(req, res) {
  await ensureVjudgeV2Schema();
  const manageable = !!(res.locals.user && await can(res.locals.user, 'vjudge:source.manage'));
  const credentials = manageable ? await TypeORM.getConnection().query("SELECT provider,status,reference_hint,tested_at FROM vjudge_v2_credential WHERE user_id=? AND status='active'", [res.locals.user.id]) : [];
  const byProvider = new Map(credentials.map(row => [row.provider, row]));
  return api().send(res, Object.entries(PROVIDERS).map(([id, value]) => {
    const credential = byProvider.get(id);
    return { id, name: value.name, capabilities: value.capabilities, problem_types: [value.problemType], policy: { rate_limit_ms: value.rateLimitMs, contest_submissions_enabled: false, maximum_batch_size: 5000 }, credential_configured: !!credential, credential_hint: credential ? credential.reference_hint : undefined, tested_at: credential ? api().databaseIso(credential.tested_at) : null };
  }));
}
app.get('/api/v2/vjudge/providers', listVjudgeSources);
app.get('/api/v2/vjudge/sources', listVjudgeSources);

async function testVjudgeConnection(req, res) {
  const user = res.locals.user; const providerId = String(req.params.provider || req.params.id || '');
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!PROVIDERS[providerId]) return api().fail(res, 404, 'VJUDGE_PROVIDER_NOT_FOUND', 'Provider was not found.');
  if (!await can(user, 'vjudge:source.manage')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: vjudge:source.manage.');
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again or complete MFA before testing provider credentials.');
  const reason = operationReason(req);
  const adapter = providerAdapter(providerId); if (!adapter) return api().fail(res, 503, 'PROVIDER_ADAPTER_UNAVAILABLE', 'The provider adapter is not loaded.');
  const reference = String(req.body && req.body.secret_ref || `env:SYZOJ_WEB_${providerId.toUpperCase()}`).trim();
  if (!/^(env:[A-Z0-9_]+|vault:\/\/[A-Za-z0-9._\/-]+|secret:\/\/[A-Za-z0-9._\/-]+)$/.test(reference)) return api().fail(res, 422, 'VALIDATION_FAILED', 'A valid environment or vault secret reference is required.', { secret_ref: 'invalid reference' });
  try { await adapter.withCredential(reference, () => providerOperation(providerId, () => adapter.checkAccount())); } catch (error) { const failure = vjudgeImportPolicy.classifyFailure(error); return api().fail(res, 502, failure.code, failure.message); }
  await ensureVjudgeV2Schema(); const id = crypto.randomUUID(); const encrypted = vault.encrypt(reference, getCredentialKey(), providerId); const fingerprint = vault.referenceFingerprint(reference); const hint = reference.startsWith('env:') ? reference : reference.replace(/\/[^/]+$/, '/***');
  await TypeORM.getConnection().query(`INSERT INTO vjudge_v2_credential (id,user_id,provider,credential_ref,encrypted_ref,encryption_iv,encryption_tag,reference_hint,status,tested_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,'active',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))
    ON DUPLICATE KEY UPDATE credential_ref=VALUES(credential_ref),encrypted_ref=VALUES(encrypted_ref),encryption_iv=VALUES(encryption_iv),encryption_tag=VALUES(encryption_tag),reference_hint=VALUES(reference_hint),status='active',tested_at=UTC_TIMESTAMP(3),last_error_code=NULL,updated_at=UTC_TIMESTAMP(3)`,
    [id, user.id, providerId, fingerprint, encrypted.ciphertext, encrypted.iv, encrypted.authTag, hint]);
  const stored = await TypeORM.getConnection().query('SELECT id FROM vjudge_v2_credential WHERE user_id=? AND provider=? LIMIT 1', [user.id, providerId]);
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'vjudge:connection.test', resourceType: 'provider', resourceId: providerId, reason, details: { credential_fingerprint: fingerprint } });
  return api().send(res, { provider: providerId, status: 'configured', credential_id: stored[0].id, reference_hint: hint, audit_event_id: auditEventId });
}
app.post('/api/v2/vjudge/connections/:provider/test', testVjudgeConnection);
app.post('/api/v2/vjudge/sources/:id/test-connection', testVjudgeConnection);
app.post('/api/v2/vjudge/sources', async (req, res, next) => {
  if (req.body && req.body.provider) req.params.provider = String(req.body.provider);
  return testVjudgeConnection(req, res, next);
});

app.delete('/api/v2/vjudge/connections/:provider', async (req, res) => {
  const user = res.locals.user; const providerId = String(req.params.provider || '');
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!await can(user, 'vjudge:source.manage')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: vjudge:source.manage.');
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again or complete MFA before disabling a provider credential.');
  const reason = operationReason(req);
  const result = await TypeORM.getConnection().query("UPDATE vjudge_v2_credential SET status='disabled',encrypted_ref=NULL,encryption_iv=NULL,encryption_tag=NULL,updated_at=UTC_TIMESTAMP(3) WHERE user_id=? AND provider=?", [user.id, providerId]);
  if (!result.affectedRows) return api().fail(res, 404, 'VJUDGE_CONNECTION_NOT_FOUND', 'Provider connection was not found.');
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'vjudge:connection.disable', resourceType: 'provider', resourceId: providerId, reason });
  return api().send(res, { provider: providerId, status: 'disabled', audit_event_id: auditEventId });
});

app.get('/api/v2/vjudge/imports', async (req, res) => {
  const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user, 'vjudge:import.create')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: vjudge:import.create.');
  await ensureVjudgeV2Schema(); const limit = api().parseLimit(req, 30, 100); const cursor = api().decodeCursor(req.query.cursor);
  const rows = await TypeORM.getConnection().query('SELECT * FROM vjudge_v2_import_job WHERE actor_id=? AND (? IS NULL OR created_at<?) ORDER BY created_at DESC LIMIT ?', [user.id, cursor && cursor.created_at || null, cursor && cursor.created_at || null, limit + 1]);
  const more = rows.length > limit; res.locals.apiMeta.limit = limit; res.locals.apiMeta.next_cursor = more ? api().encodeCursor({ created_at: api().databaseIso(rows[limit - 1].created_at) }) : null; return api().send(res, rows.slice(0, limit).map(serializeJob));
});

async function createVjudgeImport(req, res) {
  const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user, 'vjudge:import.create')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: vjudge:import.create.'); if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again or complete MFA before starting an import.');
  const reason = operationReason(req); const body = req.body || {};
  const provider = String(req.params.provider || req.params.id || body.provider || ''); if (!PROVIDERS[provider]) return api().fail(res, 422, 'VALIDATION_FAILED', 'Unsupported VJudge provider.', { provider: 'unsupported' });
  const requested = Array.isArray(body.remote_ids) ? body.remote_ids : []; const remoteIds = vjudgeImportPolicy.normalizeRemoteIds(requested); if (requested.length && remoteIds.length !== requested.length) return api().fail(res, 422, 'VALIDATION_FAILED', 'Remote problem identifiers must be positive integers.', { remote_ids: 'contains invalid or duplicate identifiers' });
  await ensureVjudgeV2Schema();
  const connection = TypeORM.getConnection();
  const credentials = await connection.query("SELECT id,credential_ref FROM vjudge_v2_credential WHERE user_id=? AND provider=? AND status='active' AND tested_at IS NOT NULL LIMIT 1", [user.id, provider]);
  if (!credentials.length) return api().fail(res, 409, 'VJUDGE_CREDENTIAL_REQUIRED', 'Test and save a provider credential before creating an import.');
  const id = crypto.randomUUID(); const options = { remote_ids: remoteIds, visibility: body.visibility === 'public' ? 'public' : 'private', tags: Array.isArray(body.tags) ? body.tags.map(String).slice(0, 20) : [], conflict_policy: body.conflict_policy === 'overwrite' ? 'overwrite' : 'skip', preview_only: !!body.preview_only };
  await connection.query("INSERT INTO vjudge_v2_import_job (id,provider,actor_id,credential_id,credential_fingerprint,state,stage,total,options_json,created_at,updated_at) VALUES (?,?,?,?,?,'queued','queued',?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [id, provider, user.id, credentials[0].id, credentials[0].credential_ref, remoteIds.length, JSON.stringify(options)]);
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'vjudge:import.create', resourceType: 'vjudge_import', resourceId: id, reason, details: { provider, count: remoteIds.length, preview_only: options.preview_only } });
  await api().appendEvent({ stream: `vjudge-import:${id}`, type: 'vjudge.import.queued', aggregateId: id, actor: user, payload: { job_id: id, provider, audit_event_id: auditEventId } }); setImmediate(() => runImportJob(id));
  return api().send(res, { id, provider, state: 'queued', stage: 'queued', progress: { total: remoteIds.length, processed: 0, imported: 0, skipped: 0, failed: 0 }, audit_event_id: auditEventId }, 202);
}
app.post('/api/v2/vjudge/imports', createVjudgeImport);
app.post('/api/v2/vjudge/sources/:id/imports', createVjudgeImport);

app.post('/api/v2/vjudge/problems/:id/submissions', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  const problem = await Problem.findById(Number(req.params.id));
  if (!problem) return api().fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
  const provider = String(problem.type || '').slice('vjudge:'.length).toLowerCase();
  if (!PROVIDERS[provider]) return api().fail(res, 409, 'VJUDGE_PROBLEM_REQUIRED', 'The problem is not associated with a supported VJudge provider.');
  if (!await problem.isAllowedUseBy(user)) return api().fail(res, 403, 'PROBLEM_FORBIDDEN', 'You cannot submit to this problem.');
  if (!await syzoj.utils.authorizationV2.authorize(user, 'vjudge:submission.create', { ownerId: problem.user_id, scope: `problem:${problem.id}` }, { scope: `problem:${problem.id}` })) {
    return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: vjudge:submission.create.');
  }
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again or complete MFA before submitting to VJudge.');
  const submitter = syzoj.utils.submissionV2 && syzoj.utils.submissionV2.createSubmission;
  if (typeof submitter !== 'function') return api().fail(res, 503, 'SUBMISSION_DOMAIN_UNAVAILABLE', 'The submission service is not ready.');
  return submitter(req, res, problem, null);
});

app.get('/api/v2/vjudge/remote-problems/:source/:remote_id', async (req, res) => {
  const provider = String(req.params.source || '').trim().toLowerCase();
  const remoteId = String(req.params.remote_id || '').trim();
  if (!/^[a-z0-9_-]{1,32}$/.test(provider) || !remoteId || remoteId.length > 80) return api().fail(res, 404, 'VJUDGE_REMOTE_PROBLEM_NOT_FOUND', 'Remote problem was not found.');
  await ensureVjudgeV2Schema();
  const rows = await TypeORM.getConnection().query('SELECT local_problem_id,imported_at,updated_at FROM vjudge_v2_remote_problem WHERE provider=? AND remote_id=? LIMIT 1', [provider, remoteId]);
  if (!rows.length) return api().fail(res, 404, 'VJUDGE_REMOTE_PROBLEM_NOT_FOUND', 'Remote problem was not found.');
  const problem = await Problem.findById(Number(rows[0].local_problem_id));
  if (!problem) return api().fail(res, 404, 'VJUDGE_REMOTE_PROBLEM_NOT_FOUND', 'Remote problem was not found.');
  const editable = !!(res.locals.user && await syzoj.utils.authorizationV2.authorize(res.locals.user, 'problem:edit', { id: problem.id, ownerId: problem.user_id, scope: `problem:${problem.id}` }, { scope: `problem:${problem.id}` }));
  if (!problem.is_public && !editable) return api().fail(res, 404, 'VJUDGE_REMOTE_PROBLEM_NOT_FOUND', 'Remote problem was not found.');
  const projected = syzoj.utils.problemV2.serializeProblem(problem, await syzoj.utils.problemV2.loadState(problem.id));
  return api().send(res, { source: { kind: 'vjudge', provider, remote_id: remoteId }, problem: projected, imported_at: api().databaseIso(rows[0].imported_at), updated_at: api().databaseIso(rows[0].updated_at) });
});

app.get('/api/v2/vjudge/imports/:id', async (req, res) => {
  const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); await ensureVjudgeV2Schema(); const rows = await TypeORM.getConnection().query('SELECT * FROM vjudge_v2_import_job WHERE id=? LIMIT 1', [req.params.id]); if (!rows.length) return api().fail(res, 404, 'VJUDGE_IMPORT_NOT_FOUND', 'Import job was not found.'); if (Number(rows[0].actor_id) !== Number(user.id) && !await can(user, 'admin:job.manage')) return api().fail(res, 403, 'JOB_FORBIDDEN', 'You cannot view this import job.');
  const limit = api().parseLimit(req, 50, 100); const cursor = String(api().decodeCursor(req.query.cursor) || ''); const items = await TypeORM.getConnection().query('SELECT remote_id,state,attempts,local_problem_id,error_code,error_message,updated_at FROM vjudge_v2_import_item WHERE job_id=? AND remote_id>? ORDER BY remote_id ASC LIMIT ?', [req.params.id, cursor, limit + 1]); const more = items.length > limit; res.locals.apiMeta.limit = limit; res.locals.apiMeta.next_cursor = more ? api().encodeCursor(items[limit - 1].remote_id) : null;
  return api().send(res, { ...serializeJob(rows[0]), items: items.slice(0, limit).map(item => ({ remote_id: item.remote_id, state: item.state, attempts: Number(item.attempts), local_problem_id: item.local_problem_id == null ? null : Number(item.local_problem_id), error: item.error_code ? { code: item.error_code, message: item.error_message } : null, updated_at: api().databaseIso(item.updated_at) })) });
});

app.post('/api/v2/vjudge/imports/:id/cancel', async (req, res) => {
  const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const rows = await TypeORM.getConnection().query('SELECT * FROM vjudge_v2_import_job WHERE id=? LIMIT 1', [req.params.id]); if (!rows.length) return api().fail(res, 404, 'VJUDGE_IMPORT_NOT_FOUND', 'Import job was not found.'); if (Number(rows[0].actor_id) !== Number(user.id) && !await can(user, 'admin:job.manage')) return api().fail(res, 403, 'JOB_FORBIDDEN', 'You cannot cancel this import job.'); const nextState = vjudgeImportPolicy.cancellationState(rows[0]); if (!nextState) return api().fail(res, 409, 'JOB_TERMINAL', 'The import job has already finished.'); const reason = operationReason(req);
  await TypeORM.getConnection().query('UPDATE vjudge_v2_import_job SET cancel_requested=1,state=?,stage=?,cancelled_at=CASE WHEN ?=\'cancelled\' THEN UTC_TIMESTAMP(3) ELSE cancelled_at END,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [nextState, nextState, nextState, req.params.id]); const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'vjudge:import.cancel', resourceType: 'vjudge_import', resourceId: req.params.id, reason }); return api().send(res, { id: req.params.id, state: nextState, audit_event_id: auditEventId }, 202);
});

app.post('/api/v2/vjudge/imports/:id/retry', async (req, res) => {
  const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const rows = await TypeORM.getConnection().query('SELECT * FROM vjudge_v2_import_job WHERE id=? LIMIT 1', [req.params.id]); if (!rows.length) return api().fail(res, 404, 'VJUDGE_IMPORT_NOT_FOUND', 'Import job was not found.'); if (Number(rows[0].actor_id) !== Number(user.id) && !await can(user, 'admin:job.manage')) return api().fail(res, 403, 'JOB_FORBIDDEN', 'You cannot retry this import job.'); if (!vjudgeImportPolicy.retryAllowed(rows[0])) return api().fail(res, 409, 'JOB_NOT_RETRYABLE', 'Only failed, cancelled, or partially completed imports can be retried.'); if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again or complete MFA before retrying an import.'); const reason = operationReason(req);
  await TypeORM.getConnection().query("UPDATE vjudge_v2_import_item SET state='retrying',error_code=NULL,error_message=NULL,updated_at=UTC_TIMESTAMP(3) WHERE job_id=? AND state='failed' AND attempts<3", [req.params.id]); await TypeORM.getConnection().query("UPDATE vjudge_v2_import_job SET state='queued',stage='retrying',cancel_requested=0,error_json=NULL,failures_json=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [req.params.id]); const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'vjudge:import.retry', resourceType: 'vjudge_import', resourceId: req.params.id, reason }); setImmediate(() => runImportJob(req.params.id)); return api().send(res, { id: req.params.id, state: 'queued', stage: 'retrying', audit_event_id: auditEventId }, 202);
});

app.post('/api/v2/vjudge/imports/:id/approve', async (req, res) => {
  const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const rows = await TypeORM.getConnection().query("SELECT * FROM vjudge_v2_import_job WHERE id=? AND state='paused' AND stage='awaiting_approval' LIMIT 1", [req.params.id]); if (!rows.length) return api().fail(res, 409, 'JOB_NOT_AWAITING_APPROVAL', 'The import is not awaiting approval.'); if (Number(rows[0].actor_id) !== Number(user.id) && !await can(user, 'admin:job.manage')) return api().fail(res, 403, 'JOB_FORBIDDEN', 'You cannot approve this import job.'); if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again or complete MFA before approving an import.'); const reason = operationReason(req);
  const options = safeJson(rows[0].options_json, {}); options.preview_only = false; await TypeORM.getConnection().query("UPDATE vjudge_v2_import_job SET state='queued',stage='approved',options_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [JSON.stringify(options), req.params.id]); const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'vjudge:import.approve', resourceType: 'vjudge_import', resourceId: req.params.id, reason }); setImmediate(() => runImportJob(req.params.id)); return api().send(res, { id: req.params.id, state: 'queued', stage: 'approved', audit_event_id: auditEventId }, 202);
});

app.get('/api/v2/vjudge/imports/:id/events', async (req, res) => {
  const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const rows = await TypeORM.getConnection().query('SELECT actor_id FROM vjudge_v2_import_job WHERE id=? LIMIT 1', [req.params.id]); if (!rows.length) return api().fail(res, 404, 'VJUDGE_IMPORT_NOT_FOUND', 'Import job was not found.'); if (Number(rows[0].actor_id) !== Number(user.id) && !await can(user, 'admin:job.manage')) return api().fail(res, 403, 'JOB_FORBIDDEN', 'You cannot view this import stream.');
  return api().sse(req, res, `vjudge-import:${req.params.id}`);
});

async function persistSubmissionSync(sync) {
  await Promise.all([ensureVjudgeV2Schema(), api().ensureFoundationSchema()]);
  const connection = TypeORM.getConnection();
  const stored = await connection.transaction(async manager => {
    const rows = await manager.query('SELECT * FROM vjudge_v2_submission_sync WHERE local_submission_id=? LIMIT 1 FOR UPDATE', [sync.local_submission_id]);
    const previous = rows[0] || null;
    if (!vjudgeRemoteSubmission.hasChanged(previous, sync)) {
      return { changed: false, event: null, updatedAt: api().databaseIso(previous.updated_at) };
    }
    await manager.query(`INSERT INTO vjudge_v2_submission_sync
      (local_submission_id,provider,upstream_task_id,remote_problem_id,phase,local_status,marker_hash,updated_at)
      VALUES (?,?,?,?,?,?,?,UTC_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE provider=VALUES(provider),upstream_task_id=VALUES(upstream_task_id),
        remote_problem_id=VALUES(remote_problem_id),phase=VALUES(phase),local_status=VALUES(local_status),
        marker_hash=VALUES(marker_hash),updated_at=UTC_TIMESTAMP(3)`, [
      sync.local_submission_id, sync.provider, sync.upstream_task_id, sync.remote_problem_id,
      sync.phase, sync.local_status, sync.marker_hash
    ]);
    const payload = vjudgeRemoteSubmission.publicSync(sync);
    const eventResult = await manager.query(
      'INSERT INTO api_v2_event (stream,type,aggregate_id,actor_id,payload_json,created_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))',
      [`submission:${sync.local_submission_id}`, vjudgeRemoteSubmission.eventType(sync), String(sync.local_submission_id), null, JSON.stringify(payload)]
    );
    const createdAt = new Date().toISOString();
    return {
      changed: true,
      updatedAt: createdAt,
      event: {
        id: String(eventResult.insertId), stream: `submission:${sync.local_submission_id}`,
        type: vjudgeRemoteSubmission.eventType(sync), aggregate_id: String(sync.local_submission_id),
        actor_id: null, payload, created_at: createdAt
      }
    };
  });
  if (stored.event) api().publishEvent(stored.event);
  return stored;
}

app.get('/api/v2/vjudge/submissions/:id/sync', async (req, res) => {
  const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const judge = await JudgeState.findById(Number(req.params.id)); if (!judge) return api().fail(res, 404, 'SUBMISSION_NOT_FOUND', 'Submission was not found.'); if (Number(judge.user_id) !== Number(user.id) && !await can(user, 'judge:read')) return api().fail(res, 403, 'SUBMISSION_FORBIDDEN', 'You cannot view this remote submission.');
  const result = safeJson(judge.result, {}); const marker = result && result.vjudge || null; const problem = await Problem.findById(judge.problem_id);
  const sync = vjudgeRemoteSubmission.snapshot(judge, problem, marker);
  if (!sync) return api().fail(res, 409, 'VJUDGE_SUBMISSION_REQUIRED', 'The submission is not associated with a supported VJudge provider.');
  const persisted = await persistSubmissionSync(sync);
  return api().send(res, { ...vjudgeRemoteSubmission.publicSync(sync, persisted.updatedAt), changed: persisted.changed, sync_event_id: persisted.event ? persisted.event.id : null });
});

syzoj.utils.vjudgeV2 = { ensureSchema: ensureVjudgeV2Schema, runImportJob, providerOperation };

async function recoverVjudgeImportJobs() {
  await ensureVjudgeV2Schema();
  const connection = TypeORM.getConnection();
  const interrupted = await connection.query("SELECT id,state,cancel_requested FROM vjudge_v2_import_job WHERE state IN ('running','cancelling') ORDER BY created_at ASC");
  for (const job of interrupted) {
    const action = vjudgeJobRecovery.recoveryAction(job);
    if (!action) continue;
    if (action.state === 'cancelled') {
      await connection.query("UPDATE vjudge_v2_import_job SET state='cancelled',stage='cancelled',current_remote_id=NULL,cancelled_at=COALESCE(cancelled_at,UTC_TIMESTAMP(3)),updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state IN ('running','cancelling') AND cancel_requested=1", [job.id]);
    } else {
      await connection.query("UPDATE vjudge_v2_import_job SET state='queued',stage='recovering',current_remote_id=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state IN ('running','cancelling') AND cancel_requested=0", [job.id]);
    }
  }
  setTimeout(async () => {
    const rows = await connection.query("SELECT id FROM vjudge_v2_import_job WHERE state='queued' AND cancel_requested=0 ORDER BY created_at ASC LIMIT 10");
    rows.forEach(row => setImmediate(() => runImportJob(row.id)));
  }, 5000);
}

syzoj.utils.vjudgeV2.recoverImportJobs = recoverVjudgeImportJobs;

recoverVjudgeImportJobs().catch(error => syzoj.log(`[vjudge-v2] schema initialization failed: ${error.stack || error.message}`));
