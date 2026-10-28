'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_identity.js'), 'utf8');

// Exercise the real login handler with isolated accounts, sessions and time.
// No test signs into a production account or changes its password.
function harness() {
  let now = 1000000, schemaChecks = 0, verifyCalls = 0;
  const users = [
    { id: 1, username: 'alice', email: 'alice@example.test', password: 'hash:good_password' },
    { id: 2, username: '比赛账号（测试）', email: null, password: 'hash:temporary_password', temporary: true }
  ];
  const profiles = [
    { user_id: 1, student_id_scope: 'ordinary', student_id: '0012345678' },
    { user_id: 2, student_id_scope: 'contest:42', student_id: '0012345678' }
  ];
  const sessions = [], sessionOptions = [], audits = [], queries = [];
  for (const user of users) user.save = async () => {};
  const User = {
    prototype: {},
    fromName: async name => users.find(user => user.username.toLowerCase() === name.toLowerCase()) || null,
    findById: async id => users.find(user => user.id === id) || null
  };
  const db = { async query(sql, params) {
    queries.push({ sql, params: Array.from(params) });
    if (sql === 'SELECT id FROM user WHERE email=? LIMIT 2') {
      return users.filter(user => user.email === params[0]).slice(0, 2).map(user => ({ id: user.id }));
    }
    if (sql === 'SELECT user_id AS id FROM user_registration_profile WHERE student_id_scope=? AND student_id=? LIMIT 2') {
      return profiles.filter(profile => profile.student_id_scope === params[0] && profile.student_id === params[1])
        .slice(0, 2).map(profile => ({ id: profile.user_id }));
    }
    throw new Error('Unexpected SQL: ' + sql);
  } };
  let handler;
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } }, process: { env: {} }, Buffer,
    app: { post: (route, callback) => { assert.equal(route, '/api/v2/auth/login'); handler = callback; } },
    require(name) {
      if (name === 'crypto') return require('node:crypto');
      if (name === 'typeorm') return { getConnection: () => db };
      if (name === '../libs/user-signature') return require(name);
      if (name === '../libs/registration-profile-schema') return {
        ORDINARY_STUDENT_ID_SCOPE: 'ordinary', ensureRegistrationProfileSchema: async () => { schemaChecks++; }
      };
      if (name === '../libs/site-mail' || name === '../libs/content-domain') return {};
      throw new Error(name);
    },
    syzoj: { model: () => User, log() {}, utils: {
      apiV2: {
        send: (_res, data) => ({ status: 200, data }),
        fail: (_res, status, code, message) => ({ status, error: { code, message } })
      },
      verifyPassword: async (password, hash) => { verifyCalls++; return hash === 'hash:' + password || hash === 'legacy:' + password; },
      passwordNeedsUpgrade: hash => hash.startsWith('legacy:'),
      hashPassword: async password => 'hash:' + password,
      isUserAccountActive: async id => !users.find(user => user.id === id).disabled,
      isTemporaryAccountLoginAllowed: async id => !users.find(user => user.id === id).expired,
      isTemporaryContestAccount: async id => !!users.find(user => user.id === id).temporary,
      establishAuthenticatedSession: async (_req, id, options) => { sessions.push(id); sessionOptions.push({ ...options }); },
      clearLegacyLoginCookie() {},
      authorizationV2: { recordAudit: async (_req, event) => { audits.push(event); } }
    } }
  });
  vm.runInContext(source.slice(0, source.indexOf("app.post('/api/v2/auth/logout',")), context);
  return { users, profiles, sessions, sessionOptions, audits, queries,
    schemaChecks: () => schemaChecks, verifyCalls: () => verifyCalls,
    advance: milliseconds => { now += milliseconds; },
    login: (identifier, password = 'good_password', ip = 'test-client', rememberMe) => handler(
      { ip, body: { username: identifier, password, ...(rememberMe !== undefined ? { remember_me: rememberMe } : {}) } }, { locals: {} }
    )
  };
}

test('username, case-insensitive email and zero-prefixed student ID sign into the same account', async () => {
  const h = harness();
  for (const identifier of ['alice', ' ALICE ', 'alice@example.test', ' ALICE@EXAMPLE.TEST ', '0012345678']) {
    const result = await h.login(identifier);
    assert.equal(result.status, 200, identifier);
    assert.equal(result.data.user.id, 1);
    assert.equal(result.data.user.username, 'alice');
  }
  assert.deepEqual(h.sessions, [1, 1, 1, 1, 1]);
  assert.equal(h.audits.length, 5);
  assert.ok(h.audits.every(event => event.action === 'auth:login' && event.resourceId === 1));
  assert.equal(h.schemaChecks(), 1);
  assert.deepEqual(h.queries.at(-1).params, ['ordinary', '0012345678']);
});

test('invalid aliases and wrong passwords expose the same generic failure without a session', async () => {
  const h = harness();
  const wrong = await h.login('alice@example.test', 'wrong');
  assert.equal(wrong.status, 401);
  for (const identifier of ['unknown', 'missing@example.test', '9999999999', '1', '123456789', "x' OR 1=1--@example.test"]) {
    const result = await h.login(identifier);
    assert.equal(result.status, 401);
    assert.equal(result.error.code, wrong.error.code);
    assert.equal(result.error.message, wrong.error.message);
  }
  assert.equal((await h.login('')).status, 422);
  assert.equal((await h.login('alice', '')).status, 422);
  assert.equal(h.sessions.length, 0);
  const injection = h.queries.at(-1);
  assert.deepEqual(injection.params, ["x' or 1=1--@example.test"]);
  assert.ok(!injection.sql.includes('OR 1=1'));
});

test('numeric and email-shaped usernames retain priority without password fallback to another account', async () => {
  const h = harness();
  for (const username of ['0012345678', 'alice@example.test']) {
    h.users[1].username = username;
    assert.equal((await h.login(username, 'good_password')).status, 401);
    const result = await h.login(username, 'temporary_password');
    assert.equal(result.status, 200);
    assert.equal(result.data.user.id, 2);
    assert.equal(result.data.redirect_url, '/contests');
  }
  assert.equal(h.queries.length, 0);
});

test('student login excludes temporary contest identities and fails closed on duplicate legacy aliases', async () => {
  const h = harness();
  assert.equal((await h.login('0012345678')).data.user.id, 1);
  h.profiles[0].student_id = '2026000001';
  assert.equal((await h.login('0012345678', 'temporary_password')).status, 401);
  h.profiles.push({ user_id: 2, student_id_scope: 'ordinary', student_id: '2026000001' });
  assert.equal((await h.login('2026000001')).status, 401);
  h.users[1].email = 'alice@example.test';
  assert.equal((await h.login('alice@example.test')).status, 401);
});

test('disabled accounts and expired temporary accounts remain blocked for all available identifiers', async () => {
  const h = harness();
  h.users[0].disabled = true;
  for (const identifier of ['alice', 'alice@example.test', '0012345678']) {
    const result = await h.login(identifier);
    assert.equal(result.status, 403);
    assert.equal(result.error.code, 'ACCOUNT_DISABLED');
  }
  h.users[1].expired = true;
  h.users[1].email = 'temp@example.test';
  for (const identifier of [h.users[1].username, h.users[1].email]) {
    assert.equal((await h.login(identifier, 'temporary_password')).status, 401);
  }
  assert.equal(h.sessions.length, 0);
});

test('switching identifiers cannot bypass five-failure lockout and it expires after one minute', async () => {
  const h = harness();
  const identifiers = ['alice', 'alice@example.test', '0012345678'];
  for (let i = 0; i < 5; i++) assert.equal((await h.login(identifiers[i % 3], 'wrong')).status, 401);
  for (const identifier of identifiers) assert.equal((await h.login(identifier)).status, 429);
  assert.equal(h.verifyCalls(), 5);
  h.advance(59999);
  assert.equal((await h.login('alice')).status, 429);
  h.advance(1);
  assert.equal((await h.login('0012345678')).status, 200);
  assert.deepEqual(h.sessions, [1]);
});

test('a successful alias login resets the shared failure count without revoking existing sessions', async () => {
  const h = harness();
  for (let i = 0; i < 4; i++) await h.login('alice', 'wrong');
  assert.equal((await h.login('alice@example.test')).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await h.login('0012345678', 'wrong')).status, 401);
  assert.equal((await h.login('alice')).status, 429);
  assert.deepEqual(h.sessions, [1]);
  assert.equal((await h.login('alice', 'good_password', 'different-client')).status, 200);
});

test('email updates and legacy password upgrades work through the common login flow', async () => {
  const h = harness();
  h.users[0].email = 'new@example.test';
  h.users[0].password = 'legacy:good_password';
  let saves = 0;
  h.users[0].save = async () => { saves++; };
  assert.equal((await h.login('alice@example.test')).status, 401);
  assert.equal((await h.login('NEW@EXAMPLE.TEST')).status, 200);
  assert.equal(h.users[0].password, 'hash:good_password');
  assert.equal(saves, 1);
});

test('the login UI advertises all identifiers while retaining autofill and the v2 request contract', () => {
  const view = fs.readFileSync(path.join(__dirname, '../views/login.ejs'), 'utf8');
  assert.match(view, /用户名 \/ 邮箱 \/ 学号/);
  assert.match(view, /placeholder="请输入用户名、邮箱或学号"/);
  assert.match(view, /name="username" type="text"[^>]*autocomplete="username"/);
  assert.match(view, /username: form\.elements\.username\.value/);
  assert.match(view, /账号或密码错误/);
  assert.match(view, /type="checkbox" name="remember_me"/);
  assert.doesNotMatch(view.match(/<input[^>]*name="remember_me"[^>]*>/)[0], /\bchecked\b/);
  assert.match(view, /remember_me: form\.elements\.remember_me\.checked/);
});

test('remember me is explicitly opt-in for ordinary and temporary sign-ins', async () => {
  const h = harness();
  assert.equal((await h.login('alice')).status, 200);
  assert.equal((await h.login('alice@example.test', 'good_password', 'test-client', true)).status, 200);
  assert.equal((await h.login('0012345678', 'good_password', 'test-client', false)).status, 200);
  assert.equal((await h.login(h.users[1].username, 'temporary_password', 'test-client', true)).status, 200);
  assert.deepEqual(h.sessionOptions, [{ rememberMe: false }, { rememberMe: true }, { rememberMe: false }, { rememberMe: true }]);
  for (const value of ['false', 'true', 1, 0, null, [], {}]) {
    assert.equal((await h.login('alice', 'good_password', 'test-client', value)).status, 422);
  }
  h.users[1].expired = true;
  assert.equal((await h.login(h.users[1].username, 'temporary_password', 'test-client', true)).status, 401);
  h.users[0].disabled = true;
  assert.equal((await h.login('alice', 'good_password', 'test-client', true)).status, 403);
  assert.equal(h.sessions.length, 4, 'invalid options and ineligible accounts cannot create sessions');
});
