'use strict';
// Connection-local TEMPORARY tables shadow their production names. The test
// never mutates persistent user, profile, audit, or legal tables.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('real registration transaction commits or rolls back acknowledgement and account together (isolated MySQL)', { timeout: 45000 }, () => {
  const run = async function () {
    const fs = require('fs'), vm = require('vm'), assert = require('assert').strict, path = require('path');
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const t = require('typeorm'), c = require('/app/config/web.json').db, h = process.env.SYZOJ_WEB_DB_HOST || c.host;
    const connection = await t.createConnection({ type: 'mysql', host: h.split(':')[0], port: Number(h.split(':')[1] || 3306),
      username: process.env.SYZOJ_WEB_DB_USERNAME || c.username, password: process.env.SYZOJ_WEB_DB_PASSWORD || c.password, database: process.env.SYZOJ_WEB_DB_DATABASE || c.database });
    const runner = connection.createQueryRunner();
    await runner.connect();
    try {
      const definitions = {
        user: 'id INT PRIMARY KEY AUTO_INCREMENT,username VARCHAR(80) UNIQUE,password VARCHAR(100),email VARCHAR(100),is_admin TINYINT,is_show TINYINT,public_email TINYINT,prefer_formatted_code TINYINT,rating INT,register_time INT',
        user_registration_profile: 'user_id INT PRIMARY KEY,student_id VARCHAR(10),real_name VARCHAR(64),college VARCHAR(100),created_at INT,updated_at INT',
        auth_user_state: 'user_id INT PRIMARY KEY,status VARCHAR(20),reason TEXT,changed_by INT,changed_at DATETIME',
        api_v2_event: 'id INT PRIMARY KEY AUTO_INCREMENT,stream VARCHAR(100),type VARCHAR(100),aggregate_id VARCHAR(100),actor_id INT,payload_json TEXT,created_at DATETIME'
      };
      for (const [name, columns] of Object.entries(definitions)) await runner.query('CREATE TEMPORARY TABLE ' + name + ' (' + columns + ') ENGINE=InnoDB');
      const module = { exports: {} };
      const mockFs = { readFileSync: file => input.documents[path.basename(file)] };
      vm.runInNewContext(input.library, { module, exports: module.exports, __dirname: '/fixture/libs', require: name => name === 'fs' ? mockFs : require(name), Buffer });
      const service = module.exports.createLegalService({ directory: '/fixture/content/legal', connection: () => ({ query: async sql => {
        assert.match(sql, /^CREATE TABLE IF NOT EXISTS (site_legal_revision|user_legal_acknowledgement) /);
        return runner.query(sql.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMPORARY TABLE IF NOT EXISTS'));
      } }) });
      await service.ensureSchema();
      const txConnection = { transaction: async fn => {
        await runner.startTransaction();
        try { const result = await fn({ query: (sql, args) => runner.query(sql, args) }); await runner.commitTransaction(); return result; }
        catch (error) { await runner.rollbackTransaction(); throw error; }
      } };
      const published = [];
      const syzoj = { config: { default: { user: { show: 1, rating: 1500 } } }, utils: {
        legalDocuments: service, ensureSiteOwner: async () => {}, ensureAccountStateSchema: async () => {},
        hashPassword: async () => 'fixture-hash', claimSiteOwner: async () => {},
        apiV2: { ensureFoundationSchema: async () => {}, publishEvent: event => published.push(event) }
      } };
      const context = { syzoj, TypeORM: { getConnection: () => txConnection }, ensureRegistrationSchema: async () => {},
        User: { findById: async id => (await runner.query('SELECT * FROM user WHERE id=?', [id]))[0] } };
      vm.runInNewContext(input.createAccount, context);
      const data = { username: 'isolated-review', password: 'fixture-only', email: 'review@example.invalid',
        identity: { studentId: '2026000000', realName: '测试', college: '测试学院' },
        legalAcknowledgement: { legal_version: service.registrationPolicy().version, terms_accepted: true, privacy_acknowledged: true } };
      const user = await context.createAccount(data);
      assert.equal(Number(user.public_email), 0);
      const receipts = await runner.query('SELECT * FROM user_legal_acknowledgement');
      assert.equal(receipts.length, 1);
      assert.equal(Number(receipts[0].user_id), Number(user.id));
      assert.equal(Object.prototype.hasOwnProperty.call(receipts[0], 'age_at_least'), false);
      assert.equal(Number(receipts[0].privacy_acknowledged), 1);
      const versions = await runner.query('SELECT * FROM site_legal_revision');
      assert.equal(versions.length, 1);
      assert.equal(versions[0].snapshot_json, service.bundle.snapshot);
      await assert.rejects(context.createAccount({ ...data, username: 'missing-confirmation', legalAcknowledgement: null }), /阅读/);
      syzoj.utils.legalDocuments = { ...service, persistAcknowledgement: async (...args) => { await service.persistAcknowledgement(...args); throw new Error('forced-after-receipt-write'); } };
      await assert.rejects(context.createAccount({ ...data, username: 'rollback-fixture' }), /forced-after-receipt-write/);
      for (const table of ['user', 'user_registration_profile', 'auth_user_state', 'api_v2_event', 'user_legal_acknowledgement', 'site_legal_revision']) {
        assert.equal(Number((await runner.query('SELECT COUNT(*) AS n FROM ' + table))[0].n), 1, table + ' rolls back with the failed registration');
      }
      assert.equal(published.length, 1);
      process.stdout.write('PASS: temporary-table account, privacy default, receipt snapshot, missing confirmation and rollback checks\n');
    } finally { await runner.release(); await connection.close(); }
  };
  const documents = Object.fromEntries(['manifest.json', 'terms.md', 'privacy.md', 'competition.md', 'copyright.md'].map(name => [name, read('content/legal/' + name)]));
  documents['manifest.json'] = JSON.stringify({ ...JSON.parse(documents['manifest.json']), status: 'approved', effective_date: '2026-01-01', guardian_consent_status: 'ready', review_pending: [] });
  const source = read('modules/_registration_identity.js');
  const createAccount = source.slice(source.indexOf('async function createAccount('), source.indexOf('function validRegistrationCsrf('));
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', '(' + run.toString() + ')().catch(error=>{console.error(error.message);process.exit(1);});'], {
    cwd: path.join(root, '..'), input: JSON.stringify({ documents, createAccount, library: read('libs/legal-documents.js') }), encoding: 'utf8', timeout: 40000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS:/);
});
