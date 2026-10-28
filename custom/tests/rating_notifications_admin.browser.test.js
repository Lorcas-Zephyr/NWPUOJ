'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');

function render(view, data) {
  const template = fs.readFileSync(path.join(root, 'views', view + '.ejs'), 'utf8')
    .replace(/<% include (?:admin_header|admin_footer) %>/g, '')
    .replace('<% include app_pagination %>', fs.readFileSync(path.join(root, 'views/app_pagination.ejs'), 'utf8'));
  const script = `const fs=require('fs'),ejs=require('/app/node_modules/ejs');const x=JSON.parse(fs.readFileSync(0,'utf8'));
    x.data.syzoj={utils:{formatDate:n=>new Date(n*1000).toISOString(),makeUrl:(p,q)=>'/'+(Array.isArray(p)?p.join('/'):'admin/notifications')+(q?'?'+new URLSearchParams(q):'')}};
    process.stdout.write(ejs.render(x.template,x.data));`;
  const result = spawnSync('docker', ['exec', '-i', 'nwpuoj-web-1', 'node', '-e', script], {
    input: JSON.stringify({ template, data }), encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    ['app-shell.css','app-shared.css','app-features.css'].map(f => '<link rel="stylesheet" href="/self/' + f + '">').join('') +
    '</head><body class="app-v2"><main class="app-main"><div class="app-page app-admin-page"><div class="app-admin-content">' + result.stdout +
    '</div></div></main><script>window.__NWPUOJ_APP={csrfToken:"fixture-csrf"};</script><script src="/self/app-v2.js"></script></body></html>';
}

test('Rating dialog and notification filters match the existing UI and never mutate real data', { timeout: 60000 }, async () => {
  const contests = [
    { id: 30, title: '后续比赛', state: 'completed', startTime: 201, endTime: 300, calculationId: 3, participantCount: 5 },
    { id: 20, title: '目标比赛', state: 'completed', startTime: 101, endTime: 200, calculationId: 2, participantCount: 5 },
    { id: 10, title: '待计算比赛', state: 'pending', startTime: 1, endTime: 100, calculationId: null }
  ];
  const fixtures = {
    rating: render('admin_rating', { req: { query: {} }, ratingContests: contests, ratingCanCalculate: true }),
    readonly: render('admin_rating', { req: { query: {} }, ratingContests: contests, ratingCanCalculate: false }),
    notifications: render('admin_notifications', { req: { query: { filter: 'all' } }, filter: 'all', paginate: { currPage: 1, pageCnt: 3 }, notifications: [
      { id: 1, origin: 'system', type_label: 'Rating 变化', title: '目标比赛 Rating 已更新', content: 'Rating 1500 → 1600（+100）<script>bad()</script>', recipient_id: 8, recipient_username: '选手', published_at: '2026-10-11T00:00:00Z', is_read: false, source_url: '/contest/20/ranklist' },
      { id: 1, origin: 'manual', title: '手动通知', audience: 'all', status: 'published', published_at: '2026-10-11T00:00:00Z', etag: 'fixture', read_count: 1, recipient_count: 10 }
    ] })
  };
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], calls = [], notificationCalls = [];
    let fail = true;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      assert.equal(url.origin, 'http://rating-admin.test');
      if (url.pathname.startsWith('/self/')) {
        const f = path.basename(url.pathname);
        return route.fulfill({ contentType: f.endsWith('.js') ? 'application/javascript' : 'text/css', body: fs.readFileSync(path.join(root, f)) });
      }
      if (url.pathname.endsWith('/rollback')) {
        calls.push({ url: url.pathname, body: req.postDataJSON(), headers: req.headers() });
        return route.fulfill(fail ? { status: 409, json: { error: { message: 'Rating 结算记录已变化' } } } : { json: { data: { contest_count: 2 } } });
      }
      if (url.pathname.startsWith('/api/v2/admin/notifications/')) {
        notificationCalls.push({ url: url.pathname, body: req.postDataJSON(), headers: req.headers() });
        return route.fulfill({ status: 409, json: { error: { message: 'fixture action rejected' } } });
      }
      return route.fulfill({ contentType: 'text/html', body: url.pathname === '/readonly' ? fixtures.readonly : url.pathname.includes('notifications') ? fixtures.notifications : fixtures.rating });
    });
    await page.goto('http://rating-admin.test/admin/rating');
    assert.equal(await page.locator('[data-rating-rollback]').count(), 2);
    await page.locator('[data-rating-rollback="20"]').click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.equal(await dialog.locator('[data-rating-rollback-following]').isVisible(), true);
    assert.match(await dialog.textContent(), /后续比赛/);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(calls.length, 0);
    await page.locator('[data-rating-rollback="30"]').click();
    assert.equal(await dialog.locator('[data-rating-rollback-following]').isVisible(), false);
    await page.keyboard.press('Escape');
    await page.locator('[data-rating-rollback="20"]').click();
    await dialog.getByRole('button', { name: '确认撤回', exact: true }).click();
    await page.locator('[data-rating-rollback-error]:not([hidden])').waitFor();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { calculation_ids: [3, 2] });
    assert.ok(calls[0].headers['idempotency-key']);
    assert.equal(calls[0].headers['x-csrf-token'], 'fixture-csrf');
    assert.equal(await dialog.getByRole('button', { name: '确认撤回', exact: true }).isEnabled(), true);
    await page.screenshot({ path: '/tmp/nwpuoj-rating-rollback-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    const rect = await dialog.boundingBox();
    assert.ok(rect.width <= 390 && rect.x >= 0, 'confirmation fits mobile');
    await page.screenshot({ path: '/tmp/nwpuoj-rating-rollback-mobile.png' });
    fail = false;
    await dialog.getByRole('button', { name: '确认撤回', exact: true }).click();
    await page.waitForURL('**/admin/rating?rolled_back=1');
    assert.equal(calls.length, 2);
    await page.goto('http://rating-admin.test/readonly');
    assert.equal(await page.locator('[data-rating-rollback]').count(), 0);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('http://rating-admin.test/admin/notifications');
    assert.equal(await page.locator('.app-tab').count(), 4);
    const system = page.locator('[data-notification-origin="system"]');
    assert.equal(await system.locator('[data-notification-action]').count(), 0);
    await system.locator('summary').click();
    assert.match(await system.textContent(), /Rating 1500 → 1600/);
    assert.equal(await system.locator('script').count(), 0);
    assert.equal(await page.getByRole('link', { name: '下一页', exact: true }).getAttribute('href'), '/admin/notifications?filter=all&page=2');
    page.once('dialog', d => d.accept());
    await page.locator('[data-notification-action="revoke"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-notification-action="revoke"]').disabled);
    assert.equal(notificationCalls.length, 1);
    assert.equal(notificationCalls[0].url, '/api/v2/admin/notifications/1/revoke');
    assert.equal(notificationCalls[0].body.if_match, 'fixture');
    assert.equal(notificationCalls[0].headers['x-csrf-token'], 'fixture-csrf');
    await page.screenshot({ path: '/tmp/nwpuoj-admin-system-notifications.png' });
    await page.getByRole('link', { name: 'Rating 变化', exact: true }).click();
    await page.waitForURL('**/admin/notifications?filter=rating');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
