'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, 'custom/modules', file), 'utf8');
const auth = read('_auth_security.js'), identity = read('_api_v2_identity.js');
const sources = {
  security: read('_request_security.js'),
  establish: auth.slice(auth.indexOf('function regenerateSession('), auth.indexOf('async function revokeUserSessions(')),
  logout: identity.slice(identity.indexOf('function destroySession('), identity.indexOf('function maskEmail(')) +
    identity.slice(identity.indexOf("app.post('/api/v2/auth/logout',"), identity.indexOf("app.post('/api/v2/auth/mfa/challenge',"))
};
const HOUR = 3600000, DAY = 24 * HOUR;

// Also run inside an isolated process using the deployed session engine.
// No production accounts or session files are accessed.
function createHarness(sources, Clock = Date) {
  const vm = require('node:vm');
  const middlewares = [], routes = {}, utils = {};
  const context = vm.createContext({
    Date: Clock, URL, Buffer, process: { env: {} },
    app: { use: fn => middlewares.push(fn), get() {}, post: (url, fn) => { routes[url] = fn; } },
    syzoj: { utils },
    require(name) {
      if (name === 'crypto' || name === 'fs') return require(name);
      if (name === '../libs/request-read-cache') return { middleware: (_req, _res, next) => next() };
      return {};
    }
  });
  vm.runInContext(sources.security + String.fromCharCode(10) + sources.establish, context);
  vm.runInContext('function api() { return syzoj.utils.apiV2; }' + sources.logout, context);
  utils.apiV2 = { send: (res, data) => res.json(data) };
  utils.authorizationV2 = { recordAudit: async () => {} };
  utils.clearLegacyLoginCookie = (req, res) => res.clearCookie('login', utils.secureCookieOptions(req));
  return { utils, routes, middleware: middlewares[1], establish: context.establishAuthenticatedSession };
}

test('cookie policy extends only opted-in authenticated sessions and keeps secure flags', () => {
  const h = createHarness(sources);
  for (const item of [
    { user_id: 1, rememberMe: true, expected: 30 * DAY },
    { user_id: 1, rememberMe: false, expected: 12 * HOUR },
    { user_id: 1, expected: 12 * HOUR },
    { user_id: null, rememberMe: true, expected: 12 * HOUR },
    { user_id: 1, rememberMe: 'true', expected: 12 * HOUR }
  ]) {
    for (const secure of [true, false]) {
      const req = { secure, session: { ...item, cookie: {} }, body: { remember_me: true } };
      let next = false;
      h.middleware(req, {}, () => { next = true; });
      assert.equal(next, true);
      assert.equal(req.session.cookie.maxAge, item.expected);
      assert.equal(req.session.cookie.httpOnly, true);
      assert.equal(req.session.cookie.sameSite, 'lax');
      assert.equal(req.session.cookie.secure, secure);
      assert.equal(req.session.cookie.path, '/');
    }
  }
  assert.doesNotThrow(() => h.utils.applySessionCookiePolicy({}));
});

test('regeneration sets lifetime immediately, rotates CSRF, and preserves only same-user choices', async () => {
  let now = 1000000, rotations = 0;
  const h = createHarness(sources, class extends Date { static now() { return now; } });
  const req = { secure: true };
  function freshSession() {
    return { cookie: {}, regenerate(callback) { rotations++; req.session = freshSession(); callback(); } };
  }
  req.session = freshSession();
  req.session.globalCsrfToken = 'before-login';
  await h.establish(req, 3, { rememberMe: true });
  assert.equal(req.session.cookie.maxAge, 30 * DAY);
  assert.equal(req.session.cookie.secure, true);
  assert.notEqual(req.session.globalCsrfToken, 'before-login');
  assert.equal(req.session.apiV2AuthenticatedAt, now);
  const token = req.session.globalCsrfToken;
  now += DAY;
  h.utils.applySessionCookiePolicy(req);
  assert.equal(req.session.apiV2AuthenticatedAt, 1000000, 'activity must not refresh recent-password/MFA proof');
  assert.equal(req.session.globalCsrfToken, token);
  await h.establish(req, 3);
  assert.equal(req.session.cookie.maxAge, 30 * DAY, 'own password changes retain the preference');
  assert.notEqual(req.session.globalCsrfToken, token);
  await h.establish(req, 4);
  assert.equal(req.session.cookie.maxAge, 12 * HOUR, 'other accounts cannot inherit the preference');
  await h.establish(req, 4, { rememberMe: true });
  await h.establish(req, 4, { rememberMe: false });
  assert.equal(req.session.cookie.maxAge, 12 * HOUR);
  assert.equal(req.session.rememberMe, false);
  assert.equal(rotations, 5);
});

async function checkRealStore(input) {
  const assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
  const NativeDate = Date;
  let now = NativeDate.now();
  global.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  const express = require('/app/node_modules/express');
  const session = require('/app/node_modules/express-session');
  const FileStore = require('/app/node_modules/session-file-store')(session);
  const helpers = require('/app/node_modules/session-file-store/lib/session-file-helpers');
  const storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'noj-remember-fixture-'));
  const h = eval('(' + input.harness + ')')(input.sources, Date);
  let store, server;
  function state(req, res) {
    res.json({ id: req.sessionID, user: req.session.user_id || null, age: req.session.cookie.originalMaxAge, authenticatedAt: req.session.apiV2AuthenticatedAt });
  }
  async function startServer() {
    // Recreate both the application and the store; only persisted files and
    // the signing secret survive, as when replacing the Web container.
    store = new FileStore({ path: storePath, retries: 0, reapInterval: -1, logFn() {} });
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use(session({ secret: 'isolated-test-secret-never-used-in-production', rolling: true, saveUninitialized: true, resave: true, store }));
    app.use(h.middleware);
    app.use((req, res, next) => { res.locals.user = req.session.user_id ? { id: req.session.user_id } : null; next(); });
    app.post('/fixture/signin', async (req, res, next) => {
      try { await h.establish(req, 1, { rememberMe: req.body.remember_me === true }); state(req, res); } catch (error) { next(error); }
    });
    app.get('/fixture/state', state);
    app.post('/api/v2/auth/logout', h.routes['/api/v2/auth/logout']);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  }
  await startServer();
  const day = 86400000, hour = 3600000;
  async function call(route, cookie, body, secure = false) {
    return new Promise((resolve, reject) => {
      const headers = { Connection: 'close' };
      if (cookie) headers.Cookie = cookie;
      if (body) headers['Content-Type'] = 'application/json';
      if (secure) headers['X-Forwarded-Proto'] = 'https';
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: route, method: body ? 'POST' : 'GET', headers }, res => {
        let data = '';
        res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            assert.equal(res.statusCode, 200, data);
            const header = (res.headers['set-cookie'] || []).find(value => value.startsWith('connect.sid='));
            resolve({ data: JSON.parse(data), header, cookie: header && header.split(';')[0] });
          } catch (error) { reject(error); }
        });
      });
      request.on('error', reject); request.end(body ? JSON.stringify(body) : undefined);
    });
  }
  function assertCookie(result, age, secure) {
    assert.match(result.header, /HttpOnly/);
    assert.match(result.header, /SameSite=Lax/);
    assert.equal(/; Secure(?:;|$)/.test(result.header), secure);
    const expiry = new Date(result.header.match(/Expires=([^;]+)/)[1]).getTime();
    assert.ok(Math.abs(expiry - now - age) < 1000, 'Set-Cookie expiry must match rolling session TTL');
    assert.equal(result.data.age, age);
  }
  try {
    const anonymous = await call('/fixture/state');
    assertCookie(anonymous, 12 * hour, false);
    const start = await call('/fixture/signin', anonymous.cookie, { remember_me: true });
    assertCookie(start, 30 * day, false);
    assert.notEqual(start.data.id, anonymous.data.id, 'login rotates the session ID');
    const stored = JSON.parse(fs.readFileSync(path.join(storePath, start.data.id + '.json'), 'utf8'));
    assert.equal(stored.rememberMe, true);
    assert.equal(stored.cookie.originalMaxAge, 30 * day, 'FileStore must use per-session TTL rather than its default one-hour TTL');
    const proofTime = start.data.authenticatedAt;
    await new Promise(resolve => server.close(resolve));
    await startServer();
    const afterRestart = await call('/fixture/state', start.cookie);
    assert.equal(afterRestart.data.user, 1, 'remembered login survives application and store replacement');
    assert.equal(afterRestart.data.id, start.data.id);
    assert.equal(afterRestart.data.authenticatedAt, proofTime, 'restart must not renew recent authentication proof');
    assertCookie(afterRestart, 30 * day, false);
    for (let i = 0; i < 3; i++) {
      now += 29 * day;
      assert.equal(helpers.isExpired(JSON.parse(fs.readFileSync(path.join(storePath, start.data.id + '.json'), 'utf8')), store.options), false);
      const active = await call('/fixture/state', start.cookie);
      assert.equal(active.data.user, 1);
      assert.equal(active.data.id, start.data.id);
      assert.equal(active.data.authenticatedAt, proofTime);
      assertCookie(active, 30 * day, false);
    }
    now += 30 * day + 1;
    const idle = await call('/fixture/state', start.cookie);
    assert.equal(idle.data.user, null, '30 days of inactivity expires the server-side session');
    assertCookie(idle, 12 * hour, false);
    const legacy = await call('/fixture/signin', null, {});
    assertCookie(legacy, 12 * hour, false);
    await new Promise(resolve => server.close(resolve));
    await startServer();
    const ordinaryAfterRestart = await call('/fixture/state', legacy.cookie);
    assert.equal(ordinaryAfterRestart.data.user, 1, 'ordinary login also survives replacement');
    assert.equal(ordinaryAfterRestart.data.id, legacy.data.id);
    assertCookie(ordinaryAfterRestart, 12 * hour, false);
    now += 13 * hour;
    assert.equal((await call('/fixture/state', legacy.cookie)).data.user, null);
    const remembered = await call('/fixture/signin', null, { remember_me: true });
    const unchecked = await call('/fixture/signin', remembered.cookie, { remember_me: false });
    assertCookie(unchecked, 12 * hour, false);
    const publicSite = await call('/fixture/signin', null, { remember_me: true }, true);
    assertCookie(publicSite, 30 * day, true);
    await call('/api/v2/auth/logout', publicSite.cookie, {}, true);
    await new Promise(resolve => server.close(resolve));
    await startServer();
    assert.equal((await call('/fixture/state', publicSite.cookie, undefined, true)).data.user, null, 'logout invalidates even a replayed remembered cookie');
    console.log(JSON.stringify({ rollingDaysTested: 87, cookieAndStoreExpiry: true, idleExpiry: true, lanAndHttps: true, logoutRevocation: true, replacementPersistence: true }));
  } finally {
    await new Promise(resolve => server.close(resolve));
    global.Date = NativeDate;
    fs.rmSync(storePath, { recursive: true, force: true });
  }
}

test('deployment keeps the session directory in a stable named volume rather than tmpfs', () => {
  const result = spawnSync('docker', ['compose', 'config', '--format', 'json'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, 'Compose configuration must resolve');
  const config = JSON.parse(result.stdout);
  const mounts = config.services.web.volumes.filter(mount => mount.target === '/app/sessions');
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].type, 'volume');
  assert.equal(mounts[0].read_only, undefined);
  assert.equal(config.volumes[mounts[0].source].name, 'nwpuoj_web_sessions');
  assert.ok(!(config.services.web.tmpfs || []).some(mount => String(mount).split(':')[0] === '/app/sessions'));
});

test('deployed session engine persists, rolls, expires and revokes sessions on HTTP and proxy HTTPS', { timeout: 30000 }, t => {
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e',
    '(' + checkRealStore.toString() + ")(JSON.parse(require('fs').readFileSync(0,'utf8'))).catch(error=>{console.error(error);process.exitCode=1;});"],
  { cwd: root, input: JSON.stringify({ sources, harness: createHarness.toString() }), encoding: 'utf8', timeout: 25000 });
  assert.equal(result.status, 0, result.stderr || result.error && result.error.message);
  t.diagnostic(result.stdout.trim());
});
