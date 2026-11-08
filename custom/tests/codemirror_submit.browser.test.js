'use strict';

// Real templates and local editor assets, with every write intercepted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const sample = '#include <iostream>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n\n    // Read two integers and print their sum.\n    long long a, b;\n    cin >> a >> b;\n\n    cout << a + b << "\\n";\n    return 0;\n}\n';

function fixtures() {
  const template = read('views/problem_submit.ejs')
    .replace('<% include problem_context %>', read('views/problem_context.ejs'))
    .replace('<% include problem_submit_form %>', read('views/problem_submit_form.ejs'))
    .replace(/<% include \w+ %>/g, '');
  const script = `
    const fs=require('fs'),ejs=require('/app/node_modules/ejs');
    const x=JSON.parse(fs.readFileSync(0,'utf8'));
    const config=require('/app/config/web.json'),languages=require('/app/language-config.json');
    const utils={makeUrl:(parts,query)=>'/'+parts.join('/')+(query?'?'+new URLSearchParams(query):''),removeTitleTag:String,getCurrentDate:()=>200,formatDate:String,contestSubmissionEnabled:()=>true};
    const pages={};
    for(const kind of ['practice','contest','problem-set','base','answer']) {
      const problem={id:1000,title:'A + B Problem',type:kind==='answer'?'submit-answer':'traditional',time_limit:1000,memory_limit:256,getDisplayId:()=>1000};
      const contest=kind==='contest'?{id:21,title:'测试比赛',start_time:100,end_time:400,isRunning:()=>true,isEnded:()=>false}:null;
      const problemSet=kind==='problem-set'?{id:31,title:'测试题单'}:null;
      const testcases=[{cases:[{answer:'1.out'},{answer:'2.out'}]}];
      pages[kind]=ejs.render(x.template,{problem,contest,problemSet,baseContext:kind==='base',baseAdmin:false,user:{id:7,username:'fixture'},
        problemContext:{problem,contest,contestProblemId:1,problemSet,problemSetProblemId:1,problemSetCanParticipate:true,section:'submit',testcases},
        languages:null,state:{language:'cpp23',code:x.sample},lastLanguage:'cpp',testcases,serializejs:JSON.stringify,syzoj:{config,languages,utils}
      },{context:{alpha:n=>String.fromCharCode(64+n)}});
    }
    process.stdout.write(JSON.stringify(pages));`;
  const result = spawnSync('docker', ['exec', '-i', 'nwpuoj-web-1', 'node', '-e', script], {
    input: JSON.stringify({ template, sample }), encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(Object.entries(JSON.parse(result.stdout)).map(([name, body]) => [name,
    '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + ['app-shell.css', 'app-shared.css', 'app-features.css'].map(file => `<link rel="stylesheet" href="/self/${file}">`).join('')
    + '</head><body class="app-v2"><main class="app-main">' + body + '</main><script src="/self/app-v2.js"></script></body></html>'
  ]));
}

async function chooseEditorOption(page, label, value) {
  const trigger = page.getByRole('combobox', { name: label, exact: true });
  await trigger.click();
  const menu = page.getByRole('listbox', { name: label, exact: true });
  const option = menu.locator('[data-value="' + value + '"]');
  const triggerBox = await trigger.boundingBox(), menuBox = await menu.boundingBox();
  assert.ok(Math.abs(triggerBox.x - menuBox.x) < 1, label + ': menu aligns with trigger left edge');
  assert.ok(Math.abs(triggerBox.width - menuBox.width) < 1, label + ': menu matches trigger width');
  assert.equal(await option.evaluate(node => getComputedStyle(node).fontSize), await trigger.evaluate(node => getComputedStyle(node).fontSize));
  assert.equal((await option.boundingBox()).height, triggerBox.height, label + ': option height matches trigger');
  await option.click();
}

test('CodeMirror preserves source and submission workflows with responsive editor controls', { timeout: 90000 }, async () => {
  const pages = fixtures(), writes = [], errors = [];
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1080 } });
  async function routes(page, fallback = false) {
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      assert.equal(url.hostname, 'editor.test', 'all assets stay local');
      if (fallback && url.pathname.endsWith('/editor.min.js')) return route.abort();
      if (url.pathname.startsWith('/self/')) return route.fulfill({
        contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css',
        body: fs.readFileSync(path.join(root, url.pathname.replace(/^\/self\/lib\//, 'static-libs/').replace(/^\/self\//, '')))
      });
      if (url.pathname.startsWith('/api/')) {
        writes.push({ path: url.pathname, body: request.headers()['content-type'].includes('application/json') ? request.postDataJSON() : request.postData() });
        return route.fulfill({ json: { data: { submission: { id: 99 } } } });
      }
      const name = url.pathname.slice(1);
      return route.fulfill({ contentType: 'text/html', body: pages[name] || '<p>Submission saved in test fixture</p>' });
    });
  }
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await routes(page);
  const content = page.locator('#editor .cm-content');
  try {
    await page.goto('http://editor.test/practice');
    await content.waitFor();
    assert.equal(await page.locator('#editor').getAttribute('data-editor-engine'), 'codemirror');
    assert.equal(await page.evaluate(() => window.editor.getValue()), sample);
    assert.ok((await page.locator('[data-code-workbench] > .app-editor-toolbar').boundingBox()).height <= 44, 'desktop toolbar stays compact');
    assert.equal(await page.getByRole('combobox').count(), 3);
    const languageControl = page.getByRole('combobox', { name: '编程语言', exact: true });
    await languageControl.press('Enter');
    await languageControl.press('End');
    await languageControl.press('Enter');
    assert.equal(await page.locator('[data-language-input]').inputValue(), 'pypy3');
    assert.equal(await page.locator('[data-language-version]').textContent(), 'PyPy 7.3.23');
    await languageControl.press('Enter');
    await languageControl.press('Home');
    await languageControl.press('Escape');
    assert.equal(await page.locator('[data-language-input]').inputValue(), 'pypy3', 'Escape cancels an uncommitted option');
    assert.equal(await languageControl.getAttribute('aria-expanded'), 'false');
    await chooseEditorOption(page, '编程语言', 'cpp23');
    // Sample pixels inside selected indentation, where syntax and the caret
    // cannot disguise an active-line background painting over the selection.
    const selectionSource = '                    int value = 1;\n                    int other = 2;';
    for (const theme of ['light', 'dark']) {
      await page.locator('html').evaluate((node, value) => { node.dataset.theme = value; }, theme);
      await page.evaluate(value => window.editor.setValue(value), selectionSource);
      await content.press('Control+Home');
      const line = await content.locator('.cm-line').first().boundingBox();
      const clip = { x: line.x + 22, y: line.y + 8, width: 8, height: 8 };
      const unselected = await page.screenshot({ clip, animations: 'disabled' });
      await content.press('Shift+End');
      await page.locator('.cm-selectionBackground').first().waitFor();
      assert.equal(await page.evaluate(() => window.getSelection().toString()), selectionSource.split('\n')[0]);
      assert.notDeepEqual(await page.screenshot({ clip, animations: 'disabled' }), unselected, theme + ': selected text must visibly highlight on the active line');
      await page.screenshot({ path: '/tmp/nwpuoj-codemirror-selection-' + theme + '.png', fullPage: true, animations: 'disabled' });
      await page.getByRole('combobox', { name: '编辑器字号' }).focus();
      assert.notDeepEqual(await page.screenshot({ clip, animations: 'disabled' }), unselected, theme + ': selection remains visible when editor loses focus');
    }
    await page.locator('html').evaluate(node => { node.dataset.theme = 'light'; });
    await page.evaluate(value => window.editor.setValue(value), sample);
    assert.deepEqual(await page.locator('[data-language-select] option').evaluateAll(items => items.map(item => item.value)), ['cpp11','cpp17','cpp20','cpp23','c','java','python311','pypy3']);
    const source = '# comment\nprint("你好")\n';
    await page.evaluate(value => window.editor.setValue(value), source);
    await chooseEditorOption(page, '编程语言', 'python311');
    assert.equal(await page.locator('[data-language-version]').textContent(), 'CPython 3.11.15');
    assert.equal(await page.evaluate(() => window.editor.getValue()), source);
    await content.press('Control+End');
    await page.keyboard.type('# added');
    assert.equal(await page.evaluate(() => window.editor.getValue()), source + '# added');
    await content.press('Control+z');
    assert.equal(await page.evaluate(() => window.editor.getValue()), source);
    await chooseEditorOption(page, '编辑器字号', '18');
    assert.equal(await page.locator('#editor .cm-editor').evaluate(node => getComputedStyle(node).fontSize), '18px');
    await chooseEditorOption(page, '缩进空格数', '2');
    await content.press('Control+End');
    await content.press('Tab');
    assert.equal(await page.evaluate(() => window.editor.getValue()), source + '  ');
    await content.press('Control+f');
    await page.locator('.cm-search input[name="search"]').fill('print');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.cm-search').count(), 0);
    await page.getByRole('button', { name: '全屏编辑', exact: true }).click();
    assert.equal(await page.locator('[data-code-workbench]').getAttribute('aria-modal'), 'true');
    await languageControl.click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-code-workbench]').getAttribute('aria-modal'), 'true', 'Escape closes dropdown before fullscreen');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-code-workbench]').getAttribute('aria-modal'), null);
    assert.equal(await page.getByRole('button', { name: '全屏编辑', exact: true }).evaluate(node => node === document.activeElement), true);
    await chooseEditorOption(page, '编程语言', 'cpp23');
    await page.evaluate(value => window.editor.setValue(value), sample);
    await chooseEditorOption(page, '编辑器字号', '14');
    await chooseEditorOption(page, '缩进空格数', '4');
    const lightToken = await page.locator('.cm-content .cm-line span').first().evaluate(node => getComputedStyle(node).color);
    await page.screenshot({ path: '/tmp/nwpuoj-codemirror-desktop.png', fullPage: true, animations: 'disabled' });
    await languageControl.click();
    await page.locator('[data-code-workbench]').screenshot({ path: '/tmp/nwpuoj-editor-toolbar-light.png', animations: 'disabled' });
    await content.click();
    assert.equal(await languageControl.getAttribute('aria-expanded'), 'false', 'outside click closes dropdown');
    await page.locator('html').evaluate(node => { node.dataset.theme = 'dark'; });
    await page.waitForFunction(color => getComputedStyle(document.querySelector('.cm-content .cm-line span')).color !== color, lightToken);
    assert.notEqual(await page.locator('.cm-editor').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
    await page.screenshot({ path: '/tmp/nwpuoj-codemirror-dark.png', fullPage: true, animations: 'disabled' });
    await languageControl.click();
    await page.locator('[data-code-workbench]').screenshot({ path: '/tmp/nwpuoj-editor-toolbar-dark.png', animations: 'disabled' });
    await languageControl.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('html').evaluate(node => { node.dataset.theme = 'light'; });
    await page.waitForFunction(color => getComputedStyle(document.querySelector('.cm-content .cm-line span')).color === color, lightToken);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await languageControl.click();
    const menuBounds = await page.getByRole('listbox', { name: '编程语言' }).boundingBox();
    assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 390, 'mobile dropdown fits the viewport');
    await page.screenshot({ path: '/tmp/nwpuoj-editor-toolbar-mobile.png', fullPage: true, animations: 'disabled' });
    await languageControl.press('Escape');
    await page.screenshot({ path: '/tmp/nwpuoj-codemirror-mobile.png', fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '提交评测', exact: true }).click();
    await page.waitForURL('**/submission/99');
    assert.deepEqual(writes.at(-1), { path: '/api/v2/problems/1000/submissions', body: { source: sample, language: 'cpp23', source_visibility: 'private' } });

    for (const kind of ['contest', 'problem-set', 'base']) {
      await page.goto('http://editor.test/' + kind);
      await content.waitFor();
      await chooseEditorOption(page, '编程语言', 'java');
      assert.equal(await page.locator('[data-language-version]').textContent(), 'OpenJDK 11.0.11');
      await page.locator('#answer').setInputFiles({ name: 'Main.java', mimeType: 'text/plain', buffer: Buffer.from('class Main {}') });
      await page.getByRole('button', { name: '提交评测', exact: true }).click();
      await page.waitForURL(url => url.pathname.endsWith('/submissions'));
      assert.deepEqual(writes.at(-1).body, { source: 'class Main {}', language: 'java', source_visibility: 'private' });
      assert.equal(new URL(page.url()).pathname, kind === 'contest' ? '/contest/21/submissions' : kind === 'problem-set' ? '/problem-set/31/submissions' : '/base/submissions');
    }

    await page.goto('http://editor.test/answer');
    await page.locator('#editor-0 .cm-content').waitFor();
    await page.evaluate(() => { answerEditors[0].setValue('42\n'); answerEditors[1].setValue('100\n'); });
    await page.locator('[data-case-index="1"]').click();
    assert.equal(await page.locator('#editor-1 .cm-content').isVisible(), true);
    await page.getByRole('button', { name: '提交答案', exact: true }).click();
    await page.waitForURL('**/submission/99');
    assert.equal(writes.at(-1).path, '/api/v2/problems/1000/submit-answer');
    assert.ok(writes.at(-1).body.includes('1.out') && writes.at(-1).body.includes('2.out'));

    const fallback = await context.newPage();
    await routes(fallback, true);
    await fallback.goto('http://editor.test/practice');
    await fallback.locator('.app-code-fallback').fill('int main() {}');
    await chooseEditorOption(fallback, '编程语言', 'cpp11');
    await fallback.getByRole('button', { name: '提交评测', exact: true }).click();
    await fallback.waitForURL('**/submission/99');
    assert.equal(writes.at(-1).body.source, 'int main() {}');
    assert.equal(writes.at(-1).body.language, 'cpp11');
    const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const touchPage = await touchContext.newPage();
    await routes(touchPage);
    await touchPage.goto('http://editor.test/practice');
    await touchPage.getByRole('combobox', { name: '编程语言', exact: true }).tap();
    await touchPage.locator('.app-editor-select-menu:visible [data-value="java"]').tap();
    assert.equal(await touchPage.locator('[data-language-input]').inputValue(), 'java', 'touch selection updates the submission language');
    assert.equal(await touchPage.evaluate(() => window.editor.getValue()), sample);
    await touchContext.close();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
