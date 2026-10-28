'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('profile heading and public username reuse the shared tag renderer without self links', () => {
  const view = read('custom/views/user.ejs');
  assert.match(view, /<h1[^>]*>[\s\S]*?renderUsername\(show_user, \{ noLink: true \}\)[\s\S]*?<\/h1>/);
  assert.match(view, /<dt>用户名<\/dt><dd><%- syzoj\.utils\.renderUsername\(show_user, \{ noLink: true \}\) %><\/dd>/);
  assert.equal((view.match(/renderUsername\(show_user, \{ noLink: true \}\)/g) || []).length, 2);
  const css = read('custom/app-features.css');
  assert.match(css, /\.app-profile-identity h1\s*\{[^}]*flex-wrap:\s*wrap/);
});

test('profile tag rendering follows the shown user, visibility, class tags and escaping rules', () => {
  const syzoj = { utils: {}, userTagsEnabled: true, userTags: new Map([
    [7, { text: '<svg onload=1>', tier: 'blue' }],
    [8, { text: '浏览者标签', tier: 'red' }]
  ]), userClassTags: new Map([[7, [
    { name: '班级<甲>', tag: '甲班' }, { name: '班级乙', tag: '乙班' }, { name: '班级丙', tag: '丙班' }
  ]]]) };
  vm.runInNewContext(read('custom/modules/_username_renderer.js'), { syzoj });
  const shown = { id: 7, username: '<张三>' };
  let html = syzoj.utils.renderUsername(shown, { noLink: true });
  assert.match(html, /&lt;张三&gt;/);
  assert.match(html, /&lt;svg onload=1&gt;/);
  assert.match(html, /title="班级：班级&lt;甲&gt;"/);
  assert.match(html, /甲班/); assert.match(html, /乙班/); assert.match(html, />\+1<\/span>/);
  assert.doesNotMatch(html, /<a\b|<svg\b|浏览者标签/);
  syzoj.userTagsEnabled = false;
  html = syzoj.utils.renderUsername(shown, { noLink: true });
  assert.doesNotMatch(html, /onload/);
  assert.match(html, /甲班/); // Class membership is separate from custom nameplates.
  syzoj.userTagsEnabled = true;
  syzoj.userTags.delete(7); // Invisible/disabled nameplates are omitted by the existing cache.
  assert.doesNotMatch(syzoj.utils.renderUsername(shown, { noLink: true }), /onload/);
  syzoj.cheaterUserIds = new Set([7]);
  html = syzoj.utils.renderUsername(shown, { noLink: true });
  assert.match(html, /username-tier-cheater/);
  assert.doesNotMatch(html, /tag-tier-cheater|作弊者/);
  assert.match(html, /甲班/);
  assert.doesNotMatch(syzoj.utils.renderUsername({ id: 99, username: '无标签' }, { noLink: true }), /user-name-tag/);
});

test('cheater name tags stay hidden across profiles and submission lists without changing marks or other users', () => {
  const syzoj = { utils: {}, userTagsEnabled: true,
    userTags: new Map([[7, { text: '原自定义牌子', tier: 'blue' }], [8, { text: '普通牌子', tier: 'green' }], [9, { text: '管理员', tier: 'admin' }]]),
    cheaterUserIds: new Set([7, 9]), adminUserIds: new Set([9]),
    userClassTags: new Map([[7, [{ name: '测试班级', tag: '测试班' }]]]) };
  const context = { syzoj };
  vm.runInNewContext(read('custom/modules/_username_renderer.js'), context);
  const template = read('custom/views/submissions.ejs');
  vm.runInNewContext(template.slice(template.indexOf('function submissionUserTag('), template.indexOf('function submissionLink(')), context);
  for (const options of [{}, { noLink: true }]) {
    const html = syzoj.utils.renderUsername({ id: 7, username: 'fixture-cheater' }, options);
    assert.match(html, /username-tier-cheater/);
    assert.match(html, /测试班/);
    assert.doesNotMatch(html, /tag-tier-cheater|作弊者|原自定义牌子/);
    assert.match(syzoj.utils.renderUsername({ id: 8, username: 'fixture-user' }, options), /普通牌子/);
    assert.match(syzoj.utils.renderUsername({ id: 9, username: 'fixture-admin' }, options), /管理员/);
  }
  assert.equal(context.submissionUserTag(7), null);
  assert.equal(context.submissionUserTag(8).text, '普通牌子');
  assert.equal(context.submissionUserTag(9).text, '管理员');
  assert.equal(syzoj.cheaterUserIds.has(7), true);
  assert.equal(syzoj.userTags.get(7).text, '原自定义牌子');
  syzoj.userTagsEnabled = false;
  assert.equal(context.submissionUserTag(7), null);
  assert.equal(context.submissionUserTag(8), null);
  assert.doesNotMatch(syzoj.utils.renderUsername({ id: 7, username: 'fixture-cheater' }), /作弊者|原自定义牌子/);
  syzoj.userTagsEnabled = true;
  syzoj.cheaterUserIds.delete(7);
  assert.match(syzoj.utils.renderUsername({ id: 7, username: 'fixture-user' }), /原自定义牌子/);
  assert.equal(context.submissionUserTag(7).text, '原自定义牌子');
  assert.doesNotMatch(read('custom/views/user_edit.ejs'), /当前牌子被“作弊者”身份覆盖/);
  assert.match(template, /adminActionType === 'cheated'\) return '作弊'/);
});

test('client username color map matches the server renderer for all Hit tiers and overrides', () => {
  const syzoj = { utils: {}, adminUserIds: new Set([1]), cheaterUserIds: new Set([1, 7]),
    userHitScores: new Map([[1, { total: 0 }], [2, { total: 350 }], [3, { total: 280 }],
      [4, { total: 200 }], [5, { total: 100 }], [6, { total: 0 }], [7, { total: 400 }], [8, { total: 99 }]]) };
  const context = { syzoj };
  vm.runInNewContext(read('custom/modules/_username_renderer.js'), context);
  const header = read('custom/views/app_header.ejs');
  const map = vm.runInNewContext(header.slice(header.indexOf('let appTierMap ='), header.indexOf('const appCheatedJudgeIds =')) + '\nappTierMap;', context);
  for (let id = 1; id <= 9; id++) assert.equal(map[id] || 'default', syzoj.utils.calcUserTier({ id }));
  assert.equal(map[1], 'admin');
  assert.equal(map[7], 'cheater');
  assert.equal(map[6], 'gray');
});

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
  assert.match(registration, /'生命科学与技术学院',\s*'生命科学与医学学部'/);
  assert.match(registration, /colleges: COLLEGES/);
  assert.match(registration, /registrationColleges: COLLEGES/);
  const context = vm.createContext({});
  vm.runInContext(registration.match(/const COLLEGES = \[[\s\S]*?\];/)[0] + '\n' +
    registration.slice(registration.indexOf('function cleanText('), registration.indexOf('async function findProfile(')), context);
  for (const college of ['生命科学与技术学院', '生命科学与医学学部']) {
    const identity = context.validateIdentity({ student_id: '2026000001', real_name: '测试用户', college }, true);
    assert.equal(identity.college, college);
  }
  assert.throws(() => context.validateIdentity({ student_id: '2026000001', real_name: '测试用户', college: '不存在的学院' }, true),
    error => error.registrationCode === 2013);
});
