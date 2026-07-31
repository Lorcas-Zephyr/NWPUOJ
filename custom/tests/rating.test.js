const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateRatingChanges, winProbability } = require('../libs/rating');
const { calculatePeriod, updatePlayer } = require('../libs/glicko2');

test('equal ratings have symmetric win probability', () => {
  assert.equal(winProbability(1500, 1500), 0.5);
});

test('rating calculation returns integer deltas for ordered contestants', () => {
  const result = calculateRatingChanges([
    { userId: 1, rank: 1, currentRating: 1500 },
    { userId: 2, rank: 2, currentRating: 1500 },
    { userId: 3, rank: 3, currentRating: 1500 }
  ]);
  assert.equal(result.length, 3);
  assert.ok(result.every(item => Number.isInteger(item.ratingAfter) && Number.isInteger(item.delta)));
  assert.ok(result[0].delta > result[2].delta);
});

test('tied equal-rated contestants receive equal changes', () => {
  const result = calculateRatingChanges([
    { userId: 1, rank: 1, currentRating: 1500 },
    { userId: 2, rank: 1, currentRating: 1500 },
    { userId: 3, rank: 3, currentRating: 1500 }
  ]);
  assert.equal(result[0].delta, result[1].delta);
});

test('fewer than two contestants is rejected', () => {
  assert.throws(() => calculateRatingChanges([{ userId: 1, rank: 1, currentRating: 1500 }]));
});

test('Glicko-2 matches the published reference rating period', () => {
  const result = updatePlayer(
    { rating: 1500, deviation: 200, volatility: 0.06 },
    [
      { rating: 1400, deviation: 30, score: 1 },
      { rating: 1550, deviation: 100, score: 0 },
      { rating: 1700, deviation: 300, score: 0 }
    ],
    { tau: 0.5, minimumDeviation: 0 }
  );
  assert.ok(Math.abs(result.rating - 1464.06) < 0.02);
  assert.ok(Math.abs(result.deviation - 151.52) < 0.02);
  assert.ok(Math.abs(result.volatility - 0.059996) < 0.000002);
});

test('Glicko-2 contest period preserves ties and returns projection fields', () => {
  const result = calculatePeriod([
    { userId: 1, rank: 1, rating: 1500, deviation: 350, volatility: 0.06 },
    { userId: 2, rank: 1, rating: 1500, deviation: 350, volatility: 0.06 },
    { userId: 3, rank: 3, rating: 1500, deviation: 350, volatility: 0.06 }
  ]);
  assert.equal(result[0].ratingAfter, result[1].ratingAfter);
  assert.ok(result[0].ratingAfter > result[2].ratingAfter);
  assert.ok(result.every(item => item.deviationAfter > 0 && item.volatilityAfter > 0));
});
