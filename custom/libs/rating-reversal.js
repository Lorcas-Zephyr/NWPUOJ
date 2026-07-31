'use strict';

const crypto = require('crypto');

const REVERSAL_TYPES = Object.freeze({
  cancellation: 'contest_cancelled',
  disqualification: 'contest_disqualified',
  cheating: 'contest_cheating',
  correction: 'rating_corrected'
});

function reversalError(code, message, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function overrideStatus(reversalType, eligibility) {
  if (reversalType === 'cancellation') return 'cancelled';
  if (reversalType === 'disqualification') return 'disqualified';
  if (reversalType === 'cheating') return 'cheating';
  if (reversalType === 'correction' && eligibility) return eligibility === 'eligible' ? 'eligible' : 'disqualified';
  return null;
}

async function reverseInTransaction(manager, input) {
  const originalId = Number(input.originalId);
  const reversalType = String(input.reversalType || 'correction');
  if (!Number.isSafeInteger(originalId) || originalId < 1 || !REVERSAL_TYPES[reversalType]) {
    throw reversalError('VALIDATION_FAILED', 'A valid source event and reversal type are required.', 422);
  }
  if (input.eligibility && !['eligible', 'excluded'].includes(input.eligibility)) {
    throw reversalError('VALIDATION_FAILED', 'Eligibility must be eligible or excluded.', 422);
  }
  if (typeof input.currentProjection !== 'function' || typeof input.recordAudit !== 'function') {
    throw new TypeError('Rating reversal transaction dependencies are required.');
  }

  const originals = await manager.query('SELECT * FROM rating_v2_event WHERE id=? FOR UPDATE', [originalId]);
  if (!originals.length) throw reversalError('RATING_EVENT_NOT_FOUND', 'The Rating event to reverse was not found.', 404);
  const original = originals[0];
  const requestedProfile = input.requestedProfileId == null ? original.profile_id : String(input.requestedProfileId);
  if (input.requestedUserId != null && Number(input.requestedUserId) !== Number(original.user_id)) {
    throw reversalError('RATING_USER_MISMATCH', 'The source event belongs to another user.');
  }
  if (requestedProfile !== original.profile_id) throw reversalError('RATING_PROFILE_MISMATCH', 'The source event belongs to another Rating profile.');

  const duplicate = await manager.query("SELECT id FROM rating_v2_event WHERE supersedes_event_id=? AND kind IN ('contest_cancelled','contest_disqualified','contest_cheating','rating_corrected') LIMIT 1", [originalId]);
  if (duplicate.length) throw reversalError('RATING_EVENT_ALREADY_REVERSED', 'This Rating event already has a reversal. Reverse that event to make another correction.');
  const profiles = await manager.query('SELECT * FROM rating_v2_profile WHERE id=? AND enabled=1 LIMIT 1', [original.profile_id]);
  if (!profiles.length) throw reversalError('RATING_PROFILE_INVALID', 'Rating profile is unavailable.', 422);

  const profile = profiles[0];
  const current = await input.currentProjection(manager, profile, Number(original.user_id));
  const inverseDelta = -Number(original.delta || 0);
  const after = Math.max(1, Number(current.rating) + inverseDelta);
  const source = String(input.sourceId || `rating-reverse:${originalId}:${crypto.randomUUID()}`);
  const inserted = await manager.query(`INSERT INTO rating_v2_event (profile_id,user_id,contest_id,kind,delta,rating_before,rating_after,deviation_before,deviation_after,volatility_before,volatility_after,preview_id,reason,source_event_id,job_id,supersedes_event_id,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,NULL,?,?,UTC_TIMESTAMP(3))`, [profile.id, original.user_id, original.contest_id, REVERSAL_TYPES[reversalType], after - current.rating, current.rating, after, current.deviation, current.deviation, current.volatility, current.volatility, input.reason, source, originalId, input.actorId]);
  const reversalEventId = Number(inserted.insertId);
  await manager.query(`INSERT INTO rating_v2_current (profile_id,user_id,rating,deviation,volatility,last_event_id,updated_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE rating=VALUES(rating),deviation=VALUES(deviation),volatility=VALUES(volatility),last_event_id=VALUES(last_event_id),updated_at=VALUES(updated_at)`, [profile.id, original.user_id, after, current.deviation, current.volatility, reversalEventId]);
  if (profile.id === 'icpc') await manager.query('UPDATE user SET rating=? WHERE id=?', [after, original.user_id]);

  const status = original.contest_id == null ? null : overrideStatus(reversalType, input.eligibility);
  if (status) await manager.query(`INSERT INTO rating_v2_contest_override (profile_id,contest_id,user_id,status,source_event_id,reason,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE status=VALUES(status),source_event_id=VALUES(source_event_id),reason=VALUES(reason),updated_by=VALUES(updated_by),updated_at=UTC_TIMESTAMP(3)`, [profile.id, original.contest_id, original.user_id, status, reversalEventId, input.reason, input.actorId]);
  const jobId = original.contest_id == null ? null : String(input.jobId);
  if (jobId) await manager.query("INSERT INTO rating_v2_job (id,kind,profile_id,from_contest_id,state,stage,actor_id,reason,created_at,updated_at) VALUES (?,'recalculate',?,?,'queued','preview',?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [jobId, profile.id, original.contest_id, input.actorId, input.reason]);

  const result = {
    event_id: String(reversalEventId),
    reversed_event_id: String(originalId),
    profile_id: profile.id,
    user_id: Number(original.user_id),
    contest_id: original.contest_id == null ? null : Number(original.contest_id),
    kind: REVERSAL_TYPES[reversalType],
    rating_before: Number(current.rating),
    rating_after: after,
    delta: after - Number(current.rating),
    job_id: jobId
  };
  const auditEventId = await input.recordAudit(result, manager);
  if (jobId) await manager.query('UPDATE rating_v2_job SET audit_event_id=? WHERE id=?', [auditEventId, jobId]);
  const eventPayload = { ...result, audit_event_id: String(auditEventId) };
  const stream = `rating:user:${result.user_id}`;
  const eventInsert = await manager.query(
    'INSERT INTO api_v2_event (stream,type,aggregate_id,actor_id,payload_json,created_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))',
    [stream, `rating.${reversalType}`, String(result.user_id), input.actorId, JSON.stringify(eventPayload)]
  );
  return {
    ...eventPayload,
    domain_event: {
      id: String(eventInsert.insertId),
      stream,
      type: `rating.${reversalType}`,
      aggregate_id: String(result.user_id),
      actor_id: Number(input.actorId),
      payload: eventPayload,
      created_at: new Date().toISOString()
    }
  };
}

module.exports = { REVERSAL_TYPES, overrideStatus, reverseInTransaction, reversalError };
