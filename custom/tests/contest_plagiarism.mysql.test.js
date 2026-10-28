'use strict';

// Isolated temporary tables shadow every production table used by these routes.
// Run in the web container with NWPUOJ_PLAGIARISM_DB_TEST=1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const vm = require('vm');

test('contest plagiarism queue, authorization, replay, report and restart behavior with real SQL', {
  skip: process.env.NWPUOJ_PLAGIARISM_DB_TEST !== '1', timeout: 90000
}, async () => {
  const appRoot = process.env.NWPUOJ_APP_ROOT || '/app';
  const orm = require(path.join(appRoot, 'node_modules/typeorm'));
  const config = require(path.join(appRoot, 'config/web.json')).db;
  const host = process.env.SYZOJ_WEB_DB_HOST || config.host;
  const connection = await orm.createConnection({ type: 'mysql', host: host.split(':')[0], port: Number(host.split(':')[1] || 3306),
    username: process.env.SYZOJ_WEB_DB_USERNAME || config.username, password: process.env.SYZOJ_WEB_DB_PASSWORD || config.password,
    database: process.env.SYZOJ_WEB_DB_DATABASE || config.database });
  const runner = connection.createQueryRunner(); await runner.connect();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noj-plagiarism-routes-test-'));
  const manager = { query: (sql, params) => runner.query(sql, params) };
  let queue = Promise.resolve();
  const db = { query: (sql, params) => sql.startsWith('CREATE TABLE IF NOT EXISTS contest_plagiarism_job') ? Promise.resolve([]) : manager.query(sql, params), createQueryRunner: () => ({ connect: async () => {}, query: manager.query, release: async () => {} }),
    transaction: fn => {
      const transaction = queue.then(async () => {
        await runner.startTransaction();
        try { const result = await fn(manager); await runner.commitTransaction(); return result; }
        catch (e) { await runner.rollbackTransaction(); throw e; }
      });
      queue = transaction.catch(() => {}); return transaction;
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '../modules/_contest_plagiarism.js'), 'utf8');
  const table = source.match(/CREATE TABLE IF NOT EXISTS contest_plagiarism_job \([\s\S]*?DEFAULT CHARSET=utf8mb4/)[0]
    .replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMPORARY TABLE').replace(/,\n    CONSTRAINT fk_plagiarism_contest[\s\S]*?ON DELETE SET NULL/, '');
  try {
    for (const [name, definition] of Object.entries({
      contest: 'id INT PRIMARY KEY,holder_id INT,start_time INT,end_time INT,title TEXT',
      user: 'id INT PRIMARY KEY,username TEXT',
      problem: 'id INT PRIMARY KEY,type VARCHAR(32),title TEXT',
      judge_state: 'id INT PRIMARY KEY,user_id INT,problem_id INT,language VARCHAR(32),code MEDIUMTEXT,status VARCHAR(32),submit_time INT,type INT,type_info INT',
      submission_v2_code_version: 'submission_id INT PRIMARY KEY,source_code MEDIUMTEXT',
      plagiarism_test_audit: 'job_id INT PRIMARY KEY'
    })) await runner.query(`CREATE TEMPORARY TABLE ${name} (${definition}) ENGINE=InnoDB`);
    await runner.query(table);
    await runner.query("INSERT INTO contest VALUES (10,1,100,200,'Fixture'),(11,2,100,200,'Other'),(12,1,100,2147483647,'Running')");
    await runner.query("INSERT INTO user VALUES (1,'Manager'),(2,'甲'),(3,'乙')");
    await runner.query("INSERT INTO problem VALUES (20,'traditional','Sort')");
    const code = '#include <stdio.h>\nint main(){int n;scanf("%d",&n);int a[1000];for(int i=0;i<n;i++)scanf("%d",&a[i]);for(int i=0;i<n;i++)for(int j=0;j+1<n-i;j++)if(a[j]>a[j+1]){int t=a[j];a[j]=a[j+1];a[j+1]=t;}for(int i=0;i<n;i++)printf("%d ",a[i]);return 0;}';
    await runner.query('INSERT INTO judge_state VALUES (1,2,20,?,?,?,150,1,10),(2,3,20,?,?,?,151,1,10),(3,3,20,?,?,?,201,1,10)',
      ['c', code, 'Accepted', 'cpp23', code, 'Accepted', 'cpp23', code, 'Accepted']);
    const routes = new Map(), errors = [];
    const engine = require('../libs/contest-plagiarism');
    const runtimeRoot = process.env.NWPUOJ_JPLAG_RUNTIME || '/opt/jplag';
    const context = { module: { exports: {} }, setInterval: () => ({ unref() {} }), setImmediate: () => {},
      app: { get: (url, fn) => routes.set('GET ' + url, fn), post: (url, fn) => routes.set('POST ' + url, fn) },
      syzoj: { config: {}, log: message => errors.push(message), model: () => ({ findById: async id => {
        const row = (await runner.query('SELECT * FROM contest WHERE id=?', [id]))[0];
        return row && Object.assign(row, { isSupervisior: async user => !!user && (user.admin || Number(row.holder_id) === user.id || user.contests && user.contests.includes(id)) });
      } }), utils: { apiV2: { ensureFoundationSchema: async () => {}, send: (res, data, status = 200) => ({ status, data }), fail: (res, status, code, message) => ({ status, code, message }) },
        authorizationV2: { recordAudit: async (req, event, manager) => manager.query('INSERT INTO plagiarism_test_audit VALUES (?)', [event.details.job_id]) } } },
      require(name) {
        if (name === 'typeorm') return { getConnection: () => db };
        if (name === '../libs/contest-plagiarism') return { ...engine, runtimeAvailable: () => engine.runtimeAvailable(runtimeRoot),
          analyzeGroup: (group, directory) => engine.analyzeGroup(group, directory, runtimeRoot) };
        return require(name);
      }
    };
    vm.runInNewContext(source.replace("const ROOT = '/app/private-plagiarism';", 'const ROOT = ' + JSON.stringify(root) + ';')
      // Avoid touching the production worker lock, even on the isolated DB connection.
      .replaceAll('nwpuoj:plagiarism-worker', 'nwpuoj:plagiarism-test-' + process.pid)
      .replace('ensureSchema().then(() => tick()).catch', 'ensureSchema().catch') + '\nmodule.exports={tick,ensureSchema};', context);
    await context.module.exports.ensureSchema();
    async function call(method, suffix, { user = { id: 1 }, id = 10, jobId, body = {}, query = {}, group } = {}) {
      const req = { params: { id, jobId, group }, body, query };
      const res = { locals: { user }, set: () => {}, status(code) { this.code = code; return this; },
        render(view, data) { return { status: this.code || 200, view, data }; }, download(file, filename) { return { file, filename }; } };
      return routes.get(method + ' ' + suffix)(req, res);
    }
    const endpoint = '/api/v2/contests/:id/plagiarism';
    for (const key of routes.keys()) {
      const space = key.indexOf(' '), method = key.slice(0, space), route = key.slice(space + 1);
      const result = await call(method, route, { user: null, jobId: 1, group: 'p20-cpp' });
      assert.equal(result.status, 401, key);
      const denied = await call(method, route, { user: { id: 7 }, jobId: 1, group: 'p20-cpp' });
      assert.equal(denied.status, 403, key);
    }
    assert.equal((await call('GET', endpoint, { user: { id: 5, contests: [10] } })).status, 200);
    assert.equal((await call('GET', endpoint, { user: { id: 5, admin: true } })).status, 200);
    assert.equal((await call('POST', endpoint, { id: 12, body: { request_token: 'request-token-12345' } })).code, 'CONTEST_NOT_ENDED');
    const first = await call('POST', endpoint, { body: { request_token: 'request-token-12345' } });
    assert.equal(first.status, 202);
    const id = first.data.id;
    const [duplicate, concurrent] = await Promise.all([
      call('POST', endpoint, { body: { request_token: 'request-token-12345' } }),
      call('POST', endpoint, { body: { request_token: 'different-token-67890' } })
    ]);
    assert.equal(duplicate.data.id, id); assert.equal(concurrent.data.id, id);
    assert.equal(Number((await runner.query('SELECT COUNT(*) AS n FROM plagiarism_test_audit'))[0].n), 1);
    assert.equal((await call('GET', endpoint + '/:jobId', { user: { id: 5, admin: true }, id: 11, jobId: id })).status, 404);
    await context.module.exports.tick();
    const result = await call('GET', endpoint + '/:jobId', { jobId: id });
    assert.equal(result.data.state, 'completed', JSON.stringify(result));
    assert.equal(result.data.summary.total, 2);
    assert.equal(result.data.total, 1);
    const pair = result.data.pairs[0];
    assert.ok(pair.similarity > 0.95);
    const comparison = await call('GET', endpoint + '/:jobId/comparison', { jobId: id, query: { key: pair.key } });
    assert.equal(comparison.data.first.code, code);
    assert.ok(comparison.data.matches.length);
    assert.equal((await call('GET', endpoint + '/:jobId/comparison', { jobId: id, query: { key: '../../etc/passwd' } })).status, 404);
    assert.equal((await call('GET', '/contest/:id/plagiarism/:jobId/report/:group', { jobId: id, group: '../' })).status, 404);
    const report = await call('GET', '/contest/:id/plagiarism/:jobId/report/:group', { jobId: id, group: pair.group });
    assert.ok(report.file.startsWith(root)); assert.ok(await fs.pathExists(report.file));
    const reportRoute = '/contest/:id/plagiarism/:jobId/report/:group';
    const webOptions = { jobId: id, group: pair.group, query: { format: 'html' } };
    assert.equal((await call('GET', reportRoute, { ...webOptions, user: { id: 7 } })).status, 403);
    assert.equal((await call('GET', reportRoute, { ...webOptions, user: null })).status, 401);
    assert.equal((await call('GET', reportRoute, { ...webOptions, id: 11, user: { id: 5, admin: true } })).status, 404);
    assert.equal((await call('GET', reportRoute, { ...webOptions, group: '../' })).status, 404);
    assert.equal((await call('GET', reportRoute, { ...webOptions, query: { format: 'invalid' } })).status, 422);
    const [webReport, duplicateReport] = await Promise.all([call('GET', reportRoute, webOptions), call('GET', reportRoute, webOptions)]);
    assert.match(webReport.filename, /\.html$/); assert.equal(duplicateReport.file, webReport.file);
    const html = await fs.readFile(webReport.file, 'utf8');
    assert.match(html, /无需安装 JPlag/); assert.match(html, /report-data/);
    const embedded = JSON.parse(html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    assert.equal(embedded.pairs.length, 1); assert.equal(embedded.submissions[1].code, code);
    assert.ok(embedded.pairs[0].matches[0].every(Number.isInteger));
    // Cached reports still require current permission on every download.
    assert.equal((await call('GET', reportRoute, { ...webOptions, user: { id: 7 } })).status, 403);
    // A later request is a new historical job; old completed results remain.
    const second = await call('POST', endpoint, { body: { request_token: 'another-token-12345' } });
    assert.notEqual(second.data.id, id);
    await runner.query("UPDATE contest_plagiarism_job SET state='running' WHERE id=?", [second.data.id]);
    await context.module.exports.tick();
    const interrupted = await call('GET', endpoint + '/:jobId', { jobId: second.data.id });
    assert.equal(interrupted.data.state, 'failed'); assert.match(interrupted.data.summary.message, /中断/);
    assert.equal((await call('GET', endpoint)).data.items.length, 2);
    assert.equal((await call('GET', endpoint + '/:jobId', { jobId: id })).data.state, 'completed');
    assert.deepEqual(errors, []);
  } finally { await runner.release(); await connection.close(); await fs.remove(root); }
});
