'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const recovery = require('../libs/vjudge-job-recovery');

test('interrupted VJudge imports retain a requested cancellation across restart', () => {
  assert.deepEqual(recovery.recoveryAction({ state: 'cancelling', cancel_requested: 1 }), {
    state: 'cancelled', stage: 'cancelled', shouldRun: false
  });
  assert.deepEqual(recovery.recoveryAction({ state: 'running', cancel_requested: true }), {
    state: 'cancelled', stage: 'cancelled', shouldRun: false
  });
});

test('only non-cancelled interrupted imports resume after restart', () => {
  assert.deepEqual(recovery.recoveryAction({ state: 'running', cancel_requested: 0 }), {
    state: 'queued', stage: 'recovering', shouldRun: true
  });
  assert.deepEqual(recovery.recoveryAction({ state: 'cancelling', cancel_requested: '0' }), {
    state: 'queued', stage: 'recovering', shouldRun: true
  });
  assert.equal(recovery.recoveryAction({ state: 'paused', cancel_requested: 0 }), null);
});

test('the VJudge domain executes the tested recovery decision before queueing work', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_vjudge_domain.js'), 'utf8');
  assert.match(source, /require\('\.\.\/libs\/vjudge-job-recovery'\)/);
  assert.match(source, /async function recoverVjudgeImportJobs\(\)/);
  assert.match(source, /vjudgeJobRecovery\.recoveryAction\(job\)/);
  assert.match(source, /cancel_requested=1/);
  assert.match(source, /state='queued' AND cancel_requested=0/);
});
