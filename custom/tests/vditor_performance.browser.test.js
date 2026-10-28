'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const section = '## 题目说明\n\n' + '给定序列，求满足条件的方案数。'.repeat(22) + '\n\n公式：$a_i^2+b_i^2=c_i^2$\n\n| 数据范围 | 分数 |\n| --- | --- |\n| 100 | 10 |\n| 100 | 10 |\n\n```cpp\nint main() { return 0; }\n```\n\n';

test('long Markdown avoids a whole-document conversion on every keystroke', { timeout: 90000 }, async t => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const content = section.repeat(42);
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/self/')) {
        const file = path.join(root, url.pathname.replace(/^\/self\/lib\//, 'static-libs/').replace(/^\/self\//, ''));
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
      }
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><meta charset="utf-8"><form data-problem-editor-v2><textarea name="description">' + escape(content) + '</textarea><button type="submit">保存</button></form><script>document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();window.saved=new FormData(e.target).get("description")})</script><script src="/self/lib/noj-markdown.js"></script></html>' });
    });
    await page.goto('http://performance.test/');
    await page.waitForSelector('[data-vditor-ready="1"]', { state: 'attached' });
    assert.equal(await page.locator('textarea.vditor-sv').isVisible(), true);
    assert.equal(await page.locator('.vditor-preview').isVisible(), true);
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const source = document.querySelector('textarea[name="description"]');
      const editor = NWPUOJMarkdown.getEditor(source), original = editor.getValue.bind(editor);
      window.measurements = { reads: 0, readMs: 0, inputEvents: 0, characters: source.value.length, mode: editor.getCurrentMode() };
      editor.getValue = function () { const start = performance.now(); const value = original(); measurements.reads++; measurements.readMs += performance.now() - start; return value; };
      document.querySelector('.app-vditor-host').addEventListener('input', () => measurements.inputEvents++);
      editor.focus();
    });
    await page.keyboard.press('Control+End');
    await page.keyboard.type('performance-test-abcdefghijklmnopqrstuvwxyz', { delay: 10 });
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const metrics = await page.evaluate(() => ({ ...measurements, readMs: Math.round(measurements.readMs * 100) / 100, saved: saved.includes('performance-test-abcdefghijklmnopqrstuvwxyz') }));
    t.diagnostic(JSON.stringify(metrics));
    assert.equal(metrics.saved, true);
    if (process.env.NOJ_EDITOR_BASELINE !== '1') {
      assert.equal(metrics.mode, 'sv');
      assert.ok(metrics.reads <= 5, `unnecessary full reads: ${metrics.reads}`);
    }
  } finally { await browser.close(); }
});
