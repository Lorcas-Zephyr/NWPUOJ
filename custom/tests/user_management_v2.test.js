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
  assert.match(route, /hasAdminStatus && isAdmin !== !!target\.is_admin && !access\.actorIsOwner/);
  assert.match(route, /function normalizeSex\(value, fallback\)/);
  assert.match(route, /sex: normalizeSex\(target\.sex, '0'\) \|\| '0'/);
  assert.match(route, /Sex must be -1, 0, or 1/);
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
  const identity = read('custom/modules/_registration_identity.js');
  const privilegeLoader = read('custom/modules/_user_privilege_loader.js');
  const route = read('custom/modules/_api_v2_admin_domain.js');
  const view = read('custom/views/user_edit.ejs');
  assert.match(identity, /actorIsOwner: context\.actorIsOwner/);
  assert.match(identity, /actorCanManage: context\.actorCanManage/);
  assert.match(identity, /actorCanGrant: context\.actorCanGrant/);
  assert.match(privilegeLoader, /Number\(user\.id\) === Number\(owner\.id\)/);
  assert.match(view, /data-account-admin-v2/);
  assert.match(view, /\/api\/v2\/admin\/users\/' \+ encodeURIComponent\(form\.dataset\.userId\)/);
  assert.match(view, /selectedPrivileges = Array\.prototype\.map\.call/);
  assert.match(view, /payload\.privileges = selectedPrivileges/);
  assert.match(view, /form\.querySelector\('input\[name="is_admin"\]'\)/);
  assert.match(view, /siteAdminField && !!siteAdminField\.checked !== !!currentResult\.body\.data\.is_admin/);
  assert.match(view, /payload\.is_admin = !!siteAdminField\.checked/);
  assert.match(view, /<%- appCanManageSiteAdmin \? ' name="is_admin"' : ' disabled' %>/);
  assert.doesNotMatch(view, /<%= appCanManageSiteAdmin \? ' name="is_admin"' : ' disabled' %>/);
  assert.doesNotMatch(view, /fallbackAttribute|API_DOMAIN_DISABLED|HTMLFormElement\.prototype\.submit/);
  assert.match(view, /function resourceEtag\(result\)/);
  assert.match(view, /if_match: currentEtag/);
  assert.match(view, /'If-Match': currentEtag/);
  assert.match(route, /req\.get\('If-Match'\) \|\| body\.if_match/);
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
  assert.match(service, /classGroups\.ensureSchema\(\)/);
  assert.match(service, /SELECT id FROM class_group WHERE owner_id=\? FOR UPDATE/);
  assert.match(service, /DELETE FROM class_group_member WHERE class_id IN \(\?\)/);
  assert.match(service, /DELETE FROM class_group WHERE id IN \(\?\) AND owner_id=\?/);
  assert.match(service, /UPDATE class_group_member SET added_by=\? WHERE added_by=\?/);
  assert.match(service, /DELETE FROM class_group_member WHERE user_id=\?/);
  assert.match(service, /classGroups\.refreshCache\(\)/);
  assert.match(service, /action: 'admin:user\.delete'/);
  assert.match(view, /data-admin-user-delete-v2/);
  assert.match(view, /method: 'DELETE'/);
  assert.doesNotMatch(view, /API_DOMAIN_DISABLED|HTMLFormElement\.prototype\.submit/);
});
