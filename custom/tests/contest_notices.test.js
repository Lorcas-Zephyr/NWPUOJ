'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../modules/_contest_notices.js'), 'utf8');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function harness() {
  const now = Math.floor(Date.now() / 1000);
  const contest = { id: 7, holder_id: 2, is_public: true, start_time: now - 100, end_time: now + 600 };
  const rows = [];
  const cursors = new Map();
  const registered = new Set([3, 4]);
  const routes = new Map();
  const audits = [];
  const events = [];
  const schema = [];
  let exists = true;
  let failAudit = false;
  const database = {
    async query(sql, args = []) {
      if (sql.startsWith('CREATE TABLE')) { schema.push(sql); return []; }
      if (sql.startsWith('SELECT id,holder_id FROM contest')) return exists ? [contest] : [];
      if (sql.startsWith('SELECT id FROM contest_player')) return registered.has(args[1]) ? [{ id: args[1] }] : [];
      if (sql.startsWith('SELECT last_notice_id')) return cursors.has(args[1]) ? [{ last_notice_id: cursors.get(args[1]) }] : [];
      if (sql.startsWith('SELECT * FROM contest_notice')) return rows.filter(row => row.contest_id === args[0] && row.publish_token === args[1]);
      if (sql.startsWith('SELECT id FROM contest_notice')) return rows.filter(row => row.contest_id === args[0] && row.id === args[1]);
      if (sql.startsWith('SELECT id,content,published_at FROM contest_notice')) {
        let result = rows.filter(row => row.contest_id === args[0]);
        if (sql.includes('id<?')) result = result.filter(row => row.id < args[1]);
        if (sql.includes('id>?')) result = result.filter(row => row.id > args[1]);
        result = result.slice().sort((a, b) => sql.includes('DESC') ? b.id - a.id : a.id - b.id);
        return result.slice(0, sql.includes('LIMIT 51') ? 51 : 50);
      }
      if (sql.startsWith('INSERT INTO contest_notice (')) {
        const id = rows.length + 1;
        rows.push({ id, contest_id: args[0], author_id: args[1], content: args[2], publish_token: args[3], published_at: args[4] });
        return { insertId: id };
      }
      if (sql.startsWith('INSERT INTO contest_notice_read')) {
        cursors.set(args[1], Math.max(cursors.get(args[1]) || 0, args[2])); return {};
      }
      throw new Error('Unexpected SQL: ' + sql);
    },
    async transaction(work) {
      const length = rows.length;
      try { return await work(database); } catch (error) { rows.splice(length); throw error; }
    }
  };
  const authorize = async (user, action, resource, options) => {
    assert.equal(action, 'contest:edit');
    assert.equal(resource.scope, 'contest:7');
    assert.equal(options.scope, resource.scope);
    return !!user && (user.is_admin || user.siteOwner || (user.contestManager && user.id === resource.ownerId));
  };
  const context = {
    require(name) {
      if (name === 'typeorm') return { getConnection: () => database };
      if (name === '../libs/content-domain') return { appendEvent: async (manager, event) => { assert.equal(manager, database); events.push(event); } };
      throw new Error(name);
    },
    app: { get: (url, handler) => routes.set('GET ' + url, handler), post: (url, handler) => routes.set('POST ' + url, handler) },
    syzoj: {
      model: () => ({ findById: async id => exists && id === contest.id ? contest : null }), log() {},
      utils: {
        authorizationV2: { authorize, recordAudit: async (req, input, manager) => { assert.equal(manager, database); if (failAudit) throw new Error('audit failed'); audits.push(input); return 1; } },
        apiV2: { ensureFoundationSchema: async () => {}, send: (res, data, status = 200) => Object.assign(res, { status, data }),
          fail: (res, status, code, message) => Object.assign(res, { status, error: { code, message } }) }
      }
    }
  };
  vm.runInNewContext(source, context);
  async function call(method, suffix, user, body, query) {
    const res = { locals: { user, apiMeta: {} }, set() {}, status(code) { this.status = code; return this; }, render(view, data) { this.view = view; this.data = data; return this; } };
    const params = { id: '7', noticeId: '1' };
    const route = suffix.startsWith('/contest/') ? suffix : '/api/v2/contests/:id/notices' + suffix;
    await routes.get(method + ' ' + route)({ params, query: query || {}, body: body || {} }, res);
    return res;
  }
  return { call, contest, rows, cursors, registered, schema, audits, events,
    removeContest: () => { exists = false; }, failAudit: () => { failAudit = true; } };
}

const owner = { id: 2, contestManager: true };
const player = { id: 3 };
const temporary = { id: 4, temporary_contest: 7 };
const content = '<img src=x onerror=alert(1)>\n**纯文本**';
const payload = { content, publish_token: 'test-token-abcdefghijkl' };

test('only scoped contest managers, site administrators and site owner can publish', async () => {
  const h = harness();
  for (const user of [null, player, temporary, { id: 5, contestManager: true }]) {
    const response = await h.call('POST', '', user, payload);
    assert.equal(response.status, user ? 403 : 401);
  }
  for (const user of [owner, { id: 5, is_admin: true }, { id: 1, siteOwner: true }]) {
    assert.equal((await h.call('POST', '', user, { ...payload, publish_token: payload.publish_token + user.id })).status, 201);
  }
  assert.equal(h.rows.length, 3);
  assert.equal(h.audits.length, 3);
  assert.equal(h.events.length, 3);
  assert.equal(h.rows[0].content, content);
});

test('public history is visible to visitors; hidden contests and management pages enforce scope', async () => {
  const h = harness();
  assert.equal((await h.call('GET', '', null)).status, 200);
  assert.equal((await h.call('GET', '/contest/:id/notices', owner)).view, 'contest_notices');
  assert.equal((await h.call('GET', '/contest/:id/notices', player)).status, 403);
  h.contest.is_public = false;
  assert.equal((await h.call('GET', '', null)).status, 401);
  assert.equal((await h.call('GET', '', player)).status, 403);
  assert.equal((await h.call('GET', '', owner)).status, 200);
  h.removeContest();
  assert.equal((await h.call('GET', '', owner)).status, 404);
});

test('empty/oversized/non-text content and invalid publish tokens are rejected', async () => {
  const h = harness();
  for (const value of ['', '   \n ', 'a'.repeat(4001), 3, { text: 'x' }]) {
    assert.equal((await h.call('POST', '', owner, { ...payload, content: value })).status, 422);
  }
  assert.equal((await h.call('POST', '', owner, { content: 'test' })).status, 422);
  assert.equal(h.rows.length, 0);
});

test('stable body tokens deduplicate publish retries even without If-Match/custom headers', async () => {
  const h = harness();
  assert.equal((await h.call('POST', '', owner, payload)).status, 201);
  assert.equal((await h.call('POST', '', owner, payload)).status, 200);
  assert.equal(h.rows.length, 1);
  assert.equal(h.audits.length, 1);
  assert.equal((await h.call('POST', '', owner, { ...payload, content: 'changed' })).status, 409);
  assert.equal((await h.call('POST', '', { id: 9, is_admin: true }, payload)).status, 409);
});

test('notice and audit/event persistence form one transaction', async () => {
  const h = harness();
  h.failAudit();
  assert.equal((await h.call('POST', '', owner, payload)).status, 500);
  assert.equal(h.rows.length, 0);
  assert.equal(h.events.length, 0);
});

test('ordinary and temporary contestants receive ordered unread notices only during the contest', async () => {
  const h = harness();
  await h.call('POST', '', owner, payload);
  await h.call('POST', '', owner, { ...payload, publish_token: payload.publish_token + '-2' });
  for (const user of [player, temporary]) {
    const response = await h.call('GET', '/unread', user);
    assert.equal(response.data.active, true);
    assert.deepEqual(Array.from(response.data.items, x => x.id), [1, 2]);
  }
  for (const user of [owner, { id: 77 }]) assert.equal((await h.call('GET', '/unread', user)).data.active, false);
  assert.equal((await h.call('GET', '/unread', null)).status, 401);
  h.contest.start_time += 500;
  assert.equal((await h.call('GET', '/unread', player)).data.items.length, 0);
  h.contest.start_time -= 500;
  h.contest.end_time -= 1000;
  assert.equal((await h.call('GET', '/unread', player)).data.items.length, 0);
  assert.equal((await h.call('GET', '', player)).data.items.length, 2);
});

test('read acknowledgements persist per contestant and do not acknowledge another contest', async () => {
  const h = harness();
  await h.call('POST', '', owner, payload);
  assert.equal((await h.call('POST', '/:noticeId/read', player)).status, 200);
  assert.equal((await h.call('POST', '/:noticeId/read', player)).status, 200);
  assert.equal((await h.call('GET', '/unread', player)).data.items.length, 0);
  assert.equal((await h.call('GET', '/unread', temporary)).data.items.length, 1);
  assert.equal((await h.call('POST', '/:noticeId/read', { id: 77 })).status, 403);
  h.rows[0].contest_id = 8;
  assert.equal((await h.call('POST', '/:noticeId/read', temporary)).status, 404);
  assert.match(source, /GREATEST\(last_notice_id,VALUES\(last_notice_id\)\)/);
});

test('live registration removal stops popups and acknowledgements immediately', async () => {
  const h = harness();
  await h.call('POST', '', owner, payload);
  h.registered.delete(player.id);
  assert.equal((await h.call('GET', '/unread', player)).data.active, false);
  assert.equal((await h.call('POST', '/:noticeId/read', player)).status, 403);
});

test('history uses bounded keyset pagination without exposing publisher identity or tokens', async () => {
  const h = harness();
  for (let i = 0; i < 55; i++) await h.call('POST', '', owner, { ...payload, publish_token: payload.publish_token + i });
  const first = (await h.call('GET', '', null)).data;
  assert.equal(first.items.length, 50);
  assert.equal(first.items[0].id, 55);
  assert.equal(first.next_before_id, 6);
  assert.deepEqual(Object.keys(first.items[0]).sort(), ['content', 'id', 'published_at']);
  const last = (await h.call('GET', '', null, null, { before_id: '6' })).data;
  assert.deepEqual(Array.from(last.items, x => x.id), [5, 4, 3, 2, 1]);
  assert.equal(last.next_before_id, null);
  assert.equal((await h.call('GET', '', null, null, { before_id: '-1' })).status, 422);
});

test('contest/user deletion cascades only the appropriate notice records', async () => {
  const h = harness();
  await h.call('GET', '', null);
  assert.equal(h.schema.length, 2);
  assert.match(h.schema[0], /REFERENCES contest\(id\) ON DELETE CASCADE/);
  assert.match(h.schema[0], /REFERENCES user\(id\) ON DELETE SET NULL/);
  assert.match(h.schema[1], /REFERENCES user\(id\) ON DELETE CASCADE/);
});

test('UI is plain text, separate from announcements, and includes retry-safe confirmation', () => {
  const editor = read('views/contest_notices.ejs');
  const client = read('contest-notices.js');
  for (const file of ['views/contest_edit.ejs', 'views/contest_registrations.ejs']) assert.match(read(file), /'notices'\]\).*发布通知/);
  const details = read('views/contest_details.ejs');
  assert.match(details, /include contest_notice_table/);
  assert.ok(details.indexOf('include contest_notice_table') > details.lastIndexOf('</section>'), 'contest notices belong below information and announcements');
  assert.match(read('views/app_footer.ejs'), /include contest_notice_client/);
  assert.match(editor, /textarea.*maxlength="4000"/);
  assert.doesNotMatch(editor, /include markdown|modern-editor|allow_markdown/);
  assert.doesNotMatch(client, /innerHTML/);
  assert.match(client, /textContent = notice.content/);
  assert.match(client, /pending.content !== content/);
  assert.match(client, /readThrough = Math.max\(readThrough, noticeId\)/);
  assert.match(client, /data.items.find/);
  assert.match(client, /visibilitychange/);
  assert.match(client, /addEventListener\('storage'/);
});
