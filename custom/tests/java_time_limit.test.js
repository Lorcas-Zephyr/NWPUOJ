'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const limits = require('../libs/python-time-limit');
const domain = require('../libs/problem-domain');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('Java has an independent multiplier with a default of two and never matches JavaScript', () => {
  for (const name of ['java', 'java8', 'java11', 'java-17', 'java21', ' JAVA ']) {
    assert.equal(limits.isJavaLanguage(name), true);
    assert.equal(limits.effectiveTimeLimit(1000, name), 2000);
    assert.equal(limits.effectiveTimeLimit(1000, name, 7, 3.5), 3500);
  }
  for (const name of ['javascript', 'nodejs', 'cpp23', 'c', 'csharp', 'kotlin', 'javac', 'vjudge:java']) {
    assert.equal(limits.isJavaLanguage(name), false);
    assert.equal(limits.effectiveTimeLimit(1000, name, 7, 3.5), 1000);
  }
  assert.equal(limits.effectiveTimeLimit(1000, 'python311', 1.5, 7), 1500);
  assert.equal(limits.effectiveTimeLimit(1000, 'pypy3', 4, 7), 4000);
  assert.equal(limits.effectiveTimeLimit(1, 'java', 2, 0.1), 1);
  for (const value of [null, '', 0, -1, NaN, Infinity, 'bad']) {
    assert.equal(limits.effectiveTimeLimit(1000, 'java', 9, value), 2000);
  }
});

test('schema migration supplies Java defaults without rewriting existing Python settings and is idempotent', async () => {
  const columns = new Set(['time_limit', 'python_time_limit_multiplier']);
  const writes = [];
  const db = { query: async sql => {
    if (sql.includes('INFORMATION_SCHEMA.TABLES')) return [{ TABLE_NAME: 'problem' }];
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return [...columns].map(COLUMN_NAME => ({ COLUMN_NAME }));
    writes.push(sql);
    assert.match(sql, /^ALTER TABLE problem ADD COLUMN java_time_limit_multiplier DOUBLE NOT NULL DEFAULT 2/);
    columns.add('java_time_limit_multiplier');
    return {};
  } };
  await domain.ensureLegacyProblemSchema(db);
  await domain.ensureLegacyProblemSchema(db);
  assert.equal(writes.length, 1);
});

test('content, public limits and version hashes include independently validated Java settings', () => {
  for (const value of [undefined, null]) {
    const content = domain.contentFromInput({ title: 'A+B', java_time_limit_multiplier: value });
    assert.equal(content.java_time_limit_multiplier, 2);
    assert.equal(content.python_time_limit_multiplier, 2);
  }
  for (const value of [0, -1, 1001, 'bad', Infinity, '']) {
    assert.ok(domain.validateContent({ title: 'A+B', java_time_limit_multiplier: value }).java_time_limit_multiplier);
  }
  for (const value of [0.1, 1, 2, '2.5', 1000]) {
    assert.deepEqual(domain.validateContent({ title: 'A+B', java_time_limit_multiplier: value }), {});
  }
  const before = domain.contentFromInput({ title: 'A+B', python_time_limit_multiplier: 4 });
  const after = domain.contentFromInput({ java_time_limit_multiplier: 3 }, before);
  assert.equal(after.python_time_limit_multiplier, 4);
  assert.notEqual(domain.contentHash(before), domain.contentHash(after));
  assert.deepEqual(domain.diffContent(before, after).changed_fields, ['java_time_limit_multiplier']);
  assert.equal(domain.serializeProblem(after).limits.java_time_limit_multiplier, 3);
  assert.equal(domain.serializeProblem({}).limits.java_time_limit_multiplier, 2);
});

function workflowHarness() {
  let allowed = true;
  let current = { id: 7, type: 'traditional', time_limit: 1000, memory_limit: 256,
    python_time_limit_multiplier: 4, java_time_limit_multiplier: 2, file_io: false };
  const saved = [], routes = new Map();
  const api = { send: (_res, data) => data, fail: (_res, status, code) => ({ status, code }),
    ifMatch: req => req.body.if_match === 'current-tag' };
  const manager = { query: async () => [{ ...current }] };
  const context = vm.createContext({
    app: { get: (route, handler) => routes.set(route, handler), patch() {}, post() {} },
    api: () => api, can: async () => allowed, path,
    Problem: { findById: async () => ({ ...current }), deleteFromCache: async () => {} },
    TypeORM: { getConnection: () => manager },
    contentTransaction: work => work(manager),
    contentFailure: (_res, error) => ({ status: error.statusCode, code: error.code, fields: error.fields }),
    problemDomain: { updateJudgeConfigurationAggregate: async (_manager, _problem, config) => {
      saved.push(config); current = { ...current, ...config }; return { version_id: '9', snapshot_id: 'ps_9' };
    } },
    contentDomain: { appendEvent: async () => 'event' },
    syzoj: { config: {}, utils: { authorizationV2: { recordAudit: async () => 'audit' } } }
  });
  const source = read('modules/_api_v2_problem_workflows.js');
  vm.runInContext(source.slice(source.indexOf('function judgeConfigResource('), source.indexOf("app.post('/api/v2/problems/:id/testdata/upload'")), context);
  return {
    saved, setAllowed: value => { allowed = value; }, setType: type => { current.type = type; },
    update: (body, user = { id: 5 }) => context.updateJudgeConfigurationV2({ params: { id: '7' }, body: {
      if_match: 'current-tag', type: current.type, time_limit: 1000, memory_limit: 256, ...body
    } }, { locals: { user } }),
    get: () => routes.get('/api/v2/problems/:id/judge-configuration')({ params: { id: '7' } }, { locals: { user: { id: 5 } } })
  };
}

test('judge configuration saves numeric strings, preserves blank/omitted values and keeps external body If-Match', async () => {
  const app = workflowHarness();
  assert.equal((await app.get()).java_time_limit_multiplier, 2);
  const changed = await app.update({ java_time_limit_multiplier: '3.5' });
  assert.equal(changed.java_time_limit_multiplier, 3.5);
  assert.equal(changed.python_time_limit_multiplier, 4);
  assert.equal(changed.snapshot_id, 'ps_9');
  for (const value of [undefined, null, '', '  ']) {
    const preserved = await app.update({ java_time_limit_multiplier: value });
    assert.equal(preserved.java_time_limit_multiplier, 3.5);
  }
  const count = app.saved.length;
  for (const value of ['bad', '0', '-1', '1001', Infinity]) {
    const invalid = await app.update({ java_time_limit_multiplier: value });
    assert.equal(invalid.status, 422);
    assert.ok(invalid.fields.java_time_limit_multiplier);
  }
  assert.equal((await app.update({ if_match: 'stale' })).status, 412);
  assert.equal((await app.update({}, null)).status, 401);
  app.setAllowed(false);
  assert.equal((await app.update({ java_time_limit_multiplier: 5 })).status, 403);
  assert.equal(app.saved.length, count);
});

test('interaction configuration accepts Java factors; submit-answer preserves limits without validating hidden inputs', async () => {
  const app = workflowHarness();
  app.setType('interaction');
  assert.equal((await app.update({ java_time_limit_multiplier: '2.5' })).java_time_limit_multiplier, 2.5);
  app.setType('submit-answer');
  assert.equal((await app.update({ java_time_limit_multiplier: 'bad' })).java_time_limit_multiplier, 2.5);
});

test('standard and interactive judge tasks use the same multiplied limit in payload and signed security policy', async () => {
  const source = read('libs-built/judger.js');
  const queue = [];
  const context = vm.createContext({
    module: { exports: {} }, pythonTimeLimit: limits,
    enums: { ProblemType: { Standard: 1, Interaction: 2 } },
    process: { env: {} }, syzoj: { languages: {} },
    compileCacheKeys: { compilerMetadata: () => ({ languageConfigHash: 'lang-hash', compileCacheKey: 'cache-key' }) },
    taskSignatures: { attach: () => {} }, judgeTaskSigningKey: 'test-only',
    judgeQueue: { push: task => queue.push(task) }, winston: { warn() {} }
  });
  vm.runInContext(source.slice(source.indexOf('module.exports.judge = async function'), source.indexOf('module.exports.getCachedJudgeState =')), context);
  for (const type of ['traditional', 'interaction']) {
    for (const [language, javaMultiplier, expected] of [['java', undefined, 2000], ['java', 3.5, 3500], ['python311', 3.5, 4000], ['pypy3', 3.5, 4000], ['cpp23', 3.5, 1000]]) {
      await context.module.exports.judge({ id: 99, task_id: 'test-task', language, code: 'test' }, {
        id: 7, type, time_limit: 1000, memory_limit: 256, python_time_limit_multiplier: 4,
        java_time_limit_multiplier: javaMultiplier
      }, 2, { snapshotId: 'ps_9' });
      const { content } = queue.pop();
      assert.equal(content.param.timeLimit, expected);
      assert.equal(content.securityPolicy.timeLimit, expected);
      assert.equal(content.securityPolicy.problemSnapshotId, 'ps_9');
    }
  }
});

test('immutable dispatch keeps the selected snapshot factor and defaults legacy snapshots to two', async () => {
  const source = read('modules/_api_v2_submission_domain.js');
  let content = { type: 'traditional', time_limit: 1000 };
  const context = vm.createContext({
    TypeORM: { getConnection: () => ({ query: async () => [{ problem_id: 7, content_json: JSON.stringify(content), testdata_hash: 'data-hash', testdata_path: 'snapshots/data', content_hash: 'hash' }] }) },
    missingProblemSnapshot: () => new Error('missing'), syzoj: { utils: {} }
  });
  vm.runInContext(source.slice(source.indexOf('async function immutableExecutionProblem('), source.indexOf('async function registeredForContest(')), context);
  const liveProblem = { id: 7, java_time_limit_multiplier: 8 };
  assert.equal((await context.immutableExecutionProblem(liveProblem, 'old')).java_time_limit_multiplier, 2);
  content.java_time_limit_multiplier = 3;
  assert.equal((await context.immutableExecutionProblem(liveProblem, 'new')).java_time_limit_multiplier, 3);
  assert.equal((await context.immutableExecutionProblem(liveProblem, null)).java_time_limit_multiplier, 8);
});

test('management form and bulk ZIP example include Java settings with label/control alignment and separate hint row', () => {
  const form = read('views/problem_manage.ejs');
  assert.match(form, /name="java_time_limit_multiplier"/);
  assert.match(form, /java_time_limit_multiplier: form\.elements\.java_time_limit_multiplier\.value/);
  assert.match(form, /aria-describedby="java-time-limit-hint"/);
  assert.match(read('modules/_api_v2_problem_domain.js'), /BULK_PROBLEM_TEMPLATE[\s\S]*java_time_limit_multiplier: 2/);
  const css = read('app-features.css');
  assert.match(css, /\.app-limit-field\s*\{[^}]*align-items: center/s);
  for (const child of ['app-label', 'app-input']) assert.match(css, new RegExp(`\\.app-limit-field > \\.${child}\\s*\\{[^}]*grid-row: 1`, 's'));
  assert.match(css, /\.app-limit-field > \.app-help\s*\{[^}]*grid-row: 2/s);
});
