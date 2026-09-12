'use strict';

const STATE_PRIORITY = Object.freeze({
  upcoming: 0,
  running: 1,
  ended: 2
});

function contestState(contest, now) {
  const start = Number(contest.start_time || 0);
  const end = Number(contest.end_time || 0);
  if (now < start) return 'upcoming';
  if (now < end) return 'running';
  return 'ended';
}

function compareContests(a, b, now) {
  const aState = contestState(a, now);
  const bState = contestState(b, now);
  const stateDifference = STATE_PRIORITY[aState] - STATE_PRIORITY[bState];
  if (stateDifference) return stateDifference;

  const startDifference = Number(a.start_time || 0) - Number(b.start_time || 0);
  if (aState === 'ended') {
    if (startDifference) return -startDifference;
    return Number(b.id || 0) - Number(a.id || 0);
  }
  if (startDifference) return startDifference;

  return Number(a.id || 0) - Number(b.id || 0);
}

function sortContests(contests, now = Math.floor(Date.now() / 1000)) {
  return contests.slice().sort((a, b) => compareContests(a, b, now));
}

module.exports = { contestState, compareContests, sortContests };
