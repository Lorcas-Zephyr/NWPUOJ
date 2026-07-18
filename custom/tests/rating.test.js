const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateRatingChanges, winProbability } = require('../libs/rating');

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
