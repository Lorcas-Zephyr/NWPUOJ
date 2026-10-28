'use strict';
// All browser requests are intercepted. No real accounts, emails, or production
// policy rows are created. EJS is rendered read-only with the installed runtime.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const MarkdownIt = require('markdown-it');
const legalLib = require('../libs/legal-documents');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const service = legalLib.createLegalService();
const html = new Map();
let browser;

async function documentLocals(slug) {
  let handler, locals;
  vm.runInNewContext(read('modules/_legal_documents.js'), {
    require: () => ({ ...legalLib, createLegalService: () => service }),
    app: { get: (route, fn) => { handler = fn; } },
    syzoj: { utils: { markdown: async text => new MarkdownIt({ html: false }).render(text) }, log: message => { throw new Error(message); } },
    ErrorMessage: Error
  });
  await handler({ params: { slug }, query: {} }, {
    setHeader: () => {}, render: (name, values) => { assert.equal(name, 'legal'); locals = values; }
  }, () => { throw new Error('document route not handled'); });
  return locals;
}

function render(template, locals, pathname) {
  const header = read('views/app_header.ejs').replace('<% include util %>', '');
  const footer = read('views/app_footer.ejs').replace('<% include contest_notice_client %>', '');
  const source = read('views/' + template + '.ejs').replace('<% include app_header %>', header).replace('<% include app_footer %>', footer);
  const script = `const fs=require('fs'),ejs=require('ejs'); const x=JSON.parse(fs.readFileSync(0,'utf8'));
    const values={...x.locals,title:x.locals.legalDocument?x.locals.legalDocument.title:'注册',active:'legal',user:null,csrfToken:'fixture-csrf',
      req:{path:x.pathname,originalUrl:x.pathname,query:{}},serializejs:JSON.stringify,selfLib:p=>'/self/lib/'+p,
      syzoj:{config:{title:'NWPUOJ',nwpuoj_version:'2.1.0'},utils:{legalDocuments:{},
        makeUrl:(p,q)=>'/'+p.join('/')+(q?'?'+new URLSearchParams(q):'')}}};
    process.stdout.write(ejs.render(x.source,values));`;
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], {
    cwd: path.join(root, '..'), input: JSON.stringify({ source, locals, pathname }), encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test.before(async () => {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  for (const item of legalLib.DOCUMENTS) {
    const locals = await documentLocals(item.slug);
    html.set('/legal/' + item.slug, render('legal', locals, '/legal/' + item.slug));
    html.set('/admin-legal/' + item.slug, render('legal', { ...locals, legalCanEdit: true }, '/legal/' + item.slug));
    html.set('/legal/' + item.slug + '/edit', render('legal_edit', {
      legalPage: { ...item, content: locals.legalDocument.markdown, version: service.bundle.manifest.version }, legalEtag: '"fixture-etag"'
    }, '/legal/' + item.slug + '/edit'));
  }
  const locals = { registrationValues: {}, registrationErrorInfo: null, registrationNotice: null, registrationCsrfToken: 'fixture', registrationPrevUrl: '/', colleges: ['计算机学院'] };
  html.set('/sign_up', render('sign_up', { ...locals, registrationLegal: { ...service.registrationPolicy(), enabled: true } }, '/sign_up'));
  html.set('/legal/registration-preview', render('sign_up', { ...locals, registrationLegal: { ...service.registrationPolicy(), enabled: true, preview: true } }, '/legal/registration-preview'));
  html.set('/draft-sign-up', render('sign_up', { ...locals, registrationLegal: { ...service.registrationPolicy(), enabled: false } }, '/sign_up'));
});
test.after(async () => { if (browser) await browser.close(); });

async function fixture() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const writes = [], writeHeaders = [], errors = [];
  let result = { status: 422, json: { error: { message: '测试接口：未创建账户。' } } };
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, 'http://legal.test', 'no network traffic may reach the real OJ');
    if (url.pathname === '/api/v2/auth/register' || url.pathname.startsWith('/api/v2/admin/legal/')) {
      writes.push(route.request().postDataJSON());
      writeHeaders.push({ method: route.request().method(), ...route.request().headers() });
      if (result.abort) return route.abort();
      return route.fulfill(result);
    }
    if (url.pathname.startsWith('/self/')) {
      let relative = url.pathname.slice(6);
      if (relative.startsWith('lib/')) relative = 'static-libs/' + relative.slice(4);
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404 });
      return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : 'image/png', body: fs.readFileSync(file) });
    }
    if (html.has(url.pathname)) return route.fulfill({ contentType: 'text/html', body: html.get(url.pathname) });
    return route.fulfill({ contentType: 'text/html', body: '<h1>注册完成（模拟）</h1>' });
  });
  return { page, context, writes, writeHeaders, errors, result: value => { result = value; } };
}

test('four administrator edit buttons open the matching full-width Vditor editor; public readers see none', { timeout: 60000 }, async () => {
  const f = await fixture(), page = f.page;
  try {
    for (const item of legalLib.DOCUMENTS) {
      await page.goto('http://legal.test/legal/' + item.slug);
      assert.equal(await page.getByRole('link', { name: '编辑', exact: true }).count(), 0);
      await page.goto('http://legal.test/admin-legal/' + item.slug);
      await page.getByRole('link', { name: '编辑', exact: true }).click();
      await page.waitForURL('http://legal.test/legal/' + item.slug + '/edit');
      await page.waitForFunction(() => document.querySelector('textarea[name="content"]').dataset.vditorReady === '1');
      assert.equal(await page.locator('h1').innerText(), '编辑' + item.title);
      assert.equal(await page.locator('textarea.vditor-sv').isVisible(), true);
      assert.equal(await page.locator('.vditor-preview').isVisible(), true);
      await page.waitForFunction(() => document.querySelector('.vditor-preview').innerText.trim().length > 20, null, { timeout: 8000 });
      assert.equal(await page.locator('textarea[name="content"]').inputValue(), service.bundle.documents.find(doc => doc.slug === item.slug).markdown);
      assert.ok(await page.locator('.app-vditor-host').evaluate(node => node.getBoundingClientRect().width > 750));
    }
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({ path: '/tmp/nwpuoj-legal-editor-desktop.png', animations: 'disabled' });
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('editor saves current text with gateway-safe version and CSRF, retains failed edits, and returns to正文', { timeout: 45000 }, async () => {
  const f = await fixture(), page = f.page;
  try {
    await page.goto('http://legal.test/legal/terms/edit');
    await page.waitForFunction(() => document.querySelector('textarea[name="content"]').dataset.vditorReady === '1');
    const content = '## 仅隔离测试\n\n新正文，不会发送到真实 OJ。';
    await page.locator('textarea.vditor-sv').fill(content);
    f.result({ status: 412, json: { error: { message: '协议已被其他管理员更新。' } } });
    await page.getByRole('button', { name: '保存并发布' }).click();
    await page.waitForFunction(() => !document.querySelector('[type="submit"]').disabled);
    assert.match(await page.locator('[data-legal-edit-error]').innerText(), /其他管理员/);
    assert.equal((await page.locator('textarea[name="content"]').inputValue()).trim(), content);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].content.trim(), content);
    assert.equal(f.writes[0].if_match, '"fixture-etag"');
    assert.equal(f.writeHeaders[0]['if-match'], '"fixture-etag"');
    assert.equal(f.writeHeaders[0]['x-csrf-token'], 'fixture-csrf');
    assert.equal(f.writeHeaders[0]['x-http-method-override'], 'PATCH');
    assert.equal(f.writeHeaders[0].method, 'POST');
    assert.ok(f.writeHeaders[0]['idempotency-key']);
    f.result({ abort: true });
    await page.getByRole('button', { name: '保存并发布' }).click();
    await page.waitForFunction(() => !document.querySelector('[type="submit"]').disabled);
    assert.match(await page.locator('[data-legal-edit-status]').innerText(), /内容已保留/);
    assert.equal((await page.locator('textarea[name="content"]').inputValue()).trim(), content);
    f.result({ status: 200, json: { data: {}, meta: { etag: '"saved-etag"' } } });
    await page.getByRole('button', { name: '保存并发布' }).click();
    await page.waitForURL('http://legal.test/legal/terms');
    assert.equal(f.writes.length, 3);
    assert.notEqual(f.writeHeaders[0]['idempotency-key'], f.writeHeaders[2]['idempotency-key']);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

async function fillAccount(page) {
  await page.locator('[name="username"]').fill('review_only');
  await page.locator('[name="student_id"]').fill('2026000000');
  await page.locator('[name="real_name"]').fill('审核示例');
  await page.locator('[name="college"]').selectOption('计算机学院');
  await page.locator('[name="email"]').fill('review@example.invalid');
  await page.locator('[name="password"]').fill('preview-only-123');
  await page.locator('[name="confirm_password"]').fill('preview-only-123');
}

test('signup is opt-in, readable without losing the form, and posts only explicit confirmations', { timeout: 45000 }, async () => {
  const f = await fixture(), page = f.page;
  try {
    await page.goto('http://legal.test/sign_up');
    assert.equal(await page.locator('#registration-terms').isChecked(), false);
    assert.equal(await page.locator('#sign-up-form input[type="checkbox"]').count(), 1);
    assert.equal(await page.locator('#registration-age').count(), 0);
    await fillAccount(page);
    await page.getByRole('button', { name: '注册', exact: true }).click();
    assert.equal(f.writes.length, 0);
    assert.match(await page.locator('#sign-up-v2-error').innerText(), /阅读/);
    const popupPromise = f.context.waitForEvent('page');
    await page.locator('.app-registration-confirmation').getByRole('link', { name: '《用户协议》', exact: true }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(await popup.locator('h1').innerText(), '用户协议');
    assert.equal(await page.locator('[name="username"]').inputValue(), 'review_only');
    assert.equal(await page.locator('#registration-terms').isChecked(), false);
    await popup.close();
    await page.locator('#registration-terms').check();
    const privacyPromise = f.context.waitForEvent('page');
    await page.locator('.app-registration-confirmation').getByRole('link', { name: '《隐私政策》', exact: true }).click();
    const privacy = await privacyPromise;
    await privacy.waitForLoadState();
    assert.equal(await privacy.locator('h1').innerText(), '隐私政策');
    assert.equal(await page.locator('#registration-terms').isChecked(), true, 'opening an inline link must not toggle acknowledgement');
    await privacy.close();
    await page.getByRole('button', { name: '注册', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[type="submit"]').disabled);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].terms_accepted, true);
    assert.equal(f.writes[0].privacy_acknowledged, true);
    assert.equal(Object.prototype.hasOwnProperty.call(f.writes[0], 'age_confirmed'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(f.writes[0], 'guardian_consent'), false);
    assert.equal(f.writes[0].legal_version, service.bundle.revision);
    assert.equal(await page.locator('#registration-terms').isChecked(), true);
    f.result({ json: { data: { redirect_url: '/email/verification-pending?sent=1' } } });
    await page.getByRole('button', { name: '注册', exact: true }).click();
    await page.waitForURL('**/email/verification-pending?sent=1');
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('review signup never sends data and draft mode does not impose unapproved agreement', { timeout: 30000 }, async () => {
  const f = await fixture(), page = f.page;
  try {
    await page.goto('http://legal.test/legal/registration-preview');
    await fillAccount(page);
    await page.locator('#registration-terms').check();
    await page.getByRole('button', { name: '验证预览表单' }).click();
    assert.match(await page.locator('#sign-up-v2-error').innerText(), /未发送资料/);
    assert.equal(f.writes.length, 0);
    await page.goto('http://legal.test/draft-sign-up');
    assert.equal(await page.locator('#registration-terms').count(), 0);
    assert.equal(await page.locator('#registration-age').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('four pages, embedded inventories, anchors and single-row footer render across themes and viewport sizes', { timeout: 60000 }, async () => {
  const f = await fixture(), page = f.page;
  try {
    for (const item of legalLib.DOCUMENTS) {
      await page.goto('http://legal.test/legal/' + item.slug);
      assert.equal(await page.locator('h1').innerText(), item.title);
      assert.equal(await page.locator('.app-legal-review').count(), 0);
      assert.match(await page.locator('.app-page-description').innerText(), /生效日期：2026-10-16/);
      assert.equal(await page.locator('.app-legal-nav a[aria-current="page"]').innerText(), item.title);
      assert.equal(await page.locator('.app-footer-legal a').count(), 4);
      const anchors = await page.locator('.app-help-toc a').evaluateAll(links => links.map(link => link.hash));
      for (const anchor of anchors) assert.equal(await page.locator(anchor).count(), 1);
    }
    await page.goto('http://legal.test/legal/privacy');
    assert.equal(await page.locator('.app-legal-table').count(), 2);
    assert.equal(await page.locator('.app-legal-table [rowspan], .app-legal-table [colspan]').count(), 0);
    await page.screenshot({ path: '/tmp/nwpuoj-legal-privacy-desktop.png', animations: 'disabled' });
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal page overflow at ' + width);
        assert.ok(await page.locator('.app-footer').evaluate(footer => {
          const rects = [...footer.querySelector('.app-footer-meta').children].map(node => node.getBoundingClientRect());
          const centers = rects.map(rect => rect.top + rect.height / 2);
          return Math.max(...centers) - Math.min(...centers) < 2;
        }), 'footer remains one aligned scrollable row');
      }
    }
    await page.screenshot({ path: '/tmp/nwpuoj-legal-privacy-mobile.png', animations: 'disabled' });
    await page.goto('http://legal.test/legal/registration-preview');
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1100 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      if (width === 1440) assert.ok(await page.evaluate(() => {
        const field = name => document.querySelector('[name="' + name + '"]').getBoundingClientRect().top;
        return Math.abs(field('username') - field('student_id')) < 2 && Math.abs(field('password') - field('confirm_password')) < 2;
      }), 'help text does not shift adjacent registration inputs');
      await page.locator('#registration-terms').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('#registration-terms').isVisible(), true);
      assert.ok(await page.locator('#registration-terms').evaluate(input => input.getBoundingClientRect().width >= 18));
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.screenshot({ path: '/tmp/nwpuoj-legal-registration-desktop.png', fullPage: true, animations: 'disabled' });
    await page.locator('.app-auth-panel').screenshot({ path: '/tmp/nwpuoj-legal-registration-panel.png', animations: 'disabled' });
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('export self-contained, non-submitting pages for review when requested', async () => {
  const directory = process.env.NWPUOJ_LEGAL_PREVIEW_OUTPUT;
  if (!directory) return;
  assert.ok(path.isAbsolute(directory));
  fs.mkdirSync(directory, { recursive: true });
  const files = { '/legal/terms': 'index.html', '/legal/privacy': 'privacy.html', '/legal/competition': 'competition.html', '/legal/copyright': 'copyright.html', '/legal/registration-preview': 'registration.html' };
  const css = ['app-shell.css', 'app-shared.css', 'app-features.css'].map(read).join('\n');
  for (const [pathname, filename] of Object.entries(files)) {
    let source = html.get(pathname)
      .replace(/<link\b[^>]*>/g, '')
      .replace(/<script\b[^>]*src=[^>]*>[\s\S]*?<\/script>/g, '')
      .replace('</head>', '<style>' + css + '</style></head>')
      .replace(/src="\/self\/logo\.png[^\"]*"/g, 'src="data:image/png;base64,' + fs.readFileSync(path.join(root, 'logo.png')).toString('base64') + '"');
    source = source.replace(/href="(\/[^\"]*)"/g, (whole, target) => {
      const pathname = target.split('?')[0];
      return files[pathname] ? 'href="' + files[pathname] + '"' : pathname === '/sign_up' ? 'href="registration.html"' : 'href="#"';
    });
    // No remote scripts or form action are present in these review files.
    source = source.replace('</head>', '<script>window.fetch=function(){return Promise.reject(new Error("离线审核，不发送请求"));};</script></head>');
    fs.writeFileSync(path.join(directory, filename), source);
  }
  const page = await browser.newPage(), errors = [], network = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/^https?:\/\//, route => { network.push(route.request().url()); return route.abort(); });
  try {
    await page.goto(pathToFileURL(path.join(directory, 'index.html')).href);
    assert.equal(await page.locator('h1').innerText(), '用户协议');
    await page.locator('.app-legal-nav').getByRole('link', { name: '隐私政策' }).click();
    assert.equal(await page.locator('.app-legal-table').count(), 2);
    await page.getByRole('link', { name: '注册', exact: true }).click();
    await fillAccount(page);
    await page.locator('#registration-terms').check();
    await page.getByRole('button', { name: '验证预览表单' }).click();
    assert.match(await page.locator('#sign-up-v2-error').innerText(), /未创建账户/);
    assert.deepEqual(errors, []);
    assert.deepEqual(network, []);
  } finally { await page.close(); }
});
