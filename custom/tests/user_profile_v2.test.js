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
  assert.match(identity, /function normalizeSex\(value, fallback\)/);
  assert.match(identity, /sex: normalizeSex\(user\.sex, '0'\) \|\| '0'/);
  assert.match(identity, /Sex must be -1, 0, or 1/);
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

test('ordinary users can change only their own username with uniqueness and owner protection', () => {
  const registration = read('custom/modules/_registration_identity.js');
  const identity = read('custom/modules/_api_v2_identity.js');
  const view = read('custom/views/user_edit.ejs');
  assert.match(identity, /const requestedUsername = body\.username == null/);
  assert.match(identity, /isValidUsername\(requestedUsername\)/);
  assert.match(registration, /USERNAME_MAX_LENGTH = 20/);
  assert.match(registration, /CHAR_LENGTH\(username\)>\?/);
  assert.match(registration, /username_length_limit/);
  assert.match(registration, /INSERT INTO notification/);
  assert.match(identity, /USERNAME_ALREADY_USED/);
  assert.match(identity, /site owner username cannot be changed/);
  assert.match(identity, /SELECT id FROM user WHERE username=\? AND id<>\?/);
  assert.match(identity, /UPDATE user SET username=\?,email=\?/);
  assert.match(view, /\(adminFlow \|\| selfFlow\) payload\.username/);
  assert.match(view, /\(edited_user\.id !== user\.id && !appCanManageUsers\) \|\| appEditedUserIsSiteOwner/);
});

test('registration settings advertise the twenty-character username limit', () => {
  const signup = read('custom/views/sign_up.ejs');
  const webConfig = JSON.parse(read('custom/web.json'));
  assert.equal(webConfig.username_regex, '^[a-zA-Z0-9\\-_]{1,20}$');
  assert.match(signup, /name="username"[\s\S]*maxlength="20"/);
  assert.match(signup, /最多 20 个字符/);
  const editor = read('custom/views/user_edit.ejs');
  assert.match(editor, /input\.maxLength = 20/);
});

test('ordinary account settings use v2 with ETag and no fallback', () => {
  const view = read('custom/views/user_edit.ejs');
  assert.match(view, /data-account-v2/);
  assert.match(view, /endpoint = adminFlow \? .* : '\/api\/v2\/me'/);
  assert.match(view, /fetch\(endpoint, \{ credentials: 'same-origin', cache: 'no-store' \}\)/);
  assert.match(view, /function resourceEtag\(result\)/);
  assert.match(view, /if_match: currentEtag/);
  assert.match(view, /method: 'PATCH'/);
  assert.match(view, /'If-Match': currentEtag/);
  assert.match(view, /'Idempotency-Key': operationKey\(\)/);
  assert.doesNotMatch(view, /API_DOMAIN_DISABLED|HTMLFormElement\.prototype\.submit/);
  assert.match(view, /!appCanManageUsers && !appCanManagePrivileges && !appCanManageSiteAdmin/);
  const registration = read('custom/modules/_registration_identity.js');
  assert.match(registration, /res\.setHeader\('Cache-Control', 'private, no-store, max-age=0, must-revalidate'\)/);
  const foundation = read('custom/modules/_api_v2_foundation.js');
  assert.match(foundation, /req\.method === 'GET' \? 'private, no-store, max-age=0, must-revalidate'/);
  assert.match(foundation, /body\.meta\.etag = setResourceEtag\(res, payload\)/);
  const identity = read('custom/modules/_api_v2_identity.js');
  assert.match(identity, /req\.get\('If-Match'\) \|\| body\.if_match/);
});

test('ordinary users can edit their own email and see activation status on their profile', () => {
  const view = read('custom/views/user.ejs');
  const editor = read('custom/views/user_edit.ejs');
  const authorization = read('custom/libs/authorization-v2.js');
  const identity = read('custom/modules/_api_v2_identity.js');
  assert.match(authorization, /profile:edit/);
  assert.match(editor, /修改邮箱时会弹出密码确认，修改后需要重新激活/);
  assert.match(editor, /autocomplete="email"/);
  assert.match(editor, /data-email-password-dialog/);
  assert.doesNotMatch(editor, /<form class="app-form" data-email-password-form>/);
  assert.match(editor, /确认修改邮箱/);
  assert.match(editor, /requestEmailPassword\(form\.elements\.email\.value\)/);
  assert.match(editor, /editingOwnAccount/);
  assert.match(editor, /emailChanged = editingOwnAccount/);
  assert.match(editor, /current_password: currentPassword/);
  assert.match(editor, /if_match: currentEtag/);
  assert.doesNotMatch(editor, /current_password: passwordCurrent/);
  assert.match(view, /appCanViewEmailActivation/);
  assert.match(view, /邮箱状态/);
  assert.match(view, /appEmailActivated \? '已激活' : '未激活'/);
  assert.match(view, /user\.is_email_verified/);
  assert.match(view, /appHasCapability\('admin:user\.manage'\)/);
  assert.match(identity, /\(emailChanged \|\| passwordChanged\) && !await syzoj\.utils\.verifyPassword\(body\.current_password, user\.password\)/);
});

test('registration identity accepts newly added colleges', () => {
  const registration = read('custom/modules/_registration_identity.js');
  assert.match(registration, /'电子信息学院',\s*'人工智能学院',\s*'柔性电子学院',\s*'自动化学院'/);
  assert.match(registration, /const COLLEGES = \[/);
  assert.match(registration, /COLLEGES\.includes\(next\.college\)/);
});
