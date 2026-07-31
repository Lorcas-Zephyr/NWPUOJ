'use strict';

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

function stateOf(job) {
  return String(job && job.state || '');
}

function stageOf(job) {
  return String(job && job.stage || '');
}

function retryAllowed(job) {
  return ['failed', 'cancelled'].includes(stateOf(job)) || stageOf(job) === 'rolled_back';
}

function approvalAllowed(job) {
  return stateOf(job) === 'paused' && stageOf(job) === 'awaiting_approval';
}

function rollbackAllowed(job) {
  return stateOf(job) === 'completed' && stageOf(job) === 'completed';
}

function cancellationState(job) {
  const state = stateOf(job);
  if (TERMINAL_STATES.has(state)) return null;
  return state === 'running' ? 'cancelling' : 'cancelled';
}

function shouldApply(job) {
  return stageOf(job) === 'applying';
}

module.exports = { TERMINAL_STATES, approvalAllowed, cancellationState, retryAllowed, rollbackAllowed, shouldApply };
