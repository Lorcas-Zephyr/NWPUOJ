'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { settings, schema, answers, open, version, exportCsv, returnMailMessage } = require('../libs/activities');
const auth = require('../libs/authorization-v2');
const field = { id: 'f_phone', label: '联系方式', type: 'text', required: true, options: [] };
const config = { title: '校赛报名', description: '', location: '', mode: 'individual', status: 'published', opens_at: 100, closes_at: 200, fields: [field], require_review: true };

test('global activity permission is grantable independently of admin workspaces', () => {
  assert.deepEqual(auth.BUILT_IN_ROLES.activity_manager, ['activity:manage']);
  assert.equal(auth.LEGACY_ROLE_MAP.manage_activity, 'activity_manager');
  assert.ok(auth.BUILT_IN_ROLES.site_admin.includes('activity:manage'));
  assert.ok(!auth.BUILT_IN_ROLES.member.includes('activity:manage'));
  assert.ok(!auth.ADMIN_WORKSPACES.some(item => item.capability === 'activity:manage'));
});
test('validates registration modes, timelines, member bounds and field identities', () => {
  assert.equal(settings(config).min_members, 1);
  assert.equal(settings({ ...config, mode: 'team', min_members: 2, max_members: 3 }).max_members, 3);
  for (const patch of [{ mode: 'other' }, { status: 'unknown' }, { closes_at: 100 }, { opens_at: null }, { mode: 'team', min_members: 1, max_members: 3 }, { mode: 'team', min_members: 3, max_members: 2 }, { fields: [field, field] }]) assert.throws(() => settings({ ...config, ...patch }));
  assert.throws(() => schema([{ ...field, id: '__proto__' }]));
  assert.throws(() => schema([{ ...field, type: 'select', options: ['a', 'a'] }]));
  assert.throws(() => schema(Array.from({ length: 31 }, (_, i) => ({ ...field, id: 'f_' + i }))));
});
test('required, bounded and enumerated answers are enforced server-side', () => {
  const fields = schema([field, { id: 'f_options', label: '参加项目', type: 'checkbox', required: true, options: ['A', 'B'] }]);
  assert.throws(() => answers(fields, {}), /联系方式/);
  assert.throws(() => answers(fields, { f_phone: '123', f_options: [] }), /参加项目/);
  assert.throws(() => answers(fields, { f_phone: '123', f_options: ['other'] }), /选项/);
  assert.throws(() => answers(fields, { f_phone: '123', f_options: ['A', 'A'] }), /选项/);
  assert.throws(() => answers(fields, { f_phone: 'a'.repeat(501), f_options: ['A'] }));
  assert.deepEqual(answers(fields, { f_phone: ' 123 ', f_options: ['A'], real_name: 'forged' }), { f_phone: '123', f_options: ['A'] });
});
test('opening is inclusive, deadline exclusive and stale revisions are rejected', () => {
  open(config, 100); open(config, 199);
  for (const now of [99, 200, 201]) assert.throws(() => open(config, now));
  assert.throws(() => open({ ...config, status: 'closed' }, 150));
  assert.throws(() => version({ revision: 2 }, 1), /更新/);
  assert.throws(() => version({ revision: 2 }, undefined), /版本/);
  version({ revision: 2 }, 2);
});
test('CSV escapes formula injection, preserves student identifiers and multiline answers', () => {
  const output = exportCsv(settings(config), [{ id: 1, team_name: '=SUM(A1)', status: 'approved', review_note: '', leader_id: 1, submitted_at: 100, members: [{ user_id: 1, username: '@evil', real_name: '张"三', student_id: '0123456789', college: '计算机学院', email: 'person@example.test', answers: { f_phone: 'line1\nline2' } }] }]);
  assert.ok(output.startsWith('\uFEFF'));
  assert.match(output, /"'=SUM\(A1\)"/);
  assert.match(output, /"'@evil"/);
  assert.match(output, /"'0123456789"/);
  assert.match(output, /"张""三"/);
  assert.match(output, /"学院","邮箱","联系方式"/);
  assert.match(output, /"计算机学院","person@example.test","line1/);
  assert.match(output, /"line1\nline2"/);
});

test('return email uses the approved copy, Beijing deadline, escaped content and a direct registration link', () => {
  const mail = returnMailMessage({ id: 12, title: '<校赛>\r\n报名', closes_at: Date.parse('2026-11-18T00:59:00+08:00') },
    { review_note: '请核对 <img src=x onerror=alert(1)>\n补全姓名 & 学号' }, { username: '<someone>', email: ' person@example.test ' }, 'https://noj.nwpu.edu.cn');
  assert.deepEqual(mail.to, { address: 'person@example.test' });
  assert.match(mail.subject, /^【NWPUOJ】「.*」报名退回通知$/);
  assert.ok(!/[\r\n]/.test(mail.subject));
  assert.match(mail.html, /&lt;someone&gt;，您好/);
  assert.ok(!mail.html.includes('<img'));
  assert.match(mail.html, /&lt;img src=x onerror=alert\(1\)&gt;<br>补全姓名 &amp; 学号/);
  assert.match(mail.html, /2026\/11\/18 00:59（北京时间）/);
  assert.match(mail.html, /href="https:\/\/noj\.nwpu\.edu\.cn\/activities\/12\?tab=mine"/);
  assert.match(mail.text, /退回原因：\n请核对/);
  assert.match(mail.text, /在「我的报名」中查看并修改信息/);
  assert.match(mail.text, /NWPUOJ 活动管理团队$/);
  assert.throws(() => returnMailMessage({ id: 12 }, {}, {}, 'javascript:alert(1)'));
});
