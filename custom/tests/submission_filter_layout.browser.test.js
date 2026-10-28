'use strict';

// Render the actual shared template/styles with isolated data; no live writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function render(kind, limited = false) {
  const template = read('views/submissions.ejs').replace(/<% include \w+ %>/g, '');
  const source = `const fs=require('fs'),ejs=require('/app/node_modules/ejs');const x=JSON.parse(fs.readFileSync(0,'utf8'));
    const inContest=x.kind==='contest'||x.kind==='baseContest',inProblemSet=x.kind==='problemSet';
    const utils={makeUrl:(parts,q)=>'/'+parts.join('/')+(q&&Object.keys(q).length?'?'+new URLSearchParams(q):'')};
    process.stdout.write(ejs.render(x.template,{displayConfig:{inContest,inProblemSet,inBase:false,showOthers:!x.limited,showScore:!x.limited&&x.kind!=='baseContest',showScoreFilter:x.kind==='baseContest',showResult:!x.limited},
      contest:{id:21,title:'测试比赛'},problemSet:{id:31,title:'测试题单'},baseContext:x.kind==='baseContest',
      items:[],user:{id:2,username:'filter_tester'},form:{problem_id:'1',language:'cpp',min_score:'0',max_score:'100',status:'Accepted'},
      req:{query:{}},isFiltered:true,serializejs:JSON.stringify,vjudge:{languages:{}},
      syzoj:{utils,config:{filter_enabled_languages:['cpp']},languages:{cpp:{show:'C++ 23'}}}}));`;
  const result = spawnSync('docker', ['exec', '-i', 'nwpuoj-web-1', 'node', '-e', source], {
    input: JSON.stringify({ template, kind, limited }), encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + ['app-shell', 'app-shared', 'app-features'].map(name => '<link rel="stylesheet" href="/self/' + name + '.css">').join('')
    + '</head><body class="app-v2"><main class="app-main">' + result.stdout + '</main></body></html>';
}

test('activity submission filters fit one desktop row, wrap on mobile and preserve GET actions', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    for (const kind of ['contest', 'problemSet', 'baseContest', 'global']) {
      const html = render(kind), limitedHtml = kind === 'contest' ? render(kind, true) : null;
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith('/self/')) return route.fulfill({ contentType: 'text/css', body: read(path.basename(url.pathname)) });
        assert.equal(route.request().method(), 'GET');
        return route.fulfill({ contentType: 'text/html', body: url.searchParams.has('limited') ? limitedHtml : html });
      });
      const pathname = kind === 'problemSet' ? '/problem-set/31/submissions' : kind === 'global' ? '/submissions' : '/contest/21/submissions';
      await page.goto('http://filters.test' + pathname);
      const controls = page.locator('#submission-filter-form .app-form-grid input, #submission-filter-form .app-form-grid select');
      assert.equal(await controls.count(), 6);
      assert.equal(await page.locator('.app-submission-filter-compact').count(), kind === 'global' ? 0 : 1);
      if (kind === 'global') {
        const tops = await controls.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
        assert.ok(Math.max(...tops) - Math.min(...tops) > 20, 'global list retains its existing grid');
        await page.close(); continue;
      }
      for (const width of [1440, 1366, 1024]) {
        await page.setViewportSize({ width, height: 900 });
        const bounds = await controls.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { top: r.top, width: r.width, right: r.right }; }));
        assert.ok(Math.max(...bounds.map(r => r.top)) - Math.min(...bounds.map(r => r.top)) < 1, kind + ' is a single row at ' + width);
        assert.ok(bounds.every(r => r.width <= 181 && r.width >= 60 && r.right <= width), 'compact, usable inputs');
      }
      for (const width of [768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const tops = await controls.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
        assert.ok(Math.max(...tops) - Math.min(...tops) > 20, 'wraps on a narrow screen');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no page overflow');
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      if (kind === 'contest') await page.screenshot({ path: '/tmp/noj-submission-filter-desktop.png' });
      await page.locator('[name="problem_id"]').fill('2');
      await page.locator('[name="submitter"]').fill('another_user');
      await page.locator('[name="min_score"]').fill('15');
      await page.locator('[name="max_score"]').fill('85');
      await page.locator('[name="status"]').selectOption('Time Limit Exceeded');
      await page.getByRole('button', { name: '应用筛选', exact: true }).click();
      await page.waitForURL(url => url.pathname === pathname && url.searchParams.get('submitter') === 'another_user');
      const params = new URL(page.url()).searchParams;
      for (const [key, value] of Object.entries({ problem_id: '2', language: 'cpp', min_score: '15', max_score: '85', status: 'Time Limit Exceeded' })) assert.equal(params.get(key), value);
      await page.getByRole('button', { name: '我的', exact: true }).click();
      await page.waitForURL(url => url.pathname === pathname && url.searchParams.get('submitter') === 'filter_tester');
      await page.getByRole('link', { name: '清除', exact: true }).click();
      await page.waitForURL(url => url.pathname === pathname && !url.search);
      if (limitedHtml) {
        await page.goto('http://filters.test' + pathname + '?limited=1');
        assert.equal(await controls.count(), 2);
        const tops = await controls.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
        assert.ok(Math.abs(tops[0] - tops[1]) < 1, 'hidden score/submitter/status fields leave no gaps');
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
