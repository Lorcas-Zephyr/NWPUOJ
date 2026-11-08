'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const test = require('node:test');
const vm = require('node:vm');
const upload = require('../libs/testdata-upload');

const exec = promisify(execFile);

test('normalizes Windows CRLF and UTF-8 BOM without trimming data, isolated CR or missing final newline', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwpuoj-newlines-'));
  try {
    const filename = path.join(root, 'sample.in');
    const original = '\ufeff  中文\t \r\n\r\nword\rdata\nlast  ';
    await fs.writeFile(filename, original);
    const result = await upload.normalizeTestdataTextFile(filename);
    assert.equal(result.crlf, 2); assert.equal(result.bom, true);
    assert.equal(await fs.readFile(filename, 'utf8'), '  中文\t \n\nword\rdata\nlast  ');
    assert.equal((await fs.stat(filename)).size, result.size);
    assert.equal((await upload.normalizeTestdataTextFile(filename)).changed, false);
    for (const content of ['', '\n', '\r', 'line\n', 'no newline', 'interior\ufeffBOM']) {
      await fs.writeFile(filename, content);
      assert.equal((await upload.normalizeTestdataTextFile(filename)).changed, false);
      assert.equal(await fs.readFile(filename, 'utf8'), content);
    }
  } finally { await fs.remove(root); }
});

test('chunk boundaries and legacy text bytes survive streaming normalization; binary markers anywhere prevent conversion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwpuoj-newline-stream-'));
  try {
    const filename = path.join(root, 'large.in');
    const contents = Buffer.concat([Buffer.alloc(65535, 97), Buffer.from('\r\n'), Buffer.from([0xd6, 0xd0]), Buffer.from('\r\nend\r')]);
    await fs.writeFile(filename, contents);
    assert.equal((await upload.normalizeTestdataTextFile(filename)).crlf, 2);
    assert.deepEqual(await fs.readFile(filename), Buffer.from(contents.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'));
    // BOM shifts the second pass by three bytes; exercise its chunk boundary too.
    await fs.writeFile(filename, Buffer.concat([Buffer.from('\ufeff'), contents]));
    assert.equal((await upload.normalizeTestdataTextFile(filename)).crlf, 2);
    assert.deepEqual(await fs.readFile(filename), Buffer.from(contents.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'));
    for (const bytes of [Buffer.concat([Buffer.from('\ufeff'), contents, Buffer.from([0])]),
      Buffer.from([0xff, 0xfe, 0x31, 0, 13, 0, 10, 0]), Buffer.from([0xfe, 0xff, 0, 13, 0, 10]),
      Buffer.from([0x7f, 69, 76, 70, 13, 10]), Buffer.from([65, 13, 10, 1])]) {
      await fs.writeFile(filename, bytes);
      const result = await upload.normalizeTestdataTextFile(filename);
      assert.equal(result.skipped_binary, true); assert.equal(result.changed, false);
      assert.deepEqual(await fs.readFile(filename), bytes);
    }
    const target = path.join(root, 'outside'); await fs.writeFile(target, 'x\r\n');
    const link = path.join(root, 'link.in'); await fs.symlink(target, link);
    await assert.rejects(upload.normalizeTestdataTextFile(link), /regular file/);
    assert.equal(await fs.readFile(target, 'utf8'), 'x\r\n');
  } finally { await fs.remove(root); }
});

function modelForUploads(root) {
  const context = { exports: {}, __dirname: path.join(__dirname, '../models-built'),
    syzoj: { config: { limit: {} }, utils: { lock: async (_key, work) => work() } },
    require(name) {
      if (name === 'typeorm') return { Entity: () => () => {}, Column: () => () => {}, Index: () => () => {}, PrimaryGeneratedColumn: () => () => {} };
      if (name === './common') return { default: function Model() {} };
      if (name === 'fs-extra') return fs;
      if (name === 'path') return path;
      if (name === '../libs/testdata-upload') return upload;
      return {};
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../models-built/problem.js'), 'utf8'), context);
  const problem = new context.exports.default();
  problem.id = 7; problem.getTestdataPath = () => path.join(root, 'current');
  problem.getTestdataArchivePath = () => path.join(root, 'current.zip');
  return problem;
}

test('single-file model upload normalizes before publishing and invalidates the downloadable archive', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwpuoj-newline-model-'));
  try {
    const problem = modelForUploads(root), source = path.join(root, 'incoming');
    await fs.writeFile(source, '\ufeff123\r\n'); await fs.writeFile(problem.getTestdataArchivePath(), 'old archive');
    const result = await problem.uploadTestdataSingleFile('1.in', source, 8, true);
    assert.equal(result.changed, true); assert.equal(result.crlf, 1); assert.equal(result.bom, true);
    assert.equal(await fs.readFile(path.join(problem.getTestdataPath(), '1.in'), 'utf8'), '123\n');
    assert.equal(await fs.pathExists(problem.getTestdataArchivePath()), false);
    const binary = Buffer.from([0, 65, 13, 10]); await fs.writeFile(source, binary);
    assert.equal((await problem.uploadTestdataSingleFile('2.in', source, binary.length, true)).skipped_binary, true);
    assert.deepEqual(await fs.readFile(path.join(problem.getTestdataPath(), '2.in')), binary);
  } finally { await fs.remove(root); }
});

test('ZIP job normalizes before validation and immutable snapshots, keeps binary content and discards stale archive', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwpuoj-newline-job-'));
  try {
    const source = path.join(root, 'source'), jobs = path.join(root, 'jobs');
    await fs.ensureDir(path.join(source, 'data')); await fs.ensureDir(jobs);
    await fs.writeFile(path.join(source, 'data', '1.in'), '\ufeff1\r\n');
    await fs.writeFile(path.join(source, 'data', '1.out'), '2\r\n');
    const binary = Buffer.from([0, 13, 10, 255]); await fs.writeFile(path.join(source, 'data', 'blob.bin'), binary);
    const archive = '12345678-1234-1234-1234-123456789abc.zip';
    await exec('zip', ['-q', '-r', path.join(jobs, archive), 'data'], { cwd: source });
    const problem = modelForUploads(root); problem.type = 'traditional';
    await fs.ensureDir(problem.getTestdataPath()); await fs.writeFile(path.join(problem.getTestdataPath(), 'old.in'), 'old');
    await fs.writeFile(problem.getTestdataArchivePath(), 'old zip');
    const events = [], completed = [];
    const connection = { query: async (sql, params) => {
      if (sql.startsWith('SELECT')) return [{ cancel_requested: false, actor_id: 1, input_json: JSON.stringify({ archive }) }];
      if (sql.includes("state='failed'")) assert.fail(params[0]);
      if (sql.includes("state='completed'")) completed.push(JSON.parse(params[0]));
      return {};
    } };
    const snapshots = require('../libs/testdata-snapshot');
    const context = { fs, path, testdataUpload: upload, testdataSnapshots: snapshots,
      TypeORM: { getConnection: () => connection }, api: () => ({ appendEvent: async event => events.push(event) }),
      testdataUploadRoot: () => jobs, syzoj: { config: { upload_dir: root }, utils: {
        parseTestdata: async directory => {
          assert.equal(await fs.readFile(path.join(directory, '1.in'), 'utf8'), '1\n');
          assert.equal(await fs.readFile(path.join(directory, '1.out'), 'utf8'), '2\n');
          assert.deepEqual(await fs.readFile(path.join(directory, 'blob.bin')), binary);
          return [{ cases: [{}] }];
        }, problemV2: { refreshTestdataSnapshotFromDirectory: async (_problem, _user, directory) => ({ snapshot_id: 'ps_normalized_123', testdata: await snapshots.captureFromDirectory(root, directory, 'ps_normalized_123') }) }
      } } };
    const code = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_problem_workflows.js'), 'utf8');
    vm.runInNewContext(code.slice(code.indexOf('function testdataSummary('), code.indexOf('async function contentTransaction(')) + '\n' +
      code.slice(code.indexOf('async function parseProblemTestdata('), code.indexOf('async function runValidationJob(')) + '\n' +
      code.slice(code.indexOf('async function runUploadJob('), code.indexOf('\nasync function queueBulkArchive(', code.indexOf('async function runUploadJob('))), context);
    await context.runUploadJob('job', problem);
    assert.equal(completed.length, 1); assert.equal(completed[0].normalization.normalized_files, 2);
    assert.equal(completed[0].normalization.skipped_binary_files, 1);
    assert.equal(await fs.readFile(path.join(problem.getTestdataPath(), '1.in'), 'utf8'), '1\n');
    assert.equal(await fs.readFile(path.join(snapshots.snapshotDirectory(root, 'ps_normalized_123'), '1.out'), 'utf8'), '2\n');
    assert.equal(await fs.pathExists(problem.getTestdataArchivePath()), false);
    assert.equal(await fs.pathExists(path.join(jobs, archive)), false);
    assert.equal(events[0].payload.normalization.crlf, 2);
  } finally { await fs.remove(root); }
});

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
  assert.match(workflow, /const TESTDATA_ARCHIVE_LIMIT = 8 \* 1024 \* 1024 \* 1024/);
  assert.match(workflow, /limits: \{ fileSize: TESTDATA_ARCHIVE_LIMIT, files: 1 \}/);
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
