const multer = require('multer');
const TypeORM = require('typeorm');
const classGroups = require('../libs/class-groups');
const contestMutation = require('../libs/contest-mutation');
const { normalizeStudentIdRows } = require('../libs/contest-temp-accounts');
const { ensureRegistrationProfileSchema, ORDINARY_STUDENT_ID_SCOPE } = require('../libs/registration-profile-schema');

const Contest = syzoj.model('contest');
const classCsvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => callback(/\.csv$/i.test(String(file.originalname || '')) ? null : new Error('仅支持 .csv 文件。'), /\.csv$/i.test(String(file.originalname || '')))
}).single('student_ids_csv');

function apiError(res, status, code, message, fields) {
  return syzoj.utils.apiV2.fail(res, status, code, message, fields || {});
}

function normalizeGroupInput(body, current) {
  const name = String(body && body.name != null ? body.name : current && current.name || '').trim();
  const tag = String(body && body.tag_text != null ? body.tag_text : current && current.tag_text || '').trim();
  if (!name || name.length > 80) throw Object.assign(new Error('班级名称不能为空且不能超过 80 个字符。'), { field: 'name' });
  if (!tag || Array.from(tag).length > 12) throw Object.assign(new Error('班级标签不能为空且不能超过 12 个字符。'), { field: 'tag_text' });
  return {
    name,
    tag,
    allowImport: body && body.allow_activity_import == null
      ? !!(current ? current.allow_activity_import : true)
      : ['1', 'true', 'on'].includes(String(body.allow_activity_import).toLowerCase()) || body.allow_activity_import === true
  };
}

async function requireClassManager(req, res) {
  const group = await classGroups.findById(req.params.id || req.params.classId);
  if (!group || group.status !== 'active') {
    apiError(res, 404, 'RESOURCE_NOT_FOUND', '班级不存在。');
    return null;
  }
  if (!await classGroups.canManageClass(res.locals.user, group)) {
    apiError(res, res.locals.user ? 403 : 401, res.locals.user ? 'CAPABILITY_REQUIRED' : 'AUTHENTICATION_REQUIRED', res.locals.user ? '您只能管理自己创建的班级。' : '请登录后继续。');
    return null;
  }
  return group;
}

async function ordinaryUsersByStudentIds(studentIds) {
  await ensureRegistrationProfileSchema();
  if (!studentIds.length) return new Map();
  const rows = await TypeORM.getConnection().query(
    `SELECT profile.student_id,profile.user_id,user.username,profile.real_name,profile.college
       FROM user_registration_profile profile
       INNER JOIN user ON user.id=profile.user_id
       LEFT JOIN temporary_contest_account temporary_account ON temporary_account.user_id=profile.user_id
      WHERE profile.student_id_scope=? AND profile.student_id IN (?) AND temporary_account.user_id IS NULL`,
    [ORDINARY_STUDENT_ID_SCOPE, studentIds]
  );
  return new Map(rows.map(row => [String(row.student_id), row]));
}

async function addClassMembers(group, studentIds, actorId) {
  const accounts = await ordinaryUsersByStudentIds(studentIds);
  const missing = studentIds.filter(studentId => !accounts.has(studentId));
  let added = 0;
  for (const studentId of studentIds) {
    const account = accounts.get(studentId);
    if (!account) continue;
    const result = await TypeORM.getConnection().query(
      'INSERT IGNORE INTO class_group_member (class_id,user_id,added_by,created_at) VALUES (?,?,?,UTC_TIMESTAMP(3))',
      [group.id, account.user_id, actorId]
    );
    if (Number(result.affectedRows || 0)) added++;
  }
  await classGroups.refreshCache();
  return { accounts, missing, added };
}

app.get('/classes', async (req, res) => {
  try {
    if (!await classGroups.canManageUsers(res.locals.user)) throw Object.assign(new Error('您没有班级管理权限。'), { statusCode: res.locals.user ? 403 : 401 });
    await classGroups.ensureSchema();
    const unrestricted = classGroups.isUnrestricted(res.locals.user);
    const rows = await TypeORM.getConnection().query(
      `SELECT group_table.*,owner.username AS owner_username,COUNT(member.user_id) AS member_count
         FROM class_group group_table
         INNER JOIN user owner ON owner.id=group_table.owner_id
         LEFT JOIN class_group_member member ON member.class_id=group_table.id
        WHERE group_table.status='active' ${unrestricted ? '' : 'AND group_table.owner_id=?'}
        GROUP BY group_table.id ORDER BY group_table.updated_at DESC,group_table.id DESC`,
      unrestricted ? [] : [res.locals.user.id]
    );
    res.render('classes', { classes: rows });
  } catch (error) {
    res.status(error.statusCode || 500).render('error', { err: error });
  }
});

app.get('/class/:id', async (req, res) => {
  try {
    const group = await classGroups.findById(req.params.id);
    if (!group || group.status !== 'active' || !await classGroups.canManageClass(res.locals.user, group)) throw Object.assign(new Error('班级不存在或您没有管理权限。'), { statusCode: 404 });
    const members = await TypeORM.getConnection().query(
      `SELECT member.user_id,member.created_at,user.username,profile.student_id,profile.real_name,profile.college
         FROM class_group_member member INNER JOIN user ON user.id=member.user_id
         LEFT JOIN user_registration_profile profile ON profile.user_id=member.user_id
        WHERE member.class_id=? ORDER BY profile.student_id,user.username`,
      [group.id]
    );
    res.render('class_detail', { classGroup: group, members });
  } catch (error) {
    res.status(error.statusCode || 500).render('error', { err: error });
  }
});

app.post('/api/v2/classes', async (req, res) => {
  if (!await classGroups.canManageUsers(res.locals.user)) return apiError(res, res.locals.user ? 403 : 401, res.locals.user ? 'CAPABILITY_REQUIRED' : 'AUTHENTICATION_REQUIRED', '您没有班级管理权限。');
  try {
    await classGroups.ensureSchema();
    const input = normalizeGroupInput(req.body, null);
    const result = await TypeORM.getConnection().query(
      'INSERT INTO class_group (name,tag_text,owner_id,allow_activity_import,status,revision,created_at,updated_at) VALUES (?,?,?,?,\'active\',1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',
      [input.name, input.tag, res.locals.user.id, input.allowImport ? 1 : 0]
    );
    await classGroups.refreshCache();
    return syzoj.utils.apiV2.send(res, { id: Number(result.insertId), name: input.name, tag_text: input.tag }, 201);
  } catch (error) {
    return apiError(res, 422, 'VALIDATION_FAILED', error.message, error.field ? { [error.field]: 'invalid' } : {});
  }
});

app.patch('/api/v2/classes/:id', async (req, res) => {
  const group = await requireClassManager(req, res);
  if (!group) return;
  try {
    const input = normalizeGroupInput(req.body, group);
    await TypeORM.getConnection().query(
      'UPDATE class_group SET name=?,tag_text=?,allow_activity_import=?,revision=revision+1,updated_at=UTC_TIMESTAMP(3) WHERE id=?',
      [input.name, input.tag, input.allowImport ? 1 : 0, group.id]
    );
    await classGroups.refreshCache();
    return syzoj.utils.apiV2.send(res, { id: Number(group.id), name: input.name, tag_text: input.tag, allow_activity_import: input.allowImport });
  } catch (error) {
    return apiError(res, 422, 'VALIDATION_FAILED', error.message, error.field ? { [error.field]: 'invalid' } : {});
  }
});

app.delete('/api/v2/classes/:id', async (req, res) => {
  const group = await requireClassManager(req, res);
  if (!group) return;
  await TypeORM.getConnection().query("UPDATE class_group SET status='archived',revision=revision+1,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [group.id]);
  await classGroups.refreshCache();
  return syzoj.utils.apiV2.send(res, { id: Number(group.id), archived: true });
});

app.post('/api/v2/classes/:id/members', async (req, res) => {
  const group = await requireClassManager(req, res);
  if (!group) return;
  const requestedUserId = Number(req.body && req.body.user_id);
  if (Number.isSafeInteger(requestedUserId) && requestedUserId > 0) {
    const rows = await TypeORM.getConnection().query(
      `SELECT user.id AS user_id,user.username,profile.student_id,profile.real_name,profile.college
         FROM user LEFT JOIN user_registration_profile profile ON profile.user_id=user.id AND profile.student_id_scope=?
         LEFT JOIN temporary_contest_account temporary_account ON temporary_account.user_id=user.id
        WHERE user.id=? AND temporary_account.user_id IS NULL AND COALESCE(user.is_admin,0)=0 LIMIT 1`,
      [ORDINARY_STUDENT_ID_SCOPE, requestedUserId]
    );
    if (!rows.length) return apiError(res, 404, 'RESOURCE_NOT_FOUND', '未找到对应的普通账户。', { user_id: 'not_found' });
    const result = await TypeORM.getConnection().query(
      'INSERT IGNORE INTO class_group_member (class_id,user_id,added_by,created_at) VALUES (?,?,?,UTC_TIMESTAMP(3))',
      [group.id, requestedUserId, res.locals.user.id]
    );
    await classGroups.refreshCache();
    const added = Number(result.affectedRows || 0) > 0;
    return syzoj.utils.apiV2.send(res, { class_id: Number(group.id), user_id: requestedUserId, added }, added ? 201 : 200);
  }
  const studentId = String(req.body && req.body.student_id || '').trim();
  if (!/^\d{10}$/.test(studentId)) return apiError(res, 422, 'VALIDATION_FAILED', '学号必须为 10 位数字。', { student_id: 'invalid' });
  const result = await addClassMembers(group, [studentId], res.locals.user.id);
  if (result.missing.length) return apiError(res, 404, 'RESOURCE_NOT_FOUND', '未找到对应的普通账户。', { student_id: 'not_found' });
  const account = result.accounts.get(studentId);
  return syzoj.utils.apiV2.send(res, { class_id: Number(group.id), user_id: Number(account.user_id), added: !!result.added }, result.added ? 201 : 200);
});

app.delete('/api/v2/classes/:id/members/:userId', async (req, res) => {
  const group = await requireClassManager(req, res);
  if (!group) return;
  await TypeORM.getConnection().query('DELETE FROM class_group_member WHERE class_id=? AND user_id=?', [group.id, Number(req.params.userId)]);
  await classGroups.refreshCache();
  return syzoj.utils.apiV2.send(res, { class_id: Number(group.id), user_id: Number(req.params.userId), removed: true });
});

app.post('/api/v2/classes/:id/members/import', (req, res) => classCsvUpload(req, res, async uploadError => {
  const group = await requireClassManager(req, res);
  if (!group) return;
  if (uploadError || !req.file) return apiError(res, 422, 'VALIDATION_FAILED', uploadError ? uploadError.message : '请上传学号 CSV 文件。');
  try {
    const studentIds = normalizeStudentIdRows(req.file.buffer);
    const result = await addClassMembers(group, studentIds, res.locals.user.id);
    return syzoj.utils.apiV2.send(res, { class_id: Number(group.id), requested_count: studentIds.length, matched_count: result.accounts.size, added_count: result.added, missing_student_ids: result.missing });
  } catch (error) {
    return apiError(res, error.statusCode || 422, 'VALIDATION_FAILED', error.message);
  }
}));

app.post('/api/v2/contests/:id/participants/import-class', async (req, res) => {
  const contest = await Contest.findById(Number(req.params.id));
  if (!contest) return apiError(res, 404, 'RESOURCE_NOT_FOUND', '比赛不存在。');
  const resource = { id: Number(contest.id), ownerId: Number(contest.holder_id), scope: `contest:${contest.id}` };
  if (!res.locals.user || !await syzoj.utils.authorizationV2.authorize(res.locals.user, 'contest:registration.manage', resource, { scope: resource.scope })) return apiError(res, res.locals.user ? 403 : 401, res.locals.user ? 'CAPABILITY_REQUIRED' : 'AUTHENTICATION_REQUIRED', '您没有该比赛的报名管理权限。');
  await classGroups.ensureSchema();
  const classIds = classGroups.normalizeClassIds(req.body && req.body.class_ids);
  if (!classIds.length) return apiError(res, 422, 'VALIDATION_FAILED', '请至少选择一个班级。', { class_ids: 'required' });
  const groups = await TypeORM.getConnection().query(`SELECT * FROM class_group WHERE status='active' AND id IN (?)`, [classIds]);
  const allowed = groups.filter(group => group.allow_activity_import || classGroups.isUnrestricted(res.locals.user) || Number(group.owner_id) === Number(res.locals.user.id));
  if (allowed.length !== classIds.length) return apiError(res, 403, 'CAPABILITY_REQUIRED', '所选班级不存在或不允许用于活动报名。');
  const rows = await TypeORM.getConnection().query(
    `SELECT DISTINCT member.user_id FROM class_group_member member
       LEFT JOIN temporary_contest_account temporary_account ON temporary_account.user_id=member.user_id
      WHERE member.class_id IN (?) AND temporary_account.user_id IS NULL`, [classIds]
  );
  let added = 0;
  const failed = [];
  for (const row of rows) {
    try {
      await contestMutation.registerUser(contest.id, Number(row.user_id), { managed: true });
      added++;
    } catch (error) {
      failed.push({ user_id: Number(row.user_id), message: error.message });
    }
  }
  if (syzoj.utils.invalidateContestReadCache) syzoj.utils.invalidateContestReadCache(contest.id);
  return syzoj.utils.apiV2.send(res, { contest_id: Number(contest.id), class_ids: classIds, matched_count: rows.length, added_count: added, failed });
});

classGroups.ensureSchema().then(classGroups.refreshCache).catch(error => syzoj.log('[class-groups] ' + (error.stack || error)));
syzoj.utils.classGroups = classGroups;
