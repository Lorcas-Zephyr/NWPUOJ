'use strict';

// Fixtures use the production statement template, shared script and styles.
// They never create accounts/problems or send writes to the running OJ.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const samples = ['  1  2\n\t3 4\n\n', '#include <cstdio>\nint main() {\n\tputs("中文 & <tag>");  \n}\n', 'x'.repeat(400) + '\n', ''];

function renderStatement(context = 'problem') {
  const template = read('views/problem.ejs').match(/<article class="app-problem-content[\s\S]*?<\/article>/)[0];
  const description = '<p>行内代码 <code>inline()</code></p>' + samples.map((value, index) =>
    '<div class="ui existing segment"><pre style="margin-top:0;margin-bottom:0">' +
    (index === 2 ? escape(value) : '<code><span class="hl-text hl-plain">' + escape(value) + '</span></code>') + '</pre></div>').join('');
  const data = { contest: context.includes('contest') ? { id: 1 } : null, problemSet: context === 'problem-set' ? { id: 1 } : null,
    problem: { description, input_format: '', output_format: '', example: '', limit_and_hint: '', tags: [] } };
  const script = 'const fs=require("fs"),ejs=require("/app/node_modules/ejs");const x=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(ejs.render(x.template,x.data));';
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], {
    cwd: path.join(root, '..'), input: JSON.stringify({ template, data }), encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function fixture(browser, options = {}) {
  const page = await browser.newPage({ viewport: options.viewport || { width: 1360, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(mode => {
    window.copies = [];
    document.execCommand = command => {
      if (mode !== 'legacy' || command !== 'copy') return false;
      window.copies.push(document.activeElement.value); return true;
    };
    if (mode !== 'real') Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'legacy' ? undefined : {
      writeText: async text => { if (mode === 'failure') throw new Error('Denied'); window.copies.push(text); }
    } });
  }, options.mode || 'legacy');
  const body = renderStatement(options.context);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    assert.equal(route.request().method(), 'GET');
    if (url.pathname.startsWith('/self/')) {
      const file = path.basename(url.pathname);
      return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'application/javascript', body: read(file) });
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      ['app-shell', 'app-shared', 'app-features'].map(name => '<link rel="stylesheet" href="/self/' + name + '.css">').join('') +
      '</head><body class="app-v2"><main class="app-main"><div class="app-page app-problem-page">' + body +
      '<div class="app-markdown" id="outside"><pre><code>outside</code></pre></div><textarea id="existing-copy">existing share URL</textarea><button data-copy="#existing-copy">复制链接</button>' +
      '</div></main><div data-toast-region></div><script src="/self/lucide-1.27.0.min.js"></script><script src="/self/app-v2.js"></script></body></html>' });
  });
  await page.goto((options.mode === 'real' ? 'https' : 'http') + '://statement.test/');
  return { page, errors };
}

for (const context of ['problem', 'contest', 'problem-set', 'base', 'base-contest']) {
  test(context + ': every statement code block copies exact plain text over HTTP', async () => {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    try {
      const { page, errors } = await fixture(browser, { context });
      const buttons = page.locator('.app-statement-code-copy');
      assert.equal(await buttons.count(), samples.length);
      assert.equal(await page.locator('#outside .app-statement-code-copy').count(), 0);
      assert.equal(await page.locator('.app-problem-statement p .app-statement-code-copy').count(), 0);
      assert.deepEqual(await page.locator('.app-statement-code-block > pre').allTextContents(), samples);
      for (let index = 0; index < samples.length; index++) {
        await buttons.nth(index).click();
        assert.equal(await buttons.nth(index).innerText(), '已复制');
        assert.equal(await buttons.nth(index).getAttribute('aria-label'), '已复制');
      }
      assert.deepEqual(await page.evaluate(() => window.copies), samples);
      await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-copy-label]')).every(label => label.textContent === '复制'));
      await buttons.first().focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => window.copies.at(-1)), samples[0]);
      await page.locator('[data-copy="#existing-copy"]').click();
      assert.equal(await page.evaluate(() => window.copies.at(-1)), 'existing share URL');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}

test('modern Clipboard API fallback and permission failures show truthful feedback', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    for (const mode of ['modern', 'failure']) {
      const { page, errors } = await fixture(browser, { mode });
      const button = page.locator('.app-statement-code-copy').first();
      await button.click();
      if (mode === 'modern') {
        assert.deepEqual(await page.evaluate(() => window.copies), [samples[0]]);
        assert.equal(await button.innerText(), '已复制');
      } else {
        assert.equal(await button.innerText(), '复制失败');
        assert.equal(await page.locator('[role="alert"]').innerText(), '复制失败，请手动选择内容');
        assert.equal(await button.evaluate(node => node.classList.contains('is-copied')), false);
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('HTTPS copies into the real browser clipboard', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const { page, errors } = await fixture(browser, { mode: 'real' });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.locator('.app-statement-code-copy').nth(1).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), samples[1]);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('mobile and dark mode keep the floating copy button in place without a toolbar row', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const { page, errors } = await fixture(browser, { viewport: { width: 390, height: 844 } });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => window.NWPUOJApp.setTheme(theme), theme);
      const block = page.locator('.app-statement-code-block').nth(2);
      await block.scrollIntoViewIfNeeded();
      const pre = block.locator('pre'), button = block.locator('button');
      const before = await button.boundingBox();
      assert.ok(before.x >= 0 && before.x + before.width <= 390);
      assert.ok(before.height >= 32);
      assert.ok(await pre.evaluate(node => node.scrollWidth > node.clientWidth));
      await pre.evaluate(node => { node.scrollLeft = 500; });
      assert.deepEqual(await button.boundingBox(), before);
      const codeBox = await pre.boundingBox();
      const blockBox = await block.boundingBox();
      assert.ok(before.y >= codeBox.y && before.y + before.height <= codeBox.y + codeBox.height, 'button floats inside the code block');
      assert.ok(Math.abs(codeBox.y - blockBox.y - 1) < 1, 'no toolbar row above code');
      assert.ok(Math.abs(blockBox.height - codeBox.height - 2) < 1, 'button does not increase code block height');
      assert.equal(await block.locator('.app-statement-code-toolbar').evaluate(node => getComputedStyle(node).position), 'absolute');
      await button.click();
      assert.equal(await page.evaluate(() => window.copies.at(-1)), samples[2]);
    }
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('.app-statement-code-toolbar').first().isVisible(), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
