const crypto = require('crypto');
const fs = require('fs-extra');
const multer = require('multer');
const os = require('os');
const TypeORM = require('typeorm');
const submissionDomain = require('../libs/submission-domain');
const submissionStorage = require('../libs/submission-storage');
const submissionScheduler = require('../libs/submission-scheduler');
const judgeStatus = require('../libs/judge-status');

const JudgeState = syzoj.model('judge_state');
const Problem = syzoj.model('problem');
const Contest = syzoj.model('contest');
const File = syzoj.model('file');
const Judger = syzoj.lib('judger');

const submitAnswerUpload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: Number(syzoj.config.limit && syzoj.config.limit.submit_answer || 512 * 1024 * 1024),
    files: 1
  },
  fileFilter: (_req, file, callback) => {
    const isZip = /\.zip$/i.test(String(file.originalname || ''));
    callback(isZip ? null : Object.assign(new Error('Only ZIP answer archives are supported.'), { code: 'ANSWER_ARCHIVE_INVALID' }), isZip);
  }
}).single('answer');

const TERMINAL_STATUSES = new Set(submissionDomain.TERMINAL_STATUSES);
let schemaPromise = null;
let projectionTimer = null;
let dispatchTimer = null;
const dispatchingSubmissions = new Set();
const retryingSystemErrors = new Set();

async function ensureSubmissionSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const connection = TypeORM.getConnection();
    await syzoj.utils.apiV2.ensureFoundationSchema();
    await connection.query(`
      CREATE TABLE IF NOT EXISTS submission_v2_code_version (
        id CHAR(36) NOT NULL PRIMARY KEY,
        submission_id INT NOT NULL,
        user_id INT NOT NULL,
        language VARCHAR(40) NULL,
        source_hash CHAR(64) NOT NULL,
        source_code MEDIUMTEXT NOT NULL,
        visibility VARCHAR(24) NOT NULL DEFAULT 'private',
        created_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_submission_v2_code_submission (submission_id),
        KEY idx_submission_v2_code_user_time (user_id,created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS submission_v2_projection (
        submission_id INT NOT NULL PRIMARY KEY,
        problem_id INT NOT NULL,
        snapshot_id VARCHAR(80) NULL,
        code_version_id CHAR(36) NULL,
        user_id INT NOT NULL,
        contest_id INT NULL,
        language VARCHAR(40) NULL,
        source_visibility VARCHAR(24) NOT NULL DEFAULT 'private',
        status VARCHAR(40) NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        last_error VARCHAR(1000) NULL,
        next_retry_at DATETIME(3) NULL,
        dispatch_attempts INT NOT NULL DEFAULT 0,
        dispatch_lease_until DATETIME(3) NULL,
        dispatch_enabled TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        KEY idx_submission_v2_user_time (user_id,created_at,submission_id),
        KEY idx_submission_v2_problem_time (problem_id,created_at,submission_id),
        KEY idx_submission_v2_status (status,updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const projectionColumns = await connection.query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='submission_v2_projection'`);
    const projectionColumnNames = new Set(projectionColumns.map(row => row.COLUMN_NAME));
    if (!projectionColumnNames.has('code_version_id')) await connection.query('ALTER TABLE submission_v2_projection ADD COLUMN code_version_id CHAR(36) NULL AFTER snapshot_id');
    if (!projectionColumnNames.has('dispatch_attempts')) await connection.query('ALTER TABLE submission_v2_projection ADD COLUMN dispatch_attempts INT NOT NULL DEFAULT 0 AFTER next_retry_at');
    if (!projectionColumnNames.has('dispatch_lease_until')) await connection.query('ALTER TABLE submission_v2_projection ADD COLUMN dispatch_lease_until DATETIME(3) NULL AFTER dispatch_attempts');
    if (!projectionColumnNames.has('dispatch_enabled')) await connection.query('ALTER TABLE submission_v2_projection ADD COLUMN dispatch_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER dispatch_lease_until');
    await connection.query("UPDATE submission_v2_projection SET dispatch_enabled=1 WHERE status='queued' AND last_error IS NOT NULL AND next_retry_at IS NOT NULL");
    await connection.query(`
      CREATE TABLE IF NOT EXISTS submission_v2_attempt (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        submission_id INT NOT NULL,
        operation VARCHAR(32) NOT NULL,
        actor_id INT NULL,
        reason VARCHAR(1000) NULL,
        old_status VARCHAR(40) NULL,
        new_status VARCHAR(40) NULL,
        created_at DATETIME(3) NOT NULL,
        KEY idx_submission_v2_attempt_submission (submission_id,id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS submission_v2_result_revision (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        submission_id INT NOT NULL, legacy_status VARCHAR(80) NULL, pending TINYINT(1) NOT NULL,
        score DECIMAL(12,3) NULL, total_time INT NULL, max_memory INT NULL,
        result_json LONGTEXT NULL, compilation_text LONGTEXT NULL, created_by INT NULL,
        reason VARCHAR(1000) NOT NULL, created_at DATETIME(3) NOT NULL,
        KEY idx_submission_v2_revision_submission (submission_id,id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS submission_v2_job (
        id CHAR(36) NOT NULL PRIMARY KEY, submission_id INT NOT NULL, kind VARCHAR(32) NOT NULL,
        state VARCHAR(24) NOT NULL, progress TINYINT UNSIGNED NOT NULL DEFAULT 0,
        actor_id INT NOT NULL, reason VARCHAR(1000) NOT NULL, audit_event_id VARCHAR(80) NULL,
        cancel_requested TINYINT(1) NOT NULL DEFAULT 0, error_json LONGTEXT NULL,
        created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
        KEY idx_submission_v2_job_state (state,updated_at),
        KEY idx_submission_v2_job_submission (submission_id,created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await connection.query(`
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
       WHERE NOT EXISTS (
         SELECT 1 FROM api_v2_event event
          WHERE event.stream=CONCAT('submission:',projection.submission_id)
            AND event.type='submission.projection.seeded'
       )
    `);
  })().catch(error => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

function statusForJudge(judge, projectedStatus) {
  return judgeStatus.statusForJudge(judge, projectedStatus);
}

function publicSubmission(row, viewerId, options = {}) {
  const includeCode = options.includeCode === true;
  const canReadSource = includeCode && submissionDomain.sourceVisibleTo({
    ownerId: row.user_id,
    viewerId,
    visibility: row.source_visibility,
    canReadAll: options.canReadAll === true
  });
  return {
    id: Number(row.submission_id || row.id),
    problem_id: Number(row.problem_id),
    problem_title: row.problem_title || null,
    contest_id: row.contest_id == null ? null : Number(row.contest_id),
    user_id: Number(row.user_id),
    language: row.language || null,
    code_version_id: row.code_version_id || null,
    source_visibility: row.source_visibility,
    status: row.status,
    score: row.score == null ? null : Number(row.score),
    total_time: row.total_time == null ? null : Number(row.total_time),
    memory: row.max_memory == null ? null : Number(row.max_memory),
    code_length: row.code_length == null ? null : Number(row.code_length),
    source_hash: canReadSource ? row.source_hash || null : undefined,
    source: canReadSource ? (row.version_source == null ? row.code || null : row.version_source) : undefined,
    created_at: row.submit_time ? new Date(Number(row.submit_time) * 1000).toISOString() : syzoj.utils.apiV2.databaseIso(row.created_at),
    updated_at: syzoj.utils.apiV2.databaseIso(row.updated_at)
  };
}

function publishDomainEvent(result) {
  if (result && result.event) syzoj.utils.apiV2.publishEvent(result.event);
  return result;
}

async function submissionTransaction(work) {
  await ensureSubmissionSchema();
  const result = await TypeORM.getConnection().transaction(work);
  return publishDomainEvent(result);
}

async function projectStatus(judge, force = false) {
  await ensureSubmissionSchema();
  const connection = TypeORM.getConnection();
  const rows = await connection.query('SELECT * FROM submission_v2_projection WHERE submission_id=? LIMIT 1', [judge.id]);
  if (!rows.length) return null;
  const projection = rows[0];
  const nextStatus = statusForJudge(judge, projection.status);
  if (!force && projection.status === nextStatus) {
    if (nextStatus === 'system_error') setImmediate(() => queueSystemRetry(judge, projection));
    return projection;
  }
  try {
    const result = await submissionTransaction(manager => submissionDomain.transitionProjection(manager, {
      submissionId: judge.id,
      status: nextStatus,
      operation: 'runtime_status',
      actorId: judge.user_id,
      eventType: 'submission.status.changed',
      payload: { legacy_status: judge.status, pending: !!judge.pending }
    }));
    if (nextStatus === 'system_error') setImmediate(() => queueSystemRetry(judge, result.projection));
    return result.projection;
  } catch (error) {
    if (error.code === 'SUBMISSION_TRANSITION_INVALID') return projection;
    throw error;
  }
}

async function queueSystemRetry(judge, projection) {
  const id = Number(judge && judge.id);
  if (!Number.isSafeInteger(id) || retryingSystemErrors.has(id)) return false;
  if (!projection || projection.status !== 'system_error' || !submissionDomain.shouldRetryAutomatically(projection.status, projection.attempts, 2)) return false;
  retryingSystemErrors.add(id);
  try {
    const connection = TypeORM.getConnection();
    const locked = await connection.query('SELECT * FROM submission_v2_projection WHERE submission_id=? LIMIT 1', [id]);
    if (!locked.length || locked[0].status !== 'system_error' || !submissionDomain.shouldRetryAutomatically(locked[0].status, locked[0].attempts, 2)) return false;
    await connection.transaction(manager => snapshotSubmissionResult(manager, judge, null, '评测服务系统错误自动重试'));
    await judge.loadRelationships();
    judge.status = 'Unknown';
    judge.pending = false;
    judge.score = null;
    judge.total_time = null;
    judge.max_memory = null;
    judge.result = {};
    judge.compilation = null;
    judge.task_id = require('randomstring').generate(10);
    await judge.save();
    await judge.updateRelatedInfo(false);
    const result = await submissionTransaction(async manager => {
      const rows = await manager.query('SELECT attempts FROM submission_v2_projection WHERE submission_id=? LIMIT 1 FOR UPDATE', [id]);
      if (!rows.length || rows[0].attempts >= 2) return null;
      return submissionDomain.transitionProjection(manager, {
        submissionId: id,
        status: 'queued',
        allowTerminalReset: true,
        operation: 'system_retry',
        actorId: null,
        reason: '评测服务系统错误自动重试',
        eventType: 'submission.system_retry.queued',
        patch: {
          attempts: Number(rows[0].attempts || 0) + 1,
          dispatch_enabled: true,
          dispatch_lease_until: null,
          last_error: null,
          next_retry_at: null
        },
        payload: { retry_limit: 2 }
      });
    });
    return !!result;
  } catch (error) {
    syzoj.log(`[submission-v2] system error retry failed for #${id}: ${error.message || error}`);
    return false;
  } finally {
    retryingSystemErrors.delete(id);
  }
}

async function projectRuntimeState(taskId, nextStatus) {
  if (!['compiling', 'judging'].includes(nextStatus)) return false;
  await ensureSubmissionSchema();
  const connection = TypeORM.getConnection();
  const rows = await connection.query(
    `SELECT projection.submission_id,projection.status,judge.user_id
       FROM submission_v2_projection projection
       JOIN judge_state judge ON judge.id=projection.submission_id
      WHERE judge.task_id=? LIMIT 1`,
    [String(taskId)]
  );
  if (!rows.length || rows[0].status === nextStatus) return false;
  try {
    await submissionTransaction(manager => submissionDomain.transitionProjection(manager, {
      submissionId: rows[0].submission_id,
      status: nextStatus,
      operation: 'runtime_status',
      actorId: rows[0].user_id,
      eventType: 'submission.status.changed'
    }));
    return true;
  } catch (error) {
    if (error.code === 'SUBMISSION_TRANSITION_INVALID') return false;
    throw error;
  }
}

async function canViewSubmission(judge, user) {
  if (!judge || !user) return false;
  if (Number(judge.user_id) === Number(user.id)) return true;
  if (await syzoj.utils.authorizationV2.authorize(user, 'judge:read', null, {})) return true;
  return !!(judge.is_public && judge.type === 0);
}

async function canViewSubmissionDiagnostics(judge, user) {
  if (!judge || !user) return false;
  if (Number(judge.user_id) === Number(user.id)) return true;
  return syzoj.utils.authorizationV2.authorize(user, 'judge:read', null, {});
}

function validLanguage(problem, language) {
  const languages = problem.getVJudgeLanguages() || syzoj.config.enabled_languages || [];
  if (!language) return false;
  return Array.isArray(languages)
    ? languages.includes(language)
    : Object.prototype.hasOwnProperty.call(languages, language);
}

async function contestAcceptsSubmissions(contest) {
  const rows = await TypeORM.getConnection().query(
    'SELECT * FROM contest_v2_state WHERE contest_id=? LIMIT 1',
    [contest.id]
  );
  const status = syzoj.utils.contestV2 && typeof syzoj.utils.contestV2.status === 'function'
    ? syzoj.utils.contestV2.status(contest, rows[0] || null)
    : (Math.floor(Date.now() / 1000) < Number(contest.start_time) ? 'scheduled'
      : Math.floor(Date.now() / 1000) > Number(contest.end_time) ? 'ended' : 'running');
  return status === 'running' || status === 'frozen';
}

async function resolveContestProblem(contest, token) {
  const ids = (await contest.getProblems()).map(Number);
  const numeric = Number(token);
  if (Number.isSafeInteger(numeric) && ids.includes(numeric)) return numeric;
  const text = String(token || '').trim().toUpperCase();
  if (/^[A-Z]+$/.test(text)) {
    let index = 0;
    for (const character of text) index = index * 26 + character.charCodeAt(0) - 64;
    if (ids[index - 1]) return ids[index - 1];
  }
  return null;
}

async function resolveSubmissionSnapshot(problem, contest, actorId) {
  const snapshot = await syzoj.utils.problemV2.snapshotForCurrentVersion(problem, actorId, {
    includeDraft: !!contest || !problem.is_public,
    activate: !problem.is_public
  });
  if (contest && snapshot && snapshot.snapshot_id && syzoj.utils.contestV2.trackProblemSnapshot) {
    await syzoj.utils.contestV2.trackProblemSnapshot(contest.id, problem.id, snapshot.snapshot_id);
  }
  return snapshot && snapshot.snapshot_id || null;
}

function missingProblemSnapshot(snapshotId) {
  const error = new Error('The problem snapshot required for this submission is missing.');
  error.code = 'PROBLEM_SNAPSHOT_REQUIRED';
  error.statusCode = 409;
  error.snapshotId = snapshotId || null;
  return error;
}

async function immutableExecutionProblem(problem, snapshotId) {
  if (!snapshotId) return problem;
  let rows = await TypeORM.getConnection().query(
    'SELECT problem_id,content_hash,content_json,provider_config,testdata_hash,testdata_path FROM problem_v2_snapshot WHERE id=? LIMIT 1',
    [snapshotId]
  );
  if (!rows.length || Number(rows[0].problem_id) !== Number(problem.id)) throw missingProblemSnapshot(snapshotId);
  let content;
  try {
    content = typeof rows[0].content_json === 'string' ? JSON.parse(rows[0].content_json) : rows[0].content_json;
  } catch (error) {
    throw missingProblemSnapshot(snapshotId);
  }
  if (!content || typeof content !== 'object') throw missingProblemSnapshot(snapshotId);
  if (content.vjudge_config == null && rows[0].provider_config != null) content.vjudge_config = rows[0].provider_config;
  const requiresLocalTestdata = !String(content.type || problem.type || '').startsWith('vjudge:');
  if (requiresLocalTestdata && (!rows[0].testdata_hash || !rows[0].testdata_path)) {
    if (!syzoj.utils.problemV2 || !syzoj.utils.problemV2.ensureSnapshotTestdata) throw missingProblemSnapshot(snapshotId);
    await syzoj.utils.problemV2.ensureSnapshotTestdata(problem, snapshotId);
    rows = await TypeORM.getConnection().query(
      'SELECT problem_id,content_hash,content_json,provider_config,testdata_hash,testdata_path FROM problem_v2_snapshot WHERE id=? LIMIT 1',
      [snapshotId]
    );
    if (!rows.length || !rows[0].testdata_hash || !rows[0].testdata_path) throw missingProblemSnapshot(snapshotId);
  }
  return Object.assign({}, problem, content, {
    judge_snapshot_id: String(snapshotId),
    judge_snapshot_hash: String(rows[0].content_hash),
    judge_testdata_hash: rows[0].testdata_hash || null,
    judge_testdata_path: rows[0].testdata_path || null
  });
}

async function registeredForContest(contest, user) {
  if (!user) return false;
  if (await contest.isSupervisior(user)) return true;
  if (!contest.isRunning()) return false;
  const rows = await TypeORM.getConnection().query('SELECT id FROM contest_player WHERE contest_id=? AND user_id=? LIMIT 1', [contest.id, user.id]);
  return !!rows.length;
}

function retryAt(seconds) {
  return new Date(Date.now() + Number(seconds) * 1000);
}

async function recordDispatchFailure(submissionId, error) {
  return submissionTransaction(async manager => {
    const rows = await manager.query('SELECT dispatch_attempts FROM submission_v2_projection WHERE submission_id=? LIMIT 1 FOR UPDATE', [submissionId]);
    if (!rows.length) throw submissionDomain.domainError('SUBMISSION_PROJECTION_MISSING', 'Submission projection was not found.', 404);
    const attempts = Number(rows[0].dispatch_attempts || 0) + 1;
    const retrySeconds = submissionDomain.retryDelaySeconds(attempts);
    return submissionDomain.transitionProjection(manager, {
      submissionId,
      status: 'queued',
      operation: 'dispatch_failed',
      eventType: 'submission.dispatch_failed',
      patch: {
        dispatch_attempts: attempts,
        dispatch_lease_until: null,
        dispatch_enabled: true,
        last_error: 'JUDGE_DISPATCH_UNAVAILABLE',
        next_retry_at: retryAt(retrySeconds)
      },
      payload: { error_code: 'JUDGE_DISPATCH_UNAVAILABLE', retry_in_seconds: retrySeconds }
    });
  });
}

async function recordDispatchSuccess(submissionId, actorId, priority) {
  return submissionTransaction(async manager => {
    const rows = await manager.query('SELECT dispatch_attempts FROM submission_v2_projection WHERE submission_id=? LIMIT 1 FOR UPDATE', [submissionId]);
    if (!rows.length) throw submissionDomain.domainError('SUBMISSION_PROJECTION_MISSING', 'Submission projection was not found.', 404);
    const attempts = Number(rows[0].dispatch_attempts || 0) + 1;
    return submissionDomain.transitionProjection(manager, {
      submissionId,
      status: 'queued',
      operation: 'dispatch',
      actorId,
      eventType: 'submission.dispatched',
      patch: {
        dispatch_attempts: attempts,
        dispatch_lease_until: null,
        dispatch_enabled: false,
        last_error: null,
        next_retry_at: null
      },
      payload: { dispatch_attempt: attempts, priority }
    });
  });
}

async function dispatchQueuedSubmission(submissionId) {
  const id = Number(submissionId);
  if (!Number.isSafeInteger(id) || dispatchingSubmissions.has(id)) return false;
  dispatchingSubmissions.add(id);
  const connection = TypeORM.getConnection();
  try {
    const claimed = await connection.query(`UPDATE submission_v2_projection
      SET dispatch_lease_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 45 SECOND),updated_at=UTC_TIMESTAMP(3)
      WHERE submission_id=? AND status='queued' AND dispatch_enabled=1 AND (dispatch_lease_until IS NULL OR dispatch_lease_until<UTC_TIMESTAMP(3))`, [id]);
    if (!claimed.affectedRows) return false;
    const rows = await connection.query(`SELECT projection.dispatch_attempts,projection.snapshot_id,judge.* FROM submission_v2_projection projection
      JOIN judge_state judge ON judge.id=projection.submission_id WHERE projection.submission_id=? LIMIT 1`, [id]);
    if (!rows.length) return false;
    const judge = await JudgeState.findById(id);
    if (!judge || judge.pending) {
      await connection.query('UPDATE submission_v2_projection SET dispatch_lease_until=NULL WHERE submission_id=?', [id]);
      return false;
    }
    let contest;
    try {
      const problem = await Problem.findById(Number(judge.problem_id));
      if (!problem) throw new Error('Problem was not found while dispatching the submission.');
      contest = Number(judge.type) === 1 ? await Contest.findById(Number(judge.type_info)) : null;
      const executionProblem = await immutableExecutionProblem(problem, rows[0].snapshot_id);
      await Judger.judge(judge, executionProblem, contest ? 3 : 2, { snapshotId: rows[0].snapshot_id });
      judge.pending = true;
      judge.status = 'Waiting';
      await judge.save();
    } catch (error) {
      syzoj.log(`[submission-v2] judge dispatch unavailable for #${id}: ${error.message || error}`);
      await recordDispatchFailure(id, error);
      return false;
    }
    try {
      await recordDispatchSuccess(id, judge.user_id, contest ? 'contest' : 'practice');
    } catch (error) {
      await connection.query('UPDATE submission_v2_projection SET dispatch_lease_until=NULL WHERE submission_id=?', [id]).catch(() => {});
      syzoj.log(`[submission-v2] dispatched #${id}, but projection persistence failed: ${error.message || error}`);
    }
    return true;
  } catch (error) {
    syzoj.log(`[submission-v2] dispatch bookkeeping failed for #${id}: ${error.message || error}`);
    await recordDispatchFailure(id, error).catch(persistError => syzoj.log(`[submission-v2] could not schedule dispatch retry for #${id}: ${persistError.message || persistError}`));
    return false;
  } finally { dispatchingSubmissions.delete(id); }
}

async function dispatchQueuedSubmissions() {
  try {
    await ensureSubmissionSchema();
    const connection = TypeORM.getConnection();
    const rows = await connection.query(`SELECT projection.submission_id,projection.user_id,projection.contest_id,projection.language,projection.created_at
      FROM submission_v2_projection projection JOIN judge_state judge ON judge.id=projection.submission_id
      WHERE projection.status='queued' AND projection.dispatch_enabled=1 AND judge.pending=0
        AND (projection.next_retry_at IS NULL OR projection.next_retry_at<=UTC_TIMESTAMP(3))
        AND (projection.dispatch_lease_until IS NULL OR projection.dispatch_lease_until<UTC_TIMESTAMP(3))
        AND (SELECT COUNT(*) FROM judge_state active WHERE active.user_id=projection.user_id AND active.pending=1)<3
      ORDER BY (projection.contest_id IS NOT NULL) DESC,projection.created_at ASC,projection.submission_id ASC LIMIT 100`);
    const activeRows = await connection.query(`SELECT language,COUNT(*) AS active_count
      FROM submission_v2_projection WHERE status IN ('compiling','judging') GROUP BY language`);
    const activeByLanguage = Object.fromEntries(activeRows.map(row => [String(row.language || 'unknown'), Number(row.active_count || 0)]));
    const selected = submissionScheduler.rankQueuedSubmissions(rows, {
      limit: 20,
      activeByLanguage,
      languageSlots: syzoj.config.judge_language_slots || {}
    });
    for (const row of selected) {
      dispatchQueuedSubmission(row.submission_id).catch(error => syzoj.log(`[submission-v2] dispatch failed: ${error.message}`));
    }
  } catch (error) { syzoj.log(`[submission-v2] scheduler failed: ${error.message}`); }
}

function answerSubmissionError(code, message, statusCode, fields) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.fields = fields || {};
  return error;
}

async function expectedAnswerFilenames(problem) {
  const testcases = await syzoj.utils.parseTestdata(problem.getTestdataPath(), true);
  if (!Array.isArray(testcases) || testcases.error) {
    throw answerSubmissionError('PROBLEM_TESTDATA_UNAVAILABLE', 'The answer file list is unavailable.', 409);
  }
  const filenames = new Set();
  for (const subtask of testcases) {
    for (const testcase of Array.isArray(subtask && subtask.cases) ? subtask.cases : []) {
      const filename = String(testcase && testcase.answer || '');
      if (filename) filenames.add(filename);
    }
  }
  if (!filenames.size) throw answerSubmissionError('PROBLEM_TESTDATA_UNAVAILABLE', 'The problem has no answer files configured.', 409);
  return filenames;
}

async function prepareSubmitAnswer(req, problem) {
  const limit = Number(syzoj.config.limit && syzoj.config.limit.submit_answer || 512 * 1024 * 1024);
  let archivePath = req.file && req.file.path;
  try {
    if (!archivePath) {
      const raw = String(req.body && req.body.answer_by_editor || '');
      if (!raw) throw answerSubmissionError('VALIDATION_FAILED', 'At least one answer file is required.', 422, { answer_by_editor: 'required' });
      if (Buffer.byteLength(raw) > limit + 1024 * 1024) throw answerSubmissionError('ANSWER_TOO_LARGE', 'The answer data exceeds the submission limit.', 413);
      let entries;
      try { entries = JSON.parse(raw); }
      catch (error) { throw answerSubmissionError('VALIDATION_FAILED', 'The answer data is invalid.', 422, { answer_by_editor: 'invalid JSON' }); }
      if (!Array.isArray(entries)) throw answerSubmissionError('VALIDATION_FAILED', 'The answer data is invalid.', 422, { answer_by_editor: 'array required' });
      const expected = await expectedAnswerFilenames(problem);
      const seen = new Set();
      const files = [];
      let totalSize = 0;
      let populated = 0;
      for (const entry of entries) {
        const filename = String(entry && entry.filename || '');
        if (!expected.has(filename) || seen.has(filename)) throw answerSubmissionError('VALIDATION_FAILED', 'The answer file list is invalid.', 422, { answer_by_editor: 'unexpected or duplicate filename' });
        seen.add(filename);
        const data = String(entry && entry.data == null ? '' : entry.data);
        const size = Buffer.byteLength(data);
        totalSize += size;
        if (size) populated++;
        if (totalSize > limit) throw answerSubmissionError('ANSWER_TOO_LARGE', 'The answer data exceeds the submission limit.', 413);
        files.push({ filename, data });
      }
      if (!populated) throw answerSubmissionError('VALIDATION_FAILED', 'At least one answer file is required.', 422, { answer_by_editor: 'empty' });
      archivePath = await File.zipFiles(files);
    }
    const answerFile = await File.upload(archivePath, 'answer');
    const size = await answerFile.getUnzipSize();
    if (size > limit) throw answerSubmissionError('ANSWER_TOO_LARGE', 'The answer archive exceeds the submission limit.', 413);
    if (!answerFile.md5) throw answerSubmissionError('ANSWER_UPLOAD_FAILED', 'The answer archive could not be stored.', 500);
    return { md5: String(answerFile.md5), size: Number(size || 0) };
  } catch (error) {
    if (error && error.statusCode) throw error;
    throw answerSubmissionError('ANSWER_ARCHIVE_INVALID', error && error.message ? error.message : 'The answer archive is invalid.', 422);
  } finally {
    if (archivePath) await fs.remove(archivePath).catch(() => {});
  }
}

async function createSubmission(req, res, problem, contest) {
  const api = syzoj.utils.apiV2;
  const user = res.locals.user;
  const body = req.body || {};
  const submitAnswer = problem.type === 'submit-answer';
  let source = String(body.source || '');
  let language = submitAnswer ? null : String(body.language || '');
  let codeLength = Buffer.byteLength(source);
  let sourceVisibility = 'private';
  if (!submitAnswer) {
    if (!source.trim()) return api.fail(res, 422, 'VALIDATION_FAILED', 'Source code is required.', { source: 'required' });
    if (codeLength > Number(syzoj.config.limit.submit_code || 512 * 1024)) return api.fail(res, 413, 'SOURCE_TOO_LARGE', 'Source code exceeds the submission limit.');
    if (!validLanguage(problem, language)) return api.fail(res, 422, 'VALIDATION_FAILED', 'The language is not enabled for this problem.', { language: 'unsupported' });
    try { sourceVisibility = submissionDomain.normalizeSourceVisibility(body.source_visibility); }
    catch (error) { return api.fail(res, 422, 'VALIDATION_FAILED', error.message, { source_visibility: 'private or public required' }); }
  }
  if (contest && !await registeredForContest(contest, user)) return api.fail(res, 403, 'CONTEST_PARTICIPATION_REQUIRED', 'Register for the contest before submitting.');
  if (contest && !await contestAcceptsSubmissions(contest)) return api.fail(res, 409, 'CONTEST_NOT_RUNNING', 'Contest submissions are accepted only while the contest is running.');
  if (contest && !(await contest.getProblems()).map(Number).includes(Number(problem.id))) return api.fail(res, 404, 'CONTEST_PROBLEM_NOT_FOUND', 'The problem is not part of this contest.');
  const snapshotId = await resolveSubmissionSnapshot(problem, contest, user.id);
  if (!snapshotId) return api.fail(res, 409, 'PROBLEM_SNAPSHOT_REQUIRED', 'The contest problem snapshot is missing. Restore the contest snapshot before accepting submissions.');
  if (submitAnswer) {
    try {
      const answer = await prepareSubmitAnswer(req, problem);
      source = answer.md5;
      codeLength = answer.size;
    } catch (error) {
      return api.fail(res, error.statusCode || 422, error.code || 'ANSWER_ARCHIVE_INVALID', error.message, error.fields || {});
    }
  }
  const created = await submissionTransaction(async manager => {
    const storedJudge = await submissionStorage.insertSubmission(manager, {
      submit_time: Math.floor(Date.now() / 1000), status: 'Unknown', task_id: require('randomstring').generate(10),
      code: source, code_length: codeLength, language, user_id: user.id,
      problem_id: problem.id, is_public: problem.is_public, type: contest ? 1 : 0,
      type_info: contest ? contest.id : null, pending: false
    });
    const codeVersion = await submissionDomain.createCodeVersion(manager, {
      submissionId: storedJudge.id, userId: user.id, language,
      source, sourceVisibility
    });
    const projection = await submissionDomain.createProjection(manager, {
      submissionId: storedJudge.id, problemId: problem.id, snapshotId, userId: user.id,
      contestId: contest ? contest.id : null, language,
      codeVersionId: codeVersion.id, sourceVisibility, actorId: user.id
    });
    return { judge: storedJudge, codeVersion, event: projection.event };
  });
  const judge = JudgeState.create(created.judge);
  try {
    await judge.updateRelatedInfo(true);
    const executionProblem = await immutableExecutionProblem(problem, snapshotId);
    await Judger.judge(judge, executionProblem, contest ? 3 : 2, { snapshotId });
    judge.pending = true;
    judge.status = 'Waiting';
    await judge.save();
    await submissionTransaction(manager => submissionDomain.transitionProjection(manager, {
      submissionId: judge.id,
      status: 'queued',
      operation: 'queue',
      actorId: user.id,
      eventType: 'submission.queued',
      patch: { dispatch_attempts: 1, dispatch_enabled: false, last_error: null, next_retry_at: null }
    }));
  } catch (error) {
    syzoj.log(`[submission-v2] initial judge dispatch unavailable for #${judge.id}: ${error.message || error}`);
    await submissionTransaction(manager => submissionDomain.transitionProjection(manager, {
      submissionId: judge.id,
      status: 'queued',
      operation: 'queue',
      actorId: user.id,
      eventType: 'submission.queued',
      patch: {
        dispatch_attempts: 1,
        dispatch_enabled: true,
        last_error: 'JUDGE_DISPATCH_UNAVAILABLE',
        next_retry_at: retryAt(10)
      },
      payload: { error_code: 'JUDGE_DISPATCH_UNAVAILABLE', retry_in_seconds: 10 }
    }));
  }
  return api.send(res, { submission: { id: Number(judge.id), status: 'queued', problem_id: Number(problem.id), snapshot_id: snapshotId, code_version_id: created.codeVersion.id, language, source_visibility: sourceVisibility }, operation_id: res.locals.apiOperationId || null }, 202);
}

// VJudge exposes a provider-specific submission route, but the local task,
// immutable snapshot, code-version, and dispatch transaction remain shared.
syzoj.utils.submissionV2 = Object.freeze({ createSubmission });

function receiveSubmitAnswer(req, res, next) {
  submitAnswerUpload(req, res, error => {
    if (!error) return next();
    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    return syzoj.utils.apiV2.fail(res, tooLarge ? 413 : 422, tooLarge ? 'ANSWER_TOO_LARGE' : 'ANSWER_ARCHIVE_INVALID', error.message);
  });
}

app.post('/api/v2/problems/:id/submissions', async (req, res) => {
  const api = syzoj.utils.apiV2;
  const user = res.locals.user;
  if (!user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  const problem = await Problem.findById(Number(req.params.id));
  if (!problem) return api.fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
  if (!await problem.isAllowedUseBy(user)) return api.fail(res, 403, 'PROBLEM_FORBIDDEN', 'You cannot submit to this problem.');
  if (!await syzoj.utils.authorizationV2.authorize(user, 'submission:create', { ownerId: problem.user_id, scope: `problem:${problem.id}` }, { scope: `problem:${problem.id}` })) return api.fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: submission:create.');
  return createSubmission(req, res, problem, null);
});

app.post('/api/v2/problems/:id/submit-answer', receiveSubmitAnswer, async (req, res) => {
  const api = syzoj.utils.apiV2;
  const user = res.locals.user;
  try {
    if (!user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
    const problem = await Problem.findById(Number(req.params.id));
    if (!problem) return api.fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
    if (problem.type !== 'submit-answer') return api.fail(res, 409, 'PROBLEM_TYPE_MISMATCH', 'This problem does not accept answer archives.');
    if (!await problem.isAllowedUseBy(user)) return api.fail(res, 403, 'PROBLEM_FORBIDDEN', 'You cannot submit to this problem.');
    if (!await syzoj.utils.authorizationV2.authorize(user, 'submission:create', { ownerId: problem.user_id, scope: `problem:${problem.id}` }, { scope: `problem:${problem.id}` })) return api.fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: submission:create.');
    return await createSubmission(req, res, problem, null);
  } finally {
    if (req.file && req.file.path) await fs.remove(req.file.path).catch(() => {});
  }
});

app.post('/api/v2/contests/:id/problems/:pid/submissions', async (req, res) => {
  const api = syzoj.utils.apiV2;
  if (!res.locals.user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  const contest = await Contest.findById(Number(req.params.id));
  if (!contest) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  const problemId = await resolveContestProblem(contest, req.params.pid);
  if (!problemId) return api.fail(res, 404, 'CONTEST_PROBLEM_NOT_FOUND', 'The contest problem was not found.');
  const problem = await Problem.findById(problemId);
  if (!problem) return api.fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
  if (!await syzoj.utils.authorizationV2.authorize(res.locals.user, 'contest:submit', { scope: `contest:${contest.id}` }, { scope: `contest:${contest.id}` })) return api.fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: contest:submit.');
  return createSubmission(req, res, problem, contest);
});

app.post('/api/v2/contests/:id/problems/:pid/submit-answer', receiveSubmitAnswer, async (req, res) => {
  const api = syzoj.utils.apiV2;
  try {
    if (!res.locals.user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
    const contest = await Contest.findById(Number(req.params.id));
    if (!contest) return api.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
    const problemId = await resolveContestProblem(contest, req.params.pid);
    if (!problemId) return api.fail(res, 404, 'CONTEST_PROBLEM_NOT_FOUND', 'The contest problem was not found.');
    const problem = await Problem.findById(problemId);
    if (!problem) return api.fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
    if (problem.type !== 'submit-answer') return api.fail(res, 409, 'PROBLEM_TYPE_MISMATCH', 'This problem does not accept answer archives.');
    if (!await syzoj.utils.authorizationV2.authorize(res.locals.user, 'contest:submit', { scope: `contest:${contest.id}` }, { scope: `contest:${contest.id}` })) return api.fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: contest:submit.');
    return await createSubmission(req, res, problem, contest);
  } finally {
    if (req.file && req.file.path) await fs.remove(req.file.path).catch(() => {});
  }
});

app.get('/api/v2/submissions', async (req, res) => {
  const api = syzoj.utils.apiV2;
  if (!res.locals.user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  await ensureSubmissionSchema();
  const limit = api.parseLimit(req, 50, 100);
  const descending = String(req.query.order || '').toLowerCase() === 'desc';
  const decodedCursor = api.decodeCursor(req.query.cursor);
  const cursor = decodedCursor == null ? (descending ? Number.MAX_SAFE_INTEGER : 0) : Number(decodedCursor);
  const canReadAll = await syzoj.utils.authorizationV2.authorize(res.locals.user, 'judge:read', null, {});
  const ownOnly = req.query.scope === 'mine' || !canReadAll;
  const cursorOperator = descending ? '<' : '>';
  const orderDirection = descending ? 'DESC' : 'ASC';
  const params = ownOnly ? [res.locals.user.id, cursor, limit + 1] : [cursor, limit + 1];
  const rows = await TypeORM.getConnection().query(
    `SELECT projection.*,
            CASE WHEN projection.contest_id IS NOT NULL
              THEN COALESCE(JSON_UNQUOTE(JSON_EXTRACT(current_version.content_json,'$.title')),problem.title)
              ELSE problem.title END AS problem_title,
            judge.status AS legacy_status,judge.pending,judge.score,judge.total_time,judge.max_memory,judge.code_length,judge.submit_time
       FROM submission_v2_projection projection JOIN judge_state judge ON judge.id=projection.submission_id
       LEFT JOIN problem problem ON problem.id=projection.problem_id
       LEFT JOIN problem_v2_state problem_state ON problem_state.problem_id=projection.problem_id
       LEFT JOIN problem_v2_version current_version ON current_version.id=problem_state.current_version_id
      WHERE ${ownOnly ? 'projection.user_id=? AND ' : ''} projection.submission_id${cursorOperator}? ORDER BY projection.submission_id ${orderDirection} LIMIT ?`,
    params
  );
  for (const row of rows) {
    const legacyJudge = { id: row.submission_id, user_id: row.user_id, status: row.legacy_status, pending: row.pending };
    const nextStatus = statusForJudge(legacyJudge, row.status);
    if (nextStatus !== row.status) await projectStatus(legacyJudge);
    row.status = nextStatus;
  }
  const hasMore = rows.length > limit;
  res.locals.apiMeta.next_cursor = hasMore ? api.encodeCursor(rows[limit - 1].submission_id) : null;
  res.locals.apiMeta.limit = limit;
  return api.send(res, rows.slice(0, limit).map(row => publicSubmission(row, res.locals.user.id)));
});

app.get('/api/v2/submissions/:id', async (req, res) => {
  const api = syzoj.utils.apiV2;
  if (!res.locals.user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  const judge = await JudgeState.findById(Number(req.params.id));
  if (!judge) return api.fail(res, 404, 'SUBMISSION_NOT_FOUND', 'Submission was not found.');
  if (!await canViewSubmission(judge, res.locals.user)) return api.fail(res, 403, 'SUBMISSION_FORBIDDEN', 'You cannot view this submission.');
  await ensureSubmissionSchema();
  await projectStatus(judge);
  const rows = await TypeORM.getConnection().query(
    `SELECT projection.*,
            CASE WHEN projection.contest_id IS NOT NULL
              THEN COALESCE(JSON_UNQUOTE(JSON_EXTRACT(current_version.content_json,'$.title')),problem.title)
              ELSE problem.title END AS problem_title,
            judge.status AS legacy_status,judge.pending,judge.score,judge.total_time,judge.max_memory,judge.code_length,judge.submit_time,judge.code,judge.result,judge.compilation,
            code_version.source_hash,code_version.source_code AS version_source
       FROM submission_v2_projection projection JOIN judge_state judge ON judge.id=projection.submission_id
       LEFT JOIN problem problem ON problem.id=projection.problem_id
       LEFT JOIN problem_v2_state problem_state ON problem_state.problem_id=projection.problem_id
       LEFT JOIN problem_v2_version current_version ON current_version.id=problem_state.current_version_id
       LEFT JOIN submission_v2_code_version code_version ON code_version.id=projection.code_version_id
      WHERE projection.submission_id=? LIMIT 1`,
    [judge.id]
  );
  if (!rows.length) return api.fail(res, 409, 'SUBMISSION_PROJECTION_MISSING', 'Submission projection is not ready.');
  const row = rows[0];
  const canReadAll = await syzoj.utils.authorizationV2.authorize(res.locals.user, 'judge:read', null, {});
  return api.send(res, Object.assign(publicSubmission(row, res.locals.user.id, { includeCode: true, canReadAll }), { result: Number(res.locals.user.id) === Number(judge.user_id) || canReadAll ? judge.result : null, compilation: Number(res.locals.user.id) === Number(judge.user_id) || canReadAll ? judge.compilation : null }));
});

app.get('/api/v2/submissions/:id/testpoints', async (req, res) => {
  const api = syzoj.utils.apiV2;
  const judge = await JudgeState.findById(Number(req.params.id));
  if (!judge || !await canViewSubmission(judge, res.locals.user)) return api.fail(res, judge ? 403 : 404, judge ? 'SUBMISSION_FORBIDDEN' : 'SUBMISSION_NOT_FOUND', judge ? 'You cannot view these testpoints.' : 'Submission was not found.');
  const canReadDiagnostics = await canViewSubmissionDiagnostics(judge, res.locals.user);
  return api.send(res, { submission_id: Number(judge.id), status: judgeStatus.statusForJudge(judge), testpoints: canReadDiagnostics ? judge.result || null : null });
});

app.get('/api/v2/submissions/:id/result-revisions', async (req, res) => {
  const api = syzoj.utils.apiV2; const user = res.locals.user;
  if (!user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  const judge = await JudgeState.findById(Number(req.params.id));
  if (!judge) return api.fail(res, 404, 'SUBMISSION_NOT_FOUND', 'Submission was not found.');
  const canReadAll = await syzoj.utils.authorizationV2.authorize(user, 'judge:read', null, {});
  if (Number(judge.user_id) !== Number(user.id) && !canReadAll) return api.fail(res, 403, 'SUBMISSION_FORBIDDEN', 'You cannot view historical results for this submission.');
  await ensureSubmissionSchema(); const limit = api.parseLimit(req, 30, 100); const cursor = Number(api.decodeCursor(req.query.cursor) || 0);
  const rows = await TypeORM.getConnection().query(`SELECT id,legacy_status,pending,score,total_time,max_memory,result_json,compilation_text,created_by,reason,created_at
    FROM submission_v2_result_revision WHERE submission_id=? AND id>? ORDER BY id ASC LIMIT ?`, [judge.id, cursor, limit + 1]);
  const more = rows.length > limit; res.locals.apiMeta.next_cursor = more ? api.encodeCursor(rows[limit - 1].id) : null; res.locals.apiMeta.limit = limit;
  return api.send(res, rows.slice(0, limit).map(row => ({ id: String(row.id), submission_id: Number(judge.id), legacy_status: row.legacy_status, pending: !!row.pending, score: row.score == null ? null : Number(row.score), total_time: row.total_time == null ? null : Number(row.total_time), memory: row.max_memory == null ? null : Number(row.max_memory), result: row.result_json ? JSON.parse(row.result_json) : null, compilation: row.compilation_text || null, created_by: row.created_by == null ? null : Number(row.created_by), reason: row.reason, created_at: api.databaseIso(row.created_at) })));
});

app.get('/api/v2/submissions/:id/events', async (req, res) => {
  const api = syzoj.utils.apiV2;
  const judge = await JudgeState.findById(Number(req.params.id));
  if (!judge || !await canViewSubmission(judge, res.locals.user)) return api.fail(res, judge ? 403 : 404, judge ? 'SUBMISSION_FORBIDDEN' : 'SUBMISSION_NOT_FOUND', judge ? 'You cannot view these events.' : 'Submission was not found.');
  const canReadDiagnostics = await canViewSubmissionDiagnostics(judge, res.locals.user);
  const stream = `submission:${judge.id}`;
  return api.sse(req, res, stream, { serialize: event => {
    const visibleEvent = submissionDomain.serializeEventForViewer(event, canReadDiagnostics);
    return visibleEvent;
  } });
});

app.post('/api/v2/submissions/:id/cancel', async (req, res) => {
  const api = syzoj.utils.apiV2;
  if (!res.locals.user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  const judge = await JudgeState.findById(Number(req.params.id));
  if (!judge) return api.fail(res, 404, 'SUBMISSION_NOT_FOUND', 'Submission was not found.');
  const canManage = await syzoj.utils.authorizationV2.authorize(res.locals.user, 'submission:rejudge', null, {});
  if (Number(judge.user_id) !== Number(res.locals.user.id) && !canManage) return api.fail(res, 403, 'SUBMISSION_FORBIDDEN', 'You cannot cancel this submission.');
  if (!judge.pending && ['Accepted', 'Wrong Answer', 'Compile Error', 'Runtime Error', 'Time Limit Exceeded', 'Memory Limit Exceeded'].includes(judge.status)) return api.fail(res, 409, 'SUBMISSION_TERMINAL', 'The submission has already finished.');
  await ensureSubmissionSchema();
  const cancellationReason = String(req.body.reason || '').trim() || 'Cancelled by submitter';
  const transition = await submissionTransaction(async manager => {
    const stored = await submissionStorage.cancelSubmission(manager, {
      submission_id: judge.id, actor_id: res.locals.user.id, operator_time: Math.floor(Date.now() / 1000), reason: cancellationReason
    });
    const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
      action: 'submission:cancel', resourceType: 'submission', resourceId: judge.id,
      reason: stored.reason, details: { admin_action_id: stored.action_id }
    }, manager);
    const result = await submissionDomain.transitionProjection(manager, {
      submissionId: judge.id,
      status: 'cancelled',
      operation: 'cancel',
      actorId: res.locals.user.id,
      reason: stored.reason,
      eventType: 'submission.cancelled',
      patch: { dispatch_enabled: false, dispatch_lease_until: null, next_retry_at: null },
      payload: { audit_event_id: auditEventId }
    });
    result.auditEventId = auditEventId;
    result.stored = stored;
    return result;
  });
  Object.assign(judge, transition.stored.judge);
  const auditEventId = transition.auditEventId;
  return api.send(res, { submission_id: Number(judge.id), status: 'cancelled', audit_event_id: auditEventId });
});

async function snapshotSubmissionResult(manager, judge, actorId, reason) {
  const result = await manager.query(`INSERT INTO submission_v2_result_revision
    (submission_id,legacy_status,pending,score,total_time,max_memory,result_json,compilation_text,created_by,reason,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`, [judge.id, judge.status || null, judge.pending ? 1 : 0,
    judge.score == null ? null : judge.score, judge.total_time == null ? null : judge.total_time,
    judge.max_memory == null ? null : judge.max_memory, JSON.stringify(judge.result == null ? null : judge.result),
    judge.compilation == null ? null : String(judge.compilation), actorId || null, reason]);
  return String(result.insertId);
}

async function rejudgeWithCurrentSnapshot(judge, actorId) {
  const connection = TypeORM.getConnection();
  await judge.loadRelationships();
  const contest = Number(judge.type) === 1 ? await Contest.findById(Number(judge.type_info)) : null;
  const snapshotId = await resolveSubmissionSnapshot(judge.problem, contest, actorId);
  const executionProblem = await immutableExecutionProblem(judge.problem, snapshotId);
  await connection.query('UPDATE submission_v2_projection SET snapshot_id=?,updated_at=UTC_TIMESTAMP(3) WHERE submission_id=?', [snapshotId, judge.id]);
  await syzoj.utils.lock(['JudgeState::rejudge', judge.id], async () => {
    judge.status = 'Unknown';
    judge.pending = false;
    judge.score = null;
    if (judge.language) {
      judge.total_time = null;
      judge.max_memory = null;
    }
    judge.result = {};
    judge.task_id = require('randomstring').generate(10);
    await judge.save();
    await judge.updateRelatedInfo(false);
    await Judger.judge(judge, executionProblem, contest ? 3 : 2, { snapshotId });
    judge.pending = true;
    judge.status = 'Waiting';
    await judge.save();
  });
  return snapshotId;
}

syzoj.utils.rejudgeSubmissionWithCurrentSnapshot = rejudgeWithCurrentSnapshot;

async function runRejudgeJob(jobId) {
  const connection = TypeORM.getConnection();
  try {
    const claimed = await connection.query("UPDATE submission_v2_job SET state='running',progress=10,updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state='queued'", [jobId]);
    if (!claimed.affectedRows) return;
    const jobs = await connection.query('SELECT * FROM submission_v2_job WHERE id=? LIMIT 1', [jobId]); const job = jobs[0];
    if (job.cancel_requested) return connection.query("UPDATE submission_v2_job SET state='cancelled',progress=0,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
    const judge = await JudgeState.findById(Number(job.submission_id)); if (!judge) throw new Error('Submission was not found.');
    const revisionId = await connection.transaction(manager => snapshotSubmissionResult(manager, judge, job.actor_id, job.reason));
    await connection.query("UPDATE submission_v2_job SET progress=40,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
    const controls = await connection.query('SELECT cancel_requested FROM submission_v2_job WHERE id=? LIMIT 1', [jobId]);
    if (!controls.length || controls[0].cancel_requested) {
      await connection.query("UPDATE submission_v2_job SET state='cancelled',progress=40,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
      return;
    }
    await rejudgeWithCurrentSnapshot(judge, job.actor_id);
    await submissionTransaction(async manager => {
      const projections = await manager.query('SELECT attempts FROM submission_v2_projection WHERE submission_id=? LIMIT 1 FOR UPDATE', [judge.id]);
      const result = await submissionDomain.transitionProjection(manager, {
        submissionId: judge.id,
        status: 'queued',
        allowTerminalReset: true,
        operation: 'rejudge',
        actorId: job.actor_id,
        reason: job.reason,
        eventType: 'submission.rejudged',
        patch: {
          attempts: Number(projections[0] && projections[0].attempts || 0) + 1,
          dispatch_enabled: false,
          dispatch_lease_until: null,
          last_error: null,
          next_retry_at: null
        },
        payload: { job_id: jobId, revision_id: revisionId, audit_event_id: job.audit_event_id }
      });
      await manager.query("UPDATE submission_v2_job SET state='completed',progress=100,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
      return result;
    });
    await syzoj.utils.apiV2.appendEvent({ stream: `submission-job:${jobId}`, type: 'submission.rejudge.completed', aggregateId: jobId, actor: { id: job.actor_id }, payload: { submission_id: Number(judge.id), revision_id: revisionId } });
  } catch (error) {
    await connection.query("UPDATE submission_v2_job SET state='failed',error_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [JSON.stringify({ code: 'REJUDGE_FAILED', message: String(error.message || error).slice(0, 500) }), jobId]);
    await syzoj.utils.apiV2.appendEvent({ stream: `submission-job:${jobId}`, type: 'submission.rejudge.failed', aggregateId: jobId, payload: { code: 'REJUDGE_FAILED' } }).catch(() => {});
  }
}

app.post('/api/v2/submissions/:id/rejudge', async (req, res) => {
  const api = syzoj.utils.apiV2;
  if (!res.locals.user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  const reason = syzoj.utils.operationReason(req, '重新评测提交');
  const allowed = await syzoj.utils.authorizationV2.authorize(res.locals.user, 'submission:rejudge', null, {});
  if (!allowed) return api.fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: submission:rejudge.');
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api.fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again or complete MFA before rejudging a submission.');
  const judge = await JudgeState.findById(Number(req.params.id));
  if (!judge) return api.fail(res, 404, 'SUBMISSION_NOT_FOUND', 'Submission was not found.');
  await ensureSubmissionSchema();
  const jobId = crypto.randomUUID();
  const queued = await TypeORM.getConnection().transaction(async manager => {
    await manager.query("INSERT INTO submission_v2_job (id,submission_id,kind,state,progress,actor_id,reason,created_at,updated_at) VALUES (?,?,'rejudge','queued',0,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [jobId, judge.id, res.locals.user.id, reason]);
    const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
      action: 'submission:rejudge', resourceType: 'submission', resourceId: judge.id,
      reason, details: { job_id: jobId }
    }, manager);
    await manager.query('UPDATE submission_v2_job SET audit_event_id=? WHERE id=?', [auditEventId, jobId]);
    const event = await submissionDomain.appendEvent(manager, {
      stream: `submission-job:${jobId}`, type: 'submission.rejudge.queued', aggregateId: jobId,
      actorId: res.locals.user.id, payload: { submission_id: Number(judge.id), audit_event_id: auditEventId }
    });
    return { auditEventId, event };
  });
  api.publishEvent(queued.event);
  const auditEventId = queued.auditEventId;
  setImmediate(() => runRejudgeJob(jobId));
  return api.send(res, { id: jobId, kind: 'submission_rejudge', submission_id: Number(judge.id), state: 'queued', progress: 0, audit_event_id: auditEventId }, 202);
});

async function runProjectionRebuildJob(jobId) {
  const connection = TypeORM.getConnection();
  try {
    const claimed = await connection.query("UPDATE submission_v2_job SET state='running',progress=20,updated_at=UTC_TIMESTAMP(3) WHERE id=? AND kind='projection_rebuild' AND state='queued'", [jobId]);
    if (!claimed.affectedRows) return;
    const jobs = await connection.query('SELECT * FROM submission_v2_job WHERE id=? LIMIT 1', [jobId]);
    const job = jobs[0];
    if (!job || job.cancel_requested) {
      await connection.query("UPDATE submission_v2_job SET state='cancelled',updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
      return;
    }
    const rebuilt = await submissionTransaction(async manager => {
      const controls = await manager.query('SELECT cancel_requested FROM submission_v2_job WHERE id=? LIMIT 1 FOR UPDATE', [jobId]);
      if (!controls.length || controls[0].cancel_requested) {
        await manager.query("UPDATE submission_v2_job SET state='cancelled',progress=20,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
        return { cancelled: true };
      }
      await manager.query("UPDATE submission_v2_job SET progress=60,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
      const result = await submissionDomain.rebuildProjection(manager, {
        submissionId: job.submission_id,
        actorId: job.actor_id,
        reason: job.reason,
        auditEventId: job.audit_event_id
      });
      await manager.query("UPDATE submission_v2_job SET state='completed',progress=100,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
      return result;
    });
    if (rebuilt.cancelled) return;
    await syzoj.utils.apiV2.appendEvent({
      stream: `submission-job:${jobId}`, type: 'submission.projection_rebuild.completed',
      aggregateId: jobId, actor: { id: job.actor_id },
      payload: { submission_id: Number(job.submission_id), replayed_event_count: rebuilt.replayedEventCount }
    });
  } catch (error) {
    await connection.query("UPDATE submission_v2_job SET state='failed',error_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [JSON.stringify({ code: 'PROJECTION_REBUILD_FAILED', message: String(error.message || error).slice(0, 500) }), jobId]);
    await syzoj.utils.apiV2.appendEvent({
      stream: `submission-job:${jobId}`, type: 'submission.projection_rebuild.failed', aggregateId: jobId,
      payload: { code: 'PROJECTION_REBUILD_FAILED' }
    }).catch(() => {});
  }
}

async function runSubmissionJob(jobId) {
  await ensureSubmissionSchema();
  const rows = await TypeORM.getConnection().query('SELECT kind FROM submission_v2_job WHERE id=? LIMIT 1', [jobId]);
  if (!rows.length) return;
  if (rows[0].kind === 'projection_rebuild') return runProjectionRebuildJob(jobId);
  return runRejudgeJob(jobId);
}

async function recoverSubmissionJobs() {
  try {
    await ensureSubmissionSchema();
    const connection = TypeORM.getConnection();
    const jobs = await connection.query(`SELECT id,kind,state,cancel_requested
      FROM submission_v2_job
      WHERE state IN ('queued','running','cancelling')
      ORDER BY created_at ASC`);
    for (const job of jobs) {
      const nextState = submissionDomain.recoveryDisposition(job.kind, job.state, !!job.cancel_requested);
      if (nextState !== job.state) {
        const errorJson = nextState === 'failed'
          ? JSON.stringify({ code: 'REJUDGE_INTERRUPTED', message: 'The rejudge worker restarted before completion. Retry this job explicitly.' })
          : null;
        await connection.query('UPDATE submission_v2_job SET state=?,error_json=COALESCE(?,error_json),updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state=?', [nextState, errorJson, job.id, job.state]);
        await syzoj.utils.apiV2.appendEvent({
          stream: `submission-job:${job.id}`,
          type: nextState === 'queued' ? 'submission.job.recovered' : nextState === 'cancelled' ? 'submission.job.cancelled' : 'submission.rejudge.interrupted',
          aggregateId: job.id,
          payload: { kind: job.kind, previous_state: job.state, state: nextState }
        });
      }
      if (nextState === 'queued') setImmediate(() => runSubmissionJob(job.id));
    }
  } catch (error) {
    syzoj.log(`[submission-v2] job recovery failed: ${error.message || error}`);
  }
}

app.post('/api/v2/admin/submissions/:id/projection-rebuild', async (req, res) => {
  const api = syzoj.utils.apiV2;
  const actor = res.locals.user;
  if (!actor) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!await syzoj.utils.authorizationV2.authorize(actor, 'submission:rejudge', null, {})) {
    return api.fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: submission:rejudge.');
  }
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) {
    return api.fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again or complete MFA before rebuilding a projection.');
  }
  const judge = await JudgeState.findById(Number(req.params.id));
  if (!judge) return api.fail(res, 404, 'SUBMISSION_NOT_FOUND', 'Submission was not found.');
  await ensureSubmissionSchema();
  const jobId = crypto.randomUUID();
  const reason = String(req.body && req.body.reason || '').trim() || '重建提交事件投影';
  const queued = await TypeORM.getConnection().transaction(async manager => {
    await manager.query("INSERT INTO submission_v2_job (id,submission_id,kind,state,progress,actor_id,reason,created_at,updated_at) VALUES (?,?,'projection_rebuild','queued',0,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [jobId, judge.id, actor.id, reason]);
    const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
      action: 'submission:projection.rebuild', resourceType: 'submission', resourceId: judge.id,
      reason, details: { job_id: jobId }
    }, manager);
    await manager.query('UPDATE submission_v2_job SET audit_event_id=? WHERE id=?', [auditEventId, jobId]);
    const event = await submissionDomain.appendEvent(manager, {
      stream: `submission-job:${jobId}`, type: 'submission.projection_rebuild.queued', aggregateId: jobId,
      actorId: actor.id, payload: { submission_id: Number(judge.id), audit_event_id: auditEventId }
    });
    return { auditEventId, event };
  });
  api.publishEvent(queued.event);
  setImmediate(() => runProjectionRebuildJob(jobId));
  return api.send(res, {
    id: jobId, kind: 'submission_projection_rebuild', submission_id: Number(judge.id),
    state: 'queued', progress: 0, audit_event_id: queued.auditEventId
  }, 202);
});

async function projectOpenSubmissions() {
  try {
    await ensureSubmissionSchema();
    const rows = await TypeORM.getConnection().query(
      `SELECT projection.submission_id,judge.* FROM submission_v2_projection projection JOIN judge_state judge ON judge.id=projection.submission_id
        WHERE projection.status IN ('created','queued','compiling','judging')
           OR (projection.status='system_error' AND projection.attempts<2)
        ORDER BY projection.updated_at ASC LIMIT 100`
    );
    for (const judge of rows) await projectStatus(judge);
  } catch (error) {
    syzoj.log(`[submission-v2] projection failed: ${error.message}`);
  }
}

ensureSubmissionSchema().then(() => {
  if (!projectionTimer) projectionTimer = setInterval(projectOpenSubmissions, 3000);
  if (!dispatchTimer) dispatchTimer = setInterval(dispatchQueuedSubmissions, 3000);
  setImmediate(() => recoverSubmissionJobs());
}).catch(error => syzoj.log(`[submission-v2] schema initialization failed: ${error.stack || error.message}`));

syzoj.utils.submissionV2 = {
  ensureSchema: ensureSubmissionSchema,
  projectStatus,
  projectRuntimeState,
  runRejudgeJob,
  runProjectionRebuildJob,
  runSubmissionJob,
  recoverSubmissionJobs,
  dispatchQueuedSubmission
};
