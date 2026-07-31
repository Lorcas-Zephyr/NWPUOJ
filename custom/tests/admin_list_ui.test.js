'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const readAppCss = require('./helpers/read-app-css');

const root = path.resolve(__dirname, '../..');
const viewsDir = path.join(root, 'custom/views');
const readView = name => fs.readFileSync(path.join(viewsDir, name), 'utf8');

test('admin list tables use the shared toolbar and scroll region structure', () => {
  const listViews = [
    'admin_announcements.ejs',
    'admin_banners.ejs',
    'admin_judge_workers.ejs',
    'admin_links.ejs',
    'admin_privilege.ejs',
    'admin_solutions.ejs',
    'admin_user_tags.ejs',
    'admin_users.ejs'
  ];

  for (const view of listViews) {
    assert.match(readView(view), /app-admin-toolbar/, view + ' must use the shared toolbar');
  }

  for (const file of fs.readdirSync(viewsDir).filter(file => /^admin_.*\.ejs$/.test(file))) {
    const source = readView(file);
    if (source.includes('<table')) {
      assert.match(source, /app-table-region/, file + ' must wrap tables in a scroll region');
    }
  }
});

test('banner forms use valid row-independent markup', () => {
  const banner = readView('admin_banners.ejs');

  assert.match(banner, /<article class="app-admin-banner-row">/);
  assert.match(banner, /class="app-form app-admin-banner-form"/);
  assert.match(banner, /fetch\('\/api\/v2\/admin\/banners\/'/);
  assert.doesNotMatch(banner, /\['admin', 'banner', banner\.id, 'delete'\]/);
  assert.match(banner, /data-banner-v2="upload"/);
  assert.match(banner, /data-banner-v2="edit"/);
  assert.match(banner, /data-banner-v2="delete"/);
  assert.doesNotMatch(banner, /<table\b/);
  assert.doesNotMatch(banner, /<tr[^>]*>[\s\S]*?<form/);
});

test('solution review status and responsive admin column priorities remain visible', () => {
  const solutions = readView('admin_solutions.ejs');
  const css = readAppCss();

  assert.match(solutions, /<th>状态<\/th>/);
  assert.match(solutions, /appSolutionStateClasses\[solution\.status\]/);
  assert.match(solutions, /app-admin-solutions-table/);
  assert.match(css, /\.app-admin-solutions-table th:nth-child\(5\)/);
  assert.match(css, /\.app-admin-users-table th:nth-child\(6\)/);
  assert.match(css, /\.app-judge-service \.app-table th:nth-child\(5\)/);
});

test('migrated admin templates contain no inline styles', () => {
  for (const file of fs.readdirSync(viewsDir).filter(file => /^admin_.*\.ejs$/.test(file))) {
    assert.doesNotMatch(readView(file), /\sstyle=/, file + ' contains an inline style');
  }
});

test('admin workspace navigation remains available to full admins and on the current page', () => {
  const header = readView('admin_header.ejs');

  assert.match(header, /appIsFullAdmin/);
  assert.match(header, /user\.is_admin/);
  assert.match(header, /key === this\.adminPage/);
  assert.match(header, /class="app-admin-nav"/);
  assert.doesNotMatch(header, /manage_user/);
});

test('admin overview omits retired task and migration workspaces', () => {
  const overview = readView('admin_info.ejs');
  const route = fs.readFileSync(path.join(root, 'custom/modules/_admin_overview.js'), 'utf8');

  assert.doesNotMatch(route, /canManageMigrations|'admin:job\.manage'/);
  assert.ok(overview.indexOf('aria-label="待处理事项"') < overview.indexOf('VJudge 状态'));
  assert.match(overview, /VJudge 状态/);
  assert.match(overview, /最近未结工单/);
  assert.match(overview, /近期评测管理操作/);
  assert.doesNotMatch(overview, /运行任务|迁移归档|迁移发布证据/);
  assert.doesNotMatch(overview, /data-admin-operations|data-migration-workspace|data-job-action/);
  assert.doesNotMatch(overview, /\/api\/v2\/admin\/(?:jobs|migrations)/);
  assert.doesNotMatch(overview, /new EventSource|setInterval|watchMigration/);
});
