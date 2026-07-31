'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const test = require('node:test');
const upload = require('../libs/testdata-upload');

const exec = promisify(execFile);

test('testdata ZIP extraction rejects traversal and atomically replaces only validated staging directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwpuoj-testdata-upload-'));
  try {
    const source = path.join(root, 'source'); const archive = path.join(root, 'data.zip'); const staging = path.join(root, 'staging'); const current = path.join(root, 'current'); const backup = path.join(root, 'backup');
    await fs.ensureDir(source); await fs.writeFile(path.join(source, '1.in'), '1 2\n'); await fs.writeFile(path.join(source, '1.out'), '3\n');
    await exec('zip', ['-q', archive, '1.in', '1.out'], { cwd: source });
    const extracted = await upload.extractTestdataArchive(archive, staging);
    assert.equal(extracted.entries, 2);
    await fs.ensureDir(current); await fs.writeFile(path.join(current, 'old.in'), 'old');
    await upload.replaceDirectory(current, staging, backup);
    assert.equal(await fs.readFile(path.join(current, '1.out'), 'utf8'), '3\n');
    assert.equal(await fs.pathExists(backup), false);
    await assert.rejects(upload.extractTestdataArchive(archive, path.join(root, 'unsafe'), { maxEntries: 1 }), /too many entries/);
  } finally { await fs.remove(root); }
});

test('single-file deletion rejects path traversal and emits audited domain events', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_problem_workflows.js'), 'utf8');
  assert.match(source, /function testdataFilename/);
  assert.match(source, /path\.posix\.basename\(filename\)/);
  assert.match(source, /path\.win32\.basename\(filename\)/);
  assert.match(source, /Buffer\.byteLength\(filename, 'utf8'\) > 255/);
  assert.match(source, /path\.dirname\(target\) !== root/);
  assert.match(source, /problem\.deleteTestdataSingleFile\(filename\)/);
  assert.match(source, /action: 'problem:testdata\.file\.delete'/);
  assert.match(source, /type: 'problem\.testdata\.file\.deleted'/);
  assert.match(source, /TESTDATA_FILE_NOT_FOUND/);
});
