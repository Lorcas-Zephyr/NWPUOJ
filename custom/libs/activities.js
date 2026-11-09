'use strict';

// All writes lock the activity first. This serializes roster changes, publication
// and review, including invitations accepted concurrently on different teams.
const STATES = ['draft', 'pending', 'approved', 'returned', 'rejected', 'withdrawn'];
const FIELD_TYPES = ['text', 'textarea', 'radio', 'checkbox', 'select'];
function fail(message, status = 422) { throw Object.assign(new Error(message), { statusCode: status }); }
function text(value, max, label, required = true) {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) fail(`${label}不能为空且不能超过 ${max} 个字符。`);
  return value.trim();
}
function integer(value, min, max, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) fail(`${label}应在 ${min} 到 ${max} 之间。`);
  return n;
}
function schema(value) {
  if (!Array.isArray(value) || value.length > 30) fail('报名表最多包含 30 个自定义字段。');
  const ids = new Set();
  return value.map(field => {
    if (!field || !/^f_[a-zA-Z0-9_-]{1,50}$/.test(field.id) || ids.has(field.id)) fail('字段编号无效或重复。');
    ids.add(field.id);
    if (!FIELD_TYPES.includes(field.type)) fail('字段类型无效。');
    const options = ['radio', 'checkbox', 'select'].includes(field.type) ? field.options : [];
    if (!Array.isArray(options) || options.length > 40 || (['radio', 'checkbox', 'select'].includes(field.type) && !options.length)) fail('选项字段需要 1–40 个选项。');
    const clean = options.map(option => text(option, 120, '选项'));
    if (new Set(clean).size !== clean.length) fail('字段选项不能重复。');
    return { id: field.id, type: field.type, label: text(field.label, 100, '字段名称'), required: field.required === true, options: clean };
  });
}
function answers(fields, input, complete = true) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('报名表格式无效。');
  const out = {};
  for (const field of fields) {
    const value = input[field.id] == null ? (field.type === 'checkbox' ? [] : '') : input[field.id];
    if (field.type === 'checkbox') {
      if (!Array.isArray(value) || value.length > field.options.length || value.some(v => !field.options.includes(v)) || new Set(value).size !== value.length) fail(`${field.label}的选项无效。`);
      out[field.id] = value;
    } else {
      if (typeof value !== 'string' || value.length > (field.type === 'textarea' ? 4000 : 500)) fail(`${field.label}内容过长或格式无效。`);
      out[field.id] = value.trim();
      if (value && ['select', 'radio'].includes(field.type) && !field.options.includes(value)) fail(`${field.label}的选项无效。`);
    }
    if (complete && field.required && !out[field.id].length) fail(`请填写${field.label}。`);
  }
  return out;
}
function settings(input) {
  const mode = input.mode;
  if (!['individual', 'team'].includes(mode)) fail('请选择个人报名或组队报名。');
  if (!['draft', 'published', 'closed'].includes(input.status)) fail('活动状态无效。');
  const opens = integer(input.opens_at, 1, 8640000000000000, '报名开始时间');
  const closes = integer(input.closes_at, 1, 8640000000000000, '报名截止时间');
  if (opens >= closes) fail('报名截止时间必须晚于开始时间。');
  const starts = input.starts_at ? integer(input.starts_at, 1, 8640000000000000, '活动时间') : null;
  const min = mode === 'team' ? integer(input.min_members, 2, 20, '最少人数') : 1;
  const max = mode === 'team' ? integer(input.max_members, min, 20, '最多人数') : 1;
  return { title: text(input.title, 120, '活动标题'), description: text(input.description || '', 60000, '活动介绍', false), location: text(input.location || '', 200, '地点', false), mode,
    status: input.status, opens_at: opens, closes_at: closes, starts_at: starts, min_members: min, max_members: max, require_review: input.require_review === true, fields: schema(input.fields) };
}
function open(activity, now) {
  if (activity.status !== 'published' || now < activity.opens_at || now >= activity.closes_at) fail('当前不在报名开放时间内。', 409);
}
function version(current, value) {
  if (!value) fail('缺少版本信息，请刷新页面。', 428);
  if (Number(value) !== Number(current.revision)) fail('信息已被更新，请刷新页面后重试。', 409);
}
function decodeActivity(row) { return row && { ...row, fields: JSON.parse(row.fields_json), require_review: !!row.require_review }; }
function decodeMember(row) { return { user_id: Number(row.user_id), ...JSON.parse(row.identity_json), answers: JSON.parse(row.answers_json), ready: !!row.ready }; }
function csvCell(value) {
  let s = String(value == null ? '' : value);
  if (/^\s*[=+\-@\t\r]/.test(s) || /^0\d+$/.test(s) || /^\d{10,}$/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
function exportCsv(activity, items) {
  const header = ['报名编号', '队名', '状态', '审核说明', '提交时间', '队长', '用户名', '姓名', '学号', '学院', ...activity.fields.map(f => f.label)];
  const rows = [header];
  for (const item of items) for (const member of item.members) rows.push([item.id, item.team_name, item.status, item.review_note, item.submitted_at ? new Date(Number(item.submitted_at)).toISOString() : '', Number(item.leader_id) === member.user_id ? '是' : '否', member.username, member.real_name, member.student_id, member.college, ...activity.fields.map(f => Array.isArray(member.answers[f.id]) ? member.answers[f.id].join('；') : member.answers[f.id])]);
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function createService({ connection, authorize, audit = async () => {}, now = Date.now }) {
  let schemaPromise;
  function ensureSchema() {
    if (!schemaPromise) schemaPromise = (async () => {
      const db = connection();
      await db.query(`CREATE TABLE IF NOT EXISTS activity (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,title VARCHAR(120) NOT NULL,description MEDIUMTEXT NOT NULL,location VARCHAR(200) NOT NULL,
        mode VARCHAR(16) NOT NULL,status VARCHAR(16) NOT NULL,opens_at BIGINT NOT NULL,closes_at BIGINT NOT NULL,starts_at BIGINT NULL,
        min_members INT NOT NULL,max_members INT NOT NULL,require_review TINYINT NOT NULL,fields_json TEXT NOT NULL,
        revision INT NOT NULL DEFAULT 1,created_by INT NOT NULL,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,
        KEY idx_activity_public(status,opens_at,id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      await db.query(`CREATE TABLE IF NOT EXISTS activity_registration (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,activity_id INT NOT NULL,leader_id INT NOT NULL,team_name VARCHAR(80) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'draft',review_note VARCHAR(1000) NOT NULL DEFAULT '',revision INT NOT NULL DEFAULT 1,
        snapshot_json MEDIUMTEXT NOT NULL,submitted_at BIGINT NULL,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,
        KEY idx_activity_registration(activity_id,status,id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      await db.query(`CREATE TABLE IF NOT EXISTS activity_member (
        activity_id INT NOT NULL,user_id INT NOT NULL,registration_id INT NOT NULL,student_id VARCHAR(10) NOT NULL,
        identity_json TEXT NOT NULL,answers_json TEXT NOT NULL,ready TINYINT NOT NULL DEFAULT 0,
        PRIMARY KEY(activity_id,user_id),UNIQUE KEY uq_activity_student(activity_id,student_id),KEY idx_activity_members(registration_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      await db.query(`CREATE TABLE IF NOT EXISTS activity_invitation (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,activity_id INT NOT NULL,registration_id INT NOT NULL,user_id INT NOT NULL,created_at BIGINT NOT NULL,
        UNIQUE KEY uq_activity_invitation(registration_id,user_id),KEY idx_activity_invitee(activity_id,user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    })().catch(error => { schemaPromise = null; throw error; });
    return schemaPromise;
  }
  async function canManage(user) { return !!(user && await authorize(user)); }
  async function manager(user) { if (!await canManage(user)) fail('您没有活动管理权限。', user ? 403 : 401); }
  function login(user) { if (!user) fail('请先登录。', 401); }
  async function get(id, db = connection(), lock = false) {
    const rows = await db.query('SELECT * FROM activity WHERE id=?' + (lock ? ' FOR UPDATE' : ''), [id]);
    if (!rows[0]) fail('活动不存在。', 404);
    return decodeActivity(rows[0]);
  }
  async function visible(id, user, db = connection()) {
    const a = await get(id, db);
    if (a.status === 'draft' && !await canManage(user)) fail('活动不存在。', 404);
    return a;
  }
  async function identity(db, userId) {
    const rows = await db.query(`SELECT u.id AS user_id,u.username,p.real_name,p.student_id,p.college,p.student_id_scope,t.user_id AS temporary_id
      FROM user u LEFT JOIN user_registration_profile p ON p.user_id=u.id
      LEFT JOIN temporary_contest_account t ON t.user_id=u.id WHERE u.id=?`, [userId]);
    const row = rows[0];
    if (!row || row.temporary_id || row.student_id_scope !== 'ordinary') fail('请使用本人普通 OJ 账户报名。');
    if (!/^\d{10}$/.test(row.student_id || '') || !row.real_name || !row.college) fail('请先在账号设置中补全姓名、十位学号和学院。');
    return { user_id: Number(row.user_id), username: row.username, real_name: row.real_name, student_id: row.student_id, college: row.college };
  }
  async function registration(db, id) {
    const rows = await db.query('SELECT * FROM activity_registration WHERE id=?', [id]);
    if (!rows[0]) fail('报名记录不存在。', 404);
    const row = rows[0];
    const members = await db.query('SELECT * FROM activity_member WHERE registration_id=? ORDER BY user_id', [id]);
    return { ...row, members: row.status === 'withdrawn' ? JSON.parse(row.snapshot_json) : members.map(decodeMember) };
  }
  async function saveRegistration(db, r, action, user, context) {
    const members = (await db.query('SELECT * FROM activity_member WHERE registration_id=? ORDER BY user_id', [r.id])).map(decodeMember);
    await db.query('UPDATE activity_registration SET team_name=?,status=?,review_note=?,snapshot_json=?,revision=revision+1,submitted_at=?,updated_at=? WHERE id=?',
      [r.team_name, r.status, r.review_note, JSON.stringify(r.status === 'withdrawn' ? r.members : members), r.submitted_at, now(), r.id]);
    await audit(db, { action: `activity:${action}`, activityId: r.activity_id, registrationId: r.id, actorId: user.id, status: r.status }, context);
  }
  async function join(db, a, r, userId) {
    const person = await identity(db, userId);
    const duplicate = await db.query('SELECT user_id FROM activity_member WHERE activity_id=? AND (user_id=? OR student_id=?)', [a.id, userId, person.student_id]);
    if (duplicate.length) fail('您已在该活动报名或加入其他队伍。', 409);
    await db.query('INSERT INTO activity_member(activity_id,user_id,registration_id,student_id,identity_json,answers_json,ready) VALUES(?,?,?,?,?,?,0)', [a.id, userId, r.id, person.student_id, JSON.stringify(person), '{}']);
    await db.query('DELETE FROM activity_invitation WHERE activity_id=? AND user_id=?', [a.id, userId]);
  }
  async function list(user, page = 1) {
    await ensureSchema();
    const managed = await canManage(user);
    page = integer(page, 1, 100000, '页码');
    const where = managed ? '' : "WHERE status<>'draft'";
    const items = await connection().query(`SELECT id,title,location,mode,status,opens_at,closes_at,starts_at,min_members,max_members FROM activity ${where} ORDER BY id DESC LIMIT 30 OFFSET ?`, [(page - 1) * 30]);
    const count = await connection().query(`SELECT COUNT(*) AS n FROM activity ${where}`);
    return { items, total: Number(count[0].n), page, can_manage: managed };
  }
  async function detail(id, user) {
    await ensureSchema();
    // A consistent read prevents displaying half of a simultaneous roster change.
    return connection().transaction(async db => {
      const a = await visible(id, user, db);
      const result = { activity: a, can_manage: await canManage(user), mine: null, invitations: [], identity: null, identity_error: '', user_id: user ? Number(user.id) : null, server_now: now() };
      if (user) {
        try { result.identity = await identity(db, user.id); } catch (error) { result.identity_error = error.message; }
        const rows = await db.query('SELECT registration_id FROM activity_member WHERE activity_id=? AND user_id=?', [id, user.id]);
        if (rows.length) {
          result.mine = await registration(db, rows[0].registration_id);
          // Each member controls their answers. Teammates see only public names
          // and completion state; organizers alone see everyone's identity.
          result.mine.members = result.mine.members.map(m => m.user_id === Number(user.id) ? m : { user_id: m.user_id, username: m.username, ready: m.ready });
          delete result.mine.snapshot_json;
          if (Number(result.mine.leader_id) === Number(user.id)) result.mine.invitations = await db.query('SELECT i.id,u.username FROM activity_invitation i JOIN user u ON u.id=i.user_id WHERE i.registration_id=?', [result.mine.id]);
        }
        result.invitations = await db.query(`SELECT i.id,r.team_name,u.username AS leader_username FROM activity_invitation i JOIN activity_registration r ON r.id=i.registration_id JOIN user u ON u.id=r.leader_id WHERE i.activity_id=? AND i.user_id=? AND r.status IN ('draft','returned')`, [id, user.id]);
      }
      delete a.fields_json;
      return result;
    });
  }
  async function create(user, input, context) {
    await manager(user); await ensureSchema();
    const a = settings(input);
    return connection().transaction(async db => {
      const result = await db.query('INSERT INTO activity(title,description,location,mode,status,opens_at,closes_at,starts_at,min_members,max_members,require_review,fields_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [a.title, a.description, a.location, a.mode, a.status, a.opens_at, a.closes_at, a.starts_at, a.min_members, a.max_members, a.require_review ? 1 : 0, JSON.stringify(a.fields), user.id, now(), now()]);
      await audit(db, { action: 'activity:create', activityId: result.insertId, actorId: user.id }, context);
      return { id: Number(result.insertId) };
    });
  }
  async function update(id, user, input, context) {
    await manager(user); await ensureSchema();
    const next = settings(input);
    return connection().transaction(async db => {
      const a = await get(id, db, true); version(a, input.revision);
      const count = await db.query('SELECT COUNT(*) AS n FROM activity_registration WHERE activity_id=?', [id]);
      if (Number(count[0].n) && (next.mode !== a.mode || next.min_members !== a.min_members || next.max_members !== a.max_members || next.require_review !== a.require_review || JSON.stringify(next.fields) !== JSON.stringify(a.fields))) fail('已有报名记录后，报名方式、人数限制、审核规则和表单字段不可修改；可复制活动后调整。', 409);
      if (Number(count[0].n) && next.status === 'draft' && a.status !== 'draft') fail('已有报名的活动不能退回草稿，可关闭报名。', 409);
      await db.query('UPDATE activity SET title=?,description=?,location=?,mode=?,status=?,opens_at=?,closes_at=?,starts_at=?,min_members=?,max_members=?,require_review=?,fields_json=?,revision=revision+1,updated_at=? WHERE id=?',
        [next.title, next.description, next.location, next.mode, next.status, next.opens_at, next.closes_at, next.starts_at, next.min_members, next.max_members, next.require_review ? 1 : 0, JSON.stringify(next.fields), now(), id]);
      await audit(db, { action: 'activity:update', activityId: id, actorId: user.id }, context);
      return { id: Number(id) };
    });
  }
  async function copy(id, user, context) {
    await manager(user); await ensureSchema();
    const a = await get(id);
    return create(user, { ...a, title: (a.title + '（副本）').slice(0, 120), status: 'draft' }, context);
  }
  async function start(id, user, input, context) {
    login(user); await ensureSchema();
    return connection().transaction(async db => {
      const a = await get(id, db, true); open(a, now());
      const teamName = a.mode === 'team' ? text(input.team_name, 80, '队伍名称') : '';
      const result = await db.query("INSERT INTO activity_registration(activity_id,leader_id,team_name,status,snapshot_json,created_at,updated_at) VALUES(?,?,?,'draft','[]',?,?)", [id, user.id, teamName, now(), now()]);
      const r = { id: Number(result.insertId), activity_id: id, team_name: teamName, status: 'draft', review_note: '', submitted_at: null };
      await join(db, a, r, user.id);
      await saveRegistration(db, r, 'registration.create', user, context);
      return { id: r.id };
    });
  }
  async function change(id, user, input, context) {
    login(user); await ensureSchema();
    return connection().transaction(async db => {
      const a = await get(id, db, true); open(a, now());
      const rows = await db.query('SELECT registration_id FROM activity_member WHERE activity_id=? AND user_id=?', [id, user.id]);
      if (!rows.length) fail('您还没有加入报名。', 404);
      const r = await registration(db, rows[0].registration_id); version(r, input.revision);
      const leader = Number(r.leader_id) === Number(user.id);
      const editing = ['draft', 'returned'].includes(r.status);
      const action = input.action;
      const requireLeader = () => { if (!leader) fail('只有队长可以执行此操作。', 403); };
      if (action === 'save') {
        if (r.status === 'rejected') fail('此报名已被拒绝，不能修改。', 409);
        const clean = answers(a.fields, input.answers, true);
        const own = r.members.find(member => member.user_id === Number(user.id));
        const teamName = leader && a.mode === 'team' ? text(input.team_name, 80, '队伍名称') : r.team_name;
        const changed = JSON.stringify(clean) !== JSON.stringify(own.answers) || teamName !== r.team_name;
        await db.query('UPDATE activity_member SET answers_json=?,ready=1 WHERE activity_id=? AND user_id=?', [JSON.stringify(clean), id, user.id]);
        r.team_name = teamName;
        if (changed && ['approved', 'pending'].includes(r.status)) { r.status = a.require_review ? 'pending' : 'approved'; r.review_note = ''; }
      } else if (action === 'submit') {
        requireLeader();
        if (!editing) fail('当前报名状态不能提交。', 409);
        if (r.members.length < a.min_members || r.members.length > a.max_members) fail(`需有 ${a.min_members}–${a.max_members} 位已确认成员才能提交。`);
        for (const member of r.members) { if (!member.ready) fail(`${member.username}尚未保存并确认报名信息。`); answers(a.fields, member.answers); }
        r.status = a.require_review ? 'pending' : 'approved'; r.review_note = ''; r.submitted_at = now();
        await db.query('DELETE FROM activity_invitation WHERE registration_id=?', [r.id]);
      } else if (action === 'withdraw') {
        requireLeader(); r.status = 'withdrawn';
        await db.query('DELETE FROM activity_member WHERE registration_id=?', [r.id]);
        await db.query('DELETE FROM activity_invitation WHERE registration_id=?', [r.id]);
      } else if (action === 'leave' || action === 'remove-member') {
        if (a.mode !== 'team') fail('仅组队报名支持成员调整。');
        if (action === 'remove-member') { requireLeader(); if (!editing) fail('请先退回修改状态后调整成员，或撤回整队报名。', 409); }
        const target = action === 'leave' ? Number(user.id) : integer(input.user_id, 1, 2147483647, '用户编号');
        if (target === Number(r.leader_id)) fail('队长不能退出，请撤回整队报名。');
        if (!r.members.some(m => m.user_id === target)) fail('该用户不在队伍中。', 404);
        await db.query('DELETE FROM activity_member WHERE registration_id=? AND user_id=?', [r.id, target]);
        r.status = 'draft'; r.review_note = ''; r.submitted_at = null;
      } else if (action === 'invite') {
        requireLeader(); if (a.mode !== 'team' || !editing) fail('当前状态不能邀请成员。', 409);
        if (r.members.length >= a.max_members) fail('队伍人数已满。', 409);
        const pending = await db.query('SELECT COUNT(*) AS n FROM activity_invitation WHERE registration_id=?', [r.id]);
        if (Number(pending[0].n) >= 20) fail('待确认的邀请最多 20 个。');
        const target = await db.query('SELECT id FROM user WHERE username=?', [text(input.username, 80, '用户名')]);
        if (!target[0]) fail('未找到该用户。', 404);
        await identity(db, target[0].id);
        const occupied = await db.query('SELECT user_id FROM activity_member WHERE activity_id=? AND user_id=?', [id, target[0].id]);
        if (occupied.length) fail('该用户已报名或加入队伍。', 409);
        await db.query('INSERT IGNORE INTO activity_invitation(activity_id,registration_id,user_id,created_at) VALUES(?,?,?,?)', [id, r.id, target[0].id, now()]);
      } else if (action === 'cancel-invitation') {
        requireLeader();
        await db.query('DELETE FROM activity_invitation WHERE registration_id=? AND id=?', [r.id, integer(input.invitation_id, 1, 2147483647, '邀请编号')]);
      } else fail('不支持的报名操作。');
      await saveRegistration(db, r, `registration.${action}`, user, context);
      return { id: r.id, status: r.status };
    });
  }
  async function invitation(id, invitationId, user, input, context) {
    login(user); await ensureSchema();
    return connection().transaction(async db => {
      const a = await get(id, db, true); open(a, now());
      const rows = await db.query('SELECT * FROM activity_invitation WHERE id=? AND activity_id=? AND user_id=?', [invitationId, id, user.id]);
      if (!rows.length) fail('邀请不存在或已失效。', 404);
      const r = await registration(db, rows[0].registration_id);
      if (input.action === 'accept') {
        if (a.mode !== 'team' || !['draft', 'returned'].includes(r.status) || r.members.length >= a.max_members) fail('该队伍已满或已提交报名。', 409);
        await join(db, a, r, user.id);
      } else if (input.action !== 'decline') fail('邀请操作无效。');
      await db.query('DELETE FROM activity_invitation WHERE id=?', [invitationId]);
      await saveRegistration(db, r, `invitation.${input.action}`, user, context);
      return { id: r.id };
    });
  }
  async function roster(id, user, query = {}) {
    await manager(user); await ensureSchema();
    const page = integer(query.page || 1, 1, 100000, '页码');
    const search = String(query.search || '').trim().slice(0, 100);
    if (query.status && !STATES.includes(query.status)) fail('报名状态无效。');
    const params = [id];
    let where = 'activity_id=?';
    if (query.status) { where += ' AND status=?'; params.push(query.status); }
    if (search) { where += ' AND (LOCATE(?,team_name)>0 OR LOCATE(?,snapshot_json)>0)'; params.push(search, search); }
    return connection().transaction(async db => {
      const a = await get(id, db);
      const counts = await db.query(`SELECT COUNT(*) AS n FROM activity_registration WHERE ${where}`, params);
      if (query.export && Number(counts[0].n) > 10000) fail('导出最多支持 10000 份报名，请按状态或关键词筛选。');
      const rows = await db.query(`SELECT * FROM activity_registration WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, query.export ? 10000 : 30, query.export ? 0 : (page - 1) * 30]);
      const items = rows.map(row => { const item = { ...row, members: JSON.parse(row.snapshot_json) }; delete item.snapshot_json; return item; });
      return { activity: a, items, total: Number(counts[0].n), page };
    });
  }
  async function review(id, registrationId, user, input, context) {
    await manager(user); await ensureSchema();
    return connection().transaction(async db => {
      await get(id, db, true);
      const r = await registration(db, registrationId);
      if (Number(r.activity_id) !== Number(id)) fail('报名记录不存在。', 404);
      version(r, input.revision);
      if (!['pending', 'approved', 'returned', 'rejected'].includes(r.status) || !['approved', 'returned', 'rejected'].includes(input.status)) fail('当前报名状态不能审核。', 409);
      r.review_note = text(input.note || '', 1000, '审核说明', input.status !== 'approved'); r.status = input.status;
      await saveRegistration(db, r, 'registration.review', user, context);
      return { id: r.id, status: r.status };
    });
  }
  return { ensureSchema, canManage, list, detail, create, update, copy, start, change, invitation, roster, review };
}
module.exports = { createService, settings, schema, answers, open, version, exportCsv };
