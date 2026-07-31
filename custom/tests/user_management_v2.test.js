'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('administrator user profile v2 preserves owner and administrator boundaries', () => {
  const route = read('custom/modules/_api_v2_admin_domain.js');
  assert.match(route, /app\.get\('\/api\/v2\/admin\/users\/:id', requireCapability\('admin:user\.manage'\)/);
  assert.match(route, /app\.patch\('\/api\/v2\/admin\/users\/:id', requireCapability\('admin:user\.manage'\)/);
  assert.match(route, /body\.new_password \|\| hasPrivileges \|\| hasAdminStatus/);
  assert.match(route, /recentLoginSatisfied\(req\)/);
  assert.match(route, /function assertManagedUserAccess\(target, actor\)/);
  assert.match(route, /OWNER_ACCOUNT_PROTECTED/);
  assert.match(route, /OWNER_CAPABILITY_REQUIRED/);
  assert.match(route, /admin:permission\.grant/);
  assert.match(route, /hasAdminStatus && !actorIsOwner/);
});

test('administrator user updates lock and commit every profile surface atomically', () => {
  const route = read('custom/modules/_api_v2_admin_domain.js');
  assert.match(route, /FROM user WHERE id=\? FOR UPDATE/);
  assert.match(route, /FROM user_registration_profile WHERE user_id=\? FOR UPDATE/);
  assert.match(route, /FROM user_privilege WHERE user_id=\? FOR UPDATE/);
  assert.match(route, /saveProfileFields\(manager, targetId, body, true\)/);
  assert.match(route, /DELETE FROM user_privilege WHERE user_id=\?/);
  assert.match(route, /action: 'admin:user\.update'/);
  assert.match(route, /contentDomain\.appendEvent\(manager/);
  assert.match(route, /type: 'user\.profile\.updated'/);
  assert.match(route, /revokeUserSessions\(req, targetId\)/);
});

test('privileged account editor uses only the administrator v2 resource', () => {
  const view = read('custom/views/user_edit.ejs');
  assert.match(view, /data-account-admin-v2/);
  assert.match(view, /\/api\/v2\/admin\/users\/' \+ encodeURIComponent\(form\.dataset\.userId\)/);
  assert.match(view, /selectedPrivileges = Array\.prototype\.map\.call/);
  assert.match(view, /payload\.privileges = selectedPrivileges/);
  assert.match(view, /payload\.is_admin = !!form\.elements\.is_admin\.checked/);
  assert.doesNotMatch(view, /fallbackAttribute|API_DOMAIN_DISABLED|HTMLFormElement\.prototype\.submit/);
  assert.match(view, /'If-Match': currentResult\.response\.headers\.get\('ETag'\)/);
});

test('Hit visibility settings use one ETag-protected evented v2 resource', () => {
  const route = read('custom/modules/__hit_score_engine.js');
  const view = read('custom/views/user_edit.ejs');
  assert.match(route, /app\.get\('\/api\/v2\/me\/hit-settings'/);
  assert.match(route, /app\.patch\('\/api\/v2\/me\/hit-settings'/);
  assert.match(route, /user_hit_setting WHERE user_id=\? LIMIT 1 FOR UPDATE/);
  assert.match(route, /api\.ifMatch\(req, current\)/);
  assert.match(route, /contentDomain\.appendEvent\(manager/);
  assert.match(route, /profile\.hit-settings\.updated/);
  assert.match(view, /data-hit-setting-v2/);
  assert.match(view, /fetch\('\/api\/v2\/me\/hit-settings'/);
  assert.doesNotMatch(view, /API_DOMAIN_DISABLED|HTMLFormElement\.prototype\.submit/);
});

test('administrator deletion uses only the v2 resource', () => {
  const route = read('custom/modules/_api_v2_admin_domain.js');
  const service = read('custom/modules/_admin_users.js');
  const view = read('custom/views/admin_users.ejs');
  assert.match(route, /app\.delete\('\/api\/v2\/admin\/users\/:id', requireCapability\('admin:user\.manage', \{ recent: true \}\)/);
  assert.match(route, /deleteUserAccount\(/);
  assert.doesNotMatch(route, /legacyRoute/);
  assert.match(route, /X-Audit-Event-ID/);
  assert.match(route, /USER_DELETE_CONFLICT/);
  assert.match(service, /UPDATE submission_v2_projection SET user_id=\? WHERE user_id=\?/);
  assert.match(service, /DELETE FROM rating_v2_event WHERE user_id=\?/);
  assert.match(service, /DELETE FROM auth_grant WHERE subject_type='user'/);
  assert.match(service, /action: 'admin:user\.delete'/);
  assert.match(view, /data-admin-user-delete-v2/);
  assert.match(view, /method: 'DELETE'/);
  assert.doesNotMatch(view, /API_DOMAIN_DISABLED|HTMLFormElement\.prototype\.submit/);
});
