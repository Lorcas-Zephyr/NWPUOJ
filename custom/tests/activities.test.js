'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { settings, schema, answers, open, version, exportXlsx, returnMailMessage } = require('../libs/activities');
const ExcelJS = require('exceljs');
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
test('Excel preserves numeric identifiers as text without apostrophes or formulas', async () => {
  const cases = ['2026303160', '0123456789', '1254492234', '70774954', '12345678901234567890', '=HYPERLINK("https://example.test","click")', '+123', '-123', '@SUM(A1)', '\t=1+1', '张"三 & <四>\n第二行', "'original", '0000000000'];
  const output = await exportXlsx(settings({ ...config, fields: [field, { id: 'f_options', label: '参加项目', type: 'checkbox', required: false, options: ['A', 'B'] }] }), cases.map((value, index) => ({
    id: index + 1, team_name: '=SUM(A1)', status: 'approved', review_note: '', leader_id: index + 1, submitted_at: 100,
    members: [{ user_id: index + 1, username: value, real_name: '张"三', student_id: value, college: '计算机学院', email: 'person@example.test', answers: { f_phone: value, f_options: ['A', 'B'] } }]
  })));
  assert.ok(Buffer.isBuffer(output));
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(output);
  const sheet = workbook.getWorksheet('报名信息');
  assert.equal(sheet.rowCount, cases.length + 1);
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['报名编号', '队名', '状态', '审核说明', '提交时间', '队长', '用户名', '姓名', '学号', '学院', '邮箱', '联系方式', '参加项目']);
  for (const [index, value] of cases.entries()) {
    const row = sheet.getRow(index + 2);
    assert.equal(row.getCell(1).value, index + 1);
    assert.equal(row.getCell(1).type, ExcelJS.ValueType.Number);
    for (const column of [7, 9, 12]) {
      const cell = row.getCell(column);
      assert.equal(cell.value, value, 'raw text survives export without any added character');
      assert.equal(cell.type, ExcelJS.ValueType.String);
      assert.equal(cell.numFmt, '@');
      assert.equal(cell.formula, undefined);
    }
    assert.equal(row.getCell(2).value, '=SUM(A1)');
    assert.equal(row.getCell(2).type, ExcelJS.ValueType.String);
    assert.equal(row.getCell(6).value, '是');
    assert.equal(row.getCell(8).value, '张"三');
    assert.equal(row.getCell(11).value, 'person@example.test');
    assert.equal(row.getCell(13).value, 'A；B');
  }
  assert.equal(sheet.views[0].state, 'frozen');
  assert.equal(sheet.views[0].ySplit, 1);
  assert.equal(sheet.autoFilter, `A1:M${cases.length + 1}`);
});

test('Excel export supports an empty filtered roster', async () => {
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await exportXlsx(settings(config), []));
  assert.equal(workbook.worksheets[0].rowCount, 1);
  assert.equal(workbook.worksheets[0].getCell('L1').value, '联系方式');
});

test('registration download serves a filtered Excel file through the authorized roster service', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const routes = new Map(), calls = [], headers = {};
  const activity = settings(config), items = [{ id: 4, team_name: '', status: 'approved', leader_id: 3, members: [{ user_id: 3, username: '2026303160', student_id: '0123456789', email: 'person@example.test', answers: { f_phone: '1254492234' } }] }];
  let forbidden = false, sent;
  const service = { ensureSchema: async () => {}, roster: async (id, user, query) => { calls.push({ id, user, query }); if (forbidden) throw Object.assign(new Error('您没有活动管理权限。'), { statusCode: 403 }); return { activity, items, total: 1 }; } };
  const user = { id: 99 };
  vm.runInNewContext(fs.readFileSync(require.resolve('../modules/_activities'), 'utf8'), {
    require: name => name === '../libs/activities' ? { createService: () => service, exportXlsx } : name === '../libs/registration-profile-schema' ? { ensureRegistrationProfileSchema: async () => {} } : {},
    app: Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [method, (path, handler) => { routes.set(method + ' ' + path, handler); }])),
    syzoj: { utils: { ensureTemporaryContestAccountSchema: async () => {}, apiV2: { ensureFoundationSchema: async () => {}, fail: (res, status) => { res.status = status; } }, authorizationV2: { recordAudit: async (req, event) => { calls.push(event); } } } }
  });
  const handler = routes.get('get /api/v2/activities/:id/registrations/export');
  const req = { params: { id: '12' }, query: { search: '2026303160', status: 'approved' } };
  const res = { locals: { user }, headersSent: false, set: (key, value) => { headers[key] = value; }, send: data => { sent = data; res.headersSent = true; } };
  await handler(req, res, error => { throw error; });
  assert.equal(calls[0].id, 12); assert.equal(calls[0].user, user);
  assert.deepEqual({ ...calls[0].query }, { ...req.query, export: true });
  assert.equal(calls[1].action, 'activity:registration.export');
  assert.equal(headers['Content-Type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(headers['Content-Disposition'], 'attachment; filename="activity-12.xlsx"');
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(sent);
  assert.equal(workbook.worksheets[0].getCell('I2').value, '0123456789');
  assert.equal(workbook.worksheets[0].getCell('L2').value, '1254492234');
  forbidden = true; sent = undefined; res.headersSent = false;
  await handler(req, res, error => { throw error; });
  assert.equal(res.status, 403); assert.equal(sent, undefined);
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
