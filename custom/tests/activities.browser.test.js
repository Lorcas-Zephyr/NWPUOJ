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
async function fixture(mode = 'detail', tab = 'mine', manager = true, configure = () => {}) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 1100 } });
  const page = await context.newPage(), failures = [], writes = [];
  const data = payload(); data.can_manage = manager; configure(data);
  const document = html(mode, manager); let rejectNext = false;
  page.on('pageerror', error => failures.push(error.message));
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname.startsWith('/self/')) { const file = url.pathname.startsWith('/self/lib/') ? 'static-libs/' + url.pathname.slice(10) : url.pathname.split('/').pop(); return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'application/javascript', body: read(file) }); }
    if (url.pathname.startsWith('/fixture')) return route.fulfill({ contentType: 'text/html', body: document });
    if (!url.pathname.startsWith('/api/v2/activities')) return route.fulfill({ status: 404, body: '' });
    if (req.method() !== 'GET') {
      const body = req.postDataJSON(); writes.push({ path: url.pathname, method: req.method(), body, headers: req.headers() });
      if (rejectNext) { rejectNext = false; return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { message: '信息已被更新，请刷新页面后重试。' } }) }); }
      if (url.pathname.endsWith('/registrations')) data.mine = { id: 4, leader_id: 1, team_name: body.team_name || '', status: 'draft', revision: 2, members: [{ ...data.identity, ready: false, answers: {} }], invitations: [] };
      if (body.action === 'save' || body.action === 'submit') { data.mine.members[0].answers = body.answers; data.mine.members[0].ready = true; data.mine.revision++; }
      if (body.action === 'invite') { data.mine.invitations.push({ id: 8, username: body.username }); data.mine.revision++; }
      if (url.pathname.includes('/invitations/') && body.action === 'accept') { data.mine = {id: 4, leader_id: 2, team_name: '邀请队伍', status: 'draft', revision: 3, members: [{...data.identity, answers: {}, ready: false}, {user_id: 2, username: 'leader', ready: true}], invitations: []}; data.invitations = []; }
      if (body.submit) { data.mine.members[0].answers = body.answers; data.mine.members[0].ready = true; data.mine.status = data.activity.require_review ? 'pending' : 'approved'; }
      if (body.action === 'submit') { data.mine.status = 'pending'; data.mine.revision++; }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { id: 1 } }) });
    }
    if (url.pathname === '/api/v2/activities') { const items = [{...data.activity}, {...data.activity,id:2,title:'个人交流会',mode:'individual',status:'closed'}].filter(a => (!url.searchParams.get('search') || a.title.includes(url.searchParams.get('search'))) && (url.searchParams.get('scope') !== 'open' || a.status === 'published')); return route.fulfill({json:{data:{items,total:items.length,page:1,server_now:Date.now()}}}); }
    if (url.pathname.endsWith('/registrations')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { activity: data.activity, summary: {pending: 1, approved: 4, draft: 2, returned: 0}, items: [{ id: 4, leader_id: 1, team_name: '<img src=x onerror=alert(1)>', status: 'pending', revision: 7, submitted_at: Date.now(), review_note: '', members: [{ ...data.identity, answers: { f_phone: '123' } }] }], total: 1, page: 1 } }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  await page.goto('http://activity.test/fixture?tab=' + tab);
  if (mode === 'new') await page.locator('[data-config-step="0"]').waitFor(); else if (mode === 'list') await page.locator('.activity-list-row').first().waitFor(); else await page.locator('[data-activity-title]').filter({ hasText: '2026 校赛报名' }).waitFor();
  return { page, context, failures, writes, data, reject: () => { rejectNext = true; } };
}
test('create form supports both registration modes, ordered fields and 24-hour hour/minute selects', async () => {
  const f = await fixture('new');
  try {
    await f.page.locator('[data-activity-config] [name="title"]').fill('新校赛');
    await f.page.locator('[data-config-next]').click();
    await f.page.getByRole('radio', {name: '组队报名'}).check();
    assert.ok(await f.page.locator('[name="min_members"]').isVisible());
    await f.page.locator('[data-config-next]').click();
    await f.page.locator('[data-add-field]').click();
    await f.page.locator('[data-field-prop="label"]').fill('参赛组别');
    await f.page.locator('[data-field-prop="type"]').selectOption('select');
    await f.page.locator('[data-field-prop="options"]').fill('新生组\n公开组');
    await f.page.locator('[data-add-field]').click();
    await f.page.locator('[data-field-prop="label"]').last().fill('联系方式');
    await f.page.locator('[data-field-move="-1"]').last().click();
    assert.equal(await f.page.locator('[data-field-prop="label"]').first().inputValue(), '联系方式');
    await f.page.locator('[data-config-prev]').click();
    const time = f.page.locator('[name="opens_at"] + input'); await time.click();
    assert.equal(await f.page.locator('.flatpickr-calendar.open [data-datetime-hour] option').count(), 24);
    assert.equal(await f.page.locator('.flatpickr-calendar.open [data-datetime-minute] option').count(), 60);
    await f.page.keyboard.press('Escape');
    await f.page.locator('[data-config-next]').click();
    await f.page.locator('[data-config-next]').click();
    await f.page.locator('[data-activity-config] button[type="submit"]').click();
    await f.page.waitForURL('**/activities/1');
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
    await f.page.locator('[data-save-answers] [name="f_phone"]').fill('12345');
    await f.page.locator('[data-save-answers] button').click();
    await f.page.locator('[data-activity-message]').filter({ hasText: '信息已保存' }).waitFor();
    await f.page.locator('[data-invite-member] [name="username"]').fill('teammate');
    await f.page.locator('[data-invite-member] button').click();
    await f.page.getByText('teammate · 等待接受邀请').waitFor();
    const saves = f.writes.filter(item => item.body.action === 'save');
    assert.equal(saves[0].body.revision, 2); assert.equal(saves[0].body.answers.f_phone, '12345');
    await f.page.locator('[data-save-answers] [name="f_phone"]').fill('67890'); f.reject();
    await f.page.locator('[data-save-answers] button').click();
    await f.page.locator('[data-activity-message]').filter({ hasText: '已被更新' }).waitFor();
    assert.equal(await f.page.locator('[data-save-answers] [name="f_phone"]').inputValue(), '67890');
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

test('individuals fill and submit once, then see a receipt and explicitly edit their saved information', async () => {
  const f = await fixture('detail', 'mine', false, data => { data.activity.mode = 'individual'; data.activity.min_members = data.activity.max_members = 1; });
  try {
    const form = f.page.locator('[data-start-registration]');
    await form.locator('[name="f_phone"]').fill('13800138000');
    await form.getByRole('button', { name: '确认并提交报名' }).click();
    await f.page.getByRole('heading', { name: '报名已提交，等待审核' }).waitFor();
    assert.equal(f.writes.length, 1, 'direct personal submission is a single atomic request');
    assert.equal(f.writes[0].body.submit, true);
    assert.equal(f.writes[0].body.answers.f_phone, '13800138000');
    assert.equal(await f.page.locator('[data-save-answers]').count(), 0, 'submitted form is a receipt until explicitly edited');
    await f.page.getByRole('button', { name: '修改报名信息' }).click();
    assert.equal(await f.page.locator('[data-save-answers] [name="f_phone"]').inputValue(), '13800138000');
    await f.page.locator('[data-save-answers] [name="f_phone"]').fill('13900139000');
    await f.page.getByRole('button', { name: '保存修改', exact: true }).click();
    await f.page.getByRole('heading', { name: '报名已提交，等待审核' }).waitFor();
    assert.equal(f.writes[1].body.action, 'save');
    await f.page.screenshot({path: '/tmp/nwpuoj-activity-personal-receipt.png', fullPage: true});
    assert.deepEqual(f.failures, []);
  } finally { await f.context.close(); }
});

test('team readiness blocks submission, refresh preserves edits, and the captain submits visible answers atomically', async () => {
  const f = await fixture('detail', 'mine', true, data => {
    data.mine = {id: 4, leader_id: 1, team_name: '西工大测试队', status: 'draft', revision: 3, members: [{...data.identity, ready: false, answers: {}}, {user_id: 2, username: 'member', ready: false}], invitations: []};
  });
  try {
    await f.page.locator('[data-save-answers] [name="f_phone"]').fill('not-yet-saved');
    assert.ok(await f.page.locator('[data-submit-registration]').isDisabled());
    f.data.mine.members[1].ready = true; f.data.mine.revision++;
    await f.page.locator('[data-refresh-mine]').click();
    await f.page.getByText('成员状态已更新，未保存的输入已保留。').waitFor();
    assert.equal(await f.page.locator('[data-save-answers] [name="f_phone"]').inputValue(), 'not-yet-saved');
    assert.ok(await f.page.locator('[data-submit-registration]').isEnabled());
    await f.page.screenshot({path: '/tmp/nwpuoj-activity-team-desktop.png', fullPage: true});
    await f.page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await f.page.screenshot({path: '/tmp/nwpuoj-activity-team-dark.png', fullPage: true});
    await f.page.locator('[data-submit-registration]').click();
    await f.page.getByRole('heading', {name: '报名已提交，等待审核'}).waitFor();
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].body.revision, 4);
    assert.equal(f.writes[0].body.action, 'submit');
    assert.equal(f.writes[0].body.answers.f_phone, 'not-yet-saved');
    assert.deepEqual(f.failures, []);
  } finally { await f.context.close(); }
});

test('configuration locks existing rules, preserves hidden values and requires exact-name deletion confirmation', async () => {
  const f = await fixture('detail', 'settings', true, data => { data.fields_locked = true; });
  try {
    await f.page.locator('[data-activity-config] [name="title"]').fill('更新校赛标题');
    await f.page.locator('[data-config-next]').click();
    assert.ok(await f.page.getByRole('radio', {name: '组队报名'}).isDisabled());
    await f.page.locator('[data-config-next]').click();
    assert.ok(await f.page.locator('[data-add-field]').isDisabled());
    await f.page.locator('[data-config-next]').click();
    await f.page.locator('[data-config-save]').click();
    await f.page.getByText('活动设置已保存。').waitFor();
    assert.equal(f.writes[0].body.mode, 'team');
    assert.equal(f.writes[0].body.min_members, '2');
    assert.equal(f.writes[0].body.fields[0].label, '联系方式');
    await f.page.locator('[data-delete-activity]').click();
    const dialog = f.page.getByRole('dialog', {name: '删除活动'});
    await dialog.locator('input').fill('错误名称');
    await dialog.getByRole('button', {name: '确认删除'}).click();
    await dialog.getByText('活动名称不一致，请输入完整名称。').waitFor();
    assert.equal(f.writes.length, 1);
    await dialog.locator('input').fill('2026 校赛报名');
    f.reject(); await dialog.getByRole('button', {name: '确认删除'}).click();
    await dialog.getByText('信息已被更新，请刷新页面后重试。').waitFor();
    assert.equal(await dialog.locator('input').inputValue(), '2026 校赛报名');
    await dialog.getByRole('button', {name: '确认删除'}).click();
    await f.page.waitForURL('**/activities');
    assert.equal(f.writes.at(-1).body.revision, 1);
    assert.equal(f.writes.at(-1).method, 'POST');
    assert.equal(f.writes.at(-1).headers['x-http-method-override'], 'DELETE');
    assert.deepEqual(f.failures, []);
  } finally { await f.context.close(); }
});

test('wizard validates before moving on and previews questions in desktop, mobile and dark themes', async () => {
  const f = await fixture('new');
  try {
    await f.page.locator('[data-config-next]').click();
    assert.ok(await f.page.locator('[data-config-step="0"]').isVisible());
    await f.page.locator('[data-activity-config] [name="title"]').fill('2026 西北工业大学程序设计竞赛');
    await f.page.locator('[name="location"]').fill('长安校区 · 计算机学院');
    await f.page.locator('[name="description"]').fill('面向全校同学开放，欢迎组队参加校赛。');
    await f.page.locator('[data-config-next]').click();
    await f.page.getByRole('radio', {name: '组队报名'}).check();
    await f.page.locator('[name="opens_at"] + input').fill('2026-11-10 09:00');
    await f.page.locator('[name="closes_at"] + input').fill('2026-11-09 18:00');
    await f.page.keyboard.press('Escape');
    await f.page.locator('[data-config-next]').click();
    await f.page.getByText('报名截止时间必须晚于开始时间。').waitFor();
    await f.page.locator('[name="closes_at"] + input').fill('2026-11-20 23:59');
    await f.page.keyboard.press('Escape');
    await f.page.locator('[data-config-next]').click();
    await f.page.locator('[data-field-preset="phone"]').click();
    await f.page.locator('[data-field-preset="grade"]').click();
    assert.equal(await f.page.locator('[data-fields-preview] .app-field').count(), 2);
    await f.page.locator('[data-activity-message]').evaluate(el => el.hidden = true);
    await f.page.screenshot({path: '/tmp/nwpuoj-activity-builder-desktop.png', fullPage: true});
    await f.page.setViewportSize({width: 390, height: 844});
    assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await f.page.screenshot({path: '/tmp/nwpuoj-activity-builder-mobile.png', fullPage: true});
    await f.page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await f.page.screenshot({path: '/tmp/nwpuoj-activity-builder-dark.png', fullPage: true});
    await f.page.locator('[data-config-next]').click();
    await f.page.locator('[name="status"]').selectOption('published');
    await f.page.getByRole('button', {name: '创建并公开活动'}).click();
    await f.page.waitForURL('**/activities/1');
    assert.equal(f.writes[0].body.closes_at, Date.parse('2026-11-20T23:59:00+08:00'));
    assert.deepEqual(f.failures, []);
  } finally { await f.context.close(); }
});

test('activity directory filters and searches with shareable URLs and fits narrow screens', async () => {
  const f = await fixture('list', 'intro');
  try {
    assert.equal(await f.page.locator('.activity-list-row').count(), 2);
    await f.page.locator('[data-list-scope="open"]').click();
    await f.page.waitForFunction(() => document.querySelectorAll('.activity-list-row').length === 1);
    assert.equal(new URL(f.page.url()).searchParams.get('scope'), 'open');
    await f.page.locator('[data-list-search] input').fill('不存在');
    await f.page.locator('[data-list-search] button[type="submit"]').click();
    await f.page.getByText('暂无符合条件的活动').waitFor();
    await f.page.locator('[data-list-search] input').fill('');
    await f.page.locator('[data-list-scope="all"]').click();
    await f.page.waitForFunction(() => document.querySelectorAll('.activity-list-row').length === 2);
    await f.page.screenshot({path:'/tmp/nwpuoj-activity-directory.png',fullPage:true});
    await f.page.setViewportSize({width: 360, height: 780});
    assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(f.failures, []);
  } finally { await f.context.close(); }
});

test('invited members accept and confirm only their information, while closed activities are read-only', async () => {
  const f = await fixture('detail', 'mine', false, data => { data.invitations = [{id: 8, team_name: '邀请队伍', leader_username: 'leader'}]; });
  try {
    await f.page.getByRole('button', {name: '接受并加入'}).click();
    await f.page.locator('[data-save-answers] [name="f_phone"]').fill('member-answer');
    assert.equal(await f.page.locator('[data-submit-registration]').count(), 0, 'members cannot submit the whole team');
    assert.equal(await f.page.locator('[data-invite-member]').count(), 0);
    await f.page.getByRole('button', {name: '保存并确认我的信息'}).click();
    await f.page.getByText('信息已保存并确认。').waitFor();
    assert.equal(f.writes.at(-1).body.action, 'save');
    f.data.activity.closes_at = Date.now() - 1000;
    await f.page.locator('[data-refresh-mine]').click();
    await f.page.getByText('报名已结束，当前仅可查看报名信息。').waitFor();
    assert.equal(await f.page.locator('[data-save-answers]').count(), 0);
    assert.equal(await f.page.locator('[data-withdraw-registration]').count(), 0);
    assert.deepEqual(f.failures, []);
  } finally { await f.context.close(); }
});
