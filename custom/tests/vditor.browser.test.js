'use strict';

// All requests are intercepted: no real accounts, uploads, messages or problems
// are created. Use the actual bundled Vditor and OJ integration, not a stub.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const sample = '| 测试点 | 分值 |\n| --- | --- |\n| 1 | 10 |\n| 1 | 10 |\n\n公式：$1+1=2$\n\n```cpp\nint main() { return 0; }\n```\n';
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function html(body, upload = false, app = false) {
  return '<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + ['app-shell.css', 'app-shared.css', 'app-features.css'].map(name => `<link rel="stylesheet" href="/self/${name}">`).join('')
    + '</head><body class="app-v2"><main class="app-main"><div class="app-page">' + body + '</div></main>'
    + (app ? '<script src="/self/app-v2.js"></script>' : '<script>window.messages=[];window.NWPUOJApp={showToast:message=>window.messages.push(message)};</script>')
    + `<script src="/self/lib/noj-markdown.js" data-upload-allowed="${upload ? 1 : 0}"></script></body></html>`;
}

async function fixture(body, options = {}) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors = [], external = [], uploads = [], requests = [];
  if (options.init) await page.addInitScript(options.init);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push(url.pathname);
    if (url.origin !== 'http://markdown.test') {
      external.push(url.origin + url.pathname);
      return route.fulfill({ status: 404, body: '' });
    }
    if (options.api && url.pathname.startsWith('/api/')) return options.api(route, request, url);
    if (url.pathname === '/api/v2/image-host') {
      uploads.push(request.postDataBuffer());
      if (options.uploadError) return route.fulfill({ status: 403, json: { error: { message: '没有图床上传权限' } } });
      return route.fulfill({ json: { data: { url: 'https://noj.nwpu.edu.cn/uploads/image-host/fixture.png' } } });
    }
    if (url.pathname.startsWith('/self/')) {
      if (url.pathname.startsWith('/self/image-assets/')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#f2f6fb"/><path d="M55 115L160 52L265 115" stroke="#8caacb" stroke-width="3" fill="none"/><g fill="#e2edfa" stroke="#145fb8" stroke-width="2"><circle cx="55" cy="115" r="17"/><circle cx="160" cy="52" r="17"/><circle cx="265" cy="115" r="17"/></g><g fill="#145fb8" font-size="15" text-anchor="middle" font-family="sans-serif"><text x="55" y="120">1</text><text x="160" y="57">2</text><text x="265" y="120">3</text></g></svg>' });
      const file = path.join(root, url.pathname.replace(/^\/self\/lib\//, 'static-libs/').replace(/^\/self\//, ''));
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || options.failAssets && url.pathname.endsWith('index.min.js')) return route.fulfill({ status: 404, body: '' });
      const type = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
      return route.fulfill({ contentType: type, body: fs.readFileSync(file) });
    }
    return route.fulfill({ contentType: 'text/html', body: html(body, options.upload, options.app) });
  });
  await page.goto('http://markdown.test/fixture', { waitUntil: 'domcontentloaded' });
  return { browser, page, errors, external, uploads, requests };
}

async function mode(page, name, host = '.app-vditor-host') {
  await page.locator(host + ' button[data-type="edit-mode"]').click();
  await page.locator(host + ` button[data-mode="${name}"]`).click();
}
async function ready(page) { await page.waitForSelector('[data-vditor-ready="1"]', { state: 'attached' }); }

function renderTemplate(name, data) {
  const template = fs.readFileSync(path.join(root, 'views', name + '.ejs'), 'utf8')
    .replace(/<% include (markdown_editor_script|clipboard_v2_script) %>/g, (_, partial) => fs.readFileSync(path.join(root, 'views', partial + '.ejs'), 'utf8'))
    .replace(/<% include \w+ %>/g, '');
  const script = `const fs=require('fs'),ejs=require('/app/node_modules/ejs');const x=JSON.parse(fs.readFileSync(0,'utf8'));
    const locals=Object.assign({user:{id:2},adminCsrfToken:'fixture-csrf',req:{query:{}},syzoj:{utils:{makeUrl:parts=>'/'+parts.join('/')}},appHasCapability:()=>false},x.data);
    process.stdout.write(ejs.render(x.template,locals));`;
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], {
    cwd: path.join(root, '..'), input: JSON.stringify({ template, data }), encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  const footer = fs.readFileSync(path.join(root, 'views/app_footer.ejs'), 'utf8');
  const writeHeaders = footer.match(/<script>[\s\S]*?<\/script>/g).find(script => script.includes('__nwpuojWriteHeaders'));
  return '<meta name="csrf-token" content="fixture-csrf">' + result.stdout + writeHeaders;
}

test('Vditor renders formulas/code and repeated table cells locally without merging', { timeout: 60000 }, async () => {
  const f = await fixture(`<form data-problem-editor-v2><label class="app-field"><span class="app-label">题面</span><textarea name="description" rows="30" required>${escape(sample)}</textarea></label></form>`);
  try {
    await f.page.waitForFunction(() => document.querySelector('textarea').dataset.vditorReady === '1');
    const editor = f.page.locator('.app-vditor-host');
    assert.equal(await editor.isVisible(), true);
    assert.equal(await f.page.locator('textarea.vditor-sv').isVisible(), true);
    assert.equal(await f.page.locator('.vditor-preview').isVisible(), true);
    await mode(f.page, 'ir');
    assert.equal(await editor.locator('table [rowspan],table [colspan]').count(), 0);
    assert.equal(await editor.locator('.vditor-ir table tbody td').count(), 4);
    assert.equal(await f.page.locator('textarea[name="description"]').inputValue(), sample, 'opening an editor preserves original source exactly');
    await f.page.waitForFunction(() => !!document.querySelector('.app-vditor-host .katex'));
    assert.ok(await editor.locator('[data-type="code-block"]').count());
    assert.equal(await f.page.locator('label .app-vditor-host').count(), 0, 'native labels cannot steal editable focus');
    assert.deepEqual(f.external, []);
    assert.deepEqual(f.errors, []);
    await f.page.screenshot({ path: '/tmp/nwpuoj-vditor-desktop.png', fullPage: true });
    await f.page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await f.page.screenshot({ path: '/tmp/nwpuoj-vditor-mobile.png', fullPage: true });
  } finally { await f.browser.close(); }
});

test('native typing immediately saves through required validation, FormData and JSON values in all modes', { timeout: 60000 }, async () => {
  const f = await fixture('<form data-message-v2="new"><label class="app-field"><span class="app-label">消息</span><textarea name="content" required maxlength="5000"></textarea></label><button type="submit">保存</button></form><script>window.saved=[];document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();window.saved.push({form:new FormData(e.target).get("content"),json:e.target.elements.content.value})});</script>');
  try {
    await ready(f.page);
    assert.equal(await f.page.locator('textarea[name="content"]').getAttribute('tabindex'), '-1');
    await f.page.getByRole('button', { name: '保存', exact: true }).click();
    assert.equal(await f.page.evaluate(() => saved.length), 0);
    await mode(f.page, 'ir');
    await f.page.locator('.vditor-ir [contenteditable="true"]').fill('即时保存');
    await f.page.getByRole('button', { name: '保存', exact: true }).click();
    assert.equal(await f.page.evaluate(() => saved.length), 1);
    assert.match(await f.page.evaluate(() => saved[0].form), /即时保存/);
    await mode(f.page, 'sv');
    await f.page.locator('textarea.vditor-sv').fill(sample);
    await f.page.getByRole('button', { name: '保存', exact: true }).click();
    assert.equal(await f.page.evaluate(() => saved[1].json), sample);
    await mode(f.page, 'wysiwyg');
    assert.equal(await f.page.locator('.vditor-wysiwyg tbody td').count(), 4);
    assert.equal(await f.page.locator('.vditor-wysiwyg [rowspan],.vditor-wysiwyg [colspan]').count(), 0);
    await f.page.getByRole('button', { name: '保存', exact: true }).click();
    assert.match(await f.page.evaluate(() => saved[2].form), /1\s*\|\s*10/);
    await mode(f.page, 'ir');
    assert.equal(await f.page.locator('.vditor-ir table tbody td').count(), 4);
    assert.deepEqual(await f.page.evaluate(() => saved.map(x => x.form === x.json)), [true, true, true]);
    assert.deepEqual(f.errors, []);
  } finally { await f.browser.close(); }
});

test('plain notification toggle, reset, maxlength, disabled state and theme preserve values', { timeout: 60000 }, async () => {
  const f = await fixture('<form data-site-notification-editor><textarea name="content" maxlength="30">初始内容</textarea><label><input type="checkbox" name="allow_markdown" checked>Markdown</label><button type="reset">重置</button></form>');
  try {
    await ready(f.page);
    await mode(f.page, 'sv');
    await f.page.locator('textarea.vditor-sv').fill('编辑后的内容\n第二行');
    await f.page.getByLabel('Markdown', { exact: true }).uncheck();
    const source = f.page.locator('textarea[name="content"]');
    assert.equal(await source.isVisible(), true);
    assert.match(await source.inputValue(), /编辑后的内容\n第二行/);
    assert.equal(await source.getAttribute('tabindex'), null);
    await source.fill('纯文本修改\n下一行');
    await f.page.getByLabel('Markdown', { exact: true }).check();
    assert.match(await f.page.locator('textarea.vditor-sv').inputValue(), /纯文本修改\n下一行/);
    await f.page.locator('textarea.vditor-sv').fill('a'.repeat(40));
    assert.equal(await source.evaluate(x => x.checkValidity()), false);
    assert.match(await source.evaluate(x => x.validationMessage), /30/);
    await f.page.getByRole('button', { name: '重置', exact: true }).click();
    await f.page.waitForFunction(() => document.querySelector('textarea.vditor-sv').value.trim() === '初始内容');
    assert.equal(await source.inputValue(), '初始内容');
    assert.equal(await source.evaluate(x => x.checkValidity()), true);
    await source.evaluate(x => { x.disabled = true; });
    await f.page.waitForFunction(() => document.querySelector('.app-vditor-host').getAttribute('aria-disabled') === 'true');
    assert.equal(await source.evaluate(x => new FormData(x.form).has('content')), false);
    await source.evaluate(x => { x.disabled = false; x.value = ''; });
    await f.page.waitForFunction(() => document.querySelector('textarea.vditor-sv').value === '');
    await f.page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); document.dispatchEvent(new Event('nwpuoj:themechange')); });
    await f.page.waitForFunction(() => document.querySelector('.app-vditor-host').classList.contains('vditor--dark'));
    await f.page.screenshot({ path: '/tmp/nwpuoj-vditor-dark.png', fullPage: true });
    assert.deepEqual(f.errors, []);
  } finally { await f.browser.close(); }
});

test('local drafts restore into Vditor and continue saving without its shared cache', { timeout: 60000 }, async () => {
  const body = '<form data-markdown-editor data-draft-key="content-draft:help:2"><input name="title" value="帮助"><textarea name="content">服务器原文</textarea><span data-draft-status></span><button type="button" data-save-draft>存草稿</button></form>' + fs.readFileSync(path.join(root, 'views/markdown_editor_script.ejs'), 'utf8');
  const f = await fixture(body, { init: () => { window.confirm = () => true; localStorage.setItem('content-draft:help:2', JSON.stringify({title:'帮助',content:'恢复的草稿',allowComment:null})); } });
  try {
    await ready(f.page);
    assert.match(await f.page.locator('textarea.vditor-sv').inputValue(), /恢复的草稿/);
    await mode(f.page, 'sv');
    await f.page.locator('textarea.vditor-sv').fill('新草稿\n\n**粗体**');
    await f.page.getByRole('button', { name: '存草稿', exact: true }).click();
    assert.match(await f.page.evaluate(() => JSON.parse(localStorage.getItem('content-draft:help:2')).content), /新草稿/);
    assert.deepEqual(await f.page.evaluate(() => Object.keys(localStorage)), ['content-draft:help:2']);
    assert.deepEqual(f.errors, []);
  } finally { await f.browser.close(); }
});

test('image uploads use the existing authorized endpoint and insert the returned URL', { timeout: 60000 }, async () => {
  const f = await fixture('<form data-problem-editor-v2><textarea name="description">图片题面</textarea></form>', { upload: true });
  try {
    await ready(f.page);
    await mode(f.page, 'sv');
    await f.page.locator('textarea.vditor-sv').focus();
    await f.page.locator('.app-vditor-host input[type="file"]').setInputFiles({ name: '图示.png', mimeType: 'image/png', buffer: Buffer.from('png fixture') });
    await f.page.waitForFunction(() => document.querySelector('textarea[name="description"]').value.includes('/uploads/image-host/fixture.png'));
    assert.equal(f.uploads.length, 1);
    assert.match(f.uploads[0].toString('utf8'), /name="image"/);
    assert.match(await f.page.locator('textarea[name="description"]').inputValue(), /!\[图示\.png\]\(https:\/\/noj\.nwpu\.edu\.cn\/uploads\/image-host\/fixture\.png\)/);
    await f.page.locator('.app-vditor-host input[type="file"]').setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
    await f.page.waitForFunction(() => messages.some(x => x.includes('10 MiB')));
    assert.equal(f.uploads.length, 1, 'invalid files never reach the API');
    assert.deepEqual(f.errors, []);
  } finally { await f.browser.close(); }
  const denied = await fixture('<form data-problem-editor-v2><textarea name="description">原始题面</textarea></form>', { upload: true, uploadError: true });
  try {
    await ready(denied.page);
    await mode(denied.page, 'ir');
    await denied.page.locator('.vditor-ir [contenteditable="true"]').focus();
    await denied.page.locator('.app-vditor-host input[type="file"]').setInputFiles({ name: '图示.png', mimeType: 'image/png', buffer: Buffer.from('png fixture') });
    await denied.page.waitForFunction(() => messages.includes('没有图床上传权限'));
    assert.equal(await denied.page.locator('textarea[name="description"]').inputValue(), '原始题面');
    assert.deepEqual(denied.errors, []);
  } finally { await denied.browser.close(); }
});

for (const editorMode of ['ir', 'wysiwyg', 'sv']) {
  for (const action of ['upload', 'library']) {
    test(`image integration: ${action} renders and saves a loaded image in ${editorMode}`, { timeout: 60000 }, async () => {
      const url = 'http://markdown.test/self/image-assets/fixture.png?size=1&v=2';
      const name = '图示 (1) & 示例.png';
      const asset = { id: 1, original_name: name, file_size: 2048, url };
      const f = await fixture('<form data-problem-editor-v2><textarea name="description">前 后</textarea></form>', {
        upload: true, app: true, api: (route, request) => route.fulfill({ json: { data: request.method() === 'GET' ? [asset] : asset } })
      });
      try {
        await ready(f.page);
        if (editorMode !== 'sv') await mode(f.page, editorMode);
        await f.page.evaluate(editorMode => {
          if (editorMode === 'sv') {
            const input = document.querySelector('textarea.vditor-sv'); input.focus(); input.setSelectionRange(2, 2);
          } else {
            const input = document.querySelector('.vditor-' + editorMode + ' [contenteditable="true"]');
            input.focus();
            const text = input.querySelector('p').firstChild;
            const range = document.createRange(); range.setStart(text, 2); range.collapse(true);
            getSelection().removeAllRanges(); getSelection().addRange(range);
          }
        }, editorMode);
        if (action === 'upload') {
          await Promise.all([
            f.page.waitForResponse(response => response.url().includes('/api/v2/image-host')),
            f.page.locator('.app-vditor-host input[type="file"]').setInputFiles({ name, mimeType: 'image/png', buffer: Buffer.from('fixture') })
          ]);
          await f.page.waitForFunction(() => !document.querySelector('.app-vditor-statusbar').classList.contains('is-uploading'));
        } else {
          await f.page.locator('[data-type="image-library"]').click();
          await f.page.getByRole('button', { name: '插入 ' + name, exact: true }).click();
        }
        const source = await f.page.locator('textarea[name="description"]').inputValue();
        assert.ok(source.includes(url), 'saved Markdown must retain the image URL: ' + source);
        assert.ok(source.indexOf('前') < source.indexOf('![') && source.indexOf('后') > source.indexOf('!['), 'image stays at the selected cursor');
        const container = editorMode === 'sv' ? '.vditor-preview' : '.vditor-' + editorMode;
        await f.page.waitForFunction(selector => {
          const image = document.querySelector(selector + ' img');
          return image && image.complete && image.naturalWidth > 0;
        }, container).catch(async error => {
          error.message += '\n' + JSON.stringify(await f.page.evaluate(selector => ({ preview: document.querySelector(selector).outerHTML, source: document.querySelector('textarea[name="description"]').value }), container));
          throw error;
        });
        assert.equal(await f.page.locator(container + ' img').first().getAttribute('src'), url);
        assert.equal(await f.page.locator('.app-vditor-host [data-file-selection]').count(), 0, 'toolbar upload has no generic file-selection label');
        await f.page.screenshot({ path: `/tmp/nwpuoj-vditor-image-${editorMode}-${action}.png`, fullPage: true });
        if (editorMode !== 'sv') await mode(f.page, 'sv');
        assert.ok((await f.page.locator('textarea.vditor-sv').inputValue()).includes(url));
        await mode(f.page, 'ir');
        await f.page.waitForFunction(() => Array.from(document.querySelectorAll('.vditor-ir img')).some(image => image.naturalWidth > 0));
        assert.deepEqual(f.errors, []);
        assert.deepEqual(f.external, []);
      } finally { await f.browser.close(); }
    });
  }
}

test('heading markers keep a visible left gutter in rich modes on desktop and mobile', { timeout: 60000 }, async () => {
  const f = await fixture('<form data-problem-editor-v2><textarea name="description">## 二级标题\n\n正文内容</textarea></form>', { app: true });
  try {
    await ready(f.page);
    for (const editorMode of ['ir', 'wysiwyg']) {
      await f.page.setViewportSize({ width: 1440, height: 900 });
      await mode(f.page, editorMode);
      for (const width of [1440, 700, 390]) {
        await f.page.setViewportSize({ width, height: 900 });
        const gutter = await f.page.locator('.vditor-' + editorMode + ' h2').first().evaluate(heading => {
          const marker = getComputedStyle(heading, '::before');
          const content = heading.closest('.vditor-reset').getBoundingClientRect();
          return { content: marker.content, left: heading.getBoundingClientRect().left + parseFloat(marker.marginLeft) - content.left };
        });
        await f.page.screenshot({ path: `/tmp/nwpuoj-vditor-heading-${editorMode}-${width}.png`, fullPage: true });
        if (gutter.content !== 'none') assert.ok(gutter.left >= 4, `${editorMode} at ${width}px clips the heading marker: ${JSON.stringify(gutter)}`);
        assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      }
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.browser.close(); }
});

test('unsafe Markdown stays inert and ordinary users have no upload button', { timeout: 60000 }, async () => {
  const unsafe = '<img src="/missing.png" onerror="window.pwned=1">\n\n<script>window.pwned=2</script>\n\n[x](javascript:window.pwned=3)';
  const f = await fixture(`<form data-message-v2="new"><textarea name="content">${escape(unsafe)}</textarea></form>`);
  try {
    await ready(f.page);
    await mode(f.page, 'sv');
    await f.page.waitForSelector('.vditor-preview');
    assert.equal(await f.page.evaluate(() => window.pwned), undefined);
    assert.equal(await f.page.locator('.vditor-preview [onerror],.vditor-preview script,.vditor-preview [href^="javascript:"]').count(), 0);
    assert.equal(await f.page.locator('.app-vditor-host input[type="file"]').count(), 0);
    assert.equal(await f.page.locator('[data-type="image-library"]').count(), 0);
    assert.equal(await f.page.locator('textarea[name="content"]').inputValue(), unsafe);
    assert.deepEqual(f.errors, []);
  } finally { await f.browser.close(); }
});

test('image library searches, limits thumbnails, preserves insertion position, and closes outside or with Escape', { timeout: 60000 }, async () => {
  const assets = Array.from({length: 40}, (_, index) => ({ id: index + 1, original_name: index === 39 ? '<img onerror=alert(1)>.png' : `示意图-${index + 1}.png`, file_size: 1024 * (index + 1), url: `http://markdown.test/self/image-assets/${index + 1}.png` }));
  const f = await fixture(`<form data-problem-editor-v2><label class="app-field"><span class="app-label">题面 Markdown</span><textarea name="description" rows="30">${escape(sample)}</textarea></label></form>`, { upload: true, api: route => route.fulfill({ json: { data: assets } }) });
  try {
    await ready(f.page);
    await f.page.screenshot({ path: '/tmp/nwpuoj-vditor-refined-desktop.png', fullPage: true });
    await mode(f.page, 'sv');
    await f.page.locator('textarea.vditor-sv').fill('左边 右边');
    await f.page.locator('textarea.vditor-sv').evaluate(source => source.setSelectionRange(3, 3));
    await f.page.locator('[data-type="image-library"]').click();
    const dialog = f.page.getByRole('dialog', { name: '我的图床' });
    await dialog.locator('.app-image-library-item').first().waitFor();
    assert.equal(await dialog.locator('.app-image-library-item').count(), 18);
    assert.equal(await dialog.locator('img[loading="lazy"]').count(), 18);
    await dialog.getByRole('button', { name: '显示更多', exact: true }).click();
    assert.equal(await dialog.locator('.app-image-library-item').count(), 36);
    await dialog.getByRole('searchbox').fill('示意图-30');
    assert.equal(await dialog.locator('.app-image-library-item').count(), 1);
    await dialog.getByRole('button', { name: '插入 示意图-30.png', exact: true }).click();
    const saved = await f.page.locator('textarea[name="description"]').inputValue();
    assert.match(saved, /^左边 !\[示意图-30\.png\]\(http:\/\/markdown\.test\/self\/image-assets\/30\.png\)\n右边/);
    assert.equal(await dialog.count(), 0);
    await f.page.locator('[data-type="image-library"]').click();
    await dialog.getByRole('searchbox').fill('<img');
    await f.page.waitForFunction(() => document.querySelector('.app-image-library-message').textContent === '共 1 张图片');
    assert.equal(await dialog.locator('[onerror]').count(), 0);
    assert.equal(await dialog.locator('.app-image-library-item').textContent(), '<img onerror=alert(1)>.png40 KB');
    await dialog.getByRole('searchbox').fill('找不到的名称');
    assert.match(await dialog.getByRole('status').textContent(), /没有匹配/);
    await f.page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    await f.page.locator('[data-type="image-library"]').click();
    await dialog.locator('.app-image-library-item').first().waitFor();
    await f.page.screenshot({ path: '/tmp/nwpuoj-vditor-image-library.png', fullPage: true });
    await f.page.mouse.click(1, 1);
    assert.equal(await dialog.count(), 0);
    assert.equal(await f.page.locator('body').evaluate(body => body.classList.contains('is-dialog-open')), false);
    await f.page.setViewportSize({width:390,height:844});
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await f.page.locator('[data-type="image-library"]').click();
    await dialog.locator('.app-image-library-item').first().waitFor();
    assert.ok((await dialog.boundingBox()).width < 390);
    await f.page.screenshot({ path: '/tmp/nwpuoj-vditor-image-library-mobile.png', fullPage: true });
    assert.deepEqual(f.errors, []);
  } finally { await f.browser.close(); }
});

test('pending image uploads prevent incomplete saves and keep the selected insertion point', { timeout: 60000 }, async () => {
  let release;
  const waitForUpload = new Promise(resolve => { release = resolve; });
  const f = await fixture('<form data-problem-editor-v2><textarea name="description">前 后</textarea><button type="submit">保存</button></form><script>window.saved=null;document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();window.saved=new FormData(e.target).get("description")})</script>', { upload: true, api: async route => {
    await waitForUpload;
    return route.fulfill({ json: { data: { url: 'https://noj.nwpu.edu.cn/self/image-assets/test.png' } } });
  } });
  try {
    await ready(f.page);
    await mode(f.page, 'sv');
    await f.page.locator('textarea.vditor-sv').evaluate(source => source.setSelectionRange(2, 2));
    await f.page.locator('.app-vditor-host input[type="file"]').setInputFiles({ name: '上传中.png', mimeType: 'image/png', buffer: Buffer.from('fixture') });
    await f.page.waitForFunction(() => document.querySelector('.app-vditor-statusbar').classList.contains('is-uploading'));
    await f.page.getByRole('button', {name:'保存',exact:true}).click();
    assert.equal(await f.page.evaluate(() => saved), null);
    assert.ok(await f.page.evaluate(() => messages.some(message => message.includes('图片仍在上传'))));
    release();
    await f.page.waitForFunction(() => !document.querySelector('.app-vditor-statusbar').classList.contains('is-uploading'));
    await f.page.getByRole('button', {name:'保存',exact:true}).click();
    assert.match(await f.page.evaluate(() => saved), /^前 !\[上传中\.png\]\(https:\/\/noj\.nwpu\.edu\.cn\/self\/image-assets\/test\.png\)\n后/);
    assert.deepEqual(f.errors, []);
  } finally { release(); await f.browser.close(); }
});

test('asynchronous long content keeps split preview and rich edits batch serialization without stale saves', { timeout: 60000 }, async () => {
  const f = await fixture('<form data-problem-editor-v2><textarea name="description">初始短题面</textarea><button type="submit">保存</button></form><script>window.saved=null;document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();window.saved=new FormData(e.target).get("description")})</script>');
  try {
    await ready(f.page);
    assert.equal(await f.page.locator('textarea.vditor-sv').isVisible(), true);
    assert.equal(await f.page.locator('.vditor-preview').isVisible(), true);
    await f.page.locator('textarea[name="description"]').evaluate(source => { source.value = '长题面\n\n'.repeat(3000); });
    assert.equal(await f.page.evaluate(() => NWPUOJMarkdown.getEditor(document.querySelector('textarea[name="description"]')).getCurrentMode()), 'sv');
    assert.equal(await f.page.locator('.vditor-preview').isVisible(), true);
    assert.match(await f.page.locator('.app-vditor-statusbar').textContent(), /长文档/);
    await f.page.locator('textarea[name="description"]').evaluate(source => { source.value = '短题面'; });
    await mode(f.page, 'ir');
    await f.page.evaluate(() => {
      const source = document.querySelector('textarea[name="description"]'), editor = NWPUOJMarkdown.getEditor(source);
      window.reads = 0; const getValue = editor.getValue.bind(editor);
      editor.getValue = () => { reads++; return getValue(); };
      editor.focus();
    });
    await f.page.keyboard.press('Control+End');
    await f.page.keyboard.type('abcdefghijklmnopqrstuvwxyz', {delay:10});
    await f.page.getByRole('button', {name:'保存',exact:true}).click();
    assert.match(await f.page.evaluate(() => saved), /abcdefghijklmnopqrstuvwxyz/);
    assert.ok(await f.page.evaluate(() => reads < 10), 'rich mode no longer serializes once per key');
    await f.page.locator('textarea[name="description"]').evaluate(source => { source.value = '异步更新'; });
    assert.equal(await f.page.evaluate(() => NWPUOJMarkdown.getEditor(document.querySelector('textarea[name="description"]')).getCurrentMode()), 'ir', 'asynchronous updates preserve the manually selected mode');
    assert.deepEqual(f.errors, []);
  } finally { await f.browser.close(); }
});

test('pages without Markdown load no editor assets and load failures leave usable textareas', { timeout: 60000 }, async () => {
  const plain = await fixture('<form data-contest-notice-publish novalidate><textarea name="content" required></textarea><button type="submit">普通表单</button></form><script>document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();window.plainSaved=true})</script>');
  try {
    await plain.page.waitForLoadState('networkidle');
    assert.equal(plain.requests.some(x => x.includes('vditor-4')), false);
    assert.equal(await plain.page.locator('.app-vditor-host').count(), 0);
    await plain.page.getByRole('button', {name:'普通表单',exact:true}).click();
    assert.equal(await plain.page.evaluate(() => plainSaved), true, 'non-Markdown forms retain their own validation rules');
  } finally { await plain.browser.close(); }
  const failed = await fixture('<form data-ticket-v2="reply"><textarea name="content">原文</textarea></form>', { failAssets: true });
  try {
    await failed.page.waitForFunction(() => messages.length > 0);
    const source = failed.page.locator('textarea[name="content"]');
    await source.fill('依旧可以编辑');
    assert.equal(await source.evaluate(x => new FormData(x.form).get('content')), '依旧可以编辑');
    assert.deepEqual(failed.errors, []);
  } finally { await failed.browser.close(); }
});

test('all Markdown forms are upgraded but plain contest notices, IDs and code are excluded', { timeout: 60000 }, async () => {
  const forms = [
    ['data-problem-editor-v2', 'description'], ['data-contest-editor-v2', 'information'], ['data-problem-set-editor', 'description'],
    ['data-markdown-editor', 'content'], ['data-announcement-v2-edit', 'content'], ['data-site-notification-editor', 'content'],
    ['data-message-v2="new"', 'content'], ['data-message-v2="reply"', 'content'], ['data-ticket-v2="create"', 'description'],
    ['data-ticket-v2="reply"', 'content'], ['data-clipboard-v2="save"', 'content'],
    ['data-discussion-v2-reply', 'comment'], ['data-solution-v2-form="comment"', 'comment']
  ];
  const body = forms.map(([attribute, name], index) => `<form ${attribute}><label class="app-field"><span class="app-label">字段${index}</span><textarea id="field-${index}" name="${name}">原始内容${index}</textarea></label>${attribute === 'data-site-notification-editor' ? '<input type="checkbox" name="allow_markdown" checked>' : ''}</form>`).join('')
    + '<form data-contest-editor-v2><textarea name="subtitle">比赛简介</textarea></form>'
    + '<form data-contest-notice-publish><textarea name="content" id="plain-notice">不支持 Markdown 的赛时通知</textarea></form>'
    + '<form data-account-workflow-v2><textarea name="information" id="plain-signature">**纯文本签名**</textarea></form>'
    + '<textarea name="target_user_ids" id="plain-ids"></textarea><textarea name="code" id="plain-code"></textarea><textarea id="clipboard-raw-source" hidden>原文</textarea>';
  const f = await fixture(body);
  try {
    await f.page.waitForFunction(count => document.querySelectorAll('[data-vditor-ready="1"]').length === count, forms.length + 1);
    assert.equal(await f.page.locator('.app-vditor-host').count(), forms.length + 1);
    for (const id of ['plain-notice', 'plain-signature', 'plain-ids', 'plain-code', 'clipboard-raw-source']) assert.equal(await f.page.locator('#' + id).getAttribute('data-vditor-ready'), null);
    const readOnly = f.page.locator('#field-0');
    await readOnly.evaluate(source => { source.readOnly = true; source.value = '异步加载的最新题面\n\n' + '完整描述'; });
    await f.page.waitForFunction(() => document.querySelector('#field-0').nextElementSibling.getAttribute('aria-disabled') === 'true');
    assert.match(await f.page.evaluate(() => NWPUOJMarkdown.getEditor(document.querySelector('#field-0')).getValue()), /异步加载的最新题面/);
    await readOnly.evaluate(source => { source.readOnly = false; });
    await f.page.waitForFunction(() => document.querySelector('#field-0').nextElementSibling.getAttribute('aria-disabled') === 'false');
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.external, []);
  } finally { await f.browser.close(); }
});

for (const base of [false, true]) {
  test(`${base ? 'base' : 'ordinary'} real problem editor keeps split legacy sections and saves versioned Markdown`, { timeout: 60000 }, async () => {
    const problem = { id: 12, new: false, title: '原始标题', description: '旧题面', input_format: '输入', output_format: '输出', example: '样例', limit_and_hint: '提示', tags: [{ id: 7, name: '动态规划' }], allowedEdit: true, allowedManage: true };
    const writes = [];
    const f = await fixture(renderTemplate('problem_edit', { problem, baseContext: base, baseMember: base }), { api: async (route, request, url) => {
      if (request.method() === 'GET' && url.pathname.endsWith('/versions/9')) {
        // Ensure the asynchronous update happens after Vditor has attached.
        await new Promise(resolve => setTimeout(resolve, 750));
        return route.fulfill({ json: { data: { content: { title: '最新标题', description: '最新描述', input_format: '最新输入', output_format: '最新输出', example: '最新样例', limit_and_hint: '最新提示' } } } });
      }
      if (url.pathname.endsWith('/update')) writes.push({ body: request.postDataJSON(), headers: request.headers() });
      return route.fulfill({ json: { data: request.method() === 'GET' ? { id: 12, current_version_id: '9', visibility: 'public' } : { problem: { id: 12 }, version: { id: '10' } }, meta: { etag: '"fixture-version"' } } });
    } });
    try {
      await ready(f.page);
      await f.page.waitForFunction(() => !document.querySelector('#submit_button').disabled);
      const source = f.page.locator('textarea[name="description"]');
      for (const text of ['最新描述', '最新输入', '最新输出', '最新样例', '最新提示']) assert.match(await source.inputValue(), new RegExp(text));
      assert.match(await f.page.locator('textarea.vditor-sv').inputValue(), /最新输入/);
      await mode(f.page, 'sv');
      await f.page.locator('textarea.vditor-sv').fill(sample);
      await f.page.getByRole('button', { name: '保存题目', exact: true }).click();
      await f.page.waitForURL('**/problem/12?version=10');
      assert.equal(writes.length, 1);
      assert.equal(writes[0].body.description, sample);
      assert.equal(writes[0].body.title, '最新标题');
      assert.deepEqual(writes[0].body.tag_ids, [7]);
      assert.equal(writes[0].body.workspace, base ? 'base' : 'global');
      assert.equal(writes[0].body.if_match, '"fixture-version"');
      assert.equal(writes[0].headers['if-match'], '"fixture-version"');
      assert.equal(writes[0].headers['x-csrf-token'], 'fixture-csrf');
      assert.deepEqual(f.errors, []);
    } finally { await f.browser.close(); }
  });
}

for (const spec of [
  { view: 'admin_announcement_edit', data: { announcement: { id: 7, title: '公告', content: '旧正文', level: 'info', start_time: 1791158400, end_time: 1791244800, is_active: true } }, button: '保存公告', api: '/api/v2/admin/announcements/7', destination: '**/admin/announcements', method: 'PATCH' },
  { view: 'admin_notification_edit', data: { notification: { id: 7, title: '通知', content: '旧正文' }, notificationEtag: '"fixture-version"' }, button: '发布通知', api: '/api/v2/admin/notifications/7', destination: '**/admin/notifications', method: 'PATCH' },
  { view: 'admin_help_edit', data: { helpPage: { revision: 3, content: '帮助原文' } }, button: '发布帮助页', api: '/api/v2/admin/help/pages/main', destination: '**/admin/help?saved=1', method: 'PUT' },
  { view: 'clipboard_edit', data: { item: { id: 7, title: '剪贴板', content: '旧正文', visibility: 'private', share_expires: null } }, button: '保存内容', api: '/api/v2/clipboard/7', destination: '**/clipboard/7', method: 'PATCH' }
]) {
  test(`real ${spec.view} saves Vditor Markdown through existing external-compatible API`, { timeout: 60000 }, async () => {
    const writes = [];
    const f = await fixture(renderTemplate(spec.view, spec.data), { api: (route, request, url) => {
      if (request.method() !== 'GET') writes.push({ body: request.postDataJSON(), headers: request.headers(), path: url.pathname });
      return route.fulfill({ json: { data: { id: 7, html: '<p>帮助原文</p>' }, meta: { etag: '"fixture-version"' } } });
    } });
    f.page.on('dialog', dialog => dialog.accept());
    try {
      await ready(f.page);
      await mode(f.page, 'sv');
      await f.page.locator('textarea.vditor-sv').fill(sample);
      await f.page.getByRole('button', { name: spec.button, exact: true }).click();
      await f.page.waitForURL(spec.destination);
      const save = writes.find(item => item.path === spec.api);
      assert.ok(save, JSON.stringify(writes));
      assert.equal(save.body.content, sample);
      assert.equal(save.body.if_match, '"fixture-version"');
      assert.equal(save.headers['if-match'], '"fixture-version"');
      assert.equal(save.headers['x-csrf-token'], 'fixture-csrf');
      assert.equal(save.headers['x-http-method-override'], spec.method);
      if (spec.view === 'admin_notification_edit') {
        assert.equal(save.body.allow_markdown, true);
        assert.ok(writes.some(item => item.path.endsWith('/publish')));
      }
      assert.deepEqual(f.errors, []);
    } finally { await f.browser.close(); }
  });
}
