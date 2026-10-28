'use strict';
// Real editor and statement templates with intercepted requests only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const catalog = [{ id: 7, name: '动态规划' }, { id: 8, name: '基地练习' }];

function render(view, tagIds) {
  const template = fs.readFileSync(path.join(root, 'views', view + '.ejs'), 'utf8').replace(/<% include \w+ %>/g, '');
  const script = `const fs=require('fs'),ejs=require('/app/node_modules/ejs');const x=JSON.parse(fs.readFileSync(0,'utf8'));
    const problem={id:12,new:false,title:'基地测试题',description:'题面',input_format:'',output_format:'',example:'',limit_and_hint:'',type:'traditional',is_public:true,is_anonymous:false,tags:x.tags,allowedEdit:true,allowedManage:true};
    const utils={makeUrl:parts=>'/'+parts.join('/'),removeTitleTag:x=>x};
    process.stdout.write(ejs.render(x.template,{problem,testcases:[],baseContext:true,baseMember:true,appHasCapability:()=>false,user:{id:2},req:{query:{}},syzoj:{utils}}));`;
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], {
    cwd: path.join(root, '..'), input: JSON.stringify({ template, tags: catalog.filter(tag => tagIds.includes(tag.id)) }), encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  return '<!doctype html><html><meta charset="utf-8"><body>' + result.stdout + '</body></html>';
}

test('base editor preserves administrator tags, saves member additions/removals, and displays them on the statement', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = [], writes = [];
    let assigned = [7]; // An administrator assigned this tag before the member opened the editor.
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: render(url.pathname.endsWith('/edit') ? 'problem_edit' : 'problem', assigned) });
      }
      let data;
      if (url.pathname.endsWith('/update')) {
        const body = request.postDataJSON();
        assert.equal(body.workspace, 'base');
        assert.equal(body.if_match, 'body-etag', 'works when the public proxy omits the ETag header');
        assigned = body.tag_ids; writes.push(body);
        data = { problem: { id: 12 }, version: { id: '10' } };
      } else if (url.pathname.includes('/search/tags/')) data = catalog.map(tag => ({ value: tag.id, name: tag.name }));
      else if (url.pathname.includes('/versions/')) data = { content: { title: '基地测试题', description: '题面' } };
      else if (url.pathname.endsWith('/publish')) data = {};
      else data = { id: 12, current_version_id: '9', visibility: 'public' };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data, meta: { etag: 'body-etag' } }) });
    });
    async function edit() {
      await page.goto('http://tags.test/problem/12/edit');
      await page.waitForFunction(() => !document.querySelector('button[type="submit"]').disabled);
    }
    async function save() {
      await page.getByRole('button', { name: '保存题目', exact: true }).click();
      await page.waitForURL(url => !url.pathname.endsWith('/edit'));
    }
    await edit();
    assert.equal(await page.locator('[data-tag-id="7"] strong').textContent(), '动态规划');
    await save();
    assert.deepEqual(writes[0].tag_ids, [7], 'an unchanged save keeps administrator tags');
    assert.deepEqual(await page.locator('.app-problem-tags .app-tag').allTextContents(), ['动态规划']);
    await edit();
    await page.locator('[data-tag-search]').fill('基地');
    await page.locator('[data-tag-results]').getByRole('button', { name: '基地练习', exact: true }).click();
    await save();
    assert.deepEqual(writes[1].tag_ids, [7, 8]);
    assert.deepEqual(await page.locator('.app-problem-tags .app-tag').allTextContents(), ['动态规划', '基地练习']);
    await edit();
    await page.getByRole('button', { name: '移除 动态规划', exact: true }).click();
    assert.equal(writes.length, 2, 'removing a chip must not implicitly submit the form');
    await save();
    assert.deepEqual(writes[2].tag_ids, [8]);
    assert.deepEqual(await page.locator('.app-problem-tags .app-tag').allTextContents(), ['基地练习']);
    await edit();
    await page.getByRole('button', { name: '移除 基地练习', exact: true }).click();
    await save();
    assert.deepEqual(writes[3].tag_ids, []);
    assert.equal(await page.locator('.app-problem-tags .app-tag').count(), 0);
    await edit();
    assert.equal(await page.locator('[data-tag-selected] [data-tag-id]').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
