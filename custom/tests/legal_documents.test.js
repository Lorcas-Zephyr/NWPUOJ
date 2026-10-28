'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DOCUMENTS, readBundle, registrationPolicy, validateRegistrationAcknowledgement, createLegalService } = require('../libs/legal-documents');
const { temporaryRoute } = require('../libs/contest-temp-accounts');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

function fixture(t, overrides = {}, connection) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nwpuoj-legal-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(read('content/legal/manifest.json'));
  Object.assign(manifest, { status: 'approved', review_pending: [], effective_date: '2026-01-01', guardian_consent_status: 'ready', publication_basis: 'fully_reviewed', implementation_pending: [] }, overrides);
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  for (const item of DOCUMENTS) fs.copyFileSync(path.join(root, 'content/legal', item.slug + '.md'), path.join(directory, item.slug + '.md'));
  return { directory, service: createLegalService({ directory, connection }) };
}

function acceptance(policy) {
  return { terms_accepted: true, privacy_acknowledged: true, legal_version: policy.version };
}

test('draft fixture allows minors subject to guardian arrangements and creates no schema', async t => {
  let calls = 0;
  const { service } = fixture(t, { status: 'draft', effective_date: null, guardian_consent_status: 'pending' }, () => { calls++; throw new Error('must not connect'); });
  assert.equal(service.bundle.manifest.status, 'draft');
  assert.equal(service.bundle.manifest.operator, '西北工业大学程序设计创新实践基地');
  assert.equal(service.bundle.manifest.contact_email, 'npuicpc@163.com');
  assert.equal(service.bundle.manifest.allow_under_14, true);
  assert.equal(service.bundle.manifest.guardian_consent_status, 'pending');
  assert.equal(service.registrationPolicy().enabled, false);
  assert.equal(service.validateRegistration({}), null);
  await service.persistAcknowledgement(null, 1, null);
  assert.equal(await service.getBundle('a'.repeat(64)), null);
  assert.equal(calls, 0);
});

test('operator-approved publication preserves pending implementation and never invents guardian consent', () => {
  const service = createLegalService();
  const manifest = service.bundle.manifest;
  assert.equal(manifest.status, 'approved');
  assert.equal(manifest.version, '2026-10-16.1');
  assert.equal(manifest.effective_date, '2026-10-16');
  assert.equal(manifest.publication_basis, 'operator_approved_current_state');
  assert.equal(manifest.guardian_consent_status, 'pending');
  assert.ok(manifest.implementation_pending.includes('guardian_consent'));
  assert.deepEqual(manifest.review_pending, []);
  const policy = registrationPolicy(service.bundle, Date.parse('2026-10-16T00:00:00+08:00'));
  assert.equal(policy.enabled, true);
  assert.deepEqual(validateRegistrationAcknowledgement(acceptance(policy), policy), acceptance(policy));
  for (const item of DOCUMENTS) assert.doesNotMatch(read('content/legal/' + item.slug + '.md'), /本节待审核|本稿为待审核|方可发布生效版|正式生效前落实/);
});

test('approval requires a real date and no unresolved checklist items', t => {
  assert.throws(() => fixture(t, { review_pending: ['未确认'] }), /completed review/);
  assert.throws(() => fixture(t, { effective_date: null }), /effective date/);
  assert.throws(() => fixture(t, { effective_date: '2026-02-30' }), /effective date/);
  assert.throws(() => fixture(t, { guardian_consent_status: 'pending' }), /completed review/);
  assert.throws(() => fixture(t, { guardian_consent_status: 'pending', publication_basis: 'operator_approved_current_state', publication_approved_on: '2026-01-01', implementation_pending: [] }), /completed review/);
  assert.throws(() => fixture(t, { guardian_consent_status: 'pending', publication_basis: 'operator_approved_current_state', publication_approved_on: '2025-12-31', implementation_pending: ['guardian_consent'] }), /completed review/);
  const { service } = fixture(t, { effective_date: '2026-11-01' });
  assert.equal(registrationPolicy(service.bundle, Date.parse('2026-10-31T15:59:59Z')).enabled, false);
  assert.equal(registrationPolicy(service.bundle, Date.parse('2026-10-31T16:00:00Z')).enabled, true);
});

test('unchecked, string booleans and missing notices are rejected without an age declaration', t => {
  const { service } = fixture(t);
  const policy = service.registrationPolicy();
  assert.equal(policy.enabled, true);
  for (const field of ['terms_accepted', 'privacy_acknowledged']) {
    for (const value of [undefined, false, 'true', 'false', 'on', 1, []]) {
      assert.throws(() => service.validateRegistration({ ...acceptance(policy), [field]: value }), error => error.statusCode === 422);
    }
  }
  assert.throws(() => service.validateRegistration({}), /阅读/);
  assert.deepEqual(service.validateRegistration(acceptance(policy)), acceptance(policy));
});

test('stale versions are rejected and optional consents are never inferred or persisted', t => {
  const { service } = fixture(t);
  const values = acceptance(service.registrationPolicy());
  assert.throws(() => service.validateRegistration({ ...values, legal_version: 'old' }), /版本已更新/);
  const receipt = service.validateRegistration({ ...values, marketing_consent: true, third_party_consent: true, guardian_consent: true, age_confirmed: false, ip: '1.2.3.4', birth_date: '2000-01-01' });
  assert.deepEqual(receipt, values);
  assert.equal(Object.isFrozen(receipt), true);
});

test('content and manifest changes invalidate versions; all four document hashes are stable', t => {
  const { directory, service } = fixture(t);
  const original = service.bundle;
  assert.deepEqual(readBundle(directory), original);
  fs.appendFileSync(path.join(directory, 'terms.md'), '\n审核修订\n');
  const revised = readBundle(directory);
  assert.notEqual(revised.revision, original.revision);
  assert.notEqual(revised.documents[0].sha256, original.documents[0].sha256);
  assert.throws(() => validateRegistrationAcknowledgement(acceptance(service.registrationPolicy()), registrationPolicy(revised)), /版本已更新/);
});

test('receipt schema retries safely and persists only server revision, flags, user and time', async t => {
  const sql = [];
  let fail = true;
  const connection = () => ({ query: async statement => { if (fail) { fail = false; throw new Error('temporary'); } sql.push(statement); return []; } });
  const { service } = fixture(t, {}, connection);
  await assert.rejects(service.ensureSchema(), /temporary/);
  await service.ensureSchema();
  await service.ensureSchema();
  assert.equal(sql.length, 2);
  const writes = [];
  await service.persistAcknowledgement({ query: async (query, parameters) => { writes.push({ query, parameters }); } }, 42, acceptance(service.registrationPolicy()));
  assert.equal(writes.length, 2);
  assert.match(writes[0].query, /INSERT IGNORE INTO site_legal_revision/);
  assert.equal(writes[0].parameters[3], service.bundle.snapshot);
  assert.match(writes[1].query, /user_legal_acknowledgement/);
  assert.deepEqual(writes[1].parameters.slice(0, 2), [42, service.bundle.revision]);
  assert.ok(Number.isInteger(writes[1].parameters[2]));
  assert.doesNotMatch(sql.join(' '), /ip_address|birth_date|user_agent|password|age_at_least|guardian_consent/i);
});

function accountHarness(service, failReceipt = false) {
  const committed = [], published = [];
  const manager = { query: async (sql, args) => { if (failReceipt && /INSERT INTO user_legal_acknowledgement/.test(sql)) throw new Error('receipt unavailable'); return { insertId: /INSERT INTO user\s/.test(sql) ? 42 : 5 }; } };
  const connection = { transaction: async action => {
    const staged = [];
    await action({ query: async (sql, args) => { const result = await manager.query(sql, args); staged.push({ sql, args }); return result; } });
    committed.push(...staged);
  } };
  const syzoj = { config: { default: { user: { show: 1, rating: 1500 } } }, utils: {
    legalDocuments: service,
    ensureSiteOwner: async () => {}, ensureAccountStateSchema: async () => {},
    hashPassword: async () => 'fixture-hash', claimSiteOwner: async () => {},
    apiV2: { ensureFoundationSchema: async () => {}, publishEvent: item => published.push(item) }
  } };
  const source = read('modules/_registration_identity.js');
  const context = { syzoj, TypeORM: { getConnection: () => connection }, ensureRegistrationSchema: async () => {}, User: { findById: async id => ({ id }) } };
  vm.runInNewContext(source.slice(source.indexOf('async function createAccount('), source.indexOf('function validRegistrationCsrf(')), context);
  const data = { username: 'fixture', password: 'not-a-real-password', email: 'fixture@example.invalid', identity: { studentId: '2026000000', realName: '测试', college: '测试学院' }, legalAcknowledgement: acceptance(service.registrationPolicy()) };
  return { create: patch => context.createAccount({ ...data, ...patch }), committed, published };
}

test('account and confirmation commit together, new email defaults private, legacy users remain untouched', async t => {
  const { service } = fixture(t, {}, () => ({ query: async () => [] }));
  const h = accountHarness(service);
  assert.equal((await h.create()).id, 42);
  assert.equal(h.published.length, 1);
  assert.match(h.committed.find(row => /INSERT INTO user\s/.test(row.sql)).sql, /VALUES \(\?,\?,\?,0,\?,0,1,\?,\?\)/);
  assert.ok(h.committed.some(row => /INSERT INTO user_legal_acknowledgement/.test(row.sql)));
  assert.ok(h.committed.some(row => /INSERT INTO user_registration_profile/.test(row.sql)));
  assert.ok(h.committed.every(row => !/UPDATE user\b|DELETE FROM user\b/.test(row.sql)));
});

test('receipt failure rolls back account creation, and direct callers cannot skip confirmation', async t => {
  const { service } = fixture(t, {}, () => ({ query: async () => [] }));
  const h = accountHarness(service, true);
  await assert.rejects(h.create(), /receipt unavailable/);
  assert.deepEqual(h.committed, []);
  assert.deepEqual(h.published, []);
  await assert.rejects(h.create({ legalAcknowledgement: null }), /阅读/);
  assert.deepEqual(h.committed, []);
});

test('archive lookup is parameterized, validates hash, and never interprets a path as a file', async t => {
  const { service: old } = fixture(t);
  const { service } = fixture(t, { version: 'next' }, () => ({ query: async (sql, args) => /SELECT snapshot/.test(sql) ? [{ snapshot_json: old.bundle.snapshot }] : [] }));
  assert.equal(await service.getBundle('../privacy'), null);
  assert.equal(await service.getBundle(['terms']), null);
  assert.equal((await service.getBundle(old.bundle.revision)).revision, old.bundle.revision);
  await assert.rejects(service.getBundle('0'.repeat(64)), /integrity/);
});

test('API surfaces field errors and never establishes a session after rejected confirmation', async () => {
  let handler, sessions = 0;
  const context = {
    app: { post: (url, fn) => { assert.equal(url, '/api/v2/auth/register'); handler = fn; } },
    syzoj: { utils: {
      registrationIdentityV2: { validateAccount: async () => { const error = new Error('请先阅读'); error.fields = { terms_accepted: 'required' }; throw error; }, registrationErrorText: error => error.message },
      establishAuthenticatedSession: async () => { sessions++; },
      apiV2: { fail: (res, status, code, message, fields) => ({ status, code, message, fields }) }
    } }
  };
  vm.runInNewContext(read('modules/_api_v2_registration.js'), context);
  const result = await handler({ body: { password: 'abc', confirm_password: 'abc' } }, {});
  assert.equal(result.status, 422);
  assert.equal(result.fields.terms_accepted, 'required');
  assert.equal(sessions, 0);
});

test('all four documents remain readable to temporary accounts without allowing writes or unrelated legal routes', () => {
  for (const item of DOCUMENTS) {
    assert.equal(temporaryRoute('GET', '/legal/' + item.slug + '?version=test').kind, 'session');
    assert.equal(temporaryRoute('HEAD', '/legal/' + item.slug).kind, 'session');
    assert.equal(temporaryRoute('POST', '/legal/' + item.slug), null);
  }
  assert.equal(temporaryRoute('GET', '/legal/registration-preview'), null);
  const order = read('module-order.js');
  assert.ok(order.indexOf("'_legal_documents.js'") < order.indexOf("'_identity_gate.js'"));
});

test('content has two embedded inventories, truthful draft limitations and no blanket authorization', () => {
  const privacy = read('content/legal/privacy.md');
  assert.match(privacy, /个人信息收集清单/);
  assert.match(privacy, /第三方服务清单/);
  assert.match(privacy, /不构成对所有个人信息处理活动的概括性同意/);
  assert.match(privacy, /目前尚未建立统一的自动清理机制/);
  assert.doesNotMatch(privacy, /apikey|api_key|sk-[a-z0-9]{16,}/i);
  assert.match(privacy, /尚未提供监护人同意的核验、记录及撤回功能/);
  for (const document of DOCUMENTS) assert.doesNotMatch(read('content/legal/' + document.slug + '.md'), /一揽子|我们是谁|你的权利|恶意刷提交|不等于把代码|静默改变|不满 14 周岁的人不得注册|不向不满 14 周岁的人提供/);
});

test('one unchecked checkbox uses inline agreement links and never sends an age assertion', () => {
  const view = read('views/sign_up.ejs');
  const boxes = view.match(/<input type="checkbox"[^>]+>/g);
  assert.equal(boxes.length, 1);
  boxes.forEach(box => { assert.doesNotMatch(box, /\bchecked\b/); assert.match(box, /\brequired\b/); });
  assert.match(view, /target="_blank" rel="noopener noreferrer"/);
  assert.match(view, /body\.privacy_acknowledged = form\.elements\.terms_accepted\.checked/);
  const markup = view.replace(/<%[\s\S]*?%>/g, '');
  assert.match(markup, /<label for="registration-terms">我已阅读并同意<a[^>]+>《用户协议》<\/a>，并已阅读<a[^>]+>《隐私政策》<\/a>。<\/label>/);
  assert.doesNotMatch(view, /age_confirmed|registration-age|app-legal-reading-links/);
  assert.match(view, /data-legal-preview/);
  assert.ok(view.indexOf("form.hasAttribute('data-legal-preview')") < view.indexOf("fetch('/api/v2/auth/register'"));
});

test('retention notice matches existing account cleanup without claiming universal anonymization', () => {
  const privacy = read('content/legal/privacy.md');
  const terms = read('content/legal/terms.md');
  const deletion = read('modules/_admin_users.js');
  assert.match(privacy, /不因注销而统一删除历史业务内容/);
  assert.match(privacy, /账户已删除/);
  assert.match(privacy, /不等同于对全部留存内容完成不可逆匿名化/);
  assert.match(privacy, /管理审计仍可能保留原用户名和账户编号/);
  assert.match(terms, /个人参赛及 Rating/);
  assert.match(deletion, /UPDATE judge_state SET user_id=\? WHERE user_id=\?/);
  assert.match(deletion, /UPDATE problem SET user_id=\? WHERE user_id=\?/);
  assert.match(deletion, /DELETE FROM user_registration_profile WHERE user_id=\?/);
  assert.match(deletion, /DELETE FROM contest_player WHERE user_id=\?/);
  assert.match(deletion, /DELETE FROM rating_history WHERE user_id=\?/);
  assert.match(deletion, /details: \{ username: deletedUsername, reassigned_to_user_id: deletedAccountId \}/);
});
