'use strict';
// All writes use connection-local TEMPORARY tables, never real OJ records.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

test('CF reset, chronological settlement, job preview/apply/rollback agree in MySQL', {
  skip: process.env.NWPUOJ_CF_DB_TEST !== '1'
}, async () => {
  const root = process.env.NWPUOJ_APP_ROOT || '/app';
  const orm = require(path.join(root, 'node_modules/typeorm'));
  const cfg = require(path.join(root, 'config/web.json')).db;
  const host = process.env.SYZOJ_WEB_DB_HOST || cfg.host;
  const connection = await orm.createConnection({ type: 'mysql', host: host.split(':')[0], port: Number(host.split(':')[1] || 3306),
    username: process.env.SYZOJ_WEB_DB_USERNAME || cfg.username, password: process.env.SYZOJ_WEB_DB_PASSWORD || cfg.password,
    database: process.env.SYZOJ_WEB_DB_DATABASE || cfg.database });
  const runner = connection.createQueryRunner(); await runner.connect();
  const manager = runner.manager;
  const transaction = async work => {
    await runner.startTransaction();
    try { const result = await work(manager); await runner.commitTransaction(); return result; }
    catch (error) { await runner.rollbackTransaction(); throw error; }
  };
  try {
    const definitions = {
      user: 'id INT PRIMARY KEY,username VARCHAR(80),rating INT,is_admin TINYINT DEFAULT 0',
      contest: 'id INT PRIMARY KEY,title VARCHAR(200),type VARCHAR(10),start_time INT,end_time INT,holder_id INT,admins TEXT,ranklist_id INT',
      contest_player: 'id INT PRIMARY KEY,contest_id INT,user_id INT,score_details TEXT',
      contest_ranklist: 'id INT PRIMARY KEY,ranking_params TEXT',
      contest_registration_removal: 'contest_id INT,user_id INT',
      judge_state: 'id INT PRIMARY KEY,type INT,type_info INT,submit_time INT,pending INT,status VARCHAR(40),user_id INT',
      judge_state_admin_action: 'judge_id INT,action_type VARCHAR(40)',
      contest_rating_config: 'contest_id INT PRIMARY KEY,is_rated TINYINT',
      rating_calculation: 'id INT PRIMARY KEY AUTO_INCREMENT,contest_id INT',
      rating_history: 'rating_calculation_id INT,user_id INT,rating_after INT,rank INT',
      contest_rating_finalization: 'contest_id INT PRIMARY KEY,rating_calculation_id INT,status VARCHAR(40),participant_count INT,algorithm_version INT,completed_at INT,skip_reason TEXT',
      site_config_v2_override: 'field_name VARCHAR(80) PRIMARY KEY,value_json TEXT,updated_by INT,updated_at DATETIME(3)',
      notification: 'id INT PRIMARY KEY,type VARCHAR(60)',
      rating_notification_delivery: 'profile_id VARCHAR(32),contest_id INT,user_id INT'
    };
    for (const [table, columns] of Object.entries(definitions)) await manager.query(`CREATE TEMPORARY TABLE ${table} (${columns}) ENGINE=InnoDB`);
    for (const table of ['rating_v2_profile', 'rating_v2_event', 'rating_v2_current', 'rating_v2_preview', 'rating_v2_job', 'rating_v2_contest_override', 'auth_audit_event']) { const schema = (await manager.query(`SHOW CREATE TABLE ${table}`))[0]['Create Table']; await manager.query(schema.replace(/^CREATE TABLE/, 'CREATE TEMPORARY TABLE')); }
    global.syzoj = { config: { default: { user: { rating: 0 } } }, utils: { baseWorkspace: { contains: async () => false } }, model: () => ({ deleteFromCache() {} }) };
    const reset = require(process.env.NWPUOJ_CF_RESET_SCRIPT || '../scripts/reset-codeforces-rating');
    const rating = require(path.join(root, 'libs/contest-rating'));
    await manager.query("INSERT INTO user (id,username,rating) VALUES (1,'a',1800),(2,'b',1600),(3,'unrated',1500)");
    await manager.query("INSERT INTO contest VALUES (10,'Earlier','acm',100,200,99,'',10),(11,'Single','acm',201,300,99,'',11),(12,'Later','acm',301,400,99,'',12)");
    await manager.query('INSERT INTO contest_rating_config VALUES (10,1),(11,1),(12,1)');
    await manager.query("INSERT INTO contest_ranklist VALUES (10,'{}'),(11,'{}'),(12,'{}')");
    await manager.query("INSERT INTO contest_player VALUES (1,10,1,?), (2,10,2,'{}'), (3,11,1,'{}'), (4,12,1,'{}'), (5,12,2,?)", [JSON.stringify({ 1: { accepted: true, acceptedTime: 120 } }), JSON.stringify({ 1: { accepted: true, acceptedTime: 320 } })]);
    await manager.query("INSERT INTO judge_state VALUES (1,1,10,120,0,'Accepted',1),(2,1,10,125,0,'Wrong Answer',2),(3,1,11,220,0,'Wrong Answer',1),(4,1,12,320,0,'Wrong Answer',1),(5,1,12,320,0,'Accepted',2)");
    await manager.query("INSERT INTO rating_v2_profile VALUES ('icpc','ACM','glicko2',1,'{}',1,NOW(),NOW())");
    await manager.query("INSERT INTO notification VALUES (1,'contest_rating'),(2,'message')");
    await manager.query("UPDATE judge_state SET pending=1 WHERE id=1");
    await assert.rejects(reset.readInput(manager, rating.canonicalStandings), /pending/);
    await manager.query('UPDATE judge_state SET pending=0 WHERE id=1');
    const input = await reset.readInput(manager, rating.canonicalStandings);
    const result = reset.replay(input);
    assert.equal(result.periods[1].changes.length, 0);
    assert.equal(result.periods[2].changes[0].ratedContestsBefore, 1);
    await assert.rejects(transaction(async m => { await reset.writeReplay(m, input, result, 1); throw new Error('injected failure'); }), /injected failure/);
    assert.deepEqual((await manager.query('SELECT rating FROM user ORDER BY id')).map(row => row.rating), [1800, 1600, 1500]);
    await transaction(m => reset.writeReplay(m, input, result, 1));
    assert.deepEqual((await manager.query('SELECT id,rating FROM user ORDER BY id')).map(row => ({ ...row })), result.ratings);
    assert.equal((await manager.query('SELECT rating FROM user WHERE id=3'))[0].rating, 0);
    assert.equal((await manager.query('SELECT value_json FROM site_config_v2_override'))[0].value_json, '0');
    assert.deepEqual((await manager.query('SELECT id FROM notification')).map(row => row.id), [2]);
    const replayAgain = reset.replay(await reset.readInput(manager, rating.canonicalStandings));
    assert.deepEqual(replayAgain, result);
    await manager.query("DELETE FROM contest_rating_finalization WHERE contest_id=12");
    await manager.query('DELETE h FROM rating_history h JOIN rating_calculation rc ON rc.id=h.rating_calculation_id WHERE rc.contest_id=12');
    await manager.query('DELETE FROM rating_calculation WHERE contest_id=12');
    for (const change of result.periods[0].changes) await manager.query('UPDATE user SET rating=? WHERE id=?', [change.ratingAfter, change.userId]);
    await transaction(m => rating.finalizeContestInTransaction(m, 12, { suppressNotifications: true }));
    assert.deepEqual((await manager.query('SELECT id,rating FROM user ORDER BY id')).map(row => ({ ...row })), result.ratings);

    const routes = new Map();
    const api = { appendEvent: async () => {}, databaseIso: value => value, send: (_res, value) => value, fail: (_res, _status, code, message) => { throw new Error(code + ': ' + message); } };
    const notifications = { ensureSchema: async () => {}, removeRatingChangeNotification: async () => ({ removed: false }), upsertRatingChangeNotification: async () => ({ deduplicated: true }), restoreRatingChangeNotification: async () => {} };
    syzoj.utils.apiV2 = api;
    syzoj.utils.operationReason = () => 'test';
    syzoj.utils.authorizationV2 = { authorize: async () => true, recentLoginSatisfied: () => true, recordAudit: async () => 1 };
    const context = { syzoj, app: Object.fromEntries(['get', 'post'].map(method => [method, (route, handler) => routes.set(String(route), handler)])),
      require(name) { if (name === 'typeorm') return { getConnection: () => ({ query: manager.query.bind(manager), manager, transaction }) }; if (name === '../libs/rating-notification') return notifications; return name.startsWith('../libs/') ? require(path.join(root, name.slice(3))) : require(name); }, setTimeout() {}, setImmediate() {} };
    const source = fs.readFileSync(path.join(root, 'modules/_api_v2_rating_domain.js'), 'utf8');
    vm.runInNewContext(source.slice(0, source.lastIndexOf('ensureRatingV2Schema().then')), context);
    const job = { id: 'fixture-cf', profile_id: 'icpc', from_contest_id: 10 };
    await manager.query("INSERT INTO rating_v2_job (id,kind,profile_id,from_contest_id,state,stage,actor_id,approved_by,reason,created_at,updated_at) VALUES (?,'recalculate','icpc',10,'running','previewing',1,1,'test',NOW(),NOW())", [job.id]);
    await context.buildRatingJobPreview(job);
    let diff = JSON.parse((await manager.query('SELECT diff_json FROM rating_v2_job'))[0].diff_json);
    assert.equal(diff.contests.length, 2);
    assert.equal(diff.changed_users, 0, 'job replay must reproduce legacy settlement exactly');
    await manager.query("INSERT INTO contest_registration_removal VALUES (10,1)");
    await assert.rejects(context.applyRatingJob(job), /standings changed/);
    await context.buildRatingJobPreview(job);
    await context.applyRatingJob(job);
    assert.equal((await manager.query('SELECT COUNT(*) n FROM rating_history h JOIN rating_calculation rc ON rc.id=h.rating_calculation_id WHERE rc.contest_id=10'))[0].n, '0');
    await routes.get('/api/v2/rating/jobs/:id/rollback')({ params: { id: job.id }, body: {} }, { locals: { user: { id: 1 } } });
    assert.deepEqual((await manager.query('SELECT id,rating FROM user ORDER BY id')).map(row => ({ ...row })), result.ratings);
    assert.equal((await manager.query('SELECT COUNT(*) n FROM rating_history'))[0].n, '4');
  } finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); await connection.close(); }
});
