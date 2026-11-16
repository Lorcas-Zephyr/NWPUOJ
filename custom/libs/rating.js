'use strict';

// Codeforces' rank/seed algorithm, with the newcomer progression introduced in 2020.
// Reference: https://codeforces.com/contest/1/submission/13861109
// Current seed exclusion and integer corrections: cheran-senthil/TLE rating_calculator.py.
const ALGORITHM_VERSION = 2;
const NEWCOMER_BONUSES = Object.freeze([500, 350, 250, 150, 100, 50]);
const DEFAULT_CONFIG = Object.freeze({ initialRating: 0, initialDeviation: 350, initialVolatility: 0.06 });

function normalizedConfig(input = {}) {
  const initialRating = Number(input.initialRating ?? input.rating ?? DEFAULT_CONFIG.initialRating);
  if (!Number.isSafeInteger(initialRating)) throw new TypeError('Invalid initial Rating.');
  // Retain these fields in existing API projections; CF does not use RD or volatility.
  return { initialRating, initialDeviation: 350, initialVolatility: 0.06 };
}

function winProbability(firstRating, secondRating) {
  return 1 / (1 + Math.pow(10, (secondRating - firstRating) / 400));
}

function calculateRatingChanges(contestants) {
  if (!Array.isArray(contestants) || contestants.length < 2) throw new Error('At least two contestants are required.');
  const players = contestants.map((contestant, index) => {
    const rating = Number(contestant.currentRating);
    const count = Number(contestant.ratedContests ?? 6);
    if (!Number.isSafeInteger(rating) || !Number.isSafeInteger(contestant.rank) || contestant.rank < 1 || !Number.isSafeInteger(count) || count < 0) throw new Error('Invalid rating contestant.');
    return { index, rating, count, rank: contestant.rank, effective: rating + NEWCOMER_BONUSES.slice(count).reduce((a, b) => a + b, 0) };
  });
  const byRank = players.slice().sort((a, b) => a.rank - b.rank);
  for (let start = 0; start < byRank.length;) {
    let end = start + 1;
    while (end < byRank.length && byRank[end].rank === byRank[start].rank) end++;
    for (let index = start; index < end; index++) byRank[index].cfRank = end;
    start = end;
  }
  function seed(rating, player) {
    return 1 + players.reduce((sum, other) => sum + (other === player ? 0 : winProbability(other.effective, rating)), 0);
  }
  for (const player of players) {
    const middleRank = Math.sqrt(player.cfRank * seed(player.effective, player));
    let left = 1, right = 8000;
    while (right - left > 1) {
      const middle = Math.floor((left + right) / 2);
      if (seed(middle, player) < middleRank) right = middle;
      else left = middle;
    }
    player.delta = Math.trunc((left - player.effective) / 2);
  }
  const first = Math.trunc(-players.reduce((sum, player) => sum + player.delta, 0) / players.length) - 1;
  players.forEach(player => { player.delta += first; });
  const byRating = players.slice().sort((a, b) => b.effective - a.effective || a.index - b.index);
  const count = Math.min(4 * Math.round(Math.sqrt(players.length)), players.length);
  const topSum = byRating.slice(0, count).reduce((sum, player) => sum + player.delta, 0);
  const second = Math.min(0, Math.max(-10, Math.trunc(-topSum / count)));
  return players.map(player => {
    const delta = player.delta + second + (NEWCOMER_BONUSES[player.count] || 0);
    return { ...contestants[player.index], ratingBefore: player.rating, ratingAfter: player.rating + delta, delta,
      ratedContestsBefore: player.count, ratedContestsAfter: player.count + 1 };
  });
}

function calculatePeriod(players, inputConfig = {}) {
  const config = normalizedConfig(inputConfig);
  return calculateRatingChanges(players.map(player => ({ ...player, currentRating: Number(player.rating ?? config.initialRating), ratedContests: Number(player.ratedContests ?? 0) }))).map(change => ({
    ...change,
    deviationBefore: Number(change.deviation ?? config.initialDeviation), deviationAfter: config.initialDeviation,
    volatilityBefore: Number(change.volatility ?? config.initialVolatility), volatilityAfter: config.initialVolatility
  }));
}

async function ratedContestCounts(manager, userIds, profileId = 'icpc', boundary = null) {
  if (!userIds.length) return new Map();
  const params = [userIds];
  let before = '';
  if (boundary) { before = ' AND (c.end_time<? OR (c.end_time=? AND c.id<?))'; params.push(boundary.end_time, boundary.end_time, boundary.id); }
  const rows = profileId === 'icpc'
    ? await manager.query(`SELECT h.user_id,COUNT(DISTINCT rc.contest_id) AS n FROM rating_history h JOIN rating_calculation rc ON rc.id=h.rating_calculation_id JOIN contest c ON c.id=rc.contest_id WHERE h.user_id IN (?)${before} GROUP BY h.user_id`, params)
    : await manager.query(`SELECT e.user_id,COUNT(DISTINCT e.contest_id) AS n FROM rating_v2_event e JOIN contest c ON c.id=e.contest_id WHERE e.user_id IN (?)${before} AND e.profile_id=? AND e.kind IN ('contest','contest_recalculated') GROUP BY e.user_id`, [...params, profileId]);
  return new Map(rows.map(row => [Number(row.user_id), Number(row.n)]));
}

module.exports = { ALGORITHM_VERSION, DEFAULT_CONFIG, NEWCOMER_BONUSES, calculateRatingChanges, calculatePeriod, normalizedConfig, ratedContestCounts, winProbability };
