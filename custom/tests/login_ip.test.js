'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { normalizeIp, localDate, listLogins } = require('../libs/login-ip');

test('IP equivalence includes mapped IPv4 and compressed IPv6; invalid records do not count', () => {
  assert.equal(normalizeIp(' 10.31.122.249 '), '10.31.122.249');
  assert.equal(normalizeIp('::ffff:10.31.122.249'), '10.31.122.249');
  assert.equal(normalizeIp('0:0:0:0:0:ffff:a1f:7af9'), '10.31.122.249');
  assert.equal(normalizeIp('2001:0DB8:0000:0000:0000:0000:0000:0001'), normalizeIp('2001:db8::1'));
  for (const value of [null, '', 'unknown', '10.0.0.1, 10.0.0.2', '999.1.1.1', '<script>', 'fe80::1%eth0']) assert.equal(normalizeIp(value), null);
});

test('search dates are interpreted in Beijing and invalid filters never reach SQL', async () => {
  assert.equal(localDate('2026-11-01T18:00'), '2026-11-01 10:00:00');
  for (const input of ['2026-02-30T10:00', '2026-11-01T24:00', 'x', '2026-11-01T18:00Z']) assert.throws(() => localDate(input));
  const manager = { query() { assert.fail('invalid input reached SQL'); } };
  for (const query of [{ page: 'NaN' }, { page: '-1' }, { contest_id: 'oops' }, { from: '2026-11-02T10:00', to: '2026-11-01T10:00' }]) {
    await assert.rejects(listLogins(manager, query, true), error => error.statusCode === 422);
  }
});

test('admin page and API require global audit permission before accessing login records', async () => {
  const routes = new Map(); let reads = 0;
  const context = { require: name => name === 'typeorm' ? { getConnection: () => ({}) } : { listLogins: async () => { reads++; return { rows: [] }; } },
    app: { get: (url, fn) => routes.set(url, fn) }, syzoj: { log() {}, utils: {
      authorizationV2: { authorize: async user => user.audit === true, ensureSchema: async () => {} },
      apiV2: { send: (_res, data) => ({ status: 200, data }), fail: (_res, status) => ({ status }) }
    } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../modules/_login_ip.js'), 'utf8'), context);
  for (const url of ['/admin/ip', '/api/v2/admin/login-ips']) {
    for (const [user, expected] of [[null, 401], [{ id: 1 }, 403], [{ id: 2, contest_admin: true }, 403], [{ id: 3, audit: true }, 200]]) {
      const headers = {};
      const res = { locals: { user }, code: 200, set: (k, v) => { headers[k] = v; }, status(code) { this.code = code; return this; }, render() { return { status: this.code }; } };
      const result = await routes.get(url)({ query: {} }, res);
      assert.equal(result.status, expected); assert.equal(headers['Cache-Control'], 'private, no-store');
    }
  }
  assert.equal(reads, 1);
});
