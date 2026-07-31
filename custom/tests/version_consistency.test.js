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

test('SYZOJ Web images are pinned to one repository digest', () => {
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile.web'), 'utf8');
  const images = Array.from((compose + '\n' + dockerfile).matchAll(/(?:image:\s*|FROM\s+)(menci\/syzoj-web@sha256:[a-f0-9]{64})/g), match => match[1]);

  assert.strictEqual(images.length, 2);
  assert.strictEqual(new Set(images).size, 1);
  assert.doesNotMatch(compose, /^\s*image:\s*menci\/syzoj-web\s*$/m);
});

test('operator documentation covers v2 usage, maintenance, and rollback boundaries', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const userGuide = fs.readFileSync(path.join(root, 'docs/USER_GUIDE.md'), 'utf8');
  const maintenance = fs.readFileSync(path.join(root, 'docs/MAINTENANCE.md'), 'utf8');
  const release = fs.readFileSync(path.join(root, 'RELEASE.md'), 'utf8');

  assert.match(readme, /\[使用手册\]\(docs\/USER_GUIDE\.md\)/);
  assert.match(readme, /\[部署与维护手册\]\(docs\/MAINTENANCE\.md\)/);
  assert.match(userGuide, /题库与做题/);
  assert.match(userGuide, /管理后台/);
  assert.match(maintenance, /\/api\/v2/);
  assert.match(maintenance, /docker compose down -v/);
  assert.match(maintenance, /npm test/);
  assert.match(maintenance, /备份策略/);
  assert.match(maintenance, /VJudge 运维/);
  assert.match(release, /Rollback/);
});
