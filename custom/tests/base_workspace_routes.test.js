'use strict';
// Execute the real route handlers against isolated transactional fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../modules/_base_workspace.js'), 'utf8');

function harness() {
  const routes = new Map(), members = new Set([2]), audits = [], revoked = [], migrations = [], queries = [];
  let failAudit = false;
  const ordinary = new Set([2, 3, 4, 5]);
  const db = { async query(sql, args) {
    queries.push([sql, args]);
    if (sql.startsWith('SELECT COUNT(*) AS total FROM base_workspace_problem')) return [{ total: 1 }];
    if (sql.startsWith('SELECT p.id,COALESCE(')) return [{ id: 12, title: 'A + B', user_id: 2, is_public: 1, username: '成员甲' }];
    if (sql.startsWith('SELECT map.problem_id,tag.name FROM problem_tag_map')) return [{ problem_id: 12, name: '动态规划' }];
    if (sql.startsWith('SELECT id,name FROM problem_tag')) return [{ id: 7, name: '动态规划' }];
    if (sql.startsWith('SELECT u.id FROM user')) return args[0].filter(id => ordinary.has(id)).map(id => ({ id }));
    if (sql.startsWith('INSERT IGNORE')) { const present = members.has(args[0]); members.add(args[0]); return { affectedRows: present ? 0 : 1 }; }
    if (sql.startsWith('DELETE FROM base_workspace_member')) { let count = 0; args[0].forEach(id => { count += members.delete(id) ? 1 : 0; }); return { affectedRows: count }; }
    if (sql.startsWith('SELECT id FROM class_group')) return args[0].filter(id => [10, 11].includes(id)).map(id => ({ id }));
    if (sql.startsWith('SELECT DISTINCT user_id')) return [{ user_id: 2 }, { user_id: 3 }, { user_id: 99 }];
    if (sql.startsWith('SELECT u.id,p.student_id')) return [{ id: 3, student_id: '2026000003' }, { id: 4, student_id: '2026000004' }, { id: 5, student_id: '2026000004' }];
    throw Error(sql);
  }, async transaction(fn) {
    const before = [...members];
    try { return await fn(db); } catch (e) { members.clear(); before.forEach(id => members.add(id)); throw e; }
  } };
  const multer = () => ({ single: () => (_req, _res, next) => next() }); multer.memoryStorage = () => ({});
  const context = { ErrorMessage: Error, app: {}, syzoj: { utils: {
    problemV2: { ensureSchema: async () => {} },
    apiV2: { send: (res, data) => { res.data = data; }, fail: (res, status, code, message) => { res.statusCode = status; res.error = { code, message }; } },
    authorizationV2: { recordAudit: async (_req, value, manager) => { assert.equal(manager, db); if (failAudit) throw Error('audit unavailable'); audits.push(value); } }
  } }, require(name) {
    if (name === 'typeorm') return { getConnection: () => db };
    if (name === 'multer') return multer;
    if (name === '../libs/base-workspace') return { isAdmin: user => !!user && user.id === 1, ensureSchema: async () => {}, contains: async (kind, id) => kind === 'problem' && id === 12, migrationStates: async () => new Map([[12, { problem_id: 22 }]]), revokeConnections: ids => revoked.push(...ids), csvEntries: () => [
      { row: 2, student_id: '2026000003', reason: null }, { row: 3, student_id: '2026000004', reason: null },
      { row: 4, student_id: '2026000006', reason: null }, { row: 5, student_id: 'invalid', reason: '学号必须为 10 位数字' }
    ] };
    if (name === '../libs/base-problem-migration') return { migrate: async (id, user) => { migrations.push({ id, user: user.id }); return { source_problem_id: id, problem_id: 22, skipped: false }; } };
    if (name === '../libs/class-groups') return { ensureSchema: async () => {} };
    if (name === '../libs/registration-profile-schema') return { ensureRegistrationProfileSchema: async () => {}, ORDINARY_STUDENT_ID_SCOPE: 'ordinary' };
    throw Error(name);
  } };
  for (const method of ['get', 'post']) context.app[method] = (route, ...handlers) => { for (const item of Array.isArray(route) ? route : [route]) routes.set(method + ' ' + item, handlers); };
  vm.runInNewContext(source, context);
  async function call(route, body = {}, user = { id: 1 }, file = null) {
    return callRoute('post /api/v2/base/members' + route, body, user, file);
  }
  async function callRoute(route, body = {}, user = { id: 1 }, file = null, params = {}) {
    const res = { locals: { user }, render(view, values) { this.view = view; this.values = values; } }, req = { body, file, res, query: {}, params, path: route.slice(route.indexOf(' ') + 1) };
    const handlers = routes.get(route);
    async function step(i, error) { if (error) throw error; if (!handlers[i]) return; let pending; await handlers[i](req, res, e => { pending = step(i + 1, e); return pending; }); if (pending) await pending; }
    await step(0);
    return res;
  }
  return { call, callRoute, members, audits, revoked, migrations, queries, setFailAudit: () => { failAudit = true; } };
}

test('base problem list loads labels for visible rows in one query', async () => {
  const f = harness();
  const res = await f.callRoute('get /base/problems', {}, { id: 2 });
  assert.equal(res.view, 'base_workspace');
  assert.equal(res.values.rows[0].tags[0].name, '动态规划');
  const tagQueries = f.queries.filter(([sql]) => sql.startsWith('SELECT map.problem_id,tag.name FROM problem_tag_map'));
  assert.equal(tagQueries.length, 1);
  assert.deepEqual(Array.from(tagQueries[0][1][0]), [12]);
});

test('migration and migration status routes require site administration before service access', async () => {
  const f = harness();
  for (const user of [null, { id: 2 }, { id: 9, privileges: ['manage_problem'] }]) {
    for (const route of ['post /api/v2/base/problems/:id/migrate', 'get /api/v2/base/problems/:id/migration']) {
      const res = await f.callRoute(route, {}, user, null, { id: '12' });
      assert.equal(res.statusCode, 403);
    }
  }
  assert.equal(f.migrations.length, 0);
  const migrated = await f.callRoute('post /api/v2/base/problems/:id/migrate', {}, { id: 1 }, null, { id: '12' });
  assert.equal(migrated.data.problem_id, 22);
  const state = await f.callRoute('get /api/v2/base/problems/:id/migration', {}, { id: 1 }, null, { id: '12' });
  assert.equal(state.data.migration.problem_id, 22);
  const missing = await f.callRoute('get /api/v2/base/problems/:id/migration', {}, { id: 1 }, null, { id: '99' });
  assert.equal(missing.statusCode, 404);
});

test('real member handlers deny ordinary members and unrelated user managers', async () => {
  const f = harness();
  for (const user of [null, { id: 2 }, { id: 9, privileges: ['manage_user'] }]) {
    for (const route of ['', '/import-classes', '/import-csv', '/remove']) assert.equal((await f.call(route, { user_ids: [3] }, user)).statusCode, 403);
  }
  assert.deepEqual([...f.members], [2]); assert.equal(f.audits.length, 0);
});

test('manual and class imports deduplicate, validate ordinary accounts, and return per-operation counts', async () => {
  const f = harness();
  const first = await f.call('', { user_ids: [2, 3, 3, 99] });
  assert.equal(first.data.added, 1); assert.equal(first.data.skipped, 1); assert.deepEqual(Array.from(first.data.invalid), [99]);
  const again = await f.call('/import-classes', { class_ids: [10, 11] });
  assert.equal(again.data.added, 0); assert.equal(again.data.skipped, 2);
  assert.equal((await f.call('/import-classes', { class_ids: [999] })).error.code, 'CLASS_NOT_FOUND');
  await assert.rejects(f.call('', { user_ids: [0] }), /有效/);
  assert.equal(f.audits.length, 2);
});

test('CSV imports valid matches and reports ambiguous, unmatched and invalid rows', async () => {
  const f = harness();
  assert.equal((await f.call('/import-csv')).error.code, 'CSV_INVALID');
  const res = await f.call('/import-csv', {}, { id: 1 }, { originalname: 'members.csv', buffer: Buffer.alloc(0) });
  assert.equal(res.data.added, 1); assert.equal(res.data.errors.length, 3);
  assert.match(res.data.errors[0].reason, /多个/); assert.match(res.data.errors[1].reason, /没有匹配/);
  assert.deepEqual([...f.members], [2, 3]);
});

test('member removal audits, revokes streams, and rolls back when audit storage fails', async () => {
  const f = harness();
  f.setFailAudit();
  await assert.rejects(f.call('/remove', { user_ids: [2] }), /audit unavailable/);
  assert.ok(f.members.has(2)); assert.deepEqual(f.revoked, []);
  const valid = harness(); const res = await valid.call('/remove', { user_ids: [2, 99] });
  assert.equal(res.data.removed, 1); assert.deepEqual(valid.revoked, [2, 99]); assert.equal(valid.audits[0].action, 'base:members.remove');
});
