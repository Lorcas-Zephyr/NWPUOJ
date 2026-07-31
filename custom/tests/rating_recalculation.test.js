'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cascadeRatingPeriods } = require('../libs/rating-recalculation');

const config = { rating: 1500, deviation: 350, volatility: 0.06 };

test('changing an early contest cascades into later Rating periods', () => {
  const original = cascadeRatingPeriods([
    { contestId: 10, standings: [{ userId: 1, rank: 1 }, { userId: 2, rank: 2 }] },
    { contestId: 11, standings: [{ userId: 1, rank: 2 }, { userId: 2, rank: 1 }] }
  ], {}, config);
  const corrected = cascadeRatingPeriods([
    { contestId: 10, standings: [{ userId: 1, rank: 2 }, { userId: 2, rank: 1 }] },
    { contestId: 11, standings: [{ userId: 1, rank: 2 }, { userId: 2, rank: 1 }] }
  ], {}, config);
  assert.notDeepEqual(original.periods[1].changes, corrected.periods[1].changes);
  assert.notDeepEqual(original.finalStates.get(1), corrected.finalStates.get(1));
});

test('a removed contestant remains at the boundary baseline', () => {
  const baselines = new Map([[1, { rating: 1640, deviation: 120, volatility: 0.05 }], [2, { rating: 1510, deviation: 140, volatility: 0.055 }]]);
  const result = cascadeRatingPeriods([{ contestId: 20, standings: [{ userId: 2, rank: 1 }] }], baselines, config);
  assert.deepEqual(result.finalStates.get(1), baselines.get(1));
  assert.equal(result.periods[0].changes.length, 0);
});

test('new contestants start from profile defaults and duplicate input is rejected', () => {
  const result = cascadeRatingPeriods([{ contestId: 30, standings: [{ userId: 7, rank: 1 }, { userId: 8, rank: 2 }] }], {}, config);
  assert.equal(result.periods[0].changes[0].ratingBefore, 1500);
  assert.throws(() => cascadeRatingPeriods([{ contestId: 30, standings: [{ userId: 7, rank: 1 }, { userId: 7, rank: 2 }] }], {}, config), /contestant/);
});
