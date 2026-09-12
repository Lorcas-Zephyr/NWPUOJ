'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { effectiveTimeLimit, isPythonLanguage } = require('../libs/python-time-limit');

test('Python time limits use the configured multiplier', () => {
  assert.equal(effectiveTimeLimit(1000, 'python311', 2), 2000);
  assert.equal(effectiveTimeLimit(1000, 'pypy3', 1.5), 1500);
  assert.equal(effectiveTimeLimit(1000, 'cpp23', 2), 1000);
  assert.equal(effectiveTimeLimit(1000, 'python3', 0), 2000);
  assert.equal(isPythonLanguage('python310'), true);
  assert.equal(isPythonLanguage('pypy3'), true);
  assert.equal(isPythonLanguage('java'), false);
});
