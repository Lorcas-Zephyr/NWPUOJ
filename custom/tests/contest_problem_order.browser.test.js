'use strict';

// Render the real editor and intercept all browser requests. These tests never
// create or change a production contest, problem, user or session.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const longTitle = '长题目名称与特殊字符 <b>不是标签</b> '.repeat(8);
const labels = new Map([11, 12, 13, 14].map(id => [id, `${id}. ${id === 14 ? longTitle : '测试题目' + id}`]));

function renderEditor(base, ids, schedule, rating = {}) {
  const template = read('views/contest_edit.ejs')
    .replace('<% include app_header %>', '').replace('<% include app_footer %>', '');
  const script = `
    const fs = require('fs'), ejs = require('/app/node_modules/ejs');
    const x = JSON.parse(fs.readFileSync(0, 'utf8'));
    const utils = { makeUrl: parts => '/' + parts.join('/'), getCurrentDate: () => 1791072000,
      formatDate: t => new Date((t + 8 * 3600) * 1000).toISOString().slice(0, 16) };
    const contest = { id: x.rating.id == null ? 21 : x.rating.id, title: '题目顺序测试', subtitle: '', information: '', type: 'acm',
      is_public: true, start_time: x.schedule.start, end_time: x.schedule.end, isEnded: () => false };
    const problems = x.ids.map(id => ({id, title: id === 14 ? x.longTitle : '测试题目' + id, getDisplayId: () => id}));
    process.stdout.write(ejs.render(x.template, {contest, problems, admins: [{id: 2, username: '比赛管理员'}],
      baseContext: x.base, baseMember: x.base, appHasCapability: () => false, adminCsrfToken: '',
      contestRated: !!x.rating.rated, contestRatingLocked: !!x.rating.locked, contestRatingFinalizationStatus: '',
      user: {id: 2}, req: {query: {}}, syzoj: {utils}}));
  `;
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], {
    cwd: path.join(root, '..'), input: JSON.stringify({ template, base, ids, longTitle, schedule, rating }),
    encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  return browserFixture(result.stdout);
}

function browserFixture(body) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<link rel="stylesheet" href="/self/lib/flatpickr-4.6.13/flatpickr.min.css">'
    + ['app-shell.css', 'app-shared.css', 'app-features.css'].map(name => `<link rel="stylesheet" href="/self/${name}">`).join('')
    + '<script src="/self/lib/flatpickr-4.6.13/flatpickr.min.js"></script><script src="/self/lib/flatpickr-4.6.13/zh.js"></script>'
    + '<script src="/self/lucide-1.27.0.min.js"></script></head><body class="app-v2"><main class="app-main">'
    + body + '</main><script src="/self/app-v2.js"></script><script src="/self/lib/noj-markdown.js" data-upload-allowed="1"></script></body></html>';
}

function renderSchedulePage(name, locals) {
  const template = read(`views/${name}.ejs`).replace(/<% include (?:admin|app)_(?:header|footer) %>/g, '');
  const script = `
    process.env.TZ = 'Asia/Shanghai';
    const fs = require('fs'), ejs = require('/app/node_modules/ejs');
    const x = JSON.parse(fs.readFileSync(0, 'utf8'));
    const syzoj = {config: {filter_enabled_languages: []}, languages: {}, utils: {
      formatDate: t => new Date((Number(t) + 8 * 3600) * 1000).toISOString().slice(0, 16)
    }};
    process.stdout.write(ejs.render(x.template, Object.assign({syzoj, icon: {}, iconHidden: []}, x.locals)));
  `;
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], {
    cwd: path.join(root, '..'), input: JSON.stringify({ template, locals }), encoding: 'utf8', timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr);
  return browserFixture(result.stdout);
}

async function mockScheduleRoutes(page, fixtures, writes) {
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.startsWith('/self/')) return route.fulfill({
      contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css',
      body: fs.readFileSync(path.join(root, url.pathname.replace(/^\/self\/lib\//, 'static-libs/').replace(/^\/self\//, '')))
    });
    if (fixtures.has(url.pathname)) return route.fulfill({ contentType: 'text/html', body: fixtures.get(url.pathname) });
    if (url.pathname.startsWith('/api/')) {
      assert.equal(request.method(), 'POST', 'all schedule writes stay in the browser mock');
      writes.push({ path: url.pathname, body: request.postDataJSON(), headers: request.headers() });
      return route.fulfill({ headers: { ETag: '"saved-revision"' }, json: { data: { id: 7 } } });
    }
    return route.fulfill({ contentType: 'text/html', body: '<p>Saved schedule fixture</p>' });
  });
}

test('contest publish review and saved Rated state agree for editable, locked and base contests', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    for (const state of [
      { id: 0, rated: false },
      { id: 21, rated: true },
      { id: 21, rated: true, locked: true },
      { id: 21, rated: false, locked: true },
      { id: 21, rated: false, base: true }
    ]) {
      const page = await browser.newPage({ timezoneId: 'Asia/Shanghai' });
      const errors = [], writes = [];
      page.on('pageerror', error => errors.push(error.message));
      const html = renderEditor(!!state.base, [11], { start: 1793520000, end: 1793534400 }, state);
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.pathname.startsWith('/self/')) return route.fulfill({
          contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css',
          body: fs.readFileSync(path.join(root, url.pathname.replace(/^\/self\/lib\//, 'static-libs/').replace(/^\/self\//, '')))
        });
        if (url.pathname.endsWith('/edit')) return route.fulfill({ contentType: 'text/html', body: html });
        if (url.pathname.startsWith('/api/v2/contests')) {
          if (request.method() === 'GET') return route.fulfill({ json: { data: { id: 21 }, meta: { etag: '"rating-revision"' } } });
          assert.equal(request.method(), 'POST');
          writes.push(request.postDataJSON());
          return route.fulfill({ json: { data: { id: 21 } } });
        }
        return route.fulfill({ contentType: 'text/html', body: '<p>Saved contest fixture</p>' });
      });
      try {
        await page.goto(`http://contest-rating.test/contest/${state.id}/edit`);
        await page.locator('[data-contest-step-target="3"]').click();
        const toggle = page.locator('input[type="checkbox"][name="is_rated"]');
        const summary = page.locator('[data-review-visibility]');
        const label = async () => (await summary.textContent()).split(' · ')[1];
        assert.equal(await toggle.isDisabled(), !!(state.locked || state.base));
        assert.equal(await page.locator('input[name="is_rated"]').count(), state.locked && state.rated ? 2 : 1);
        assert.equal(await label(), state.rated ? 'Rated' : 'Unrated', JSON.stringify(state));
        let expectedRated = state.rated;
        if (!state.locked && !state.base) {
          for (const rated of [true, false, true]) {
            await toggle.setChecked(rated);
            assert.equal(await label(), rated ? 'Rated' : 'Unrated');
          }
          expectedRated = true;
        }
        await page.locator('#submit_button').click();
        await page.waitForURL('**/contest/21/details');
        assert.equal(writes.length, 1);
        assert.equal(writes[0].is_rated, expectedRated);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});

for (const base of [false, true]) {
  test(`${base ? 'base' : 'ordinary'} contest preserves problem order and announcement-style schedule through save and reload`, { timeout: 60000 }, async () => {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', timezoneId: 'Asia/Shanghai' });
    page.setDefaultTimeout(8000);
    let storedIds = [11, 12, 13];
    let storedSchedule = { start: 1793520000, end: 1793534400 };
    const writes = [], errors = [], searchScopes = [], dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.startsWith('/self/')) return route.fulfill({
        contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css',
        body: fs.readFileSync(path.join(root, url.pathname.replace(/^\/self\/lib\//, 'static-libs/').replace(/^\/self\//, '')))
      });
      if (url.pathname.startsWith('/api/v2/search/problems/')) {
        searchScopes.push(url.searchParams.get('workspace'));
        return route.fulfill({ json: { data: [11, 14].map(id => ({ id, name: labels.get(id) })) } });
      }
      if (url.pathname === '/api/v2/contests/21' && request.method() === 'GET') {
        // Reproduce external proxies: the ETag is available only in JSON.
        return route.fulfill({ json: { data: { id: 21 }, meta: { etag: '"test-revision"' } } });
      }
      if (url.pathname === '/api/v2/contests/21/update' && request.method() === 'POST') {
        const body = request.postDataJSON();
        writes.push({ body, headers: request.headers() });
        storedIds = body.problem_ids;
        storedSchedule = { start: Date.parse(body.start_at) / 1000, end: Date.parse(body.end_at) / 1000 };
        return route.fulfill({ json: { data: { id: 21 } } });
      }
      if (url.pathname === '/contest/21/edit') return route.fulfill({ contentType: 'text/html', body: renderEditor(base, storedIds, storedSchedule) });
      if (url.pathname === '/contest/21/details') return route.fulfill({ contentType: 'text/html', body: '<p>Saved contest fixture</p>' });
      return route.fulfill({ status: 404, body: '' });
    });
    const picker = page.locator('[data-entity-picker][data-name="problems"]');
    const row = id => picker.locator(`[data-picker-value="${id}"]`);
    const move = (id, direction) => row(id).locator(`[data-picker-move="${direction}"]`);
    const order = () => picker.locator('[data-picker-value]').evaluateAll(rows => rows.map(row => Number(row.dataset.pickerValue)));
    async function checkBoundaries(expected) {
      assert.deepEqual(await order(), expected);
      for (let i = 0; i < expected.length; i++) {
        assert.equal(await move(expected[i], 'up').isDisabled(), i === 0);
        assert.equal(await move(expected[i], 'down').isDisabled(), i === expected.length - 1);
      }
    }
    try {
      await page.goto('http://contest-order.test/contest/21/edit');
      await page.waitForFunction(() => document.querySelectorAll('[data-vditor-ready="1"]').length === 2);
      await page.locator('textarea[name="subtitle"]').evaluate(source => { source.value = '比赛简介\n第二行'; });
      await page.locator('textarea[name="information"]').evaluate(source => { source.value = '## 比赛公告\n\n支持 **Markdown**'; });
      await page.locator('[data-contest-step-next]').click();
      await checkBoundaries([11, 12, 13]);
      assert.equal(await page.locator('[data-name="admins"] [data-picker-move]').count(), 0);
      assert.equal(await page.locator('[data-name="admins"]').count(), base ? 0 : 1);
      await move(12, 'up').click();
      await checkBoundaries([12, 11, 13]);
      assert.equal(await move(12, 'down').evaluate(button => button === document.activeElement), true, 'focus follows the moved row');
      await move(12, 'down').click();
      await move(13, 'up').click();
      await checkBoundaries([11, 13, 12]);
      await picker.locator('[data-picker-search]').fill('测试');
      await picker.locator('[data-picker-results] button').waitFor();
      assert.equal(await picker.locator('[data-picker-results] button').count(), 1, 'existing problems cannot be duplicated');
      await picker.locator('[data-picker-results] button').click();
      await checkBoundaries([11, 13, 12, 14]);
      assert.equal(await row(14).locator('em b').count(), 0, 'titles remain escaped');
      assert.equal(await row(14).locator('em').getAttribute('title'), labels.get(14).trim());
      assert.equal(await move(14, 'up').locator('svg').count(), 1, 'new arrows render actual icons');
      await move(14, 'up').click();
      await row(11).locator('[data-picker-remove]').click();
      await checkBoundaries([13, 14, 12]);
      await move(14, 'up').focus();
      await page.keyboard.press('Enter');
      await checkBoundaries([14, 13, 12]);
      assert.equal(writes.length, 0, 'move buttons never submit the form');
      assert.deepEqual(await page.locator('#contest-editor-form').evaluate(form => new FormData(form).getAll('problems')), ['14', '13', '12']);
      await page.screenshot({ path: `/tmp/nwpuoj-contest-order-${base ? 'base' : 'global'}-desktop.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no mobile page overflow');
      assert.equal(await row(14).evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'long title stays inside the row');
      for (const direction of ['up', 'down']) assert.ok((await move(13, direction).boundingBox()).width >= 32);
      await move(13, 'down').click();
      await move(13, 'up').click();
      await checkBoundaries([14, 13, 12]);
      await page.screenshot({ path: `/tmp/nwpuoj-contest-order-${base ? 'base' : 'global'}-mobile.png`, fullPage: true });
      await page.locator('[data-contest-step-next]').click();
      const start = page.getByLabel('开始时间', { exact: true });
      const end = page.getByLabel('结束时间', { exact: true });
      assert.equal(await page.locator('input[type="hidden"][data-app-datetime-picker]').count(), 2);
      await start.fill('2026-11-15 00:00');
      assert.equal(await page.locator('[name="start_time"]').inputValue(), '2026-11-15T00:00');
      const calendar = page.locator('.app-datetime-calendar.open');
      const hour = calendar.getByRole('combobox', { name: '小时（0–23）', exact: true });
      const minute = calendar.getByRole('combobox', { name: '分钟（0–59）', exact: true });
      assert.equal(await calendar.locator('.flatpickr-am-pm').count(), 0, 'en-US browsers still use 24-hour time');
      assert.equal(await hour.inputValue(), '00');
      assert.deepEqual(await hour.locator('option').evaluateAll(options => options.map(option => option.value)), Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')));
      assert.deepEqual(await minute.locator('option').evaluateAll(options => options.map(option => option.value)), Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0')));
      await calendar.locator('.flatpickr-day:not(.prevMonthDay):not(.nextMonthDay)').filter({ hasText: /^16$/ }).click();
      assert.equal(await page.locator('[name="start_time"]').inputValue(), '2026-11-16T00:00');
      await hour.selectOption('13');
      await minute.selectOption('05');
      assert.equal(await start.inputValue(), '2026-11-16 13:05');
      await calendar.locator('.flatpickr-day:not(.prevMonthDay):not(.nextMonthDay)').filter({ hasText: /^15$/ }).click();
      assert.equal(await start.inputValue(), '2026-11-15 13:05', 'changing the date preserves the chosen time');
      assert.equal(await hour.evaluate(select => select === document.activeElement), true);
      await hour.press('ArrowDown');
      assert.equal(await start.inputValue(), '2026-11-15 14:05', 'select keyboard navigation updates the schedule');
      await hour.press('ArrowUp');
      await hour.press('Tab');
      assert.equal(await minute.evaluate(select => select === document.activeElement), true);
      await minute.press('Shift+Tab');
      assert.equal(await hour.evaluate(select => select === document.activeElement), true);
      await hour.press('Escape');
      assert.equal(await calendar.count(), 0);
      assert.equal(await start.evaluate(input => input === document.activeElement), true);
      await end.fill('2026-11-15 10:00');
      await hour.selectOption('23');
      await minute.selectOption('59');
      assert.equal(await page.locator('[name="start_time"]').inputValue(), '2026-11-15T13:05');
      assert.equal(await page.locator('[name="end_time"]').inputValue(), '2026-11-15T23:59');
      assert.equal(await page.locator('[name="standings_freeze_after_minutes"]').getAttribute('max'), '653');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'datetime pickers fit on mobile');
      assert.equal(await hour.inputValue(), '23');
      const mobileCalendar = await calendar.boundingBox();
      assert.ok(mobileCalendar.x >= 0 && mobileCalendar.x + mobileCalendar.width <= 390, 'mobile popup fits the screen');
      await page.screenshot({ path: `/tmp/nwpuoj-contest-time-${base ? 'base' : 'global'}-mobile.png`, fullPage: true, animations: 'disabled' });
      await start.fill('');
      await page.locator('[data-contest-step-next]').click();
      assert.equal(await start.isVisible(), true, 'a missing date blocks the review step');
      assert.equal(writes.length, 0);
      await start.fill('2026-02-31 13:05');
      assert.equal(await start.evaluate(input => input.checkValidity()), false, 'invalid dates cannot be saved');
      assert.equal(await page.locator('[name="start_time"]').inputValue(), '');
      await start.fill('2026-11-15 13:05');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await start.click();
      assert.equal(await hour.inputValue(), '13', 'typing a time synchronizes both dropdowns');
      assert.equal(await minute.inputValue(), '05');
      await page.locator('html').evaluate(html => { html.dataset.theme = 'dark'; });
      await page.screenshot({ path: `/tmp/nwpuoj-contest-time-${base ? 'base' : 'global'}-desktop.png`, fullPage: true, animations: 'disabled' });
      await start.press('Escape');
      await page.locator('[data-contest-step-next]').click();
      assert.equal(await page.locator('[data-review-problems]').textContent(), '3 道 · ' + [14, 13, 12].map(id => labels.get(id).trim()).join('、'));
      assert.equal(await page.locator('[data-review-schedule]').textContent(), '2026-11-15T13:05 至 2026-11-15T23:59');
      await page.locator('#submit_button').click();
      await page.waitForURL('**/contest/21/details');
      assert.equal(writes.length, 1);
      assert.deepEqual(writes[0].body.problem_ids, [14, 13, 12]);
      assert.deepEqual(writes[0].body.admins, base ? [] : [2]);
      assert.equal(writes[0].body.workspace, base ? 'base' : 'global');
      assert.equal(writes[0].headers['if-match'], '"test-revision"');
      assert.equal(writes[0].body.if_match, '"test-revision"');
      assert.equal(writes[0].body.is_rated, false);
      assert.equal(writes[0].body.subtitle, '比赛简介\n第二行');
      assert.equal(writes[0].body.information, '## 比赛公告\n\n支持 **Markdown**');
      assert.equal(writes[0].body.start_at, '2026-11-15T05:05:00.000Z');
      assert.equal(writes[0].body.end_at, '2026-11-15T15:59:00.000Z');
      await page.goto('http://contest-order.test/contest/21/edit');
      await page.locator('[data-contest-step-next]').click();
      await checkBoundaries([14, 13, 12]);
      await row(14).locator('[data-picker-remove]').click();
      await row(13).locator('[data-picker-remove]').click();
      await checkBoundaries([12]);
      await row(12).locator('[data-picker-remove]').click();
      await checkBoundaries([]);
      await picker.locator('[data-picker-search]').fill('测试');
      await picker.locator('[data-picker-results] button').filter({ hasText: '14.' }).click();
      await checkBoundaries([14]);
      assert.deepEqual(searchScopes, [base ? 'base' : null, base ? 'base' : null]);
      await page.locator('[data-contest-step-next]').click();
      assert.equal(await page.locator('[name="start_time"]').inputValue(), '2026-11-15T13:05');
      assert.equal(await page.locator('[name="end_time"]').inputValue(), '2026-11-15T23:59');
      assert.equal(await page.getByLabel('开始时间', { exact: true }).inputValue(), '2026-11-15 13:05');
      assert.equal(await page.getByLabel('结束时间', { exact: true }).inputValue(), '2026-11-15 23:59');
      await page.getByLabel('结束时间', { exact: true }).click();
      assert.equal(await hour.inputValue(), '23', 'saved hour is selected when reopening the picker');
      assert.equal(await minute.inputValue(), '59');
      assert.deepEqual(errors, []);
      assert.deepEqual(dialogs, []);
    } finally { await browser.close(); }
  });
}

test('announcement datetime fields use 24-hour time on touch devices and save new and existing schedules', { timeout: 30000 }, async () => {
  const template = read('views/admin_announcement_edit.ejs')
    .replace('<% include admin_header %>', '').replace('<% include admin_footer %>', '');
  const script = `
    process.env.TZ = 'Asia/Shanghai';
    const fs = require('fs'), ejs = require('/app/node_modules/ejs');
    const x = JSON.parse(fs.readFileSync(0, 'utf8'));
    const start = Date.parse('2026-11-15T00:00:00+08:00') / 1000;
    process.stdout.write(ejs.render(x.template, {announcement: {id: x.id, title: '时间测试', content: '测试正文',
      start_time: x.id ? start : 0, end_time: x.id ? start + 3600 : 0}, adminCsrfToken: '',
      syzoj: {utils: {makeUrl: parts => '/' + parts.join('/')}}}));
  `;
  const fixtures = new Map([0, 9].map(id => {
    const rendered = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], {
      cwd: path.join(root, '..'), input: JSON.stringify({ template, id }), encoding: 'utf8', timeout: 10000
    });
    assert.equal(rendered.status, 0, rendered.stderr);
    return [id, browserFixture(rendered.stdout)];
  }));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    locale: 'en-US', timezoneId: 'Asia/Shanghai' });
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.startsWith('/self/')) return route.fulfill({
      contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css',
      body: fs.readFileSync(path.join(root, url.pathname.replace(/^\/self\/lib\//, 'static-libs/').replace(/^\/self\//, '')))
    });
    const edit = /^\/admin\/announcements\/(0|9)\/edit$/.exec(url.pathname);
    if (edit) return route.fulfill({ contentType: 'text/html', body: fixtures.get(Number(edit[1])) });
    if (url.pathname.startsWith('/api/v2/admin/announcements')) {
      if (request.method() === 'GET') return route.fulfill({ json: { data: { id: 9 }, meta: { etag: '"announcement-revision"' } } });
      writes.push({ body: request.postDataJSON(), method: request.method(), headers: request.headers() });
      return route.fulfill({ json: { data: { id: 9 } } });
    }
    return route.fulfill({ contentType: 'text/html', body: '<p>Saved announcement fixture</p>' });
  });
  try {
    for (const id of [0, 9]) {
      await page.goto(`http://announcement-time.test/admin/announcements/${id}/edit`);
      const start = page.getByLabel('开始时间', { exact: true });
      const end = page.getByLabel('结束时间', { exact: true });
      const save = page.getByRole('button', { name: '保存公告' });
      assert.equal(await start.inputValue(), id ? '2026-11-15 00:00' : '');
      await start.fill('2026-11-15 00:00');
      await end.fill('2026-11-16 12:00');
      const calendar = page.locator('.app-datetime-calendar.open');
      const hour = calendar.getByRole('combobox', { name: '小时（0–23）', exact: true });
      const minute = calendar.getByRole('combobox', { name: '分钟（0–59）', exact: true });
      await hour.selectOption('23');
      await minute.selectOption('59');
      assert.equal(await calendar.locator('.flatpickr-am-pm').count(), 0);
      assert.equal(await end.inputValue(), '2026-11-16 23:59');
      assert.equal(await page.locator('.flatpickr-mobile').count(), 0, 'touch devices use the same fixed 24-hour picker');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.screenshot({ path: '/tmp/nwpuoj-announcement-time-mobile.png', fullPage: true, animations: 'disabled' });
      await start.fill('2026-11-15 24:01');
      assert.equal(await start.evaluate(input => input.checkValidity()), false);
      await save.click();
      assert.equal(writes.length, id ? 1 : 0, 'invalid time blocks submission');
      await start.fill('2026-11-15 00:00');
      await calendar.getByRole('combobox', { name: '小时（0–23）', exact: true }).selectOption('00');
      await calendar.getByRole('combobox', { name: '分钟（0–59）', exact: true }).selectOption('00');
      await save.click();
      await page.waitForURL('**/admin/announcements');
      const saved = writes[writes.length - 1];
      assert.equal(saved.method, 'POST');
      assert.equal(saved.headers['x-http-method-override'], id ? 'PATCH' : undefined);
      assert.equal(saved.body.starts_at, '2026-11-14T16:00:00.000Z');
      assert.equal(saved.body.ends_at, '2026-11-16T15:59:00.000Z');
      if (id) assert.equal(saved.headers['if-match'], '"announcement-revision"');
    }
    assert.equal(writes.length, 2);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('notification, problem-set, and rejudge schedules share the global 24-hour picker', { timeout: 60000 }, async () => {
  const notificationFixtures = new Map();
  for (const id of [0, 7]) notificationFixtures.set(`/admin/notification/${id}/edit`, renderSchedulePage('admin_notification_edit', {
    notification: { id, title: '通知时间测试', content: '内容', audience: 'all', scheduled_at: id ? 1794672000 : null },
    notificationEtag: id ? '"notification-revision"' : ''
  }));
  const problemSetFixtures = new Map();
  for (const id of [0, 7]) problemSetFixtures.set(`/problem-set/${id}/edit`, renderSchedulePage('problem_set_edit', {
    problemSet: id ? { id, title: '题单时间测试', description: '', deadline_at: 1794672000, allow_registration: true, ranking_mode: 'acm', visibility: 'private', status: 'draft' } : null,
    problemSetItems: [], problemSetEtag: id ? '"set-revision"' : ''
  }));
  const rejudge = renderSchedulePage('admin_rejudge', { rejudgeLimit: 100, form: {} });
  const fixtures = new Map([...notificationFixtures, ...problemSetFixtures, ['/admin/rejudge', rejudge]]);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, locale: 'en-US', timezoneId: 'Asia/Shanghai' });
  page.setDefaultTimeout(8000);
  const writes = [], errors = [], dialogs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
  await mockScheduleRoutes(page, fixtures, writes);
  try {
    await page.goto('http://schedule.test/admin/notification/7/edit');
    const scheduled = page.getByLabel('定时发布时间', { exact: true });
    assert.equal(await scheduled.inputValue(), '2026-11-15 00:00');
    await scheduled.click();
    const calendar = page.locator('.app-datetime-calendar.open');
    await calendar.getByRole('combobox', { name: '小时（0–23）', exact: true }).selectOption('23');
    await calendar.getByRole('combobox', { name: '分钟（0–59）', exact: true }).selectOption('59');
    await page.getByRole('button', { name: '保存草稿' }).click();
    await page.waitForURL('**/admin/notifications');
    assert.equal(writes[0].path, '/api/v2/admin/notifications/7');
    assert.equal(writes[0].body.scheduled_at, '2026-11-15T23:59');
    assert.equal(writes[0].headers['if-match'], '"notification-revision"');

    await page.goto('http://schedule.test/admin/notification/7/edit');
    await scheduled.fill('');
    await page.getByRole('button', { name: '保存草稿' }).click();
    await page.waitForURL('**/admin/notifications');
    assert.equal(writes.at(-1).body.scheduled_at, '', 'clearing an existing schedule explicitly removes it');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('http://schedule.test/admin/notification/0/edit');
    assert.equal(await scheduled.inputValue(), '');
    await scheduled.fill('2026-11-16 24:01');
    await scheduled.press('Escape');
    const beforeInvalidPublish = writes.length;
    await page.getByRole('button', { name: '发布通知' }).click();
    assert.equal(await scheduled.evaluate(input => input.checkValidity()), false);
    assert.equal(writes.length, beforeInvalidPublish, 'publish buttons also reject invalid schedule input');
    assert.equal(dialogs.length, 0);
    await scheduled.fill('2026-11-16 00:00');
    await calendar.getByRole('combobox', { name: '小时（0–23）', exact: true }).selectOption('00');
    await calendar.getByRole('combobox', { name: '分钟（0–59）', exact: true }).selectOption('07');
    await page.screenshot({ path: '/tmp/nwpuoj-notification-time-mobile.png', fullPage: true, animations: 'disabled' });
    await calendar.getByRole('combobox', { name: '分钟（0–59）', exact: true }).press('Escape');
    await page.getByRole('button', { name: '发布通知' }).click();
    await page.waitForURL('**/admin/notifications');
    assert.equal(writes.at(-2).path, '/api/v2/admin/notifications');
    assert.equal(writes.at(-2).body.scheduled_at, '2026-11-16T00:07');
    assert.equal(writes.at(-1).path, '/api/v2/admin/notifications/7/publish');
    assert.equal(writes.at(-1).headers['if-match'], '"saved-revision"');

    await page.goto('http://schedule.test/problem-set/7/edit');
    const deadline = page.getByLabel('截止时间', { exact: true });
    assert.equal(await deadline.inputValue(), '2026-11-15 00:00');
    await deadline.click();
    await page.locator('.app-datetime-calendar.open').getByRole('combobox', { name: '小时（0–23）', exact: true }).selectOption('12');
    await page.locator('.app-datetime-calendar.open').getByRole('combobox', { name: '分钟（0–59）', exact: true }).selectOption('30');
    await page.locator('.app-datetime-calendar.open').getByRole('combobox', { name: '分钟（0–59）', exact: true }).press('Escape');
    await page.locator('[data-deadline-toggle]').uncheck();
    assert.equal(await deadline.inputValue(), '');
    assert.equal(await page.locator('[name="deadline_at"]').inputValue(), '');
    await page.locator('[data-deadline-toggle]').check();
    assert.equal(await deadline.inputValue(), '');
    await deadline.fill('2026-02-31 12:30');
    assert.equal(await deadline.evaluate(input => input.checkValidity()), false);
    await deadline.press('Escape');
    await page.locator('[data-deadline-toggle]').uncheck();
    assert.equal(await deadline.evaluate(input => input.checkValidity()), true, 'turning off the deadline clears stale validation');
    await page.locator('[data-deadline-toggle]').check();
    await deadline.fill('2026-11-16 12:30');
    await page.screenshot({ path: '/tmp/nwpuoj-problem-set-time-mobile.png', fullPage: true, animations: 'disabled' });
    await deadline.press('Escape');
    await page.getByRole('button', { name: '保存题单' }).click();
    await page.waitForURL('**/problem-set/7');
    const setWrite = writes.find(item => item.path === '/api/v2/problem-sets/7');
    assert.equal(setWrite.body.deadline_at, '2026-11-16T12:30');
    assert.equal(setWrite.headers['if-match'], '"set-revision"');

    await page.goto('http://schedule.test/problem-set/0/edit');
    assert.equal(await deadline.isVisible(), false);
    await page.getByLabel('题单标题', { exact: true }).fill('无限期题单测试');
    await page.getByRole('button', { name: '保存题单' }).click();
    await page.waitForURL('**/problem-set/7');
    assert.equal(writes.at(-1).path, '/api/v2/problem-sets');
    assert.equal(writes.at(-1).body.deadline_at, '');

    await page.goto('http://schedule.test/admin/rejudge');
    const min = page.getByRole('textbox', { name: '提交时间下限' }), max = page.getByRole('textbox', { name: '提交时间上限' });
    assert.equal(await min.inputValue(), '1970-01-01 08:00');
    assert.equal(await max.inputValue(), '2038-01-19 11:14');
    await min.fill('2026-11-15 13:05');
    await max.fill('2026-11-15 14:06');
    await calendar.getByRole('combobox', { name: '小时（0–23）', exact: true }).selectOption('23');
    await calendar.getByRole('combobox', { name: '分钟（0–59）', exact: true }).selectOption('59');
    await page.screenshot({ path: '/tmp/nwpuoj-rejudge-time-mobile.png', fullPage: true, animations: 'disabled' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await calendar.getByRole('combobox', { name: '分钟（0–59）', exact: true }).press('Escape');
    await page.getByRole('button', { name: '创建批量重测任务' }).click();
    await page.waitForURL('**/admin/jobs?job=7');
    const rejudgeWrite = writes.find(item => item.path === '/api/v2/admin/rejudge/jobs');
    assert.equal(rejudgeWrite.body.min_time, '2026-11-15T13:05:00');
    assert.equal(rejudgeWrite.body.max_time, '2026-11-15T23:59:59');
    const sameMinute = Date.parse(rejudgeWrite.body.max_time + '+08:00') - Date.parse('2026-11-15T23:59:30+08:00');
    assert.equal(sameMinute, 29000, 'submissions within the upper minute remain included');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('datetime pointer menus open across the full control and keep minutes 58/59 reachable', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1200, height: mobile ? 560 : 900 }, hasTouch: mobile, isMobile: mobile, timezoneId: 'Asia/Shanghai' });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith('/self/')) return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css', body: read(url.pathname.replace(/^\/self\/lib\//, 'static-libs/').replace(/^\/self\//, '')) });
        return route.fulfill({ contentType: 'text/html', body: browserFixture('<main style="padding:24px;max-width:360px"><label>开始时间<input class="app-input" type="datetime-local" name="start" data-app-datetime-picker value="2026-11-15T12:00"></label></main>') });
      });
      try {
        await page.goto('http://datetime-pointer.test/picker');
        const input = page.getByLabel('开始时间', { exact: true });
        await input.click({ position: { x: 12, y: 20 } });
        const calendar = page.locator('.app-datetime-calendar.open');
        const minute = calendar.getByRole('combobox', { name: '分钟（0–59）', exact: true });
        const clickMinute = async position => {
          if (mobile) await minute.tap({ position }); else await minute.click({ position });
        };
        await clickMinute({ x: 12, y: 20 });
        const list = calendar.getByRole('listbox', { name: '分钟选项' });
        await list.waitFor();
        assert.equal(await minute.getAttribute('aria-expanded'), 'true');
        // Real scrolling and pointer clicks catch native-popup clipping that
        // selectOption() and counting option elements cannot detect.
        await list.hover();
        await page.mouse.wheel(0, 5000);
        await page.waitForFunction(() => { const list = document.querySelector('.app-datetime-options:not([hidden])'); return list && list.scrollTop + list.clientHeight >= list.scrollHeight - 1; });
        const bounds = await list.boundingBox();
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= (mobile ? 560 : 900), 'options stay inside viewport');
        assert.ok(bounds.height <= 224, 'long list has a bounded height');
        for (const value of ['58', '59']) {
          const option = await list.getByRole('option', { name: value, exact: true }).boundingBox();
          assert.ok(option.y >= bounds.y && option.y + option.height <= bounds.y + bounds.height, value + ' is fully visible at the bottom');
        }
        if (mobile) assert.equal(await list.getAttribute('data-placement'), 'above');
        await list.getByRole('option', { name: '58', exact: true }).click();
        assert.equal(await page.locator('[name="start"]').inputValue(), '2026-11-15T12:58');
        assert.ok(await list.isVisible(), 'choosing a minute keeps the options and calendar open');
        const box = await minute.boundingBox();
        await list.getByRole('option', { name: '59', exact: true }).click();
        assert.equal(await page.locator('[name="start"]').inputValue(), '2026-11-15T12:59');
        await clickMinute({ x: box.width / 2, y: 20 });
        assert.equal(await list.isVisible(), false, 'clicking the control again closes only its options');
        await clickMinute({ x: box.width - 6, y: 20 });
        assert.ok(await list.isVisible(), 'arrow area also opens the same list');
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
        await page.screenshot({ path: '/tmp/nwpuoj-time-options-' + (mobile ? 'mobile' : 'desktop') + '.png', fullPage: true, animations: 'disabled' });
        await minute.press('Home');
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('[name="start"]').inputValue(), '2026-11-15T12:00');
        await minute.press('Escape');
        assert.ok(await calendar.isVisible(), 'first Escape closes the time options');
        await minute.press('Escape');
        assert.equal(await calendar.count(), 0);
        // Reopen from the middle of an already-focused date input.
        await input.click({ position: { x: 100, y: 20 } });
        assert.ok(await calendar.isVisible());
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
});
