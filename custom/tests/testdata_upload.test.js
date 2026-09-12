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

test('testdata archives with one containing directory are flattened before parsing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwpuoj-testdata-nested-'));
  try {
    const source = path.join(root, 'source'); const archive = path.join(root, 'data.zip'); const staging = path.join(root, 'staging');
    await fs.ensureDir(path.join(source, 'data'));
    await fs.writeFile(path.join(source, 'data', '1.in'), '1\n');
    await fs.writeFile(path.join(source, 'data', '1.out'), '1\n');
    await exec('zip', ['-q', '-r', archive, 'data'], { cwd: source });
    await upload.extractTestdataArchive(archive, staging);
    assert.equal(await upload.normalizeTestdataDirectory(staging), true);
    assert.equal(await fs.pathExists(path.join(staging, '1.in')), true);
    assert.equal(await fs.pathExists(path.join(staging, 'data')), false);
  } finally { await fs.remove(root); }
});

test('root metadata with a conventional data directory is flattened and data.yml paths stay valid', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwpuoj-testdata-metadata-'));
  try {
    const staging = path.join(root, 'staging');
    await fs.ensureDir(path.join(staging, 'data'));
    await fs.writeFile(path.join(staging, 'data', '01.in'), '1\n');
    await fs.writeFile(path.join(staging, 'data', '01.out'), '1\n');
    await fs.writeFile(path.join(staging, 'data.yml'), [
      'inputFile: "data/#.in"',
      'outputFile: "data/#.out"',
      'subtasks:',
      '  - score: 100',
      '    type: sum',
      '    cases: ["01"]',
      ''
    ].join('\n'));
    assert.equal(await upload.normalizeTestdataDirectory(staging), true);
    assert.equal(await fs.pathExists(path.join(staging, '01.in')), true);
    assert.equal((await fs.readFile(path.join(staging, 'data.yml'), 'utf8')).includes('inputFile:'), true);
    assert.match(await fs.readFile(path.join(staging, 'data.yml'), 'utf8'), /inputFile:\s+['"]?#\.in/);
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

test('testdata upload pages wait for durable data before refreshing their testcase summary', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_problem_workflows.js'), 'utf8');
  const manage = fs.readFileSync(path.join(__dirname, '../views/problem_manage.ejs'), 'utf8');
  const data = fs.readFileSync(path.join(__dirname, '../views/problem_data.ejs'), 'utf8');

  assert.match(workflow, /function testdataSummary\(parsed\)/);
  assert.match(workflow, /const testcases = subtasks\.reduce/);
  assert.match(workflow, /summary = \{ valid: false, testcases: 0, special_judge: false, error:/);
  assert.match(workflow, /filenames: uploaded, testdata: summary/);
  assert.match(workflow, /refreshCurrentTestdataSnapshot\(problem, Number\(rows\[0\]\.actor_id\)\)/);
  assert.match(workflow, /refreshCurrentTestdataSnapshot\(problem, user\.id\)/);
  assert.match(workflow, /result\.snapshot_id = snapshot\.snapshot_id/);
  assert.match(workflow, /snapshot_id: snapshot && snapshot\.snapshot_id \|\| null/);
  assert.match(workflow, /limits: \{ fileSize: 200 \* 1024 \* 1024, files: 1 \}/);
  assert.match(workflow, /testdata\/upload\/chunk/);
  assert.match(workflow, /testdata\/upload\/complete/);
  assert.match(workflow, /TESTDATA_CHUNK_SIZE = 512 \* 1024/);
  assert.match(workflow, /normalizeTestdataDirectory\(staging\)/);
  assert.match(manage, /name="python_time_limit_multiplier"/);
  assert.match(manage, /python_time_limit_multiplier: form\.elements\.python_time_limit_multiplier\.value/);
  assert.match(manage, /var currentEtag = current\.headers\.get\('ETag'\) \|\| currentBody && currentBody\.meta && currentBody\.meta\.etag/);
  assert.match(manage, /'If-Match': currentEtag/);
  assert.match(manage, /if_match: currentEtag/);
  assert.match(manage, /uploadTestdataArchive/);
  assert.match(manage, /chunkSize = 512 \* 1024/);
  assert.match(manage, /testdata\/upload\/chunk/);
  assert.match(manage, /testdata\/upload\/complete/);
  assert.match(manage, /async function waitForTestdataJob\(jobId\)/);
  assert.match(manage, /\/api\/v2\/problem-jobs\/' \+ encodeURIComponent\(jobId\)/);
  assert.match(manage, /if \(job\.state === 'completed'\) return job/);
  assert.match(manage, /await waitForTestdataJob\(testdataJob\)/);
  assert.match(manage, /window\.location\.replace\(next\.pathname \+ next\.search\)/);
  assert.doesNotMatch(manage, /\/admin\/jobs\?job=/);
  assert.match(data, /data-testdata-upload-status/);
  assert.match(data, /body\.data\.testdata/);
  assert.match(data, /window\.location\.replace\(next\.pathname \+ next\.search\)/);
  assert.doesNotMatch(data, /window\.location\.reload\(\)/);
});
