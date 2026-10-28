'use strict';
// Isolated browser fixtures. Every request is intercepted; no live memberships,
// accounts, problems or contests are modified by these tests.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

function render(tab, admin = true, longContent = false) {
  const template = read('views/base_workspace.ejs').replace('<% include app_header %>', '').replace('<% include app_footer %>', '')
    .replace('<% include app_pagination %>', read('views/app_pagination.ejs'))
    .replace('<% include base_problem_actions %>', read('views/base_problem_actions.ejs'));
  const script = `const fs=require('fs'),ejs=require('/app/node_modules/ejs');const x=JSON.parse(fs.readFileSync(0,'utf8'));
    const row={id:2,username:'成员甲',real_name:'张三',student_id:'2026000001',college:'计算机学院',classes:[{name:'2026 级基地'}],created_at:'2026-09-24T00:00:00Z',title:'A + B',user_id:2,is_public:1,holder_id:2,start_time:100,end_time:500,type:'acm',tags:[{name:'动态规划'}]};
    if(x.longContent){row.title='手机布局测试_很长的基地题目或比赛名称'.repeat(5);row.classes=[{name:'一个很长的班级名称'.repeat(8)}];}
    process.stdout.write(ejs.render(x.template,{tab:x.tab,rows:[row],problemTags:[{id:7,name:'动态规划'}],baseAdmin:x.admin,total:101,mine:false,keyword:'',user:{id:x.admin?1:2},paginate:{currPage:1,pageCnt:2},paginationBasePath:['base',x.tab],req:{query:{}},syzoj:{utils:{formatDate:String,getCurrentDate:()=>300,makeUrl:(parts,q)=>'/'+parts.join('/')+(q?'?'+new URLSearchParams(q):'')}}}));`;
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], {
    cwd: path.join(root, '..'), input: JSON.stringify({ template, tab, admin, longContent }), encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<link rel="stylesheet" href="/self/app-shell.css"><link rel="stylesheet" href="/self/app-shared.css"><link rel="stylesheet" href="/self/app-features.css">'
    + '</head><body class="app-v2"><main class="app-main">' + result.stdout + '</main></body></html>';
}

function renderEditor(kind, base = true, medals) {
  const template = read('views/' + kind + '_edit.ejs').replace('<% include app_header %>', '').replace('<% include app_footer %>', '');
  const script = `const fs=require('fs'),ejs=require('/app/node_modules/ejs');const x=JSON.parse(fs.readFileSync(0,'utf8'));
    const utils={makeUrl:parts=>'/'+parts.join('/'),getCurrentDate:()=>1790251200,formatDate:t=>new Date(t*1000).toISOString().slice(0,16)};
    const problem={id:0,new:true,title:'',description:'',input_format:'',output_format:'',example:'',limit_and_hint:'',tags:[],allowedEdit:true,allowedManage:false};
    const contest={id:0,title:'',subtitle:'',information:'',type:'acm',start_time:1790251200,end_time:1790265600};
    process.stdout.write(ejs.render(x.template,{problem,contest,problems:[],admins:[],baseContext:x.base,baseMember:x.base,appHasCapability:()=>false,contestMedalPercentages:x.medals,user:{id:2},req:{query:{}},syzoj:{utils}}));`;
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], {
    cwd: path.join(root, '..'), input: JSON.stringify({ template, base, medals }), encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>' + result.stdout + '</body></html>';
}

function renderProblemContext(admin = true, base = true) {
  const template = read('views/problem_context.ejs').replace('<% include base_problem_actions %>', read('views/base_problem_actions.ejs'));
  const script = `const fs=require('fs'),ejs=require('/app/node_modules/ejs');const x=JSON.parse(fs.readFileSync(0,'utf8'));
    const problem={id:2,title:'A + B',type:'traditional',time_limit:1000,memory_limit:256,allowedEdit:true,allowedManage:true,getDisplayId:()=>2};
    const utils={makeUrl:parts=>'/'+parts.join('/'),removeTitleTag:title=>title};
    process.stdout.write(ejs.render(x.template,{problemContext:{problem,testcases:{spj:false}},baseContext:x.base,baseAdmin:x.admin,baseProblemMigration:null,user:{id:x.admin?1:2},syzoj:{utils}}));`;
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], {
    cwd: path.join(root, '..'), input: JSON.stringify({ template, admin, base }), encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  return '<!doctype html><html><head><meta charset="utf-8"></head><body>' + result.stdout + '</body></html>';
}

test('base member UI supports search, multiple selections, class and CSV imports, errors, confirmation and paging', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const html = render('members'); const errors = []; const writes = []; let confirms = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { confirms++; await dialog.accept(); });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/self/app-v2.js') return route.fulfill({ contentType: 'application/javascript', body: read('app-v2.js') });
    if (url.pathname.startsWith('/self/')) return route.fulfill({ contentType: 'text/css', body: read(url.pathname.split('/').pop()) });
    if (url.pathname.startsWith('/api/v2/base/')) {
      let data;
      if (url.pathname.endsWith('/users/search')) data = [{ id: 3, username: '<img src=x onerror=alert(1)>', real_name: '李四', student_id: '2026000002' }];
      else if (url.pathname.endsWith('/classes/search')) data = [{ id: 5, name: '基地一班' }, { id: 6, name: '基地二班' }];
      else {
        writes.push({ path: url.pathname, body: url.pathname.endsWith('/import-csv') ? route.request().postData() : route.request().postDataJSON() });
        data = { added: 1, skipped: 1, invalid: [], errors: [{ row: 3, student_id: 'invalid', reason: '学号必须为 10 位数字' }] };
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    }
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  try {
    await page.goto('http://base.test/base/members');
    await page.addScriptTag({ url: '/self/app-v2.js' });
    const csvInputStyle = await page.locator('[name="student_ids_csv"]').evaluate(element => {
      const style = getComputedStyle(element);
      return { border: style.borderTopWidth, background: style.backgroundColor, textFieldStyle: element.classList.contains('app-input') };
    });
    assert.deepEqual(csvInputStyle, { border: '0px', background: 'rgba(0, 0, 0, 0)', textFieldStyle: false });
    assert.equal(await page.locator('[data-base-import="members/import-csv"] .app-file-field').count(), 1);
    assert.equal(await page.locator('[data-base-import="members/import-csv"] [data-file-selection]').textContent(), '未选择文件');
    assert.equal(await page.locator('[data-base-remove-selected]').isEnabled(), false);
    await page.locator('[data-base-search="users"]').fill('2026000002');
    await page.locator('[data-base-import="members"] [data-base-results] button').click();
    assert.equal(await page.locator('[data-base-selected] img').count(), 0);
    await page.getByRole('button', { name: '添加选中账户', exact: true }).click();
    await page.locator('[data-base-report]:not([hidden])').waitFor();
    assert.deepEqual(writes[0].body, { user_ids: [3] });
    for (const name of ['基地一班', '基地二班']) {
      await page.locator('[data-base-search="classes"]').fill('基地');
      await page.locator('[data-base-import="members/import-classes"] [data-base-results]').getByRole('button', { name, exact: true }).click();
    }
    await page.getByRole('button', { name: '导入选中班级', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-base-import="members/import-classes"] [data-base-selected]').children.length === 0);
    assert.deepEqual(writes[1].body, { class_ids: [5, 6] });
    await page.locator('[name="student_ids_csv"]').setInputFiles({ name: 'members.csv', mimeType: 'text/csv', buffer: Buffer.from('学号\n2026000002\ninvalid\n') });
    assert.match(await page.locator('[data-base-import="members/import-csv"] [data-file-selection]').textContent(), /members\.csv/);
    await page.locator('[data-base-import="members/import-csv"]').screenshot({ path: '/tmp/nwpuoj-base-csv-selected.png' });
    await page.getByRole('button', { name: '上传并导入', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[name="student_ids_csv"]').files.length === 0);
    await page.waitForFunction(() => document.querySelector('[data-base-import="members/import-csv"] [data-file-selection]').textContent === '未选择文件');
    assert.match(writes[2].body, /2026000002/);
    assert.match(await page.locator('[data-base-report-summary]').textContent(), /新增 1 人/);
    assert.equal(await page.locator('[data-base-report-errors] tr').count(), 1);
    assert.match(await page.locator('#page_next').getAttribute('href'), /\/base\/members\?page=2/);
    await page.screenshot({ path: '/tmp/nwpuoj-base-members-desktop.png', fullPage: true });
    await page.locator('[data-base-select-all]').check();
    assert.equal(await page.locator('[data-base-remove-selected]').isEnabled(), true);
    await page.getByRole('button', { name: '移除选中成员', exact: true }).click();
    await page.waitForLoadState();
    assert.equal(confirms, 1);
    assert.deepEqual(writes[3].body, { user_ids: [2] });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile page overflow');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('ordinary base member sees problem, contest and submission tabs without member administration', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ status: 404, body: '' }));
    await page.setContent(render('problems', false));
    assert.equal(await page.getByRole('link', { name: '成员管理', exact: true }).count(), 0);
    assert.equal(await page.getByRole('link', { name: '提交记录', exact: true }).getAttribute('href'), '/base/submissions');
    assert.equal(await page.getByRole('link', { name: '创建题目', exact: true }).getAttribute('href'), '/problem/0/edit?base=1');
    assert.equal(await page.getByRole('link', { name: '编辑', exact: true }).count(), 1);
    assert.equal(await page.getByText('基地内公开', { exact: true }).count(), 1);
    assert.equal(await page.locator('[data-select-item]').count(), 1);
    assert.equal(await page.locator('[data-base-action]').count(), 4);
    assert.equal(await page.locator('[data-base-migrate]').count(), 0);
    await page.setContent(render('contests', false));
    assert.equal(await page.getByRole('link', { name: '创建比赛', exact: true }).getAttribute('href'), '/contest/0/edit?base=1');
    assert.match(await page.locator('tbody').textContent(), /Unrated/);
  } finally { await browser.close(); }
});

test('base problem tags toggle shares the catalog preference and keeps its column aligned', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const html = render('problems');
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/self/')) return route.fulfill({ contentType: 'text/css', body: read(path.basename(url.pathname)) });
      return route.fulfill({ contentType: 'text/html', body: html });
    });
    await page.goto('http://base.test/base/problems');
    const toggle = page.locator('[data-problem-tags-toggle]');
    const column = page.locator('th.app-problem-tag-column');
    assert.equal(await toggle.isChecked(), false);
    assert.equal(await column.isVisible(), false);
    await page.locator('.app-base-toolbar .app-switch-control').click();
    assert.equal(await column.isVisible(), true);
    assert.equal(await page.locator('tbody .app-problem-tag-column .app-tag').textContent(), '动态规划');
    assert.equal(await page.evaluate(() => localStorage.getItem('show_problem_tags')), '1');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.reload();
    assert.equal(await toggle.isChecked(), true);
    assert.equal(await column.isVisible(), true);
    await page.locator('.app-base-toolbar .app-switch-control').click();
    assert.equal(await column.isVisible(), false);
    assert.equal(await page.evaluate(() => localStorage.getItem('show_problem_tags')), '0');
  } finally { await browser.close(); }
});

test('base bulk actions match ordinary catalog interactions and migration updates/restores both controls', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const html = render('problems', true), writes = [], errors = []; let migration = null;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()); let data;
      if (url.pathname.startsWith('/self/')) return route.fulfill({ contentType: 'text/css', body: read(url.pathname.split('/').pop()) });
      if (!url.pathname.startsWith('/api/v2/')) return route.fulfill({ contentType: 'text/html', body: html });
      if (route.request().method() === 'POST') writes.push({ path: url.pathname, body: route.request().postDataJSON() });
      if (url.pathname.endsWith('/migrate')) { migration = { problem_id: 101, skipped: false }; data = migration; }
      else if (url.pathname.endsWith('/migration')) data = { migration };
      else if (url.pathname.endsWith('/bulk-actions')) data = { id: 'fixture-job' };
      else if (url.pathname.endsWith('/bulk-tags')) data = { added: 1, skipped: 0 };
      else data = { state: 'completed', result: { changed: 1, failed: 0, skipped: 0 } };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    });
    await page.goto('http://base.test/base/problems');
    assert.equal(await page.locator('th.app-problem-select-cell').evaluate(element => Math.round(element.getBoundingClientRect().width)), 52);
    assert.equal(await page.locator('[data-base-action]').count(), 5);
    assert.equal(await page.locator('[data-base-action="publish"]').isDisabled(), true);
    await page.addScriptTag({ url: '/self/app-v2.js' });
    const labels = await page.locator('tbody [href="/problem/2/edit"], tbody [href="/problem/2/manage"], tbody [data-base-migrate]').evaluateAll(elements => elements.map(element => ({
      fontSize: getComputedStyle(element).fontSize,
      fontWeight: getComputedStyle(element).fontWeight,
      lineHeight: getComputedStyle(element).lineHeight
    })));
    assert.equal(labels.length, 3);
    assert.deepEqual(labels[1], labels[0], 'judging settings and edit buttons match');
    assert.deepEqual(labels[2], labels[0], 'migration and edit buttons match');
    await page.locator('[data-base-action-menu] summary').click();
    assert.equal(await page.locator('[data-base-action-menu]').getAttribute('open'), '');
    await page.locator('.app-page-title').click();
    assert.equal(await page.locator('[data-base-action-menu]').getAttribute('open'), null, 'outside click closes menu');
    await page.locator('[data-base-action-menu] summary').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-base-action-menu]').getAttribute('open'), null, 'Escape closes menu');
    await page.locator('[data-select-all]').check();
    assert.equal(await page.locator('[data-selected-count]').textContent(), '1');
    for (const action of ['publish', 'unpublish', 'archive', 'add-tag', 'migrate']) {
      await page.locator('[data-base-action-menu] summary').click();
      await page.locator('[data-base-action="' + action + '"]').click();
      assert.equal(await page.locator('#base-problem-action-dialog').isVisible(), true);
      if (action === 'migrate') {
        assert.match(await page.locator('[data-base-action-message]').textContent(), /新建正式题目默认未公开/);
        assert.match(await page.locator('[data-base-action-message]').textContent(), /基地原题及其公开状态保持不变/);
      }
      if (action === 'add-tag') await page.locator('[data-base-tag-select]').selectOption('7');
      await page.locator('[data-base-action-confirm]').click();
      await page.locator('[data-base-refresh]:not([hidden])').waitFor();
    }
    assert.deepEqual(writes.slice(0, 3).map(row => row.body), ['publish', 'unpublish', 'archive'].map(action => ({ action, problem_ids: [2] })));
    assert.deepEqual(writes[3].body, { workspace: 'base', tag_id: 7, problem_ids: [2] });
    assert.equal(writes[4].path, '/api/v2/base/problems/2/migrate');
    assert.match(await page.locator('[data-base-problem-progress]').textContent(), /新建正式题目均为未公开/);
    assert.equal(await page.locator('[data-base-migrate]').textContent(), '已迁移');
    assert.equal(await page.locator('[data-base-migrate]').isDisabled(), true);
    assert.equal(await page.locator('[data-base-migrated-link]').getAttribute('href'), '/problem/101');
    await page.screenshot({ path: '/tmp/nwpuoj-base-problems-desktop.png', fullPage: true });
    migration = null;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => !document.querySelector('[data-base-migrate]').disabled);
    assert.equal(await page.locator('[data-base-migrate]').textContent(), '迁移至正式题库');
    await page.locator('[data-base-migrate]').click();
    assert.match(await page.locator('[data-base-action-message]').textContent(), /已选择 1 题/);
    await page.locator('[data-base-action-confirm]').click();
    await page.locator('[data-base-refresh]:not([hidden])').waitFor();
    assert.equal(writes.length, 6);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('problem statement management offers migration only to base site admins and displays the resulting copy', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage(); const writes = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (route.request().method() === 'POST') {
        writes.push(new URL(route.request().url()).pathname);
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { problem_id: 102, skipped: false } }) });
      }
      return route.fulfill({ contentType: 'text/html', body: renderProblemContext() });
    });
    await page.goto('http://base.test/problem/2');
    await page.locator('.app-action-menu summary').click();
    await page.locator('[data-base-migrate]').click();
    assert.match(await page.locator('[data-base-action-message]').textContent(), /新建正式题目默认未公开/);
    await page.locator('[data-base-action-confirm]').click();
    await page.locator('[data-base-refresh]:not([hidden])').waitFor();
    assert.deepEqual(writes, ['/api/v2/base/problems/2/migrate']);
    assert.match(await page.locator('[data-base-problem-progress]').textContent(), /新建正式题目均为未公开/);
    assert.equal(await page.locator('[data-base-migrate]').textContent(), '已迁移');
    assert.equal(await page.locator('[data-base-migrated-link]').getAttribute('href'), '/problem/102');
    await page.setContent(renderProblemContext(false));
    assert.equal(await page.locator('[data-base-migrate]').count(), 0);
    await page.setContent(renderProblemContext(true, false));
    assert.equal(await page.locator('[data-base-migrate]').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('real problem and contest editors submit scoped payloads and keep global editors unchanged', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    for (const kind of ['problem', 'contest']) {
      const page = await browser.newPage(); const writes = []; const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        if (route.request().method() === 'POST') {
          writes.push(route.request().postDataJSON());
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { id: 21, problem: { id: 12 } } }) });
        }
        return route.fulfill({ contentType: 'text/html', body: new URL(route.request().url()).pathname.endsWith('/0/edit') ? renderEditor(kind) : '<!doctype html><p>Saved</p>' });
      });
      await page.goto('http://base.test/' + kind + '/0/edit?base=1');
      await page.locator('[name="title"]').fill('基地示例');
      if (kind === 'problem') assert.equal(await page.getByRole('link', { name: '打开图床', exact: true }).getAttribute('href'), '/image-host');
      if (kind === 'problem') await page.locator('[name="description"]').fill('计算两数之和。');
      if (kind === 'contest') {
        assert.equal(await page.locator('[name="is_rated"]').isDisabled(), true);
        assert.equal(await page.locator('[data-name="admins"]').count(), 0);
        assert.match(await page.locator('[data-name="problems"]').getAttribute('data-endpoint'), /workspace=base/);
      }
      if (kind === 'contest') {
        await page.locator('[data-contest-step-next]').click();
        await page.locator('[data-contest-step-next]').click();
        assert.deepEqual(await page.locator('[name^="medal_"]').evaluateAll(fields => fields.map(field => field.value)), ['10', '20', '30']);
        await page.locator('[name="medal_gold"]').fill('101');
        await page.locator('[name="medal_silver"]').fill('20');
        await page.locator('[name="medal_bronze"]').fill('20');
        await page.locator('[data-contest-step-next]').click();
        assert.equal(await page.locator('[data-contest-step-next]').isVisible(), true);
        await page.locator('[name="medal_gold"]').fill('70');
        await page.locator('[data-contest-step-next]').click();
      }
      await page.locator('form').first().evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
      await page.waitForURL(url => !url.pathname.endsWith('/0/edit'));
      assert.equal(writes.length, 1); assert.equal(writes[0].workspace, 'base');
      if (kind === 'contest') { assert.equal(writes[0].is_rated, false); assert.deepEqual(writes[0].admins, []); assert.deepEqual(writes[0].medal_percentages, { gold: 70, silver: 20, bronze: 20 }); }
      assert.deepEqual(errors, []);
      await page.setContent(renderEditor(kind, false));
      if (kind === 'problem') assert.equal(await page.getByRole('link', { name: '打开图床', exact: true }).count(), 0);
      if (kind === 'contest') { assert.equal(await page.locator('[name="is_rated"]').isDisabled(), false); assert.equal(await page.locator('[data-name="admins"]').count(), 1); }
      await page.close();
    }
  } finally { await browser.close(); }
});

test('contest medal inputs reload configured shares and align in desktop and mobile layouts', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const html = renderEditor('contest', false, { gold: 5, silver: 15, bronze: 30 });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1100 } });
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
      await page.goto('http://medal.test/contest/0/edit');
      for (const name of ['app-shell.css', 'app-shared.css', 'app-features.css']) await page.addStyleTag({ content: read(name) });
      await page.evaluate(() => document.body.classList.add('app-v2'));
      await page.locator('[name="title"]').fill('奖项比例测试');
      await page.locator('[data-contest-step-next]').click();
      await page.locator('[data-contest-step-next]').click();
      assert.deepEqual(await page.locator('[name^="medal_"]').evaluateAll(fields => fields.map(field => field.value)), ['5', '15', '30']);
      assert.equal(await page.locator('[data-medal-total]').count(), 0);
      assert.doesNotMatch(await page.locator('.app-medal-settings').textContent(), /设置比例合计|获奖比例合计/);
      const boxes = await page.locator('[name^="medal_"]').evaluateAll(fields => fields.map(field => {
        const box = field.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, width: box.width, height: box.height };
      }));
      assert.ok(boxes.every(box => box.width >= 70 && box.height >= 30 && box.right <= width));
      if (width > 600) assert.ok(boxes.every(box => Math.abs(box.y - boxes[0].y) < 1));
      else assert.ok(boxes[0].y < boxes[1].y && boxes[1].y < boxes[2].y);
      await page.locator('.app-medal-settings').screenshot({ path: '/tmp/nwpuoj-medals-' + width + '.png' });
      await page.close();
    }
  } finally { await browser.close(); }
});

test('base mobile pages keep navigation, long tables, imports, and bulk dialogs usable', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    for (const tab of ['problems', 'contests', 'members']) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const html = render(tab, true, true), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith('/self/')) return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css', body: read(path.basename(url.pathname)) });
        assert.equal(route.request().method(), 'GET', 'mobile checks cannot mutate production data');
        return route.fulfill({ contentType: 'text/html', body: html });
      });
      await page.goto('http://base.test/base/' + tab);
      await page.addScriptTag({ url: '/self/lucide-1.27.0.min.js' });
      await page.addScriptTag({ url: '/self/app-v2.js' });
      const table = page.locator('.app-base-page > .app-table-region, [data-base-problem-bulk] > .app-table-region');
      for (const width of [320, 360, 390, 768]) {
        await page.setViewportSize({ width, height: 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), tab + ': no page overflow at ' + width);
        assert.ok(await table.evaluate(element => element.scrollWidth > element.clientWidth), tab + ': dense data can scroll locally');
        await table.evaluate(element => { element.scrollLeft = 150; });
        assert.ok(await table.evaluate(element => element.scrollLeft > 0));
        const search = await page.locator('.app-base-toolbar input[type="search"]').boundingBox();
        assert.ok(search.width > 160 && search.x + search.width <= width, 'search stays usable');
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await table.evaluate(element => { element.scrollLeft = 0; });
      assert.equal(await page.locator('.app-base-scroll-hint').isVisible(), true);
      await page.screenshot({ path: '/tmp/nwpuoj-base-' + tab + '-mobile.png', fullPage: true });
      if (tab === 'problems') {
        await page.locator('[data-select-all]').check();
        await page.locator('[data-base-action-menu] summary').click();
        const menu = await page.locator('.app-action-menu-list').boundingBox();
        assert.ok(menu.x >= 0 && menu.x + menu.width <= 390, 'bulk menu fits mobile');
        await page.locator('[data-base-action="archive"]').click();
        const dialog = await page.locator('#base-problem-action-dialog').boundingBox();
        assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= 390, 'confirmation fits mobile');
        await page.getByRole('button', { name: '取消', exact: true }).click();
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
