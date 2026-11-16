'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
let browser;
test.before(async () => { browser = await chromium.launch({headless:true,args:['--no-sandbox']}); });
test.after(async () => { if (browser) await browser.close(); });
function render(unread) {
  const template = fs.readFileSync(path.join(root,'views/notifications.ejs'),'utf8').replace(/<% include \w+ %>/g,'');
  const code = `const fs=require('fs'),ejs=require('ejs'),x=JSON.parse(fs.readFileSync(0,'utf8'));
  const syzoj={utils:{formatDate:()=> '2026-11-16',makeUrl:(parts,query)=>'/'+parts.join('/')+(query?'?'+new URLSearchParams(query):'')}};
  process.stdout.write(ejs.render(x.template,{syzoj,unreadCount:x.unread,totalCount:3,filter:'unread',notifications:[
  {id:1,title:'Rating 更新',content:'notice',contentRendered:'<p>Codeforces 积分规则</p>'.repeat(20),type:'site_notification',source_url:'/notifications'},
  {id:2,title:'第二条通知',content:'比赛结果',source_url:'/contest/21/details'},
  {id:3,title:'已读通知',content:'旧消息',is_read:1}
  ]}));`;
  const result=spawnSync('docker',['compose','exec','-T','web','node','-e',code],{cwd:path.join(root,'..'),input:JSON.stringify({template,unread}),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
    ['app-shell.css','app-shared.css','app-features.css'].map(f=>'<link rel="stylesheet" href="/self/'+f+'">').join('')+
    '<style>.app-page{padding:24px}.app-topbar{position:sticky;top:0}</style></head><body class="app-v2">'+
    '<header class="app-topbar"><a href="/notifications" aria-label="通知中心"><span class="app-notification-count">'+unread+'</span></a></header>'+result.stdout+
    '<script>window.__NWPUOJ_APP={csrfToken:"fixture-csrf"};</script><script src="/self/app-v2.js"></script></body></html>';
}
async function fixture({hidden=false,fail=false,unread=4,mobile=false}={}) {
  const context=await browser.newContext({viewport:{width:mobile?390:1000,height:600}});
  await context.addInitScript(hidden=>{window.fixtureHidden=hidden;Object.defineProperty(document,'hidden',{get:()=>window.fixtureHidden});},hidden);
  const page=await context.newPage(),calls=[],errors=[],seen=new Set();let failNext=fail;
  const html=render(unread);
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',route=>{
    const req=route.request(),url=new URL(req.url());
    assert.equal(url.origin,'http://notifications.test');
    if(url.pathname.startsWith('/self/'))return route.fulfill({contentType:url.pathname.endsWith('.js')?'text/javascript':'text/css',body:fs.readFileSync(path.join(root,path.basename(url.pathname)))});
    const match=url.pathname.match(/^\/api\/v2\/notifications\/(\d+)\/read$/);
    if(match){
      const id=Number(match[1]);calls.push({id,method:req.method(),headers:req.headers()});
      if(failNext){failNext=false;return route.fulfill({status:503,json:{error:{message:'temporary failure'}}});}
      seen.add(id);return route.fulfill({json:{data:{id,is_read:true,updated:1,unread_count:unread-seen.size,source_url:id===2?'/contest/21/details':'/notifications'}}});
    }
    if(url.pathname.startsWith('/api/'))throw Error('Unexpected write: '+url.pathname);
    return route.fulfill({contentType:'text/html',body:url.pathname.startsWith('/contest/')?'<h1>比赛</h1>':html});
  });
  await page.goto('http://notifications.test/notifications');
  return {context,page,calls,errors,seen};
}

test('visible notifications auto-read, update counts without reload, and leave unseen pages unread',async()=>{
  const f=await fixture();
  try{
    await f.page.waitForFunction(()=>!document.querySelector('[data-notification-item="1"]').classList.contains('is-unread'));
    assert.deepEqual(f.calls.map(c=>c.id),[1]);
    assert.equal(await f.page.locator('[data-notification-unread-count]').textContent(),'3');
    assert.equal(await f.page.locator('.app-notification-count').textContent(),'3');
    assert.equal(await f.page.locator('[data-notification-item="1"] [data-notification-v2="read"]').count(),0);
    assert.ok(f.calls[0].headers['idempotency-key']);
    assert.equal(f.calls[0].headers['x-csrf-token'],'fixture-csrf');
    assert.equal(f.calls[0].method,'POST');
    await f.page.locator('[data-notification-item="2"]').scrollIntoViewIfNeeded();
    await f.page.waitForFunction(()=>!document.querySelector('[data-notification-item="2"]').classList.contains('is-unread'));
    assert.deepEqual(f.calls.map(c=>c.id),[1,2]);
    assert.equal(await f.page.locator('[data-notification-unread-count]').textContent(),'2');
    assert.equal(await f.page.locator('[data-notification-next-unread] a').getAttribute('href'),'/notifications?filter=unread');
    assert.equal(await f.page.locator('[data-notification-next-unread]').isVisible(),true);
    assert.equal(await f.page.locator('[data-notification-item]').count(),3);
    await f.page.evaluate(()=>window.scrollTo(0,0));await f.page.waitForTimeout(500);
    assert.deepEqual(f.calls.map(c=>c.id),[1,2]);
    assert.deepEqual(f.errors,[]);
  }finally{await f.context.close();}
});

test('background tabs do not read notifications until visible; zero unread hides the badge',async()=>{
  const f=await fixture({hidden:true,unread:1,mobile:true});
  try{
    await f.page.waitForTimeout(600);assert.equal(f.calls.length,0);
    await f.page.evaluate(()=>{window.fixtureHidden=false;document.dispatchEvent(new Event('visibilitychange'));});
    await f.page.waitForFunction(()=>document.querySelector('[data-notifications-unread]').dataset.notificationsUnread==='0');
    assert.deepEqual(f.calls.map(c=>c.id),[1]);
    assert.equal(await f.page.locator('.app-notification-count').isVisible(),false);
    assert.equal(await f.page.locator('[data-notification-v2="read-all"]').isVisible(),false);
    assert.match(await f.page.locator('[data-notification-summary]').textContent(),/所有通知均已阅读/);
    assert.deepEqual(f.errors,[]);
  }finally{await f.context.close();}
});

test('failed auto-read preserves unread state and retries on reconnect; source links still navigate',async()=>{
  const f=await fixture({fail:true});
  try{
    await f.page.waitForTimeout(900);assert.equal(f.calls.length,1);
    assert.equal(await f.page.locator('[data-notification-item="1"]').getAttribute('class'),'is-unread');
    assert.equal(await f.page.locator('[data-notification-unread-count]').textContent(),'4');
    await f.page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await f.page.waitForFunction(()=>!document.querySelector('[data-notification-item="1"]').classList.contains('is-unread'));
    await f.page.locator('[data-notification-item="2"] button[aria-label="查看通知"]').click();
    await f.page.waitForURL('http://notifications.test/contest/21/details');
    assert.ok(f.seen.has(2));assert.deepEqual(f.errors,[]);
  }finally{await f.context.close();}
});
