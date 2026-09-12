'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../..');
const webConfig = require('../web.json');
const languageConfig = require('../language-config.json');
const judgeDockerfile = fs.readFileSync(path.join(projectRoot, 'Dockerfile.judge'), 'utf8');

test('web exposes versioned language names and matching filters', () => {
  assert.deepEqual(webConfig.filter_enabled_languages, webConfig.enabled_languages);
  assert.equal(languageConfig.cpp.show, 'C++ 03');
  assert.equal(languageConfig.python3.show, 'Python 3.8');

  const expected = {
    cpp20: 'C++ 20',
    cpp23: 'C++ 23',
    python310: 'Python 3.10',
    python311: 'Python 3.11',
    pypy3: 'PyPy 3.11'
  };
  for (const [id, label] of Object.entries(expected)) {
    assert.ok(webConfig.enabled_languages.includes(id));
    assert.equal(languageConfig[id].show, label);
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
  assert.match(judgeDockerfile, /PYPY_VERSION=7\.3\.23/);
  assert.match(judgeDockerfile, /PYPY_SHA256=16f9f56e82d1f4ec95a324c1a8cacfd78afc7f0656c0a809a18725ef4391453a/);
  assert.match(judgeDockerfile, /\/opt\/pypy\/bin > \/rootfs\/etc\/ld\.so\.conf\.d\/pypy\.conf/);
});
