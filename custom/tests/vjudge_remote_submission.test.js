'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const remoteSubmission = require('../libs/vjudge-remote-submission');

const root = path.resolve(__dirname, '../..');

test('remote VJudge snapshot exposes only stable task linkage and lifecycle state', () => {
  const sync = remoteSubmission.snapshot(
    { id: 42, pending: true, status: 'Waiting' },
    { type: 'vjudge:hdu' },
    { provider: 'hdu', submissionId: 9001, problemId: 1000, phase: 'submitting', session: 'must-not-leak' }
  );
  assert.deepEqual(remoteSubmission.publicSync(sync), {
    local_submission_id: 42, provider: 'hdu', upstream_task_id: '9001', remote_problem_id: '1000',
    phase: 'submitting', local_status: 'Waiting', updated_at: null
  });
  assert.equal(sync.marker_hash.length, 64);
  assert.equal(JSON.stringify(remoteSubmission.publicSync(sync)).includes('must-not-leak'), false);
  assert.equal(remoteSubmission.eventType(sync), 'vjudge.submission.submitting');
});

test('remote VJudge sync completes local terminal submissions and is idempotent by marker hash', () => {
  const current = remoteSubmission.snapshot(
    { id: 77, pending: false, status: 'Accepted' },
    { type: 'vjudge:uoj' },
    { provider: 'uoj', submissionId: 500, problemId: 1, phase: 'judging' }
  );
  assert.equal(current.phase, 'completed');
  assert.equal(remoteSubmission.eventType(current), 'vjudge.submission.completed');
  assert.equal(remoteSubmission.hasChanged({ ...current }, current), false);
  assert.equal(remoteSubmission.hasChanged({ ...current, local_status: 'Wrong Answer' }, current), true);
  assert.equal(remoteSubmission.snapshot({ id: 1, pending: true }, { type: 'traditional' }, null), null);
});

test('all active VJudge providers implement the submission adapter contract and route the runner through it', () => {
  for (const provider of remoteSubmission.PROVIDERS) {
    const source = fs.readFileSync(path.join(root, 'custom/libs-built/vjudge', provider + '.js'), 'utf8');
    for (const method of remoteSubmission.ADAPTER_METHODS) {
      assert.match(source, new RegExp('vjudge\\.' + method.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '\\s*='), provider + ' implements ' + method);
    }
    assert.match(source, /远程提交必须关联本地评测任务/);
    assert.match(source, /await vjudge\.submit\(/);
    assert.match(source, /await vjudge\.pollSubmission\(/);
  }
});

test('VJudge API sync persists a changed marker once and publishes it on the submission stream', () => {
  const source = fs.readFileSync(path.join(root, 'custom/modules/_api_v2_vjudge_domain.js'), 'utf8');
  assert.match(source, /require\('\.\.\/libs\/vjudge-remote-submission'\)/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS vjudge_v2_submission_sync/);
  assert.match(source, /async function persistSubmissionSync\(sync\)/);
  assert.match(source, /SELECT \* FROM vjudge_v2_submission_sync[^\n]*FOR UPDATE/);
  assert.match(source, /vjudgeRemoteSubmission\.hasChanged\(previous, sync\)/);
  assert.match(source, /stream: `submission:\$\{sync\.local_submission_id\}`/);
  assert.match(source, /api\(\)\.publishEvent\(stored\.event\)/);
  assert.match(source, /sync_event_id/);
  assert.match(source, /vjudge:submission\.create/);
  assert.match(source, /submissionV2\.createSubmission/);
});
