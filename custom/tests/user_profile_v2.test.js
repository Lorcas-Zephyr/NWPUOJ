'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('self profile v2 includes registration identity and protects committed fields', () => {
  const registration = read('custom/modules/_registration_identity.js');
  const identity = read('custom/modules/_api_v2_identity.js');
  assert.match(registration, /function profileResource\(profile\)/);
  assert.match(registration, /async function saveProfileFields\(manager, userId, body, allowChanges\)/);
  assert.match(registration, /user_registration_profile WHERE user_id = \? FOR UPDATE/);
  assert.match(registration, /Object\.prototype\.hasOwnProperty\.call\(body \|\| \{\}, field\)/);
  assert.match(registration, /registrationError\(2017, '注册实名信息保存后不允许修改。'\)/);
  assert.match(identity, /async function publicMeWithIdentity\(user\)/);
  assert.match(identity, /identity: identity\.profileResource\(await identity\.findProfile\(user\.id\)\)/);
  assert.match(identity, /saveProfileFields\(manager, user\.id, body, canManageIdentity\)/);
  assert.match(identity, /IDENTITY_PROFILE_LOCKED/);
  assert.match(identity, /STUDENT_ID_ALREADY_USED/);
});

test('self profile v2 rechecks ETag and commits account audit and event atomically', () => {
  const identity = read('custom/modules/_api_v2_identity.js');
  assert.match(identity, /SELECT \* FROM user WHERE id=\? FOR UPDATE/);
  assert.match(identity, /api\(\)\.ifMatch\(req, \{ \.\.\.publicMe\(lockedUser\), identity: lockedIdentity \}\)/);
  assert.match(identity, /recordAudit\(req, \{[\s\S]*action: 'profile:update'[\s\S]*\}, manager\)/);
  assert.match(identity, /contentDomain\.appendEvent\(manager, \{/);
  assert.match(identity, /type: 'profile\.updated'/);
  assert.match(identity, /identity_changed: identitySubmitted/);
});

test('ordinary account settings use v2 with ETag and no fallback', () => {
  const view = read('custom/views/user_edit.ejs');
  assert.match(view, /data-account-v2/);
  assert.match(view, /endpoint = adminFlow \? .* : '\/api\/v2\/me'/);
  assert.match(view, /fetch\(endpoint, \{ credentials: 'same-origin' \}\)/);
  assert.match(view, /method: 'PATCH'/);
  assert.match(view, /'If-Match': currentResult\.response\.headers\.get\('ETag'\)/);
  assert.match(view, /'Idempotency-Key': operationKey\(\)/);
  assert.doesNotMatch(view, /API_DOMAIN_DISABLED|HTMLFormElement\.prototype\.submit/);
  assert.match(view, /!user\.allowedManage && !appCanManagePrivileges && !appCanManageSiteAdmin/);
});
