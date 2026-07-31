'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { discover } = require('../scripts/compatibility-inventory');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('administrative writes are registered only under v2 contracts', () => {
  const source = read('custom/modules/_api_v2_admin_domain.js');
  assert.match(source, /app\.patch\('\/api\/v2\/admin\/config'/);
  assert.match(source, /app\.put\('\/api\/v2\/admin\/links'/);
  assert.match(source, /app\.post\('\/api\/v2\/admin\/rejudge\/jobs'/);
  assert.match(source, /app\.patch\('\/api\/v2\/admin\/users\/:id'/);
  assert.doesNotMatch(source, /app\.(?:post|put|patch|delete)\('\/admin\//);
  const inventory = discover();
  assert.equal(inventory.summary.v1_write_routes, 0);
  assert.equal(inventory.summary.v1_write_forms, 0);
});

test('configuration and privilege changes require capability, recent login, ETag, and audit', () => {
  const source = read('custom/modules/_api_v2_admin_domain.js');
  assert.match(source, /app\.patch\('\/api\/v2\/admin\/config', requireCapability\('admin:config\.write', \{ recent: true \}\)/);
  assert.match(source, /app\.patch\('\/api\/v2\/admin\/users\/:id', requireCapability\('admin:user\.manage'\)/);
  assert.match(source, /recentLoginSatisfied\(req\)/);
  assert.match(source, /authorize\(actor, 'admin:permission\.grant'/);
  assert.match(source, /PRECONDITION_REQUIRED/);
  assert.match(source, /ifMatch\(req, current\)/);
  assert.match(source, /action: 'admin:config\.update'/);
  assert.match(source, /action: 'admin:user\.update'/);
  assert.match(source, /details: \{ diff \}/);
});

test('bulk rejudge creates one bounded audited unified job', () => {
  const source = read('custom/modules/_api_v2_admin_domain.js');
  assert.match(source, /const MAX_BULK_REJUDGE = 500/);
  assert.match(source, /action: 'submission:bulk-rejudge'/);
  assert.match(source, /INSERT INTO admin_v2_rejudge_job/);
  assert.match(source, /INSERT INTO admin_v2_rejudge_item/);
  assert.match(source, /createRejudgeBatch\(req, res\.locals\.user, query, count\)/);
  assert.match(source, /res\.set\('X-Audit-Event-ID', String\(result\.auditEventId\)\)/);
});

test('raw configuration is neither exposed nor writable', () => {
  const route = read('custom/modules/_api_v2_admin_domain.js');
  const navigation = read('custom/views/admin_header.ejs');
  const view = read('custom/views/admin_raw.ejs');
  assert.match(route, /app\.get\('\/admin\/raw'[\s\S]*redirect\(syzoj\.utils\.makeUrl\(\['admin', 'config'\]\)\)/);
  assert.doesNotMatch(route, /app\.(?:post|put|patch|delete)\('\/admin\/raw'/);
  assert.doesNotMatch(navigation, /raw: \[/);
  assert.doesNotMatch(view, /<textarea|name="data"/);
});

test('server-rendered admin controls are v2-owned and global fetches carry CSRF', () => {
  const cases = {
    'admin_config.ejs': 'data-admin-config-v2',
    'admin_privilege.ejs': 'data-admin-privileges-v2',
    'admin_other.ejs': 'data-maintenance-v2',
    'admin_rejudge.ejs': 'data-admin-rejudge-v2',
    'admin_help_edit.ejs': 'data-admin-help-v2',
    'admin_announcement_edit.ejs': 'data-announcement-v2-edit',
    'admin_announcements.ejs': 'data-announcement-v2',
    'admin_banners.ejs': 'data-banner-v2',
    'admin_links.ejs': 'data-admin-links-v2'
  };
  for (const [view, marker] of Object.entries(cases)) assert.match(read('custom/views/' + view), new RegExp(marker), view);
  const client = read('custom/app-v2.js');
  assert.match(client, /headers\.set\('X-CSRF-Token', app\.csrfToken\)/);
});

test('content administration uses transaction-backed v2 domains', () => {
  const admin = read('custom/modules/_api_v2_admin_domain.js');
  const help = read('custom/modules/_help_page.js');
  assert.match(admin, /app\.post\('\/api\/v2\/admin\/announcements'/);
  assert.match(admin, /app\.delete\('\/api\/v2\/admin\/announcements\/:id'/);
  assert.match(admin, /app\.post\('\/api\/v2\/admin\/banners\/upload'/);
  assert.match(admin, /app\.delete\('\/api\/v2\/admin\/banners\/:id'/);
  assert.match(admin, /contentDomain\.deleteAnnouncement/);
  assert.match(admin, /contentDomain\.deleteBanner/);
  assert.match(help, /app\.put\('\/api\/v2\/admin\/help\/pages\/:slug'/);
  assert.match(help, /TypeORM\.getConnection\(\)\.transaction/);
});

test('active high-risk administrative writes persist audit identifiers', () => {
  const admin = read('custom/modules/_api_v2_admin_domain.js');
  const rating = read('custom/modules/_contest_rating.js');
  const contest = read('custom/modules/_api_v2_contest_domain.js');
  const hit = read('custom/modules/__hit_score_engine.js');
  assert.match(admin, /app\.delete\('\/api\/v2\/admin\/users\/:id'[\s\S]*X-Audit-Event-ID/);
  assert.match(admin, /app\.post\('\/api\/v2\/admin\/judge-workers\/:id\/restart'[\s\S]*X-Audit-Event-ID/);
  assert.match(rating, /app\.post\('\/api\/v2\/admin\/rating\/calculate-pending'[\s\S]*recordAudit/);
  assert.match(contest, /app\.delete\('\/api\/v2\/contests\/:id'[\s\S]*X-Audit-Event-ID/);
  assert.match(hit, /app\.post\('\/api\/v2\/admin\/hit\/recalculate'[\s\S]*recordAudit/);
});
