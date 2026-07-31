'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const cache = require('../libs/compile-cache-key');

test('compile cache keys are stable across configuration key order', () => {
  const left = cache.compilerMetadata({
    source: 'int main() {}', language: 'cpp20', languageConfig: { run: 'a', compile: 'b' },
    compilerImage: 'judge@sha256:abc', compilerVersion: 'gcc-14.1'
  });
  const right = cache.compilerMetadata({
    source: 'int main() {}', language: 'cpp20', languageConfig: { compile: 'b', run: 'a' },
    compilerImage: 'judge@sha256:abc', compilerVersion: 'gcc-14.1'
  });
  assert.equal(left.compileCacheKey, right.compileCacheKey);
  assert.equal(left.languageConfigHash, right.languageConfigHash);
});

test('source, language configuration, image, and compiler version isolate cache keys', () => {
  const base = { source: 'code', language: 'cpp20', languageConfig: { compile: 'g++' }, compilerImage: 'image:a', compilerVersion: 'gcc-a' };
  const original = cache.compilerMetadata(base).compileCacheKey;
  for (const changed of [
    { source: 'changed' },
    { language: 'rust' },
    { languageConfig: { compile: 'clang++' } },
    { compilerImage: 'image:b' },
    { compilerVersion: 'gcc-b' }
  ]) assert.notEqual(cache.compilerMetadata({ ...base, ...changed }).compileCacheKey, original);
});
