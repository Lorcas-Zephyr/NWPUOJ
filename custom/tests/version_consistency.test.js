'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

test('NWPUOJ release version is synchronized', () => {
  const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  const web = readJson('custom/web.json');
  const packageJson = readJson('custom/package.json');
  const packageLock = readJson('custom/package-lock.json');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(web.nwpuoj_version, version);
  assert.strictEqual(packageJson.version, version);
  assert.strictEqual(packageLock.version, version);
  assert.strictEqual(packageLock.packages[''].version, version);
  assert.match(readme, new RegExp(`当前发行版：\\*\\*v${version.replace(/\./g, '\\.')}\\*\\*`));
});
