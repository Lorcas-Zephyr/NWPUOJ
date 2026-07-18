const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');
const importer = require(process.env.PROBLEM_BULK_IMPORT_LIB || '../libs/problem-bulk-import');

async function writeProblem(root, folder, metadata, options) {
  const directory = path.join(root, folder);
  await fs.mkdir(path.join(directory, 'testdata'), { recursive: true });
  await fs.writeFile(path.join(directory, 'problem.json'), JSON.stringify(metadata), 'utf8');
  await fs.writeFile(path.join(directory, 'description.md'), '# ' + metadata.title, 'utf8');
  await fs.writeFile(path.join(directory, 'input.md'), 'Input', 'utf8');
  await fs.writeFile(path.join(directory, 'output.md'), 'Output', 'utf8');
  await fs.writeFile(path.join(directory, 'testdata', '1.in'), '1 2\n', 'utf8');
  if (!options || !options.missingOutput) {
    await fs.writeFile(path.join(directory, 'testdata', '1.out'), '3\n', 'utf8');
  }
  if (options && options.extraFile) await fs.writeFile(path.join(directory, options.extraFile), 'bad', 'utf8');
}

function createZip(source, output, folders) {
  childProcess.execFileSync('zip', ['-qr', output].concat(folders), { cwd: source });
}

test('extracts a valid multi-problem archive', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'problem-import-test-'));
  try {
    const source = path.join(temporary, 'source');
    const staging = path.join(temporary, 'staging');
    await fs.mkdir(source);
    await writeProblem(source, 'A', {
      title: 'A+B Problem', time_limit: 1000, memory_limit: 256, tags: ['入门'], is_anonymous: false
    });
    await writeProblem(source, 'B', {
      title: 'Second Problem', time_limit: 2000, memory_limit: 512
    });
    const archive = path.join(temporary, 'problems.zip');
    createZip(source, archive, ['A', 'B']);
    const specs = await importer.extractArchive(archive, staging);
    assert.deepStrictEqual(specs.map(spec => spec.title), ['A+B Problem', 'Second Problem']);
    assert.strictEqual(specs[0].timeLimit, 1000);
    assert.deepStrictEqual(specs[0].tags, ['入门']);
    assert.deepStrictEqual(specs[0].testdataFiles, ['1.in', '1.out']);
    assert.strictEqual(await fs.readFile(path.join(specs[1].testdataDirectory, '1.out'), 'utf8'), '3\n');
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('rejects paths outside the strict layout', () => {
  const entry = { fileName: '../evil/problem.json', externalFileAttributes: 0, generalPurposeBitFlag: 0 };
  assert.throws(() => {
    const info = importer.normalizedEntry(entry);
    importer.validateArchivePath(info);
  }, /路径穿越|子文件夹名称/);
  assert.throws(() => importer.normalizedEntry({
    fileName: 'A/problem.json', externalFileAttributes: 0xa000 << 16, generalPurposeBitFlag: 0
  }), /符号链接/);
});

test('rejects unknown metadata fields and duplicate tags', () => {
  assert.throws(() => importer.parseMetadata(JSON.stringify({
    title: 'A', time_limit: 1000, memory_limit: 256, unsupported: true
  }), 'A'), /未知字段/);
  assert.throws(() => importer.parseMetadata(JSON.stringify({
    title: 'A', time_limit: 1000, memory_limit: 256, tags: ['DP', 'dp']
  }), 'A'), /重复标签/);
});

test('rejects missing or ambiguous testdata pairs', () => {
  assert.throws(() => importer.validateTestdata({ name: 'A', testdataFiles: ['1.in'] }), /必须且只能/);
  assert.throws(() => importer.validateTestdata({ name: 'A', testdataFiles: ['1.in', '1.out', '1.ans'] }), /必须且只能/);
});

test('rejects files outside the allowed archive contract', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'problem-import-test-'));
  try {
    const source = path.join(temporary, 'source');
    await fs.mkdir(source);
    await writeProblem(source, 'A', { title: 'A', time_limit: 1000, memory_limit: 256 }, { extraFile: 'spj_cpp.cpp' });
    const archive = path.join(temporary, 'invalid.zip');
    createZip(source, archive, ['A']);
    await assert.rejects(importer.extractArchive(archive, path.join(temporary, 'staging')), /规范外文件/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('rejects case-insensitive path collisions', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'problem-import-test-'));
  try {
    const source = path.join(temporary, 'source');
    await fs.mkdir(source);
    await writeProblem(source, 'A', { title: 'A', time_limit: 1000, memory_limit: 256 });
    await fs.mkdir(path.join(source, 'a'));
    const archive = path.join(temporary, 'collision.zip');
    createZip(source, archive, ['A', 'a']);
    await assert.rejects(importer.extractArchive(archive, path.join(temporary, 'staging')), /大小写冲突/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('default help contains the complete ZIP contract', async () => {
  const help = await fs.readFile(path.resolve(__dirname, '../content/default-help.md'), 'utf8');
  for (const required of [
    'problem.json', 'description.md', 'input.md', 'output.md', 'testdata',
    'time_limit', 'memory_limit', '路径穿越', '符号链接', '50 MiB', '200 MiB'
  ]) assert.match(help, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
