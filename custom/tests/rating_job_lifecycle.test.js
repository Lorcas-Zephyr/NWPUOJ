'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const lifecycle = require('../libs/rating-job-lifecycle');

test('Rating recalculation only allows the intended retry, approval and rollback states', () => {
  assert.equal(lifecycle.retryAllowed({ state: 'failed', stage: 'failed' }), true);
  assert.equal(lifecycle.retryAllowed({ state: 'completed', stage: 'rolled_back' }), true);
  assert.equal(lifecycle.retryAllowed({ state: 'completed', stage: 'completed' }), false);
  assert.equal(lifecycle.approvalAllowed({ state: 'paused', stage: 'awaiting_approval' }), true);
  assert.equal(lifecycle.approvalAllowed({ state: 'paused', stage: 'previewing' }), false);
  assert.equal(lifecycle.rollbackAllowed({ state: 'completed', stage: 'completed' }), true);
  assert.equal(lifecycle.rollbackAllowed({ state: 'completed', stage: 'rolled_back' }), false);
});

test('Rating cancellation waits for a running worker and does not reopen terminal jobs', () => {
  assert.equal(lifecycle.cancellationState({ state: 'running' }), 'cancelling');
  assert.equal(lifecycle.cancellationState({ state: 'paused' }), 'cancelled');
  assert.equal(lifecycle.cancellationState({ state: 'completed' }), null);
  assert.equal(lifecycle.shouldApply({ stage: 'applying' }), true);
  assert.equal(lifecycle.shouldApply({ stage: 'preview' }), false);
});

test('the Rating API routes use the tested lifecycle policy', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_rating_domain.js'), 'utf8');
  assert.match(source, /require\('\.\.\/libs\/rating-job-lifecycle'\)/);
  assert.match(source, /ratingJobLifecycle\.retryAllowed\(job\)/);
  assert.match(source, /ratingJobLifecycle\.approvalAllowed\(job\)/);
  assert.match(source, /ratingJobLifecycle\.rollbackAllowed\(job\)/);
  assert.match(source, /ratingJobLifecycle\.cancellationState\(job\)/);
  assert.match(source, /ratingJobLifecycle\.shouldApply\(job\)/);
});
