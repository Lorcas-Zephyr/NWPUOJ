'use strict';

// Every mutable table is connection-local and temporary. The normal service
// SQL is exercised without publishing test text or creating production users.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('editable legal publication, audit and registration are atomic and survive reload (isolated MySQL)', { timeout: 45000 }, () => {
  const run = async function () {
    const fs = require('fs'), vm = require('vm'), assert = require('assert').strict, path = require('path');
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const t = require('typeorm'), c = require('/app/config/web.json').db, h = process.env.SYZOJ_WEB_DB_HOST || c.host;
    const connection = await t.createConnection({ type: 'mysql', host: h.split(':')[0], port: Number(h.split(':')[1] || 3306),
      username: process.env.SYZOJ_WEB_DB_USERNAME || c.username, password: process.env.SYZOJ_WEB_DB_PASSWORD || c.password, database: process.env.SYZOJ_WEB_DB_DATABASE || c.database });
    const runner = connection.createQueryRunner();
    await runner.connect();
    try {
      await runner.query('CREATE TEMPORARY TABLE legal_editor_test_audit (id INT AUTO_INCREMENT PRIMARY KEY,details TEXT) ENGINE=InnoDB');
      await runner.query('CREATE TEMPORARY TABLE legal_editor_test_user (id INT PRIMARY KEY) ENGINE=InnoDB');
      const db = {
        query: (sql, args) => {
          if (sql.startsWith('CREATE TABLE')) {
            assert.match(sql, /^CREATE TABLE IF NOT EXISTS (site_legal_revision|user_legal_acknowledgement|site_legal_publication) /);
            sql = sql.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMPORARY TABLE IF NOT EXISTS');
          }
          return runner.query(sql, args);
        },
        transaction: async fn => {
          await runner.startTransaction();
          try { const result = await fn({ query: (sql, args) => runner.query(sql, args) }); await runner.commitTransaction(); return result; }
          catch (error) { await runner.rollbackTransaction(); throw error; }
        }
      };
      const module = { exports: {} };
      vm.runInNewContext(input.library, { module, exports: module.exports, __dirname: '/fixture/libs', Buffer,
        require: name => name === 'fs' ? { readFileSync: file => input.documents[path.basename(file)] } : require(name) });
      const makeService = () => module.exports.createLegalService({ editable: true, directory: '/fixture/legal', connection: () => db });
      const service = makeService();
      const seed = service.bundle;
      const audit = async (manager, details) => String((await manager.query('INSERT INTO legal_editor_test_audit (details) VALUES (?)', [JSON.stringify(details)])).insertId);
      const count = async table => Number((await runner.query('SELECT COUNT(*) AS n FROM ' + table))[0].n);
      assert.equal((await service.refresh()).revision, seed.revision);
      assert.equal(await count('site_legal_revision'), 1);
      const edited = await service.publishDocument('terms', '## 隔离测试\n\n新的协议正文。', seed.revision, 101, audit);
      assert.equal(edited.changed, true);
      assert.notEqual(edited.bundle.revision, seed.revision);
      assert.equal(await count('site_legal_revision'), 2);
      assert.equal(await count('legal_editor_test_audit'), 1);
      assert.equal(edited.bundle.documents[0].markdown, '## 隔离测试\n\n新的协议正文。');
      assert.equal(JSON.stringify(edited.bundle.documents.slice(1)), JSON.stringify(seed.documents.slice(1)));
      assert.equal(edited.bundle.manifest.guardian_consent_status, seed.manifest.guardian_consent_status);
      assert.equal(JSON.stringify(edited.bundle.manifest.implementation_pending), JSON.stringify(seed.manifest.implementation_pending));
      assert.equal((await service.getBundle(seed.revision)).snapshot, seed.snapshot);
      const restarted = makeService();
      assert.equal((await restarted.refresh()).revision, edited.bundle.revision);
      const head = (await runner.query('SELECT * FROM site_legal_publication WHERE id=1'))[0];
      assert.equal(Number(head.updated_by), 101);
      assert.equal(Number(head.sequence), 2);
      assert.equal((await restarted.publishDocument('terms', edited.bundle.documents[0].markdown, edited.bundle.revision, 101, audit)).changed, false);
      assert.equal(await count('site_legal_revision'), 2);
      assert.equal(await count('legal_editor_test_audit'), 1);
      await assert.rejects(restarted.publishDocument('privacy', '过期修改', seed.revision, 101, audit), error => error.statusCode === 412);
      // Even after a callback has inserted an audit row, a failure rolls back
      // the snapshot and audit together, leaving the public head unchanged.
      await assert.rejects(restarted.publishDocument('terms', '失败事务', edited.bundle.revision, 101, async (...args) => {
        await audit(...args); throw new Error('audit-failed');
      }), /audit-failed/);
      assert.equal(await count('site_legal_revision'), 2);
      assert.equal(await count('legal_editor_test_audit'), 1);
      assert.equal((await restarted.refresh()).revision, edited.bundle.revision);
      for (const [slug, content, status] of [['unknown', 'text', 404], ['terms', '', 422], ['terms', '  ', 422], ['terms', null, 422], ['terms', '中'.repeat(70000), 413]]) {
        await assert.rejects(restarted.publishDocument(slug, content, edited.bundle.revision, 101, audit), error => error.statusCode === status);
      }
      // The user may have read the old version before another administrator
      // published. Registration must recheck under the same head lock.
      const accept = version => ({ terms_accepted: true, privacy_acknowledged: true, legal_version: version });
      await assert.rejects(db.transaction(async manager => {
        await manager.query('INSERT INTO legal_editor_test_user (id) VALUES (42)');
        await restarted.persistAcknowledgement(manager, 42, accept(seed.revision));
      }), /版本已更新/);
      assert.equal(await count('legal_editor_test_user'), 0);
      assert.equal(await count('user_legal_acknowledgement'), 0);
      await db.transaction(async manager => {
        await manager.query('INSERT INTO legal_editor_test_user (id) VALUES (42)');
        await restarted.persistAcknowledgement(manager, 42, accept(edited.bundle.revision));
      });
      assert.equal(await count('legal_editor_test_user'), 1);
      const receipt = (await runner.query('SELECT * FROM user_legal_acknowledgement'))[0];
      assert.equal(receipt.revision, edited.bundle.revision);
      const next = await restarted.publishDocument('competition', '## 比赛规则更新', edited.bundle.revision, 101, audit);
      assert.equal((await restarted.getBundle(edited.bundle.revision)).snapshot, edited.bundle.snapshot);
      assert.equal((await runner.query('SELECT revision FROM user_legal_acknowledgement'))[0].revision, edited.bundle.revision);
      assert.equal((await makeService().refresh()).revision, next.bundle.revision);
      process.stdout.write('PASS: SQL schema, head locks, immutable versions, reload, audit rollback, stale registration and validation\n');
    } finally { await runner.release(); await connection.close(); }
  };
  const documents = Object.fromEntries(['manifest.json', 'terms.md', 'privacy.md', 'competition.md', 'copyright.md'].map(name => [name, read('content/legal/' + name)]));
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', '(' + run.toString() + ')().catch(error=>{console.error(error.message);process.exit(1);});'], {
    cwd: path.join(root, '..'), input: JSON.stringify({ documents, library: read('libs/legal-documents.js') }), encoding: 'utf8', timeout: 40000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS:/);
});
