'use strict';
// Opt-in, read-only smoke check of the deployed app. Never authenticates,
// creates users/contests, or changes the real weekly roster.
const test = require('node:test');
const assert = require('node:assert/strict');

test('deployed weekly page, assets, anonymous permissions and responsive shell', {
  skip: process.env.NWPUOJ_WEEKLY_LIVE_TEST !== '1', timeout: 45000
}, async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const origin = process.env.NWPUOJ_WEEKLY_LIVE_ORIGIN || 'http://127.0.0.1';
    for (const path of ['/', '/contests', '/ranklist', '/self/weekly-ranklist.js', '/self/weekly-ranklist.css']) {
      const response = await context.request.get(origin + path);
      assert.equal(response.status(), 200, path);
    }
    const response = await page.goto(origin + '/weekly-ranklist');
    assert.equal(response.status(), 200);
    await page.locator('[data-weekly-summary]').filter({ hasText: '位成员' }).waitFor();
    assert.equal(await page.locator('.app-nav-item[href="/weekly-ranklist"]').count(), 0);
    assert.equal(await page.locator('[data-weekly-recalculate]').count(), 0);
    assert.equal(await page.locator('[data-weekly-identities]').count(), 0);
    const result = await context.request.get(origin + '/api/v2/weekly-ranklist');
    assert.equal(result.status(), 200);
    const { data } = await result.json();
    assert.equal(data.can_manage, false);
    assert.ok(data.edit_etag);
    assert.ok(data.rows.every(row => !('real_name' in row) && !('student_id' in row)));
    assert.ok(data.rows.every(row => row.cells.every(cell => Number.isSafeInteger(cell.total_problems) && cell.total_problems >= 0)));
    assert.ok((await page.locator('[data-weekly-rank] td small').allTextContents()).every(text => /通过 (?:\d+|—)\/\d+$/.test(text)));
    assert.equal((await context.request.get(origin + '/weekly-ranklist/settings')).status(), 401);
    assert.equal((await context.request.get(origin + '/api/v2/weekly-ranklist/search/users?q=test')).status(), 403);
    await page.screenshot({ path: '/tmp/nwpuoj-weekly-live-desktop.png', animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: '/tmp/nwpuoj-weekly-live-mobile.png', animations: 'disabled' });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ origin, members: data.member_count, contests: data.contests.length, rules: data.rules, permissions: 'anonymous read only' }));
    await context.close();
  } finally { await browser.close(); }
});
