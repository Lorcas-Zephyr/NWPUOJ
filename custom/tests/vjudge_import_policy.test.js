'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const policy = require('../libs/vjudge-import-policy');

test('VJudge import conflict and retry policy preserves completed imports', () => {
  assert.deepEqual(policy.normalizeRemoteIds([' 1 ', 2, '2', '0', 'bad']), ['1', '2']);
  assert.equal(policy.initialItemState({ id: 7 }, 'skip'), 'skipped');
  assert.equal(policy.initialItemState({ id: 7 }, 'overwrite'), 'pending');
  assert.equal(policy.initialItemState(null, 'skip'), 'pending');
  assert.equal(policy.retryAllowed({ state: 'failed', failed: 0 }), true);
  assert.equal(policy.retryAllowed({ state: 'cancelled', failed: 0 }), true);
  assert.equal(policy.retryAllowed({ state: 'completed', failed: 1 }), true);
  assert.equal(policy.retryAllowed({ state: 'completed', failed: 0 }), false);
});

test('VJudge cancellation and client failure messages never expose credentials', () => {
  assert.equal(policy.cancellationState({ state: 'running' }), 'cancelling');
  assert.equal(policy.cancellationState({ state: 'queued' }), 'cancelled');
  assert.equal(policy.cancellationState({ state: 'completed' }), null);
  const secret = 'password=super-secret-token';
  for (const error of [{ message: secret }, { publicCode: 'PROVIDER_ADAPTER_UNAVAILABLE', message: secret }]) {
    const failure = policy.classifyFailure(error);
    assert.ok(policy.PUBLIC_FAILURES[failure.code]);
    assert.doesNotMatch(failure.message, /super-secret-token|password/i);
  }
});

test('VJudge retries only transient upstream failures with bounded exponential backoff', () => {
  assert.equal(policy.retryableFailure({ code: 'UPSTREAM_RATE_LIMITED' }), true);
  assert.equal(policy.retryableFailure({ code: 'UPSTREAM_UNAVAILABLE' }), true);
  assert.equal(policy.retryableFailure({ code: 'UPSTREAM_AUTH_FAILED' }), false);
  assert.equal(policy.retryableFailure({ code: 'UPSTREAM_RESPONSE_INVALID' }), false);
  assert.deepEqual([1, 2, 3, 20].map(attempt => policy.retryDelayMs(attempt, 500)), [500, 1000, 2000, 30000]);
});

test('the VJudge API routes use the tested import policy', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_vjudge_domain.js'), 'utf8');
  assert.match(source, /require\('\.\.\/libs\/vjudge-import-policy'\)/);
  assert.match(source, /vjudgeImportPolicy\.initialItemState\(existing, options\.conflict_policy\)/);
  assert.match(source, /vjudgeImportPolicy\.retryAllowed\(rows\[0\]\)/);
  assert.match(source, /vjudgeImportPolicy\.classifyFailure\(error\)/);
  assert.match(source, /vjudgeImportPolicy\.cancellationState\(rows\[0\]\)/);
  assert.match(source, /createProviderScheduler/);
  assert.match(source, /providerScheduler\.run\(providerId, provider\.rateLimitMs, operation\)/);
  assert.match(source, /\['withCredential', 'fetchProblemIds', 'importProblem'\]/);
  assert.match(source, /async function loadJobCredentialReference\(job/);
  assert.match(source, /id=\? AND user_id=\? AND provider=\? AND credential_ref=\? AND status='active'/);
  assert.match(source, /adapter\.withCredential\(reference, \(\) => providerOperation/);
  assert.match(source, /credential_id,credential_fingerprint,state,stage/);
  assert.match(source, /vjudgeImportPolicy\.retryableFailure\(failure\)/);
  assert.match(source, /adapter\.importProblem[\s\S]*?\{ retry: false \}/);
  assert.match(source, /app\.get\('\/api\/v2\/vjudge\/imports\/:id\/events'[\s\S]*?return api\(\)\.sse\(req, res, `vjudge-import:\$\{req\.params\.id\}`\)/);
  assert.match(source, /app\.get\('\/api\/v2\/vjudge\/remote-problems\/:source\/:remote_id'/);
  assert.match(source, /app\.post\('\/api\/v2\/vjudge\/sources\/:id\/test-connection'/);
  assert.match(source, /app\.post\('\/api\/v2\/vjudge\/sources\/:id\/imports'/);
  assert.match(source, /app\.post\('\/api\/v2\/vjudge\/problems\/:id\/submissions'/);
  assert.match(source, /FROM vjudge_v2_remote_problem WHERE provider=\? AND remote_id=\?/);
  assert.match(source, /!problem\.is_public && !editable/);
  assert.match(source, /syzoj\.utils\.problemV2\.serializeProblem/);
  assert.doesNotMatch(source, /remote-problems[\s\S]{0,1200}credential_ref/);
});
