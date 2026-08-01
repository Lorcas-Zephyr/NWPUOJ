const crypto = require('crypto');
const fs = require('fs-extra');
const multer = require('multer');
const os = require('os');
const path = require('path');
const TypeORM = require('typeorm');
const contentDomain = require('../libs/content-domain');
const problemDomain = require('../libs/problem-domain');
const bulkAction = require('../libs/problem-bulk-action');
const testdataUpload = require('../libs/testdata-upload');
const Problem = syzoj.model('problem');
const User = syzoj.model('user');
const TAG_TYPE_COLORS = Object.freeze({
  source: 'pink',
  category: 'teal',
  algorithm: 'violet',
  problem_type: 'olive',
  difficulty: 'orange'
});
let schemaPromise = null;
const testdataUploadMiddleware = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => callback(/\.zip$/i.test(String(file.originalname || '')) ? null : Object.assign(new Error('Only ZIP archives are supported.'), { code: 'TESTDATA_UPLOAD_INVALID' }), /\.zip$/i.test(String(file.originalname || '')))
}).single('archive');
const testdataFilesMiddleware = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: Number(syzoj.config.limit && syzoj.config.limit.testdata || 200 * 1024 * 1024),
    files: Math.min(1000, Number(syzoj.config.limit && syzoj.config.limit.testdata_filecount || 100))
  },
  fileFilter: (_req, file, callback) => {
    try {
      testdataFilename(file.originalname);
      callback(null, true);
    } catch (error) {
      callback(error);
    }
  }
}).array('files');
const additionalFileMiddleware = multer({
  dest: os.tmpdir(),
  limits: { fileSize: Number(syzoj.config.limit && syzoj.config.limit.data_size || 200 * 1024 * 1024), files: 1 },
  fileFilter: (_req, file, callback) => callback(/\.zip$/i.test(String(file.originalname || '')) ? null : Object.assign(new Error('Only ZIP archives are supported.'), { code: 'TESTDATA_UPLOAD_INVALID' }), /\.zip$/i.test(String(file.originalname || '')))
}).single('archive');
function testdataUploadRoot() { return path.join(syzoj.config.upload_dir, 'testdata-upload'); }
function testdataFilename(value) {
  const filename = String(value || '');
  if (
    !filename || filename === '.' || filename === '..' || filename.includes('\0') ||
    filename !== path.posix.basename(filename) || filename !== path.win32.basename(filename) ||
    Buffer.byteLength(filename, 'utf8') > 255
  ) {
    const error = new Error('Testdata filename is invalid.');
    error.code = 'VALIDATION_FAILED';
    error.statusCode = 422;
    error.fields = { filename: 'a single filename of at most 255 UTF-8 bytes is required' };
    throw error;
  }
  return filename;
}
async function ensureProblemWorkflowSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = TypeORM.getConnection().query(`CREATE TABLE IF NOT EXISTS problem_v2_job (
    id CHAR(36) NOT NULL PRIMARY KEY, problem_id INT NOT NULL, kind VARCHAR(32) NOT NULL,
    state VARCHAR(24) NOT NULL, progress TINYINT UNSIGNED NOT NULL DEFAULT 0,
    input_json LONGTEXT NULL, result_json LONGTEXT NULL, error_json LONGTEXT NULL, actor_id INT NOT NULL,
    cancel_requested TINYINT(1) NOT NULL DEFAULT 0, created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL, KEY idx_problem_v2_job_problem(problem_id,created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).then(async () => {
    const columns = await TypeORM.getConnection().query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='problem_v2_job'");
    if (!columns.some(row => row.COLUMN_NAME === 'input_json')) await TypeORM.getConnection().query('ALTER TABLE problem_v2_job ADD COLUMN input_json LONGTEXT NULL AFTER progress');
    const tagColumns = await TypeORM.getConnection().query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='problem_tag'");
    if (!tagColumns.some(row => row.COLUMN_NAME === 'category')) {
      await TypeORM.getConnection().query('ALTER TABLE problem_tag ADD COLUMN category VARCHAR(32) NULL AFTER color');
    }
    await TypeORM.getConnection().query(`UPDATE problem_tag SET category=CASE
      WHEN color='pink' THEN 'source'
      WHEN color='teal' THEN 'category'
      WHEN color='olive' THEN 'problem_type'
      WHEN color IN ('red','orange','yellow','green','blue','purple','black') OR name='暂无评定' THEN 'difficulty'
      ELSE 'algorithm' END
      WHERE category IS NULL OR category NOT IN ('source','category','algorithm','problem_type','difficulty')`);
  }).catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}
function api() { return syzoj.utils.apiV2; }
async function can(user, capability, problem) { return !!(user && await syzoj.utils.authorizationV2.authorize(user, capability, problem ? { ownerId: problem.user_id, scope: `problem:${problem.id}` } : null, problem ? { scope: `problem:${problem.id}` } : {})); }
function jobPayload(row) { const input = row.input_json ? JSON.parse(row.input_json) : {}; const result = row.result_json ? JSON.parse(row.result_json) : null; return { id: row.id, problem_id: row.kind === 'bulk_archive' ? null : Number(row.problem_id), kind: row.kind === 'bulk_archive' ? 'problem_bulk_action' : row.kind, subtype: row.kind === 'bulk_archive' ? input.action : row.kind, state: row.state, progress: Number(row.progress), impact: row.kind === 'bulk_archive' ? { problem_ids: input.problem_ids || [] } : { problem_id: Number(row.problem_id) }, result, error: row.error_json ? JSON.parse(row.error_json) : null, created_at: api().databaseIso(row.created_at), updated_at: api().databaseIso(row.updated_at) }; }
function testdataSummary(parsed) {
  const subtasks = Array.isArray(parsed)
    ? parsed
    : parsed && Array.isArray(parsed.testcases) ? parsed.testcases : [];
  return {
    valid: !!parsed && !parsed.error,
    testcases: subtasks.reduce((count, subtask) => count + (Array.isArray(subtask && subtask.cases) ? subtask.cases.length : 0), 0),
    special_judge: !!(parsed && parsed.spj),
    error: parsed && parsed.error ? String(parsed.error) : null
  };
}
async function contentTransaction(work) { await api().ensureFoundationSchema(); return TypeORM.getConnection().transaction(work); }
function contentFailure(res, error) { const expected = Number.isInteger(error.statusCode); return api().fail(res, expected ? error.statusCode : 500, expected ? error.code : 'CONTENT_WRITE_FAILED', expected ? error.message : 'The content operation could not be completed.', expected ? error.fields || {} : {}); }
function auditRecorder(req) { return (event, manager) => syzoj.utils.authorizationV2.recordAudit(req, event, manager); }
function serializeSolution(row) { return { id: Number(row.id), problem_id: Number(row.problem_id), title: row.title, content: row.content, author: row.username == null ? { id: Number(row.user_id) } : { id: Number(row.user_id), username: row.username }, status: contentDomain.apiSolutionStatus(row.status), allow_comment: !!row.allow_comment, reject_reason: Number(row.user_id) === Number(row.viewer_id) || row.can_review ? row.reject_reason || null : undefined, published_at: time(row.public_time), updated_at: time(row.update_time) }; }
function solutionRevision(row) { return { id: Number(row.id), title: row.title, content: row.content, status: contentDomain.apiSolutionStatus(row.status), allow_comment: !!row.allow_comment, updated_at: time(row.update_time) }; }
async function visibleSolution(user, value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const rows = await TypeORM.getConnection().query(
    `SELECT solution.*,u.username,problem.user_id AS problem_user_id,problem.is_public AS problem_is_public
       FROM problem_solution solution
       LEFT JOIN user u ON u.id=solution.user_id
       INNER JOIN problem ON problem.id=solution.problem_id
      WHERE solution.id=? LIMIT 1`,
    [id]
  );
  if (!rows.length) return null;
  const row = rows[0];
  const reviewer = await can(user, 'solution:moderate');
  const canUseProblem = !!row.problem_is_public || reviewer || await can(user, 'problem:edit', { id: row.problem_id, user_id: row.problem_user_id });
  if (!canUseProblem || (row.status !== 'accepted' && !reviewer && (!user || Number(row.user_id) !== Number(user.id)))) return null;
  row.viewer_id = user && user.id;
  row.can_review = reviewer;
  return { row, reviewer };
}

async function updateBulkJob(connection, id, state, result) {
  const processed = Number(result.processed || 0);
  const total = Number(result.total || 0);
  const guard = state === 'running' ? ' AND cancel_requested=0' : '';
  await connection.query(`UPDATE problem_v2_job SET state=?,progress=?,result_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?${guard}`, [state, bulkAction.progress(total, processed), JSON.stringify(result), id]);
}

async function runBulkArchiveJob(jobId) {
  const connection = TypeORM.getConnection();
  let result = null;
  try {
    const rows = await connection.query('SELECT * FROM problem_v2_job WHERE id=? LIMIT 1', [jobId]);
    if (!rows.length) return;
    const job = rows[0];
    const input = bulkAction.normalize(job.input_json ? JSON.parse(job.input_json) : {});
    result = { action: input.action, total: input.problem_ids.length, processed: 0, archived: 0, skipped: 0, failed: 0, failures: [], audit_event_id: input.audit_event_id || null };
    if (job.cancel_requested) { await updateBulkJob(connection, jobId, 'cancelled', result); await api().appendEvent({ stream: `problem-job:${jobId}`, type: 'problem.bulk.cancelled', aggregateId: jobId, payload: result }); return; }
    const actor = await User.findById(Number(job.actor_id));
    if (!actor) throw Object.assign(new Error('The job creator no longer exists.'), { code: 'ACTOR_NOT_FOUND' });
    await syzoj.utils.problemV2.ensureSchema();
    await connection.query("UPDATE problem_v2_job SET state='running',progress=0,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
    for (const problemId of input.problem_ids) {
      const control = await connection.query('SELECT cancel_requested FROM problem_v2_job WHERE id=? LIMIT 1', [jobId]);
      if (!control.length || control[0].cancel_requested) {
        await updateBulkJob(connection, jobId, 'cancelled', result);
        await api().appendEvent({ stream: `problem-job:${jobId}`, type: 'problem.bulk.cancelled', aggregateId: jobId, payload: result });
        return;
      }
      result.current_problem_id = problemId;
      try {
        const problem = await Problem.findById(problemId);
        if (!problem) throw Object.assign(new Error('Problem was not found.'), { code: 'PROBLEM_NOT_FOUND' });
        if (!await can(actor, 'problem:archive', problem)) throw Object.assign(new Error('The current authorization no longer permits this archive.'), { code: 'CAPABILITY_REQUIRED' });
        const changed = await connection.transaction(async manager => {
          const states = await manager.query('SELECT lifecycle_status FROM problem_v2_state WHERE problem_id=? FOR UPDATE', [problem.id]);
          if (states[0] && states[0].lifecycle_status === 'archived') return false;
          await manager.query(`INSERT INTO problem_v2_state (problem_id,lifecycle_status,current_version_id,current_snapshot_id,archived_at,updated_at)
            VALUES (?,'archived',NULL,NULL,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))
            ON DUPLICATE KEY UPDATE lifecycle_status='archived',archived_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3)`, [problem.id]);
          await manager.query('UPDATE problem SET is_public=0 WHERE id=?', [problem.id]);
          return true;
        });
        if (changed) {
          result.archived++;
          await api().appendEvent({ stream: `problem:${problem.id}`, type: 'problem.archived', aggregateId: problem.id, actor, payload: { bulk: true, job_id: jobId, audit_event_id: result.audit_event_id } });
        } else result.skipped++;
      } catch (error) {
        result.failed++;
        if (result.failures.length < 50) result.failures.push({ problem_id: problemId, code: error.code || 'PROBLEM_BULK_ARCHIVE_FAILED' });
      }
      result.processed++;
      await updateBulkJob(connection, jobId, 'running', result);
    }
    const finalControl = await connection.query('SELECT cancel_requested FROM problem_v2_job WHERE id=? LIMIT 1', [jobId]);
    if (!finalControl.length || finalControl[0].cancel_requested) { await updateBulkJob(connection, jobId, 'cancelled', result); await api().appendEvent({ stream: `problem-job:${jobId}`, type: 'problem.bulk.cancelled', aggregateId: jobId, actor, payload: result }); return; }
    const state = result.failed === result.total ? 'failed' : 'completed';
    await updateBulkJob(connection, jobId, state, result);
    await api().appendEvent({ stream: `problem-job:${jobId}`, type: state === 'completed' ? 'problem.bulk.completed' : 'problem.bulk.failed', aggregateId: jobId, actor, payload: result });
  } catch (error) {
    const failure = { code: error.code || 'PROBLEM_BULK_ARCHIVE_FAILED', message: error.message };
    await connection.query("UPDATE problem_v2_job SET state='failed',error_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [JSON.stringify(failure), jobId]);
    await api().appendEvent({ stream: `problem-job:${jobId}`, type: 'problem.bulk.failed', aggregateId: jobId, payload: failure });
  }
}

async function runValidationJob(jobId, problem) {
  const connection = TypeORM.getConnection();
  try {
    const rows = await connection.query('SELECT cancel_requested FROM problem_v2_job WHERE id=? LIMIT 1', [jobId]); if (!rows.length || rows[0].cancel_requested) return connection.query("UPDATE problem_v2_job SET state='cancelled',updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
    await connection.query("UPDATE problem_v2_job SET state='running',progress=20,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
    const parsed = await syzoj.utils.parseTestdata(problem.getTestdataPath(), problem.type === 'submit-answer');
    const controls = await connection.query('SELECT cancel_requested FROM problem_v2_job WHERE id=? LIMIT 1', [jobId]);
    if (!controls.length || controls[0].cancel_requested) {
      await connection.query("UPDATE problem_v2_job SET state='cancelled',updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
      return;
    }
    const result = testdataSummary(parsed);
    await connection.query("UPDATE problem_v2_job SET state='completed',progress=100,result_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [JSON.stringify(result), jobId]);
    await api().appendEvent({ stream: `problem-job:${jobId}`, type: 'problem.testdata.validated', aggregateId: jobId, payload: result });
  } catch (error) {
    await connection.query("UPDATE problem_v2_job SET state='failed',error_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [JSON.stringify({ code: 'TESTDATA_VALIDATION_FAILED', message: error.message }), jobId]);
    await api().appendEvent({ stream: `problem-job:${jobId}`, type: 'problem.testdata.failed', aggregateId: jobId, payload: { message: error.message } });
  }
}

async function runUploadJob(jobId, problem) {
  const connection = TypeORM.getConnection();
  let archive = null;
  let staging = null;
  try {
    const rows = await connection.query('SELECT cancel_requested,input_json,actor_id FROM problem_v2_job WHERE id=? LIMIT 1', [jobId]);
    if (!rows.length || rows[0].cancel_requested) return connection.query("UPDATE problem_v2_job SET state='cancelled',updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
    const input = rows[0].input_json ? JSON.parse(rows[0].input_json) : {};
    if (!/^[0-9a-f-]{36}\.zip$/.test(String(input.archive || ''))) throw Object.assign(new Error('Upload payload is invalid.'), { code: 'TESTDATA_UPLOAD_INVALID', statusCode: 422 });
    archive = path.join(testdataUploadRoot(), input.archive);
    staging = path.join(testdataUploadRoot(), `${jobId}.staging`);
    await connection.query("UPDATE problem_v2_job SET state='running',progress=10,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
    await fs.remove(staging); await fs.ensureDir(staging);
    await testdataUpload.extractTestdataArchive(archive, staging);
    const parsed = await syzoj.utils.parseTestdata(staging, problem.type === 'submit-answer');
    if (!parsed || parsed.error) throw Object.assign(new Error('The archive does not contain valid judge testdata.'), { code: 'TESTDATA_UPLOAD_INVALID', statusCode: 422 });
    const controls = await connection.query('SELECT cancel_requested FROM problem_v2_job WHERE id=? LIMIT 1', [jobId]);
    if (!controls.length || controls[0].cancel_requested) return connection.query("UPDATE problem_v2_job SET state='cancelled',updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
    await connection.query("UPDATE problem_v2_job SET progress=70,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
    await testdataUpload.replaceDirectory(problem.getTestdataPath(), staging, path.join(testdataUploadRoot(), `${jobId}.backup`));
    await fs.move(archive, problem.getTestdataArchivePath(), { overwrite: true }); archive = null;
    const result = testdataSummary(parsed);
    const snapshot = await syzoj.utils.problemV2.refreshCurrentTestdataSnapshot(problem, Number(rows[0].actor_id));
    result.snapshot_id = snapshot.snapshot_id;
    await connection.query("UPDATE problem_v2_job SET state='completed',progress=100,result_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [JSON.stringify(result), jobId]);
    await api().appendEvent({ stream: `problem-job:${jobId}`, type: 'problem.testdata.uploaded', aggregateId: jobId, payload: result });
  } catch (error) {
    await connection.query("UPDATE problem_v2_job SET state='failed',error_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [JSON.stringify({ code: error.code || 'TESTDATA_VALIDATION_FAILED', message: error.message }), jobId]);
    await api().appendEvent({ stream: `problem-job:${jobId}`, type: 'problem.testdata.failed', aggregateId: jobId, payload: { code: error.code || 'TESTDATA_VALIDATION_FAILED' } });
  } finally {
    if (archive) await fs.remove(archive).catch(() => {});
    if (staging) await fs.remove(staging).catch(() => {});
  }
}

async function queueBulkArchive(req, user, value) {
  const input = bulkAction.normalize(value);
  for (const problemId of input.problem_ids) {
    const problem = await Problem.findById(problemId);
    if (!problem) throw Object.assign(new Error(`Problem #${problemId} was not found.`), { code: 'PROBLEM_NOT_FOUND', statusCode: 404 });
    if (!await can(user, 'problem:archive', problem)) throw Object.assign(new Error(`Capability required: problem:archive for problem #${problemId}.`), { code: 'CAPABILITY_REQUIRED', statusCode: 403 });
  }
  await ensureProblemWorkflowSchema();
  const id = crypto.randomUUID();
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
    action: 'problem:bulk.archive', resourceType: 'problem_batch', resourceId: id, scope: 'global',
    details: { problem_ids: input.problem_ids, count: input.problem_ids.length }
  });
  const payload = { ...input, audit_event_id: auditEventId };
  await TypeORM.getConnection().query("INSERT INTO problem_v2_job (id,problem_id,kind,state,progress,input_json,actor_id,created_at,updated_at) VALUES (?,0,'bulk_archive','queued',0,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [id, JSON.stringify(payload), user.id]);
  await api().appendEvent({ stream: `problem-job:${id}`, type: 'problem.bulk.queued', aggregateId: id, actor: user, payload: { action: input.action, problem_ids: input.problem_ids, audit_event_id: auditEventId } });
  setImmediate(() => runBulkArchiveJob(id));
  return { id, input, auditEventId };
}

app.post(['/api/v2/problems/:id/testdata-jobs', '/api/v2/problems/:id/testdata/validate'], async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const problem = await Problem.findById(Number(req.params.id)); if (!problem) return api().fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.'); if (!await can(user, 'problem:testdata.write', problem)) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: problem:testdata.write.'); const kind = String(req.body && req.body.kind || 'validate'); if (kind !== 'validate') return api().fail(res, 422, 'VALIDATION_FAILED', 'Only testdata validation jobs are accepted by this JSON endpoint.', { kind: 'unsupported' }); await ensureProblemWorkflowSchema(); const id = crypto.randomUUID(); await TypeORM.getConnection().query("INSERT INTO problem_v2_job (id,problem_id,kind,state,progress,actor_id,created_at,updated_at) VALUES (?,?,'validate','queued',0,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [id, problem.id, user.id]); await api().appendEvent({ stream: `problem-job:${id}`, type: 'problem.testdata.queued', aggregateId: id, actor: user, payload: { problem_id: Number(problem.id) } }); setImmediate(() => runValidationJob(id, problem)); return api().send(res, { id, problem_id: Number(problem.id), kind, state: 'queued', progress: 0 }, 202); });
async function requireTestdataWriter(req, res, next) { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const problem = await Problem.findById(Number(req.params.id)); if (!problem) return api().fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.'); if (!await can(user, 'problem:testdata.write', problem)) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: problem:testdata.write.'); res.locals.testdataUploadProblem = problem; return next(); }
function judgeConfigResource(row) {
  return {
    problem_id: Number(row.id),
    type: row.type,
    time_limit: Number(row.time_limit || 0),
    memory_limit: Number(row.memory_limit || 0),
    file_io: !!row.file_io,
    file_io_input_name: row.file_io_input_name || '',
    file_io_output_name: row.file_io_output_name || ''
  };
}
function judgeConfigFilename(value, field) {
  const filename = String(value || '').trim();
  if (!filename || filename.includes('\0') || filename !== path.posix.basename(filename) || filename !== path.win32.basename(filename) || Buffer.byteLength(filename, 'utf8') > 255) {
    const error = new Error(field + ' is invalid.');
    error.code = 'VALIDATION_FAILED';
    error.statusCode = 422;
    error.fields = { [field]: 'a single filename of at most 255 UTF-8 bytes is required' };
    throw error;
  }
  return filename;
}
app.get('/api/v2/problems/:id/judge-configuration', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  const problem = await Problem.findById(Number(req.params.id));
  if (!problem) return api().fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
  if (!await can(user, 'problem:edit', problem)) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: problem:edit.');
  const rows = await TypeORM.getConnection().query('SELECT id,type,time_limit,memory_limit,file_io,file_io_input_name,file_io_output_name FROM problem WHERE id=? LIMIT 1', [problem.id]);
  return api().send(res, judgeConfigResource(rows[0]));
});
app.patch('/api/v2/problems/:id/judge-configuration', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  const problem = await Problem.findById(Number(req.params.id));
  if (!problem) return api().fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
  if (!await can(user, 'problem:edit', problem)) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: problem:edit.');
  try {
    const result = await contentTransaction(async manager => {
      const rows = await manager.query('SELECT id,type,time_limit,memory_limit,file_io,file_io_input_name,file_io_output_name FROM problem WHERE id=? LIMIT 1 FOR UPDATE', [problem.id]);
      if (!rows.length) throw Object.assign(new Error('Problem was not found.'), { code: 'PROBLEM_NOT_FOUND', statusCode: 404 });
      const current = judgeConfigResource(rows[0]);
      if (!api().ifMatch(req, current)) throw Object.assign(new Error('The judge configuration changed. Refresh it and try again.'), { code: 'ETAG_MISMATCH', statusCode: 412 });
      const type = String(req.body && req.body.type || '');
      if (!['traditional', 'interaction', 'submit-answer'].includes(type)) throw Object.assign(new Error('Problem type is invalid.'), { code: 'VALIDATION_FAILED', statusCode: 422, fields: { type: 'unsupported type' } });
      if ((current.type === 'submit-answer') !== (type === 'submit-answer')) {
        const counts = await manager.query('SELECT COUNT(*) AS total FROM judge_state WHERE problem_id=?', [problem.id]);
        if (Number(counts[0] && counts[0].total || 0) > 0) throw Object.assign(new Error('A problem with submissions cannot switch to or from submit-answer mode.'), { code: 'PROBLEM_TYPE_LOCKED', statusCode: 409 });
      }
      const timeLimit = type === 'submit-answer' ? current.time_limit : Number(req.body && req.body.time_limit);
      const memoryLimit = type === 'submit-answer' ? current.memory_limit : Number(req.body && req.body.memory_limit);
      const maximumTime = Number(syzoj.config.limit && syzoj.config.limit.time_limit || 86400000);
      const maximumMemory = Number(syzoj.config.limit && syzoj.config.limit.memory_limit || 1048576);
      if (type !== 'submit-answer' && (!Number.isSafeInteger(timeLimit) || timeLimit < 1 || timeLimit > maximumTime)) throw Object.assign(new Error('Time limit is invalid.'), { code: 'VALIDATION_FAILED', statusCode: 422, fields: { time_limit: 'out of range' } });
      if (type !== 'submit-answer' && (!Number.isSafeInteger(memoryLimit) || memoryLimit < 1 || memoryLimit > maximumMemory)) throw Object.assign(new Error('Memory limit is invalid.'), { code: 'VALIDATION_FAILED', statusCode: 422, fields: { memory_limit: 'out of range' } });
      const fileIo = type === 'traditional' && !!(req.body && req.body.file_io);
      const inputName = fileIo ? judgeConfigFilename(req.body.file_io_input_name, 'file_io_input_name') : current.file_io_input_name;
      const outputName = fileIo ? judgeConfigFilename(req.body.file_io_output_name, 'file_io_output_name') : current.file_io_output_name;
      const saved = { problem_id: Number(problem.id), type, time_limit: timeLimit, memory_limit: memoryLimit, file_io: fileIo, file_io_input_name: inputName, file_io_output_name: outputName };
      const projection = await problemDomain.updateJudgeConfigurationAggregate(manager, problem, saved, user.id);
      const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'problem:judge-configuration.update', resourceType: 'problem', resourceId: Number(problem.id), scope: `problem:${problem.id}`, details: saved }, manager);
      const eventId = await contentDomain.appendEvent(manager, { stream: `problem:${problem.id}`, type: 'problem.judge-configuration.updated', aggregateId: problem.id, actorId: user.id, payload: { ...saved, audit_event_id: auditEventId } });
      return { ...saved, version_id: projection.version_id, snapshot_id: projection.snapshot_id, audit_event_id: auditEventId, event_id: eventId };
    });
    return api().send(res, result);
  } catch (error) { return contentFailure(res, error); }
});
app.post('/api/v2/problems/:id/testdata/upload', requireTestdataWriter, (req, res, next) => testdataUploadMiddleware(req, res, error => { if (error) return api().fail(res, error.code === 'LIMIT_FILE_SIZE' ? 413 : 422, error.code === 'LIMIT_FILE_SIZE' ? 'SOURCE_TOO_LARGE' : 'TESTDATA_UPLOAD_INVALID', error.message); next(); }), async (req, res) => { const user = res.locals.user; const problem = res.locals.testdataUploadProblem; if (!req.file) return api().fail(res, 422, 'TESTDATA_UPLOAD_INVALID', 'A ZIP archive is required.', { archive: 'required' }); await ensureProblemWorkflowSchema(); const id = crypto.randomUUID(); const archive = `${id}.zip`; try { await fs.ensureDir(testdataUploadRoot()); await fs.move(req.file.path, path.join(testdataUploadRoot(), archive), { overwrite: false }); await TypeORM.getConnection().query("INSERT INTO problem_v2_job (id,problem_id,kind,state,progress,input_json,actor_id,created_at,updated_at) VALUES (?,?,'upload','queued',0,?, ?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [id, problem.id, JSON.stringify({ archive }), user.id]); await api().appendEvent({ stream: `problem-job:${id}`, type: 'problem.testdata.upload.queued', aggregateId: id, actor: user, payload: { problem_id: Number(problem.id) } }); setImmediate(() => runUploadJob(id, problem)); return api().send(res, { id, problem_id: Number(problem.id), kind: 'upload', state: 'queued', progress: 0 }, 202); } catch (error) { if (req.file && req.file.path) await fs.remove(req.file.path).catch(() => {}); return api().fail(res, error.statusCode || 500, error.code || 'CONTENT_WRITE_FAILED', error.message); } });
app.post('/api/v2/problems/:id/testdata/files', requireTestdataWriter, (req, res, next) => testdataFilesMiddleware(req, res, error => {
  if (!error) return next();
  const tooLarge = error.code === 'LIMIT_FILE_SIZE';
  return api().fail(res, tooLarge ? 413 : 422, tooLarge ? 'SOURCE_TOO_LARGE' : 'TESTDATA_UPLOAD_INVALID', error.message);
}), async (req, res) => {
  const user = res.locals.user;
  const problem = res.locals.testdataUploadProblem;
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) return api().fail(res, 422, 'TESTDATA_UPLOAD_INVALID', 'At least one testdata file is required.', { files: 'required' });
  try {
    const unrestricted = await user.hasPrivilege('manage_problem');
    const uploaded = [];
    for (const file of files) {
      const filename = testdataFilename(file.originalname);
      await problem.uploadTestdataSingleFile(filename, file.path, file.size, unrestricted);
      uploaded.push(filename);
    }
    let summary;
    try {
      summary = testdataSummary(await syzoj.utils.parseTestdata(problem.getTestdataPath(), problem.type === 'submit-answer'));
    } catch (error) {
      summary = { valid: false, testcases: 0, special_judge: false, error: error.message || 'Testdata parsing failed.' };
    }
    const snapshot = summary.valid
      ? await syzoj.utils.problemV2.refreshCurrentTestdataSnapshot(problem, user.id)
      : null;
    const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
      action: 'problem:testdata.files.upload',
      resourceType: 'problem',
      resourceId: Number(problem.id),
      scope: `problem:${problem.id}`,
      details: { filenames: uploaded }
    });
    const event = await api().appendEvent({
      stream: `problem:${problem.id}`,
      type: 'problem.testdata.files.uploaded',
      aggregateId: problem.id,
      actor: user,
      payload: { filenames: uploaded, audit_event_id: auditEventId }
    });
    return api().send(res, { problem_id: Number(problem.id), filenames: uploaded, testdata: summary, snapshot_id: snapshot && snapshot.snapshot_id || null, audit_event_id: auditEventId, event_id: String(event.id) }, 201);
  } catch (error) {
    return api().fail(res, error.statusCode || 500, error.code || 'CONTENT_WRITE_FAILED', error.message || 'Testdata upload failed.', error.fields || {});
  } finally {
    await Promise.all(files.map(file => fs.remove(file.path).catch(() => {})));
  }
});
app.post('/api/v2/problems/:id/additional-file', requireTestdataWriter, (req, res, next) => additionalFileMiddleware(req, res, error => {
  if (!error) return next();
  const tooLarge = error.code === 'LIMIT_FILE_SIZE';
  return api().fail(res, tooLarge ? 413 : 422, tooLarge ? 'SOURCE_TOO_LARGE' : 'TESTDATA_UPLOAD_INVALID', error.message);
}), async (req, res) => {
  const user = res.locals.user;
  const problem = res.locals.testdataUploadProblem;
  if (!req.file) return api().fail(res, 422, 'TESTDATA_UPLOAD_INVALID', 'A ZIP archive is required.', { archive: 'required' });
  try {
    await problem.updateFile(req.file.path, 'additional_file', await user.hasPrivilege('manage_problem'));
    const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
      action: 'problem:additional-file.upload',
      resourceType: 'problem',
      resourceId: Number(problem.id),
      scope: `problem:${problem.id}`,
      details: { filename: String(req.file.originalname || '') }
    });
    const event = await api().appendEvent({
      stream: `problem:${problem.id}`,
      type: 'problem.additional-file.uploaded',
      aggregateId: problem.id,
      actor: user,
      payload: { audit_event_id: auditEventId }
    });
    return api().send(res, { problem_id: Number(problem.id), uploaded: true, audit_event_id: auditEventId, event_id: String(event.id) }, 201);
  } catch (error) {
    return api().fail(res, error.statusCode || 500, error.code || 'CONTENT_WRITE_FAILED', error.message || 'Additional file upload failed.', error.fields || {});
  } finally {
    await fs.remove(req.file.path).catch(() => {});
  }
});
app.delete('/api/v2/problems/:id/testdata/files/:filename', requireTestdataWriter, async (req, res) => {
  const user = res.locals.user;
  const problem = res.locals.testdataUploadProblem;
  try {
    const filename = testdataFilename(req.params.filename);
    const target = path.resolve(problem.getTestdataPath(), filename);
    const root = path.resolve(problem.getTestdataPath());
    if (path.dirname(target) !== root) {
      return api().fail(res, 422, 'VALIDATION_FAILED', 'Testdata filename is invalid.', {
        filename: 'path segments are not allowed'
      });
    }
    if (!await fs.pathExists(target)) {
      return api().fail(res, 404, 'TESTDATA_FILE_NOT_FOUND', 'Testdata file was not found.');
    }
    await problem.deleteTestdataSingleFile(filename);
    let summary;
    try {
      summary = testdataSummary(await syzoj.utils.parseTestdata(problem.getTestdataPath(), problem.type === 'submit-answer'));
    } catch (error) {
      summary = { valid: false, testcases: 0, special_judge: false, error: error.message || 'Testdata parsing failed.' };
    }
    const snapshot = summary.valid
      ? await syzoj.utils.problemV2.refreshCurrentTestdataSnapshot(problem, user.id)
      : null;
    const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
      action: 'problem:testdata.file.delete',
      resourceType: 'problem_testdata_file',
      resourceId: `${problem.id}:${filename}`,
      scope: `problem:${problem.id}`,
      reason: syzoj.utils.operationReason(req, '删除测试数据文件'),
      details: { problem_id: Number(problem.id), filename }
    });
    const event = await api().appendEvent({
      stream: `problem:${problem.id}`,
      type: 'problem.testdata.file.deleted',
      aggregateId: problem.id,
      actor: user,
      payload: { filename, audit_event_id: auditEventId }
    });
    return api().send(res, {
      problem_id: Number(problem.id),
      filename,
      deleted: true,
      testdata: summary,
      snapshot_id: snapshot && snapshot.snapshot_id || null,
      audit_event_id: auditEventId,
      event_id: String(event.id)
    });
  } catch (error) {
    return api().fail(
      res,
      error.statusCode || 500,
      error.code || 'CONTENT_WRITE_FAILED',
      error.message || 'Testdata file deletion failed.',
      error.fields || {}
    );
  }
});
app.post('/api/v2/problems/bulk-actions', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again before archiving problems.');
  try {
    const queued = await queueBulkArchive(req, user, req.body);
    return api().send(res, { id: queued.id, kind: 'problem_bulk_action', subtype: queued.input.action, state: 'queued', progress: 0, impact: { problem_ids: queued.input.problem_ids }, audit_event_id: queued.auditEventId }, 202);
  } catch (error) { return contentFailure(res, error); }
});
app.patch('/api/v2/problems/:id/solution-settings', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  const problem = await Problem.findById(Number(req.params.id));
  if (!problem) return api().fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
  if (!await can(user, 'problem:edit', problem)) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: problem:edit.');
  const enabled = req.body && req.body.submissions_enabled === true;
  const now = Math.floor(Date.now() / 1000);
  await TypeORM.getConnection().query(
    `INSERT INTO problem_solution_setting (problem_id,disable_submission,updated_at,updated_by)
     VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE disable_submission=VALUES(disable_submission),updated_at=VALUES(updated_at),updated_by=VALUES(updated_by)`,
    [problem.id, enabled ? 0 : 1, now, user.id]
  );
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
    action: 'solution:submission-settings.update', resourceType: 'problem', resourceId: problem.id,
    scope: `problem:${problem.id}`, details: { submissions_enabled: enabled }
  });
  await api().appendEvent({ stream: `problem:${problem.id}`, type: 'solution.submission-settings.updated', aggregateId: problem.id, actor: user, payload: { submissions_enabled: enabled, audit_event_id: auditEventId } });
  return api().send(res, { problem_id: Number(problem.id), submissions_enabled: enabled, audit_event_id: String(auditEventId) });
});
app.get('/api/v2/problem-jobs/:id', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); await ensureProblemWorkflowSchema(); const rows = await TypeORM.getConnection().query('SELECT * FROM problem_v2_job WHERE id=? LIMIT 1', [req.params.id]); if (!rows.length) return api().fail(res, 404, 'JOB_NOT_FOUND', 'Problem job was not found.'); if (Number(rows[0].actor_id) !== Number(user.id) && !await can(user, 'admin:job.manage')) return api().fail(res, 403, 'JOB_FORBIDDEN', 'You cannot view this job.'); return api().send(res, jobPayload(rows[0])); });
app.get('/api/v2/problem-jobs/:id/events', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); await ensureProblemWorkflowSchema(); const rows = await TypeORM.getConnection().query('SELECT actor_id FROM problem_v2_job WHERE id=? LIMIT 1', [req.params.id]); if (!rows.length) return api().fail(res, 404, 'JOB_NOT_FOUND', 'Problem job was not found.'); if (Number(rows[0].actor_id) !== Number(user.id) && !await can(user, 'admin:job.manage')) return api().fail(res, 403, 'JOB_FORBIDDEN', 'You cannot subscribe to this job.'); return api().sse(req, res, `problem-job:${req.params.id}`); });
app.post('/api/v2/problem-jobs/:id/cancel', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); await ensureProblemWorkflowSchema(); const rows = await TypeORM.getConnection().query('SELECT * FROM problem_v2_job WHERE id=? LIMIT 1', [req.params.id]); if (!rows.length) return api().fail(res, 404, 'JOB_NOT_FOUND', 'Problem job was not found.'); if (Number(rows[0].actor_id) !== Number(user.id) && !await can(user, 'admin:job.manage')) return api().fail(res, 403, 'JOB_FORBIDDEN', 'You cannot cancel this job.'); if (['completed', 'failed', 'cancelled'].includes(rows[0].state)) return api().fail(res, 409, 'JOB_TERMINAL', 'The job has already finished.'); await TypeORM.getConnection().query("UPDATE problem_v2_job SET cancel_requested=1,state='cancelling',updated_at=UTC_TIMESTAMP(3) WHERE id=?", [req.params.id]); return api().send(res, { id: req.params.id, state: 'cancelling' }, 202); });

syzoj.utils.problemWorkflowV2 = {
  ensureSchema: ensureProblemWorkflowSchema,
  queueBulkArchive,
  run: async jobId => {
    const rows = await TypeORM.getConnection().query('SELECT problem_id,kind FROM problem_v2_job WHERE id=? LIMIT 1', [jobId]);
    if (!rows.length) throw Object.assign(new Error('Problem job was not found.'), { statusCode: 404 });
    if (rows[0].kind === 'bulk_archive') return runBulkArchiveJob(jobId);
    const problem = await Problem.findById(Number(rows[0].problem_id));
    if (!problem) throw Object.assign(new Error('Problem was not found.'), { statusCode: 404 });
    return rows[0].kind === 'upload' ? runUploadJob(jobId, problem) : runValidationJob(jobId, problem);
  }
};

app.get('/api/v2/tags', async (req, res) => {
  await ensureProblemWorkflowSchema();
  const limit = api().parseLimit(req, 50, 100);
  const cursor = api().decodeCursor(req.query.cursor) || {};
  const params = [];
  const clauses = [];
  if (cursor.name != null) {
    clauses.push('(tag.name>? OR (tag.name=? AND tag.id>?))');
    params.push(String(cursor.name), String(cursor.name), Number(cursor.id || 0));
  }
  params.push(limit + 1);
  const rows = await TypeORM.getConnection().query(`SELECT tag.id,tag.name,tag.color,tag.category,COUNT(map.problem_id) AS problem_count FROM problem_tag tag LEFT JOIN problem_tag_map map ON map.tag_id=tag.id ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} GROUP BY tag.id,tag.name,tag.color,tag.category ORDER BY tag.name ASC,tag.id ASC LIMIT ?`, params);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  res.locals.apiMeta.limit = limit;
  res.locals.apiMeta.next_cursor = more && last ? api().encodeCursor({ name: last.name, id: Number(last.id) }) : null;
  return api().send(res, page.map(tagPayload));
});
function tagError(message, code, statusCode, fields) { return Object.assign(new Error(message), { code: code || 'VALIDATION_FAILED', statusCode: statusCode || 422, fields: fields || {} }); }
function tagPayload(row) { return { id: Number(row.id), name: row.name, category: row.category, color: row.color, problem_count: Number(row.problem_count || 0) }; }
async function loadTag(manager, id, lock) {
  await ensureProblemWorkflowSchema();
  const rows = await manager.query(`SELECT tag.id,tag.name,tag.color,tag.category,
    (SELECT COUNT(*) FROM problem_tag_map map WHERE map.tag_id=tag.id) AS problem_count
    FROM problem_tag tag WHERE tag.id=?${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) return null;
  if (lock) {
    const maps = await manager.query('SELECT problem_id FROM problem_tag_map WHERE tag_id=? FOR UPDATE', [id]);
    rows[0].problem_count = maps.length;
  }
  return tagPayload(rows[0]);
}
function tagInput(body, current) {
  const source = body && typeof body === 'object' ? body : {};
  const name = source.name == null && current ? current.name : String(source.name || '').trim();
  const category = source.category == null && current ? current.category : String(source.category || '').trim();
  const fields = {};
  if (!name || name.length > 255) fields.name = '1-255 characters required';
  if (!Object.prototype.hasOwnProperty.call(TAG_TYPE_COLORS, category)) fields.category = 'a supported tag type is required';
  if (Object.keys(fields).length) throw tagError('The tag is invalid.', 'VALIDATION_FAILED', 422, fields);
  return { name, category, color: TAG_TYPE_COLORS[category] };
}
async function requireTagManager(req, res) { const user = res.locals.user; if (!user) { api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); return null; } if (!await can(user, 'problem:tag.manage')) { api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: problem:tag.manage.'); return null; } return user; }
app.post('/api/v2/tags', async (req, res) => {
  const user = await requireTagManager(req, res); if (!user) return;
  let input; try { input = tagInput(req.body); } catch (error) { return contentFailure(res, error); }
  try {
    await ensureProblemWorkflowSchema();
    const result = await TypeORM.getConnection().query('INSERT INTO problem_tag (name,color,category) VALUES (?,?,?)', [input.name, input.color, input.category]);
    const payload = { id: Number(result.insertId), ...input, problem_count: 0 };
    api().setResourceEtag(res, payload);
    await api().appendEvent({ stream: `problem-tag:${payload.id}`, type: 'problem.tag.created', aggregateId: payload.id, actor: user, payload });
    return api().send(res, payload, 201);
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') return api().fail(res, 409, 'TAG_NAME_CONFLICT', 'A tag with this name already exists.', { name: 'duplicate' });
    return contentFailure(res, error);
  }
});
app.get('/api/v2/tags/:id', async (req, res) => {
  const tag = await loadTag(TypeORM.getConnection(), Number(req.params.id), false);
  if (!tag) return api().fail(res, 404, 'TAG_NOT_FOUND', 'Tag was not found.');
  if (api().apiNotModified(req, res, tag)) return;
  return api().send(res, tag);
});
app.put('/api/v2/tags/:id', async (req, res) => {
  const user = await requireTagManager(req, res); if (!user) return;
  if (!req.get('If-Match')) return api().fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when editing a tag.', { if_match: 'required' });
  try {
    const tag = await TypeORM.getConnection().transaction(async manager => {
      const current = await loadTag(manager, Number(req.params.id), true);
      if (!current) throw tagError('Tag was not found.', 'TAG_NOT_FOUND', 404);
      if (!api().ifMatch(req, current)) throw tagError('Tag changed. Refresh it and try again.', 'ETAG_MISMATCH', 412);
      const input = tagInput(req.body, current);
      await manager.query('UPDATE problem_tag SET name=?,color=?,category=? WHERE id=?', [input.name, input.color, input.category, current.id]);
      return { ...current, ...input };
    });
    api().setResourceEtag(res, tag);
    await api().appendEvent({ stream: `problem-tag:${tag.id}`, type: 'problem.tag.updated', aggregateId: tag.id, actor: user, payload: tag });
    return api().send(res, tag);
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') return api().fail(res, 409, 'TAG_NAME_CONFLICT', 'A tag with this name already exists.', { name: 'duplicate' });
    return contentFailure(res, error);
  }
});
app.delete('/api/v2/tags/:id', async (req, res) => {
  const user = await requireTagManager(req, res); if (!user) return;
  if (!req.get('If-Match')) return api().fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when deleting a tag.', { if_match: 'required' });
  try {
    const tag = await TypeORM.getConnection().transaction(async manager => {
      const current = await loadTag(manager, Number(req.params.id), true);
      if (!current) throw tagError('Tag was not found.', 'TAG_NOT_FOUND', 404);
      if (!api().ifMatch(req, current)) throw tagError('Tag changed. Refresh it and try again.', 'ETAG_MISMATCH', 412);
      if (current.problem_count) throw tagError('Remove this tag from all problems before deleting it.', 'TAG_IN_USE', 409, { problem_count: 'tag is still assigned' });
      await manager.query('DELETE FROM problem_tag WHERE id=?', [current.id]);
      return current;
    });
    await api().appendEvent({ stream: `problem-tag:${tag.id}`, type: 'problem.tag.deleted', aggregateId: tag.id, actor: user, payload: { id: tag.id } });
    return api().send(res, { id: tag.id, deleted: true });
  } catch (error) { return contentFailure(res, error); }
});
app.get('/api/v2/problems/:id/tags', async (req, res) => { const problem = await Problem.findById(Number(req.params.id)); if (!problem) return api().fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.'); const canRead = !!problem.is_public || await can(res.locals.user, 'problem:edit', problem); if (!canRead) return api().fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.'); const rows = await TypeORM.getConnection().query('SELECT tag_id FROM problem_tag_map WHERE problem_id=? ORDER BY tag_id ASC', [problem.id]); return api().send(res, { problem_id: Number(problem.id), tag_ids: rows.map(row => Number(row.tag_id)) }); });
app.put('/api/v2/problems/:id/tags', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const problem = await Problem.findById(Number(req.params.id)); if (!problem) return api().fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.'); if (!await can(user, 'problem:edit', problem)) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: problem:edit.'); if (!req.get('If-Match')) return api().fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when replacing problem tags.', { if_match: 'required' }); const rawIds = req.body && req.body.tag_ids; if (!Array.isArray(rawIds) || rawIds.length > 20) return api().fail(res, 422, 'VALIDATION_FAILED', 'Tag IDs must contain at most 20 unique positive integers.', { tag_ids: '1-20 unique positive integers required' }); const ids = rawIds.map(Number); if (ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) return api().fail(res, 422, 'VALIDATION_FAILED', 'Tag IDs must contain at most 20 unique positive integers.', { tag_ids: '1-20 unique positive integers required' }); try { await TypeORM.getConnection().transaction(async manager => { const currentRows = await manager.query('SELECT tag_id FROM problem_tag_map WHERE problem_id=? ORDER BY tag_id ASC FOR UPDATE', [problem.id]); const current = { problem_id: Number(problem.id), tag_ids: currentRows.map(row => Number(row.tag_id)) }; if (!api().ifMatch(req, current)) throw tagError('Problem tags changed. Refresh them and try again.', 'ETAG_MISMATCH', 412); if (ids.length) { const placeholders = ids.map(() => '?').join(','); const existing = await manager.query(`SELECT id FROM problem_tag WHERE id IN (${placeholders}) FOR UPDATE`, ids); if (existing.length !== ids.length) throw tagError('One or more tags were not found.', 'TAG_NOT_FOUND', 404, { tag_ids: 'contains an unknown tag' }); } await manager.query('DELETE FROM problem_tag_map WHERE problem_id=?', [problem.id]); for (const tagId of ids) await manager.query('INSERT INTO problem_tag_map (problem_id,tag_id) VALUES (?,?)', [problem.id, tagId]); }); return api().send(res, { problem_id: Number(problem.id), tag_ids: ids }); } catch (error) { return contentFailure(res, error); } });

app.get('/api/v2/problems/:id/solutions', async (req, res) => {
  const problem = await Problem.findById(Number(req.params.id));
  if (!problem) return api().fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
  const user = res.locals.user;
  const reviewer = await can(user, 'solution:moderate');
  const canUseProblem = !!problem.is_public || reviewer || await can(user, 'problem:edit', problem);
  if (!canUseProblem) return api().fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
  const limit = api().parseLimit(req, 30, 100);
  const cursor = api().decodeCursor(req.query.cursor);
  const clauses = ['solution.problem_id=?'];
  const params = [problem.id];
  if (!reviewer && user) {
    clauses.push("(solution.status='accepted' OR solution.user_id=?)");
    params.push(user.id);
  } else if (!reviewer) {
    clauses.push("solution.status='accepted'");
  }
  if (cursor != null && Number(cursor) > 0) {
    clauses.push('solution.id<?');
    params.push(Number(cursor));
  }
  params.push(limit + 1);
  const rows = await TypeORM.getConnection().query(`SELECT solution.id,solution.problem_id,solution.title,solution.content,solution.user_id,solution.status,solution.public_time,solution.update_time,solution.reject_reason,u.username FROM problem_solution solution INNER JOIN user u ON u.id=solution.user_id WHERE ${clauses.join(' AND ')} ORDER BY solution.id DESC LIMIT ?`, params);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  res.locals.apiMeta.limit = limit;
  res.locals.apiMeta.next_cursor = more && last ? api().encodeCursor(Number(last.id)) : null;
  return api().send(res, page.map(row => serializeSolution(Object.assign(row, { viewer_id: user && user.id, can_review: reviewer }))));
});
app.post(['/api/v2/problems/:id/solutions', '/api/v2/solutions'], async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!await can(user, 'solution:create')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: solution:create.');
  if (!await syzoj.utils.isEmailVerified(user.id)) return api().fail(res, 409, 'VERIFIED_EMAIL_REQUIRED', 'Verify your email before submitting a solution.');
  const problemId = Number(req.params.id || req.body && req.body.problem_id);
  const problem = await Problem.findById(problemId);
  if (!problem) return api().fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
  const isModerator = await can(user, 'solution:moderate');
  const canUseHiddenProblem = isModerator || await can(user, 'problem:edit', problem);
  try {
    const result = await contentTransaction(manager => contentDomain.createSolution(manager, {
      actorId: user.id,
      problemId,
      title: req.body && req.body.title,
      content: req.body && req.body.content,
      allowComment: !req.body || req.body.allow_comment == null ? true : !!req.body.allow_comment,
      submitForReview: req.path !== '/api/v2/solutions',
      isModerator,
      canUseHiddenProblem,
      now: Math.floor(Date.now() / 1000)
    }));
    return api().send(res, { id: result.id, problem_id: result.problemId, title: result.title, content: result.content, status: result.status, allow_comment: result.allowComment, updated_at: time(result.updateTime), event_id: result.eventId }, 201);
  } catch (error) { return contentFailure(res, error); }
});
app.get('/api/v2/solutions/:id', async (req, res) => {
  const visible = await visibleSolution(res.locals.user, req.params.id);
  if (!visible) return api().fail(res, 404, 'SOLUTION_NOT_FOUND', 'Solution was not found.');
  api().setResourceEtag(res, solutionRevision(visible.row));
  return api().send(res, serializeSolution(visible.row));
});
app.patch('/api/v2/solutions/:id', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!req.get('If-Match')) return api().fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when editing a solution.', { if_match: 'required' });
  const isModerator = await can(user, 'solution:moderate');
  try {
    const result = await contentTransaction(manager => contentDomain.updateSolution(manager, {
      solutionId: req.params.id,
      actorId: user.id,
      isModerator,
      title: req.body && req.body.title,
      content: req.body && req.body.content,
      allowComment: !req.body || req.body.allow_comment == null ? true : !!req.body.allow_comment,
      now: Math.floor(Date.now() / 1000),
      reason: syzoj.utils.operationReason(req, '编辑题解'),
      ifMatch: current => api().ifMatch(req, solutionRevision(current)),
      recordAudit: auditRecorder(req)
    }));
    return api().send(res, { id: result.id, problem_id: result.problemId, title: result.title, content: result.content, status: result.status, allow_comment: result.allowComment, updated_at: time(result.updateTime), audit_event_id: result.auditEventId, event_id: result.eventId });
  } catch (error) { return contentFailure(res, error); }
});
app.post('/api/v2/solutions/:id/submit-review', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const isModerator = await can(user, 'solution:moderate'); try { const result = await contentTransaction(manager => contentDomain.submitSolutionReview(manager, { solutionId: req.params.id, actorId: user.id, isModerator, now: Math.floor(Date.now() / 1000), ifMatch: current => api().ifMatch(req, solutionRevision(current)) })); return api().send(res, { id: result.id, problem_id: result.problemId, status: result.status, updated_at: time(result.updateTime), event_id: result.eventId }); } catch (error) { return contentFailure(res, error); } });
app.post('/api/v2/solutions/:id/withdraw', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); try { const result = await contentTransaction(manager => contentDomain.withdrawSolution(manager, { solutionId: req.params.id, actorId: user.id, now: Math.floor(Date.now() / 1000), recordAudit: auditRecorder(req) })); return api().send(res, { id: result.id, problem_id: result.problemId, status: result.status, updated_at: time(result.updateTime), audit_event_id: result.auditEventId, event_id: result.eventId }); } catch (error) { return contentFailure(res, error); } });
app.delete('/api/v2/solutions/:id', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const isModerator = await can(user, 'solution:moderate'); try { const result = await contentTransaction(manager => contentDomain.deleteSolution(manager, { solutionId: req.params.id, actorId: user.id, isModerator, recordAudit: auditRecorder(req) })); return api().send(res, { id: result.id, problem_id: result.problemId, deleted: true, audit_event_id: result.auditEventId, event_id: result.eventId }); } catch (error) { return contentFailure(res, error); } });
app.delete('/api/v2/solutions/:id/comments/:commentId', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const isModerator = await can(user, 'solution:moderate') || await can(user, 'problem:edit'); try { const result = await contentTransaction(manager => contentDomain.deleteSolutionComment(manager, { solutionId: req.params.id, commentId: req.params.commentId, actorId: user.id, isModerator, recordAudit: auditRecorder(req) })); return api().send(res, { id: result.id, solution_id: result.solutionId, deleted: true, audit_event_id: result.auditEventId, event_id: result.eventId }); } catch (error) { return contentFailure(res, error); } });
app.post('/api/v2/solutions/:id/comments', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  const isModerator = await can(user, 'solution:moderate');
  let mentionUserIds = [];
  try {
    if (syzoj.utils.parseMentions) {
      const mentions = await syzoj.utils.parseMentions(String(req.body && req.body.content || ''));
      mentionUserIds = mentions.map(mention => Number(mention.userId));
    }
  } catch (error) {
    syzoj.log('[solution-v2] mention lookup failed: ' + error.message);
  }
  try {
    const result = await contentTransaction(manager => contentDomain.createSolutionComment(manager, {
      solutionId: req.params.id,
      actorId: user.id,
      actorName: user.username,
      isModerator,
      content: req.body && req.body.content,
      mentionUserIds,
      now: Math.floor(Date.now() / 1000)
    }));
    return api().send(res, { id: result.id, solution_id: result.solutionId, content: result.content, created_at: time(result.now), notification_ids: result.notifications.map(item => item.id), event_id: result.eventId }, 201);
  } catch (error) { return contentFailure(res, error); }
});
app.get(['/api/v2/admin/solutions/pending', '/api/v2/admin/solutions/review-queue'], async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!await can(user, 'solution:moderate')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: solution:moderate.');
  const limit = api().parseLimit(req, 30, 100);
  const cursor = Number(api().decodeCursor(req.query.cursor) || 0);
  const params = [];
  const clauses = ["solution.status='pending'"];
  if (cursor > 0) {
    clauses.push('solution.id>?');
    params.push(cursor);
  }
  params.push(limit + 1);
  const rows = await TypeORM.getConnection().query(`SELECT solution.*,u.username,p.title AS problem_title FROM problem_solution solution INNER JOIN user u ON u.id=solution.user_id INNER JOIN problem p ON p.id=solution.problem_id WHERE ${clauses.join(' AND ')} ORDER BY solution.id ASC LIMIT ?`, params);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  res.locals.apiMeta.limit = limit;
  res.locals.apiMeta.next_cursor = more && last ? api().encodeCursor(Number(last.id)) : null;
  return api().send(res, page.map(row => ({ id: Number(row.id), problem_id: Number(row.problem_id), problem_title: row.problem_title, title: row.title, content: row.content, author: { id: Number(row.user_id), username: row.username }, status: row.status, updated_at: time(row.update_time) })));
});
app.post(['/api/v2/admin/solutions/:id/review', '/api/v2/solutions/:id/review'], async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const isModerator = await can(user, 'solution:moderate'); if (!isModerator) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: solution:moderate.'); const decision = req.body && req.body.decision; const reason = decision === 'rejected' ? req.body && req.body.reason : '题解审核通过'; try { const result = await contentTransaction(manager => contentDomain.reviewSolution(manager, { solutionId: req.params.id, reviewerId: user.id, reviewerName: user.username, isModerator, decision, reason, now: Math.floor(Date.now() / 1000), ifMatch: current => api().ifMatch(req, solutionRevision(current)), recordAudit: auditRecorder(req) })); return api().send(res, { id: result.id, problem_id: result.problemId, status: result.status, reject_reason: result.reason, audit_event_id: result.auditEventId, notification_id: result.notificationId, event_id: result.eventId }); } catch (error) { return contentFailure(res, error); } });

function time(value) { return value == null ? null : new Date(Number(value) * 1000).toISOString(); }
ensureProblemWorkflowSchema().catch(error => syzoj.log(`[problem-workflow-v2] schema initialization failed: ${error.stack || error.message}`));
