'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const problemDomain = require('../libs/problem-domain');
const { resourceOwnerAllows, scopeMatches } = require('../libs/authorization-v2');

function content(overrides = {}) {
  return problemDomain.contentFromInput(overrides, {
    title: 'A+B Problem',
    description: 'Add two integers.',
    input_format: 'Two integers.',
    output_format: 'Their sum.',
    example: '1 2\n\n3',
    limit_and_hint: 'Use 64-bit integers.',
    time_limit: 1000,
    memory_limit: 256,
    file_io: false,
    file_io_input_name: null,
    file_io_output_name: null,
    type: 'traditional'
  });
}

function versionManager(options = {}) {
  const calls = [];
  const manager = {
    calls,
    async save(problem) {
      calls.push({ type: 'save', problem: { ...problem } });
      problem.id = options.problemId || 41;
      return problem;
    },
    async query(sql, params) {
      calls.push({ type: 'query', sql, params });
      if (sql.startsWith('SELECT * FROM problem_v2_state')) return options.states || [];
      if (sql.startsWith('SELECT COALESCE')) return [{ next_version: options.nextVersion || 1 }];
      if (sql.startsWith('INSERT INTO problem_v2_version')) {
        if (options.failVersionInsert) throw new Error('version insert failed');
        return { insertId: options.versionId || 501 };
      }
      return {};
    }
  };
  return manager;
}

test('problem content is canonical, validated, and rendered as one Markdown document', () => {
  const first = content();
  const reversed = {};
  Object.keys(first).reverse().forEach(key => { reversed[key] = first[key]; });
  assert.equal(problemDomain.serializeContent(reversed), problemDomain.serializeContent(first));
  assert.equal(problemDomain.contentHash(reversed), problemDomain.contentHash(first));
  assert.deepEqual(problemDomain.validateContent(first), {});
  assert.deepEqual(problemDomain.validateContent(content({ title: '', time_limit: 0, type: 'unknown' })), {
    title: 'required',
    time_limit: 'positive integer required',
    type: 'unsupported problem type'
  });
  assert.equal(content({ vjudge_config: '1000' }).vjudge_config, '1000');
  assert.notEqual(problemDomain.contentHash(content({ vjudge_config: '1000' })), problemDomain.contentHash(content({ vjudge_config: '1001' })));
  assert.deepEqual(problemDomain.validateContent(content({ vjudge_config: 'x'.repeat(81) })), { vjudge_config: 'maximum length is 80' });
  assert.deepEqual(problemDomain.validateContent(content({ type: 'vjudge:poj', vjudge_config: null })), { vjudge_config: 'remote identifier required without surrounding whitespace' });
  assert.deepEqual(problemDomain.validateContent(content({ type: 'vjudge:poj', vjudge_config: ' 1000 ' })), { vjudge_config: 'remote identifier required without surrounding whitespace' });
  assert.equal(problemDomain.statementMarkdown(first), [
    '## 题目描述\n\nAdd two integers.',
    '## 输入格式\n\nTwo integers.',
    '## 输出格式\n\nTheir sum.',
    '## 样例\n\n1 2\n\n3',
    '## 数据范围与提示\n\nUse 64-bit integers.'
  ].join('\n\n'));
});

test('a canonical single-field statement is returned without a generated section wrapper', () => {
  const markdown = '# 完整题面\n\n包含输入、输出、样例和提示。';
  assert.equal(problemDomain.statementMarkdown(content({
    description: markdown,
    input_format: '',
    output_format: '',
    example: '',
    limit_and_hint: ''
  })), markdown);
});

test('problem version diffs only include changed canonical fields', () => {
  const before = content({ title: 'Before', memory_limit: 256 });
  const after = content({ title: 'After', memory_limit: 512 });
  const diff = problemDomain.diffContent(before, after);
  assert.deepEqual(diff.changed_fields, ['title', 'memory_limit']);
  assert.deepEqual(diff.fields.title, { before: 'Before', after: 'After' });
  assert.deepEqual(diff.fields.memory_limit, { before: 256, after: 512 });
  assert.equal(Object.prototype.hasOwnProperty.call(diff.fields, 'description'), false);
});

test('problem version review transitions are explicit', () => {
  assert.equal(problemDomain.reviewRequestAllowed('draft'), true);
  assert.equal(problemDomain.reviewRequestAllowed('rejected'), true);
  assert.equal(problemDomain.reviewRequestAllowed('in_review'), false);
  assert.equal(problemDomain.reviewDecisionAllowed('in_review'), true);
  assert.equal(problemDomain.reviewDecisionAllowed('approved'), false);
  assert.equal(problemDomain.reviewDecisionAllowed('published'), false);
});

test('problem API model exposes immutable version and snapshot identifiers', () => {
  const value = problemDomain.serializeProblem({
    id: 7,
    title: 'Projection',
    user_id: 3,
    publicizer_id: 9,
    is_public: true,
    type: 'traditional',
    time_limit: 1000,
    memory_limit: 512,
    description: 'Body',
    input_format: null,
    output_format: null,
    example: null,
    limit_and_hint: null,
    ac_num: 2,
    submit_num: 5,
    publicize_time: '2026-07-30T00:00:00.000Z'
  }, {
    lifecycle_status: 'published',
    current_version_id: 88,
    current_snapshot_id: 'ps_fixed'
  }, date => date);
  assert.equal(value.current_version_id, '88');
  assert.equal(value.current_snapshot_id, 'ps_fixed');
  assert.equal(value.visibility, 'public');
  assert.deepEqual(value.source, { kind: 'local', provider: null, remote_id: null });
  assert.deepEqual(value.statistics, { accepted: 2, submissions: 5 });
  assert.equal('content_hash' in value, false);
  assert.deepEqual(problemDomain.sourceMetadata({ type: 'vjudge:poj', vjudge_config: '1000' }), {
    kind: 'vjudge', provider: 'poj', remote_id: '1000'
  });
  assert.deepEqual(problemDomain.sourceMetadata({ type: 'vjudge:luogu', vjudge_config: 'P1000' }), {
    kind: 'vjudge', provider: 'luogu', remote_id: 'P1000'
  });
});

test('creating a problem persists the legacy row and initial version through one manager', async () => {
  const manager = versionManager();
  const Problem = { create: initial => ({ ...initial }) };
  const created = await problemDomain.createProblemAggregate(manager, Problem, content(), 12);
  assert.equal(created.problem.id, 41);
  assert.equal(created.problem.user_id, 12);
  assert.equal(created.version.id, '501');
  assert.deepEqual(manager.calls.map(call => call.type), ['save', 'query', 'query', 'query']);
  assert.match(manager.calls[2].sql, /INSERT INTO problem_v2_version/);
  assert.match(manager.calls[3].sql, /INSERT INTO problem_v2_state/);
});

test('a failed initial version insert rolls the whole aggregate back at the route transaction boundary', async () => {
  const persisted = [];
  const manager = versionManager({ failVersionInsert: true });
  manager.save = async problem => {
    problem.id = 41;
    persisted.push(problem);
  };
  const transaction = async work => {
    const checkpoint = persisted.slice();
    try {
      return await work(manager);
    } catch (error) {
      persisted.splice(0, persisted.length, ...checkpoint);
      throw error;
    }
  };
  await assert.rejects(
    transaction(current => problemDomain.createProblemAggregate(current, { create: value => ({ ...value }) }, content(), 12)),
    /version insert failed/
  );
  assert.deepEqual(persisted, []);
});

test('editing a published problem creates a draft without mutating the public legacy projection', async () => {
  const manager = versionManager({ states: [{ lifecycle_status: 'published', current_version_id: 77 }], nextVersion: 4 });
  const mutation = await problemDomain.updateProblemAggregate(
    manager,
    { id: 7, user_id: 2, is_public: true },
    content({ title: 'Draft title' }),
    2
  );
  assert.equal(mutation.legacy_projection_updated, false);
  assert.equal(mutation.version.version_number, 4);
  assert.equal(manager.calls.some(call => call.sql && call.sql.startsWith('UPDATE problem SET')), false);
  const insert = manager.calls.find(call => call.sql && call.sql.startsWith('INSERT INTO problem_v2_version'));
  assert.equal(insert.params[2], 77);
});

test('a pending draft never makes a still-public problem write through to the legacy projection', async () => {
  const manager = versionManager({ states: [{ lifecycle_status: 'draft', current_version_id: 78 }], nextVersion: 5 });
  const mutation = await problemDomain.updateProblemAggregate(
    manager,
    { id: 7, user_id: 2, is_public: true },
    content({ title: 'Another draft title' }),
    2
  );
  assert.equal(mutation.legacy_projection_updated, false);
  assert.equal(manager.calls.some(call => call.sql && call.sql.startsWith('UPDATE problem SET')), false);
});

test('publishing writes one immutable snapshot and updates the compatibility projection atomically', async () => {
  const calls = [];
  const stored = content({ title: 'Published title', memory_limit: 512 });
  const manager = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT * FROM problem_v2_version')) {
        return [{ id: 91, content_json: problemDomain.serializeContent(stored), content_hash: problemDomain.contentHash(stored) }];
      }
      return {};
    }
  };
  const published = await problemDomain.publishProblemAggregate(
    manager,
    { id: 7 },
    91,
    5,
    () => 'ps_deterministic'
  );
  assert.equal(published.snapshot_id, 'ps_deterministic');
  const snapshot = calls.find(call => call.sql.startsWith('INSERT INTO problem_v2_snapshot'));
  assert.equal(snapshot.params[0], 'ps_deterministic');
  assert.equal(snapshot.params[4], problemDomain.serializeContent(stored));
  assert.equal(snapshot.params[5], null);
  assert.equal(snapshot.params[6], null);
  assert.equal(snapshot.params[7], null);
  const versionUpdate = calls.find(call => call.sql.startsWith('UPDATE problem_v2_version'));
  assert.match(versionUpdate.sql, /reviewed_by=COALESCE/);
  assert.deepEqual(versionUpdate.params, [5, 91]);
  const projection = calls.find(call => call.sql.startsWith('UPDATE problem SET'));
  assert.equal(projection.params[0], 'Published title');
  assert.equal(projection.params.at(-2), 5);
  assert.equal(projection.params.at(-1), 7);
});

test('publishing includes the immutable testdata hash and worker-relative path in its snapshot', async () => {
  const stored = content();
  const calls = [];
  const manager = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT * FROM problem_v2_version')) {
        return [{ id: 92, content_json: problemDomain.serializeContent(stored), content_hash: problemDomain.contentHash(stored) }];
      }
      return {};
    }
  };
  await problemDomain.publishProblemAggregate(manager, { id: 8 }, 92, 5, () => 'ps_testdata_0001', {
    hash: 'a'.repeat(64), path: 'snapshots/ps_testdata_0001'
  });
  const snapshot = calls.find(call => call.sql.startsWith('INSERT INTO problem_v2_snapshot'));
  assert.equal(snapshot.params[6], 'a'.repeat(64));
  assert.equal(snapshot.params[7], 'snapshots/ps_testdata_0001');
});

test('refreshing published testdata advances the snapshot without exposing a newer statement draft', async () => {
  const calls = [];
  const manager = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT * FROM problem_v2_state')) {
        return [{ current_version_id: 99, current_snapshot_id: 'ps_published_old' }];
      }
      if (sql.startsWith('SELECT * FROM problem_v2_snapshot')) {
        return [{
          id: 'ps_published_old',
          version_id: 91,
          content_hash: 'published-content',
          content_json: '{"title":"Published"}',
          provider_config: null,
          testdata_hash: 'old-testdata'
        }];
      }
      if (sql.startsWith('SELECT id FROM problem_v2_snapshot')) return [];
      return {};
    }
  };

  const refreshed = await problemDomain.refreshTestdataSnapshotAggregate(
    manager,
    { id: 7, is_public: true },
    5,
    'ps_testdata_new',
    { hash: 'new-testdata', path: 'snapshots/ps_testdata_new' }
  );

  assert.deepEqual(refreshed, { snapshot_id: 'ps_testdata_new', created: true, changed: true });
  assert.equal(calls.some(call => call.sql.startsWith('SELECT * FROM problem_v2_version')), false);
  const insert = calls.find(call => call.sql.startsWith('INSERT INTO problem_v2_snapshot'));
  assert.equal(insert.params[2], 91);
  assert.equal(insert.params[3], 'published-content');
  assert.equal(insert.params[6], 'new-testdata');
  assert.equal(insert.params[7], 'snapshots/ps_testdata_new');
  const stateUpdate = calls.find(call => call.sql.startsWith('UPDATE problem_v2_state SET current_snapshot_id'));
  assert.deepEqual(stateUpdate.params, ['ps_testdata_new', 7]);
});

test('refreshing unchanged testdata keeps the existing snapshot pointer', async () => {
  const calls = [];
  const manager = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT * FROM problem_v2_state')) {
        return [{ current_version_id: 91, current_snapshot_id: 'ps_current' }];
      }
      if (sql.startsWith('SELECT * FROM problem_v2_snapshot')) {
        return [{ id: 'ps_current', version_id: 91, content_hash: 'content', testdata_hash: 'same-data' }];
      }
      return {};
    }
  };

  const refreshed = await problemDomain.refreshTestdataSnapshotAggregate(
    manager,
    { id: 7, is_public: true },
    5,
    'ps_unused',
    { hash: 'same-data', path: 'snapshots/ps_unused' }
  );

  assert.deepEqual(refreshed, { snapshot_id: 'ps_current', created: false, changed: false });
  assert.equal(calls.some(call => call.sql.startsWith('INSERT INTO problem_v2_snapshot')), false);
  assert.equal(calls.some(call => call.sql.startsWith('UPDATE problem_v2_state SET current_snapshot_id')), false);
});

test('unpublishing returns the mutable projection to draft without discarding version or snapshot pointers', async () => {
  const calls = [];
  const manager = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {};
    }
  };
  await problemDomain.unpublishProblemAggregate(manager, 7);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /lifecycle_status='draft'/);
  const duplicateUpdate = calls[0].sql.split('ON DUPLICATE KEY UPDATE')[1];
  assert.doesNotMatch(duplicateUpdate, /current_version_id|current_snapshot_id/);
  assert.deepEqual(calls[0].params, [7]);
  assert.match(calls[1].sql, /UPDATE problem SET is_public=0/);
  assert.deepEqual(calls[1].params, [7]);
});

test('publishing reuses an existing snapshot with the same content hash', async () => {
  const stored = content();
  const manager = {
    async query(sql) {
      if (sql.startsWith('SELECT * FROM problem_v2_version')) {
        return [{ id: 91, content_json: problemDomain.serializeContent(stored), content_hash: problemDomain.contentHash(stored) }];
      }
      if (sql.startsWith('INSERT INTO problem_v2_snapshot')) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
      if (sql.startsWith('SELECT id FROM problem_v2_snapshot')) return [{ id: 'ps_existing' }];
      return {};
    }
  };
  const published = await problemDomain.publishProblemAggregate(manager, { id: 7 }, 91, 5, () => 'ps_new');
  assert.equal(published.snapshot_id, 'ps_existing');
});

test('problem ownership and grants remain scoped to the intended resource', () => {
  const owner = { id: 20 };
  const ownProblem = problemDomain.problemResource({ id: 3, user_id: 20 });
  assert.equal(resourceOwnerAllows(owner, 'problem:read', ownProblem), true);
  assert.equal(resourceOwnerAllows(owner, 'problem:edit', ownProblem), true);
  assert.equal(resourceOwnerAllows(owner, 'problem:publish', ownProblem), false);
  assert.equal(resourceOwnerAllows({ id: 21 }, 'problem:edit', ownProblem), false);
  assert.equal(scopeMatches('problem', '3', 'problem:3'), true);
  assert.equal(scopeMatches('problem', '3', 'problem:4'), false);
  assert.equal(scopeMatches('global', null, 'problem:4'), true);
});

test('problem source projection binds, rejects conflicts, and removes stale remote mappings', async () => {
  const inserted = [];
  const manager = {
    rows: [],
    async query(sql, params) {
      if (sql.startsWith('SELECT provider')) return this.rows;
      inserted.push({ sql, params });
      return {};
    }
  };
  const bound = await problemDomain.syncSourceProjection(manager, { id: 7, type: 'vjudge:poj', vjudge_config: '1000' });
  assert.deepEqual(bound.source, { kind: 'vjudge', provider: 'poj', remote_id: '1000' });
  assert.match(inserted[0].sql, /INSERT INTO vjudge_v2_remote_problem/);
  manager.rows = [{ provider: 'poj', remote_id: '1000', local_problem_id: 8 }];
  await assert.rejects(problemDomain.syncSourceProjection(manager, { id: 7, type: 'vjudge:poj', vjudge_config: '1000' }), error => error.code === 'VJUDGE_SOURCE_CONFLICT' && error.statusCode === 409);
  manager.rows = [{ provider: 'poj', remote_id: '1000', local_problem_id: 7 }];
  inserted.length = 0;
  const removed = await problemDomain.syncSourceProjection(manager, { id: 7, type: 'traditional', vjudge_config: null });
  assert.equal(removed.changed, true);
  assert.match(inserted[0].sql, /DELETE FROM vjudge_v2_remote_problem/);
});

test('problem API routes use scoped capabilities and transaction-backed aggregate mutations', () => {
  const domainSource = fs.readFileSync(path.resolve(__dirname, '../modules/_api_v2_problem_domain.js'), 'utf8');
  const workflowSource = fs.readFileSync(path.resolve(__dirname, '../modules/_api_v2_problem_workflows.js'), 'utf8');
  for (const route of [
    '/api/v2/problems',
    '/api/v2/problems/:id',
    '/api/v2/problems/:id/versions',
    '/api/v2/problems/:id/versions/:versionId',
    '/api/v2/problems/:id/versions/:versionId/review-request',
    '/api/v2/problems/:id/versions/:versionId/review',
    '/api/v2/problems/:id/publish',
    '/api/v2/problems/:id/unpublish',
    '/api/v2/problems/:id/archive'
  ]) assert.equal(domainSource.includes(route), true, `missing route ${route}`);
  assert.equal(workflowSource.includes('/api/v2/problems/:id/testdata/validate'), true);
  assert.equal(workflowSource.includes('/api/v2/problems/:id/testdata/upload'), true);
  assert.equal(workflowSource.includes('/api/v2/problems/:id/testdata/files/:filename'), true);
  assert.equal(workflowSource.includes('/api/v2/problems/bulk-actions'), true);
  assert.equal(workflowSource.includes("kind: 'problem_bulk_action'"), true);
  for (const route of ['/api/v2/tags/:id', '/api/v2/tags/:id']) assert.equal(workflowSource.includes(route), true, `missing route ${route}`);
  assert.match(domainSource, /requireCapability\('problem:create'\)/);
  assert.match(domainSource, /requireCapability\('problem:edit'/);
  assert.match(domainSource, /requireCapability\('problem:publish'/);
  assert.match(domainSource, /requireCapability\('problem:archive'/);
  assert.match(workflowSource, /can\(user, 'problem:testdata\.write', problem\)/);
  assert.match(workflowSource, /testdataUpload\.extractTestdataArchive/);
  assert.match(workflowSource, /testdataUpload\.replaceDirectory/);
  assert.match(workflowSource, /bulkAction\.normalize/);
  assert.match(workflowSource, /runBulkArchiveJob/);
  assert.match(workflowSource, /recentLoginSatisfied\(req\)/);
  assert.match(workflowSource, /TAG_IN_USE/);
  assert.match(workflowSource, /TAG_NAME_CONFLICT/);
  assert.match(domainSource, /transaction\(async manager =>[\s\S]*createProblemAggregate/);
  assert.match(domainSource, /transaction\(async manager =>[\s\S]*updateProblemAggregate/);
  assert.match(domainSource, /transaction\(async manager =>[\s\S]*publishProblemAggregate/);
  assert.match(domainSource, /syncSourceProjection/);
  assert.match(domainSource, /transaction\(manager => archiveProblemAggregate/);
  assert.match(domainSource, /canReadDraftVersions/);
  assert.match(domainSource, /problem_version\.status='published'/);
  assert.match(domainSource, /ensureCurrentSnapshot\(problem, problem\.publicizer_id \|\| problem\.user_id \|\| null\)/);
  assert.match(domainSource, /Imported from legacy published problem/);
  assert.match(domainSource, /testdata_hash CHAR\(64\) NULL/);
  assert.match(domainSource, /captureTestdataSnapshot/);
  assert.match(domainSource, /testdataSnapshots\.capture/);
  assert.match(domainSource, /loadVersionRow\(manager, problem\.id, req\.params\.versionId, true\)/);
  assert.match(domainSource, /problem:version\.review/);
  assert.match(domainSource, /review_feedback/);
  assert.match(domainSource, /diffContent/);
});
