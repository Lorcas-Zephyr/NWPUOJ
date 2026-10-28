'use strict';

// Real templates and browser navigation with isolated fixtures; no live writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function render(base, ended) {
  const problemTemplate = read('views/problem_context.ejs').replace(/<% include \w+ %>/g, '');
  const listTemplate = read('views/submissions.ejs')
    .replace('<% include contest_context %>', read('views/contest_context.ejs'))
    .replace('<% include app_pagination %>', read('views/app_pagination.ejs'))
    .replace(/<% include \w+ %>/g, '');
  const script = `const fs=require('fs'),ejs=require('/app/node_modules/ejs');const x=JSON.parse(fs.readFileSync(0,'utf8'));
    const now=x.ended?500:200;
    const utils={getCurrentDate:()=>now,formatDate:String,removeTitleTag:s=>s,contestSubmissionEnabled:()=>true,
      makeUrl:(parts,q)=> (Array.isArray(parts)?'/'+parts.join('/'):parts.path)+(q&&Object.keys(q).length?'?'+new URLSearchParams(q):'')};
    const contest={id:21,title:x.base?'基地测试比赛':'正式测试比赛',type:'acm',start_time:100,end_time:400,isEnded:()=>x.ended,isRunning:()=>!x.ended};
    const problem={id:911106,title:'B 测试题',type:'traditional',time_limit:1000,memory_limit:256,getDisplayId:()=>911106};
    const registration={registered:true,canParticipate:!x.ended,canViewProblems:true,ended:x.ended,running:!x.ended};
    const locals={user:{id:7,username:'member'},baseContext:x.base,baseAdmin:false,contest,
      contestRegistration:registration,problemContext:{problem,contest,contestProblemId:2,section:'statement',testcases:{spj:false}},
      syzoj:{utils,config:{filter_enabled_languages:['cpp']},languages:{cpp:{show:'C++ 23'}}}};
    const options={context:{alpha:n=>String.fromCharCode(64+Number(n))}};
    const statement=ejs.render(x.problemTemplate,locals,options);
    const submit=ejs.render(x.problemTemplate,{...locals,problemContext:{...locals.problemContext,section:'submit'}},options);
    const form={problem_id:'2'};
    const list=ejs.render(x.listTemplate,{...locals,problemContext:null,
      contestHeader:{contest,section:'submissions',seeRanklist:true,isSupervisior:false,submissionsUrl:'/contest/21/submissions'},
      displayConfig:{inContest:true,inProblemSet:false,inBase:false,showOthers:true,showScore:false,showScoreFilter:x.base,showUsage:true,showCode:true,showResult:true},
      items:[{info:{submissionId:100,problemId:2,sourceProblemId:911106,problemDisplayId:'911106',problemName:problem.title,userId:7,user:'member',language:'C++ 23',codeSize:120,submitTime:'fixture',canViewDetail:true},result:{result:'Accepted',score:100,time:5,memory:256},running:false}],
      form,req:{path:'/contest/21/submissions',query:form},isFiltered:true,paginate:{currPage:1,pageCnt:2},
      serializejs:JSON.stringify,vjudge:{languages:{}}},options);
    process.stdout.write(JSON.stringify({statement,submit,list}));`;
  const result = spawnSync('docker', ['exec', '-i', 'nwpuoj-web-1', 'node', '-e', script], {
    input: JSON.stringify({ problemTemplate, listTemplate, base, ended }), encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(Object.entries(JSON.parse(result.stdout)).map(([key, html]) => [key,
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + ['app-shell', 'app-shared', 'app-features'].map(name => '<link rel="stylesheet" href="/self/' + name + '.css">').join('')
    + '</head><body class="app-v2"><main class="app-main">' + html + '</main></body></html>'
  ]));
}

test('base and ordinary contest problem/submit tabs stay in contest submissions before and after the contest ends', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    for (const base of [true, false]) for (const ended of [false, true]) {
      const html = render(base, ended), errors = [];
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith('/self/')) return route.fulfill({ contentType: 'text/css', body: read(path.basename(url.pathname)) });
        assert.equal(route.request().method(), 'GET');
        assert.ok(url.pathname.startsWith('/contest/21/'), 'navigation never leaves the current contest');
        return route.fulfill({ contentType: 'text/html', body: url.pathname.endsWith('/submissions') ? html.list : url.pathname.endsWith('/submit') ? html.submit : html.statement });
      });
      for (const suffix of ['', '/submit']) {
        await page.goto('http://navigation.test/contest/21/problem/2' + suffix);
        const link = page.getByRole('navigation', { name: '题目导航' }).getByRole('link', { name: '提交记录', exact: true });
        assert.equal(await link.getAttribute('href'), '/contest/21/submissions?problem_id=2');
        await link.click();
        await page.waitForURL(url => url.pathname === '/contest/21/submissions' && url.searchParams.get('problem_id') === '2');
        assert.equal(await page.locator('.app-contest-context h1').textContent(), base ? '基地测试比赛' : '正式测试比赛');
        assert.equal(await page.locator('.app-contest-tabs [aria-current="page"]').textContent(), '提交记录');
        assert.equal(await page.locator('[name="problem_id"]').inputValue(), '2');
        assert.equal(await page.locator('#submission-filter-form').getAttribute('action'), '/contest/21/submissions');
        assert.equal(await page.locator('[name="min_score"]').count(), base ? 1 : 0);
        const row = page.locator('[data-submission-id="100"]');
        assert.equal(await row.locator('.app-cell-primary a').getAttribute('href'), '/contest/21/problem/2');
        assert.equal(await row.locator('[data-submission-status]').getAttribute('href'), '/contest/submission/100');
        await page.getByRole('button', { name: '我的', exact: true }).click();
        await page.waitForURL(url => url.pathname === '/contest/21/submissions' && url.searchParams.get('submitter') === 'member');
        assert.equal(new URL(page.url()).searchParams.get('problem_id'), '2');
        await page.getByRole('link', { name: '下一页', exact: true }).click();
        await page.waitForURL(url => url.pathname === '/contest/21/submissions' && url.searchParams.get('page') === '2');
        assert.equal(new URL(page.url()).searchParams.get('problem_id'), '2');
        await page.getByRole('link', { name: '清除', exact: true }).click();
        await page.waitForURL(url => url.pathname === '/contest/21/submissions' && !url.search);
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
