'use strict';
// Opt-in: NODE_PATH=<playwright node_modules> node --test this file.
// All requests use fixtures; no production account or announcement is changed.
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const client = read('views/index.ejs').match(/<script>([\s\S]*?)<\/script>/)[1];
let browser;
before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); });
after(async () => { if (browser) await browser.close(); });

function notice(id, level = 'important') {
  return { id, title: '公告 ' + id, level, content_rendered: '<p>公告内容</p>', published_at: '2026-11-14T00:00:00Z' };
}
function server() { return { items: [notice(81)], records: new Set(), writes: [], failNext: false }; }

async function fixture(state, initialUser, origin = 'https://notice.test') {
  let user = initialUser;
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ data }) });
    if (url.pathname === '/api/v2/announcements') {
      return json(state.items.map(item => ({ ...item, dismissed: !!user && state.records.has(user + ':' + item.id) })));
    }
    if (/^\/api\/v2\/announcements\/\d+\/dismiss$/.test(url.pathname)) {
      assert.equal(request.method(), 'POST');
      assert.equal(request.headers()['x-csrf-token'], 'fixture');
      assert.ok(request.headers()['idempotency-key']);
      const id = Number(url.pathname.split('/')[4]);
      state.writes.push({ user, id });
      if (state.failNext) { state.failNext = false; return route.abort('connectionreset'); }
      state.records.add(user + ':' + id);
      return json({ id, dismissed: true });
    }
    if (url.pathname.startsWith('/self/')) {
      const file = url.pathname.split('/').pop();
      return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'application/javascript', body: read(file) });
    }
    if (url.pathname === '/') {
      const script = client.replace("<%= user ? 'true' : 'false' %>", user ? 'true' : 'false');
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="csrf-token" content="fixture"><link rel="stylesheet" href="/self/app-shell.css"><link rel="stylesheet" href="/self/app-shared.css"><link rel="stylesheet" href="/self/app-features.css"></head><body class="app-v2"><main class="app-page"><div data-announcement-list></div><div data-announcement-dialogs></div></main><script>window.__NWPUOJ_APP = { csrfToken: "fixture" };</script><script src="/self/app-v2.js"></script><script>' + script + '</script></body></html>' });
    }
    return route.fulfill({ status: 404, body: 'fixture only' });
  });
  async function visit(nextUser = user) {
    user = nextUser;
    await page.goto(origin + '/');
    await page.waitForFunction(count => document.querySelectorAll('.app-announcement').length === count, state.items.length);
  }
  await visit();
  return { context, page, visit, errors };
}
async function dismiss(page) {
  await page.getByRole('checkbox', { name: '不再弹出' }).check();
  await page.getByRole('button', { name: '我已知晓' }).click();
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
}

test('same account stays dismissed across browsers and origins, other accounts and new notices remain visible', async () => {
  const state = server();
  const first = await fixture(state, 7, 'http://10.0.0.8:8080');
  let second;
  try {
    await dismiss(first.page);
    second = await fixture(state, 7, 'https://notice.test');
    assert.equal(await second.page.locator('dialog[open]').count(), 0);
    assert.equal(await second.page.locator('.app-announcement').count(), 1, 'dismissed announcement remains in the list');
    await first.visit(8);
    assert.equal(await first.page.locator('dialog[open] h2').textContent(), '公告 81');
    await first.visit(7);
    assert.equal(await first.page.locator('dialog[open]').count(), 0);
    state.items.push(notice(82, 'warning'));
    await second.visit();
    assert.equal(await second.page.locator('dialog[open] h2').textContent(), '公告 82');
    assert.deepEqual(state.writes, [{ user: 7, id: 81 }]);
    assert.deepEqual(first.errors.concat(second.errors), []);
  } finally { await first.context.close(); if (second) await second.context.close(); }
});

test('guest and legacy browser marks never suppress an account announcement', async () => {
  const state = server();
  const fixturePage = await fixture(state, null);
  const { page } = fixturePage;
  try {
    await dismiss(page);
    await fixturePage.visit();
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(state.writes.length, 0);
    await page.evaluate(() => localStorage.setItem('nwpuoj_dismissed_announcements', '{"81":1}'));
    await fixturePage.visit(7);
    assert.equal(await page.locator('dialog[open]').count(), 1);
    await dismiss(page);
    await page.evaluate(() => localStorage.clear());
    await fixturePage.visit();
    assert.equal(await page.locator('dialog[open]').count(), 0, 'clearing storage does not clear the account preference');
    assert.deepEqual(fixturePage.errors, []);
  } finally { await fixturePage.context.close(); }
});

test('ordinary close and Escape keep reminders, checked close persists only that notice', async () => {
  const state = server();
  state.items.push(notice(82, 'warning'), notice(83, 'info'));
  const fixturePage = await fixture(state, 7);
  const { page } = fixturePage;
  try {
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('heading', { name: '公告 82' }).waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert.equal(state.writes.length, 0);
    await fixturePage.visit();
    await page.getByRole('checkbox').check();
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { name: '公告 82' }).waitFor();
    assert.deepEqual(state.writes, [{ user: 7, id: 81 }]);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await fixturePage.visit();
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await page.locator('.app-announcement').count(), 3);
    assert.deepEqual(fixturePage.errors, []);
  } finally { await fixturePage.context.close(); }
});

test('save failure keeps the dialog checked and retryable', async () => {
  const state = server();
  state.failNext = true;
  const fixturePage = await fixture(state, 7);
  const { page } = fixturePage;
  try {
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '我已知晓' }).click();
    await page.getByText('未能保存“不再弹出”，请重试。', { exact: true }).waitFor();
    assert.equal(await page.locator('dialog[open]').count(), 1);
    assert.equal(await page.getByRole('checkbox').isChecked(), true);
    assert.equal(await page.getByRole('button', { name: '我已知晓' }).isEnabled(), true);
    assert.equal(state.records.size, 0);
    await dismiss(page);
    assert.equal(state.writes.length, 2);
    await fixturePage.visit();
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.deepEqual(fixturePage.errors, []);
  } finally { await fixturePage.context.close(); }
});
