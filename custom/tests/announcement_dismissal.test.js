'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const content = require('../libs/content-domain');

function managerFor(responses) {
  const calls = [];
  return { calls, async query(sql, params) {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    assert.ok(calls.length <= responses.length, 'unexpected query');
    return responses[calls.length - 1];
  } };
}

test('dismissal locks a live popup and stores its account plus event atomically', async () => {
  const manager = managerFor([[{ id: 81 }], [], { affectedRows: 1 }, { insertId: 109 }]);
  const result = await content.dismissAnnouncement(manager, { userId: 7, announcementId: 81, now: 1000 });
  assert.deepEqual(result, { id: 81, dismissed: true, eventId: '109' });
  assert.match(manager.calls[0].sql, /is_active=1 AND level IN \('important','warning'\)/);
  assert.match(manager.calls[0].sql, /start_time<=\?.*end_time>=\?.*FOR UPDATE/);
  assert.deepEqual(manager.calls[0].params, [81, 1000, 1000]);
  assert.deepEqual(manager.calls[1].params, [7, 81]);
  assert.deepEqual(manager.calls[2].params, [7, 81, 1000]);
  assert.equal(manager.calls[3].params[0], 'announcements:user:7');
  assert.equal(manager.calls[3].params[3], 7);
});

test('retrying a dismissed announcement makes no duplicate write or event', async () => {
  const manager = managerFor([[{ id: 81 }], [{ dismissed_at: 900 }]]);
  assert.deepEqual(await content.dismissAnnouncement(manager, { userId: 7, announcementId: 81, now: 1000 }),
    { id: 81, dismissed: true, eventId: null });
  assert.equal(manager.calls.length, 2);
});

test('invalid or unavailable announcements cannot create dismissal records', async () => {
  for (const id of [0, -1, 'bad', 1.5]) {
    const manager = managerFor([]);
    await assert.rejects(content.dismissAnnouncement(manager, { userId: 7, announcementId: id, now: 1000 }),
      error => error.code === 'VALIDATION_FAILED' && error.statusCode === 422);
    assert.equal(manager.calls.length, 0);
  }
  const manager = managerFor([[]]);
  await assert.rejects(content.dismissAnnouncement(manager, { userId: 7, announcementId: 81, now: 1000 }),
    error => error.code === 'ANNOUNCEMENT_NOT_FOUND' && error.statusCode === 404);
  assert.equal(manager.calls.length, 1);
});

function routesFor(connection) {
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    app[method] = (paths, handler) => {
      for (const route of [].concat(paths)) routes.set(method + ' ' + route, handler);
    };
  }
  const api = {
    parseLimit: () => 2, decodeCursor: () => null, encodeCursor: value => String(value),
    ensureFoundationSchema: async () => {},
    send: (res, data) => { res.statusCode = 200; res.data = data; },
    fail: (res, status, code) => { res.statusCode = status; res.code = code; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../modules/_api_v2_content_domain.js'), 'utf8'), {
    app, syzoj: { utils: { apiV2: api, markdown: async text => '<p>' + text + '</p>' } },
    require: name => {
      if (name === 'typeorm') return { getConnection: () => connection };
      if (name === '../libs/content-domain') return content;
      if (name === '../libs/user-mentions') return { linkUserMentions: async html => html };
      return require(name);
    }
  });
  return async (route, userId, request = {}) => {
    const res = { locals: { user: userId ? { id: userId } : null, apiMeta: {} } };
    await routes.get(route)({ params: { id: '81' }, query: {}, body: {}, ...request }, res);
    return res;
  };
}

test('announcement list retains dismissed content but personalizes only the current page and account', async () => {
  const calls = [];
  const invoke = routesFor({ async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('FROM announcement_dismissal')) {
      assert.deepEqual(Array.from(params.slice(1)), [81, 82]);
      return params[0] === 7 ? [{ announcement_id: 81 }] : [];
    }
    return [81, 82, 83].map(id => ({ id, title: 'Notice ' + id, content: 'body', level: 'important', public_time: 1000 }));
  } });
  const first = await invoke('get /api/v2/announcements', 7);
  assert.deepEqual(Array.from(first.data, row => [row.id, row.dismissed]), [[81, true], [82, false]]);
  assert.equal(first.locals.apiMeta.next_cursor, '2');
  const other = await invoke('get /api/v2/announcements', 8);
  assert.ok(other.data.every(row => row.dismissed === false));
  const beforeGuest = calls.length;
  const guest = await invoke('get /api/v2/announcements', null);
  assert.ok(guest.data.every(row => row.dismissed === false));
  assert.equal(calls.length - beforeGuest, 1, 'guest read never loads account preferences');
  assert.deepEqual(calls.filter(call => call.sql.includes('FROM announcement_dismissal')).map(call => call.params[0]), [7, 8]);
});

test('dismissal API requires login and ignores client-supplied account IDs', async () => {
  const manager = managerFor([[{ id: 81 }], [], { affectedRows: 1 }, { insertId: 109 }]);
  let transactions = 0;
  const invoke = routesFor({ transaction: async work => { transactions++; return work(manager); } });
  const guest = await invoke('post /api/v2/announcements/:id/dismiss', null);
  assert.equal(guest.statusCode, 401);
  assert.equal(transactions, 0);
  const saved = await invoke('post /api/v2/announcements/:id/dismiss', 7, { body: { user_id: 8 } });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.data.dismissed, true);
  assert.equal(transactions, 1);
  assert.equal(manager.calls[2].params[0], 7);
});
