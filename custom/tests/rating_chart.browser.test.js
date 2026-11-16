'use strict';
// Render local profile fixtures; network routes are intercepted and no OJ data is written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); });
test.after(async () => { if (browser) await browser.close(); });
const start = Date.UTC(2026, 8, 1) / 1000;
function history(values = [0, 570, 1350, 1720, 1650, 2150, 2510, 3100]) {
  return values.map((value, index) => ({ contestName: index ? 'NWPU Round ' + index : '初始 Rating', contestId: index || null,
    value, before: index ? values[index - 1] : null, delta: index ? value - values[index - 1] : null,
    rank: index ? index + 1 : null, participants: index ? 100 : null, endedAt: index ? start + index * 7 * 86400 : null }));
}
function render(series) {
  const template = read('views/user.ejs').replace(/<% include \w+ %>/g, '');
  const code = `const fs=require('fs'),ejs=require('ejs'),vm=require('vm');const input=JSON.parse(fs.readFileSync(0,'utf8'));
    const syzoj={utils:{makeUrl:parts=>'/'+parts.join('/'),avatar:()=>'',formatDate:()=> '2026-09-01',getCurrentDate:()=>10}};
    vm.runInNewContext(input.renderer,{syzoj});process.stdout.write(ejs.render(input.template,{...input.locals,syzoj}));`;
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', code], {
    cwd: path.join(root, '..'), input: JSON.stringify({ template, renderer: read('modules/_username_renderer.js'), locals: {
      user: null, res: { locals: { user: null } }, statistics: {}, ratingHistories: series, participatedContests: [],
      show_user: { id: 7, username: 'Fixture', register_time: start, rating: series[series.length - 1].value, ac_problems: [] }
    } }), encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
async function fixture(series = history(), mobile = false) {
  const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1100, height: 1000 }, hasTouch: mobile, isMobile: mobile });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { errors.push('Unexpected dialog: ' + dialog.message()); await dialog.dismiss(); });
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    ['app-shell.css','app-shared.css','app-features.css','username_tiers.css'].map(file => '<link rel="stylesheet" href="/self/' + file + '">').join('') +
    '<style>.app-user-page{max-width:1000px;margin:auto;padding:24px}</style></head><body class="app-v2">' + render(series) + '</body></html>';
  await context.route('**/*', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/self/')) return route.fulfill({ contentType: 'text/css', body: read(pathname.slice(6)) });
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  await page.goto('http://rating-chart.test/fixture');
  return { context, page, errors, canvas: page.locator('#user-rating-chart'), tooltip: page.locator('#user-rating-tooltip') };
}

test('CF bands, chronological dates and full event details render with keyboard navigation', async () => {
  const f = await fixture();
  try {
    await f.canvas.scrollIntoViewIfNeeded();
    await f.canvas.focus();
    await f.page.waitForFunction(() => document.querySelector('[data-rating-name]').textContent === 'NWPU Round 7');
    assert.equal(await f.tooltip.locator('[data-rating-value]').textContent(), '3100');
    assert.equal(await f.tooltip.locator('[data-rating-delta]').textContent(), '+590');
    assert.equal(await f.tooltip.locator('[data-rating-date]').textContent(), '2026/10/20');
    assert.equal(await f.tooltip.locator('[data-rating-rank]').textContent(), '名次 8 / 100');
    await f.canvas.press('ArrowLeft'); await f.canvas.press('ArrowLeft'); await f.canvas.press('ArrowLeft');
    await f.page.waitForFunction(() => document.querySelector('[data-rating-delta]').textContent === '-70');
    assert.match(await f.tooltip.locator('[data-rating-delta]').getAttribute('class'), /app-rating-down/);
    await f.canvas.press('Home');
    await f.page.waitForFunction(() => document.querySelector('[data-rating-name]').textContent === '初始 Rating');
    assert.equal(await f.tooltip.locator('[data-rating-value]').textContent(), '0');
    assert.equal(await f.tooltip.locator('[data-rating-rank]').isVisible(), false);
    await f.canvas.press('Escape'); assert.equal(await f.tooltip.isVisible(), false);
    const colors = await f.canvas.evaluate(canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const counts = {}; for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] === 255) { const key = [pixels[i],pixels[i+1],pixels[i+2]].join(','); counts[key] = (counts[key] || 0) + 1; }
      return counts;
    });
    for (const color of ['228,228,228','194,237,183','181,230,220','190,207,240','232,192,233','246,212,166','239,178,178','222,137,143']) assert.ok(colors[color] > 100, 'missing Rating band: ' + color);
    await f.canvas.evaluate(el => el.blur());
    await f.page.locator('.app-rating-history-section').screenshot({ path: '/tmp/noj-rating-chart-light.png' });
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('long unsafe titles remain plain text and tooltips stay inside the mobile chart', async () => {
  const series = history([0, 600, 520]);
  series[2].contestName = '</script><img src=x onerror=alert(1)> 超长比赛标题 '.repeat(5);
  const f = await fixture(series, true);
  try {
    await f.canvas.scrollIntoViewIfNeeded();
    await f.canvas.tap();
    await f.canvas.press('End');
    await f.page.waitForFunction(() => document.querySelector('[data-rating-name]').textContent.startsWith('</script>'));
    assert.equal(await f.tooltip.locator('[data-rating-name]').textContent(), series[2].contestName);
    assert.equal(await f.tooltip.locator('img').count(), 0);
    const bounds = await f.tooltip.boundingBox(), chart = await f.canvas.boundingBox();
    assert.ok(bounds.x >= chart.x && bounds.x + bounds.width <= chart.x + chart.width + 1);
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await f.page.locator('.app-rating-history-section').screenshot({ path: '/tmp/noj-rating-chart-mobile.png' });
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('theme changes and resizing repaint the graph; equal-time and negative scores remain usable', async () => {
  const series = history([0, -40, -40]);
  series.forEach(point => { point.endedAt = start; });
  const f = await fixture(series);
  try {
    const light = await f.canvas.evaluate(el => el.toDataURL());
    await f.page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await f.page.waitForFunction(data => document.querySelector('canvas').toDataURL() !== data, light);
    await f.canvas.focus(); await f.canvas.press('End');
    await f.page.waitForFunction(() => document.querySelector('[data-rating-value]').textContent === '-40');
    assert.equal(await f.tooltip.locator('[data-rating-delta]').textContent(), '0');
    await f.page.setViewportSize({ width: 600, height: 1000 });
    await f.page.waitForFunction(() => { const el = document.querySelector('canvas'); return el.width === Math.round(el.clientWidth * devicePixelRatio); });
    await f.page.locator('.app-rating-history-section').screenshot({ path: '/tmp/noj-rating-chart-dark.png' });
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

test('accounts without rated participation keep the empty state', async () => {
  const f = await fixture(history([0]));
  try {
    assert.equal(await f.canvas.count(), 0);
    assert.match(await f.page.locator('.app-rating-history-section').textContent(), /暂无 Rating 变化记录/);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});
