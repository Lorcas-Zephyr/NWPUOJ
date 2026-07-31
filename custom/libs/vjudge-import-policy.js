'use strict';

const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'cancelled']);
const RETRYABLE_FAILURE_CODES = new Set(['UPSTREAM_RATE_LIMITED', 'UPSTREAM_UNAVAILABLE']);
const PUBLIC_FAILURES = Object.freeze({
  PROVIDER_ADAPTER_UNAVAILABLE: 'The provider integration is unavailable.',
  UPSTREAM_AUTH_FAILED: 'The provider credentials are unavailable or invalid.',
  UPSTREAM_RATE_LIMITED: 'The provider temporarily rate-limited this operation.',
  UPSTREAM_RESPONSE_INVALID: 'The provider returned an unsupported response.',
  UPSTREAM_UNAVAILABLE: 'The provider is temporarily unavailable.'
});

function normalizeRemoteIds(values) {
  return Array.from(new Set((values || []).map(value => String(value).trim()).filter(value => /^[1-9][0-9]{0,11}$/.test(value)))).slice(0, 5000);
}

function initialItemState(existing, conflictPolicy) {
  return existing && conflictPolicy !== 'overwrite' ? 'skipped' : 'pending';
}

function retryAllowed(job) {
  const state = String(job && job.state || '');
  return ['failed', 'cancelled'].includes(state) || (state === 'completed' && Number(job.failed || 0) > 0);
}

function cancellationState(job) {
  const state = String(job && job.state || '');
  if (TERMINAL_JOB_STATES.has(state)) return null;
  return state === 'running' ? 'cancelling' : 'cancelled';
}

function classifyFailure(error) {
  const requestedCode = String(error && error.publicCode || '');
  if (Object.prototype.hasOwnProperty.call(PUBLIC_FAILURES, requestedCode)) return { code: requestedCode, message: PUBLIC_FAILURES[requestedCode] };
  const source = String(error && error.message || error || '');
  if (/未配置|登录|账号|密码|auth|credential/i.test(source)) return { code: 'UPSTREAM_AUTH_FAILED', message: PUBLIC_FAILURES.UPSTREAM_AUTH_FAILED };
  if (/频繁|rate|captcha|队列已满/i.test(source)) return { code: 'UPSTREAM_RATE_LIMITED', message: PUBLIC_FAILURES.UPSTREAM_RATE_LIMITED };
  if (/parse|解析|格式|题面/i.test(source)) return { code: 'UPSTREAM_RESPONSE_INVALID', message: PUBLIC_FAILURES.UPSTREAM_RESPONSE_INVALID };
  return { code: 'UPSTREAM_UNAVAILABLE', message: PUBLIC_FAILURES.UPSTREAM_UNAVAILABLE };
}

function retryableFailure(error) {
  // Callers may already have classified an error and retain only its stable code.
  // Do not reclassify that object as a generic upstream outage.
  const failure = error && error.code ? error : classifyFailure(error);
  return RETRYABLE_FAILURE_CODES.has(failure.code);
}

function retryDelayMs(attempt, baseMs = 500) {
  const normalizedAttempt = Math.max(1, Math.min(8, Number(attempt) || 1));
  const normalizedBase = Math.max(1, Number(baseMs) || 500);
  return Math.min(30000, normalizedBase * Math.pow(2, normalizedAttempt - 1));
}

module.exports = { PUBLIC_FAILURES, RETRYABLE_FAILURE_CODES, TERMINAL_JOB_STATES, cancellationState, classifyFailure, initialItemState, normalizeRemoteIds, retryAllowed, retryableFailure, retryDelayMs };
