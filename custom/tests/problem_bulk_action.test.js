'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const bulkAction = require('../libs/problem-bulk-action');

test('bulk problem actions accept a bounded unique archive selection', () => {
  assert.deepEqual(bulkAction.normalize({ action: 'archive', problem_ids: ['4', 8] }), {
    action: 'archive', problem_ids: [4, 8]
  });
  assert.equal(bulkAction.progress(3, 0), 0);
  assert.equal(bulkAction.progress(3, 2), 66);
  assert.equal(bulkAction.progress(3, 3), 100);
});

test('bulk problem actions reject unsupported, duplicate, and oversized input', () => {
  assert.throws(() => bulkAction.normalize({ action: 'delete', problem_ids: [1] }), error => error.code === 'VALIDATION_FAILED');
  assert.throws(() => bulkAction.normalize({ action: 'archive', problem_ids: [1, 1] }), /unique/);
  assert.throws(() => bulkAction.normalize({ action: 'archive', problem_ids: [0] }), /invalid/);
  assert.throws(() => bulkAction.normalize({ action: 'archive', problem_ids: Array.from({ length: 201 }, (_, index) => index + 1) }), /invalid/);
});
