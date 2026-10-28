'use strict';
// Opt-in SQL integration check, run inside the Web container. All writes use
// connection-local TEMPORARY tables shadowing the real table names, and a fresh
// OS temporary upload directory. No real problems/users/submissions are edited.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
test('base synchronization works with real MariaDB SQL and existing schema in isolated temporary tables', { skip: process.env.NWPUOJ_SYNC_DB_TEST !== '1' }, async () => {
  const appRoot = process.env.NWPUOJ_APP_ROOT || '/app';
  const fs = require(path.join(appRoot, 'node_modules/fs-extra'));
  const typeorm = require(path.join(appRoot, 'node_modules/typeorm'));
  const domain = require(path.join(appRoot, 'libs/problem-domain'));
  const snapshots = require(path.join(appRoot, 'libs/testdata-snapshot'));
  const cfg = require(path.join(appRoot, 'config/web.json')).db;
  const host = process.env.SYZOJ_WEB_DB_HOST || cfg.host;
  const connection = await typeorm.createConnection({ type: 'mysql', host: host.split(':')[0], port: Number(host.split(':')[1] || 3306),
    username: process.env.SYZOJ_WEB_DB_USERNAME || cfg.username, password: process.env.SYZOJ_WEB_DB_PASSWORD || cfg.password,
    database: process.env.SYZOJ_WEB_DB_DATABASE || cfg.database });
  const runner = connection.createQueryRunner(); await runner.connect();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwpuoj-base-sync-sql-'));
  try {
    for (const table of ['problem', 'problem_v2_state', 'problem_v2_version', 'problem_v2_snapshot', 'problem_tag_map', 'base_workspace_problem', 'base_workspace_problem_migration', 'problem_v2_job', 'api_v2_event']) {
      const definition = (await runner.query(`SHOW CREATE TABLE \`${table}\``))[0]['Create Table'];
      await runner.query(definition.replace(/^CREATE TABLE /, 'CREATE TEMPORARY TABLE '));
    }
    await runner.query(`CREATE TEMPORARY TABLE base_workspace_problem_sync (
      source_problem_id INT PRIMARY KEY,target_problem_id INT NOT NULL,source_fingerprint CHAR(64),synced_at DATETIME(3),last_error TEXT,attempted_at DATETIME(3) NOT NULL)`);
    let failEvent = false;
    const manager = { query: (sql, args) => {
      if (failEvent && sql.startsWith('INSERT INTO api_v2_event')) throw Error('isolated event failure');
      return runner.query(sql, args);
    } };
    const db = { query: manager.query, transaction: async fn => {
      await runner.startTransaction();
      try { const result = await fn(manager); await runner.commitTransaction(); return result; }
      catch (e) { await runner.rollbackTransaction(); throw e; }
    } };
    const old = domain.contentFromInput({ title: '旧题', description: '旧题面', time_limit: 1000, memory_limit: 256, type: 'traditional', file_io: false });
    const current = domain.contentFromInput({ ...old, title: '新题', description: '新题面', type: 'interaction', python_time_limit_multiplier: 3, java_time_limit_multiplier: 4 });
    for (const id of [11, 100]) {
      const content = id === 11 ? current : old;
      await runner.query('INSERT INTO problem (id,title,user_id,is_public,ac_num,submit_num) VALUES (?,?,7,0,30,60)', [id, content.title]);
      const version = await domain.insertVersion(manager, id, content, 7);
      await fs.outputFile(path.join(snapshots.currentTestdataPath(root, id), '1.in'), '1 2\n');
      await fs.outputFile(path.join(snapshots.currentTestdataPath(root, id), '1.out'), id === 11 ? '3\n' : '0\n');
      const data = await snapshots.capture(root, id, `ps_integration_${id}`);
      await runner.query(`INSERT INTO problem_v2_snapshot (id,problem_id,version_id,content_hash,content_json,testdata_hash,testdata_path,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,7,UTC_TIMESTAMP(3))`, [data.id, id, version.id, domain.contentHash(content), domain.serializeContent(content), data.hash, data.path]);
      await runner.query('UPDATE problem_v2_state SET current_snapshot_id=? WHERE problem_id=?', [data.id, id]);
      if (id === 100) await runner.query('INSERT INTO base_workspace_problem_migration VALUES (11,100,?,1,UTC_TIMESTAMP(3))', [version.id]);
    }
    await runner.query('INSERT INTO base_workspace_problem VALUES (11,7,UTC_TIMESTAMP(3))');
    await runner.query('INSERT INTO problem_tag_map (problem_id,tag_id) VALUES (11,2),(11,9),(100,6)');
    const syzoj = { config: { upload_dir: root }, log() {}, model: () => ({ deleteFromCache: async () => {} }), utils: { contestV2: { syncProblemSnapshotsForProblem: async () => {} } } };
    const context = { module: { exports: {} }, syzoj, require(name) {
      if (name === 'typeorm') return { getConnection: () => db };
      if (name === './base-workspace') return { migrationStates: async (ids, queryable) => {
        const rows = await queryable.query(`SELECT m.target_problem_id FROM base_workspace_problem_migration m JOIN problem p ON p.id=m.target_problem_id
          JOIN problem_v2_version v ON v.id=m.target_version_id AND v.problem_id=p.id
          JOIN problem_v2_state s ON s.problem_id=p.id WHERE m.source_problem_id=? AND s.lifecycle_status<>'archived'`, [ids[0]]);
        return new Map(rows.map(row => [ids[0], { problem_id: Number(row.target_problem_id) }]));
      } };
      if (name.startsWith('./')) return require(path.join(appRoot, 'libs', name.slice(2)));
      if (['crypto', 'path'].includes(name)) return require(name);
      return require(path.join(appRoot, 'node_modules', name));
    } };
    vm.runInNewContext(await fs.readFile(path.join(appRoot, 'libs/base-problem-migration.js'), 'utf8'), context);
    const sync = context.module.exports.synchronize;
    assert.equal((await sync(11)).skipped, false);
    let target = (await runner.query('SELECT * FROM problem WHERE id=100'))[0];
    assert.equal(target.title, current.title); assert.equal(target.is_public, 0); assert.equal(target.submit_num, 60); assert.equal(target.java_time_limit_multiplier, 4);
    assert.equal((await sync(11)).skipped, true);
    assert.equal(await fs.readFile(path.join(snapshots.currentTestdataPath(root, 100), '1.out'), 'utf8'), '3\n');
    await runner.query('UPDATE problem SET is_public=1 WHERE id=100');
    const edited = { ...current, title: '再次修改' }; await domain.insertVersion(manager, 11, edited, 7);
    await sync(11);
    target = (await runner.query('SELECT * FROM problem WHERE id=100'))[0];
    assert.equal(target.title, edited.title); assert.equal(target.is_public, 1);
    await domain.insertVersion(manager, 11, current, 7); // exercise snapshot uniqueness/reuse on revert
    await sync(11);
    assert.equal((await runner.query('SELECT title FROM problem WHERE id=100'))[0].title, current.title);
    await domain.insertVersion(manager, 11, edited, 7);
    failEvent = true; await assert.rejects(sync(11), /isolated event failure/); failEvent = false;
    assert.equal((await runner.query('SELECT title FROM problem WHERE id=100'))[0].title, current.title);
    await sync(11);
    assert.equal((await runner.query('SELECT last_error FROM base_workspace_problem_sync'))[0].last_error, null);
    await runner.query("UPDATE problem_v2_state SET lifecycle_status='archived' WHERE problem_id=100");
    assert.equal((await sync(11)).skipped, true);
  } finally {
    await fs.remove(root);
    await runner.release();
    await connection.close();
  }
});
