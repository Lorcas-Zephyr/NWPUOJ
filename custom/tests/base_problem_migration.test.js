'use strict';
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const domain = require('../libs/problem-domain');
const snapshots = require('../libs/testdata-snapshot');

async function fixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwpuoj-base-migration-'));
  const data = snapshots.currentTestdataPath(root, 11);
  await fs.ensureDir(data); await fs.writeFile(path.join(data, '1.in'), '1 2\n'); await fs.writeFile(path.join(data, '1.out'), '3\n');
  await fs.writeFile(path.join(data, 'data.yml'), 'specialJudge:\n  fileName: checker.cpp\n');
  await fs.writeFile(path.join(data, 'checker.cpp'), '// checker');
  const sourceContent = domain.contentFromInput({ title: 'Latest title', description: '最新题面', type: 'traditional', time_limit: 1500, memory_limit: 512, python_time_limit_multiplier: 3, java_time_limit_multiplier: 4, file_io: false });
  const originalSnapshot = await snapshots.capture(root, 11, 'ps_original_fixture');
  // Prove copies use the committed immutable snapshot, not a live data folder
  // being switched by another upload worker.
  await fs.writeFile(path.join(data, '1.out'), 'upload in progress');
  const source = { ...sourceContent, id: 11, user_id: 7, is_public: options.public !== false, is_anonymous: true, additional_file_id: 5, ac_num: 50, submit_num: 70 };
  const state = { problem_id: 11, current_version_id: 30, current_snapshot_id: originalSnapshot.id, lifecycle_status: 'published' };
  const attachment = path.join(root, 'attachment.zip'); await fs.writeFile(attachment, 'attachment fixture');
  const storage = { targets: new Map(), versions: new Map(), mapping: null, audits: [], queries: [], nextId: 100 };
  let failAudit = !!options.failAudit, missingOwner = false, existingDirectory = false, transactionTail = Promise.resolve();
  const manager = { async save(problem) {
    problem.id = storage.nextId++; storage.targets.set(problem.id, { ...problem });
    if (existingDirectory) { await fs.ensureDir(snapshots.currentTestdataPath(root, problem.id)); await fs.writeFile(path.join(snapshots.currentTestdataPath(root, problem.id), 'unrelated'), 'must preserve'); }
    return problem;
  }, async query(sql, args = []) {
    storage.queries.push([sql, args]);
    if (sql.startsWith('SELECT problem_id FROM base_workspace_problem')) return args[0] === 11 ? [{ problem_id: 11 }] : [];
    if (sql.startsWith('SELECT * FROM problem_v2_state')) return args[0] === 11 ? [state] : [];
    if (sql.startsWith('SELECT * FROM problem WHERE')) return [source];
    if (sql.startsWith('SELECT id FROM user')) return missingOwner ? [] : [{ id: 7 }];
    if (sql.startsWith('SELECT content_json')) return [{ content_json: JSON.stringify(sourceContent) }];
    if (sql.startsWith('SELECT testdata_path')) return [{ testdata_path: originalSnapshot.path, testdata_hash: originalSnapshot.hash }];
    if (sql.startsWith('SELECT COALESCE')) return [{ next_version: 1 }];
    if (sql.startsWith('INSERT INTO problem_v2_version')) { const id = 1000 + args[0]; storage.versions.set(id, { id, problem_id: args[0], content_json: args[4], content_hash: args[5] }); return { insertId: id }; }
    if (sql.startsWith('SELECT * FROM problem_v2_version')) return [storage.versions.get(Number(args[0]))];
    if (sql.startsWith('SELECT provider,remote_id')) return [];
    if (sql.startsWith('UPDATE problem SET additional_file_id')) { storage.targets.get(args[1]).additional_file_id = args[0]; return {}; }
    if (sql.startsWith('UPDATE problem SET')) { const target = storage.targets.get(args[args.length - 1]); domain.EDITABLE_FIELDS.forEach((field, index) => { target[field] = args[index]; }); target.is_public = true; target.publicizer_id = args[args.length - 2]; return {}; }
    if (sql.startsWith('INSERT INTO base_workspace_problem_migration')) { storage.mapping = { source_problem_id: args[0], problem_id: args[1], version_id: args[2], migrated_by: args[3] }; return {}; }
    if (/^(INSERT INTO problem_v2_state|UPDATE problem_v2_state|INSERT INTO problem_v2_snapshot|UPDATE problem_v2_version|INSERT INTO problem_tag_map|INSERT INTO api_v2_event)/.test(sql)) return {};
    throw Error(sql);
  } };
  const db = { async transaction(fn) {
    const predecessor = transactionTail; let release;
    transactionTail = new Promise(resolve => { release = resolve; }); await predecessor;
    const before = { targets: new Map(storage.targets), versions: new Map(storage.versions), mapping: storage.mapping, audits: storage.audits.slice() };
    try { return await fn(manager); } catch (error) { Object.assign(storage, before); throw error; } finally { release(); }
  } };
  const base = { isAdmin: actor => !!actor && actor.id === 1, ensureSchema: async () => {}, migrationStates: async () => {
    const value = storage.mapping, target = value && storage.targets.get(value.problem_id);
    return value && target && !target.archived ? new Map([[11, value]]) : new Map();
  } };
  const context = { module: { exports: {} }, syzoj: { config: { upload_dir: root }, model: name => name === 'problem' ? { create: value => ({ ...value }) } : { findById: async () => ({ getPath: () => attachment }) }, utils: {
    problemV2: { ensureSchema: async () => {} }, vjudgeV2: { ensureSchema: async () => {} }, apiV2: { ensureFoundationSchema: async () => {} }, authorizationV2: { ensureSchema: async () => {}, recordAudit: async (_req, event, db) => { assert.equal(db, manager); if (failAudit) throw Error('audit failed'); storage.audits.push(event); } }
  } }, require(name) {
    if (name === 'typeorm') return { getConnection: () => db };
    if (name === './base-workspace') return base;
    if (name === './problem-domain') return domain;
    if (name === './testdata-snapshot') return snapshots;
    if (name === './testdata-upload') return require('../libs/testdata-upload');
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../libs/base-problem-migration.js'), 'utf8'), context);
  return { ...context.module.exports, root, source, storage, sourceContent, originalSnapshot,
    setFailAudit: value => { failAudit = value; }, missingOwner: () => { missingOwner = true; }, existingDirectory: () => { existingDirectory = true; },
    cleanup: () => fs.remove(root) };
}

test('migration copies latest content, testdata, checker, settings, tags and attachment while preserving the real uploader', async () => {
  const f = await fixture();
  try {
    const value = await f.migrate(11, { id: 1 }, {}), target = f.storage.targets.get(value.problem_id);
    assert.equal(target.user_id, 7); assert.equal(target.is_anonymous, false); assert.equal(target.is_public, false);
    assert.equal(target.title, 'Latest title'); assert.equal(target.python_time_limit_multiplier, 3); assert.equal(target.java_time_limit_multiplier, 4);
    assert.equal(target.ac_num, 0); assert.equal(target.submit_num, 0); assert.equal(target.additional_file_id, 5);
    assert.equal(await fs.readFile(path.join(snapshots.currentTestdataPath(f.root, target.id), '1.out'), 'utf8'), '3\n');
    assert.ok(await fs.pathExists(path.join(snapshots.currentTestdataPath(f.root, target.id), 'checker.cpp')));
    assert.ok(f.storage.queries.some(([sql]) => sql.startsWith('INSERT INTO problem_tag_map')));
    assert.equal(f.source.id, 11); assert.equal(f.source.user_id, 7); assert.equal(f.source.ac_num, 50);
    assert.equal(f.storage.audits[0].details.owner_id, 7); assert.equal(f.storage.mapping.problem_id, target.id);
  } finally { await f.cleanup(); }
});

test('both public and private base problems migrate as private drafts with complete judge snapshots', async () => {
  for (const isPublic of [true, false]) {
    const f = await fixture({ public: isPublic });
    try {
      const result = await f.migrate(11, { id: 1 }, {});
      assert.equal(result.visibility, 'private');
      assert.equal(f.storage.targets.get(result.problem_id).is_public, false);
      assert.equal(f.source.is_public, isPublic, 'base source visibility must not change');
      assert.equal(f.storage.audits[0].details.visibility, 'private');
      assert.ok(!f.storage.queries.some(([sql]) => /is_public\s*=\s*1|status\s*=\s*'published'/.test(sql)), 'migration never publishes the copy');
      assert.ok(f.storage.queries.some(([sql, args]) => sql.startsWith('INSERT INTO problem_v2_state')
        && args[0] === result.problem_id && args[1] === 'draft'));
      assert.ok(f.storage.queries.some(([sql, args]) => sql.startsWith('INSERT INTO problem_v2_version')
        && args[0] === result.problem_id && args[3] === 'draft'));
      const snapshots = f.storage.queries.filter(([sql]) => sql.startsWith('INSERT INTO problem_v2_snapshot'));
      assert.equal(snapshots.length, 1);
      const args = snapshots[0][1];
      assert.equal(args[1], result.problem_id);
      assert.equal(args[2], f.storage.mapping.version_id);
      assert.equal(args[5], f.originalSnapshot.hash);
      assert.match(args[6], /^snapshots\/ps_/);
      assert.ok(f.storage.queries.some(([sql, values]) => sql.startsWith('UPDATE problem_v2_state SET current_snapshot_id=')
        && values[0] === args[0] && values[1] === result.problem_id));
    } finally { await f.cleanup(); }
  }
});

test('private source stays private and concurrent/retried migration produces a single copy', async () => {
  const f = await fixture({ public: false });
  try {
    const results = await Promise.all([f.migrate(11, { id: 1 }, {}), f.migrate(11, { id: 1 }, {})]);
    assert.equal(f.storage.targets.size, 1); assert.equal(results.filter(row => row.skipped).length, 1);
    assert.equal(f.storage.targets.get(results[0].problem_id).is_public, false);
    assert.equal(f.storage.queries.filter(([sql]) => sql.startsWith('SELECT problem_id FROM base_workspace_problem') && sql.endsWith('FOR UPDATE')).length, 2);
  } finally { await f.cleanup(); }
});

test('deleting or archiving the official copy permits re-migration but hiding does not', async () => {
  const f = await fixture();
  try {
    const first = await f.migrate(11, { id: 1 }, {});
    f.storage.targets.get(first.problem_id).is_public = true;
    assert.equal((await f.migrate(11, { id: 1 }, {})).skipped, true);
    assert.equal(f.storage.targets.get(first.problem_id).is_public, true, 'retry must not unpublish an existing copy');
    f.storage.targets.get(first.problem_id).is_public = false;
    assert.equal((await f.migrate(11, { id: 1 }, {})).skipped, true);
    f.storage.targets.get(first.problem_id).archived = true;
    const second = await f.migrate(11, { id: 1 }, {}); assert.notEqual(second.problem_id, first.problem_id);
    assert.equal(f.storage.targets.get(second.problem_id).is_public, false);
    f.storage.targets.delete(second.problem_id);
    const third = await f.migrate(11, { id: 1 }, {}); assert.notEqual(third.problem_id, second.problem_id);
  } finally { await f.cleanup(); }
});

test('migration requires a site admin, validates source and never attributes deleted authors to the administrator', async () => {
  const f = await fixture();
  try {
    for (const user of [null, { id: 7 }, { id: 8, privileges: ['manage_problem'] }]) await assert.rejects(f.migrate(11, user, {}), { code: 'BASE_ADMIN_REQUIRED' });
    await assert.rejects(f.migrate(12, { id: 1 }, {}), { code: 'BASE_PROBLEM_REQUIRED' });
    f.missingOwner(); await assert.rejects(f.migrate(11, { id: 1 }, {}), /原上传者/);
    assert.equal(f.storage.targets.size, 0);
  } finally { await f.cleanup(); }
});

test('audit failure rolls back copied resources and leaves source data and pre-existing directories intact', async () => {
  const f = await fixture({ failAudit: true });
  try {
    await assert.rejects(f.migrate(11, { id: 1 }, {}), /audit failed/);
    assert.equal(f.storage.targets.size, 0); assert.equal(f.storage.mapping, null);
    assert.equal(await fs.pathExists(snapshots.currentTestdataPath(f.root, 100)), false);
    assert.deepEqual(await fs.readdir(path.join(f.root, 'testdata', 'snapshots')), ['ps_original_fixture']);
    assert.ok(await fs.pathExists(snapshots.currentTestdataPath(f.root, 11)));
    f.setFailAudit(false); f.existingDirectory();
    await assert.rejects(f.migrate(11, { id: 1 }, {}), /目录已存在/);
    assert.equal(await fs.readFile(path.join(snapshots.currentTestdataPath(f.root, 101), 'unrelated'), 'utf8'), 'must preserve');
  } finally { await f.cleanup(); }
});
