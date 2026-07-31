'use strict';

const INTERRUPTED_STATES = new Set(['running', 'cancelling']);

function cancelRequested(value) {
  return value === true || value === 1 || value === '1';
}

function recoveryDisposition(state, requested) {
  const current = String(state || '');
  if (!INTERRUPTED_STATES.has(current)) return current;
  return cancelRequested(requested) ? 'cancelled' : 'queued';
}

function recoveryAction(job) {
  const state = recoveryDisposition(job && job.state, job && job.cancel_requested);
  if (state === 'cancelled') return { state, stage: 'cancelled', shouldRun: false };
  if (state === 'queued') return { state, stage: 'recovering', shouldRun: true };
  return null;
}

module.exports = { cancelRequested, recoveryDisposition, recoveryAction };
