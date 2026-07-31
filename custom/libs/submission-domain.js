'use strict';

const crypto = require('crypto');

const ACTIVE_STATUSES = Object.freeze(['created', 'queued', 'compiling', 'judging']);
const TERMINAL_STATUSES = Object.freeze([
  'accepted', 'wrong_answer', 'compile_error', 'runtime_error', 'time_limit', 'memory_limit',
  'output_limit', 'file_error', 'invalid_interaction', 'partially_correct', 'system_error', 'cancelled'
]);
const STATUS_SET = new Set(ACTIVE_STATUSES.concat(TERMINAL_STATUSES));
const TERMINAL_SET = new Set(TERMINAL_STATUSES);
const PUBLIC_EVENT_FIELDS = Object.freeze([
  'submission_id', 'problem_id', 'contest_id', 'language', 'code_version_id', 'source_visibility',
  'status', 'created_at', 'updated_at'
]);

function domainError(code, message, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function positiveId(value, field = 'submission_id') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw domainError('VALIDATION_FAILED', `${field} must be a positive integer.`, 422);
  }
  return id;
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (!STATUS_SET.has(status)) {
    throw domainError('SUBMISSION_STATUS_INVALID', `Unsupported submission status: ${status || '(empty)'}.`, 422);
  }
  return status;
}

function normalizeSourceVisibility(value) {
  const visibility = value == null || value === '' ? 'private' : String(value).trim().toLowerCase();
  if (!['private', 'public'].includes(visibility)) {
    throw domainError('VALIDATION_FAILED', 'source_visibility must be private or public.', 422);
  }
  return visibility;
}

function sourceVisibleTo(input = {}) {
  if (input.canReadAll === true) return true;
  if (Number(input.ownerId) > 0 && Number(input.ownerId) === Number(input.viewerId)) return true;
  return normalizeSourceVisibility(input.visibility) === 'public';
}

function canTransition(from, to, options = {}) {
  const target = normalizeStatus(to);
  if (from == null) return target === 'created';
  const source = normalizeStatus(from);
  if (source === target) return true;
  if (TERMINAL_SET.has(source)) return target === 'queued' && options.allowTerminalReset === true;
  if (target === 'created') return false;
  return true;
}

function assertTransition(from, to, options = {}) {
  if (!canTransition(from, to, options)) {
    throw domainError('SUBMISSION_TRANSITION_INVALID', `Submission cannot transition from ${from == null ? '(none)' : from} to ${to}.`);
  }
  return normalizeStatus(to);
}

function retryDelaySeconds(attempt) {
  const normalized = Math.max(1, Math.min(7, Number.parseInt(attempt, 10) || 1));
  return Math.min(300, 5 * Math.pow(2, normalized));
}

function shouldRetryAutomatically(status, attempts, maximumAttempts = 2) {
  return normalizeStatus(status) === 'system_error' && Number(attempts || 0) < Number(maximumAttempts);
}

function recoveryDisposition(kind, state, cancelRequested = false) {
  const normalizedKind = String(kind || '');
  const normalizedState = String(state || '');
  if (cancelRequested) return 'cancelled';
  if (!['running', 'cancelling'].includes(normalizedState)) return normalizedState;
  if (normalizedKind === 'projection_rebuild') return 'queued';
  if (normalizedKind === 'rejudge') return 'failed';
  return normalizedState;
}

function parsePayload(event) {
  if (event && event.payload && typeof event.payload === 'object') return event.payload;
  if (!event || event.payload_json == null) return {};
  if (typeof event.payload_json === 'object') return event.payload_json;
  try {
    return JSON.parse(String(event.payload_json));
  } catch (error) {
    throw domainError('SUBMISSION_EVENT_INVALID', `Submission event ${event.id || '(unknown)'} has invalid JSON.`);
  }
}

function serializeEventForViewer(event, includeDiagnostics = false) {
  const payload = parsePayload(event);
  const visiblePayload = includeDiagnostics ? { ...payload } : PUBLIC_EVENT_FIELDS.reduce((result, field) => {
    if (own(payload, field)) result[field] = payload[field];
    return result;
  }, {});
  const result = {
    id: String(event.id), stream: event.stream, type: event.type,
    aggregate_id: event.aggregate_id == null ? null : String(event.aggregate_id),
    payload: visiblePayload, created_at: event.created_at
  };
  if (includeDiagnostics) result.actor_id = event.actor_id == null ? null : Number(event.actor_id);
  return result;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function stateFromPayload(payload, fallback = {}) {
  return {
    submission_id: numberOr(payload.submission_id, numberOr(fallback.submission_id, null)),
    problem_id: numberOr(payload.problem_id, numberOr(fallback.problem_id, null)),
    snapshot_id: own(payload, 'snapshot_id') ? (payload.snapshot_id == null ? null : String(payload.snapshot_id)) : fallback.snapshot_id || null,
    code_version_id: own(payload, 'code_version_id') ? (payload.code_version_id == null ? null : String(payload.code_version_id)) : fallback.code_version_id || null,
    user_id: numberOr(payload.user_id, numberOr(fallback.user_id, null)),
    contest_id: own(payload, 'contest_id') ? nullableNumber(payload.contest_id, null) : nullableNumber(fallback.contest_id, null),
    language: own(payload, 'language') ? (payload.language == null ? null : String(payload.language)) : fallback.language || null,
    source_visibility: own(payload, 'source_visibility') ? String(payload.source_visibility || 'private') : fallback.source_visibility || 'private',
    status: normalizeStatus(payload.status || fallback.status || 'created'),
    attempts: Math.max(0, numberOr(payload.attempts, numberOr(fallback.attempts, 0))),
    last_error: own(payload, 'last_error') ? (payload.last_error == null ? null : String(payload.last_error)) : fallback.last_error || null,
    next_retry_at: own(payload, 'next_retry_at') ? payload.next_retry_at : fallback.next_retry_at || null,
    dispatch_attempts: Math.max(0, numberOr(payload.dispatch_attempts, numberOr(fallback.dispatch_attempts, 0))),
    dispatch_lease_until: own(payload, 'dispatch_lease_until') ? payload.dispatch_lease_until : fallback.dispatch_lease_until || null,
    dispatch_enabled: payload.dispatch_enabled == null ? !!fallback.dispatch_enabled : !!payload.dispatch_enabled,
    created_at: payload.created_at || fallback.created_at || null,
    updated_at: payload.updated_at || fallback.updated_at || null
  };
}

function applyStatus(state, status, options = {}) {
  if (!state) throw domainError('SUBMISSION_EVENT_BASELINE_MISSING', 'Submission events require a created or seeded baseline.');
  const nextStatus = assertTransition(state.status, status, options);
  return { ...state, status: nextStatus };
}

function reduceSubmissionEvent(state, event) {
  const type = String(event && event.type || '');
  const payload = parsePayload(event);
  if (type === 'submission.projection.seeded') return stateFromPayload(payload, state || {});
  if (type === 'submission.code_version.backfilled') return stateFromPayload(payload, state || {});
  if (type === 'submission.created') {
    if (state) throw domainError('SUBMISSION_EVENT_DUPLICATE_BASELINE', 'Submission stream contains more than one created event.');
    return stateFromPayload({ ...payload, status: 'created' });
  }
  if (type === 'submission.projection.rebuilt') return state;
  if (type === 'submission.status.changed') return stateFromPayload(payload, applyStatus(state, payload.status));
  if (type === 'submission.queued') {
    return stateFromPayload(payload, applyStatus(state, 'queued', { allowTerminalReset: payload.retry_kind === 'system_error' }));
  }
  if (type === 'submission.dispatched') {
    return stateFromPayload({ ...payload, status: 'queued', dispatch_enabled: false, last_error: null, next_retry_at: null, dispatch_lease_until: null }, applyStatus(state, 'queued'));
  }
  if (type === 'submission.dispatch_failed') {
    const fallback = applyStatus(state, 'queued');
    return stateFromPayload({
      ...payload,
      status: 'queued',
      dispatch_enabled: true,
      dispatch_attempts: payload.dispatch_attempts == null ? Number(fallback.dispatch_attempts || 0) + 1 : payload.dispatch_attempts,
      last_error: payload.error_code || 'JUDGE_DISPATCH_UNAVAILABLE',
      dispatch_lease_until: null
    }, fallback);
  }
  if (type === 'submission.cancelled') {
    return stateFromPayload({ ...payload, status: 'cancelled', dispatch_enabled: false, next_retry_at: null, dispatch_lease_until: null }, applyStatus(state, 'cancelled'));
  }
  if (type === 'submission.rejudged' || type === 'submission.system_retry.queued') {
    const fallback = applyStatus(state, 'queued', { allowTerminalReset: true });
    return stateFromPayload({
      ...payload,
      status: 'queued',
      attempts: payload.attempts == null ? Number(fallback.attempts || 0) + 1 : payload.attempts,
      dispatch_enabled: payload.dispatch_enabled == null ? false : payload.dispatch_enabled,
      last_error: null,
      next_retry_at: null,
      dispatch_lease_until: null
    }, fallback);
  }
  return state;
}

function replaySubmissionEvents(events) {
  const ordered = Array.from(events || []).slice().sort((left, right) => Number(left.id || 0) - Number(right.id || 0));
  const state = ordered.reduce(reduceSubmissionEvent, null);
  if (!state) throw domainError('SUBMISSION_EVENT_BASELINE_MISSING', 'Submission stream has no created or seeded baseline.');
  positiveId(state.submission_id);
  positiveId(state.problem_id, 'problem_id');
  positiveId(state.user_id, 'user_id');
  return state;
}

async function appendEvent(manager, input) {
  const result = await manager.query(
    `INSERT INTO api_v2_event (stream,type,aggregate_id,actor_id,payload_json,created_at)
     VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))`,
    [input.stream, input.type, input.aggregateId == null ? null : String(input.aggregateId), input.actorId || null, JSON.stringify(input.payload || {})]
  );
  return {
    id: String(result.insertId), stream: input.stream, type: input.type,
    aggregate_id: input.aggregateId == null ? null : String(input.aggregateId),
    actor_id: input.actorId || null, payload: input.payload || {}, created_at: new Date().toISOString()
  };
}

async function appendAttempt(manager, input) {
  const result = await manager.query(
    `INSERT INTO submission_v2_attempt
       (submission_id,operation,actor_id,reason,old_status,new_status,created_at)
     VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3))`,
    [input.submissionId, input.operation, input.actorId || null, input.reason || null, input.oldStatus || null, input.newStatus || null]
  );
  return String(result.insertId);
}

function own(value, field) {
  return Object.prototype.hasOwnProperty.call(value || {}, field);
}

function projectionPatch(current, input) {
  const patch = input.patch || {};
  const status = assertTransition(current.status, input.status, { allowTerminalReset: input.allowTerminalReset === true });
  return {
    status,
    attempts: own(patch, 'attempts') ? Number(patch.attempts) : Number(current.attempts || 0),
    last_error: own(patch, 'last_error') ? patch.last_error : current.last_error,
    next_retry_at: own(patch, 'next_retry_at') ? patch.next_retry_at : current.next_retry_at,
    dispatch_attempts: own(patch, 'dispatch_attempts') ? Number(patch.dispatch_attempts) : Number(current.dispatch_attempts || 0),
    dispatch_lease_until: own(patch, 'dispatch_lease_until') ? patch.dispatch_lease_until : current.dispatch_lease_until,
    dispatch_enabled: own(patch, 'dispatch_enabled') ? !!patch.dispatch_enabled : !!current.dispatch_enabled
  };
}

async function transitionProjection(manager, input) {
  const submissionId = positiveId(input.submissionId);
  const rows = await manager.query('SELECT * FROM submission_v2_projection WHERE submission_id=? LIMIT 1 FOR UPDATE', [submissionId]);
  if (!rows.length) throw domainError('SUBMISSION_PROJECTION_MISSING', 'Submission projection was not found.', 404);
  const current = rows[0];
  const next = projectionPatch(current, input);
  await manager.query(
    `UPDATE submission_v2_projection
        SET status=?,attempts=?,last_error=?,next_retry_at=?,dispatch_attempts=?,dispatch_lease_until=?,dispatch_enabled=?,updated_at=UTC_TIMESTAMP(3)
      WHERE submission_id=?`,
    [next.status, next.attempts, next.last_error, next.next_retry_at, next.dispatch_attempts, next.dispatch_lease_until, next.dispatch_enabled ? 1 : 0, submissionId]
  );
  const attemptId = input.operation ? await appendAttempt(manager, {
    submissionId, operation: input.operation, actorId: input.actorId, reason: input.reason,
    oldStatus: current.status, newStatus: next.status
  }) : null;
  const payload = {
    submission_id: submissionId, old_status: current.status, status: next.status,
    attempts: next.attempts, last_error: next.last_error, next_retry_at: next.next_retry_at,
    dispatch_attempts: next.dispatch_attempts, dispatch_lease_until: next.dispatch_lease_until,
    dispatch_enabled: next.dispatch_enabled, ...(input.payload || {})
  };
  if (attemptId) payload.attempt_id = attemptId;
  const event = await appendEvent(manager, {
    stream: `submission:${submissionId}`, type: input.eventType || 'submission.status.changed',
    aggregateId: submissionId, actorId: input.actorId, payload
  });
  return { current, projection: { ...current, ...next }, attemptId, event };
}

async function createCodeVersion(manager, input) {
  const submissionId = positiveId(input.submissionId);
  const userId = positiveId(input.userId, 'user_id');
  const source = String(input.source == null ? '' : input.source);
  if (!source.trim()) throw domainError('VALIDATION_FAILED', 'Source code is required.', 422);
  const id = String(input.id || crypto.randomUUID());
  const visibility = normalizeSourceVisibility(input.sourceVisibility);
  const sourceHash = crypto.createHash('sha256').update(source).digest('hex');
  await manager.query(
    `INSERT INTO submission_v2_code_version
       (id,submission_id,user_id,language,source_hash,source_code,visibility,created_at)
     VALUES (?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`,
    [id, submissionId, userId, input.language || null, sourceHash, source, visibility]
  );
  return { id, submission_id: submissionId, user_id: userId, language: input.language || null, source_hash: sourceHash, visibility };
}

async function createProjection(manager, input) {
  const submissionId = positiveId(input.submissionId);
  const problemId = positiveId(input.problemId, 'problem_id');
  const userId = positiveId(input.userId, 'user_id');
  const visibility = normalizeSourceVisibility(input.sourceVisibility);
  const codeVersionId = String(input.codeVersionId || '').trim();
  if (!codeVersionId) throw domainError('VALIDATION_FAILED', 'code_version_id is required.', 422);
  await manager.query(
    `INSERT INTO submission_v2_projection
       (submission_id,problem_id,snapshot_id,code_version_id,user_id,contest_id,language,source_visibility,status,attempts,last_error,next_retry_at,dispatch_attempts,dispatch_lease_until,dispatch_enabled,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,'created',0,NULL,NULL,0,NULL,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
    [submissionId, problemId, input.snapshotId || null, codeVersionId, userId, input.contestId || null, input.language || null, visibility]
  );
  const attemptId = await appendAttempt(manager, {
    submissionId, operation: 'create', actorId: input.actorId || userId, oldStatus: null, newStatus: 'created'
  });
  const payload = {
    submission_id: submissionId, problem_id: problemId, snapshot_id: input.snapshotId || null, code_version_id: codeVersionId,
    user_id: userId, contest_id: input.contestId || null, language: input.language || null,
    source_visibility: visibility, status: 'created', attempts: 0, dispatch_attempts: 0,
    dispatch_enabled: true, attempt_id: attemptId
  };
  const event = await appendEvent(manager, {
    stream: `submission:${submissionId}`, type: 'submission.created', aggregateId: submissionId,
    actorId: input.actorId || userId, payload
  });
  return { projection: payload, attemptId, event };
}

function projectionValues(state) {
  return [state.problem_id, state.snapshot_id, state.code_version_id, state.user_id, state.contest_id, state.language,
    state.source_visibility, state.status, state.attempts, state.last_error, state.next_retry_at,
    state.dispatch_attempts, state.dispatch_lease_until, state.dispatch_enabled ? 1 : 0];
}

async function rebuildProjection(manager, input) {
  const submissionId = positiveId(input.submissionId);
  const currentRows = await manager.query('SELECT * FROM submission_v2_projection WHERE submission_id=? LIMIT 1 FOR UPDATE', [submissionId]);
  const eventRows = await manager.query(
    'SELECT id,stream,type,aggregate_id,actor_id,payload_json,created_at FROM api_v2_event WHERE stream=? ORDER BY id ASC FOR UPDATE',
    [`submission:${submissionId}`]
  );
  const state = replaySubmissionEvents(eventRows);
  if (Number(state.submission_id) !== submissionId) {
    throw domainError('SUBMISSION_EVENT_AGGREGATE_MISMATCH', 'Submission event stream belongs to another aggregate.');
  }
  const values = projectionValues(state);
  const previousStatus = currentRows.length ? currentRows[0].status : null;
  if (currentRows.length) {
    await manager.query(
      `UPDATE submission_v2_projection
          SET problem_id=?,snapshot_id=?,code_version_id=?,user_id=?,contest_id=?,language=?,source_visibility=?,status=?,attempts=?,last_error=?,next_retry_at=?,dispatch_attempts=?,dispatch_lease_until=?,dispatch_enabled=?,updated_at=UTC_TIMESTAMP(3)
        WHERE submission_id=?`,
      values.concat(submissionId)
    );
  } else {
    await manager.query(
      `INSERT INTO submission_v2_projection
         (problem_id,snapshot_id,code_version_id,user_id,contest_id,language,source_visibility,status,attempts,last_error,next_retry_at,dispatch_attempts,dispatch_lease_until,dispatch_enabled,submission_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?,UTC_TIMESTAMP(3)),UTC_TIMESTAMP(3))`,
      values.concat(submissionId, state.created_at)
    );
  }
  const attemptId = await appendAttempt(manager, {
    submissionId, operation: 'projection_rebuild', actorId: input.actorId, reason: input.reason,
    oldStatus: previousStatus, newStatus: state.status
  });
  const event = await appendEvent(manager, {
    stream: `submission:${submissionId}`, type: 'submission.projection.rebuilt', aggregateId: submissionId,
    actorId: input.actorId,
    payload: { submission_id: submissionId, status: state.status, previous_status: previousStatus,
      replayed_event_count: eventRows.length, attempt_id: attemptId, audit_event_id: input.auditEventId || null }
  });
  return { projection: state, previousStatus, replayedEventCount: eventRows.length, attemptId, event };
}

module.exports = {
  ACTIVE_STATUSES, TERMINAL_STATUSES, appendAttempt, appendEvent, assertTransition, canTransition,
  createCodeVersion, createProjection, domainError, normalizeSourceVisibility, rebuildProjection,
  reduceSubmissionEvent, replaySubmissionEvents, recoveryDisposition, retryDelaySeconds,
  serializeEventForViewer, shouldRetryAutomatically, sourceVisibleTo, transitionProjection
};
