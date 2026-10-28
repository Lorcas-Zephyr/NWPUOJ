'use strict';
// Real upload markup + shared production script. All requests stay in fixtures;
// no files are sent to the live OJ and no accounts/resources are created.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

function uploadFixtures() {
  const result = [];
  for (const file of fs.readdirSync(path.join(root, 'views')).filter(name => name.endsWith('.ejs'))) {
    const source = read('views/' + file);
    const inputs = source.match(/<input\b[^>]*\btype\s*=\s*["']file["'][^>]*>/gi) || [];
    if (!inputs.length) continue;
    const fields = (source.match(/<label\b[^>]*class="[^"]*\bapp-file-field\b[^"]*"[^>]*>[\s\S]*?<\/label>/g) || [])
      .filter(field => /type="file"/.test(field));
    assert.equal(fields.length, inputs.length, file + ': every upload must use the shared file field');
    fields.forEach((field, index) => {
      // EJS only supplies a static icon or a numeric attachment limit here.
      const html = field.replace(/<%[-=][\s\S]*?%>/g, match => match.includes('submitIcons')
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16"/></svg>' : '20');
      result.push({ file, index, html });
    });
  }
  return result;
}

async function fixturePage(browser) {
  const fixtures = uploadFixtures();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/self/app-v2.js') return route.fulfill({ contentType: 'application/javascript', body: read('app-v2.js') });
    if (url.pathname.startsWith('/self/') && url.pathname.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: read(path.basename(url.pathname)) });
    assert.equal(route.request().method(), 'GET', 'fixture must not upload to live services');
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      + ['app-shell', 'app-shared', 'app-features'].map(name => '<link rel="stylesheet" href="/self/' + name + '.css">').join('')
      + '<style>.fixtures{padding:24px;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(270px,100%),1fr));gap:24px}.fixtures form{min-width:0}.fixtures h2{font-size:14px;overflow-wrap:anywhere}</style></head><body class="app-v2"><main class="fixtures">'
      + fixtures.map((fixture, index) => '<form id="upload-' + index + '"><h2>' + fixture.file + ' · ' + (fixture.index + 1) + '</h2>' + fixture.html + '<button type="reset" class="app-button app-button-quiet">清空</button></form>').join('')
      + '</main><script src="/self/app-v2.js"></script></body></html>' });
  });
  await page.goto('http://uploads.test/');
  await page.waitForFunction(() => !!window.NWPUOJApp);
  return { page, fixtures, errors };
}

test('all live upload surfaces display selected names, preserve constraints, and reset their hints', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const { page, fixtures, errors } = await fixturePage(browser);
    assert.ok(fixtures.length >= 15, 'all existing file inputs must be covered');
    for (const view of ['admin_banners', 'problem_submit_form', 'problem_manage', 'contest_registrations',
      'ticket', 'image_host', 'base_workspace', 'class_detail', 'problem_data',
      'problem_set_participants', 'problem_bulk_import', 'user_edit']) {
      assert.ok(fixtures.some(fixture => fixture.file === view + '.ejs'), view + ': missing upload coverage');
    }
    for (let index = 0; index < fixtures.length; index++) {
      const form = page.locator('#upload-' + index), input = form.locator('input[type="file"]');
      const status = form.locator('[data-file-selection]');
      assert.equal(await status.count(), 1);
      assert.equal(await status.textContent(), '未选择文件');
      const original = await input.evaluate(element => ({ name: element.name, accept: element.accept, required: element.required, multiple: element.multiple }));
      const filename = '报名名单_' + index + '_中文与空格 <img src=x onerror=alert(1)>.csv';
      await input.setInputFiles({ name: filename, mimeType: 'text/csv', buffer: Buffer.from('学号\n2026000001') });
      assert.equal(await status.locator('.app-file-selection-name').textContent(), filename, fixtures[index].file);
      assert.equal(await status.locator('.app-file-selection-name').getAttribute('title'), filename);
      assert.equal(await status.locator('img').count(), 0, 'filenames are text, never HTML');
      assert.equal(await status.isVisible(), true);
      assert.ok((await input.getAttribute('aria-describedby')).split(/\s+/).includes(await status.getAttribute('id')));
      const data = await form.evaluate(element => Array.from(new FormData(element).values()).filter(value => value instanceof File).map(file => file.name));
      assert.deepEqual(data, [filename], 'display logic must not alter the submitted file');
      await input.dispatchEvent('cancel');
      assert.equal(await status.locator('.app-file-selection-name').textContent(), filename, 'cancel preserves an existing selection');
      await input.setInputFiles({ name: '替换后的文件.csv', mimeType: 'text/csv', buffer: Buffer.from('学号') });
      assert.equal(await status.locator('.app-file-selection-name').textContent(), '替换后的文件.csv');
      await form.locator('[type="reset"]').click();
      await page.waitForFunction(id => document.querySelector('#' + id + ' [data-file-selection]').textContent === '未选择文件', 'upload-' + index);
      assert.equal(await input.evaluate(element => element.files.length), 0);
      assert.deepEqual(await input.evaluate(element => ({ name: element.name, accept: element.accept, required: element.required, multiple: element.multiple })), original);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('multiple and long filenames stay readable on mobile and in dark mode; dynamic fields also work', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const { page, errors } = await fixturePage(browser);
    const input = page.locator('input[type="file"][multiple]').first();
    const field = input.locator('..'), status = field.locator('[data-file-selection]');
    const files = Array.from({ length: 18 }, (_, index) => ({ name: '测试数据_' + index + '_' + '这是一个很长的文件名'.repeat(8) + '.in', mimeType: 'text/plain', buffer: Buffer.from('1 2') }));
    await input.setInputFiles(files);
    assert.match(await status.textContent(), /^已选择 18 个文件：/);
    assert.deepEqual(await status.locator('.app-file-selection-name').allTextContents(), files.map(file => file.name));
    const list = status.locator('.app-file-selection-list');
    assert.ok(await list.evaluate(element => element.scrollHeight > element.clientHeight));
    assert.equal(await list.getAttribute('tabindex'), '0');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.NWPUOJApp.setTheme('dark'));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile must not overflow');
    await field.scrollIntoViewIfNeeded();
    await field.screenshot({ path: '/tmp/nwpuoj-upload-selected-mobile.png' });
    await input.setInputFiles([]);
    assert.equal(await status.textContent(), '未选择文件');
    await page.evaluate(() => {
      const form = document.createElement('form');
      form.id = 'dynamic-upload';
      form.innerHTML = '<label class="app-file-field"><input type="file" name="dynamic"><span><strong>动态上传</strong></span></label>';
      document.querySelector('main').appendChild(form);
    });
    const dynamic = page.locator('#dynamic-upload');
    await dynamic.locator('[data-file-selection]').waitFor();
    await dynamic.locator('input').setInputFiles({ name: 'dynamic.zip', mimeType: 'application/zip', buffer: Buffer.from('fixture') });
    assert.match(await dynamic.locator('[data-file-selection]').textContent(), /dynamic.zip/);
    await dynamic.locator('input').evaluate(element => { element.value = ''; element.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(await dynamic.locator('[data-file-selection]').textContent(), '未选择文件');
    await page.setViewportSize({ width: 1400, height: 1100 });
    await page.evaluate(() => window.NWPUOJApp.setTheme('light'));
    await page.screenshot({ path: '/tmp/nwpuoj-upload-fields-desktop.png', fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
