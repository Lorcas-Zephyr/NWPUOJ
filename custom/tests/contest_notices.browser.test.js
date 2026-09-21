'use strict';
// Opt-in browser regression: NODE_PATH=<playwright node_modules> node --test
// custom/tests/contest_notices.browser.test.js. All browser APIs are intercepted;
// no test notice is ever published to a real contest.
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const now = Math.floor(Date.now() / 1000);
let browser;
before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); });
after(async () => { if (browser) await browser.close(); });

function render(manager) {
  let template = manager ? read('views/contest_notices.ejs') : read('views/contest_notice_table.ejs') + read('views/contest_notice_client.ejs');
  template = template.replace('<% include app_header %>', '').replace('<% include app_footer %>', read('views/contest_notice_client.ejs'))
    .replace('<% include contest_notice_table %>', read('views/contest_notice_table.ejs'));
  const script = `const fs=require('fs'),ejs=require('/app/node_modules/ejs');const x=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(ejs.render(x.template,{contest:{id:7,title:'比赛通知验证'},user:{id:3},syzoj:{utils:{makeUrl:parts=>'/'+parts.join('/')}}}));`;
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], {
    cwd: path.join(root, '..'), input: JSON.stringify({ template }), encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="csrf-token" content="fixture"><link rel="stylesheet" href="/self/app-shell.css"><link rel="stylesheet" href="/self/app-shared.css"><link rel="stylesheet" href="/self/app-features.css"></head><body class="app-v2">'
    + result.stdout + '<script src="/self/app-v2.js"></script></body></html>';
}

async function fixture(manager, handler, viewport) {
  const context = await browser.newContext({ viewport: viewport || { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  const html = render(manager);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/self/')) {
      const file = url.pathname.split('/').pop();
      return route.fulfill({ status: 200, contentType: file.endsWith('.css') ? 'text/css' : 'application/javascript', body: read(file) });
    }
    if (url.pathname.startsWith('/api/v2/contests/7/notices')) return handler(route, url);
    if (url.pathname === '/fixture') return route.fulfill({ contentType: 'text/html', body: html });
    return route.fulfill({ status: 404, body: 'fixture only' });
  });
  await page.goto('http://notice.test/fixture');
  return { page, context, errors };
}
const json = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data, meta: {}, error: null }) });
const failure = route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: '模拟网络失败' } }) });
const inactive = { active: false, eligible: false, items: [], read_through: 0, server_time: now, end_time: now + 600 };

test('publish retries keep their body token, render text safely and retain usable desktop/mobile layout', async () => {
  const attempts = [];
  const notices = [];
  const { page, context, errors } = await fixture(true, async (route, url) => {
    if (url.pathname.endsWith('/unread')) return json(route, inactive);
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON();
      attempts.push(payload);
      if (!notices.length) notices.push({ id: 1, content: payload.content, published_at: now });
      if (attempts.length === 1) return route.abort('connectionreset');
      return json(route, notices[0]);
    }
    return json(route, { items: notices, next_before_id: null });
  });
  try {
    const content = '<img src=x onerror=alert(1)>\n**这是一条纯文本通知**';
    await page.locator('textarea').fill(content);
    await page.getByRole('button', { name: '发布通知', exact: true }).click();
    await page.getByText('未能确认发布结果，请重试；同一条通知不会重复发布。', { exact: true }).waitFor();
    assert.equal(await page.locator('textarea').inputValue(), content);
    await page.getByRole('button', { name: '发布通知', exact: true }).click();
    await page.getByText('通知已发布。参赛者会在赛时收到提醒。', { exact: true }).waitFor();
    await page.locator('[data-notice-history-rows] tr').waitFor();
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].publish_token, attempts[1].publish_token);
    assert.equal(attempts[0]._csrf, 'fixture');
    assert.equal(await page.locator('textarea').inputValue(), '');
    assert.equal(await page.locator('[data-notice-history-rows] td').last().textContent(), content);
    assert.equal(await page.locator('[data-notice-history-rows] img').count(), 0);
    assert.equal(await page.locator('[data-notice-history-more]').isVisible(), false);
    const box = await page.locator('textarea').boundingBox();
    assert.ok(box.width > 500, 'desktop editor must not be cramped');
    await page.screenshot({ path: '/tmp/nwpuoj-contest-notices-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await page.screenshot({ path: '/tmp/nwpuoj-contest-notices-mobile.png', fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('queued popups survive failed acknowledgement, do not close on Escape, and stay read after reload', async () => {
  const notices = [{ id: 1, content: '<b>第一条</b>\n下一行', published_at: now }, { id: 2, content: '第二条', published_at: now }];
  let cursor = 0;
  let reads = 0;
  const { page, context, errors } = await fixture(false, async (route, url) => {
    if (url.pathname.endsWith('/unread')) return json(route, { ...inactive, eligible: true, active: true, read_through: cursor, items: notices.filter(n => n.id > cursor) });
    if (url.pathname.endsWith('/read')) {
      reads++;
      if (reads === 1) return failure(route);
      cursor = Math.max(cursor, Number(url.pathname.split('/').at(-2)));
      return json(route, { read: true });
    }
    return json(route, { items: notices.slice().reverse(), next_before_id: null });
  }, { width: 390, height: 844 });
  try {
    await page.locator('dialog[open]').waitFor();
    assert.equal(await page.locator('[data-notice-content]').textContent(), notices[0].content);
    assert.equal(await page.locator('[data-notice-content] b').count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog').getAttribute('open'), '');
    await page.getByRole('button', { name: '知道了' }).click();
    await page.getByText('已读状态保存失败，请点击“知道了”重试。').waitFor();
    assert.equal(cursor, 0);
    await page.getByRole('button', { name: '知道了' }).click();
    await page.locator('[data-notice-content]').filter({ hasText: '第二条' }).waitFor();
    await page.screenshot({ path: '/tmp/nwpuoj-contest-notices-popup.png', fullPage: true });
    await page.getByRole('button', { name: '知道了' }).click();
    await page.locator('dialog[open]').waitFor({ state: 'hidden' });
    assert.equal(cursor, 2);
    await page.reload();
    await page.locator('[data-notice-history-rows] tr').first().waitFor();
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
