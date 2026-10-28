'use strict';

// Run inside the web container with NWPUOJ_RATING_ADMIN_DB_TEST=1. Every table
// written below is a connection-local TEMPORARY table, never production data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('Rating rollback and notification management use consistent SQL, permissions and pagination', {
  skip: process.env.NWPUOJ_RATING_ADMIN_DB_TEST !== '1'
}, async () => {
  const appRoot = process.env.NWPUOJ_APP_ROOT || '/app';
  const orm = require(path.join(appRoot, 'node_modules/typeorm'));
  const cfg = require(path.join(appRoot, 'config/web.json')).db;
  const host = process.env.SYZOJ_WEB_DB_HOST || cfg.host;
  const connection = await orm.createConnection({ type: 'mysql', host: host.split(':')[0], port: Number(host.split(':')[1] || 3306),
    username: process.env.SYZOJ_WEB_DB_USERNAME || cfg.username, password: process.env.SYZOJ_WEB_DB_PASSWORD || cfg.password,
    database: process.env.SYZOJ_WEB_DB_DATABASE || cfg.database });
  const runner = connection.createQueryRunner();
  await runner.connect();
  const manager = { query: (sql, args) => runner.query(sql, args) };
  const transaction = async fn => {
    await runner.startTransaction();
    try { const result = await fn(manager); await runner.commitTransaction(); return result; }
    catch (error) { await runner.rollbackTransaction(); throw error; }
  };
  try {
    const definitions = {
      user: 'id INT PRIMARY KEY, username VARCHAR(100), rating INT',
      contest: 'id INT PRIMARY KEY,title VARCHAR(255),start_time INT,end_time INT',
      contest_rating_config: 'contest_id INT PRIMARY KEY,is_rated TINYINT',
      contest_rating_finalization: 'contest_id INT PRIMARY KEY,rating_calculation_id INT,status VARCHAR(24),participant_count INT,completed_at INT,skip_reason TEXT',
      rating_calculation: 'id INT PRIMARY KEY,contest_id INT',
      rating_history: 'rating_calculation_id INT,user_id INT,rating_after INT',
      rating_notification_delivery: 'profile_id VARCHAR(32),contest_id INT,user_id INT,notification_id INT',
      rating_v2_job: 'id INT,profile_id VARCHAR(32),state VARCHAR(32)',
      rating_v2_event: 'id INT,profile_id VARCHAR(32),contest_id INT',
      rating_v2_current: 'profile_id VARCHAR(32),user_id INT',
      notification: 'id INT PRIMARY KEY,recipient_id INT,type VARCHAR(50),title VARCHAR(255),content TEXT,source_url VARCHAR(500),source_id INT,is_read TINYINT,created_at INT,read_at INT',
      site_notification: 'id INT PRIMARY KEY,title VARCHAR(255),content TEXT,status VARCHAR(20),audience VARCHAR(20),updated_at INT,published_at INT',
      api_v2_event: 'id INT PRIMARY KEY,payload_json TEXT'
    };
    for (const [table, columns] of Object.entries(definitions)) await runner.query(`CREATE TEMPORARY TABLE ${table} (${columns}) ENGINE=InnoDB`);
    const invalidated = [];
    const lockOrder = [];
    const mutation = {
      acquireContestLock: async id => { lockOrder.push(id); return async () => {}; },
      withTransactionRetry: transaction,
      mutationError: (message, statusCode) => Object.assign(new Error(message), { statusCode })
    };
    const context = { module: { exports: {} }, syzoj: { config: { default: { user: { rating: 1500 } } },
      model: () => ({ deleteFromCache: id => invalidated.push(id) }), utils: {} },
      require(name) {
        if (name === 'typeorm') return { getConnection: () => manager };
        if (name === './contest-mutation') return mutation;
        if (name === './rating') return {};
        if (name === './migration-cycle-evidence' || name === './rating-notification') return {};
        throw Error('Unexpected dependency: ' + name);
      }
    };
    vm.runInNewContext(fs.readFileSync(path.join(appRoot, 'libs/contest-rating.js'), 'utf8'), context);
    const rating = context.module.exports;
    await runner.query("INSERT INTO user VALUES (1,'First',1720),(2,'Second',1460),(3,'Third',1490)");
    await runner.query("INSERT INTO contest VALUES (10,'Earlier',1,100),(20,'Target',101,200),(30,'Later',201,300),(40,'Skipped',301,400)");
    await runner.query('INSERT INTO contest_rating_config VALUES (10,1),(20,1),(30,1),(40,1)');
    await runner.query("INSERT INTO contest_rating_finalization VALUES (10,1,'completed',2,100,NULL),(20,2,'completed',2,200,NULL),(30,3,'completed',2,300,NULL),(40,NULL,'skipped',1,400,NULL)");
    await runner.query('INSERT INTO rating_calculation VALUES (1,10),(2,20),(3,30)');
    await runner.query('INSERT INTO rating_history VALUES (1,1,1600),(2,1,1700),(2,2,1400),(3,1,1720),(3,2,1460)');
    await runner.query("INSERT INTO notification VALUES (1,1,'contest_rating','Earlier','Earlier','/contest/10/ranklist',10,1,100,105),(2,1,'contest_rating','Target','Rating 1600 → 1700','/contest/20/ranklist',20,0,200,NULL),(3,2,'contest_rating','Later','Rating 1400 → 1460','/contest/30/ranklist',30,1,300,310),(4,3,'username_length_policy','System','Change name','/user/3/edit',3,0,500,NULL),(5,1,'site_notification','Manual','Message','/notifications',1,1,600,610),(6,2,'contest_rating_ioi','IOI','Rating changed','javascript:alert(1)',50,0,700,NULL)");
    await runner.query("INSERT INTO rating_notification_delivery VALUES ('icpc',10,1,1),('icpc',20,1,2),('icpc',30,2,3)");
    await runner.query("INSERT INTO site_notification VALUES (1,'Manual','Message','published','all',600,600)");
    const options = { rollbackOnly: true, expectedCalculationIds: [3, 2], recordAudit: async (m, result) => {
      await m.query('INSERT INTO api_v2_event VALUES (1,?)', [JSON.stringify(result)]); return 1;
    } };
    await assert.rejects(rating.recalculateRatingsFrom(20, { ...options, expectedCalculationIds: [2] }), /结算记录已变化/);
    await runner.query('UPDATE user SET rating=1800 WHERE id=1');
    await assert.rejects(rating.recalculateRatingsFrom(20, options), /单独修改/);
    await runner.query('UPDATE user SET rating=1720 WHERE id=1');
    await runner.query("INSERT INTO rating_v2_job VALUES (1,'icpc','running')");
    await assert.rejects(rating.recalculateRatingsFrom(20, options), /重算任务/);
    await runner.query('DELETE FROM rating_v2_job');
    await assert.rejects(rating.recalculateRatingsFrom(20, { ...options, recordAudit: async () => { throw Error('audit unavailable'); } }), /audit unavailable/);
    assert.equal((await runner.query('SELECT COUNT(*) AS n FROM rating_calculation'))[0].n, '3');
    assert.equal((await runner.query('SELECT rating FROM user WHERE id=1'))[0].rating, 1720);
    const result = await rating.recalculateRatingsFrom(20, options);
    assert.equal(result.contestCount, 2);
    assert.deepEqual(Array.from(result.contestIds), [20, 30]);
    assert.deepEqual((await runner.query('SELECT rating FROM user ORDER BY id')).map(row => row.rating), [1600, 1500, 1490]);
    assert.deepEqual((await runner.query('SELECT id FROM rating_calculation')).map(row => row.id), [1]);
    assert.deepEqual((await runner.query('SELECT contest_id FROM contest_rating_finalization ORDER BY contest_id')).map(row => row.contest_id), [10, 40]);
    assert.deepEqual((await runner.query('SELECT id FROM notification ORDER BY id')).map(row => row.id), [1, 4, 5, 6]);
    assert.equal((await runner.query('SELECT COUNT(*) AS n FROM rating_notification_delivery'))[0].n, '1');
    assert.equal((await runner.query('SELECT COUNT(*) AS n FROM api_v2_event'))[0].n, '1');
    assert.deepEqual(invalidated.sort(), [1, 2]);
    assert.equal(lockOrder[0], 'rating-finalizer');
    await assert.rejects(rating.recalculateRatingsFrom(20, options), /结算记录已变化/);
    const statuses = await rating.listContestRatingStatuses();
    assert.equal(statuses.find(row => row.id === 20).state, 'pending');
    assert.equal(statuses.find(row => row.id === 10).calculationId, 1);

    const routes = new Map();
    const api = { etagFor: JSON.stringify, send: (res, body) => body, fail: (res, status, code) => ({ status, code }) };
    const notificationContext = { Buffer, setInterval: () => ({ unref() {} }), app: Object.fromEntries(['get','post','patch','delete'].map(method => [method, (url, fn) => routes.set(method + ' ' + url, fn)])),
      ErrorMessage: Error, syzoj: { log() {}, utils: { apiV2: api, paginate: (total, page, size) => ({ currPage: Math.min(Math.max(1, parseInt(page) || 1), Math.ceil(total / size)), pageCnt: Math.ceil(total / size) }) } },
      require: name => { assert.equal(name, 'typeorm'); return { getConnection: () => manager }; }
    };
    vm.createContext(notificationContext);
    const notificationSource = fs.readFileSync(path.join(appRoot, 'modules/_admin_notifications.js'), 'utf8')
      .replace('setInterval(publishDue,30000);publishDue();', '');
    vm.runInContext(notificationSource + '\nschemaPromise = Promise.resolve();', notificationContext);
    const list = notificationContext.listAdminNotifications;
    const all = await list();
    assert.equal(all.totalCount, 4, 'manual deliveries are not duplicated');
    assert.equal(all.notifications[0].notification_type, 'contest_rating_ioi');
    assert.equal(all.notifications[0].source_url, null, 'unsafe source links are not exposed');
    assert.equal((await list({ filter: 'system' })).totalCount, 3);
    assert.equal((await list({ filter: 'rating' })).totalCount, 2);
    const manual = (await list({ filter: 'manual' })).notifications[0];
    assert.equal(manual.read_count, 1);
    assert.equal(manual.etag, JSON.stringify(notificationContext.resource((await runner.query('SELECT * FROM site_notification'))[0])));
    for (let i = 0; i < 60; i++) await runner.query("INSERT INTO notification (id,recipient_id,type,title,created_at,is_read) VALUES (?,1,'future_system_type','future',800,0)", [100 + i]);
    const first = await list({ filter: 'system' }), second = await list({ filter: 'system', page: 2 });
    assert.equal(first.notifications.length, 50);
    assert.equal(second.notifications.length, 13);
    assert.equal(new Set([...first.notifications, ...second.notifications].map(row => row.id)).size, 63);
    const res = { locals: { user: { id: 3, is_admin: false } } };
    assert.equal((await routes.get('get /api/v2/admin/notifications')({ query: {} }, res)).status, 403);
    await runner.query('DELETE FROM site_notification');
    assert.equal((await list({ filter: 'manual' })).notifications.length, 0, 'empty filters do not produce a negative SQL offset');
    assert.equal((await runner.query('SELECT is_read FROM notification WHERE id=4'))[0].is_read, 0);
  } finally { await runner.release(); await connection.close(); }
});
