'use strict';
// Render the real list templates with fixture data; all requests are intercepted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

function render(kind, url) {
  const template = read('views/' + (kind === 'contest' ? 'contests' : 'problem_sets') + '.ejs')
    .replace(/<% include app_pagination %>/g, read('views/app_pagination.ejs'))
    .replace(/<% include (?:app_header|app_footer|contest_registration_v2_script) %>/g, '');
  const script = function () {
    const ejs = require('/app/node_modules/ejs');
    const x = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const query = x.query, user = { id: 2 };
    const stateOf = row => x.kind === 'contest' ? row.start_time > 1000 ? 'upcoming' : row.end_time > 1000 ? 'running' : 'ended' : row.deadline_at ? 'ended' : 'open';
    const filters = { state: query.state || 'all', mine: query.mine === '1', participating: query.participating === '1' };
    const all = Array.from({ length: 48 }, (_, i) => {
      const id = i + 1;
      return { id, title: '测试' + id, holder_id: id % 2 ? 3 : 2, owner_id: id % 2 ? 3 : 2,
        start_time: id % 3 === 1 ? 1100 + id : 100 + id, end_time: id % 3 === 2 ? 500 : 2000,
        is_public: 1, type: 'acm', registered: id % 3 === 0 ? 1 : 0, deadline_at: id % 3 === 2 ? 500 : 0,
        ranking_mode: 'acm', problem_count: 1, visibility: 'public', status: 'published', owner_username: 'owner', participant_count: 2 };
    }).filter(row => (!filters.mine || row.owner_id === 2) && (!filters.participating || row.registered));
    const counts = { all: all.length, upcoming: 0, running: 0, ended: 0, open: 0 };
    all.forEach(row => counts[stateOf(row)]++);
    const matches = all.filter(row => filters.state === 'all' || stateOf(row) === filters.state);
    const pageCnt = Math.ceil(matches.length / 10), currPage = Math.max(1, Math.min(pageCnt, Number(query.page) || 1));
    const rows = matches.slice((currPage - 1) * 10, currPage * 10);
    const utils = { getCurrentDate: () => 1000, formatDate: String, makeUrl: (parts, query) => {
      const pathname = Array.isArray(parts) ? '/' + parts.join('/') : parts.path;
      return pathname + (query ? '?' + new URLSearchParams(query).toString() : '');
    } };
    process.stdout.write(ejs.render(x.template, { user, contests: rows, problemSets: rows,
      canCreateProblemSet: false, appHasCapability: () => false,
      contestRegistrations: Object.fromEntries(rows.map(row => [row.id, { registered: !!row.registered, registeredCount: 2 }])),
      contestListFilters: filters, contestListCounts: counts, contestListTotal: matches.length,
      problemSetListFilters: filters, problemSetListCounts: counts, problemSetListTotal: matches.length,
      paginate: { currPage, pageCnt }, req: { query, originalUrl: x.pathname, path: x.pathname }, syzoj: { utils } }));
  };
  const result = spawnSync('docker', ['exec', '-i', 'nwpuoj-web-1', 'node', '-e', '(' + script.toString() + ')()'], {
    cwd: path.join(root, '..'), input: JSON.stringify({ template, kind, pathname: url.pathname, query: Object.fromEntries(url.searchParams) }), encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.status, 0, result.stderr);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<link rel="stylesheet" href="/self/app-shell.css"><link rel="stylesheet" href="/self/app-shared.css"><link rel="stylesheet" href="/self/app-features.css">'
    + '</head><body class="app-v2"><main class="app-main">' + result.stdout + '</main></body></html>';
}

for (const kind of ['contest', 'set']) test(kind + ' filters navigate, fill pages, retain selection and recover from empty results', async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/self/')) return route.fulfill({ contentType: 'text/css', body: read(path.basename(url.pathname)) });
      return route.fulfill({ contentType: 'text/html', body: render(kind, url) });
    });
    await page.goto('http://lists.test/' + (kind === 'contest' ? 'contests' : 'problem-sets'));
    const owner = page.locator(kind === 'contest' ? '[data-contest-owner-filter]' : '[data-set-mine]');
    const joined = page.locator(kind === 'contest' ? '[data-contest-participant-filter]' : '[data-set-participating]');
    const rowSelector = kind === 'contest' ? '[data-contest-state]' : '[data-set-state]';
    const rows = page.locator(rowSelector);
    const count = page.locator(kind === 'contest' ? '[data-contest-visible-count]' : '[data-set-count]');
    async function navigate(action, expectedQuery) {
      await Promise.all([page.waitForURL(url => url.search === expectedQuery), action()]);
      await page.waitForLoadState('load');
    }
    assert.equal(await rows.count(), 10);
    assert.equal(await count.textContent(), '48');
    const positions = await page.locator('.app-contest-toolbar > .app-segmented, .app-contest-personal-filters, .app-contest-result-count').evaluateAll(nodes => nodes.map(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right })));
    assert.ok(positions[1].left - positions[0].right <= 20, 'personal filters stay beside status filters');
    assert.ok(positions[2].left > positions[1].right, 'count stays at the end');
    const plain = await owner.evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
    await navigate(() => page.locator('#page_next').click(), '?page=2');
    await navigate(() => owner.click(), '?mine=1');
    assert.equal(await owner.getAttribute('aria-pressed'), 'true');
    assert.equal(await count.textContent(), '24');
    assert.equal(await rows.count(), 10);
    assert.ok((await rows.evaluateAll(nodes => nodes.map(row => Number(row.dataset.contestOwner || row.dataset.setOwner)))).every(id => id === 2));
    await page.waitForFunction(selector => {
      const node = document.querySelector(selector);
      return getComputedStyle(node).backgroundColor !== 'rgb(255, 255, 255)';
    }, kind === 'contest' ? '[data-contest-owner-filter]' : '[data-set-mine]');
    const active = await owner.evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
    assert.notDeepEqual(active, plain, 'active filter has visible contrast');
    await navigate(() => page.locator('#page_next').click(), '?mine=1&page=2');
    assert.equal(await owner.getAttribute('aria-pressed'), 'true');
    assert.equal(await rows.count(), 10);
    const activeState = kind === 'contest' ? 'running' : 'open';
    const stateButton = value => page.locator(kind === 'contest' ? '[data-contest-filter="' + value + '"]' : '[data-set-filter="' + value + '"]');
    await navigate(() => stateButton(activeState).click(), '?mine=1&state=' + activeState);
    assert.equal(await count.textContent(), kind === 'contest' ? '8' : '16');
    assert.equal(await rows.count(), kind === 'contest' ? 8 : 10);
    await navigate(() => joined.click(), '?mine=1&state=' + activeState + '&participating=1');
    assert.equal(await joined.getAttribute('aria-pressed'), 'true');
    assert.equal(await count.textContent(), '8');
    assert.equal(await rows.count(), 8);
    await navigate(() => stateButton('ended').click(), '?mine=1&state=ended&participating=1');
    assert.equal(await rows.count(), 0);
    assert.equal(await count.textContent(), '0');
    assert.ok(await owner.isVisible());
    assert.ok(await stateButton('all').isVisible());
    await navigate(() => stateButton('all').click(), '?mine=1&participating=1');
    assert.equal(await rows.count(), 8);
    await navigate(() => owner.click(), '?participating=1');
    assert.equal(await count.textContent(), '16');
    await navigate(() => joined.click(), '');
    assert.equal(await count.textContent(), '48');
    await page.locator('.app-contest-toolbar').screenshot({ path: '/tmp/nwpuoj-' + kind + '-filters-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile has no horizontal overflow');
    await page.locator('.app-contest-toolbar').screenshot({ path: '/tmp/nwpuoj-' + kind + '-filters-mobile.png' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
