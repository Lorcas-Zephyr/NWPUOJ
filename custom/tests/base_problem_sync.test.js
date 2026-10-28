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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwpuoj-base-sync-'));
  const content = domain.contentFromInput({ title: '新题目', description: '最新题面', type: 'interaction', time_limit: 1500, memory_limit: 512, python_time_limit_multiplier: 3, java_time_limit_multiplier: 4, file_io: false });
  const oldContent = domain.contentFromInput({ ...content, title: '旧题目', description: '旧题面', type: 'traditional' });
  const source = { ...content, id: 11, user_id: 7, is_public: true, additional_file_id: 5, ac_num: 2, submit_num: 3 };
  const target = { ...oldContent, id: 100, user_id: 7, is_public: !!options.public, additional_file_id: null, ac_num: 30, submit_num: 60, publicizer_id: 1, publicize_time: '2026-09-01' };
  for (const id of [11, 100]) {
    const dir = snapshots.currentTestdataPath(root, id);
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, '1.in'), '1 2\n');
    await fs.writeFile(path.join(dir, '1.out'), id === 11 ? '3\n' : '0\n');
    if (id === 11) {
      await fs.writeFile(path.join(dir, 'interactor.cpp'), '// interactor');
      await fs.writeFile(path.join(dir, 'data.yml'), 'interactor:\n  fileName: interactor.cpp\n');
    }
  }
  const sourceData = await snapshots.capture(root, 11, 'ps_source_fixture');
  const targetData = await snapshots.capture(root, 100, 'ps_target_fixture');
  const attachment = path.join(root, 'attachment.zip'); await fs.writeFile(attachment, 'attachment');
  const archive = path.join(root, 'testdata-archive', '100.zip'); await fs.outputFile(archive, 'old archive');
  const sourceSnapshot = { id: sourceData.id, problem_id: 11, version_id: 30, content_hash: domain.contentHash(content), content_json: domain.serializeContent(content), testdata_path: sourceData.path, testdata_hash: sourceData.hash };
  const targetSnapshot = { id: targetData.id, problem_id: 100, version_id: 40, content_hash: domain.contentHash(oldContent), content_json: domain.serializeContent(oldContent), testdata_path: targetData.path, testdata_hash: targetData.hash };
  const storage = {
    problems: new Map([[11, source], [100, target]]),
    states: new Map([[11, { problem_id: 11, current_version_id: 30, current_snapshot_id: sourceData.id, lifecycle_status: 'published' }], [100, { problem_id: 100, current_version_id: 40, current_snapshot_id: targetData.id, lifecycle_status: options.public ? 'published' : 'draft' }]]),
    versions: new Map([[30, { id: 30, problem_id: 11, content_json: domain.serializeContent(content), created_by: 7 }], [40, { id: 40, problem_id: 100, content_json: domain.serializeContent(oldContent) }]]),
    snapshots: new Map([[sourceData.id, sourceSnapshot], [targetData.id, targetSnapshot]]),
    tags: new Map([[11, [2, 9]], [100, [6]]]), mapping: { source_problem_id: 11, target_problem_id: 100, target_version_id: 40 }, marker: null, events: [], nextVersion: 50
  };
  const faults = { event: false, cache: false, commit: false, upload: false }, queries = [], invalidations = [], contests = [], timers = [];
  const query = async (statement, args = []) => {
    const sql = statement.replace(/\s+/g, ' ').trim(); queries.push([sql, args]);
    if (sql.startsWith('SELECT problem_id FROM base_workspace_problem')) return args[0] === 11 ? [{ problem_id: 11 }] : [];
    if (sql.startsWith('SELECT * FROM base_workspace_problem_migration')) return storage.mapping ? [storage.mapping] : [];
    if (sql.startsWith('SELECT m.source_problem_id')) return storage.mapping ? [storage.mapping] : [];
    if (sql.startsWith('SELECT id FROM problem_v2_job')) return faults.upload ? [{ id: 'upload' }] : [];
    if (sql.startsWith('SELECT * FROM problem_v2_state')) return args[0].map(id => storage.states.get(id)).filter(Boolean);
    if (sql.startsWith('SELECT * FROM problem WHERE')) return args[0].map(id => storage.problems.get(id)).filter(Boolean);
    if (sql.startsWith('SELECT * FROM problem_v2_version')) return [storage.versions.get(Number(args[0]))].filter(Boolean);
    if (sql.startsWith('SELECT * FROM problem_v2_snapshot WHERE id=')) return [storage.snapshots.get(args[0])].filter(Boolean);
    if (sql.startsWith('SELECT * FROM problem_v2_snapshot WHERE problem_id=')) return [...storage.snapshots.values()].filter(row => row.problem_id === args[0] && row.content_hash === args[1] && row.testdata_hash === args[2]);
    if (sql.startsWith('SELECT tag_id')) return storage.tags.get(args[0]).map(tag_id => ({ tag_id }));
    if (sql.startsWith('SELECT * FROM base_workspace_problem_sync')) return storage.marker ? [storage.marker] : [];
    if (sql.startsWith('SELECT COALESCE')) return [{ next_version: storage.nextVersion }];
    if (sql.startsWith('INSERT INTO problem_v2_version')) {
      const id = storage.nextVersion++; storage.versions.set(id, { id, problem_id: args[0], content_json: args[4], content_hash: args[5], status: args[3], created_by: args[6] }); return { insertId: id };
    }
    if (sql.startsWith('INSERT INTO problem_v2_state')) { storage.states.get(args[0]).current_version_id = args[2]; return {}; }
    if (sql.startsWith('INSERT INTO problem_v2_snapshot')) {
      storage.snapshots.set(args[0], { id: args[0], problem_id: args[1], version_id: args[2], content_hash: args[3], content_json: args[4], testdata_hash: args[5], testdata_path: args[6] }); return {};
    }
    if (sql.startsWith('UPDATE problem_v2_version')) return {};
    if (sql.startsWith('UPDATE problem SET')) {
      const row = storage.problems.get(args.at(-1)); domain.EDITABLE_FIELDS.forEach((field, i) => { row[field] = args[i]; }); row.additional_file_id = args.at(-2); return {};
    }
    if (sql.startsWith('UPDATE problem_v2_state')) { Object.assign(storage.states.get(args[2]), { current_version_id: args[0], current_snapshot_id: args[1] }); return {}; }
    if (sql.startsWith('DELETE FROM problem_tag_map')) { storage.tags.set(args[0], []); return {}; }
    if (sql.startsWith('INSERT INTO problem_tag_map')) { storage.tags.set(args[0], storage.tags.get(args[1]).slice()); return {}; }
    if (sql.startsWith('INSERT INTO base_workspace_problem_sync')) {
      const success = sql.includes('source_fingerprint');
      storage.marker = { ...storage.marker, source_problem_id: args[0], target_problem_id: args[1], ...(success ? { source_fingerprint: args[2] } : {}), last_error: success ? 'pending effects' : args[2] }; return {};
    }
    if (sql.startsWith('UPDATE base_workspace_problem_sync SET last_error=NULL')) { storage.marker.last_error = null; return {}; }
    if (sql.startsWith('INSERT INTO api_v2_event')) { if (faults.event) throw Error('event failed'); storage.events.push(args); return {}; }
    throw Error(`Unexpected SQL: ${sql}`);
  };
  let transactionTail = Promise.resolve();
  const db = { query, async transaction(fn) {
    const predecessor = transactionTail; let release;
    transactionTail = new Promise(resolve => { release = resolve; }); await predecessor;
    const before = structuredClone(storage);
    try { const value = await fn({ query }); if (faults.commit) throw Error('commit failed'); return value; }
    catch (e) { Object.assign(storage, before); throw e; } finally { release(); }
  } };
  const base = { ensureSchema: async () => {}, migrationStates: async () => storage.mapping && storage.problems.has(100) && storage.states.get(100).lifecycle_status !== 'archived' ? new Map([[11, { problem_id: 100 }]]) : new Map() };
  const context = { module: { exports: {} }, setTimeout: (fn, delay) => { timers.push({ fn, delay }); return { unref() {} }; }, syzoj: {
    config: { upload_dir: root }, log() {}, model: name => name === 'file' ? { findById: async () => ({ getPath: () => attachment }) } : {
      deleteFromCache: async id => { if (faults.cache) throw Error('cache failed'); invalidations.push(id); }
    }, utils: {
      parseTestdata: async () => ({ testcases: [{ cases: [{}] }] }),
      problemV2: { ensureSchema: async () => {} }, problemWorkflowV2: { ensureSchema: async () => {} }, apiV2: { ensureFoundationSchema: async () => {} },
      contestV2: { syncProblemSnapshotsForProblem: async id => { contests.push(id); } }
    }
  }, require(name) {
    if (name === 'typeorm') return { getConnection: () => db };
    if (name === './base-workspace') return base;
    if (name.startsWith('./')) return require('../libs/' + name.slice(2));
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../libs/base-problem-migration.js'), 'utf8'), context);
  return { ...context.module.exports, root, storage, faults, queries, invalidations, contests, timers, sourceData, targetData, archive,
    changeContent(value) { const row = storage.versions.get(30); row.content_json = domain.serializeContent({ ...JSON.parse(row.content_json), ...value }); },
    cleanup: () => fs.remove(root) };
}

test('sync updates latest statement, configuration, data, tags and attachments without changing official identity or visibility', async () => {
  for (const isPublic of [false, true]) {
    const f = await fixture({ public: isPublic });
    try {
      const result = await f.synchronize(11), target = f.storage.problems.get(100);
      assert.equal(result.skipped, false); assert.equal(target.title, '新题目'); assert.equal(target.description, '最新题面');
      assert.equal(target.type, 'interaction'); assert.equal(target.python_time_limit_multiplier, 3); assert.equal(target.java_time_limit_multiplier, 4);
      assert.equal(target.is_public, isPublic); assert.equal(target.user_id, 7); assert.equal(target.ac_num, 30); assert.equal(target.submit_num, 60);
      assert.equal(target.publicizer_id, 1); assert.equal(target.publicize_time, '2026-09-01'); assert.equal(target.additional_file_id, 5);
      assert.deepEqual(f.storage.tags.get(100), [2, 9]); assert.deepEqual(f.invalidations, [100]); assert.deepEqual(f.contests, [100]);
      assert.equal(await fs.readFile(path.join(snapshots.currentTestdataPath(f.root, 100), '1.out'), 'utf8'), '3\n');
      assert.ok(await fs.pathExists(path.join(snapshots.currentTestdataPath(f.root, 100), 'interactor.cpp')));
      assert.equal(await fs.pathExists(f.archive), false);
      assert.equal(await fs.readFile(path.join(snapshots.snapshotDirectory(f.root, f.targetData.id), '1.out'), 'utf8'), '0\n', 'historical testdata is immutable');
      assert.equal(f.storage.marker.last_error, null);
      assert.equal(f.storage.versions.get(50).status, isPublic ? 'published' : 'draft');
    } finally { await f.cleanup(); }
  }
});

test('idempotent retries and concurrent ticks create only one version; unchanged source never overwrites independent official edits', async () => {
  const f = await fixture();
  try {
    const results = await Promise.all([f.synchronize(11), f.synchronize(11)]);
    assert.equal(results.filter(row => !row.skipped).length, 1); assert.equal(f.storage.events.length, 1);
    f.storage.problems.get(100).title = '正式题库手动修改';
    assert.equal((await f.synchronize(11)).skipped, true); assert.equal(f.storage.problems.get(100).title, '正式题库手动修改');
    assert.equal((await f.synchronize(100)).skipped, true); assert.equal(f.storage.problems.get(11).title, '新题目');
    await assert.rejects(f.synchronize('../100'));
  } finally { await f.cleanup(); }
});

test('later title/tag/attachment removals synchronize and reuse independent target data without replacing live files', async () => {
  const f = await fixture();
  try {
    await f.synchronize(11);
    const beforeFiles = await fs.readdir(path.join(f.root, 'testdata', 'snapshots'));
    const liveFile = path.join(snapshots.currentTestdataPath(f.root, 100), '1.out'), beforeStat = await fs.stat(liveFile);
    f.changeContent({ title: '再改标题' }); f.storage.tags.set(11, []); f.storage.problems.get(11).additional_file_id = null;
    await f.synchronize(11);
    assert.equal(f.storage.problems.get(100).title, '再改标题'); assert.deepEqual(f.storage.tags.get(100), []); assert.equal(f.storage.problems.get(100).additional_file_id, null);
    assert.deepEqual(await fs.readdir(path.join(f.root, 'testdata', 'snapshots')), beforeFiles);
    assert.equal((await fs.stat(liveFile)).ino, beforeStat.ino);
  } finally { await f.cleanup(); }
});

test('deleted/archived/unmapped destinations and in-progress uploads are skipped without resurrection', async () => {
  for (const mode of ['deleted', 'archived', 'unmapped', 'upload']) {
    const f = await fixture();
    try {
      if (mode === 'deleted') f.storage.problems.delete(100);
      if (mode === 'archived') f.storage.states.get(100).lifecycle_status = 'archived';
      if (mode === 'unmapped') f.storage.mapping = null;
      if (mode === 'upload') f.faults.upload = true;
      assert.equal((await f.synchronize(11)).skipped, true); assert.equal(f.storage.events.length, 0); assert.equal(f.storage.marker, null);
    } finally { await f.cleanup(); }
  }
});

test('event/commit failures roll back target data, archive and SQL; corrupted source never propagates', async () => {
  for (const fault of ['event', 'commit', 'corrupt']) {
    const f = await fixture();
    try {
      if (fault === 'corrupt') await fs.writeFile(path.join(snapshots.snapshotDirectory(f.root, f.sourceData.id), '1.out'), 'corrupted');
      else f.faults[fault] = true;
      await assert.rejects(f.synchronize(11));
      assert.equal(f.storage.problems.get(100).title, '旧题目'); assert.equal(f.storage.marker, null);
      assert.equal(await fs.readFile(path.join(snapshots.currentTestdataPath(f.root, 100), '1.out'), 'utf8'), '0\n');
      assert.equal(await fs.readFile(f.archive, 'utf8'), 'old archive');
      assert.deepEqual((await fs.readdir(path.join(f.root, 'testdata', 'snapshots'))).sort(), ['ps_source_fixture', 'ps_target_fixture']);
    } finally { await f.cleanup(); }
  }
});

test('worker persists failures and retries after commit without duplicate versions or destructive rollback', async () => {
  const f = await fixture();
  try {
    f.faults.cache = true; const first = await f.synchronizeAll();
    assert.equal(first[0].failed, true); assert.match(f.storage.marker.last_error, /cache failed/);
    assert.equal(f.storage.problems.get(100).title, '新题目'); assert.equal(f.storage.events.length, 1);
    f.faults.cache = false; await f.synchronizeAll();
    assert.equal(f.storage.marker.last_error, null); assert.equal(f.storage.events.length, 1); assert.deepEqual(f.invalidations, [100]);
    f.startSyncWorker(); f.startSyncWorker(); assert.equal(f.timers.length, 1); assert.equal(f.timers[0].delay, 5000);
  } finally { await f.cleanup(); }
});

test('legacy source without snapshot uses validated live data and supports draft statements without testdata', async () => {
  for (const empty of [false, true]) {
    const f = await fixture();
    try {
      f.storage.states.get(11).current_snapshot_id = null;
      if (empty) await fs.remove(snapshots.currentTestdataPath(f.root, 11));
      assert.equal((await f.synchronize(11)).skipped, false);
      assert.equal(f.storage.problems.get(100).title, '新题目');
      if (empty) assert.deepEqual(await fs.readdir(snapshots.currentTestdataPath(f.root, 100)), []);
    } finally { await f.cleanup(); }
  }
});
