'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { isValidManagedTemporaryUsername } = require('../libs/contest-temp-accounts');
const { validSignature } = require('../libs/user-signature');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

// Run the actual managed-user routes against an isolated transaction fixture.
// No test edits an account or creates a session on the live site.
function managedUserHarness(options = {}) {
  const source = read('custom/modules/_api_v2_admin_domain.js');
  const temporary = options.temporary !== false;
  const target = { id: 20, username: 'original', email: temporary ? null : 'fixture@example.test', sex: '0', ...options.target };
  const profile = { student_id: '2026000001', real_name: '测试用户', college: 'CSV 原学院' };
  const writes = [], events = [], invalidations = [], routes = new Map();
  const db = { async query(sql, params) {
    if (sql.startsWith('SELECT id,username,email,password')) return [{ ...target }];
    if (sql.startsWith('SELECT student_id,real_name,college')) return [{ ...profile }];
    if (sql.startsWith('SELECT privilege')) return [];
    if (sql.startsWith('SELECT contest_id FROM temporary_contest_account')) return temporary ? [{ contest_id: 42 }] : [];
    if (sql.includes('AS username_conflict')) return options.duplicate ? [{ id: 21, username: 'collision', username_conflict: 1 }] : [];
    if (sql.startsWith('UPDATE user SET username=')) { writes.push({ sql, params: Array.from(params) }); return {}; }
    throw new Error('Unexpected SQL: ' + sql);
  }, async transaction(callback) { return callback(db); } };
  const api = {
    send: (_res, data) => ({ status: 200, data }),
    fail: (_res, status, code, message, fields) => ({ status, error: { code, message, fields } }),
    ifMatch: (req, current) => (req.get('If-Match') || req.body.if_match) === JSON.stringify(current),
    apiNotModified: () => false, ensureFoundationSchema: async () => {}
  };
  const context = vm.createContext({
    app: {
      get: (url, capability, handler) => routes.set('GET ' + url, { capability, handler }),
      patch: (url, capability, handler) => routes.set('PATCH ' + url, { capability, handler })
    },
    requireCapability: value => value,
    api: () => api, TypeORM: { getConnection: () => db },
    isValidManagedTemporaryUsername, validSignature, LEGACY_MANAGED_PRIVILEGE_SET: new Set(),
    inputBoolean: (value, fallback) => value == null ? fallback : !!value,
    normalizeSex: (value, fallback) => value == null ? fallback : String(value),
    User: { deleteFromCache: id => invalidations.push(['user', id]) },
    contentDomain: { appendEvent: async (_manager, event) => { events.push(event); return 'event'; } },
    syzoj: { siteOwnerUserId: 1, log() {}, utils: {
      isValidUsername: value => /^[a-zA-Z0-9_-]{1,20}$/.test(value),
      ensureTemporaryContestAccountSchema: async () => {},
      registrationIdentityV2: {
        ensureRegistrationSchema: async () => {},
        profileResource: value => ({ ...value }),
        saveProfileFields: async () => { throw new Error('Unchanged temporary identity must not be resaved'); }
      },
      authorizationV2: {
        recentLoginSatisfied: () => true,
        authorize: async () => true,
        recordAudit: async (_req, event) => { events.push(event); return 'audit'; }
      },
      invalidateContestReadCache: id => invalidations.push(['contest', id])
    } }
  });
  vm.runInContext(source.slice(source.indexOf('function managedUserError('), source.indexOf('async function changeUserStatus(')), context);
  async function invoke(method, body, actor = { id: 1 }) {
    const route = routes.get(method + ' /api/v2/admin/users/:id');
    assert.equal(route.capability, 'admin:user.manage');
    if (actor.id !== 1 && !actor.canManage) return { status: 403 };
    return route.handler({ params: { id: '20' }, body, get: () => '' }, { locals: { user: actor } });
  }
  return { target, writes, events, invalidations,
    read: () => invoke('GET', {}),
    async rename(body, actor) {
      const current = await invoke('GET', {});
      return invoke('PATCH', { if_match: JSON.stringify(current.data), ...body }, actor);
    }
  };
}

test('managed temporary rename accepts long Unicode names without requiring or changing email and identity', async () => {
  const h = managedUserHarness();
  const username = '2026 西北工业大学 ICPC 校赛 - 计算机学院（张三）';
  const result = await h.rename({ username, email: '' });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.data.username, username);
  assert.equal(result.data.is_temporary_contest_account, true);
  assert.equal(result.data.identity.college, 'CSV 原学院');
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].params[0], username);
  assert.equal(h.writes[0].params[1], null, 'empty temporary emails remain SQL NULL, not a conflicting empty string');
  assert.equal(h.events.length, 2);
  assert.deepEqual(h.invalidations, [['user', 20], ['contest', 42]]);
});

test('temporary rename preserves duplicate-name, version, length, visibility and permission checks', async () => {
  for (const username of ['', '名'.repeat(81), 'a\u202eb']) {
    const h = managedUserHarness();
    assert.equal((await h.rename({ username })).status, 422);
    assert.equal(h.writes.length, 0);
  }
  const duplicate = managedUserHarness({ duplicate: true });
  assert.equal((await duplicate.rename({ username: 'Taken' })).error.code, 'USERNAME_ALREADY_USED');
  assert.equal(duplicate.writes.length, 0);
  const stale = managedUserHarness();
  assert.equal((await stale.rename({ username: '新名字', if_match: 'outdated' })).status, 412);
  assert.equal((await stale.rename({ username: '新名字', if_match: '' })).status, 428);
  assert.equal((await stale.rename({ username: '新名字' }, { id: 20 })).status, 403);
  assert.equal(stale.writes.length, 0);
  assert.equal(stale.events.length, 0);
});

test('ordinary accounts cannot opt into the temporary policy through request fields', async () => {
  for (const username of ['中文名', 'x'.repeat(21)]) {
    const h = managedUserHarness({ temporary: false });
    assert.equal((await h.rename({ username, is_temporary_contest_account: true })).status, 422);
    assert.equal(h.writes.length, 0);
  }
  const normal = managedUserHarness({ temporary: false });
  assert.equal((await normal.rename({ username: 'normal_name' })).status, 200);
  assert.equal((await normal.rename({ username: 'normal_name', email: '' })).status, 422);
});

test('managed signatures accept fifty Unicode characters and reject longer values before saving', async () => {
  for (const information of ['', '中'.repeat(50), '😀'.repeat(50), '**签名** <b>纯文本</b>']) {
    const h = managedUserHarness();
    assert.equal((await h.rename({ information })).status, 200);
    assert.equal(h.writes[0].params[2], information);
  }
  for (const information of ['a'.repeat(51), '中'.repeat(51), '😀'.repeat(51)]) {
    const h = managedUserHarness();
    const result = await h.rename({ information });
    assert.equal(result.status, 422);
    assert.equal(result.error.fields.information, 'maximum length is 50');
    assert.equal(h.writes.length, 0);
  }
});

test('long-name notifications exempt temporary accounts without relaxing ordinary registration', () => {
  const source = read('custom/modules/_registration_identity.js');
  assert.match(source, /NOT EXISTS \(SELECT 1 FROM temporary_contest_account temporary WHERE temporary.user_id=user.id\)/);
  assert.match(source, /!syzoj.utils.isValidUsername\(username\)/);
});

test('login accepts the exact renamed Unicode account and still enforces temporary expiry', async () => {
  const source = read('custom/modules/_api_v2_identity.js');
  const user = { id: 20, username: '2026 西北工业大学 ICPC 校赛（计算机学院） - 张三 #1', password: 'fixture-hash' };
  let handler, allowed = true, sessions = 0;
  const context = vm.createContext({
    app: { post: (_url, callback) => { handler = callback; } },
    loginKey: () => 'fixture', loginBlocked: () => false, recordFailure() {}, loginFailures: new Map(),
    publicMe: target => ({ id: target.id, username: target.username }),
    User: { fromName: async name => { assert.equal(name, user.username); return user; } },
    api: () => ({ send: (_res, data) => ({ status: 200, data }), fail: (_res, status) => ({ status }) }),
    syzoj: { log() {}, utils: {
      verifyPassword: async () => true, passwordNeedsUpgrade: () => false,
      isTemporaryAccountLoginAllowed: async id => { assert.equal(id, 20); return allowed; },
      establishAuthenticatedSession: async () => { sessions++; }, clearLegacyLoginCookie() {},
      authorizationV2: { recordAudit: async () => {} }
    } }
  });
  vm.runInContext(source.slice(source.indexOf('async function findLoginUser('), source.indexOf('function loginBlocked(')), context);
  vm.runInContext(source.slice(source.indexOf("app.post('/api/v2/auth/login',"), source.indexOf("app.post('/api/v2/auth/logout',")), context);
  const request = { body: { username: user.username, password: 'fixture-password' } };
  assert.equal((await handler(request, { locals: {} })).status, 200);
  allowed = false;
  assert.equal((await handler(request, { locals: {} })).status, 401);
  assert.equal(sessions, 1);
});

test('admin user search binds student IDs as text alongside username, email and UID', () => {
  const source = read('custom/modules/_admin_users.js');
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function userSearchCondition('), source.indexOf("app.get('/admin/users'")), context);
  assert.equal(context.userSearchCondition('').sql, '');
  for (const keyword of ['0012345678', '2026', 'alice', 'alice@example.test', '42', "' OR 1=1 --"]) {
    const condition = context.userSearchCondition(keyword);
    assert.match(condition.sql, /u\.username LIKE \? OR u\.email LIKE \? OR CAST\(u\.id AS CHAR\)=\?/);
    assert.match(condition.sql, /EXISTS \(SELECT 1 FROM user_registration_profile profile WHERE profile.user_id=u.id AND profile.student_id LIKE \?\)/);
    assert.deepEqual(Array.from(condition.params), [`%${keyword}%`, `%${keyword}%`, keyword, `%${keyword}%`]);
    assert.ok(!condition.sql.includes(keyword));
  }
  const route = source.slice(source.indexOf("app.get('/admin/users'"));
  assert.ok(route.indexOf('canManageUsers(res.locals.user)') < route.indexOf('ensureRegistrationProfileSchema()'));
  assert.match(route, /SELECT COUNT\(\*\) AS count FROM user u \$\{condition.sql\}/);
  assert.match(route, /condition.params.concat\(\[USER_PAGE_SIZE, \(currentPage - 1\) \* USER_PAGE_SIZE\]\)/);
  assert.match(route, /q: keyword \|\| undefined/);
  assert.match(read('custom/views/admin_users.ejs'), /placeholder="用户名、邮箱、UID 或学号"/);
});

test('admin user search API keeps permission, cursor and redaction while matching student IDs', async () => {
  const source = read('custom/modules/_api_v2_admin_domain.js');
  let handler;
  let schemaReady = false;
  const calls = [];
  const context = vm.createContext({
    app: { get(route, permission, callback) {
      assert.equal(route, '/api/v2/admin/users');
      assert.equal(permission, 'admin:user.manage');
      handler = callback;
    } },
    requireCapability: capability => capability,
    ensureRegistrationProfileSchema: async () => { schemaReady = true; },
    syzoj: { utils: { ensureAccountStateSchema: async () => {} } },
    TypeORM: { getConnection: () => ({ query: async (sql, params) => {
      assert.ok(schemaReady);
      calls.push({ sql, params });
      return [{ id: 10, username: 'alice', email: 'private@example.test' }, { id: 11, username: 'bob' }];
    } }) },
    api: () => ({ parseLimit: () => 1, decodeCursor: value => value, encodeCursor: String, send: (_res, data) => data }),
    iso: value => value || null
  });
  vm.runInContext(source.slice(source.indexOf("app.get('/api/v2/admin/users',"), source.indexOf('function managedUserError(')), context);
  for (const keyword of ['0012345678', '2026', 'alice', '42', '', "' OR 1=1 --"]) {
    const res = { locals: { apiMeta: {} } };
    const rows = await handler({ query: { q: ` ${keyword} `, cursor: '9' } }, res);
    const call = calls.at(-1);
    assert.match(call.sql, /u.id>\? AND \(\?='' OR/);
    assert.match(call.sql, /profile.user_id=u.id AND profile.student_id LIKE CONCAT\('%',\?,'%'\)/);
    assert.deepEqual(Array.from(call.params), [9, keyword, keyword, keyword, keyword, keyword, 2]);
    assert.equal(res.locals.apiMeta.next_cursor, '10');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, '[redacted]');
    assert.equal(rows[0].student_id, undefined);
  }
});

test('administrator user profile v2 preserves owner and administrator boundaries', () => {
  const route = read('custom/modules/_api_v2_admin_domain.js');
  assert.match(route, /app\.get\('\/api\/v2\/admin\/users\/:id', requireCapability\('admin:user\.manage'\)/);
  assert.match(route, /app\.patch\('\/api\/v2\/admin\/users\/:id', requireCapability\('admin:user\.manage'\)/);
  assert.match(route, /body\.new_password \|\| hasPrivileges \|\| hasAdminStatus/);
  assert.match(route, /recentLoginSatisfied\(req\)/);
  assert.match(route, /function assertManagedUserAccess\(target, actor\)/);
  assert.match(route, /OWNER_ACCOUNT_PROTECTED/);
  assert.match(route, /OWNER_CAPABILITY_REQUIRED/);
  assert.match(route, /admin:permission\.grant/);
  assert.match(route, /hasAdminStatus && isAdmin !== !!target\.is_admin && !access\.actorIsOwner/);
  assert.match(route, /function normalizeSex\(value, fallback\)/);
  assert.match(route, /sex: normalizeSex\(target\.sex, '0'\) \|\| '0'/);
  assert.match(route, /Sex must be -1, 0, or 1/);
});

test('administrator user updates lock and commit every profile surface atomically', () => {
  const route = read('custom/modules/_api_v2_admin_domain.js');
  assert.match(route, /FROM user WHERE id=\? FOR UPDATE/);
  assert.match(route, /FROM user_registration_profile WHERE user_id=\? FOR UPDATE/);
  assert.match(route, /FROM user_privilege WHERE user_id=\? FOR UPDATE/);
  assert.match(route, /saveProfileFields\(manager, targetId, body, true\)/);
  assert.match(route, /DELETE FROM user_privilege WHERE user_id=\?/);
  assert.match(route, /action: 'admin:user\.update'/);
  assert.match(route, /contentDomain\.appendEvent\(manager/);
  assert.match(route, /type: 'user\.profile\.updated'/);
  assert.match(route, /revokeUserSessions\(req, targetId\)/);
});

test('privileged account editor uses only the administrator v2 resource', () => {
  const identity = read('custom/modules/_registration_identity.js');
  const privilegeLoader = read('custom/modules/_user_privilege_loader.js');
  const route = read('custom/modules/_api_v2_admin_domain.js');
  const view = read('custom/views/user_edit.ejs');
  assert.match(identity, /actorIsOwner: context\.actorIsOwner/);
  assert.match(identity, /actorCanManage: context\.actorCanManage/);
  assert.match(identity, /actorCanGrant: context\.actorCanGrant/);
  assert.match(privilegeLoader, /Number\(user\.id\) === Number\(owner\.id\)/);
  assert.match(view, /data-account-admin-v2/);
  assert.match(view, /\/api\/v2\/admin\/users\/' \+ encodeURIComponent\(form\.dataset\.userId\)/);
  assert.match(view, /selectedPrivileges = Array\.prototype\.map\.call/);
  assert.match(view, /payload\.privileges = selectedPrivileges/);
  assert.match(view, /form\.querySelector\('input\[name="is_admin"\]'\)/);
  assert.match(view, /siteAdminField && !!siteAdminField\.checked !== !!currentResult\.body\.data\.is_admin/);
  assert.match(view, /payload\.is_admin = !!siteAdminField\.checked/);
  assert.match(view, /<%- appCanManageSiteAdmin \? ' name="is_admin"' : ' disabled' %>/);
  assert.doesNotMatch(view, /<%= appCanManageSiteAdmin \? ' name="is_admin"' : ' disabled' %>/);
  assert.doesNotMatch(view, /fallbackAttribute|API_DOMAIN_DISABLED|HTMLFormElement\.prototype\.submit/);
  assert.match(view, /function resourceEtag\(result\)/);
  assert.match(view, /if_match: currentEtag/);
  assert.match(view, /'If-Match': currentEtag/);
  assert.match(route, /req\.get\('If-Match'\) \|\| body\.if_match/);
});

test('Hit visibility settings use one ETag-protected evented v2 resource', () => {
  const route = read('custom/modules/__hit_score_engine.js');
  const view = read('custom/views/user_edit.ejs');
  assert.match(route, /app\.get\('\/api\/v2\/me\/hit-settings'/);
  assert.match(route, /app\.patch\('\/api\/v2\/me\/hit-settings'/);
  assert.match(route, /user_hit_setting WHERE user_id=\? LIMIT 1 FOR UPDATE/);
  assert.match(route, /api\.ifMatch\(req, current\)/);
  assert.match(route, /contentDomain\.appendEvent\(manager/);
  assert.match(route, /profile\.hit-settings\.updated/);
  assert.match(view, /data-hit-setting-v2/);
  assert.match(view, /fetch\('\/api\/v2\/me\/hit-settings'/);
  assert.doesNotMatch(view, /API_DOMAIN_DISABLED|HTMLFormElement\.prototype\.submit/);
});

test('administrator deletion uses only the v2 resource', () => {
  const route = read('custom/modules/_api_v2_admin_domain.js');
  const service = read('custom/modules/_admin_users.js');
  const view = read('custom/views/admin_users.ejs');
  assert.match(route, /app\.delete\('\/api\/v2\/admin\/users\/:id', requireCapability\('admin:user\.manage', \{ recent: true \}\)/);
  assert.match(route, /deleteUserAccount\(/);
  assert.doesNotMatch(route, /legacyRoute/);
  assert.match(route, /X-Audit-Event-ID/);
  assert.match(route, /USER_DELETE_CONFLICT/);
  assert.match(service, /UPDATE submission_v2_projection SET user_id=\? WHERE user_id=\?/);
  assert.match(service, /DELETE FROM rating_v2_event WHERE user_id=\?/);
  assert.match(service, /DELETE FROM auth_grant WHERE subject_type='user'/);
  assert.match(service, /classGroups\.ensureSchema\(\)/);
  assert.match(service, /SELECT id FROM class_group WHERE owner_id=\? FOR UPDATE/);
  assert.match(service, /DELETE FROM class_group_member WHERE class_id IN \(\?\)/);
  assert.match(service, /DELETE FROM class_group WHERE id IN \(\?\) AND owner_id=\?/);
  assert.match(service, /UPDATE class_group_member SET added_by=\? WHERE added_by=\?/);
  assert.match(service, /DELETE FROM class_group_member WHERE user_id=\?/);
  assert.match(service, /classGroups\.refreshCache\(\)/);
  assert.match(service, /action: 'admin:user\.delete'/);
  assert.match(view, /data-admin-user-delete-v2/);
  assert.match(view, /method: 'DELETE'/);
  assert.doesNotMatch(view, /API_DOMAIN_DISABLED|HTMLFormElement\.prototype\.submit/);
});
