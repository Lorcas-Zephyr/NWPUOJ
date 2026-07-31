'use strict';

const crypto = require('crypto');

const PROVIDERS = Object.freeze(['uoj', 'hdu', 'poj']);
const PROVIDER_SET = new Set(PROVIDERS);
const PHASES = new Set(['submitting', 'judging', 'completed', 'failed']);

function valueOrNull(value, maximum = 120) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function providerFromProblem(problem) {
  const type = String(problem && problem.type || '');
  const provider = type.startsWith('vjudge:') ? type.slice('vjudge:'.length).toLowerCase() : '';
  return PROVIDER_SET.has(provider) ? provider : null;
}

function normalizeProvider(value, fallback) {
  const provider = String(value || '').trim().toLowerCase();
  return PROVIDER_SET.has(provider) ? provider : fallback || null;
}

function normalizePhase(value, pending) {
  const phase = String(value || '').trim().toLowerCase();
  if (!pending) return 'completed';
  return PHASES.has(phase) && phase !== 'completed' ? phase : 'judging';
}

function snapshot(judge, problem, marker) {
  const vjudge = marker && typeof marker === 'object' ? marker : {};
  const provider = normalizeProvider(vjudge.provider, providerFromProblem(problem));
  const localSubmissionId = Number(judge && judge.id);
  if (!provider || !Number.isSafeInteger(localSubmissionId) || localSubmissionId < 1) return null;

  const upstreamTaskId = valueOrNull(vjudge.submissionId != null ? vjudge.submissionId : vjudge.upstream_task_id);
  const remoteProblemId = valueOrNull(vjudge.problemId != null ? vjudge.problemId : vjudge.remote_problem_id);
  const localStatus = valueOrNull(judge && judge.status, 80) || 'Unknown';
  const phase = normalizePhase(vjudge.phase, !!(judge && judge.pending));
  const result = {
    local_submission_id: localSubmissionId,
    provider,
    upstream_task_id: upstreamTaskId,
    remote_problem_id: remoteProblemId,
    phase,
    local_status: localStatus
  };
  result.marker_hash = crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex');
  return result;
}

function hasChanged(previous, current) {
  if (!previous) return true;
  return ['provider', 'upstream_task_id', 'remote_problem_id', 'phase', 'local_status', 'marker_hash']
    .some(key => String(previous[key] == null ? '' : previous[key]) !== String(current[key] == null ? '' : current[key]));
}

function eventType(sync) {
  if (sync.phase === 'submitting') return 'vjudge.submission.submitting';
  if (sync.phase === 'completed') return 'vjudge.submission.completed';
  if (sync.phase === 'failed') return 'vjudge.submission.failed';
  return 'vjudge.submission.judging';
}

function publicSync(sync, updatedAt) {
  return {
    local_submission_id: Number(sync.local_submission_id),
    provider: sync.provider,
    upstream_task_id: sync.upstream_task_id || null,
    remote_problem_id: sync.remote_problem_id || null,
    phase: sync.phase,
    local_status: sync.local_status,
    updated_at: updatedAt || null
  };
}

const ADAPTER_METHODS = Object.freeze([
  'checkAccount', 'searchProblems', 'fetchProblem', 'fetchProblemList',
  'submit', 'pollSubmission', 'normalizeResult'
]);

function adapterMissingMethods(adapter) {
  return ADAPTER_METHODS.filter(method => !adapter || typeof adapter[method] !== 'function');
}

module.exports = {
  PROVIDERS,
  ADAPTER_METHODS,
  providerFromProblem,
  snapshot,
  hasChanged,
  eventType,
  publicSync,
  adapterMissingMethods
};
