'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { projectionDifference, rollbackIsCurrent, sameProjection } = require('../libs/rating-projection');

const baseline = { rating: 1500, deviation: 350, volatility: 0.06 };

test('projection equality uses stable Rating precision', () => {
  assert.equal(sameProjection(baseline, { rating: 1499.6, deviation: 350.0000009, volatility: 0.0600000009 }), true);
  assert.equal(sameProjection(baseline, { rating: 1501, deviation: 350, volatility: 0.06 }), false);
});

test('projection differences are normalized and unchanged values are omitted', () => {
  assert.equal(projectionDifference({ userId: 7, sourceEventId: 10, before: baseline, after: baseline }), null);
  assert.deepEqual(projectionDifference({ userId: 7, sourceEventId: 11, before: baseline, after: { rating: 1512.2, deviation: 320, volatility: 0.059 } }), {
    user_id: 7,
    source_event_id: '11',
    before: baseline,
    after: { rating: 1512, deviation: 320, volatility: 0.059 }
  });
});

test('rollback refuses stale projections and invalid numeric input', () => {
  const item = { after: { rating: 1512, deviation: 320, volatility: 0.059 } };
  assert.equal(rollbackIsCurrent({ rating: 1512, deviation: 320, volatility: 0.059 }, item), true);
  assert.equal(rollbackIsCurrent({ rating: 1513, deviation: 320, volatility: 0.059 }, item), false);
  assert.throws(() => projectionDifference({ userId: 1, sourceEventId: 1, before: baseline, after: { rating: NaN, deviation: 1, volatility: 1 } }), /Invalid Rating projection field/);
});
