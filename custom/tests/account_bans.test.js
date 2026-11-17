'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeIp } = require('../libs/login-ip');
const source = fs.readFileSync(path.join(__dirname, '../modules/_account_bans.js'), 'utf8');

function harness() {
  const routes = {}, writes = [];
  const context = {
    require: name => { assert.equal(name, 'typeorm'); return { getConnection: () => ({ query: async () => { throw new Error('Unexpected database access'); } }) }; },
    app: Object.fromEntries(['get','post','delete'].map(method => [method, (url, fn) => { routes[method + ' ' + url] = fn; }])),
    syzoj: { siteOwnerUserId: 99, log() {}, utils: {
      apiV2: { fail: (res, status, code, message) => Object.assign(res, { status, code, message }) },
      authorizationV2: { authorize: async () => true, recentLoginSatisfied: req => !!req.recent },
      normalizeBanIp: normalizeIp, ensureAccountBanSchema: async () => {}
    } }
  };
  vm.runInNewContext(source, context);
  return { context, writes, request: async (body, actor = { id: 90, is_admin: true }, recent = true) => {
    const res = { locals: { user: actor } };
    await routes['post /api/v2/admin/bans']({ body, recent }, res);
    return res;
  } };
}

test('only global administrators with a recent login can add bans', async () => {
  const h = harness();
  assert.equal((await h.request({}, null)).status, 401);
  assert.equal((await h.request({}, { id: 1, privileges: ['manage_user'] })).code, 'CAPABILITY_REQUIRED');
  assert.equal((await h.request({}, { id: 90, is_admin: true }, false)).code, 'RECENT_LOGIN_REQUIRED');
});

test('invalid duration, ambiguous expiry, malformed IP and oversized reasons never write records', async () => {
  const h = harness();
  for (const body of [
    {}, { type: 'ip', permanent: 'true' }, { type: 'ip', permanent: false, expires_at: '2000-01-01T00:00:00Z' },
    { type: 'ip', permanent: false, expires_at: '2099-01-01T00:00' },
    { type: 'ip', permanent: true, ip: '127.0.0.1/8' },
    { type: 'ip', permanent: true, ip: 'localhost' },
    { type: 'ip', permanent: true, ips: [] },
    { type: 'ip', permanent: true, ips: '192.0.2.1' },
    { type: 'ip', permanent: true, ips: ['192.0.2.1', 'invalid'] },
    { type: 'ip', permanent: true, ips: ['192.0.2.1', null] },
    { type: 'ip', permanent: true, ips: Array(201).fill('192.0.2.1') },
    { type: 'ip', permanent: true, ip: '1.2.3.4', reason: 'x'.repeat(1001) }
  ]) assert.equal((await h.request(body)).code, 'VALIDATION_FAILED', JSON.stringify(body));
});

test('equivalent IPv4 and IPv6 spellings use a single IP ban identity', () => {
  assert.equal(normalizeIp('::ffff:192.0.2.7'), '192.0.2.7');
  assert.equal(normalizeIp('::FFFF:c000:0207'), '192.0.2.7');
  assert.equal(normalizeIp('2001:0DB8:0000:0000::1'), '2001:db8::1');
  assert.equal(normalizeIp('fe80::1%eth0'), null);
});

test('IP revocation deletes matching persisted sessions across accounts without touching other sessions', async () => {
  const os = require('node:os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noj-ban-sessions-'));
  const auth = fs.readFileSync(path.join(__dirname, '../modules/_auth_security.js'), 'utf8');
  const context = { fs, path, normalizeBanIp: normalizeIp, syzoj: { log() {} } };
  vm.runInNewContext(auth.slice(auth.indexOf('async function revokeIpSessions('), auth.indexOf('function destroySession(')), context);
  try {
    const sessions = {
      'login-ip.json': { user_id: 1, authenticatedIp: '::ffff:192.0.2.1' },
      'last-ip.json': { user_id: 2, authenticatedIp: '192.0.2.2', lastIp: '192.0.2.1' },
      'unrelated.json': { user_id: 1, authenticatedIp: '192.0.2.2' },
      'anonymous.json': { cookie: {} }
    };
    for (const [name, session] of Object.entries(sessions)) fs.writeFileSync(path.join(directory, name), JSON.stringify(session));
    await context.revokeIpSessions({ sessionStore: { options: { path: directory } } }, '::FFFF:c000:201');
    assert.deepEqual(fs.readdirSync(directory).sort(), ['anonymous.json', 'unrelated.json']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
