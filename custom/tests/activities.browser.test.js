'use strict';
// Browser fixtures serve only local files and mocked APIs; no live writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); });
const question = { id: 'f_phone', type: 'text', label: '联系方式', required: true, options: [] };
function payload() {
  return { activity: { id: 1, title: '2026 校赛报名', description: '活动简介', mode: 'team', status: 'published', location: '计算机学院', opens_at: Date.now() - 86400000, closes_at: Date.now() + 86400000, starts_at: null, min_members: 2, max_members: 3, require_review: true, fields: [question], revision: 1 }, can_manage: true, user_id: 1, identity: { user_id: 1, username: 'captain', real_name: '队长', student_id: '2026000001', college: '计算机学院' }, identity_error: '', mine: null, invitations: [], server_now: Date.now(), description_html: '<p>活动简介</p>' };
}
function html(mode, manager = true) {
  const template = read('views/activities.ejs').replace('<% include app_header %>', '').replace('<% include app_footer %>', '');
  const code = "const ejs=require('ejs'),fs=require('fs'),x=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(ejs.render(x.template,{activityPage:x.mode,activityId:x.mode==='new'?0:1,activityManager:x.manager}));";
  const r = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', code], { cwd: path.join(root, '..'), input: JSON.stringify({ template, mode, manager }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + ['app-shell.css', 'app-shared.css', 'app-features.css'].map(file => '<link rel="stylesheet" href="/self/' + file + '">').join('') + '<link rel="stylesheet" href="/self/lib/flatpickr-4.6.13/flatpickr.min.css"><script src="/self/lib/flatpickr-4.6.13/flatpickr.min.js"></script><script src="/self/lib/flatpickr-4.6.13/zh.js"></script><script>window.__NWPUOJ_APP={csrfToken:"fixture",user:{id:1}};</script></head><body class="app-v2">' + r.stdout + '<script src="/self/app-v2.js"></script></body></html>';
}
async function fixture(mode = 'detail', tab = 'mine', manager = true) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 1100 } });
  const page = await context.newPage(), failures = [], writes = [];
  const data = payload(); data.can_manage = manager;
  const document = html(mode, manager); let rejectNext = false;
  page.on('pageerror', error => failures.push(error.message));
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname.startsWith('/self/')) { const file = url.pathname.startsWith('/self/lib/') ? 'static-libs/' + url.pathname.slice(10) : url.pathname.split('/').pop(); return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'application/javascript', body: read(file) }); }
    if (url.pathname.startsWith('/fixture')) return route.fulfill({ contentType: 'text/html', body: document });
    if (!url.pathname.startsWith('/api/v2/activities')) return route.fulfill({ status: 404, body: '' });
    if (req.method() !== 'GET') {
      const body = req.postDataJSON(); writes.push({ path: url.pathname, body, headers: req.headers() });
      if (rejectNext) { rejectNext = false; return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { message: '信息已被更新，请刷新页面后重试。' } }) }); }
      if (url.pathname.endsWith('/registrations')) data.mine = { id: 4, leader_id: 1, team_name: body.team_name || '', status: 'draft', revision: 2, members: [{ ...data.identity, ready: false, answers: {} }], invitations: [] };
      if (body.action === 'save') { data.mine.members[0].answers = body.answers; data.mine.members[0].ready = true; data.mine.revision++; }
      if (body.action === 'invite') { data.mine.invitations.push({ id: 8, username: body.username }); data.mine.revision++; }
      if (body.action === 'submit') { data.mine.status = 'pending'; data.mine.revision++; }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { id: 1 } }) });
    }
    if (url.pathname.endsWith('/registrations')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { activity: data.activity, items: [{ id: 4, leader_id: 1, team_name: '<img src=x onerror=alert(1)>', status: 'pending', revision: 7, submitted_at: Date.now(), review_note: '', members: [{ ...data.identity, answers: { f_phone: '123' } }] }], total: 1, page: 1 } }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  await page.goto('http://activity.test/fixture?tab=' + tab);
  if (mode === 'new') await page.locator('[data-add-field]').waitFor(); else await page.locator('[data-activity-title]').filter({ hasText: '2026 校赛报名' }).waitFor();
  return { page, context, failures, writes, data, reject: () => { rejectNext = true; } };
}
test('create form supports both registration modes, ordered fields and 24-hour hour/minute selects', async () => {
  const f = await fixture('new');
  try {
    await f.page.locator('[name="title"]').fill('新校赛');
    await f.page.locator('[name="mode"]').selectOption('team');
    assert.ok(await f.page.locator('[name="min_members"]').isVisible());
    await f.page.locator('[data-add-field]').click();
    await f.page.locator('[data-field-prop="label"]').fill('参赛组别');
    await f.page.locator('[data-field-prop="type"]').selectOption('select');
    await f.page.locator('[data-field-prop="options"]').fill('新生组\n公开组');
    await f.page.locator('[data-add-field]').click();
    await f.page.locator('[data-field-prop="label"]').last().fill('联系方式');
    await f.page.locator('[data-field-move="-1"]').last().click();
    assert.equal(await f.page.locator('[data-field-prop="label"]').first().inputValue(), '联系方式');
    const time = f.page.locator('[name="opens_at"] + input'); await time.click();
    assert.equal(await f.page.locator('.flatpickr-calendar.open [data-datetime-hour] option').count(), 24);
    assert.equal(await f.page.locator('.flatpickr-calendar.open [data-datetime-minute] option').count(), 60);
    await f.page.keyboard.press('Escape');
    await f.page.locator('[data-activity-config] button[type="submit"]').click();
    await f.page.waitForURL('**/activities/1?tab=settings');
    const request = f.writes[0]; assert.equal(request.body.mode, 'team'); assert.equal(request.body.fields[0].label, '联系方式'); assert.equal(request.body.fields[1].options.length, 2);
    assert.equal(request.headers['x-csrf-token'], 'fixture');
    assert.equal(f.failures.length, 0, f.failures.join('\n'));
  } finally { await f.context.close(); }
});
test('team captain creates, saves, invites and sees stale-version errors without losing input', async () => {
  const f = await fixture();
  try {
    await f.page.locator('[data-start-registration] [name="team_name"]').fill('测试队');
    await f.page.locator('[data-start-registration] button').click();
    await f.page.locator('[name="f_phone"]').fill('12345');
    await f.page.locator('[data-save-answers] button').click();
    await f.page.locator('[data-activity-message]').filter({ hasText: '信息已保存' }).waitFor();
    await f.page.locator('[data-invite-member] [name="username"]').fill('teammate');
    await f.page.locator('[data-invite-member] button').click();
    await f.page.getByText('teammate · 等待接受邀请').waitFor();
    const saves = f.writes.filter(item => item.body.action === 'save');
    assert.equal(saves[0].body.revision, 2); assert.equal(saves[0].body.answers.f_phone, '12345');
    await f.page.locator('[name="f_phone"]').fill('67890'); f.reject();
    await f.page.locator('[data-save-answers] button').click();
    await f.page.locator('[data-activity-message]').filter({ hasText: '已被更新' }).waitFor();
    assert.equal(await f.page.locator('[name="f_phone"]').inputValue(), '67890');
    await f.page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(f.failures.length, 0, f.failures.join('\n'));
    await f.page.screenshot({ path: '/tmp/nwpuoj-activity-team-mobile.png', fullPage: true });
  } finally { await f.context.close(); }
});
test('manager roster escapes text, reviews with the displayed revision and exports filtered results', async () => {
  const f = await fixture('detail', 'roster');
  try {
    await f.page.locator('.activity-registration summary').click();
    assert.equal(await f.page.locator('.activity-registration img').count(), 0);
    await f.page.locator('[data-review-id] [name="status"]').selectOption('returned');
    await f.page.locator('[data-review-id] [name="note"]').fill('请核对联系方式');
    await f.page.locator('[data-review-id] button').click();
    await f.page.locator('[data-activity-message]').filter({ hasText: '审核结果已保存' }).waitFor();
    assert.equal(f.writes[0].body.revision, 7); assert.equal(f.writes[0].body.status, 'returned');
    await f.page.locator('[data-roster-search] [name="search"]').fill('captain');
    await f.page.locator('[data-roster-search] button').click();
    await f.page.waitForFunction(() => document.querySelector('[data-roster-export]').href.includes('search=captain'));
    await f.page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(f.failures.length, 0, f.failures.join('\n'));
  } finally { await f.context.close(); }
});
test('ordinary participants never receive management UI', async () => {
  const f = await fixture('detail', 'settings', false);
  try {
    assert.equal(await f.page.locator('[data-activity-config]').count(), 0);
    assert.equal(await f.page.locator('[data-activity-tab="roster"]').count(), 0);
    assert.ok(await f.page.locator('[data-activity-panel="intro"]').isVisible());
  } finally { await f.context.close(); }
});
