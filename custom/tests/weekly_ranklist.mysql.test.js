'use strict';
// Real SQL integration tests on connection-local TEMPORARY tables only. No
// production users, contests, standings or audit rows are created or altered.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('weekly settings, roster imports, attendance, full recomputation and permissions (isolated MySQL)', { timeout: 60000 }, () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/_weekly_ranklist.js'), 'utf8');
  const engine = fs.readFileSync(path.join(__dirname, '../libs/weekly-standings.js'), 'utf8');
  const code = async function () {
    const assert = require('assert').strict, fs = require('fs'), vm = require('vm');
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const t = require('typeorm'), c = require('/app/config/web.json').db, h = process.env.SYZOJ_WEB_DB_HOST || c.host;
    const connection = await t.createConnection({ type: 'mysql', host: h.split(':')[0], port: Number(h.split(':')[1] || 3306),
      username: process.env.SYZOJ_WEB_DB_USERNAME || c.username, password: process.env.SYZOJ_WEB_DB_PASSWORD || c.password, database: process.env.SYZOJ_WEB_DB_DATABASE || c.database });
    const runner = connection.createQueryRunner(); await runner.connect();
    try {
      const definitions = {
        user: 'id INT PRIMARY KEY,username VARCHAR(80)',
        user_registration_profile: 'user_id INT PRIMARY KEY,real_name VARCHAR(80),student_id VARCHAR(40),student_id_scope VARCHAR(40)',
        temporary_contest_account: 'user_id INT PRIMARY KEY',
        contest: 'id INT PRIMARY KEY,title VARCHAR(100),type VARCHAR(20),start_time INT,end_time INT,problems VARCHAR(100)',
        contest_player: 'id INT PRIMARY KEY,contest_id INT,user_id INT',
        contest_registration_removal: 'contest_id INT,user_id INT',
        judge_state: 'id INT PRIMARY KEY,type INT,type_info INT,user_id INT,problem_id INT,submit_time INT,status VARCHAR(30),score INT,pending INT',
        judge_state_admin_action: 'judge_id INT PRIMARY KEY,action_type VARCHAR(30)',
        class_group: 'id INT PRIMARY KEY,name VARCHAR(80),status VARCHAR(20)',
        class_group_member: 'class_id INT,user_id INT'
      };
      for (const [name, columns] of Object.entries(definitions)) await runner.query('CREATE TEMPORARY TABLE ' + name + ' (' + columns + ') ENGINE=InnoDB');
      await runner.query("INSERT INTO user VALUES (1,'A'),(2,'B'),(3,'C'),(4,'D'),(5,'Temporary')");
      await runner.query("INSERT INTO user_registration_profile VALUES (1,'甲','0000000001','ordinary'),(2,'乙','0000000002','ordinary'),(3,'丙','0000000003','ordinary'),(4,'丁','0000000004','ordinary')");
      await runner.query('INSERT INTO temporary_contest_account VALUES (5)');
      await runner.query("INSERT INTO contest VALUES (7,'第一场','acm',100,200,'11|12'),(8,'第二场','acm',300,400,'11|12'),(9,'未结束','acm',100,2147483647,'11|12'),(10,'IOI','ioi',100,200,'11|12')");
      await runner.query('INSERT INTO contest_player VALUES (1,7,1),(2,7,2),(3,7,3),(4,8,1),(5,8,2),(6,8,3),(7,9,1)');
      await runner.query("INSERT INTO judge_state VALUES (1,1,7,1,11,110,'Accepted',100,0),(2,1,7,1,12,120,'Accepted',100,0),(3,1,7,2,11,130,'Accepted',100,0),(4,1,7,3,11,105,'Accepted',100,0),(5,1,7,3,12,106,'Accepted',100,0),(6,1,8,1,11,310,'Accepted',100,0),(7,1,8,2,11,320,'Accepted',100,0),(8,1,9,1,11,120,'Accepted',100,0)");
      await runner.query("INSERT INTO class_group VALUES (1,'预备队','active')");
      await runner.query('INSERT INTO class_group_member VALUES (1,2),(1,3)');
      let queue = Promise.resolve();
      const manager = { query: (sql, values) => runner.query(sql.replace(/^CREATE TABLE IF NOT EXISTS weekly_/, 'CREATE TEMPORARY TABLE IF NOT EXISTS weekly_'), values) };
      const db = { query: manager.query, transaction: fn => {
        const work = queue.then(async () => { await runner.startTransaction(); try { const value = await fn(manager); await runner.commitTransaction(); return value; } catch (e) { await runner.rollbackTransaction(); throw e; } });
        queue = work.catch(() => {}); return work;
      } };
      const engineContext = { module: { exports: {} } }; vm.runInNewContext(input.engine, engineContext);
      const routes = new Map(), audit = [], logs = [];
      const etag = value => '"' + require('crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex') + '"';
      const api = { etagFor: etag, setResourceEtag: () => {}, send: (res, data) => ({ status: 200, data }), fail: (res, status, code, message) => ({ status, code, message }),
        ifMatch: (req, current) => { const tag = req.get('If-Match') || req.body.if_match; if (!tag) throw Object.assign(new Error('Missing version'), { statusCode: 428 }); return tag === etag(current); } };
      const context = { module: { exports: {} }, console, setInterval: () => ({ unref() {} }),
        app: { get: (url, handler) => routes.set('GET ' + url, handler), post: (url, handler) => routes.set('POST ' + url, handler) },
        syzoj: { log: value => logs.push(value), utils: { apiV2: api, authorizationV2: { recordAudit: async (_req, event) => audit.push(event) } } },
        require(name) {
          if (name === 'typeorm') return { getConnection: () => db };
          if (name === 'multer') return Object.assign(() => ({ single: () => (req, res, callback) => callback() }), { memoryStorage: () => ({}) });
          if (name === '../libs/weekly-standings') return engineContext.module.exports;
          if (name === '../libs/class-groups') return { ensureSchema: async () => {}, isUnrestricted: user => !!(user && (user.is_admin || user.id === 999)) };
          if (name === '../libs/registration-profile-schema') return { ensureRegistrationProfileSchema: async () => {}, ORDINARY_STUDENT_ID_SCOPE: 'ordinary' };
          if (name.startsWith('../libs/')) return require('/app/libs/' + name.slice(8));
          return require(name);
        }
      };
      vm.runInNewContext(input.source + '\nmodule.exports={ensureSchema,refresh};', context);
      await context.module.exports.ensureSchema();
      const admin = { id: 999 };
      async function call(method, suffix, body, user = admin, extra = {}) {
        const req = { body: body || {}, params: extra.params || {}, query: extra.query || {}, get: () => '', file: extra.file };
        const res = { locals: { user }, set() {}, status(status) { this.code = status; return this; }, render(view, data) { return { status: this.code || 200, view, data }; } };
        return routes.get(method + ' /api/v2/weekly-ranklist' + suffix)(req, res);
      }
      let board = (await call('GET', '')).data;
      assert.equal(board.rules.population, 'all');
      assert.equal(board.rules.count_absent, false);
      async function write(suffix, data, user = admin) {
        const result = await call('POST', suffix, { ...data, if_match: board.edit_etag }, user);
        if (result.status === 200) board = result.data;
        return result;
      }
      assert.equal((await write('/config', { title: 'bad' }, null)).status, 401);
      assert.equal((await write('/config', { title: 'bad' }, { id: 1, contest_admin: true })).status, 403);
      assert.equal((await write('/contests', { contest_ids: [10] })).status, 422);
      assert.equal((await write('/contests', { contest_ids: [7, 8, 9] })).status, 200);
      assert.equal((await write('/members', { user_ids: [1, 2] })).status, 200);
      assert.equal(board.member_count, 2); assert.equal(board.rows.find(r => r.user_id === 1).cells[0].score, 200);
      assert.equal(board.rows.find(r => r.user_id === 1).cells[0].total_problems, 2);
      assert.equal(board.rows.find(r => r.user_id === 1).cells.find(c => c.contest_id === 9).score, null);
      assert.equal((await write('/members/import-class', { class_ids: [1] })).status, 200);
      assert.equal(board.operation.added_count, 1); assert.equal(board.operation.existing_count, 1);
      assert.equal(board.member_count, 3); assert.equal(board.rows.find(r => r.user_id === 1).cells[0].rank, 2);
      assert.equal(board.rows.find(r => r.user_id === 1).cells[0].score, 400 / 3);
      assert.equal((await write('/members', { user_ids: [5] })).status, 422);
      const csv = await call('POST', '/members/import-csv', { if_match: board.edit_etag }, admin,
        { file: { originalname: 'students.csv', buffer: Buffer.from('学号\n0000000004\n9999999999\n') } });
      // Multer-style callback route returns the Promise from its handler.
      assert.equal(csv.status, 200, JSON.stringify(csv)); board = csv.data;
      assert.equal(board.member_count, 4); assert.equal(board.operation.missing_student_ids[0], '9999999999');
      const oldTag = board.edit_etag;
      assert.equal((await write('/attendance', { changes: [{ user_id: 1, contest_id: 7, onsite: true }] })).status, 200);
      assert.equal(board.rows.find(r => r.user_id === 1).cells[0].group, 'g1');
      assert.equal((await call('POST', '/members', { if_match: oldTag, user_ids: [1], remove: true })).status, 412);
      const publicBoard = (await call('GET', '', {}, null)).data;
      assert.equal('real_name' in publicBoard.rows[0], false); assert.equal('student_id' in publicBoard.rows[0], false);
      assert.ok(Math.abs(Date.now() - Date.parse(publicBoard.calculated_at)) < 5000, 'cached read preserves UTC calculation time');
      assert.equal(publicBoard.calculated_at, board.calculated_at, 'save and subsequent GET use identical timestamps');
      // A cheated-only round still counts as participation at zero points;
      // cancelled-only records do not turn a missing round into attendance.
      await runner.query("INSERT INTO judge_state_admin_action VALUES (7,'cheated')");
      await context.module.exports.refresh(true); board = (await call('GET', '')).data;
      let memberB = board.rows.find(r => r.user_id === 2);
      assert.equal(memberB.cells.find(c => c.contest_id === 8).score, 0);
      assert.equal(memberB.cells.find(c => c.contest_id === 8).participated, true);
      assert.equal(memberB.g2_count, 2);
      await runner.query("UPDATE judge_state_admin_action SET action_type='cancelled' WHERE judge_id=7");
      await context.module.exports.refresh(true); board = (await call('GET', '')).data;
      memberB = board.rows.find(r => r.user_id === 2);
      assert.equal(memberB.cells.find(c => c.contest_id === 8).participated, false);
      assert.equal(memberB.g2_count, 1);
      await runner.query('DELETE FROM judge_state_admin_action WHERE judge_id=7');
      await runner.query("UPDATE judge_state SET status='Wrong Answer',score=0 WHERE id=2");
      board = (await context.module.exports.refresh(true));
      const result = typeof board.result_json === 'string' ? JSON.parse(board.result_json) : board.result_json;
      assert.equal(result.rows.find(r => r.user_id === 1).cells[0].solved, 1);
      board = (await call('GET', '')).data;
      await write('/contests', { contest_ids: [7], remove: true });
      assert.equal(board.contests.length, 2); assert.equal((await runner.query('SELECT * FROM weekly_ranklist_attendance')).length, 0);
      const tag = board.edit_etag;
      const concurrent = await Promise.all([1, 2].map(id => call('POST', '/members', { if_match: tag, user_ids: [id], remove: true })));
      assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 412]);
      assert.ok(audit.length >= 7); assert.deepEqual(logs, []);
      console.log('PASS: member/contest changes, three import modes, version conflicts, onsite records, rejudge refresh, permissions, privacy and atomic mutations.');
    } finally { await runner.release(); await connection.close(); }
  };
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', '(' + code.toString() + ')().catch(e=>{console.error(e.stack);process.exit(1)})'],
    { cwd: path.join(__dirname, '../..'), input: JSON.stringify({ source, engine }), encoding: 'utf8', timeout: 55000 });
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
  console.log(result.stdout.trim());
});
