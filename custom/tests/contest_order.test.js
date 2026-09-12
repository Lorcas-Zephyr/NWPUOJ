'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { contestState, sortContests } = require('../libs/contest-order');

const NOW = 10_000;

test('contest states use the requested upcoming, running, ended order', () => {
  assert.equal(contestState({ start_time: 11_000, end_time: 12_000 }, NOW), 'upcoming');
  assert.equal(contestState({ start_time: 9_000, end_time: 12_000 }, NOW), 'running');
  assert.equal(contestState({ start_time: 8_000, end_time: 9_000 }, NOW), 'ended');
});

test('upcoming and running contests use ascending start time while ended contests use descending start time', () => {
  const rows = [
    { id: 8, start_time: 9_500, end_time: 10_500 },
    { id: 2, start_time: 12_000, end_time: 13_000 },
    { id: 3, start_time: 11_000, end_time: 12_000 },
    { id: 7, start_time: 8_000, end_time: 9_000 },
    { id: 5, start_time: 7_000, end_time: 9_000 },
    { id: 6, start_time: 9_000, end_time: 10_500 },
    { id: 4, start_time: 12_000, end_time: 14_000 }
  ];

  assert.deepEqual(sortContests(rows, NOW).map(row => row.id), [3, 2, 4, 6, 8, 7, 5]);
  assert.deepEqual(rows.map(row => row.id), [8, 2, 3, 7, 5, 6, 4]);
});
