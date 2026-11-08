'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../..');
const webConfig = require('../web.json');
const languageConfig = require('../language-config.json');
const judgeDockerfile = fs.readFileSync(path.join(projectRoot, 'Dockerfile.judge'), 'utf8');

test('web exposes only the eight supported submission languages and matching versions', () => {
  assert.deepEqual(webConfig.filter_enabled_languages, webConfig.enabled_languages);
  assert.equal(languageConfig.cpp.show, 'C++ 03');
  assert.equal(languageConfig.python3.show, 'Python 3.8');

  const expected = {
    cpp11: ['C++ 11', 'GCC 10.2.0'],
    cpp17: ['C++ 17', 'GCC 10.2.0'],
    cpp20: ['C++ 20', 'GCC 13.1.0'],
    cpp23: ['C++ 23', 'GCC 14.3.0'],
    c: ['C', 'Clang 12.0.1'],
    java: ['Java 11', 'OpenJDK 11.0.11'],
    python311: ['Python 3.11', 'CPython 3.11.15'],
    pypy3: ['PyPy 3.11', 'PyPy 7.3.23']
  };
  assert.deepEqual(webConfig.enabled_languages, Object.keys(expected));
  for (const [id, [label, version]] of Object.entries(expected)) {
    assert.equal(languageConfig[id].show, label);
    assert.equal(languageConfig[id].version, version);
  }
});

test('judge registers modern C++ and Python runtimes', () => {
  const indexSource = fs.readFileSync(path.join(projectRoot, 'custom/judge/languages/index.js'), 'utf8');
  for (const id of ['cpp20', 'cpp23', 'python2', 'python3', 'python310', 'python311', 'pypy3']) {
    assert.match(indexSource, new RegExp(`require\\(\\"\\./${id}\\"\\)`));
  }

  const cpp20 = require('../judge/languages/cpp20').lang;
  const cpp23 = require('../judge/languages/cpp23').lang;
  const cpp17 = require('../judge/languages/cpp17').lang;
  const python310 = require('../judge/languages/python310').lang;
  const python311 = require('../judge/languages/python311').lang;
  const pypy3 = require('../judge/languages/pypy3').lang;
  const python2 = require('../judge/languages/python2').lang;
  const python3 = require('../judge/languages/python3').lang;
  const java = require('../judge/languages/java').lang;

  assert.equal(cpp20.compile('/source', '/binary').executable, '/usr/bin/g++-13');
  assert.ok(cpp20.compile('/source', '/binary').parameters.includes('-std=c++20'));
  assert.equal(cpp17.compile('/source', '/binary', true).time, 15000);
  const cpp23Compile = cpp23.compile('/source', '/binary');
  assert.ok(cpp23Compile.parameters.includes('-std=c++23'));
  assert.equal(cpp23Compile.executable, '/usr/bin/g++-14');
  assert.equal(python310.run('/binary', '/work', 1000, 256).executable, '/usr/bin/python3.10');
  assert.equal(python311.run('/binary', '/work', 1000, 256).executable, '/usr/bin/python3.11');
  assert.equal(pypy3.run('/binary', '/work', 1000, 256).executable, '/opt/pypy/bin/pypy3');
  for (const language of [python2, python3, python310, python311, pypy3]) {
    assert.match(language.run('/binary', '/work', 1000, 256).parameters.join(' '), /setrecursionlimit\(1000000\)/);
  }
  assert.equal(java.compile('/source/Main.java', '/binary').executable, '/bin/bash');
  assert.match(java.compile('/source/Main.java', '/binary').parameters[2], /LD_LIBRARY_PATH=.*lib\/jli/);
  assert.equal(java.run('/binary', '/work', 1000, 256).executable, '/bin/bash');
  assert.match(java.run('/binary', '/work', 1000, 256).parameters[2], /LD_LIBRARY_PATH=.*lib\/jli/);
  assert.match(java.run('/binary', '/work', 1000, 256).parameters[2], /ActiveProcessorCount=2/);
  assert.match(java.run('/binary', '/work', 1000, 256).parameters[2], /ParallelGCThreads=2/);
  assert.match(judgeDockerfile, /PYPY_VERSION=7\.3\.23/);
  assert.match(judgeDockerfile, /PYPY_SHA256=16f9f56e82d1f4ec95a324c1a8cacfd78afc7f0656c0a809a18725ef4391453a/);
  assert.match(judgeDockerfile, /\/opt\/pypy\/bin > \/rootfs\/etc\/ld\.so\.conf\.d\/pypy\.conf/);
});
