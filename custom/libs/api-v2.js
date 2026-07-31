'use strict';

const crypto = require('crypto');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function requestId(req) {
  const supplied = req && (req.get ? req.get('X-Request-ID') : req.headers && req.headers['x-request-id']);
  return supplied && /^[A-Za-z0-9._:-]{8,128}$/.test(String(supplied))
    ? String(supplied)
    : `req_${crypto.randomUUID().replace(/-/g, '')}`;
}

function parseLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return Math.min(fallback, MAX_LIMIT);
  return Math.min(parsed, MAX_LIMIT);
}

function encodeCursor(value) {
  if (value === undefined || value === null) return null;
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    return decoded && typeof decoded === 'object' ? decoded : null;
  } catch (error) {
    return null;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requestHash(req) {
  const body = req && req.body ? req.body : {};
  return sha256(JSON.stringify({ method: req && req.method, path: req && req.originalUrl, body }));
}

function classifyIdempotency(existing, currentRequestHash) {
  if (!existing) return { kind: 'reserve' };
  if (existing.requestHash !== currentRequestHash) return { kind: 'conflict', operation: existing };
  if (existing.status !== 'completed') return { kind: 'pending', operation: existing };
  return { kind: 'replay', operation: existing, response: existing.response };
}

function bodySize(body) {
  if (body == null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(body), 'utf8');
  } catch (error) {
    return Number.POSITIVE_INFINITY;
  }
}

function consumeFixedWindow(store, key, now, windowMs, limit) {
  let bucket = store.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    store.set(key, bucket);
  }
  bucket.count += 1;
  return {
    allowed: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt
  };
}

function etagFor(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return `"${sha256(serialized).slice(0, 32)}"`;
}

function normalizeEtag(value) {
  if (!value) return null;
  return String(value).trim().replace(/^W\//, '');
}

function ifMatchSatisfied(req, currentEtag, options = {}) {
  const header = req && (req.get ? req.get('If-Match') : req.headers && req.headers['if-match']);
  if (!header) return !options.required;
  const normalized = normalizeEtag(currentEtag);
  return String(header).split(',').map(normalizeEtag).includes(normalized) || String(header).trim() === '*';
}

function envelope(data, meta = {}, error = null) {
  return { data, meta, error };
}

function catalogGroup(status, message, codes) {
  return Object.fromEntries(codes.map(code => [code, Object.freeze({ status, message })]));
}

const ERROR_CATALOG = Object.freeze(Object.assign(
  {},
  catalogGroup(400, 'The request is invalid.', [
    'INVALID_STREAM', 'MFA_CODE_INVALID', 'PASSWORD_RESET_INVALID', 'REQUEST_FAILED',
    'STANDINGS_KIND_INVALID'
  ]),
  catalogGroup(401, 'The supplied credentials are invalid.', [
    'INVALID_CREDENTIALS'
  ]),
  catalogGroup(403, 'You do not have permission to access this resource.', [
    'ACCOUNT_DISABLED', 'ADMIN_USER_TAG_PROTECTED', 'ATTACHMENT_FORBIDDEN', 'CLIPBOARD_FORBIDDEN', 'CONTEST_FORBIDDEN',
    'CONTEST_PARTICIPATION_REQUIRED', 'DISCUSSION_FORBIDDEN', 'HIT_HISTORY_PRIVATE', 'JOB_FORBIDDEN', 'MESSAGE_FORBIDDEN',
    'OPERATION_FORBIDDEN', 'OWNER_ACCOUNT_PROTECTED', 'PROBLEM_FORBIDDEN',
    'SELF_ACCOUNT_STATUS_FORBIDDEN', 'SELF_USER_TAG_DISABLE_FORBIDDEN', 'SOLUTION_FORBIDDEN', 'STANDINGS_HIDDEN',
    'SUBMISSION_FORBIDDEN', 'TICKET_FORBIDDEN', 'USER_TAG_FORBIDDEN'
  ]),
  catalogGroup(404, 'The requested resource was not found.', [
    'ANNOUNCEMENT_NOT_FOUND', 'ATTACHMENT_NOT_FOUND', 'BANNER_NOT_FOUND', 'BANNER_UPLOAD_INVALID', 'CLIPBOARD_NOT_FOUND',
    'CONTEST_CONFIG_NOT_FOUND', 'CONTEST_NOT_FOUND', 'CONTEST_PROBLEM_NOT_FOUND',
    'DISCUSSION_NOT_FOUND', 'GRANT_NOT_FOUND', 'HELP_PAGE_NOT_FOUND', 'JOB_NOT_FOUND',
    'JUDGE_WORKER_NOT_FOUND', 'MESSAGE_NOT_FOUND', 'MESSAGE_RECIPIENT_NOT_FOUND', 'MIGRATION_DOMAIN_NOT_FOUND', 'NOTIFICATION_NOT_FOUND',
    'MIGRATION_NOT_FOUND', 'ORGANIZATION_MEMBERSHIP_NOT_FOUND', 'ORGANIZATION_NOT_FOUND', 'POLICY_NOT_FOUND',
    'PROBLEM_NOT_FOUND', 'PROBLEM_VERSION_NOT_FOUND', 'TAG_NOT_FOUND', 'RATING_EVENT_NOT_FOUND', 'RATING_JOB_NOT_FOUND',
    'RATING_PREVIEW_NOT_FOUND', 'ROLE_NOT_FOUND', 'ROLLOUT_DOMAIN_NOT_FOUND',
    'SOLUTION_COMMENT_NOT_FOUND', 'SOLUTION_NOT_FOUND', 'STANDINGS_REBUILD_NOT_FOUND', 'STANDINGS_VERSION_NOT_FOUND', 'TESTDATA_FILE_NOT_FOUND', 'USER_TAG_SETTING_NOT_FOUND', 'USER_TAGS_DISABLED',
    'SUBMISSION_NOT_FOUND', 'TEAM_MEMBERSHIP_NOT_FOUND', 'TEAM_NOT_FOUND', 'TICKET_NOT_FOUND', 'USER_NOT_FOUND',
    'VJUDGE_CONNECTION_NOT_FOUND', 'VJUDGE_IMPORT_NOT_FOUND', 'VJUDGE_PROVIDER_NOT_FOUND', 'VJUDGE_REMOTE_PROBLEM_NOT_FOUND'
  ]),
  catalogGroup(410, 'Write operations require a v2 resource route.', [
    'V2_ROUTE_REQUIRED'
  ]),
  catalogGroup(409, 'The request conflicts with the current resource state.', [
    'AUTHORIZATION_WRITE_FAILED', 'AVATAR_DELETE_FAILED', 'CONTENT_WRITE_FAILED', 'CONTEST_DELETE_FAILED', 'CONTEST_LOCKED', 'CONTEST_RATING_FINALIZED', 'FOLLOW_FAILED',
    'CONTEST_NOT_ENDED', 'CONTEST_NOT_RUNNING', 'CONTEST_PROBLEMS_REQUIRED', 'CONTEST_TRANSITION_INVALID',
    'EMAIL_ALREADY_USED', 'GRANT_ALREADY_EXISTS', 'GRANT_ALREADY_REVOKED',
    'JOB_CANCELLED', 'JOB_EVENTS_UNAVAILABLE', 'JOB_FAILED', 'JOB_NOT_AWAITING_APPROVAL', 'JOB_NOT_RETRYABLE',
    'JOB_TERMINAL', 'JUDGE_WORKER_RESTARTING', 'MESSAGES_DISABLED', 'TAG_IN_USE', 'TAG_NAME_CONFLICT', 'USER_TAG_GRANT_EXISTS',
    'VJUDGE_CREDENTIAL_REQUIRED', 'VJUDGE_SOURCE_CONFLICT',
    'MIGRATION_COMPATIBILITY_NOT_STARTED', 'MIGRATION_NOT_CONSISTENT', 'MIGRATION_ROLLOUT_INCOMPLETE',
    'ORGANIZATION_INACTIVE', 'ORGANIZATION_SLUG_CONFLICT', 'POLICY_NAME_CONFLICT',
    'PROBLEM_SNAPSHOT_REQUIRED', 'PROBLEM_VERSION_NOT_REVIEWABLE', 'PROBLEM_VERSION_REQUIRED', 'RATING_ALREADY_PUBLISHED',
    'RATING_CONTEST_NOT_PUBLISHED', 'RATING_EVENT_ALREADY_REVERSED',
    'RATING_INPUT_PENDING', 'RATING_JOB_NOT_APPROVABLE', 'RATING_JOB_NOT_RETRYABLE',
    'RATING_JOB_NOT_ROLLBACKABLE', 'RATING_JOB_PREVIEW_OBSOLETE', 'RATING_JOB_STALE',
    'RATING_JOB_STATE_CHANGED', 'RATING_JOB_TERMINAL', 'RATING_NOT_ENOUGH_PARTICIPANTS',
    'RATING_NOT_PUBLISHED', 'RATING_PREVIEW_STALE', 'RATING_PROFILE_MISMATCH',
    'RATING_ROLLBACK_STALE', 'RATING_USER_MISMATCH', 'REGISTRATION_FAILED',
    'SENSITIVE_RESPONSE_NOT_REPLAYABLE',
    'SOLUTION_ALREADY_WITHDRAWN', 'SOLUTION_NOT_REVIEWABLE', 'SOLUTION_NOT_SUBMITTABLE', 'SOLUTION_SUBMISSION_DISABLED',
    'STANDINGS_NOT_READY', 'STANDINGS_REBUILD_ACTIVE',
    'SUBMISSION_EVENT_AGGREGATE_MISMATCH', 'SUBMISSION_EVENT_BASELINE_MISSING',
    'SUBMISSION_EVENT_DUPLICATE_BASELINE', 'SUBMISSION_PROJECTION_MISSING',
    'SUBMISSION_TERMINAL', 'SUBMISSION_TRANSITION_INVALID', 'VJUDGE_PROBLEM_REQUIRED', 'VJUDGE_SUBMISSION_REQUIRED', 'TEAM_INACTIVE', 'TEAM_SLUG_CONFLICT',
    'TICKET_ALREADY_CLOSED', 'TICKET_ASSIGNEE_INELIGIBLE', 'TICKET_ASSIGNMENT_REQUIRED', 'TICKET_CLOSED',
    'IDENTITY_PROFILE_LOCKED', 'SELF_FOLLOW_FORBIDDEN', 'STUDENT_ID_ALREADY_USED', 'UNFOLLOW_FAILED', 'UNREGISTRATION_FAILED', 'USERNAME_ALREADY_USED', 'USER_DELETE_CONFLICT', 'VERIFIED_EMAIL_REQUIRED'
  ]),
  catalogGroup(413, 'The submitted content exceeds the allowed size.', [
    'ATTACHMENT_LIMIT_EXCEEDED', 'AVATAR_TOO_LARGE', 'SOURCE_TOO_LARGE'
  ]),
  catalogGroup(422, 'One or more fields are invalid.', [
    'AVATAR_UPLOAD_INVALID', 'CONTEST_ADMIN_INVALID', 'CONTEST_CONFIG_INVALID', 'CONTEST_PROBLEM_INVALID',
    'CONTEST_PROBLEM_UNAVAILABLE', 'CONTEST_RANKING_INVALID', 'CONTEST_SCORING_INVALID', 'CONTEST_TEAMS_INVALID',
    'ATTACHMENT_REQUIRED', 'CURRENT_PASSWORD_REQUIRED', 'PROBLEM_TYPE_MISMATCH', 'PROBLEM_VERSION_INVALID', 'RATING_PREVIEW_INVALID', 'TESTDATA_SNAPSHOT_INVALID', 'TESTDATA_UPLOAD_INVALID', 'UNSAFE_FILE_TYPE', 'VJUDGE_SOURCE_INVALID',
    'RATING_PROFILE_INVALID', 'SUBMISSION_EVENT_INVALID', 'SUBMISSION_STATUS_INVALID'
  ]),
  catalogGroup(429, 'Too many requests.', [
    'LOGIN_RATE_LIMITED', 'MFA_CHALLENGE_RATE_LIMITED', 'TICKET_DAILY_LIMIT_REACHED', 'UPSTREAM_RATE_LIMITED'
  ]),
  catalogGroup(500, 'The request could not be completed because of an internal error.', [
    'BATCH_INTERRUPTED', 'BULK_REJUDGE_FAILED', 'CLIPBOARD_TOKEN_GENERATION_FAILED', 'HELP_PAGE_UPDATE_FAILED', 'MARKDOWN_RENDER_FAILED',
    'MIGRATION_FAILED', 'MIGRATION_ROLLBACK_REHEARSAL_FAILED',
    'PARTICIPANT_ACTION_FAILED', 'PASSWORD_RESET_FAILED', 'RATING_ADJUSTMENT_FAILED',
    'RATING_PUBLISH_FAILED', 'RATING_RECALCULATION_FAILED', 'RATING_REVERSAL_FAILED',
    'PROJECTION_REBUILD_FAILED', 'RATING_ROLLBACK_FAILED', 'REJUDGE_FAILED', 'REJUDGE_INTERRUPTED', 'REJUDGE_JOB_MISSING', 'USER_DELETE_FAILED',
    'PROBLEM_BULK_ARCHIVE_FAILED', 'STANDINGS_REBUILD_FAILED', 'SUBMISSION_LEGACY_WRITE_FAILED', 'TESTDATA_VALIDATION_FAILED', 'USER_UPDATE_FAILED'
  ]),
  catalogGroup(502, 'An upstream service returned an invalid response.', [
    'UPSTREAM_AUTH_FAILED', 'UPSTREAM_RESPONSE_INVALID'
  ]),
  catalogGroup(503, 'A required service is temporarily unavailable.', [
    'AUTHENTICATION_UNAVAILABLE', 'JUDGE_CONTROL_UNAVAILABLE',
    'JUDGE_DISPATCH_UNAVAILABLE', 'MFA_DELIVERY_FAILED', 'PROVIDER_ADAPTER_UNAVAILABLE',
    'SEARCH_UNAVAILABLE', 'SUBMISSION_DOMAIN_UNAVAILABLE', 'UPSTREAM_UNAVAILABLE', 'API_DOMAIN_DISABLED'
  ]),
  {
    AUTHENTICATION_REQUIRED: { status: 401, message: 'Authentication is required.' },
    CAPABILITY_REQUIRED: { status: 403, message: 'You do not have permission to perform this action.' },
    RECENT_LOGIN_REQUIRED: { status: 403, message: 'Sign in again or complete MFA before performing this action.' },
    OWNER_CAPABILITY_REQUIRED: { status: 403, message: 'Only the site owner can perform this action.' },
    RESOURCE_NOT_FOUND: { status: 404, message: 'The requested resource was not found.' },
    ETAG_MISMATCH: { status: 412, message: 'The resource changed. Refresh it and try again.' },
    PRECONDITION_REQUIRED: { status: 428, message: 'If-Match is required for this editable resource.' },
    IDEMPOTENCY_CONFLICT: { status: 409, message: 'The idempotency key was already used with a different request.' },
    INVALID_CURSOR: { status: 400, message: 'The cursor is invalid or expired.' },
    VALIDATION_FAILED: { status: 422, message: 'One or more fields are invalid.' },
    OPERATION_NOT_FOUND: { status: 404, message: 'The operation was not found.' },
    DEPENDENCY_UNAVAILABLE: { status: 503, message: 'A required dependency is temporarily unavailable.' },
    REQUEST_BODY_TOO_LARGE: { status: 413, message: 'The request body exceeds the API limit.' },
    RATE_LIMITED: { status: 429, message: 'Too many requests.' },
    OPERATION_IN_PROGRESS: { status: 409, message: 'An operation with this idempotency key is still in progress.' },
    API_ROUTE_NOT_FOUND: { status: 404, message: 'The requested API route was not found.' },
    INTERNAL_ERROR: { status: 500, message: 'The request could not be completed because of an internal error.' }
  }
));

function catalogError(code, message, fields = {}) {
  const known = ERROR_CATALOG[code] || { status: 400, message: 'The request could not be completed.' };
  return { code, message: message || known.message, fields };
}

function isExpired(value, now = Date.now()) {
  return value != null && new Date(value).getTime() <= now;
}

function databaseIso(value) {
  if (value == null) return null;
  if (typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value)) return new Date(value).toISOString();
  if (value instanceof Date) return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate(), value.getHours(), value.getMinutes(), value.getSeconds(), value.getMilliseconds())).toISOString();
  return new Date(`${String(value).replace(' ', 'T')}Z`).toISOString();
}

function isPublicV2WritePath(value) {
  const path = String(value || '').replace(/\/+$/, '');
  return path === '/api/v2/auth/login' || path === '/api/v2/auth/register' || path === '/api/v2/auth/password/reset' || path === '/api/v2/markdown';
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  ERROR_CATALOG,
  requestId,
  parseLimit,
  encodeCursor,
  decodeCursor,
  sha256,
  requestHash,
  classifyIdempotency,
  bodySize,
  consumeFixedWindow,
  etagFor,
  normalizeEtag,
  ifMatchSatisfied,
  envelope,
  catalogError,
  isExpired,
  databaseIso,
  isPublicV2WritePath
};
