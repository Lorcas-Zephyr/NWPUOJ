'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function render(partial, updated) {
  const template = read('views/contest_ranklist.ejs').replace('<% include app_header %>', '')
    .replace('<% include contest_context %>', '').replace('<% include app_footer %>', '')
    .replace('<% include app_pagination %>', read('views/app_pagination.ejs'));
  const script = `const fs=require('fs'),ejs=require('/app/node_modules/ejs');const x=JSON.parse(fs.readFileSync(0,'utf8'));
    const template=x.template.replace('<% include util %>',fs.readFileSync('/app/views/util.ejs','utf8'));
    const contest={id:21,title:'局部榜单测试',type:'acm',start_time:100,end_time:2000,isEnded:()=>false,isRunning:()=>true};
    const items=[7,8].map(id=>({user:{id,username:'player'+id},player:{score:x.updated?(id===8?2:1):0,score_details:{},standing_rank:x.updated?(id===8?1:2):1,medal:id===(x.updated?8:7)?'gold':'silver'}}));
    if(x.updated)items.reverse();
    const utils={makeUrl:(parts,query)=>'/'+parts.join('/')+(query?'?'+new URLSearchParams(query):''),removeTitleTag:s=>s,formatTime:String,formatDate:String,getCurrentDate:()=>300,renderUsername:u=>'<a href="/user/'+u.id+'">'+u.username+'</a>'};
    process.stdout.write(ejs.render(template,{ranklistPartial:x.partial,contest,ranklist:items,user:{id:7},problems:[{id:11,title:'最新题名'}],req:{query:{account:'ordinary',classes:'3',page:'1'}},ranklistTotal:2,ranklistAccountFilter:'ordinary',ranklistClassOptions:[{id:3,name:'班级甲',tag:'甲'}],ranklistSelectedClassIds:[3],canManageRanklist:true,showRanklistIdentities:false,ranklistProfiles:new Map(),standingsView:{frozen:false,cutoff:null,showLive:false},paginate:{pageCnt:2,currPage:1},paginationBasePath:['contest',21,'ranklist'],syzoj:{utils}}));`;
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], {
    cwd: path.join(root, '..'), input: JSON.stringify({ template, partial, updated }), encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('live rank updates preserve row nodes, scroll, open filters and pagination; errors retain results', async () => {
  const initial = render(false, false), changed = render(true, true);
  assert.doesNotMatch(changed, /<script|<html|data-contest-notifier/);
  assert.match(changed, /\/contest\/21\/ranklist\?/);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1200, height: 650 } });
  const page = await context.newPage();
  await page.clock.install();
  let calls = 0, fail = false, revoked = false;
  const requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/self/')) return route.fulfill({ contentType: 'application/javascript', body: read(url.pathname.split('/').pop()) });
    if (url.pathname.includes('ranklist-view')) {
      requests.push(url); calls++;
      return route.fulfill({ status: revoked ? 403 : fail ? 500 : 200, contentType: 'application/json', body: JSON.stringify(fail || revoked ? { error: { message: 'fixture' } } : {
        data: { html: calls === 1 ? changed : null, revision: 'v2', unchanged: calls > 1, next_update_ms: 5000, can_manage: true, frozen: false, show_live: false,
          clock: { start: 100, end: 2000, now: 300 }, title: '最新比赛标题' }, error: null
      }) });
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div class="app-contest-context" style="height:400px"><h1>原比赛标题</h1></div>' + initial + '<div style="height:2000px"></div></body></html>' });
  });
  try {
    await page.goto('http://rank.test/contest/21/ranklist?account=ordinary&classes=3&page=1');
    assert.equal(await page.locator('[data-rank-user-id="7"] .app-rank-number.is-gold').count(), 1);
    await page.evaluate(() => {
      window.addEventListener('contest-clock-sync', event => { window.syncedClock = event.detail; });
      window.originalRow = document.querySelector('[data-rank-user-id="7"]');
      window.originalTable = document.querySelector('.app-contest-rank-table');
      window.scrollTo(0, 300);
      document.querySelector('details').open = true;
      document.querySelector('[name="classes"]').checked = false;
    });
    const scroll = await page.evaluate(() => window.scrollY);
    await page.clock.fastForward(18000);
    await page.waitForFunction(() => document.querySelector('tbody tr').dataset.rankUserId === '8');
    assert.equal(await page.locator('[data-rank-user-id="8"] .app-rank-number.is-gold').count(), 1);
    assert.equal(await page.locator('[data-rank-user-id="7"] .app-rank-number.is-silver').count(), 1);
    assert.equal(await page.evaluate(() => window.originalRow === document.querySelector('[data-rank-user-id="7"]')), true);
    assert.equal(await page.evaluate(() => window.originalTable === document.querySelector('.app-contest-rank-table')), true);
    assert.equal(await page.evaluate(() => window.scrollY), scroll);
    assert.equal(await page.locator('.app-contest-context h1').textContent(), '最新比赛标题');
    assert.deepEqual(await page.evaluate(() => window.syncedClock), { start: 100, end: 2000, now: 300 });
    assert.equal(await page.locator('details').getAttribute('open'), '');
    assert.equal(await page.locator('[name="classes"]').isChecked(), false);
    assert.equal(requests[0].searchParams.get('account'), 'ordinary');
    assert.equal(requests[0].searchParams.get('classes'), '3');
    assert.equal(requests[0].searchParams.get('page'), '1');
    assert.match(await page.locator('#page_next').getAttribute('href'), /^\/contest\/21\/ranklist\?/);
    await page.clock.fastForward(6000);
    await page.waitForFunction(() => document.querySelector('[data-rank-refresh-status]').hidden);
    assert.equal(requests.at(-1).searchParams.get('revision'), 'v2');
    fail = true;
    await page.clock.fastForward(6000);
    await page.locator('[data-rank-refresh-status]:not([hidden])').waitFor();
    assert.equal(await page.locator('tbody tr').count(), 2);
    assert.equal(await page.locator('[data-rank-user-id="8"] .app-cell-number strong').textContent(), '2');
    assert.equal(page.url(), 'http://rank.test/contest/21/ranklist?account=ordinary&classes=3&page=1');
    revoked = true;
    await page.clock.fastForward(32000);
    await page.waitForFunction(() => !document.querySelector('[data-rank-region="board"]').children.length);
    await page.evaluate(() => document.querySelector('[data-contest-rank-live]').dispatchEvent(new Event('focusout')));
    await page.clock.runFor(50);
    assert.equal(await page.locator('[data-rank-toolbar]').textContent(), '');
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); }
});
