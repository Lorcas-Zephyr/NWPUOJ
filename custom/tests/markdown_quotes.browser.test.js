'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');

test('complete Markdown utility renders four quoted lines visibly in both themes and on mobile', { timeout: 30000 }, async () => {
  // Use the real utility as well as the worker: the upstream utility converts
  // blockquote tags into legacy Semantic UI messages after Markdown rendering.
  const script = `
    global.syzoj={config:{renderer_cache_size:20}};
    const utils=require('/app/utility');
    const source='## 题目背景\\n> 引用第一行\\n> 引用第二行\\n> 引用第三行\\n> 引用第四行';
    Promise.all([utils.markdown(source),utils.markdown(source,null,true)])
      .then(html=>{console.log(JSON.stringify(html));process.exit(0);})
      .catch(error=>{console.error(error);process.exit(1);});
  `;
  const rendered = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script],
    { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.equal(rendered.status, 0, rendered.stderr);
  const [legacy, semantic] = JSON.parse(rendered.stdout);
  assert.match(legacy, /class="ui message"/);
  assert.match(semantic, /<blockquote>/);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<body><main style="padding:16px"><section class="app-markdown">' + legacy + semantic + '</section></main></body></html>');
    for (const name of ['app-shell.css', 'app-shared.css', 'app-features.css']) {
      await page.addStyleTag({ content: fs.readFileSync(path.join(root, 'custom', name), 'utf8') });
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const selector of ['.app-markdown .ui.message', '.app-markdown blockquote']) {
          const state = await page.locator(selector).evaluate(el => {
            const range = document.createRange();
            range.selectNodeContents(el.querySelector('p'));
            const css = getComputedStyle(el);
            return {
              lines: new Set(Array.from(range.getClientRects()).filter(rect => rect.width > 0).map(rect => Math.round(rect.y))).size,
              border: css.borderLeftWidth,
              borderStyle: css.borderLeftStyle,
              background: css.backgroundColor,
              overflow: document.documentElement.scrollWidth > innerWidth
            };
          });
          assert.equal(state.lines, 4, `${theme}/${width}/${selector}`);
          assert.ok(parseFloat(state.border) > 0);
          assert.equal(state.borderStyle, 'solid');
          assert.notEqual(state.background, 'rgba(0, 0, 0, 0)');
          assert.equal(state.overflow, false);
        }
      }
    }
  } finally {
    await browser.close();
  }
});
