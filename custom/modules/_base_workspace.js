'use strict';
const TypeORM = require('typeorm');
const multer = require('multer');
const base = require('../libs/base-workspace');
const migration = require('../libs/base-problem-migration');
if (migration.startSyncWorker) migration.startSyncWorker();
const classes = require('../libs/class-groups');
const { ensureRegistrationProfileSchema, ORDINARY_STUDENT_ID_SCOPE } = require('../libs/registration-profile-schema');
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1 } }).single('student_ids_csv');
const api = () => syzoj.utils.apiV2;
const run = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
function requireAdmin(req, res, next) {
  if (!base.isAdmin(res.locals.user)) return api().fail(res, 403, 'BASE_ADMIN_REQUIRED', '此操作仅限站长或全站管理员。');
  return next();
}
function ids(value, max = 1000) {
  if (!Array.isArray(value) || !value.length || value.length > max || value.some(id => !Number.isSafeInteger(Number(id)) || Number(id) < 1)) throw Object.assign(new Error('请选择有效的账户或班级。'), { statusCode: 422 });
  return [...new Set(value.map(Number))];
}
async function ordinaryAccounts(db, userIds) {
  if (!userIds.length) return [];
  return db.query(`SELECT u.id FROM user u LEFT JOIN temporary_contest_account t ON t.user_id=u.id
    WHERE u.id IN (?) AND t.user_id IS NULL AND COALESCE(u.is_admin,0)=0 AND NOT EXISTS (SELECT 1 FROM ai_agent_account ai WHERE ai.user_id=u.id)`, [userIds]);
}
async function addMembers(req, userIds, details = {}) {
  await base.ensureSchema();
  return TypeORM.getConnection().transaction(async db => {
    const accounts = await ordinaryAccounts(db, userIds);
    let added = 0;
    for (const account of accounts) {
      const result = await db.query('INSERT IGNORE INTO base_workspace_member (user_id,added_by,created_at) VALUES (?,?,UTC_TIMESTAMP(3))', [account.id, req.res.locals.user.id]);
      added += Number(result.affectedRows || 0);
    }
    const result = Object.assign({ requested: userIds.length, matched: accounts.length, added, skipped: accounts.length - added, invalid: userIds.filter(id => !accounts.some(account => Number(account.id) === id)) }, details);
    await syzoj.utils.authorizationV2.recordAudit(req, { action: 'base:members.add', resourceType: 'base', resourceId: 'members', details: result }, db);
    return result;
  });
}

app.get(['/base', '/base/problems', '/base/contests', '/base/members'], run(async (req, res) => {
  const tab = req.path.endsWith('/contests') ? 'contests' : req.path.endsWith('/members') ? 'members' : 'problems';
  if (tab === 'members' && !base.isAdmin(res.locals.user)) return res.status(403).render('error', { err: new ErrorMessage('只有全站管理员可以管理基地成员。') });
  const db = TypeORM.getConnection();
  const user = res.locals.user;
  const keyword = String(req.query.keyword || '').trim().slice(0, 80);
  const mine = req.query.mine === '1';
  const params = [];
  let from, where = '1=1', select, order;
  if (tab === 'members') {
    await ensureRegistrationProfileSchema(); await classes.ensureSchema();
    from = `base_workspace_member m JOIN user u ON u.id=m.user_id LEFT JOIN user_registration_profile p ON p.user_id=u.id AND p.student_id_scope=?`;
    params.push(ORDINARY_STUDENT_ID_SCOPE);
    select = 'u.id,u.username,p.real_name,p.student_id,p.college,m.created_at';
    order = 'm.created_at DESC,u.id DESC';
    if (keyword) { where += ' AND (u.username LIKE ? OR p.real_name LIKE ? OR p.student_id LIKE ? OR u.id=?)'; params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, Number(keyword) || 0); }
  } else if (tab === 'problems') {
    await syzoj.utils.problemV2.ensureSchema();
    from = `base_workspace_problem b JOIN problem p ON p.id=b.problem_id LEFT JOIN user u ON u.id=p.user_id LEFT JOIN problem_v2_state s ON s.problem_id=p.id LEFT JOIN problem_v2_version v ON v.id=s.current_version_id`;
    select = "p.id,COALESCE(JSON_UNQUOTE(JSON_EXTRACT(v.content_json,'$.title')),p.title) AS title,p.user_id,p.is_public,u.username";
    where += " AND COALESCE(s.lifecycle_status,'draft')<>'archived'";
    if (!base.isAdmin(user)) { where += ' AND (p.is_public=1 OR p.user_id=?)'; params.push(user.id); }
    if (mine) { where += ' AND p.user_id=?'; params.push(user.id); }
    if (keyword) { where += " AND (COALESCE(JSON_UNQUOTE(JSON_EXTRACT(v.content_json,'$.title')),p.title) LIKE ? OR p.id=?)"; params.push(`%${keyword}%`, Number(keyword) || 0); }
    order = 'p.id DESC';
  } else {
    await syzoj.utils.contestV2.ensureSchema();
    from = `base_workspace_contest b JOIN contest c ON c.id=b.contest_id LEFT JOIN user u ON u.id=c.holder_id LEFT JOIN contest_v2_state s ON s.contest_id=c.id`;
    select = 'c.id,c.title,c.holder_id,c.is_public,c.start_time,c.end_time,c.type,u.username';
    where += " AND COALESCE(s.status,'draft')<>'archived'";
    if (!base.isAdmin(user)) { where += ' AND (c.is_public=1 OR c.holder_id=?)'; params.push(user.id); }
    if (mine) { where += ' AND c.holder_id=?'; params.push(user.id); }
    if (keyword) { where += ' AND (c.title LIKE ? OR c.id=?)'; params.push(`%${keyword}%`, Number(keyword) || 0); }
    order = 'CASE WHEN c.start_time>UNIX_TIMESTAMP() THEN 0 WHEN c.end_time>UNIX_TIMESTAMP() THEN 1 ELSE 2 END,CASE WHEN c.end_time>UNIX_TIMESTAMP() THEN c.start_time ELSE -c.start_time END,c.id';
  }
  const count = await db.query(`SELECT COUNT(*) AS total FROM ${from} WHERE ${where}`, params);
  const total = Number(count[0].total);
  const pageCnt = Math.max(1, Math.ceil(total / 100));
  const currPage = Math.min(pageCnt, Math.max(1, Math.floor(Number(req.query.page) || 1)));
  const rows = await db.query(`SELECT ${select} FROM ${from} WHERE ${where} ORDER BY ${order} LIMIT 100 OFFSET ?`, params.concat((currPage - 1) * 100));
  if (tab === 'members') {
    const membership = await classes.membershipForUsers(rows.map(row => row.id));
    rows.forEach(row => { row.classes = membership.byUser.get(Number(row.id)) || []; });
  }
  let problemTags = [];
  if (tab === 'problems') {
    const migrated = await base.migrationStates(rows.map(row => Number(row.id)));
    rows.forEach(row => { row.migration = migrated.get(Number(row.id)) || null; row.tags = []; });
    if (rows.length) {
      const tags = await db.query(`SELECT map.problem_id,tag.name FROM problem_tag_map map
        JOIN problem_tag tag ON tag.id=map.tag_id WHERE map.problem_id IN (?)
        ORDER BY tag.color,tag.name,tag.id`, [rows.map(row => Number(row.id))]);
      const byProblem = new Map(rows.map(row => [Number(row.id), row.tags]));
      tags.forEach(tag => { const list = byProblem.get(Number(tag.problem_id)); if (list) list.push(tag); });
    }
    problemTags = await db.query('SELECT id,name FROM problem_tag ORDER BY name,id');
  }
  return res.render('base_workspace', { tab, rows, problemTags, total, keyword, mine, paginate: { currPage, pageCnt }, paginationBasePath: ['base', tab] });
}));

// A small per-problem request avoids gateway timeouts for large data archives.
// The bulk UI runs these sequentially, reports each result, and can safely retry.
app.post('/api/v2/base/problems/:id/migrate', requireAdmin, run(async (req, res) => {
  try { return api().send(res, await migration.migrate(Number(req.params.id), res.locals.user, req)); }
  catch (error) { return api().fail(res, error.statusCode || 500, error.code && String(error.code).startsWith('BASE_') ? error.code : error.statusCode ? error.code || 'VALIDATION_FAILED' : 'BASE_MIGRATION_FAILED', error.statusCode ? error.message : '题目迁移失败，请稍后重试。'); }
}));
app.get('/api/v2/base/problems/:id/migration', requireAdmin, run(async (req, res) => {
  const id = Number(req.params.id);
  if (!await base.contains('problem', id)) return api().fail(res, 404, 'PROBLEM_NOT_FOUND', '基地题目不存在。');
  return api().send(res, { source_problem_id: id, migration: (await base.migrationStates([id])).get(id) || null });
}));

// Normal lists remain separate, including counts and pagination.
app.get('/contests', run(async (req, res) => {
  const Contest = syzoj.model('contest');
  const userId = Number(res.locals.user && res.locals.user.id || 0);
  const now = syzoj.utils.getCurrentDate();
  const contestListFilters = {
    state: ['upcoming', 'running', 'ended'].includes(req.query.state) ? req.query.state : 'all',
    mine: !!userId && !res.locals.temporaryContestSession && req.query.mine === '1',
    participating: !!userId && req.query.participating === '1'
  };
  const query = Contest.createQueryBuilder('contest').where(base.outside('contest', 'contest.id'));
  if (res.locals.temporaryContestSession) {
    query.andWhere(`EXISTS (SELECT 1 FROM contest_player participant
      WHERE participant.contest_id=contest.id AND participant.user_id=:temporaryParticipantId
        AND NOT EXISTS (SELECT 1 FROM contest_registration_removal removed
          WHERE removed.contest_id=contest.id AND removed.user_id=participant.user_id))`,
    { temporaryParticipantId: Number(res.locals.user.id) });
  }
  if (!base.isAdmin(res.locals.user) && !res.locals.temporaryContestSession) query.andWhere('contest.is_public=1');
  query.andWhere("NOT EXISTS (SELECT 1 FROM contest_v2_state s WHERE s.contest_id=contest.id AND s.status='archived')");
  if (contestListFilters.mine) query.andWhere('contest.holder_id=:listUserId', { listUserId: userId });
  if (contestListFilters.participating) query.andWhere(`EXISTS (SELECT 1 FROM contest_player self_participant
    WHERE self_participant.contest_id=contest.id AND self_participant.user_id=:listUserId
      AND NOT EXISTS (SELECT 1 FROM contest_registration_removal removed
        WHERE removed.contest_id=contest.id AND removed.user_id=self_participant.user_id))`, { listUserId: userId });
  query.setParameter('listNow', now);
  const stateSql = "CASE WHEN contest.start_time>:listNow THEN 'upcoming' WHEN contest.end_time>:listNow THEN 'running' ELSE 'ended' END";
  const countRows = await query.clone().select(stateSql, 'state').addSelect('COUNT(*)', 'total').groupBy(stateSql).getRawMany();
  const contestListCounts = { all: 0, upcoming: 0, running: 0, ended: 0 };
  countRows.forEach(row => { contestListCounts[row.state] = Number(row.total); contestListCounts.all += Number(row.total); });
  if (contestListFilters.state !== 'all') query.andWhere(`${stateSql}=:listState`, { listState: contestListFilters.state });
  query.orderBy('CASE WHEN contest.start_time>:listNow THEN 0 WHEN contest.end_time>:listNow THEN 1 ELSE 2 END', 'ASC')
    .addOrderBy('CASE WHEN contest.start_time>:listNow OR contest.end_time>:listNow THEN contest.start_time ELSE -contest.start_time END', 'ASC')
    .addOrderBy('CASE WHEN contest.start_time>:listNow OR contest.end_time>:listNow THEN contest.id ELSE -contest.id END', 'ASC');
  const contestListTotal = contestListCounts[contestListFilters.state];
  const paginate = syzoj.utils.paginate(contestListTotal, req.query.page, syzoj.config.page.contest);
  const contests = await Contest.queryPage(paginate, query);
  await Promise.all(contests.map(async contest => { contest.subtitle = await syzoj.utils.markdown(contest.subtitle); }));
  return res.render('contests', { contests, paginate, contestListFilters, contestListCounts, contestListTotal });
}));

app.get('/api/v2/base/users/search', requireAdmin, run(async (req, res) => {
  await ensureRegistrationProfileSchema();
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (!q) return api().send(res, []);
  const rows = await TypeORM.getConnection().query(`SELECT u.id,u.username,p.real_name,p.student_id,p.college,
    (m.user_id IS NOT NULL) AS joined FROM user u
    LEFT JOIN user_registration_profile p ON p.user_id=u.id AND p.student_id_scope=?
    LEFT JOIN temporary_contest_account t ON t.user_id=u.id LEFT JOIN base_workspace_member m ON m.user_id=u.id
    WHERE t.user_id IS NULL AND COALESCE(u.is_admin,0)=0 AND NOT EXISTS (SELECT 1 FROM ai_agent_account ai WHERE ai.user_id=u.id) AND (u.username LIKE ? OR p.real_name LIKE ? OR p.student_id LIKE ? OR u.id=?)
    ORDER BY u.id LIMIT 100`, [ORDINARY_STUDENT_ID_SCOPE, `%${q}%`, `%${q}%`, `%${q}%`, Number(q) || 0]);
  return api().send(res, rows);
}));
app.get('/api/v2/base/classes/search', requireAdmin, run(async (req, res) => {
  await classes.ensureSchema();
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (!q) return api().send(res, []);
  const rows = await TypeORM.getConnection().query("SELECT id,name,tag_text FROM class_group WHERE status='active' AND (name LIKE ? OR id=?) ORDER BY name,id LIMIT 100", [`%${q}%`, Number(q) || 0]);
  return api().send(res, rows);
}));
app.post('/api/v2/base/members', requireAdmin, run(async (req, res) => api().send(res, await addMembers(req, ids(req.body.user_ids)))));
app.post('/api/v2/base/members/import-classes', requireAdmin, run(async (req, res) => {
  await classes.ensureSchema();
  const classIds = ids(req.body.class_ids, 100);
  const found = await TypeORM.getConnection().query("SELECT id FROM class_group WHERE id IN (?) AND status='active'", [classIds]);
  if (found.length !== classIds.length) return api().fail(res, 422, 'CLASS_NOT_FOUND', '部分班级不存在或已删除，请重新选择。');
  const members = await TypeORM.getConnection().query('SELECT DISTINCT user_id FROM class_group_member WHERE class_id IN (?)', [classIds]);
  return api().send(res, await addMembers(req, members.map(row => Number(row.user_id)), { class_ids: classIds }));
}));
app.post('/api/v2/base/members/import-csv', requireAdmin, (req, res, next) => csvUpload(req, res, error => {
  if (error || !req.file || !/\.csv$/i.test(req.file.originalname)) return api().fail(res, 422, 'CSV_INVALID', '请上传不超过 1 MB 的学号 CSV 文件。');
  next();
}), run(async (req, res) => {
  let entries;
  try { entries = base.csvEntries(req.file.buffer); } catch (error) { return api().fail(res, 422, 'CSV_INVALID', error.message); }
  await ensureRegistrationProfileSchema();
  const valid = entries.filter(row => !row.reason);
  const accounts = valid.length ? await TypeORM.getConnection().query(`SELECT u.id,p.student_id FROM user u
    JOIN user_registration_profile p ON p.user_id=u.id AND p.student_id_scope=?
    LEFT JOIN temporary_contest_account t ON t.user_id=u.id
    WHERE p.student_id IN (?) AND t.user_id IS NULL AND COALESCE(u.is_admin,0)=0 AND NOT EXISTS (SELECT 1 FROM ai_agent_account ai WHERE ai.user_id=u.id)`, [ORDINARY_STUDENT_ID_SCOPE, valid.map(row => row.student_id)]) : [];
  const selected = [];
  for (const row of valid) {
    const matches = accounts.filter(account => account.student_id === row.student_id);
    if (matches.length === 1) selected.push(Number(matches[0].id));
    else row.reason = matches.length ? '匹配多个账户，未添加' : '没有匹配的普通账户';
  }
  return api().send(res, await addMembers(req, [...new Set(selected)], { csv_rows: entries.length, errors: entries.filter(row => row.reason) }));
}));
app.post('/api/v2/base/members/remove', requireAdmin, run(async (req, res) => {
  const userIds = ids(req.body.user_ids);
  const result = await TypeORM.getConnection().transaction(async db => {
    const removed = await db.query('DELETE FROM base_workspace_member WHERE user_id IN (?)', [userIds]);
    await syzoj.utils.authorizationV2.recordAudit(req, { action: 'base:members.remove', resourceType: 'base', resourceId: 'members', details: { user_ids: userIds } }, db);
    return { removed: Number(removed.affectedRows || 0) };
  });
  base.revokeConnections(userIds);
  return api().send(res, result);
}));
