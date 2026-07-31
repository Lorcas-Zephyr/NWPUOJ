'use strict';

const TRANSITIONS = Object.freeze({
  draft: Object.freeze(['review', 'archived']),
  review: Object.freeze(['draft', 'scheduled']),
  scheduled: Object.freeze(['running', 'archived']),
  running: Object.freeze(['frozen', 'ended']),
  frozen: Object.freeze(['running', 'ended']),
  ended: Object.freeze(['rated', 'archived']),
  rated: Object.freeze(['archived']),
  archived: Object.freeze([])
});

function resolveContestStatus(contest, state, nowSeconds) {
  const now = nowSeconds == null ? Math.floor(Date.now() / 1000) : Number(nowSeconds);
  if (state) {
    if (state.status === 'scheduled' && Number(contest.end_time || 0) <= now) return 'ended';
    if (state.status === 'scheduled' && Number(contest.start_time || 0) <= now) return 'running';
    if (state.status === 'running' && Number(contest.end_time || 0) <= now) return 'ended';
    return state.status;
  }
  if (Number(contest.end_time || 0) <= now) return 'ended';
  if (Number(contest.start_time || 0) <= now) return 'running';
  return 'scheduled';
}

function transitionAllowed(from, to) {
  return from === to || !!(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
}

function contestConfigurationLocked(status) {
  return ['running', 'frozen', 'ended', 'rated', 'archived'].includes(status);
}

function snapshotRefreshAllowed(action) {
  // Publishing is the last mutable boundary. Starting a contest must consume
  // the already locked problem snapshots rather than recapturing live content.
  return action === 'publish';
}

function standingsVisibility(input) {
  const options = input || {};
  if (!options.isPublic && !options.participant && !options.fullScope) return 'not_found';
  if (options.fullScope) return 'visible';
  if (['ended', 'rated', 'archived'].includes(options.status)) return 'visible';
  const participantCanSeeDuringContest = ['running', 'frozen'].includes(options.status) && options.participant && options.canSeeResults && options.canSeeOthers;
  return participantCanSeeDuringContest ? 'visible' : 'hidden';
}

module.exports = { TRANSITIONS, contestConfigurationLocked, resolveContestStatus, snapshotRefreshAllowed, standingsVisibility, transitionAllowed };
