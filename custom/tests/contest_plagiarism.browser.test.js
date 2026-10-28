'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');

function render(ended = true) {
  const template = fs.readFileSync(path.join(root, 'views/contest_plagiarism.ejs'), 'utf8').replace(/<% include app_(?:header|footer) %>/g, '');
  const script = `const fs=require('fs'),ejs=require('/app/node_modules/ejs');const x=JSON.parse(fs.readFileSync(0,'utf8'));
    x.data.syzoj={utils:{makeUrl:p=>'/'+p.join('/')}};process.stdout.write(ejs.render(x.template,x.data));`;
  const result = spawnSync('docker', ['exec', '-i', 'nwpuoj-web-1', 'node', '-e', script], { input: JSON.stringify({ template,
    data: { contest: { id: 10, title: '查重测试比赛' }, plagiarismReady: true, plagiarismEnded: ended } }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    ['app-shell.css', 'app-shared.css', 'app-features.css'].map(file => '<link rel="stylesheet" href="/self/' + file + '">').join('') +
    '</head><body class="app-v2"><main class="app-main">' + result.stdout + '</main><script>window.__NWPUOJ_APP={csrfToken:"fixture-token"};</script><script src="/self/app-v2.js"></script></body></html>';
}

test('one-click check, progress, history, filters, pagination and safe side-by-side comparison work in desktop/mobile', { timeout: 60000 }, async () => {
  const html = render(), runningHtml = render(false);
  const fixtureJob = { id: 1, created_at: 1791777600, state: 'completed', finished_at: 1791777620,
    summary: { engine: '6.3.0', total: 120, selected: 60, done: 1, group_count: 1, pair_count: 55,
      groups: [{ key: 'p20-cpp', problem_id: 20, title: '排序 <script>bad()</script>', language_label: 'C / C++', count: 60, state: 'completed', report: true }] } };
  const pairs = Array.from({ length: 55 }, (_, index) => ({ key: 'p20-cpp:' + (100 + index) + ':200', group: 'p20-cpp', problem_id: 20,
    title: '排序 <script>bad()</script>', language_label: 'C / C++', first_id: 100 + index, second_id: 200, first_user_id: 2, second_user_id: 3,
    first_username: '甲 <img src=x onerror=bad()>', second_username: '乙', similarity: index === 0 ? 1 : 0.6 }));
  let current = null, complete = false, failNext = false;
  const calls = [], errors = [];
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      assert.equal(url.origin, 'http://plagiarism.test');
      if (url.pathname.startsWith('/self/')) {
        const file = path.basename(url.pathname);
        return route.fulfill({ contentType: file.endsWith('.js') ? 'application/javascript' : 'text/css', body: fs.readFileSync(path.join(root, file)) });
      }
      if (url.pathname === '/api/v2/contests/10/plagiarism') {
        if (request.method() === 'POST') {
          calls.push({ body: request.postDataJSON(), headers: request.headers() });
          if (failNext) { failNext = false; return route.fulfill({ status: 503, json: { error: { message: '引擎繁忙' } } }); }
          current = { ...fixtureJob, state: 'queued', finished_at: null, summary: { groups: [] } };
          return route.fulfill({ status: 202, json: { data: current } });
        }
        if (complete) current = fixtureJob;
        return route.fulfill({ json: { data: { items: current ? [current] : [], next_before_id: null } } });
      }
      if (url.pathname.endsWith('/comparison')) return route.fulfill({ json: { data: {
        first: { id: 100, username: '甲', code: '// <script>bad()</script>\nint main() {\n  return 0;\n}' },
        second: { id: 200, username: '乙', code: '// comment\nint main() {\n  return 0;\n}' }, similarity: 1,
        matches: [{ startInFirst: { line: 2 }, endInFirst: { line: 4 }, startInSecond: { line: 2 }, endInSecond: { line: 4 } }] } } });
      if (url.pathname === '/api/v2/contests/10/plagiarism/1') {
        const number = Number(url.searchParams.get('page') || 1), minimum = Number(url.searchParams.get('minimum') || 30);
        const filtered = complete ? pairs.filter(pair => pair.similarity * 100 >= minimum) : [];
        return route.fulfill({ json: { data: { ...current, pairs: filtered.slice((number - 1) * 50, number * 50), total: filtered.length, page: number, page_count: Math.max(1, Math.ceil(filtered.length / 50)) } } });
      }
      return route.fulfill({ contentType: 'text/html', body: url.pathname === '/running' ? runningHtml : html });
    });
    await page.goto('http://plagiarism.test/contest/10/plagiarism');
    await page.locator('[data-plagiarism-empty]:not([hidden])').waitFor();
    await page.getByRole('button', { name: '一键查重', exact: true }).click();
    await page.getByRole('button', { name: '查重进行中', exact: true }).waitFor();
    assert.equal(calls.length, 1); assert.ok(calls[0].body.request_token);
    assert.equal(calls[0].headers['x-csrf-token'], 'fixture-token'); assert.ok(calls[0].headers['idempotency-key']);
    assert.equal(await page.locator('[data-plagiarism-start]').isDisabled(), true);
    complete = true;
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-plagiarism-state]').textContent === '已完成');
    assert.equal(await page.locator('[data-plagiarism-pairs] > tr').count(), 50);
    assert.equal(await page.getByRole('link', { name: '下载网页报告', includeHidden: true }).getAttribute('href'), '/contest/10/plagiarism/1/report/p20-cpp?format=html');
    assert.equal(await page.getByRole('link', { name: '原始 .jplag', includeHidden: true }).getAttribute('href'), '/contest/10/plagiarism/1/report/p20-cpp');
    assert.equal(await page.locator('[data-plagiarism-pairs] script, [data-plagiarism-pairs] img').count(), 0);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-plagiarism-page]').textContent.includes('第 2'));
    assert.equal(await page.locator('[data-plagiarism-pairs] > tr').count(), 5);
    await page.locator('[data-plagiarism-minimum]').selectOption('90');
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-plagiarism-page]').textContent.includes('共 1 对'));
    await page.getByRole('button', { name: '查看比对', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-plagiarism-match-label]').textContent === '相似片段 1 / 1');
    assert.equal(await page.locator('[data-plagiarism-first-code] .is-current').count(), 3);
    assert.equal(await page.locator('[data-plagiarism-first-code] script').count(), 0);
    await page.screenshot({ path: '/tmp/nwpuoj-plagiarism-comparison-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    const rect = await page.getByRole('dialog').boundingBox();
    assert.ok(rect.x >= 0 && rect.width <= 390);
    await page.screenshot({ path: '/tmp/nwpuoj-plagiarism-comparison-mobile.png' });
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(await page.getByRole('dialog').isVisible(), false);
    const width = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: innerWidth }));
    assert.ok(width.doc <= width.win + 1, JSON.stringify(width));
    await page.screenshot({ path: '/tmp/nwpuoj-plagiarism-mobile.png' });
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.screenshot({ path: '/tmp/nwpuoj-plagiarism-desktop.png' });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-plagiarism-state]').textContent === '已完成');
    assert.equal(await page.locator('[data-plagiarism-jobs]').inputValue(), '1');
    failNext = true;
    await page.getByRole('button', { name: '一键查重', exact: true }).click();
    await page.locator('[data-plagiarism-error]:not([hidden])').waitFor();
    assert.match(await page.locator('[data-plagiarism-error]').textContent(), /引擎繁忙/);
    await page.getByRole('button', { name: '一键查重', exact: true }).click();
    assert.notEqual(calls[1].body.request_token, calls[2].body.request_token, 'explicit failure allows a fresh operation key');
    await page.goto('http://plagiarism.test/running');
    assert.equal(await page.locator('[data-plagiarism-start]').isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('downloaded HTML report works offline with pagination, search, code navigation and safe contestant text', { timeout: 60000 }, async () => {
  const { renderWebReport } = require('../libs/contest-plagiarism');
  const fsp = require('node:fs/promises'), os = require('node:os'), { pathToFileURL } = require('node:url');
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'noj-web-report-test-'));
  const filename = path.join(directory, 'report.html');
  const malicious = '</script><script>window.reportAttack=true</script><img src="https://example.invalid/leak" onerror="window.reportAttack=true">';
  const source = '// ' + malicious + '\n' + Array.from({ length: 150 }, (_, i) => 'int value' + i + ' = ' + i + ';').join('\n');
  const submissions = { 999: { id: 999, user_id: 999, username: '乙', language: 'C++23', code: source } };
  const pairs = Array.from({ length: 55 }, (_, i) => {
    submissions[i + 1] = { id: i + 1, user_id: i + 1, username: i ? '选手' + i : malicious, language: 'C++23', code: source };
    return { first_id: i + 1, second_id: 999, similarity: i ? 0.6 : 1, matches: [[2, 5, 2, 5], [100, 110, 100, 110]] };
  });
  const data = { contest_id: 10, job_id: 1, engine: '6.3.0', minimum_similarity: 0.3,
    group: { problem_id: 20, title: '排序 ' + malicious, language_label: 'C / C++', count: 57, state: 'partial', message: '1 份代码有效 token 不足。',
      failed: [{ username: '短代码选手', submission_id: 1000, state: 'TOO_SMALL' }] }, submissions, pairs };
  await fsp.writeFile(filename, renderWebReport(data));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ offline: true, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(), errors = [], network = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (/^https?:/.test(r.url())) network.push(r.url()); });
    await page.goto(pathToFileURL(filename).href);
    await page.locator('#pairs > tr').first().waitFor();
    assert.equal(await page.locator('#pairs > tr').count(), 50);
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(await page.evaluate(() => window.reportAttack), undefined);
    assert.match(await page.locator('details').textContent(), /短代码选手[\s\S]*#1000[\s\S]*有效 token 不足/);
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    assert.equal(await page.locator('#pairs > tr').count(), 5);
    await page.locator('#search').fill('选手54');
    assert.equal(await page.getByRole('button', { name: '查看比对' }).count(), 1);
    await page.locator('#search').fill('not-found');
    assert.match(await page.locator('#pairs').textContent(), /没有比较记录/);
    await page.locator('#search').fill('');
    await page.locator('#minimum').selectOption('90');
    assert.equal(await page.getByRole('button', { name: '查看比对' }).count(), 1);
    await page.getByRole('button', { name: '查看比对' }).click();
    assert.equal(await page.locator('#first-code .current').count(), 4);
    assert.ok((await page.locator('#first-code').textContent()).includes(malicious));
    assert.equal(await page.locator('#first-code script').count(), 0);
    await page.getByRole('button', { name: '下一处' }).click();
    assert.equal(await page.locator('#match-label').textContent(), '相似片段 2 / 2');
    assert.equal(await page.locator('#first-code .current').count(), 11);
    assert.ok(await page.locator('#first-code').evaluate(el => el.scrollTop > 0));
    await page.screenshot({ path: '/tmp/nwpuoj-web-report-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    const box = await page.getByRole('dialog').boundingBox(); assert.ok(box.width <= 390 && box.x >= 0);
    await page.screenshot({ path: '/tmp/nwpuoj-web-report-mobile.png' });
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.reload();
    assert.equal(await page.locator('#pairs > tr').count(), 50);
    assert.deepEqual(errors, []); assert.deepEqual(network, []);
    await fsp.writeFile(filename, renderWebReport({ ...data, submissions: {}, pairs: [] }));
    await page.reload(); assert.match(await page.locator('#pairs').textContent(), /没有比较记录/);
  } finally { await browser.close(); await fsp.rm(directory, { recursive: true, force: true }); }
});
