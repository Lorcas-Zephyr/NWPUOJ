'use strict';
// Real shared list template with fixture data and intercepted live updates.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function render(empty = false, admin = true) {
  const template = read('views/submissions.ejs').replace(/<% include (?:util|app_header|app_footer|problem_context|contest_context|problem_set_context) %>/g, '')
    .replace('<% include app_pagination %>', read('views/app_pagination.ejs'));
  const script = `const fs=require('fs'),ejs=require('/app/node_modules/ejs');const x=JSON.parse(fs.readFileSync(0,'utf8'));
    const form={language:'cpp',page:'2'},utils={makeUrl:(parts,q)=>'/'+parts.join('/')+(q&&Object.keys(q).length?'?'+new URLSearchParams(q):'')};
    process.stdout.write(ejs.render(x.template,{displayConfig:{inBase:true,inContest:false,inProblemSet:false,showOthers:true,showScore:true,showUsage:true,showCode:true,showResult:true},
      items:x.empty?[]:[{info:{submissionId:100,taskId:'task-100',problemId:12,sourceProblemId:12,problemDisplayId:'12',problemName:'基地 A+B',userId:2,user:'member',language:'C++ 23',codeSize:120,submitTime:'2026-09-24 12:00:00',canViewDetail:true},result:{result:'Waiting',score:0,time:0,memory:0},running:true,token:'fixture-token'}],
      baseContext:true,baseAdmin:x.admin,user:{id:2,username:'member'},form,req:{query:form},isFiltered:true,serializejs:JSON.stringify,vjudge:{languages:{}},
      paginate:{currPage:2,pageCnt:3},paginationBasePath:['base','submissions'],syzoj:{utils,config:{filter_enabled_languages:['cpp']},languages:{cpp:{show:'C++ 23'}}}}));`;
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], {
    cwd: path.join(root, '..'), input: JSON.stringify({ template, empty, admin }), encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + ['app-shell', 'app-shared', 'app-features'].map(name => '<link rel="stylesheet" href="/self/' + name + '.css">').join('')
    + '<script src="/self/lucide-1.27.0.min.js"></script></head><body class="app-v2"><main class="app-main">'
    + result.stdout + '</main><script src="/self/app-v2.js"></script></body></html>';
}

test('base list preserves filters and links, updates status in place, and scrolls within mobile tables', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  try {
    const html = render(), errors = [];
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    let streamRequests = 0;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/self/')) return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css', body: read(path.basename(url.pathname)) });
      if (url.pathname === '/api/v2/submissions/events') {
        streamRequests++;
        assert.deepEqual(JSON.parse(new URLSearchParams(route.request().postData()).get('tokens')), ['fixture-token']);
        await ready;
        return route.fulfill({ contentType: 'text/event-stream', body: 'event: status\ndata: ' + JSON.stringify({ submissionId: 100, pending: false, result: { result: 'Accepted', score: 100, time: 5, memory: 256 } }) + '\n\n' });
      }
      assert.equal(route.request().method(), 'GET');
      return route.fulfill({ contentType: 'text/html', body: html });
    });
    await page.goto('http://base.test/base/submissions?language=cpp&page=2');
    await page.waitForFunction(() => document.querySelectorAll('svg.lucide').length > 0);
    const row = page.locator('[data-submission-id="100"]');
    await row.evaluate(element => { element.dataset.sameRow = 'yes'; });
    assert.equal(await page.locator('[aria-current="page"][href="/base/submissions"]').count(), 1);
    assert.equal(await page.locator('#submission-filter-form').getAttribute('action'), '/base/submissions');
    const next = new URL(await page.locator('#page_next').getAttribute('href'), 'http://base.test');
    assert.equal(next.pathname, '/base/submissions');
    assert.equal(next.searchParams.get('page'), '3');
    assert.equal(next.searchParams.get('language'), 'cpp');
    assert.equal(await row.locator('.app-cell-primary a').getAttribute('href'), '/problem/12');
    assert.equal(await row.locator('[data-submission-status]').getAttribute('href'), '/submission/100');
    assert.equal(await row.locator('[data-submission-status]').textContent(), 'Waiting');
    release();
    await page.waitForFunction(() => document.querySelector('[data-submission-status]').textContent === 'Accepted');
    assert.equal(await row.getAttribute('data-same-row'), 'yes', 'status changes must not replace or reorder rows');
    assert.equal(await row.locator('[data-submission-score]').textContent(), '100');
    assert.equal(await row.locator('[data-submission-time]').textContent(), '5 ms');
    assert.equal(streamRequests, 1);
    await page.screenshot({ path: '/tmp/nwpuoj-base-submissions-desktop.png', fullPage: true });
    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile page does not overflow at ' + width);
      assert.ok(await page.locator('.app-table-region').evaluate(element => element.scrollWidth > element.clientWidth));
      assert.equal(await row.locator('td').nth(7).isVisible(), true, 'submitter remains available by horizontal scrolling');
    }
    await page.screenshot({ path: '/tmp/nwpuoj-base-submissions-mobile.png', fullPage: true });
    await page.getByRole('button', { name: '我的', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/base/submissions' && url.searchParams.get('submitter') === 'member');
    assert.equal(new URL(page.url()).searchParams.get('language'), 'cpp');
    assert.deepEqual(errors, []);
  } finally { release(); await browser.close(); }
});

test('empty base submissions render without errors and ordinary members have no member-management tab', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage(), html = render(true, false), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/self/')) return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css', body: read(path.basename(url.pathname)) });
      assert.equal(route.request().method(), 'GET');
      return route.fulfill({ contentType: 'text/html', body: html });
    });
    await page.goto('http://base.test/base/submissions');
    assert.equal(await page.getByText('没有匹配的提交', { exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('link', { name: '成员管理', exact: true }).count(), 0);
    assert.equal(await page.getByRole('link', { name: '清除', exact: true }).getAttribute('href'), '/base/submissions');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
