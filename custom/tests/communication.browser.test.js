'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function render(view, type = 'traditional') {
  const template = read('views/' + view + '.ejs')
    .replace('<% include problem_testcases %>', read('views/problem_testcases.ejs'))
    .replace(/<% include \w+ %>/g, '');
  const script = `
    const fs=require('fs'),ejs=require('/app/node_modules/ejs');
    const input=JSON.parse(fs.readFileSync(0,'utf8'));
    const problem={id:7,title:'两轮通信示例',getDisplayId:()=>7,type:input.type,time_limit:1000,memory_limit:256,file_io:false};
    const detailResult={judge:{subtasks:[{score:100,cases:[{status:2,result:{type:1,time:20,memory:512,
      communication:{rounds:[{round:1,type:1,time:8,memory:512,userOutput:'11\\n',userError:'',systemMessage:'Exited with return code 0'},
      {round:2,type:1,time:12,memory:512,userOutput:'22\\n',userError:'',systemMessage:'Exited with return code 0'}],secondInput:'2\\n11\\n'}}}]}]}};
    const html=ejs.render(input.template,{problem,testcases:[{score:100,type:'sum',cases:[{input:'1.in',output:'1.out'}]}],
      user:{id:1},req:{query:{}},serializejs:JSON.stringify,
      info:{submissionId:7,problemId:7,problemDisplayId:7,problemName:'通信测试',user:'fixture',userId:1,submitTime:'2026-11-03',language:'C++17'},
      roughResult:{result:'Accepted',score:100,time:20,memory:512},detailResult,
      displayConfig:{showUsage:true,showScore:true},submissionPending:false,preferFormattedCode:false,formattedCode:null,code:null,
      syzoj:{utils:{makeUrl:parts=>'/'+parts.join('/'),removeTitleTag:String,formatSize:String}}});
    process.stdout.write(html);
  `;
  const result = spawnSync('docker', ['exec', '-i', 'nwpuoj-web-1', 'node', '-e', script], {
    input: JSON.stringify({ template, type }), encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024
  });
  assert.equal(result.status, 0, result.stderr);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + ['app-shell.css', 'app-shared.css', 'app-features.css'].map(file => `<style>${read(file)}</style>`).join('')
    + '</head><body class="app-v2"><main class="app-main">' + result.stdout + '</main></body></html>';
}

test('communication management switches controls and saves the type through the existing API', async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const html = render('problem_manage');
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const writes = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request();
    if (request.method() === 'POST') {
      writes.push(request.postDataJSON());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: {} }) });
    }
    if (new URL(request.url()).pathname.includes('/api/v2/')) return route.fulfill({ status: 200, contentType: 'application/json',
      headers: { etag: 'fixture-tag' }, body: JSON.stringify({ data: {}, meta: { etag: 'fixture-tag' } }) });
    return route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  await page.goto('http://fixture.test/problem/7/manage');
  await page.locator('[data-problem-type="communication"]').click();
  assert.equal(await page.locator('[data-communication-note]').isVisible(), true);
  assert.equal(await page.locator('[data-limit-fields]').isVisible(), true);
  assert.equal(await page.locator('[data-io-fields]').isVisible(), false);
  assert.equal(await page.locator('[data-submit-answer-note]').isVisible(), false);
  await page.locator('[data-communication-note] summary').click();
  assert.match(await page.locator('[data-communication-note]').innerText(), /communication:\s+language: cpp17/);
  assert.equal(await page.locator('[data-communication-note] a[download]').getAttribute('href'), '/self/lib/communication-example.zip');
  await page.screenshot({ path: '/tmp/noj-communication-manage-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  for (const button of await page.locator('[data-problem-type]').all()) assert.equal(await button.isVisible(), true);
  await page.screenshot({ path: '/tmp/noj-communication-manage-mobile.png', fullPage: true });
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/manage?saved=1');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].type, 'communication');
  assert.equal(writes[0].file_io, false);
  assert.equal(writes[0].time_limit, 1000);
  assert.deepEqual(errors, []);
});

test('saved communication pages and both round details render without template errors', async t => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  await page.setContent(render('problem_manage', 'communication'));
  assert.equal(await page.locator('[data-communication-note]').isVisible(), true);
  assert.equal(await page.locator('[data-io-fields]').isVisible(), false);
  await page.setContent(render('submission', 'communication'));
  await page.locator('.app-testcase > summary').click();
  const details = await page.locator('.app-testcase-detail').innerText();
  assert.match(details, /第 1 轮运行 · 正常结束/);
  assert.match(details, /第 2 轮运行 · 正常结束/);
  assert.match(details, /转换后的第二轮输入/);
  await page.screenshot({ path: '/tmp/noj-communication-submission.png', fullPage: true });
});
