'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');

function renderLogin() {
  const source = fs.readFileSync(path.join(root, 'views/login.ejs'), 'utf8').replace(/<% include \w+ %>/g, '');
  const script = 'const fs=require("fs"),ejs=require("/app/node_modules/ejs");process.stdout.write(ejs.render(fs.readFileSync(0,"utf8"),{req:{query:{url:"/problems"},originalUrl:"/login"},serializejs:JSON.stringify,syzoj:{config:{nwpuoj_version:"2.1.0"},utils:{makeUrl:p=>"/"+p.join("/"),safeLocalUrl:()=>"/problems"}}}));';
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], {
    cwd: path.join(root, '..'), input: source, encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  return '<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    ['app-shell.css', 'app-shared.css', 'app-features.css'].map(name => '<link rel="stylesheet" href="/self/' + name + '">').join('') +
    '</head><body class="app-v2"><main class="app-main"><div class="app-page">' + result.stdout +
    '</div></main><script src="/self/app-v2.js"></script></body></html>';
}

test('real login checkbox stays opt-in, submits booleans, preserves errors/redirects and fits mobile/dark UI', { timeout: 60000 }, async () => {
  const html = renderLogin();
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], bodies = [];
  let success = false, temporary = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, 'http://remember.test', 'all requests remain isolated');
    if (url.pathname === '/api/v2/auth/login') {
      bodies.push(route.request().postDataJSON());
      return route.fulfill(success ? { json: { data: { authenticated: true, redirect_url: temporary ? '/contests' : null } } } :
        { status: 401, json: { error: { code: 'INVALID_CREDENTIALS', message: 'invalid' } } });
    }
    if (url.pathname.startsWith('/self/')) {
      const file = path.join(root, url.pathname.slice(6));
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
      return route.fulfill({ contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'image/png', body: fs.readFileSync(file) });
    }
    return route.fulfill({ contentType: 'text/html', body: url.pathname === '/login' ? html : '<!doctype html><h1>登录成功</h1>' });
  });
  try {
    await page.goto('http://remember.test/login');
    const checkbox = page.getByRole('checkbox', { name: '记住我', exact: true });
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(await page.locator('#remember-me-hint').isVisible(), true);
    await page.locator('#username').fill('0012345678');
    await page.locator('#password').fill('isolated_fixture_password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('#login-message:not([hidden])').waitFor();
    assert.equal(bodies[0].remember_me, false);
    assert.equal(bodies[0].username, '0012345678');
    assert.equal(await checkbox.isChecked(), false);
    await checkbox.check();
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#login-button').disabled);
    assert.equal(bodies[1].remember_me, true);
    assert.equal(await checkbox.isChecked(), true, 'a failed sign-in retains the choice');
    await page.screenshot({ path: '/tmp/nwpuoj-login-remember-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => NWPUOJApp.setTheme('dark'));
    assert.equal(await checkbox.isVisible(), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: '/tmp/nwpuoj-login-remember-mobile-dark.png', fullPage: true });
    success = true;
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/problems');
    assert.equal(bodies[2].remember_me, true);
    temporary = true;
    await page.goto('http://remember.test/login');
    assert.equal(await checkbox.isChecked(), false, 'a new login defaults to unselected');
    await page.locator('#username').fill('temporary_fixture');
    await page.locator('#password').fill('isolated_fixture_password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/contests');
    assert.equal(bodies[3].remember_me, false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
