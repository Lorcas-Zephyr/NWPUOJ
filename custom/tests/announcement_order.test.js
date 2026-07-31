'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { sortAnnouncements } = require('../libs/announcement-order');

const NOW = 10_000;

test('active announcements lead the list and are ordered by importance', () => {
  const rows = [
    { id: 1, level: 'info', start_time: 9_900, end_time: 10_100 },
    { id: 2, level: 'important', start_time: 9_000, end_time: 10_100 },
    { id: 3, level: 'warning', start_time: 9_800, end_time: 10_100 },
    { id: 4, level: 'important', start_time: 8_000, end_time: 9_000 }
  ];

  assert.deepEqual(sortAnnouncements(rows, NOW).map(row => row.id), [2, 3, 1, 4]);
});

test('ended announcements ignore importance and use descending start time', () => {
  const rows = [
    { id: 1, level: 'important', start_time: 1_000, end_time: 2_000 },
    { id: 2, level: 'info', start_time: 7_000, end_time: 8_000 },
    { id: 3, level: 'warning', start_time: 5_000, end_time: 6_000 }
  ];

  assert.deepEqual(sortAnnouncements(rows, NOW).map(row => row.id), [2, 3, 1]);
});

test('upcoming announcements sit between active and ended with the nearest first', () => {
  const rows = [
    { id: 1, level: 'important', start_time: 1_000, end_time: 2_000 },
    { id: 2, level: 'info', start_time: 12_000, end_time: 13_000 },
    { id: 3, level: 'info', start_time: 11_000, end_time: 12_000 },
    { id: 4, level: 'warning', start_time: 9_000, end_time: 11_000 }
  ];

  assert.deepEqual(sortAnnouncements(rows, NOW).map(row => row.id), [4, 3, 2, 1]);
});
