'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const signatures = require('../libs/judge-task-signature');

const key = 'test-only-judge-signing-key-32-bytes';

test('signed judge tasks survive stable object ordering', () => {
  const content = { taskId: 'abc', param: { memoryLimit: 512, language: 'cpp' }, securityPolicy: { network: 'deny', problemSnapshotId: 'snapshot-1', dataVersion: 'snapshot-1' } };
  signatures.attach(content, Buffer.from('answer-data'), key);
  assert.equal(signatures.verify(content, Buffer.from('answer-data'), key), true);
  const reordered = { securityPolicy: content.securityPolicy, param: content.param, taskId: content.taskId, taskSignature: content.taskSignature };
  assert.equal(signatures.verify(reordered, Buffer.from('answer-data'), key), true);
});

test('task policy and extra data tampering are rejected', () => {
  const content = { taskId: 'abc', param: { language: 'cpp' }, securityPolicy: { network: 'deny' } };
  signatures.attach(content, null, key);
  content.securityPolicy.network = 'allow';
  assert.equal(signatures.verify(content, null, key), false);
  content.securityPolicy.network = 'deny';
  assert.equal(signatures.verify(content, Buffer.from('changed'), key), false);
});

test('problem snapshot binding is part of the signed task policy', () => {
  const content = { taskId: 'abc', securityPolicy: { problemSnapshotId: 'ps_immutable', dataVersion: 'ps_immutable' } };
  signatures.attach(content, null, key);
  content.securityPolicy.problemSnapshotId = 'ps_mutable';
  assert.equal(signatures.verify(content, null, key), false);
});

test('judge tasks bind the worker testdata path and signed data hash from the immutable snapshot', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../libs-built/judger.js'), 'utf8');
  assert.match(source, /testData: problem\.judge_testdata_path \|\| problem\.id\.toString\(\)/);
  assert.match(source, /dataVersion: problem\.judge_testdata_hash \|\| snapshotId \|\| `legacy-problem:\$\{problem\.id\}`/);
});

test('judge tasks sign isolated compile-cache and compiler metadata', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../libs-built/judger.js'), 'utf8');
  assert.match(source, /compileCacheKeys\.compilerMetadata/);
  assert.match(source, /compilerVersion/);
  assert.match(source, /languageConfigHash/);
  assert.match(source, /compileCacheKey/);
  const content = { securityPolicy: { compileCacheKey: 'cache-a', compilerImage: 'image-a', compilerVersion: 'gcc-a' } };
  signatures.attach(content, null, key);
  content.securityPolicy.compileCacheKey = 'cache-b';
  assert.equal(signatures.verify(content, null, key), false);
});
