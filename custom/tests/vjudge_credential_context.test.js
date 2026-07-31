'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const credentialContext = require('../libs/vjudge-credential-context');

test('VJudge environment references resolve without exposing the reference as a session key', async () => {
  const credentials = await credentialContext.resolveReference('uoj', 'env:TEST_UOJ', {
    environment: { TEST_UOJ_USERNAME: 'alice', TEST_UOJ_PASSWORD: 'secret-one' }
  });
  assert.equal(credentials.username, 'alice');
  assert.equal(credentials.password, 'secret-one');
  assert.match(credentials.fingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(credentials.fingerprint, 'env:TEST_UOJ');
});

test('credential scopes remain isolated across concurrent provider operations', async () => {
  const environment = {
    FIRST_USERNAME: 'first-user', FIRST_PASSWORD: 'first-secret',
    SECOND_USERNAME: 'second-user', SECOND_PASSWORD: 'second-secret'
  };
  const observed = await Promise.all([
    credentialContext.run('hdu', 'env:FIRST', async () => {
      await new Promise(resolve => setImmediate(resolve));
      return credentialContext.current('hdu').username;
    }, { environment }),
    credentialContext.run('hdu', 'env:SECOND', async () => credentialContext.current('hdu').username, { environment })
  ]);
  assert.deepEqual(observed, ['first-user', 'second-user']);
});

test('credential scopes reject cross-provider use and unresolved references', async () => {
  const environment = { SHARED_USERNAME: 'judge', SHARED_PASSWORD: 'secret' };
  await assert.rejects(
    credentialContext.run('poj', 'env:SHARED', async () => credentialContext.current('uoj'), { environment }),
    /wrong VJudge provider/
  );
  await assert.rejects(() => credentialContext.resolveReference('uoj', 'vault://missing/account'), /cannot be resolved/);
  await assert.rejects(
    () => credentialContext.resolveReference('uoj', 'env:MISSING', { environment: {} }),
    /unavailable or incomplete/
  );
});

test('all provider clients partition cookies and login state by credential fingerprint', () => {
  const root = path.resolve(__dirname, '..');
  for (const provider of ['uoj', 'hdu', 'poj']) {
    const source = fs.readFileSync(path.join(root, 'libs-built/vjudge', provider + '.js'), 'utf8');
    assert.match(source, /const credentialSessions = new Map\(\)/);
    assert.match(source, /credentialSessions\.get\(credentials\.fingerprint\)/);
    assert.match(source, /credentialSessions\.set\(credentials\.fingerprint, session\)/);
    assert.match(source, new RegExp("credentialContext\\.run\\('" + provider + "', reference, operation, options\\)"));
    assert.doesNotMatch(source, new RegExp('process\\.env\\.SYZOJ_WEB_' + provider.toUpperCase() + '_(?:USERNAME|PASSWORD)'));
  }
});
