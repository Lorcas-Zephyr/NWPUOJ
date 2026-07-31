'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const scheduler = require('../libs/submission-scheduler');

test('submission scheduler combines contest priority, queue age, language pressure, and user fairness', () => {
  const now = Date.parse('2026-07-30T12:00:00.000Z');
  const rows = [
    { submission_id: 1, user_id: 1, contest_id: null, language: 'cpp', created_at: '2026-07-30T11:00:00.000Z' },
    { submission_id: 2, user_id: 2, contest_id: 7, language: 'cpp', created_at: '2026-07-30T11:59:00.000Z' },
    { submission_id: 3, user_id: 3, contest_id: 7, language: 'python', created_at: '2026-07-30T11:58:00.000Z' },
    { submission_id: 4, user_id: 3, contest_id: 7, language: 'python', created_at: '2026-07-30T11:57:00.000Z' }
  ];
  const selected = scheduler.rankQueuedSubmissions(rows, {
    now, limit: 3, activeByLanguage: { cpp: 4, python: 0 }, languageSlots: { cpp: 2, python: 1 }
  });
  assert.deepEqual(selected.map(row => row.submission_id), [4, 2, 1]);
});

test('language slot configuration is bounded and queue age eventually outweighs pressure', () => {
  assert.equal(scheduler.languageSlots({ cpp: 4 }, 'cpp'), 4);
  assert.equal(scheduler.languageSlots({ default: 2 }, 'python'), 2);
  assert.equal(scheduler.languageSlots({ cpp: 0 }, 'cpp'), 1);
  const now = Date.parse('2026-07-30T12:00:00.000Z');
  const oldBusy = { submission_id: 1, user_id: 1, language: 'cpp', created_at: '2026-07-30T10:00:00.000Z' };
  const newIdle = { submission_id: 2, user_id: 2, language: 'python', created_at: '2026-07-30T11:59:00.000Z' };
  const selected = scheduler.rankQueuedSubmissions([newIdle, oldBusy], { now, activeByLanguage: { cpp: 3 }, languageSlots: { cpp: 1 } });
  assert.equal(selected[0].submission_id, 1);
});
