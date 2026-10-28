'use strict';

// Opt-in, read-only checks against a running OJ; never creates fixture users or problems.
const assert = require('node:assert/strict');
const test = require('node:test');
const { buildCatalog } = require('../imports/algorithm-tags/seed');

test('live algorithm catalog is complete, searchable, paginated and usable on desktop/mobile', {
  skip: !process.env.NWPUOJ_WEB_URL, timeout: 300000
}, async () => {
  const { chromium } = require('playwright');
  const launch = { headless: true, args: ['--no-sandbox'] };
  if (process.env.NWPUOJ_CHROMIUM) launch.executablePath = process.env.NWPUOJ_CHROMIUM;
  const browser = await chromium.launch(launch);
  try {
    const context = await browser.newContext({ baseURL: process.env.NWPUOJ_WEB_URL });
    const page = await context.newPage(), errors = [], catalog = buildCatalog();
    async function read(url) {
      // Do not bypass or disable the site's shared per-IP protection.
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 450));
        const response = await context.request.get(url);
        if (response.status() !== 429) return response;
        const retryAfter = Number(response.headers()['retry-after'] || 60);
        assert.ok(Number.isFinite(retryAfter) && retryAfter <= 120, 'Unexpected rate-limit wait');
        await new Promise(resolve => setTimeout(resolve, Math.max(1, retryAfter) * 1000));
      }
      throw new Error('Read-only verification is still rate-limited');
    }
    page.on('pageerror', error => errors.push(error.message));
    const response = await page.goto('/tags', { waitUntil: 'networkidle' });
    assert.equal(response.status(), 200);
    const links = page.locator('.app-tag-cloud a');
    const visibleNames = await links.locator('span').allTextContents();
    for (const tag of catalog) assert.ok(visibleNames.includes(tag.name), 'Directory: ' + tag.name);
    assert.equal(new Set(visibleNames).size, visibleNames.length, 'No duplicate names in directory');
    for (const [title, expected] of [['算法大类', 22], ['算法细目', 240]]) {
      const section = page.locator('.app-tag-directory > section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      assert.equal(await section.locator('.app-tag-cloud a').count(), expected);
    }
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), 'No horizontal overflow at ' + viewport.width);
    }
    // Exercise the real search endpoint for every full name, including spaces,
    // accents, mathematical punctuation and KTT's slash.
    for (const tag of catalog) {
      const response = await read('/api/v2/search/tags/' + encodeURIComponent(tag.name));
      assert.equal(response.status(), 200, tag.name);
      const payload = await response.json();
      assert.ok(payload.data.some(item => item.name === tag.name), 'Search: ' + tag.name);
    }
    const all = [], cursors = new Set();
    let cursor;
    do {
      const query = new URLSearchParams({ limit: '100' });
      if (cursor) query.set('cursor', cursor);
      const response = await read('/api/v2/tags?' + query);
      assert.equal(response.status(), 200);
      const payload = await response.json();
      all.push(...payload.data);
      cursor = payload.meta.next_cursor;
      if (cursor) { assert.ok(!cursors.has(cursor)); cursors.add(cursor); }
    } while (cursor);
    assert.equal(new Set(all.map(tag => tag.id)).size, all.length, 'No duplicate IDs across pages');
    assert.equal(all.length, visibleNames.length, 'API pagination covers the whole directory');
    for (const tag of catalog) assert.ok(all.some(item => item.name === tag.name), 'API: ' + tag.name);
    const chosen = all.find(tag => tag.name === '线段树');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await links.filter({ has: page.locator('span').filter({ hasText: /^线段树$/ }) }).click();
    await page.waitForURL('**/problems/tag/' + chosen.id);
    assert.ok(!(await page.locator('body').innerText()).includes('QueryFailedError'));
    assert.ok(await page.locator('[data-app-shell]').count());
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
