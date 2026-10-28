'use strict';
// Isolated EJS/browser fixtures only; never modifies production user accounts.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');

function render(temporary) {
  const template = fs.readFileSync(path.join(root, 'views/user_edit.ejs'), 'utf8')
    .replace('<% include app_header %>', '').replace('<% include app_footer %>', '');
  const script = `const fs=require('fs'),ejs=require('/app/node_modules/ejs');const x=JSON.parse(fs.readFileSync(0,'utf8'));
    const colleges=['计算机学院'];
    const html=ejs.render(x.template,{actorCanGrant:true,actorIsOwner:true,actorCanManage:true,isTemporaryContestAccount:x.temporary,
      edited_user:{id:20,username:'原始比赛用户名',email:x.temporary?'':'fixture@example.test',sex:0,information:'',privileges:[]},
      user:{id:1},registrationProfile:{student_id:'2026000001',real_name:'测试用户',college:'CSV 原学院'},registrationColleges:colleges,
      error_info:null,req:{query:{}},avatarCsrfToken:'fixture',adminCsrfToken:'fixture',
      syzoj:{siteOwnerUserId:1,utils:{makeUrl:parts=>'/'+parts.join('/'),avatar:()=>'/avatar.svg',hasCustomAvatar:()=>false}}});
    if(colleges.length!==1)throw Error('Rendering must not mutate the shared college list');
    process.stdout.write(html);`;
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], {
    cwd: path.join(root, '..'), input: JSON.stringify({ template, temporary }), encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  return '<!doctype html><html><head><meta charset="utf-8"></head><body>' + result.stdout + '</body></html>';
}

test('temporary rename form saves Unicode with body ETag, no email, and no unrelated identity changes', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const html = render(true), errors = [], patches = [];
  const identity = { student_id: '2026000001', real_name: '测试用户', college: 'CSV 原学院' };
  const username = '2026 西北工业大学 ICPC 校赛（计算机学院） - 张三 #1';
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v2/admin/users/20') {
      if (route.request().method() === 'PATCH') patches.push(route.request().postDataJSON());
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        data: { username: 'original', email: '', identity, is_temporary_contest_account: true, privileges: [], is_admin: false },
        meta: { etag: 'fixture-version' }, error: null
      }) });
    }
    if (url.pathname === '/avatar.svg') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  try {
    await page.goto('http://fixture.test/user/20/edit');
    assert.equal(await page.locator('[name="username"]').getAttribute('maxlength'), null);
    assert.equal(await page.locator('[name="email"]').getAttribute('required'), null);
    assert.equal(await page.locator('[name="college"]').inputValue(), identity.college);
    const signature = page.locator('[name="information"]');
    await signature.fill('中'.repeat(51));
    assert.equal(await signature.evaluate(input => input.checkValidity()), false);
    assert.equal(await page.locator('[data-signature-count]').innerText(), '51 / 50');
    await signature.fill('😀'.repeat(50));
    assert.equal(await signature.evaluate(input => input.checkValidity()), true);
    assert.equal(await page.locator('[data-signature-count]').innerText(), '50 / 50');
    await signature.fill('**纯文本** <b>签名</b>');
    await page.locator('[name="username"]').fill('名'.repeat(81));
    assert.equal(await page.locator('[name="username"]').evaluate(input => input.checkValidity()), false);
    await page.locator('[name="username"]').fill('😀'.repeat(80));
    assert.equal(await page.locator('[name="username"]').evaluate(input => input.checkValidity()), true);
    await page.locator('[name="username"]').fill(username);
    await page.locator('#submit_button').click();
    await page.waitForURL('**/user/20/edit?saved=1');
    assert.equal(patches.length, 1);
    assert.equal(patches[0].username, username);
    assert.equal(patches[0].if_match, 'fixture-version');
    assert.equal(patches[0].email, '');
    assert.equal(patches[0].information, '**纯文本** <b>签名</b>');
    for (const name of ['student_id', 'real_name', 'college']) assert.equal(Object.hasOwn(patches[0], name), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('ordinary user editor keeps its twenty-character cap and required email', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ status: 404, body: '' }));
    await page.setContent(render(false));
    assert.equal(await page.locator('[name="username"]').getAttribute('maxlength'), '20');
    assert.notEqual(await page.locator('[name="email"]').getAttribute('required'), null);
  } finally { await browser.close(); }
});

test('profile, ranklist and following signatures display Markdown and HTML literally', async () => {
  const information = '**签名** <img src=x onerror=alert(1)>';
  const templates = ['user', 'ranklist', 'user_following'].map(name => fs.readFileSync(path.join(root, 'views', name + '.ejs'), 'utf8')
    .replace(/<% include app_(header|footer|pagination) %>/g, ''));
  const script = `const fs=require('fs'),ejs=require('/app/node_modules/ejs');const x=JSON.parse(fs.readFileSync(0,'utf8'));
    const shown={id:20,username:'fixture',information:x.information,ac_problems:[],rating:1500};
    const locals={show_user:shown,user:null,res:{locals:{user:null}},statistics:{},curSort:'rating',curOrder:false,
      paginate:{currPage:1,perPage:100},ranklist:[shown],users:[shown],total:1,listType:'following',
      syzoj:{utils:{avatar:()=>'',makeUrl:parts=>'/'+parts.join('/'),formatDate:()=>'',renderUsername:()=> 'fixture'}}};
    process.stdout.write(x.templates.map(template=>ejs.render(template,locals)).join(''));`;
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], {
    cwd: path.join(root, '..'), input: JSON.stringify({ information, templates }), encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(result.stdout);
    for (const selector of ['.app-profile-signature', '.app-user-bio', '.app-user-list small']) {
      assert.equal(await page.locator(selector).textContent(), information);
      assert.equal(await page.locator(selector + ' *').count(), 0);
    }
  } finally { await browser.close(); }
});
