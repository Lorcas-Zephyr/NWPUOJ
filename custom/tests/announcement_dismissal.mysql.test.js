'use strict';
// Uses isolated fixture tables and removes them on completion.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('account dismissal persists, retries concurrently, rolls back with events and cleans up on deletion (MySQL)', { timeout: 60000 }, () => {
  const run = async function () {
    const fs = require('fs'), vm = require('vm'), assert = require('assert').strict, crypto = require('crypto');
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const orm = require('typeorm'), config = require('/app/config/web.json').db;
    const host = process.env.SYZOJ_WEB_DB_HOST || config.host;
    const connection = await orm.createConnection({ type: 'mysql', host: host.split(':')[0], port: Number(host.split(':')[1] || 3306), username: process.env.SYZOJ_WEB_DB_USERNAME || config.username, password: process.env.SYZOJ_WEB_DB_PASSWORD || config.password, database: process.env.SYZOJ_WEB_DB_DATABASE || config.database });
    const prefix = 'test_ann_' + crypto.randomBytes(6).toString('hex') + '_';
    const names = ['announcement', 'announcement_dismissal', 'api_v2_event'];
    const pattern = /\b(announcement|announcement_dismissal|api_v2_event)\b/g;
    let failEvent = false;
    const wrap = db => ({ query(sql, params) {
      if (failEvent && sql.includes('INSERT INTO api_v2_event')) throw new Error('event-failure');
      return db.query(sql.replace(pattern, name => prefix + name), params);
    } });
    const db = wrap(connection), moduleObject = { exports: {} };
    vm.runInNewContext(input.library, { module: moduleObject, exports: moduleObject.exports, require });
    const content = moduleObject.exports;
    const dismiss = (userId, announcementId = 81) => connection.transaction(manager => content.dismissAnnouncement(wrap(manager), { userId, announcementId, now: 1000 }));
    try {
      await db.query('CREATE TABLE announcement(id INT PRIMARY KEY,title VARCHAR(255),level VARCHAR(20),is_active TINYINT,start_time BIGINT NULL,end_time BIGINT NULL) ENGINE=InnoDB');
      await db.query(input.schema);
      await db.query('CREATE TABLE api_v2_event(id BIGINT AUTO_INCREMENT PRIMARY KEY,stream VARCHAR(160),type VARCHAR(120),aggregate_id VARCHAR(120),actor_id INT,payload_json LONGTEXT,created_at DATETIME(3)) ENGINE=InnoDB');
      await db.query("INSERT INTO announcement VALUES(81,'Active','important',1,900,1100),(82,'New','warning',1,NULL,NULL),(83,'Expired','important',1,800,900),(84,'Inactive','important',0,NULL,NULL),(85,'Future','warning',1,1100,1200),(86,'Info','info',1,NULL,NULL)");
      await Promise.all([dismiss(7), dismiss(7), dismiss(7), dismiss(8)]);
      let records = await db.query('SELECT user_id,announcement_id,dismissed_at FROM announcement_dismissal ORDER BY user_id');
      assert.deepEqual(records.map(row => [Number(row.user_id), Number(row.announcement_id)]), [[7,81],[8,81]]);
      assert.equal(Number((await db.query('SELECT COUNT(*) AS count FROM api_v2_event'))[0].count), 2);
      assert.equal((await dismiss(7)).eventId, null);
      await dismiss(7, 82);
      for (const id of [83,84,85,86,999]) await assert.rejects(dismiss(7, id), error => error.statusCode === 404);
      failEvent = true;
      await assert.rejects(dismiss(9), /event-failure/);
      failEvent = false;
      assert.equal((await db.query('SELECT * FROM announcement_dismissal WHERE user_id=9')).length, 0);
      await connection.transaction(manager => content.deleteAnnouncement(wrap(manager), { actorId: 1, announcementId: 81, recordAudit: async () => 'fixture' }));
      records = await db.query('SELECT user_id,announcement_id FROM announcement_dismissal');
      assert.deepEqual(records.map(row => [Number(row.user_id), Number(row.announcement_id)]), [[7,82]]);
      process.stdout.write('Account isolation, concurrent retries, event rollback, active-only writes and deletion cleanup passed.\n');
    } finally {
      failEvent = false;
      for (const name of names.reverse()) await connection.query('DROP TABLE IF EXISTS ' + prefix + name);
      await connection.close();
    }
  };
  const root = path.resolve(__dirname, '../..');
  const source = fs.readFileSync(path.join(root, 'custom/modules/_api_v2_foundation.js'), 'utf8');
  const schema = source.match(/CREATE TABLE IF NOT EXISTS announcement_dismissal[\s\S]*?ENGINE=InnoDB DEFAULT CHARSET=utf8mb4/)[0];
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', '(' + run.toString() + ')().catch(error=>{console.error(error);process.exitCode=1;})'], {
    cwd: root, input: JSON.stringify({ schema, library: fs.readFileSync(path.join(root, 'custom/libs/content-domain.js'), 'utf8') }), encoding: 'utf8', timeout: 55000
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /deletion cleanup passed/);
});
