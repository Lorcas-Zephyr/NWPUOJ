'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const library = require('../libs/legal-documents');
const { etagFor } = require('../libs/api-v2');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

function fixture() {
  const routes = new Map(), writes = [], audits = [];
  let bundle = library.createLegalService().bundle, conflict = false;
  const api = {
    etagFor, ensureFoundationSchema: async () => {},
    setResourceEtag: (res, value) => res.setHeader('ETag', etagFor(value)),
    send: (res, data) => { res.body = { data, meta: { ...res.locals.apiMeta, etag: etagFor(data) } }; return res; },
    fail: (res, status, code, message) => { res.statusCode = status; res.body = { error: { code, message } }; return res; }
  };
  const service = {
    refresh: async () => bundle,
    publishDocument: async (slug, content, revision, actorId, audit) => {
      assert.equal(revision, bundle.revision);
      if (conflict) throw Object.assign(new Error('conflict under lock'), { statusCode: 412, code: 'ETAG_MISMATCH' });
      writes.push({ slug, content, revision, actorId });
      bundle = { ...bundle, revision: 'b'.repeat(64), documents: bundle.documents.map(doc => doc.slug === slug ? { ...doc, markdown: content } : doc) };
      const manager = { fixtureTransaction: true };
      const auditEventId = await audit(manager, { slug, to_revision: bundle.revision });
      return { bundle, changed: true, auditEventId };
    }
  };
  const context = {
    require: () => library, ErrorMessage: Error,
    app: Object.fromEntries(['get', 'patch'].map(method => [method, (route, handler) => routes.set(method + ' ' + route, handler)])),
    syzoj: { log: () => {}, utils: { apiV2: api, legalDocuments: service, operationReason: (_req, fallback) => fallback,
      authorizationV2: { ensureSchema: async () => {}, recordAudit: async (req, event, manager) => {
        assert.equal(manager.fixtureTransaction, true); audits.push(event); return 'audit-fixture';
      } }
    } }
  };
  vm.runInNewContext(read('modules/_legal_document_editor.js'), context);
  async function call(method, route, options = {}) {
    const res = { statusCode: 200, headers: {}, locals: { user: options.user || null, isSiteOwner: !!options.owner },
      status(code) { this.statusCode = code; return this; },
      setHeader(key, value) { this.headers[key] = value; },
      render(template, locals) { this.template = template; this.view = locals; return this; }
    };
    const req = { params: { slug: options.slug || 'terms' }, body: options.body || {}, get: name => options.headers && options.headers[name], res };
    await routes.get(method + ' ' + route)(req, res);
    return res;
  }
  return { call, writes, audits, conflict: () => { conflict = true; }, service };
}

const admin = { id: 101, is_admin: true };
const endpoints = [['get', '/legal/:slug/edit'], ['get', '/api/v2/admin/legal/:slug'], ['patch', '/api/v2/admin/legal/:slug']];

test('editor page and APIs independently reject guests and scoped managers', async () => {
  const f = fixture();
  for (const [method, route] of endpoints) {
    assert.equal((await f.call(method, route)).statusCode, 401);
    for (const privileges of [[], ['manage_problem'], ['manage_contest'], ['manage_user']]) {
      assert.equal((await f.call(method, route, { user: { id: 102, privileges } })).statusCode, 403);
    }
  }
  assert.equal(f.writes.length, 0);
});

test('all four pages allow only site administrators and the owner, with escaped initial content and ETag', async () => {
  const f = fixture();
  for (const { slug } of library.DOCUMENTS) {
    for (const actor of [{ user: admin }, { user: { id: 103 }, owner: true }]) {
      const page = await f.call('get', '/legal/:slug/edit', { ...actor, slug });
      assert.equal(page.statusCode, 200);
      assert.equal(page.template, 'legal_edit');
      assert.equal(page.headers['Cache-Control'], 'private, no-store');
      assert.equal(page.view.legalPage.slug, slug);
      assert.equal(page.view.legalEtag, etagFor(page.view.legalPage));
    }
  }
  assert.match(read('views/legal_edit.ejs'), /<%= legalPage.content %>/);
  assert.equal((await f.call('get', '/legal/:slug/edit', { user: admin, slug: 'unknown' })).statusCode, 404);
});

test('JSON-only If-Match works, response ETag is reusable, and audits share the publication transaction', async () => {
  const f = fixture();
  const initial = await f.call('get', '/api/v2/admin/legal/:slug', { user: admin });
  const saved = await f.call('patch', '/api/v2/admin/legal/:slug', { user: admin,
    body: { content: '## 测试正文', if_match: initial.body.meta.etag } });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.data.content, '## 测试正文');
  assert.equal(saved.body.meta.audit_event_id, 'audit-fixture');
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].actorId, admin.id);
  assert.equal(f.audits[0].action, 'admin:legal.update');
  assert.equal(f.audits[0].resourceId, 'terms');
  const current = await f.call('get', '/api/v2/admin/legal/:slug', { user: admin });
  assert.equal(saved.body.meta.etag, current.body.meta.etag);
  const again = await f.call('patch', '/api/v2/admin/legal/:slug', { user: admin,
    headers: { 'If-Match': saved.body.meta.etag }, body: { content: '## 第二次' } });
  assert.equal(again.statusCode, 200);
});

test('missing, stale and concurrently changed versions are rejected without writes', async () => {
  const f = fixture();
  assert.equal((await f.call('patch', '/api/v2/admin/legal/:slug', { user: admin })).statusCode, 428);
  assert.equal((await f.call('patch', '/api/v2/admin/legal/:slug', { user: admin, body: { if_match: 'stale' } })).statusCode, 412);
  assert.equal((await f.call('patch', '/api/v2/admin/legal/:slug', { user: admin, slug: 'unknown' })).statusCode, 404);
  const current = await f.call('get', '/api/v2/admin/legal/:slug', { user: admin });
  f.conflict();
  assert.equal((await f.call('patch', '/api/v2/admin/legal/:slug', { user: admin,
    body: { if_match: current.body.meta.etag, content: 'changed' } })).statusCode, 412);
  assert.equal(f.writes.length, 0);
});

test('public page button uses the same permission boundary for each document', async () => {
  for (const slug of library.DOCUMENTS.map(doc => doc.slug)) {
    for (const actor of [null, { id: 2, is_admin: false }, { id: 3, privileges: ['manage_problem'] }, admin]) {
      let handler;
      vm.runInNewContext(read('modules/_legal_documents.js'), {
        require: () => ({ ...library, createLegalService: () => library.createLegalService() }),
        app: { get: (_route, fn) => { handler = fn; } }, ErrorMessage: Error,
        syzoj: { utils: { markdown: async value => value }, log: () => {} }
      });
      let view;
      await handler({ params: { slug }, query: {} }, {
        locals: { user: actor }, setHeader: () => {}, render: (_template, data) => { view = data; }
      });
      assert.equal(view.legalCanEdit, actor === admin);
    }
  }
});

test('editing routes load after security foundation and the shared editor supplies CSRF headers', () => {
  const order = read('module-order.js');
  assert.ok(order.indexOf("'_api_v2_foundation.js'") < order.indexOf("'_legal_document_editor.js'"));
  assert.ok(order.indexOf("'_api_v2_authorization.js'") < order.indexOf("'_legal_document_editor.js'"));
  assert.match(read('views/legal_edit.ejs'), /if_match: etag/);
  assert.match(read('views/app_footer.ejs'), /X-CSRF-Token/);
});
