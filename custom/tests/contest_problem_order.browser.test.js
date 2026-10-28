'use strict';

// Render the real editor and intercept all browser requests. These tests never
// create or change a production contest, problem, user or session.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const longTitle = '长题目名称与特殊字符 <b>不是标签</b> '.repeat(8);
const labels = new Map([11, 12, 13, 14].map(id => [id, `${id}. ${id === 14 ? longTitle : '测试题目' + id}`]));

function renderEditor(base, ids) {
  const template = read('views/contest_edit.ejs')
    .replace('<% include app_header %>', '').replace('<% include app_footer %>', '');
  const script = `
    const fs = require('fs'), ejs = require('/app/node_modules/ejs');
    const x = JSON.parse(fs.readFileSync(0, 'utf8'));
    const utils = { makeUrl: parts => '/' + parts.join('/'), getCurrentDate: () => 1791072000,
      formatDate: t => new Date(t * 1000).toISOString().slice(0, 16) };
    const contest = { id: 21, title: '题目顺序测试', subtitle: '', information: '', type: 'acm',
      is_public: true, start_time: 1793520000, end_time: 1793534400 };
    const problems = x.ids.map(id => ({id, title: id === 14 ? x.longTitle : '测试题目' + id, getDisplayId: () => id}));
    process.stdout.write(ejs.render(x.template, {contest, problems, admins: [{id: 2, username: '比赛管理员'}],
      baseContext: x.base, baseMember: x.base, appHasCapability: () => false, adminCsrfToken: '',
      user: {id: 2}, req: {query: {}}, syzoj: {utils}}));
  `;
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], {
    cwd: path.join(root, '..'), input: JSON.stringify({ template, base, ids, longTitle }),
    encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + ['app-shell.css', 'app-shared.css', 'app-features.css'].map(name => `<link rel="stylesheet" href="/self/${name}">`).join('')
    + '<script src="/self/lucide-1.27.0.min.js"></script></head><body class="app-v2"><main class="app-main">'
    + result.stdout + '</main><script src="/self/app-v2.js"></script><script src="/self/lib/noj-markdown.js" data-upload-allowed="1"></script></body></html>';
}

for (const base of [false, true]) {
  test(`${base ? 'base' : 'ordinary'} contest problem arrows preserve search, review, save and reload order`, { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(8000);
    let storedIds = [11, 12, 13];
    const writes = [], errors = [], searchScopes = [], dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.startsWith('/self/')) return route.fulfill({
        contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css',
        body: fs.readFileSync(path.join(root, url.pathname.replace(/^\/self\/lib\//, 'static-libs/').replace(/^\/self\//, '')))
      });
      if (url.pathname.startsWith('/api/v2/search/problems/')) {
        searchScopes.push(url.searchParams.get('workspace'));
        return route.fulfill({ json: { data: [11, 14].map(id => ({ id, name: labels.get(id) })) } });
      }
      if (url.pathname === '/api/v2/contests/21' && request.method() === 'GET') {
        // Reproduce external proxies: the ETag is available only in JSON.
        return route.fulfill({ json: { data: { id: 21 }, meta: { etag: '"test-revision"' } } });
      }
      if (url.pathname === '/api/v2/contests/21/update' && request.method() === 'POST') {
        const body = request.postDataJSON();
        writes.push({ body, headers: request.headers() });
        storedIds = body.problem_ids;
        return route.fulfill({ json: { data: { id: 21 } } });
      }
      if (url.pathname === '/contest/21/edit') return route.fulfill({ contentType: 'text/html', body: renderEditor(base, storedIds) });
      if (url.pathname === '/contest/21/details') return route.fulfill({ contentType: 'text/html', body: '<p>Saved contest fixture</p>' });
      return route.fulfill({ status: 404, body: '' });
    });
    const picker = page.locator('[data-entity-picker][data-name="problems"]');
    const row = id => picker.locator(`[data-picker-value="${id}"]`);
    const move = (id, direction) => row(id).locator(`[data-picker-move="${direction}"]`);
    const order = () => picker.locator('[data-picker-value]').evaluateAll(rows => rows.map(row => Number(row.dataset.pickerValue)));
    async function checkBoundaries(expected) {
      assert.deepEqual(await order(), expected);
      for (let i = 0; i < expected.length; i++) {
        assert.equal(await move(expected[i], 'up').isDisabled(), i === 0);
        assert.equal(await move(expected[i], 'down').isDisabled(), i === expected.length - 1);
      }
    }
    try {
      await page.goto('http://contest-order.test/contest/21/edit');
      await page.waitForFunction(() => document.querySelectorAll('[data-vditor-ready="1"]').length === 2);
      await page.locator('textarea[name="subtitle"]').evaluate(source => { source.value = '比赛简介\n第二行'; });
      await page.locator('textarea[name="information"]').evaluate(source => { source.value = '## 比赛公告\n\n支持 **Markdown**'; });
      await page.locator('[data-contest-step-next]').click();
      await checkBoundaries([11, 12, 13]);
      assert.equal(await page.locator('[data-name="admins"] [data-picker-move]').count(), 0);
      assert.equal(await page.locator('[data-name="admins"]').count(), base ? 0 : 1);
      await move(12, 'up').click();
      await checkBoundaries([12, 11, 13]);
      assert.equal(await move(12, 'down').evaluate(button => button === document.activeElement), true, 'focus follows the moved row');
      await move(12, 'down').click();
      await move(13, 'up').click();
      await checkBoundaries([11, 13, 12]);
      await picker.locator('[data-picker-search]').fill('测试');
      await picker.locator('[data-picker-results] button').waitFor();
      assert.equal(await picker.locator('[data-picker-results] button').count(), 1, 'existing problems cannot be duplicated');
      await picker.locator('[data-picker-results] button').click();
      await checkBoundaries([11, 13, 12, 14]);
      assert.equal(await row(14).locator('em b').count(), 0, 'titles remain escaped');
      assert.equal(await row(14).locator('em').getAttribute('title'), labels.get(14).trim());
      assert.equal(await move(14, 'up').locator('svg').count(), 1, 'new arrows render actual icons');
      await move(14, 'up').click();
      await row(11).locator('[data-picker-remove]').click();
      await checkBoundaries([13, 14, 12]);
      await move(14, 'up').focus();
      await page.keyboard.press('Enter');
      await checkBoundaries([14, 13, 12]);
      assert.equal(writes.length, 0, 'move buttons never submit the form');
      assert.deepEqual(await page.locator('#contest-editor-form').evaluate(form => new FormData(form).getAll('problems')), ['14', '13', '12']);
      await page.screenshot({ path: `/tmp/nwpuoj-contest-order-${base ? 'base' : 'global'}-desktop.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no mobile page overflow');
      assert.equal(await row(14).evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'long title stays inside the row');
      for (const direction of ['up', 'down']) assert.ok((await move(13, direction).boundingBox()).width >= 32);
      await move(13, 'down').click();
      await move(13, 'up').click();
      await checkBoundaries([14, 13, 12]);
      await page.screenshot({ path: `/tmp/nwpuoj-contest-order-${base ? 'base' : 'global'}-mobile.png`, fullPage: true });
      await page.locator('[data-contest-step-next]').click();
      await page.locator('[data-contest-step-next]').click();
      assert.equal(await page.locator('[data-review-problems]').textContent(), '3 道 · ' + [14, 13, 12].map(id => labels.get(id).trim()).join('、'));
      await page.locator('#submit_button').click();
      await page.waitForURL('**/contest/21/details');
      assert.equal(writes.length, 1);
      assert.deepEqual(writes[0].body.problem_ids, [14, 13, 12]);
      assert.deepEqual(writes[0].body.admins, base ? [] : [2]);
      assert.equal(writes[0].body.workspace, base ? 'base' : 'global');
      assert.equal(writes[0].headers['if-match'], '"test-revision"');
      assert.equal(writes[0].body.if_match, '"test-revision"');
      assert.equal(writes[0].body.is_rated, false);
      assert.equal(writes[0].body.subtitle, '比赛简介\n第二行');
      assert.equal(writes[0].body.information, '## 比赛公告\n\n支持 **Markdown**');
      await page.goto('http://contest-order.test/contest/21/edit');
      await page.locator('[data-contest-step-next]').click();
      await checkBoundaries([14, 13, 12]);
      await row(14).locator('[data-picker-remove]').click();
      await row(13).locator('[data-picker-remove]').click();
      await checkBoundaries([12]);
      await row(12).locator('[data-picker-remove]').click();
      await checkBoundaries([]);
      await picker.locator('[data-picker-search]').fill('测试');
      await picker.locator('[data-picker-results] button').filter({ hasText: '14.' }).click();
      await checkBoundaries([14]);
      assert.deepEqual(searchScopes, [base ? 'base' : null, base ? 'base' : null]);
      assert.deepEqual(errors, []);
      assert.deepEqual(dialogs, []);
    } finally { await browser.close(); }
  });
}
