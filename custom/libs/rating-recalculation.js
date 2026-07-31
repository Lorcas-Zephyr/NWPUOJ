'use strict';

const { calculatePeriod, normalizedConfig } = require('./glicko2');

function normalizeState(value, config) {
  const source = value || {};
  const rating = Number(source.rating ?? config.initialRating);
  const deviation = Number(source.deviation ?? config.initialDeviation);
  const volatility = Number(source.volatility ?? config.initialVolatility);
  if (![rating, deviation, volatility].every(Number.isFinite)) throw new TypeError('Invalid Rating recalculation state.');
  return { rating: Math.round(rating), deviation, volatility };
}

function cascadeRatingPeriods(periods, baselineInput, inputConfig) {
  if (!Array.isArray(periods)) throw new TypeError('Rating periods must be an array.');
  const config = normalizedConfig(inputConfig); const states = new Map();
  const entries = baselineInput instanceof Map ? Array.from(baselineInput.entries()) : Object.entries(baselineInput || {});
  for (const [userIdValue, state] of entries) {
    const userId = Number(userIdValue); if (!Number.isSafeInteger(userId) || userId < 1) throw new TypeError('Invalid baseline user.');
    states.set(userId, normalizeState(state, config));
  }
  const seenPeriods = new Set(); const calculatedPeriods = [];
  for (const period of periods) {
    const contestId = Number(period && period.contestId);
    if (!Number.isSafeInteger(contestId) || contestId < 1 || seenPeriods.has(contestId)) throw new TypeError('Invalid or duplicate Rating period.');
    seenPeriods.add(contestId); const seenUsers = new Set();
    const standings = (period.standings || []).map(item => {
      const userId = Number(item.userId); const rank = Number(item.rank);
      if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(rank) || rank < 1 || seenUsers.has(userId)) throw new TypeError('Invalid Rating period contestant.');
      seenUsers.add(userId); if (!states.has(userId)) states.set(userId, normalizeState(null, config));
      return { userId, rank, score: Number(item.score || 0), ...states.get(userId) };
    });
    const changes = standings.length >= 2 ? calculatePeriod(standings, config) : [];
    changes.forEach(change => states.set(change.userId, { rating: change.ratingAfter, deviation: change.deviationAfter, volatility: change.volatilityAfter }));
    calculatedPeriods.push({ contestId, changes });
  }
  return { periods: calculatedPeriods, finalStates: states };
}

module.exports = { cascadeRatingPeriods, normalizeState };
