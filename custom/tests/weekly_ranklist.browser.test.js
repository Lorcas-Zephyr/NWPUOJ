'use strict';
// Browser fixtures intercept all requests; no production roster is modified.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const engine = require('../libs/weekly-standings');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); });

function fixtureData() {
  const members = Array.from({ length: 105 }, (_, i) => ({ user_id: i + 1, username: 'member' + (i + 1), real_name: '成员' + (i + 1), student_id: '202600' + (i + 1) }));
  const contests = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, title: '预备队周赛 第 ' + (i + 1) + ' 场', problems: '1|2|3|4|5|6|7|8|9|10', start_time: 1750000000 + i * 1000, end_time: 1750000900 + i * 1000 }));
  const standings = Object.fromEntries(contests.map(c => [c.id, members.map((m, i) => ({ user_id: m.user_id, score: i === 0 ? c.id : Math.max(0, 8 - Math.floor(i / 15)), penalty: i * 300, participated: i < 100 }))]));
  const attendance = members.flatMap(m => contests.slice(0, 5).map(c => ({ user_id: m.user_id, contest_id: c.id, onsite: 1 })));
  return { ...engine.calculateWeeklyStandings({ members, contests, standings, attendance, now: 1800000000 }), title: '预备队周赛总榜', can_manage: true,
    edit_etag: '"weekly-1"', revision: 1, calculated_at: '2026-10-16T08:00:00.000Z' };
}
function html(settings, manager) {
  const template = read('views/weekly_ranklist.ejs').replace('<% include app_header %>', '').replace('<% include app_footer %>', '');
  const code = "const ejs=require('ejs'),fs=require('fs'),x=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(ejs.render(x.template,{weeklySettings:x.settings,weeklyManager:x.manager}));";
  const r = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', code], { cwd: path.join(root, '..'), input: JSON.stringify({ template, settings, manager }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + ['app-shell.css', 'app-shared.css', 'app-features.css', 'username_tiers.css'].map(file => '<link rel="stylesheet" href="/self/' + file + '">').join('')
    + '<script>window.__NWPUOJ_APP={csrfToken:"fixture",user:{id:1}};window.__SYZOJ_USER_TIERS={1:"admin",2:"red",3:"orange",4:"green",5:"blue",6:"gray",7:"cheater",101:"green"};</script><script src="/self/app-api.js"></script></head><body class="app-v2">' + r.stdout + '<script src="/self/app-v2.js"></script></body></html>';
}
async function fixture(settings, manager = true) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), failures = [], writes = [];
  let board = fixtureData(), rejectNext = false;
  if (!manager) { board.can_manage = false; board.rows.forEach(row => { delete row.real_name; delete row.student_id; }); }
  const document = html(settings, manager);
  page.on('pageerror', error => failures.push(error.message));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url()), req = route.request();
    if (url.pathname.startsWith('/self/')) { const file = url.pathname.split('/').pop(); return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'application/javascript', body: read(file) }); }
    if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: document });
    if (url.pathname.startsWith('/api/v2/weekly-ranklist')) {
      let data = board;
      if (url.pathname.includes('/search/')) {
        const kind = url.pathname.split('/').pop(); data = kind === 'contests' ? [{ id: 21, title: '新增周赛' }] : kind === 'classes' ? [{ id: 8, name: '预备队班级', member_count: 20 }] : [{ id: 123, username: 'new_member', real_name: '新成员', student_id: '20269999' }];
      } else if (req.method() === 'POST') {
        writes.push({ path: url.pathname, headers: req.headers(), body: req.postData() });
        if (rejectNext) { rejectNext = false; return route.fulfill({ status: 412, contentType: 'application/json', body: JSON.stringify({ error: { message: '总榜设置已被修改，请刷新后再操作。', code: 'ETAG_MISMATCH' } }) }); }
        const body = (req.headers()['content-type'] || '').startsWith('application/json') ? req.postDataJSON() : null;
        if (body) { assert.equal(body.if_match, board.edit_etag); assert.equal(body._csrf, 'fixture'); }
        assert.equal(req.headers()['if-match'], board.edit_etag);
        assert.equal(req.headers()['x-csrf-token'], 'fixture');
        board.revision++; board.edit_etag = '"weekly-' + board.revision + '"';
        if (body && body.title) { board.title = body.title; board.rules = body.rules; }
        if (body && body.changes) body.changes.forEach(change => { const cell = board.rows.find(row => row.user_id === change.user_id).cells.find(c => c.contest_id === change.contest_id); cell.onsite = change.onsite; });
        board.operation = { added_count: 1, existing_count: 0 }; data = board;
      }
      // Deliberately omit response ETag to model the public gateway.
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data, meta: {}, error: null }) });
    }
    return route.fulfill({ status: 404, body: 'fixture only' });
  });
  await page.goto('http://weekly.test/fixture'); await page.locator('[data-weekly-title]').filter({ hasText: '预备队周赛总榜' }).waitFor();
  return { page, context, failures, writes, reject: () => { rejectNext = true; } };
}

test('ranklist columns, cell colors, identities, 100-person pagination and mobile overflow', async () => {
  const f = await fixture(false);
  try {
    const { page } = f;
    assert.equal(await page.locator('[data-weekly-rank] tr').count(), 100);
    for (const name of ['总分', 'G1', 'G2', 'S1', 'S2']) assert.equal(await page.locator('[data-weekly-rank-head] th').filter({ hasText: new RegExp('^' + name + '$') }).count(), 1);
    assert.equal(await page.locator('[data-weekly-rank] tr').first().locator('td.weekly-g1').count(), 4);
    assert.equal(await page.locator('[data-weekly-rank] tr').first().locator('td.weekly-g2').count(), 6);
    assert.match(await page.locator('[data-weekly-rank] tr').first().locator('td.weekly-g1 small').first().textContent(), /线下 · G1 · 通过 8\/10/);
    assert.equal(await page.locator('[data-weekly-rank] td small').count(), 1000);
    assert.ok((await page.locator('[data-weekly-rank] td small').allTextContents()).every(text => /通过 \d+\/10$/.test(text)));
    assert.match(await page.locator('td.weekly-g1').first().evaluate(e => getComputedStyle(e).backgroundColor), /rgba/);
    await page.getByText('显示真实信息', { exact: true }).click();
    assert.equal(await page.getByRole('checkbox', { name: '显示真实信息' }).isChecked(), true);
    assert.match(await page.locator('[data-weekly-rank] tr').first().textContent(), /成员\d+-202600/);
    await page.getByRole('button', { name: '下一页' }).click(); assert.equal(await page.locator('[data-weekly-rank] tr').count(), 5);
    await page.getByRole('button', { name: '上一页' }).click();
    await page.screenshot({ path: '/tmp/nwpuoj-weekly-rank-desktop.png', fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: '/tmp/nwpuoj-weekly-rank-mobile.png', fullPage: false });
    assert.deepEqual(f.failures, []);
  } finally { await f.context.close(); }
});
test('ordinary viewer cannot see settings or real-information controls', async () => {
  const f = await fixture(false, false);
  try { assert.equal(await f.page.getByRole('link', { name: '总榜设置' }).count(), 0); assert.equal(await f.page.locator('[data-weekly-identities]').count(), 0); assert.deepEqual(f.failures, []); }
  finally { await f.context.close(); }
});
test('weekly names reuse site colors after filtering, pagination, identity toggles and theme changes', async () => {
  const f = await fixture(false);
  try {
    const { page } = f;
    const tiers = { 1: 'admin', 2: 'red', 3: 'orange', 4: 'green', 5: 'blue', 6: 'gray', 7: 'cheater', 8: 'default' };
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme);
      for (const [id, tier] of Object.entries(tiers)) {
        const username = page.locator('[data-weekly-rank] a[href="/user/' + id + '"]');
        assert.equal(await username.getAttribute('class'), 'username-tier-' + tier);
        assert.ok(await username.evaluate((node, tier) => {
          const reference = document.createElement('span'); reference.className = 'username-tier-' + tier;
          document.body.append(reference);
          const same = getComputedStyle(node).color === getComputedStyle(reference).color;
          reference.remove(); return same;
        }, tier));
      }
    }
    await page.getByText('显示真实信息', { exact: true }).click();
    const admin = page.locator('[data-weekly-rank] a[href="/user/1"]');
    assert.match(await admin.innerText(), /^成员1-/);
    assert.equal(await admin.getAttribute('class'), 'username-tier-admin');
    await page.getByRole('searchbox', { name: '搜索总榜成员' }).fill('member5');
    assert.equal(await page.locator('[data-weekly-rank] a[href="/user/5"]').getAttribute('class'), 'username-tier-blue');
    await page.getByRole('searchbox', { name: '搜索总榜成员' }).fill('');
    await page.getByRole('button', { name: '下一页' }).click();
    assert.equal(await page.locator('[data-weekly-rank] a[href="/user/101"]').getAttribute('class'), 'username-tier-green');
    await page.getByRole('button', { name: '上一页' }).click();
    assert.equal(await page.locator('[data-weekly-rank] a[href="/user/7"]').getAttribute('class'), 'username-tier-cheater');
    assert.equal(await page.locator('.tag-tier-cheater').count(), 0);
    assert.deepEqual(f.failures, []);
  } finally { await f.context.close(); }
  const settings = await fixture(true);
  try {
    await settings.page.getByRole('tab', { name: '成员名单' }).click();
    assert.equal(await settings.page.locator('[data-weekly-members] a[href="/user/1"]').getAttribute('class'), 'username-tier-admin');
    assert.deepEqual(settings.failures, []);
  } finally { await settings.context.close(); }
});
test('settings search imports, outside-click dismissal, CSV filename and body version fallback', async () => {
  const f = await fixture(true);
  try {
    const { page } = f;
    const fields = await page.locator('[data-weekly-config] > .app-field').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
    assert.ok(Math.max(...fields) - Math.min(...fields) < 2, 'desktop rule fields share one row');
    assert.equal(await page.locator('nav[aria-label="周赛总榜"] .app-tab.is-active').textContent(), '总榜设置');
    await page.getByRole('searchbox', { name: '搜索比赛', exact: true }).fill('新增');
    await page.getByRole('button', { name: '#21 · 新增周赛' }).waitFor();
    await page.locator('[data-weekly-title]').click(); assert.equal(await page.getByRole('button', { name: '#21 · 新增周赛' }).isVisible(), false);
    await page.getByRole('searchbox', { name: '搜索比赛', exact: true }).fill('周赛');
    await page.getByRole('button', { name: '#21 · 新增周赛' }).click();
    await page.getByText('已保存，全部场次和成员已重新计算。', { exact: false }).waitFor();
    assert.equal(JSON.parse(f.writes[0].body).contest_ids[0], 21);
    await page.getByRole('tab', { name: '成员名单' }).click();
    await page.getByRole('searchbox', { name: '搜索添加用户', exact: true }).fill('新成员'); await page.getByRole('button', { name: /new_member/ }).click();
    await page.locator('[data-weekly-page][aria-busy]').waitFor({ state: 'detached' });
    await page.getByRole('searchbox', { name: '搜索班级', exact: true }).fill('预备队'); await page.getByRole('button', { name: /预备队班级/ }).click();
    await page.locator('[data-weekly-page][aria-busy]').waitFor({ state: 'detached' });
    await page.locator('input[type="file"]').setInputFiles({ name: '预备队名单.csv', mimeType: 'text/csv', buffer: Buffer.from('学号\n20269999') });
    assert.equal(await page.locator('[data-weekly-filename]').textContent(), '预备队名单.csv');
    await page.getByRole('button', { name: '导入并重算' }).click();
    await page.locator('[data-weekly-page][aria-busy]').waitFor({ state: 'detached' });
    assert.match(f.writes.at(-1).body, /if_match/); assert.match(f.writes.at(-1).body, /_csrf/);
    assert.deepEqual(f.writes.map(w => w.path.split('/').slice(-1)[0]), ['contests', 'members', 'import-class', 'import-csv']);
    assert.deepEqual(f.failures, []);
  } finally { await f.context.close(); }
});
test('onsite matrix keeps unsaved edits on error, saves only changes and fits mobile', async () => {
  const f = await fixture(true);
  try {
    const { page } = f;
    await page.getByRole('tab', { name: '线下参赛登记' }).click();
    const checkbox = page.locator('[data-weekly-attendance] input').first(); await checkbox.uncheck();
    await page.getByText('1 项更改尚未保存').waitFor(); f.reject();
    await page.getByRole('button', { name: '保存线下记录并重算' }).click(); await page.getByText('总榜设置已被修改，请刷新后再操作。').waitFor();
    assert.equal(await page.locator('[data-weekly-attendance] input').first().isChecked(), false);
    await page.getByRole('button', { name: '保存线下记录并重算' }).click();
    await page.locator('[data-weekly-page][aria-busy]').waitFor({ state: 'detached' });
    assert.equal(JSON.parse(f.writes.at(-1).body).changes.length, 1);
    assert.equal(await page.getByRole('button', { name: '保存线下记录并重算' }).isDisabled(), true);
    await page.screenshot({ path: '/tmp/nwpuoj-weekly-settings-desktop.png', fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(f.failures, []);
  } finally { await f.context.close(); }
});
