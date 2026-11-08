'use strict';

// Exercise the actual ZIP extraction/import functions with isolated filesystem
// and database fixtures. No production questions, files or data are created.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const domain = require('../libs/problem-domain');
const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_problem_domain.js'), 'utf8');
const code = source.slice(source.indexOf('const BULK_PROBLEM_TEMPLATE ='), source.indexOf("app.get('/problems/import/template'"));

function fixture(names, metadata = {}, failingTitle, validTagIds = [7, 8], validTags = [{ id: 7, name: '动态规划' }, { id: 8, name: '图论' }]) {
  const files = new Map(), created = [], tagMappings = [], cleaned = [];
  for (const name of names) {
    files.set(`/fixture/extracted/${name}/statement.md`, `# ${name}\n题面内容`);
    if (metadata[name]) files.set(`/fixture/extracted/${name}/problem.json`, JSON.stringify(metadata[name]));
  }
  const api = { send: (_res, data) => ({ status: 200, data }), fail: (_res, status, code, message) => ({ status, code, message }) };
  const context = vm.createContext({
    fs: {
      mkdtemp: async () => '/fixture', ensureDir: async () => {}, writeFile: async () => {},
      readdir: async () => names.map(name => ({ name, isDirectory: () => true })),
      pathExists: async filename => files.has(filename), pathExistsSync: filename => files.has(filename),
      readFile: async filename => files.get(filename), remove: async filename => cleaned.push(filename)
    },
    path, os: { tmpdir: () => '/tmp' }, execFile: async () => {}, ZIP_UTF8_ENV: {},
    syzoj: { model: () => ({}), utils: { apiV2: api, vjudgeV2: { ensureSchema: async () => {} } } },
    ensureProblemSchema: async () => {},
    TypeORM: { getConnection: () => ({ transaction: async callback => callback({
      query: async (sql, args = []) => {
        if (sql.startsWith('SELECT id,name FROM problem_tag WHERE name IN')) {
          return args.flatMap(name => validTags.filter(tag => tag.name === name).map(tag => ({ id: tag.id, name: tag.name })));
        }
        if (sql.startsWith('SELECT id FROM problem_tag WHERE id IN')) {
          return args.filter(id => validTagIds.includes(Number(id))).map(id => ({ id: Number(id) }));
        }
        if (sql.startsWith('INSERT INTO problem_tag_map')) {
          tagMappings.push([Number(args[0]), Number(args[1])]);
          return {};
        }
        throw Error('Unexpected database query: ' + sql);
      }
    }) }) },
    contentFromInput: domain.contentFromInput, validateContent: domain.validateContent,
    createProblemAggregate: async (_manager, _Problem, content, actorId, options) => {
      if (content.title === failingTitle) throw Error('模拟单题导入失败');
      const problem = { id: options.id || 100 + created.length, title: content.title };
      created.push({ problem, actorId });
      return { problem };
    },
    syncSourceProjection: async () => {}
  });
  vm.runInContext(`${code}\nthis.bulkTemplate = BULK_PROBLEM_TEMPLATE;`, context);
  return {
    created, tagMappings, cleaned, bulkTemplate: context.bulkTemplate,
    extract: () => context.extractBulkImportArchive({ buffer: Buffer.from('isolated ZIP fixture') }),
    import: retry => context.importBulkProblems({ file: { buffer: Buffer.from('isolated ZIP fixture') },
      body: retry ? { retry_folders: JSON.stringify(retry) } : {} }, { locals: { user: { id: 7 } } })
  };
}

test('bulk import sorts numeric folder prefixes naturally regardless of extraction order', async () => {
  for (const names of [['10_十', '2_二', '1_一'], ['2_二', '1_一', '10_十'], ['1_一', '10_十', '2_二']]) {
    const f = fixture(names);
    const extracted = await f.extract();
    assert.deepEqual(Array.from(extracted.items, item => item.name), ['1_一', '2_二', '10_十']);
    const result = await f.import();
    assert.equal(result.status, 200);
    assert.deepEqual(Array.from(result.data.created_folders), ['1_一', '2_二', '10_十']);
    assert.deepEqual(f.created.map(item => item.problem.title), ['1_一', '2_二', '10_十']);
    assert.deepEqual(f.created.map(item => item.actorId), [7, 7, 7]);
    assert.deepEqual(f.cleaned, ['/fixture']);
  }
});

test('explicit titles and problem IDs do not change folder-driven creation order', async () => {
  const f = fixture(['03_末题', '01_首题', '02_中题'], {
    '01_首题': { title: 'Z 标题', id: 503 }, '02_中题': { title: 'A 标题', id: 501 }, '03_末题': { title: 'M 标题', id: 502 }
  });
  const result = await f.import();
  assert.equal(result.status, 200);
  assert.deepEqual(Array.from(result.data.problem_ids), [503, 501, 502]);
  assert.deepEqual(f.created.map(item => item.problem.title), ['Z 标题', 'A 标题', 'M 标题']);
});

test('ties from zero-padded names remain deterministic and ordinary names still sort', async () => {
  const names = ['题目10', 'A', '02', '题目2', '2', 'B'];
  const first = await fixture(names).extract();
  const second = await fixture(names.slice().reverse()).extract();
  const ordered = Array.from(first.items, item => item.name);
  assert.deepEqual(Array.from(second.items, item => item.name), ordered);
  assert.ok(ordered.indexOf('02') < ordered.indexOf('2'));
  assert.ok(ordered.indexOf('题目2') < ordered.indexOf('题目10'));
  assert.ok(ordered.indexOf('A') < ordered.indexOf('B'));
});

test('partial failures and retries preserve relative order and only retry selected folders', async () => {
  const names = ['03_C', '01_A', '02_B'];
  const first = fixture(names, {}, '02_B');
  const result = await first.import();
  assert.deepEqual(Array.from(result.data.created_folders), ['01_A', '03_C']);
  assert.deepEqual(Array.from(result.data.failures, failure => failure.folder), ['02_B']);
  const retried = await fixture(names).import(['03_C', '02_B']);
  assert.deepEqual(Array.from(retried.data.created_folders), ['02_B', '03_C']);
  assert.equal(retried.data.created, 2);
});

test('bulk import applies only valid exact tag names and skips invalid names without failing the problem', async () => {
  const f = fixture(['05_boolean', '04_string', '03_missing', '02_duplicate', '01_tagged'], {
    '01_tagged': { tag_names: ['图论', '动态规划'] },
    '02_duplicate': { tag_names: ['图论', '图论'] },
    '03_missing': { tag_names: ['不存在的标签', '图论 '] },
    '04_string': { tag_names: [7] },
    '05_boolean': { tag_names: ['   '] }
  });
  const result = await f.import();
  assert.equal(result.status, 200);
  assert.deepEqual(Array.from(result.data.created_folders), ['01_tagged', '02_duplicate', '03_missing', '04_string', '05_boolean']);
  assert.deepEqual(Array.from(result.data.failures), []);
  assert.deepEqual(f.tagMappings, [[100, 8], [100, 7], [101, 8]]);
  assert.deepEqual(f.created.map(item => item.problem.title), ['01_tagged', '02_duplicate', '03_missing', '04_string', '05_boolean']);
});

test('bulk import keeps compatibility with older tag ID archives', async () => {
  const f = fixture(['01_tagged', '02_bad_tag'], { '01_tagged': { tag_ids: [8, 7] }, '02_bad_tag': { tag_ids: [99, '7'] } });
  const result = await f.import();
  assert.equal(result.status, 200);
  assert.deepEqual(f.tagMappings, [[100, 8], [100, 7]]);
  assert.deepEqual(Array.from(result.data.created_folders), ['01_tagged', '02_bad_tag']);
});

test('downloadable ZIP template uses the tag name field', () => {
  const f = fixture([]);
  const sample = f.bulkTemplate.problems[0];
  assert.deepEqual(Array.from(sample.tag_names), []);
  assert.equal(Object.prototype.hasOwnProperty.call(sample, 'tag_ids'), false);
  assert.match(source, /writeJson\(path\.join\(sample, 'problem\.json'\), BULK_PROBLEM_TEMPLATE\.problems\[0\]/);
});

test('import instructions document ordering, folder data and tag names', () => {
  const view = fs.readFileSync(path.join(__dirname, '../views/problem_bulk_import.ejs'), 'utf8');
  const help = fs.readFileSync(path.join(__dirname, '../content/default-help.md'), 'utf8');
  assert.match(view, /data-bulk-import-order-help/);
  assert.match(view, /01_A加B/);
  assert.match(view, /无需填写 order 字段/);
  assert.match(view, /不保证题号连续/);
  assert.match(view, /tag_names.*最多关联/);
  assert.match(view, /标签名称/);
  assert.match(view, /标签会跳过/);
  assert.match(view, /普通传统题可以不写 data.yml/);
  assert.match(help, /## 批量上传题目/);
  assert.match(help, /tag_names.*动态规划/);
  assert.match(help, /标签会跳过，不影响题目导入/);
});
