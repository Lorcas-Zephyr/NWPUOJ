'use strict';
// Local browser fixtures and mocked endpoints; never ban production accounts.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), {spawnSync} = require('node:child_process');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root,file),'utf8');
let browser;
test.before(async()=>{browser=await chromium.launch({headless:true,args:['--no-sandbox']});});
test.after(async()=>{if(browser)await browser.close();});
function html(mode='profile',admin=true) {
  let template=read('views/'+(mode==='profile'?'user':mode==='login'?'login':'admin_bans')+'.ejs')
    .replace('<% include app_header %>','').replace('<% include app_footer %>','')
    .replace('<% include admin_header %>','').replace('<% include admin_footer %>','')
    .replace('<% include ban_editor %>',read('views/ban_editor.ejs'));
  const run=function(){
    const ejs=require('ejs'),fs=require('fs'),x=JSON.parse(fs.readFileSync(0,'utf8'));
    const user={id:90,username:'admin',is_admin:x.admin},shown={id:1,username:'alice',rating:0,ac_problems:[],register_time:1000000};
    const utils={renderUsername:u=>'<a href="/user/'+u.id+'">'+ejs.escapeXML(u.username)+'</a>',avatar:()=>'/avatar.png',ratingTier:()=> 'gray',userRating:()=>0,ratingTitle:()=> 'Newbie',formatDate:()=> '2026-11-17 12:00',makeUrl:(parts,q)=>'/'+parts.join('/')+(q?'?'+new URLSearchParams(q):''),safeLocalUrl:()=>'/'};
    process.stdout.write(ejs.render(x.template,{user,show_user:shown,res:{locals:{user}},req:{query:{}},syzoj:{siteOwnerUserId:99,config:{title:'NWPUOJ'},utils},statistics:{},serializejs:JSON.stringify,keyword:'',showAll:false,banList:{total:1,page:1,page_count:1,items:[{id:5,type:'account',user_id:1,username:'alice',active:true,created_by:90,creator_name:'admin',created_at:'2026-11-17T00:00:00Z',expires_at:null}]}}));
  };
  const result=spawnSync('docker',['compose','exec','-T','web','node','-e','('+run.toString()+')()'],{cwd:path.join(root,'..'),input:JSON.stringify({template,admin}),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="csrf-token" content="fixture">'+['app-shell.css','app-shared.css','app-features.css'].map(file=>'<link rel="stylesheet" href="/self/'+file+'">').join('')+'<link rel="stylesheet" href="/self/lib/flatpickr-4.6.13/flatpickr.min.css"><script src="/self/lib/flatpickr-4.6.13/flatpickr.min.js"></script><script src="/self/lib/flatpickr-4.6.13/zh.js"></script><script src="/self/app-api.js"></script><script>window.__NWPUOJ_APP={csrfToken:"fixture",user:{id:90}};</script></head><body class="app-v2">'+result.stdout+'<script src="/self/app-v2.js"></script></body></html>';
}
async function fixture(mode='profile',admin=true){
  const context=await browser.newContext({viewport:{width:1280,height:1000},timezoneId:'America/Chicago'});
  const page=await context.newPage(), errors=[],writes=[],document=html(mode,admin);
  page.setDefaultTimeout(10000);
  const bans=[];
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.pathname.startsWith('/self/')){
      const file=url.pathname.startsWith('/self/lib/')?'static-libs/'+url.pathname.slice(10):url.pathname.slice(6);
      return route.fulfill({contentType:file.endsWith('.css')?'text/css':'application/javascript',body:read(file)});
    }
    if(url.pathname==='/fixture'||url.pathname==='/admin/bans')return route.fulfill({contentType:'text/html',body:document});
    if(url.pathname==='/api/v2/admin/bans/users/1')return route.fulfill({json:{data:{user:{id:1,username:'alice'},ips:[{ip:'192.0.2.1',last_login:'2026-11-17T00:00:00Z'},{ip:'2001:db8::1',last_login:'2026-11-16T00:00:00Z'}],bans}}});
    if(url.pathname==='/api/v2/auth/login')return route.fulfill({status:403,json:{error:{code:'IP_BANNED',message:'您的 IP 已被封禁（永久）。如有异议请邮件申诉：npuicpc@163.com',fields:{appeal_email:'npuicpc@163.com'}}}});
    if(url.pathname.startsWith('/api/v2/admin/bans')&&req.method()!=='GET'){
      writes.push({method:req.method(),body:req.postDataJSON(),headers:req.headers()});
      bans.push({id:5,active:true});return route.fulfill({json:{data:{id:5}}});
    }
    return route.fulfill({status:404,body:''});
  });
  await page.goto('http://bans.test/fixture');
  return {page,context,errors,writes};
}
test('profile supports login-IP choice, permanent ban and append state; ordinary users see no control',async()=>{
  const f=await fixture();
  try{
    await f.page.locator('[data-open-user-ban]').click();
    await f.page.locator('[name="login_ip"] option').first().waitFor({state:'attached'});
    await f.page.locator('[name="type"]').selectOption('ip');
    assert.equal(await f.page.locator('[name="login_ip"] option').count(),2);
    await f.page.locator('[name="login_ip"]').selectOption('2001:db8::1');
    await f.page.locator('[name="duration"]').selectOption('permanent');
    await f.page.locator('[data-ban-submit]').click();
    await f.page.getByRole('button',{name:'追加封禁',exact:true}).waitFor();
    assert.equal(f.writes[0].body.ip,'2001:db8::1');assert.equal(f.writes[0].body.permanent,true);assert.equal(f.writes[0].body.user_id,1);
    assert.equal(f.writes[0].headers['x-csrf-token'],'fixture');assert.ok(f.writes[0].headers['idempotency-key']);
    assert.deepEqual(f.errors,[]);
  }finally{await f.context.close();}
  const ordinary=await fixture('profile',false);
  try{assert.equal(await ordinary.page.locator('[data-open-user-ban]').count(),0);assert.equal(await ordinary.page.locator('#ban-editor').count(),0);}
  finally{await ordinary.context.close();}
});
test('custom expiry uses shared 24-hour controls inside the modal and submits Beijing time',async()=>{
  const f=await fixture();
  try{
    await f.page.locator('[data-open-user-ban]').click();
    await f.page.locator('[name="duration"]').selectOption('custom');
    const alternate=f.page.locator('[name="expires_at"] + input');
    await alternate.fill('2099-01-02 23:59');await alternate.click();
    assert.equal(await f.page.locator('#ban-editor .flatpickr-calendar.open [data-datetime-hour] option').count(),24);
    assert.equal(await f.page.locator('#ban-editor .flatpickr-calendar.open [data-datetime-minute] option').count(),60);
    await f.page.locator('#ban-editor h2').click();
    await f.page.locator('[data-ban-submit]').click();
    await f.page.getByRole('button',{name:'追加封禁',exact:true}).waitFor();
    assert.equal(f.writes[0].body.expires_at,'2099-01-02T15:59:00.000Z');
    await f.page.setViewportSize({width:390,height:844});
    await f.page.locator('[data-open-user-ban]').click();
    assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await f.page.screenshot({path:'/tmp/noj-bans-mobile.png',fullPage:true});
    assert.deepEqual(f.errors,[]);
  }finally{await f.context.close();}
});
test('admin table adds records and cancels an individual ban',async()=>{
  const f=await fixture('admin');
  try{
    await f.page.locator('[data-new-ban]').click();
    await f.page.locator('[name="username"]').fill('alice');
    await f.page.locator('[name="duration"]').selectOption('24');
    await f.page.locator('[data-ban-submit]').click();
    await f.page.waitForFunction(()=>!document.querySelector('dialog[open]'));
    assert.equal(f.writes[0].body.username,'alice');assert.equal(f.writes[0].body.permanent,false);
    f.page.on('dialog',d=>d.accept());
    await f.page.locator('[data-lift-ban]').click();
    await f.page.waitForTimeout(100);
    assert.equal(f.writes[1].headers['x-http-method-override'] || f.writes[1].method,'DELETE');
    assert.deepEqual(f.errors,[]);
  }finally{await f.context.close();}
});
test('banned sign-in shows the message in a dialog with the appeal mail link',async()=>{
  const f=await fixture('login');
  try{
    await f.page.locator('[name="username"]').fill('alice');await f.page.locator('[name="password"]').fill('test-password');
    await f.page.locator('#login-button').click();
    await f.page.locator('#login-ban-notice[open]').waitFor();
    assert.match(await f.page.locator('[data-login-ban-message]').textContent(),/永久.*npuicpc@163.com/);
    assert.equal(await f.page.locator('[data-login-ban-email]').getAttribute('href'),'mailto:npuicpc@163.com');
    assert.equal(await f.page.locator('#login-button').isEnabled(),true);
    assert.deepEqual(f.errors,[]);
  }finally{await f.context.close();}
});
