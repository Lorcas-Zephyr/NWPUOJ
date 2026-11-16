'use strict';
// Local render fixtures only: all navigation is intercepted, without live writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const author = { id: 7, username: 'owner<&>', is_admin: true };
const viewer = { id: 9, username: 'viewer' };
const tiers = { 7: 'blue', 8: 'admin', 9: 'cheater' };
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); });
function render(view, locals) {
  const template = read('views/' + view + '.ejs').replace(/<% include \w+ %>/g, '');
  const code = `const fs=require('fs'),ejs=require('ejs'),vm=require('vm');
    const input=JSON.parse(fs.readFileSync(0,'utf8'));
    const syzoj={utils:{makeUrl:parts=>'/'+parts.join('/'),avatar:()=>'',formatDate:()=> '2026-11-16',getCurrentDate:()=>10},
      adminUserIds:new Set([8]),cheaterUserIds:new Set([9]),userHitScores:new Map([[7,{total:120}]])};
    vm.runInNewContext(input.renderer,{syzoj});
    process.stdout.write(ejs.render(input.template,{...input.locals,syzoj}));`;
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', code], {
    cwd: path.join(root, '..'), input: JSON.stringify({ template, locals, renderer: read('modules/_username_renderer.js') }), encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
async function fixture(content, width = 1200) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage(), failures = [];
  page.on('pageerror', error => failures.push(error.message));
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    ['app-shell.css', 'app-shared.css', 'app-features.css', 'username_tiers.css'].map(file => '<link rel="stylesheet" href="/self/' + file + '">').join('') +
    '<script>window.__SYZOJ_USER_TIERS=' + JSON.stringify(tiers) + ';</script></head><body class="app-v2">' + content + '<script src="/self/app-v2.js"></script></body></html>';
  await context.route('**/*', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/self/')) return route.fulfill({ contentType: pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body: read(pathname.slice(6)) });
    return route.fulfill({ contentType: 'text/html', body: pathname === '/fixture' ? html : '<p>Navigation target</p>' });
  });
  await page.goto('http://username.test/fixture');
  return { page, context, failures };
}
test('base lists and problem-set creators use the account ID, escaped name and global color', async () => {
  for (const tab of ['problems', 'contests', 'members']) {
    const row = { id: tab === 'members' ? 7 : 900, user_id: 7, holder_id: 7, username: author.username, title: 'Fixture', type: 'acm', is_public: true, classes: [], start_time: 0, end_time: 20 };
    const f = await fixture(render('base_workspace', { tab, rows: [row], user: viewer, baseAdmin: false, keyword: '', mine: false, total: 1 }));
    try {
      const name = f.page.getByRole('link', { name: author.username, exact: true });
      assert.equal(await name.getAttribute('href'), '/user/7');
      assert.equal(await name.evaluate(el => getComputedStyle(el).color), 'rgb(20, 95, 184)');
      await name.click(); assert.equal(new URL(f.page.url()).pathname, '/user/7');
      assert.deepEqual(f.failures, []);
    } finally { await f.context.close(); }
  }
  const f = await fixture(render('problem_sets', { user: viewer, canCreateProblemSet: false, problemSets: [{ id: 900, title: 'Fixture', owner_id: 7, owner_username: author.username, ranking_mode: 'acm', problem_count: 1, participant_count: 1, visibility: 'public', status: 'published' }] }));
  try { await f.page.getByRole('link', { name: author.username, exact: true }).click(); assert.equal(new URL(f.page.url()).pathname, '/user/7'); } finally { await f.context.close(); }
});
test('message and ticket rows preserve separate profile and row navigation on desktop and mobile', async () => {
  const views = [
    [render('messages_inbox', { user: viewer, conversations: [{ partner: author, unread: 1, last_time: 1, last_message: { sender_id: 7, content: '消息内容' } }] }), '/messages/with/7'],
    [render('tickets', { isAdmin: false, categoryFilter: '', statusFilter: '', categories: { other: { label: '其他', subtypes: [] } }, statusMeta: { pending: { label: '待处理' } }, creatorMap: { 7: author }, assigneeMap: { 8: { id: 8, username: 'admin' } }, tickets: [{ id: 30, title: 'Fixture ticket', category: 'other', status: 'pending', creator_id: 7, assignee_id: 8, updated_at: 1 }] }), '/ticket/30']
  ];
  for (const [html, destination] of views) for (const width of [1200, 390]) {
    const f = await fixture(html, width);
    try {
      assert.equal(await f.page.locator('.app-linked-row').count(), 1);
      assert.equal(await f.page.locator('a a').count(), 0);
      await f.page.getByRole('link', { name: author.username, exact: true }).click();
      assert.equal(new URL(f.page.url()).pathname, '/user/7');
      await f.page.goto('http://username.test/fixture');
      await f.page.locator('.app-row-destination').click();
      assert.equal(new URL(f.page.url()).pathname, destination);
      assert.deepEqual(f.failures, []);
    } finally { await f.context.close(); }
  }
});
test('async names, recycled links and selection labels receive the same colors in both themes', async () => {
  const f = await fixture('<div id="list"></div>');
  try {
    await f.page.evaluate(() => {
      document.getElementById('list').innerHTML = '<a href="/user/7" class="username-tier-admin">dynamic</a><button><span data-username-id="9">selection</span></button>';
    });
    await f.page.waitForFunction(() => document.querySelector('#list a').className === 'username-tier-blue');
    const link = f.page.locator('#list a');
    assert.equal(await link.evaluate(el => getComputedStyle(el).color), 'rgb(20, 95, 184)');
    assert.match(await f.page.locator('[data-username-id]').getAttribute('class'), /username-tier-cheater/);
    await link.evaluate(el => { el.href = '/user/8'; });
    await f.page.waitForFunction(() => document.querySelector('#list a').className === 'username-tier-admin');
    assert.equal(await link.evaluate(el => getComputedStyle(el).color), 'rgb(122, 62, 177)');
    await f.page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    assert.equal(await link.evaluate(el => getComputedStyle(el).color), 'rgb(201, 160, 236)');
    assert.deepEqual(f.failures, []);
  } finally { await f.context.close(); }
});
