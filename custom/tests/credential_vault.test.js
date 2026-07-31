'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vault = require('../libs/credential-vault');

test('credential references round trip through authenticated encryption', () => {
  const key = Buffer.alloc(32, 7);
  const encrypted = vault.encrypt('env:SYZOJ_WEB_UOJ', key, 'uoj');
  assert.notEqual(encrypted.ciphertext, 'env:SYZOJ_WEB_UOJ');
  assert.equal(vault.decrypt(encrypted, key, 'uoj'), 'env:SYZOJ_WEB_UOJ');
  assert.throws(() => vault.decrypt(encrypted, key, 'hdu'));
});

test('vault keys accept exact hex and base64 encodings', () => {
  const key = Buffer.alloc(32, 3);
  assert.deepEqual(vault.parseKey(key.toString('hex')), key);
  assert.deepEqual(vault.parseKey(key.toString('base64')), key);
  assert.equal(vault.parseKey('short'), null);
});

test('credential fingerprints are stable without revealing the reference', () => {
  const fingerprint = vault.referenceFingerprint('vault://provider/account');
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(fingerprint, 'vault://provider/account');
});
