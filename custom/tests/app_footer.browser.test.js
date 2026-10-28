'use strict';
// Anonymous, read-only smoke test of the shared footer. Opt in explicitly.
const test = require('node:test');
const assert = require('node:assert/strict');

test('site footer links and text appear across pages and clear mobile navigation', {
  skip: process.env.NWPUOJ_FOOTER_LIVE_TEST !== '1', timeout: 45000
}, async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const origin = process.env.NWPUOJ_FOOTER_LIVE_ORIGIN || 'http://127.0.0.1';
    for (const path of ['/', '/login', '/problems', '/contests', '/help', '/weekly-ranklist']) {
      const response = await page.goto(origin + path);
      assert.equal(response.status(), 200, path);
      const footer = page.locator('.app-footer');
      assert.equal(await footer.count(), 1, path);
      assert.equal(await footer.isVisible(), true, path);
      assert.equal(await footer.getByRole('link', { name: '陕ICP备05010979号' }).getAttribute('href'), 'https://beian.miit.gov.cn/');
      assert.equal(await footer.getByRole('link', { name: 'npuicpc@163.com' }).getAttribute('href'), 'mailto:npuicpc@163.com');
      assert.ok((await footer.textContent()).includes('版权所有 © 西北工业大学程序设计创新实践基地'));
    }
    await page.locator('[data-weekly-summary]').filter({ hasText: '位成员' }).waitFor();
    await page.locator('.app-footer').scrollIntoViewIfNeeded();
    assert.ok(await page.locator('.app-footer').evaluate(footer => {
      const centers = [...footer.querySelector('.app-footer-meta').children, footer.querySelector('.app-footer-source')]
        .map(node => { const rect = node.getBoundingClientRect(); return rect.top + rect.height / 2; });
      return Math.max(...centers) - Math.min(...centers) < 2;
    }), 'desktop footer uses a single aligned row');
    await page.screenshot({ path: '/tmp/nwpuoj-footer-desktop.png', animations: 'disabled' });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
      await page.screenshot({ path: '/tmp/nwpuoj-footer-mobile-' + width + '.png', animations: 'disabled' });
      assert.equal(await page.locator('.app-footer').isVisible(), true);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.equal(await page.locator('.app-footer-meta').isVisible(), true);
      assert.ok(await page.locator('.app-footer').evaluate(footer => {
        const centers = [...footer.querySelector('.app-footer-meta').children]
          .map(node => { const rect = node.getBoundingClientRect(); return rect.top + rect.height / 2; });
        return Math.max(...centers) - Math.min(...centers) < 2 && footer.scrollWidth > footer.clientWidth;
      }), 'mobile footer stays in one horizontally scrollable row');
      assert.ok(await page.evaluate(() => {
        const source = document.querySelector('.app-footer-source').getBoundingClientRect();
        const nav = document.querySelector('.app-mobile-nav').getBoundingClientRect();
        return source.bottom <= nav.top && source.top >= 0;
      }), 'footer remains above fixed mobile navigation');
    }
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); }
});
