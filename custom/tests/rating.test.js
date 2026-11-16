const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateRatingChanges, winProbability, calculatePeriod, NEWCOMER_BONUSES } = require('../libs/rating');
const { updatePlayer } = require('../libs/glicko2');

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

test('CF contest period preserves ties and returns compatible projection fields', () => {
  const result = calculatePeriod([
    { userId: 1, rank: 1, rating: 1500, deviation: 350, volatility: 0.06 },
    { userId: 2, rank: 1, rating: 1500, deviation: 350, volatility: 0.06 },
    { userId: 3, rank: 3, rating: 1500, deviation: 350, volatility: 0.06 }
  ]);
  assert.equal(result[0].ratingAfter, result[1].ratingAfter);
  assert.ok(result[0].ratingAfter > result[2].ratingAfter);
  assert.ok(result.every(item => item.deviationAfter > 0 && item.volatilityAfter > 0));
});

// Public CF 1349 results, from meooow25/carrot/carrot/tests/data/round-1349-641-div1-data.json.
// Store only [rank, oldRating, officialDelta], without account identifiers.
test('CF algorithm matches every official delta in round 1349 (1248 participants)', () => {
  const fixture = require('./fixtures/cf-round-1349.json');
  const results = calculateRatingChanges(fixture.map(([rank, currentRating], index) => ({ userId: index + 1, rank, currentRating, ratedContests: 6 })));
  assert.equal(results.length, 1248);
  assert.deepEqual(results.map(result => result.delta), fixture.map(row => row[2]));
});

test('newcomers receive all six CF bonuses with the correct effective strength', () => {
  let visible = 0;
  for (let count = 0; count <= 7; count++) {
    const remaining = NEWCOMER_BONUSES.slice(count).reduce((a, b) => a + b, 0);
    const opponents = [{ userId: 2, currentRating: 1300, rank: 1, ratedContests: 9 }, { userId: 3, currentRating: 1750, rank: 3, ratedContests: 12 }];
    const experienced = calculateRatingChanges([{ userId: 1, currentRating: visible + remaining, rank: 2, ratedContests: 6 }, ...opponents]);
    const actual = calculateRatingChanges([{ userId: 1, currentRating: visible, rank: 2, ratedContests: count }, ...opponents]);
    assert.equal(actual[0].delta, experienced[0].delta + (NEWCOMER_BONUSES[count] || 0));
    assert.equal(actual[1].delta, experienced[1].delta);
    assert.equal(actual[2].delta, experienced[2].delta);
    assert.equal(actual[0].ratedContestsAfter, count + 1);
    visible = actual[0].ratingAfter;
  }
});

test('zero-rated experienced players are not mistaken for newcomers and invalid counts fail', () => {
  const others = [{ userId: 2, currentRating: 1800, rank: 1, ratedContests: 8 }];
  const experienced = calculateRatingChanges([{ userId: 1, currentRating: 0, rank: 2, ratedContests: 6 }, ...others]);
  const newcomer = calculateRatingChanges([{ userId: 1, currentRating: 0, rank: 2, ratedContests: 0 }, ...others]);
  assert.equal(experienced[0].ratingBefore, 0);
  assert.notEqual(experienced[0].delta, newcomer[0].delta);
  assert.throws(() => calculateRatingChanges([{ rank: 1, currentRating: 0, ratedContests: -1 }, ...others]));
});
