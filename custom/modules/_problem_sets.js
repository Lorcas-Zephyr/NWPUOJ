const multer = require('multer');
const TypeORM = require('typeorm');
const problemDomain = require('../libs/problem-domain');
const classGroups = require('../libs/class-groups');
const { buildRanklist, filterRanklist } = require('../libs/problem-set-ranklist');
const { buildProblemSetRanklistCsv } = require('../libs/problem-set-ranklist-export');
const { normalizeStudentIdRows } = require('../libs/contest-temp-accounts');
const { ensureRegistrationProfileSchema, ORDINARY_STUDENT_ID_SCOPE } = require('../libs/registration-profile-schema');
const { linkUserMentions } = require('../libs/user-mentions');

const Problem = syzoj.model('problem');
const User = syzoj.model('user');
let schemaPromise = null;
const participantCsvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => callback(/\.csv$/i.test(String(file.originalname || '')) ? null : new Error('仅支持 .csv 文件。'), /\.csv$/i.test(String(file.originalname || '')))
}).single('student_ids_csv');

async function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const connection = TypeORM.getConnection();
    await connection.query(`CREATE TABLE IF NOT EXISTS problem_set (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(160) NOT NULL,
      description LONGTEXT NOT NULL,
      owner_id INT NOT NULL,
      visibility VARCHAR(16) NOT NULL DEFAULT 'private',
      status VARCHAR(16) NOT NULL DEFAULT 'draft',
      ranking_mode VARCHAR(16) NOT NULL DEFAULT 'acm',
      allow_registration TINYINT(1) NOT NULL DEFAULT 1,
      deadline_at BIGINT NULL,
      published_at BIGINT NULL,
      revision INT UNSIGNED NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      KEY idx_problem_set_list (status,visibility,updated_at),
      KEY idx_problem_set_owner (owner_id,status,id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS problem_set_item (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      problem_set_id INT NOT NULL,
      problem_id INT NOT NULL,
      ordinal INT NOT NULL,
      score DECIMAL(10,2) NOT NULL DEFAULT 100,
      created_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_problem_set_item_problem (problem_set_id,problem_id),
      UNIQUE KEY uq_problem_set_item_ordinal (problem_set_id,ordinal),
      KEY idx_problem_set_item_problem (problem_id,problem_set_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS problem_set_participant (
      problem_set_id INT NOT NULL,
      user_id INT NOT NULL,
      source VARCHAR(24) NOT NULL DEFAULT 'self',
      created_at DATETIME(3) NOT NULL,
      PRIMARY KEY (problem_set_id,user_id),
      KEY idx_problem_set_participant_user (user_id,problem_set_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS problem_set_submission (
      problem_set_id INT NOT NULL,
      submission_id INT NOT NULL,
      user_id INT NOT NULL,
      problem_id INT NOT NULL,
      submitted_at BIGINT NOT NULL,
      PRIMARY KEY (submission_id),
      KEY idx_problem_set_submission_rank (problem_set_id,user_id,problem_id,submitted_at),
      KEY idx_problem_set_submission_list (problem_set_id,submission_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  })().catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}

function fail(res, status, code, message, fields) {
  return syzoj.utils.apiV2.fail(res, status, code, message, fields || {});
}

async function findProblemSet(id) {
  await ensureSchema();
  const rows = await TypeORM.getConnection().query(
    `SELECT set_table.*,owner.username AS owner_username,
            (SELECT COUNT(*) FROM problem_set_item item WHERE item.problem_set_id=set_table.id) AS problem_count,
            (SELECT COUNT(*) FROM problem_set_participant participant WHERE participant.problem_set_id=set_table.id) AS participant_count
       FROM problem_set set_table INNER JOIN user owner ON owner.id=set_table.owner_id
      WHERE set_table.id=? LIMIT 1`, [Number(id)]
  );
  if (!rows.length) return null;
  const row = rows[0];
  row.id = Number(row.id);
  row.owner_id = Number(row.owner_id);
  row.deadline_at = row.deadline_at == null ? null : Number(row.deadline_at);
  row.published_at = row.published_at == null ? null : Number(row.published_at);
  row.allow_registration = !!row.allow_registration;
  return row;
}

async function canManage(problemSet, user, capability) {
  if (!problemSet || !user) return false;
  const requested = capability || 'problemset:edit';
  const resource = { id: problemSet.id, ownerId: problemSet.owner_id, scope: `problemset:${problemSet.id}` };
  if (!classGroups.isUnrestricted(user)) {
    if (Number(problemSet.owner_id) !== Number(user.id)) return false;
    const capabilities = await syzoj.utils.authorizationV2.effectiveCapabilities(user, resource.scope);
    if (!capabilities.some(granted => syzoj.utils.authorizationV2.capabilityMatches(granted, requested))) return false;
  }
  return syzoj.utils.authorizationV2.authorize(user, requested, resource, { scope: resource.scope });
}

syzoj.utils.canManageProblemSet = canManage;

async function isParticipant(problemSetId, userId) {
  if (!userId) return false;
  const rows = await TypeORM.getConnection().query('SELECT 1 FROM problem_set_participant WHERE problem_set_id=? AND user_id=? LIMIT 1', [problemSetId, userId]);
  return rows.length > 0;
}

async function accessState(problemSet, user) {
  const manager = await canManage(problemSet, user, 'problemset:edit');
  const participant = await isParticipant(problemSet.id, user && user.id);
  const visible = manager || (problemSet.status === 'published' && (problemSet.visibility === 'public' || participant));
  const open = problemSet.status === 'published' && (!problemSet.deadline_at || problemSet.deadline_at > Math.floor(Date.now() / 1000));
  return { manager, participant, visible, open, canParticipate: !!(user && open && (manager || participant)) };
}

async function loadItems(problemSetId) {
  const rows = await TypeORM.getConnection().query(
    `SELECT item.id,item.problem_set_id,item.problem_id,item.ordinal,item.score,
            COALESCE(JSON_UNQUOTE(JSON_EXTRACT(version.content_json,'$.title')),problem.title) AS title,
            problem.type,problem.is_public
       FROM problem_set_item item INNER JOIN problem ON problem.id=item.problem_id
       LEFT JOIN problem_v2_state state ON state.problem_id=problem.id
       LEFT JOIN problem_v2_version version ON version.id=state.current_version_id
      WHERE item.problem_set_id=? ORDER BY item.ordinal`, [problemSetId]
  );
  return rows.map(row => Object.assign(row, { problem_id: Number(row.problem_id), ordinal: Number(row.ordinal), score: Number(row.score) }));
}

async function loadCurrentProblem(problemId) {
  const problem = await Problem.findById(Number(problemId));
  if (!problem) return null;
  const rows = await TypeORM.getConnection().query(
    `SELECT version.content_json FROM problem_v2_state state
       INNER JOIN problem_v2_version version ON version.id=state.current_version_id
      WHERE state.problem_id=? LIMIT 1`, [problem.id]
  );
  if (rows[0] && rows[0].content_json) Object.assign(problem, problemDomain.parseStoredContent(rows[0].content_json));
  return problem;
}

async function renderProblemPresentation(problem) {
  const fields = ['description', 'input_format', 'output_format', 'example', 'limit_and_hint'];
  const rendered = {};
  fields.forEach(field => { rendered[field] = problem[field] || ''; });
  const [specialJudge, testcases] = await Promise.all([
    problem.hasSpecialJudge(),
    syzoj.utils.parseTestdata(problem.getTestdataPath(), problem.type === 'submit-answer'),
    syzoj.utils.markdown(rendered, fields)
  ]);
  await Promise.all(fields.map(async field => { rendered[field] = await linkUserMentions(rendered[field]); }));
  Object.assign(problem, rendered);
  problem.specialJudge = specialJudge;
  return testcases;
}

function normalizeInput(body, current) {
  const title = String(body && body.title != null ? body.title : current && current.title || '').trim();
  const description = String(body && body.description != null ? body.description : current && current.description || '').trim();
  const visibility = ['public', 'private'].includes(String(body && body.visibility)) ? String(body.visibility) : current && current.visibility || 'private';
  const status = ['draft', 'published', 'archived'].includes(String(body && body.status)) ? String(body.status) : current && current.status || 'draft';
  const rankingMode = ['acm', 'ioi', 'noi'].includes(String(body && body.ranking_mode)) ? String(body.ranking_mode) : current && current.ranking_mode || 'acm';
  const allowRegistration = body && body.allow_registration == null ? !!(current ? current.allow_registration : true) : body.allow_registration === true || ['1', 'true', 'on'].includes(String(body.allow_registration).toLowerCase());
  let deadlineAt = null;
  if (body && body.deadline_at) {
    const parsed = new Date(body.deadline_at);
    if (!Number.isFinite(parsed.getTime())) throw Object.assign(new Error('截止时间格式不正确。'), { field: 'deadline_at' });
    deadlineAt = Math.floor(parsed.getTime() / 1000);
  } else if (body && body.deadline_at === undefined && current) deadlineAt = current.deadline_at;
  const problemIds = body && body.problem_ids === undefined && current
    ? null
    : Array.from(new Set((Array.isArray(body && body.problem_ids) ? body.problem_ids : String(body && body.problem_ids || '').split(/[\s,|]+/)).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))).slice(0, 500);
  if (!title || title.length > 160) throw Object.assign(new Error('题单标题不能为空且不能超过 160 个字符。'), { field: 'title' });
  if (description.length > 20000) throw Object.assign(new Error('题单说明不能超过 20000 个字符。'), { field: 'description' });
  if (status === 'published' && problemIds && !problemIds.length) throw Object.assign(new Error('发布题单前至少添加一道题目。'), { field: 'problem_ids' });
  return { title, description, visibility, status, rankingMode, allowRegistration, deadlineAt, problemIds };
}

function problemSetEditResource(problemSet) {
  return {
    id: Number(problemSet.id),
    title: String(problemSet.title || ''),
    description: String(problemSet.description || ''),
    owner_id: Number(problemSet.owner_id),
    visibility: String(problemSet.visibility || 'private'),
    status: String(problemSet.status || 'draft'),
    ranking_mode: String(problemSet.ranking_mode || 'acm'),
    allow_registration: !!problemSet.allow_registration,
    deadline_at: problemSet.deadline_at == null ? null : Number(problemSet.deadline_at),
    published_at: problemSet.published_at == null ? null : Number(problemSet.published_at),
    revision: Number(problemSet.revision || 1)
  };
}

function submissionLanguageDisplay(language) {
  const value = String(language || '');
  if (!value) return null;
  const config = syzoj.languages && syzoj.languages[value];
  return config && config.show || value;
}

async function validateProblems(problemIds, user) {
  if (!problemIds.length) return;
  const rows = await TypeORM.getConnection().query('SELECT id,is_public,user_id,type FROM problem WHERE id IN (?)', [problemIds]);
  const byId = new Map(rows.map(row => [Number(row.id), row]));
  for (const id of problemIds) {
    const problem = byId.get(id);
    if (!problem) throw Object.assign(new Error(`题目 #${id} 不存在。`), { field: 'problem_ids' });
    if (String(problem.type || '').startsWith('vjudge:')) throw Object.assign(new Error(`题目 #${id} 是 VJudge 题，暂不能加入题单。`), { field: 'problem_ids' });
    if (!problem.is_public && !classGroups.isUnrestricted(user) && Number(problem.user_id) !== Number(user.id)) throw Object.assign(new Error(`您没有使用题目 #${id} 的权限。`), { field: 'problem_ids' });
  }
}

async function saveItems(manager, problemSetId, problemIds) {
  await manager.query('DELETE FROM problem_set_item WHERE problem_set_id=?', [problemSetId]);
  for (let index = 0; index < problemIds.length; index++) {
    await manager.query('INSERT INTO problem_set_item (problem_set_id,problem_id,ordinal,score,created_at) VALUES (?,?,?,?,UTC_TIMESTAMP(3))', [problemSetId, problemIds[index], index + 1, 100]);
  }
}

async function loadProfiles(items) {
  const ids = Array.from(new Set(items.map(item => Number(item.user.id))));
  if (!ids.length) return new Map();
  const rows = await TypeORM.getConnection().query('SELECT user_id,student_id,real_name,college FROM user_registration_profile WHERE user_id IN (?)', [ids]);
  return new Map(rows.map(row => [Number(row.user_id), row]));
}

async function ordinaryAccounts(studentIds) {
  await ensureRegistrationProfileSchema();
  if (!studentIds.length) return new Map();
  const rows = await TypeORM.getConnection().query(
    `SELECT profile.student_id,profile.user_id,user.username,profile.real_name,profile.college
       FROM user_registration_profile profile INNER JOIN user ON user.id=profile.user_id
       LEFT JOIN temporary_contest_account temporary_account ON temporary_account.user_id=profile.user_id
      WHERE profile.student_id_scope=? AND profile.student_id IN (?) AND temporary_account.user_id IS NULL`,
    [ORDINARY_STUDENT_ID_SCOPE, studentIds]
  );
  return new Map(rows.map(row => [String(row.student_id), row]));
}

async function addParticipants(problemSetId, userIds, source) {
  let added = 0;
  for (const userId of Array.from(new Set(userIds.map(Number)))) {
    const result = await TypeORM.getConnection().query('INSERT IGNORE INTO problem_set_participant (problem_set_id,user_id,source,created_at) VALUES (?,?,?,UTC_TIMESTAMP(3))', [problemSetId, userId, source]);
    if (Number(result.affectedRows || 0)) added++;
  }
  return added;
}

async function requireManagedSet(req, res, capability) {
  const problemSet = await findProblemSet(req.params.id);
  if (!problemSet) { fail(res, 404, 'RESOURCE_NOT_FOUND', '题单不存在。'); return null; }
  if (!await canManage(problemSet, res.locals.user, capability || 'problemset:edit')) { fail(res, res.locals.user ? 403 : 401, res.locals.user ? 'CAPABILITY_REQUIRED' : 'AUTHENTICATION_REQUIRED', '您只能管理自己创建的题单。'); return null; }
  return problemSet;
}

app.get('/problem-sets', async (req, res) => {
  try {
    await ensureSchema();
    const userId = Number(res.locals.user && res.locals.user.id || 0);
    const unrestricted = classGroups.isUnrestricted(res.locals.user);
    const rows = await TypeORM.getConnection().query(
      `SELECT set_table.*,owner.username AS owner_username,
              COUNT(DISTINCT item.id) AS problem_count,COUNT(DISTINCT participant.user_id) AS participant_count,
              MAX(self_participant.user_id IS NOT NULL) AS registered
         FROM problem_set set_table INNER JOIN user owner ON owner.id=set_table.owner_id
         LEFT JOIN problem_set_item item ON item.problem_set_id=set_table.id
         LEFT JOIN problem_set_participant participant ON participant.problem_set_id=set_table.id
         LEFT JOIN problem_set_participant self_participant ON self_participant.problem_set_id=set_table.id AND self_participant.user_id=?
        WHERE set_table.status<>'archived' AND (set_table.status='published' AND set_table.visibility='public' OR set_table.owner_id=? OR ?=1 OR self_participant.user_id IS NOT NULL)
        GROUP BY set_table.id ORDER BY set_table.updated_at DESC,set_table.id DESC`, [userId, userId, unrestricted ? 1 : 0]
    );
    const canCreate = !!(res.locals.user && await syzoj.utils.authorizationV2.authorize(res.locals.user, 'problemset:create', null, { scope: 'global' }));
    res.render('problem_sets', { problemSets: rows, canCreateProblemSet: canCreate });
  } catch (error) { res.status(error.statusCode || 500).render('error', { err: error }); }
});

app.get('/problem-set/new', async (req, res) => {
  if (!res.locals.user || !await syzoj.utils.authorizationV2.authorize(res.locals.user, 'problemset:create', null, { scope: 'global' })) return res.status(res.locals.user ? 403 : 401).render('error', { err: new ErrorMessage('您没有创建题单的权限。') });
  res.render('problem_set_edit', { problemSet: null, problemSetItems: [] });
});

app.get('/problem-set/:id/edit', async (req, res) => {
  const problemSet = await findProblemSet(req.params.id);
  if (!problemSet || !await canManage(problemSet, res.locals.user, 'problemset:edit')) return res.status(403).render('error', { err: new ErrorMessage('您没有编辑该题单的权限。') });
  const problemSetEtag = syzoj.utils.apiV2.etagFor(problemSetEditResource(problemSet));
  res.set('ETag', problemSetEtag);
  res.render('problem_set_edit', { problemSet, problemSetItems: await loadItems(problemSet.id), problemSetEtag });
});

app.get('/problem-set/:id', async (req, res) => {
  try {
    const problemSet = await findProblemSet(req.params.id);
    if (!problemSet) throw Object.assign(new Error('题单不存在。'), { statusCode: 404 });
    const access = await accessState(problemSet, res.locals.user);
    if (!access.visible) throw Object.assign(new Error('题单不存在或您尚未获得访问资格。'), { statusCode: 404 });
    const items = await loadItems(problemSet.id);
    let progress = new Map();
    if (res.locals.user && items.length) {
      const rows = await TypeORM.getConnection().query(
        `SELECT link.problem_id,MAX(judge.status='Accepted') AS accepted,MAX(COALESCE(judge.score,0)) AS best_score,COUNT(*) AS attempts
           FROM problem_set_submission link INNER JOIN judge_state judge ON judge.id=link.submission_id
           LEFT JOIN judge_state_admin_action action ON action.judge_id=judge.id
          WHERE link.problem_set_id=? AND link.user_id=? AND action.judge_id IS NULL GROUP BY link.problem_id`,
        [problemSet.id, res.locals.user.id]
      );
      progress = new Map(rows.map(row => [Number(row.problem_id), row]));
    }
    const renderedDescription = { description: problemSet.description || '' };
    await syzoj.utils.markdown(renderedDescription, ['description']);
    res.render('problem_set_overview', { problemSet, problemSetItems: items, problemSetAccess: access, problemSetProgress: progress, problemSetDescription: renderedDescription.description });
  } catch (error) { res.status(error.statusCode || 500).render('error', { err: error }); }
});

async function renderProblemSetProblem(req, res, submit) {
  const problemSet = await findProblemSet(req.params.id);
  if (!problemSet) throw Object.assign(new Error('题单不存在。'), { statusCode: 404 });
  const access = await accessState(problemSet, res.locals.user);
  if (!access.visible) throw Object.assign(new Error('题单不存在或您尚未获得访问资格。'), { statusCode: 404 });
  const items = await loadItems(problemSet.id);
  const ordinal = Number(req.params.pid);
  const item = items.find(candidate => candidate.ordinal === ordinal);
  if (!item) throw Object.assign(new Error('题单中没有这道题。'), { statusCode: 404 });
  if (submit && !access.canParticipate) throw Object.assign(new Error(problemSet.deadline_at && problemSet.deadline_at <= Math.floor(Date.now() / 1000) ? '题单已截止提交。' : '请先报名后提交。'), { statusCode: 403 });
  const problem = await loadCurrentProblem(item.problem_id);
  if (!problem) throw Object.assign(new Error('题目不存在。'), { statusCode: 404 });
  await problem.loadRelationships();
  const testcases = await renderProblemPresentation(problem);
  const [state, lastLanguage] = await Promise.all([problem.getJudgeState(res.locals.user, false), res.locals.user ? res.locals.user.getLastSubmitLanguage() : null]);
  const options = { pid: ordinal, contest: null, problemSet, problemSetCanParticipate: access.canParticipate, problem, state, lastLanguage, testcases, languages: problem.getVJudgeLanguages() };
  if (submit) options.problemContext = { problem, section: 'submit', testcases, contest: null, problemSet, problemSetProblemId: ordinal, problemSetCanParticipate: access.canParticipate };
  res.render(submit ? 'problem_submit' : 'problem', options);
}

app.get('/problem-set/:id/problem/:pid', async (req, res) => { try { await renderProblemSetProblem(req, res, false); } catch (error) { res.status(error.statusCode || 500).render('error', { err: error }); } });
app.get('/problem-set/:id/problem/:pid/submit', async (req, res) => { try { await renderProblemSetProblem(req, res, true); } catch (error) { res.status(error.statusCode || 500).render('error', { err: error }); } });

async function submissionContext(req, res) {
  const problemSet = await findProblemSet(req.params.id);
  const user = res.locals.user;
  if (!problemSet || !user) { fail(res, user ? 404 : 401, user ? 'RESOURCE_NOT_FOUND' : 'AUTHENTICATION_REQUIRED', user ? '题单不存在。' : '请登录后提交。'); return null; }
  const access = await accessState(problemSet, user);
  if (!access.canParticipate) { fail(res, 403, 'CAPABILITY_REQUIRED', access.open ? '请先报名后提交。' : '题单已截止提交。'); return null; }
  const rows = await TypeORM.getConnection().query('SELECT 1 FROM problem_set_item WHERE problem_set_id=? AND problem_id=? LIMIT 1', [problemSet.id, Number(req.params.problemId)]);
  if (!rows.length) { fail(res, 404, 'RESOURCE_NOT_FOUND', '题目不在该题单中。'); return null; }
  const problem = await Problem.findById(Number(req.params.problemId));
  if (!problem) { fail(res, 404, 'PROBLEM_NOT_FOUND', '题目不存在。'); return null; }
  res.locals.problemSetSubmission = { problemSetId: problemSet.id };
  if (access.manager && !access.participant) await addParticipants(problemSet.id, [user.id], 'managed');
  return problem;
}

app.post('/api/v2/problem-sets/:id/problems/:problemId/submissions', async (req, res) => {
  try {
    const problem = await submissionContext(req, res); if (!problem) return;
    return await syzoj.utils.submissionV2.createSubmission(req, res, problem, null);
  } catch (error) {
    syzoj.log('[problem-set-submission] ' + (error.stack || error));
    return fail(res, error.statusCode || 500, error.code || 'CONTENT_WRITE_FAILED', error.message || '题单提交创建失败。');
  }
});
app.post('/api/v2/problem-sets/:id/problems/:problemId/submit-answer', (req, res, next) => syzoj.utils.submissionV2.receiveSubmitAnswer(req, res, next), async (req, res) => {
  try {
    const problem = await submissionContext(req, res); if (!problem) return;
    if (problem.type !== 'submit-answer') return fail(res, 409, 'VALIDATION_FAILED', '该题不是答案提交题。');
    return await syzoj.utils.submissionV2.createSubmission(req, res, problem, null);
  } catch (error) {
    syzoj.log('[problem-set-answer-submission] ' + (error.stack || error));
    return fail(res, error.statusCode || 500, error.code || 'CONTENT_WRITE_FAILED', error.message || '题单提交创建失败。');
  } finally {
    if (req.file && req.file.path) await require('fs-extra').remove(req.file.path).catch(() => {});
  }
});

app.get('/problem-set/:id/submissions', async (req, res) => {
  try {
    const problemSet = await findProblemSet(req.params.id); if (!problemSet) throw Object.assign(new Error('题单不存在。'), { statusCode: 404 });
    const access = await accessState(problemSet, res.locals.user); if (!access.visible || !res.locals.user) throw Object.assign(new Error('请登录后查看提交记录。'), { statusCode: 401 });
    if (typeof syzoj.utils.renderSubmissionList !== 'function') throw Object.assign(new Error('提交记录服务尚未就绪。'), { statusCode: 503 });
    await syzoj.utils.renderSubmissionList(req, res, null, {
      problemSet,
      problemSetItems: await loadItems(problemSet.id),
      canManageDetails: access.manager
    });
  } catch (error) { res.status(error.statusCode || 500).render('error', { err: error }); }
});

async function ranklistData(problemSet) {
  const items = await loadItems(problemSet.id);
  const participants = await TypeORM.getConnection().query(
    `SELECT participant.user_id,user.username,user.is_admin,user.nameplate,MAX(temporary.user_id IS NOT NULL) AS is_temporary
       FROM problem_set_participant participant INNER JOIN user ON user.id=participant.user_id
       LEFT JOIN temporary_contest_account temporary ON temporary.user_id=participant.user_id
      WHERE participant.problem_set_id=? GROUP BY participant.user_id`, [problemSet.id]
  );
  const params = [problemSet.id];
  let deadline = '';
  if (problemSet.deadline_at) { deadline = ' AND link.submitted_at<=?'; params.push(problemSet.deadline_at); }
  const submissions = await TypeORM.getConnection().query(
    `SELECT judge.id,link.user_id,link.problem_id,judge.submit_time,judge.status,judge.pending,judge.score,action.judge_id AS admin_action
       FROM problem_set_submission link INNER JOIN judge_state judge ON judge.id=link.submission_id
       LEFT JOIN judge_state_admin_action action ON action.judge_id=judge.id
      WHERE link.problem_set_id=?${deadline} ORDER BY judge.submit_time,judge.id`, params
  );
  return { problems: items, allItems: buildRanklist(participants, submissions, items.map(item => item.problem_id), problemSet.ranking_mode, problemSet.published_at || 0) };
}

function accountFilter(value) { return ['contest', 'ordinary'].includes(String(value)) ? String(value) : 'all'; }

app.get('/problem-set/:id/ranklist', async (req, res) => {
  try {
    const problemSet = await findProblemSet(req.params.id); if (!problemSet) throw Object.assign(new Error('题单不存在。'), { statusCode: 404 });
    const access = await accessState(problemSet, res.locals.user); if (!access.visible) throw Object.assign(new Error('题单不存在。'), { statusCode: 404 });
    const data = await ranklistData(problemSet);
    const membership = await classGroups.membershipForUsers(data.allItems.map(item => item.user.id));
    const availableIds = new Set(membership.classes.map(group => group.id));
    const selectedClassIds = classGroups.normalizeClassIds(req.query.classes).filter(id => availableIds.has(id));
    const filter = accountFilter(req.query.account);
    const ranked = filterRanklist(data.allItems, problemSet.ranking_mode, filter, selectedClassIds, membership.byUser);
    const paginate = syzoj.utils.paginate(ranked.length, req.query.page, 100); const offset = paginate.pageCnt > 0 ? (paginate.currPage - 1) * paginate.perPage : 0;
    const page = ranked.slice(offset, offset + paginate.perPage);
    const canManageRanklist = await canManage(problemSet, res.locals.user, 'problemset:standings.export');
    const showIdentities = canManageRanklist && String(req.query.identity || '') === 'real';
    res.render('problem_set_ranklist', { problemSet, problemSetItems: data.problems, ranklist: page, paginate, rankOffset: offset, ranklistTotal: ranked.length, ranklistAccountFilter: filter, ranklistClassOptions: membership.classes, ranklistSelectedClassIds: selectedClassIds, canManageRanklist, showRanklistIdentities: showIdentities, ranklistProfiles: showIdentities ? await loadProfiles(page) : new Map() });
  } catch (error) { res.status(error.statusCode || 500).render('error', { err: error }); }
});

app.get('/problem-set/:id/ranklist/export', async (req, res) => {
  const problemSet = await findProblemSet(req.params.id);
  if (!problemSet || !await canManage(problemSet, res.locals.user, 'problemset:standings.export')) return res.status(403).render('error', { err: new ErrorMessage('您没有导出该题单榜单的权限。') });
  const data = await ranklistData(problemSet);
  const membership = await classGroups.membershipForUsers(data.allItems.map(item => item.user.id));
  const availableIds = new Set(membership.classes.map(group => group.id));
  const selectedClassIds = classGroups.normalizeClassIds(req.query.classes).filter(id => availableIds.has(id));
  const filter = accountFilter(req.query.account);
  const items = filterRanklist(data.allItems, problemSet.ranking_mode, filter, selectedClassIds, membership.byUser);
  const csv = buildProblemSetRanklistCsv({ problemSet, items, problemIds: data.problems.map(item => item.problem_id), profiles: await loadProfiles(items), classMembership: membership.byUser, filtered: filter !== 'all' || selectedClassIds.length > 0 });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="problem-set-${problemSet.id}-ranklist.csv"`); res.setHeader('Cache-Control', 'private, no-store'); res.send(csv);
});

app.get('/problem-set/:id/participants', async (req, res) => {
  const problemSet = await findProblemSet(req.params.id);
  if (!problemSet || !await canManage(problemSet, res.locals.user, 'problemset:registration.manage')) return res.status(403).render('error', { err: new ErrorMessage('您没有管理该题单报名的权限。') });
  const participants = await TypeORM.getConnection().query(`SELECT participant.user_id,participant.source,participant.created_at,user.username,profile.student_id,profile.real_name,profile.college FROM problem_set_participant participant INNER JOIN user ON user.id=participant.user_id LEFT JOIN user_registration_profile profile ON profile.user_id=participant.user_id WHERE participant.problem_set_id=? ORDER BY participant.created_at DESC`, [problemSet.id]);
  await classGroups.ensureSchema();
  const classes = await TypeORM.getConnection().query(`SELECT group_table.id,group_table.name,group_table.tag_text,COUNT(member.user_id) AS member_count FROM class_group group_table LEFT JOIN class_group_member member ON member.class_id=group_table.id WHERE group_table.status='active' AND (group_table.allow_activity_import=1 OR group_table.owner_id=? OR ?=1) GROUP BY group_table.id ORDER BY group_table.name`, [res.locals.user.id, classGroups.isUnrestricted(res.locals.user) ? 1 : 0]);
  res.render('problem_set_participants', { problemSet, participants, registrationClassOptions: classes });
});

app.post('/api/v2/problem-sets', async (req, res) => {
  const user = res.locals.user;
  if (!user || !await syzoj.utils.authorizationV2.authorize(user, 'problemset:create', null, { scope: 'global' })) return fail(res, user ? 403 : 401, user ? 'CAPABILITY_REQUIRED' : 'AUTHENTICATION_REQUIRED', '您没有创建题单的权限。');
  try {
    await ensureSchema(); const input = normalizeInput(req.body, null); await validateProblems(input.problemIds, user);
    const id = await TypeORM.getConnection().transaction(async manager => {
      const result = await manager.query(`INSERT INTO problem_set (title,description,owner_id,visibility,status,ranking_mode,allow_registration,deadline_at,published_at,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [input.title, input.description, user.id, input.visibility, input.status, input.rankingMode, input.allowRegistration ? 1 : 0, input.deadlineAt, input.status === 'published' ? Math.floor(Date.now() / 1000) : null]);
      await saveItems(manager, result.insertId, input.problemIds); return Number(result.insertId);
    });
    return syzoj.utils.apiV2.send(res, { id, revision: 1 }, 201);
  } catch (error) { return fail(res, error.statusCode || 422, error.code || 'VALIDATION_FAILED', error.message, error.field ? { [error.field]: 'invalid' } : {}); }
});

app.patch('/api/v2/problem-sets/:id', async (req, res) => {
  const problemSet = await requireManagedSet(req, res, 'problemset:edit'); if (!problemSet) return;
  try {
    const hasIfMatch = !!(req.get('If-Match') || req.body && req.body.if_match);
    if (hasIfMatch && !syzoj.utils.apiV2.ifMatch(req, problemSetEditResource(problemSet))) return fail(res, 412, 'ETAG_MISMATCH', 'The problem set changed. Refresh it before saving.');
    const input = normalizeInput(req.body, problemSet);
    if (input.problemIds) await validateProblems(input.problemIds, res.locals.user);
    await TypeORM.getConnection().transaction(async manager => {
      const lockedRows = await manager.query('SELECT * FROM problem_set WHERE id=? FOR UPDATE', [problemSet.id]);
      if (!lockedRows.length || hasIfMatch && !syzoj.utils.apiV2.ifMatch(req, problemSetEditResource(lockedRows[0]))) {
        throw Object.assign(new Error('The problem set changed. Refresh it before saving.'), { code: 'ETAG_MISMATCH', statusCode: 412 });
      }
      await manager.query(`UPDATE problem_set SET title=?,description=?,visibility=?,status=?,ranking_mode=?,allow_registration=?,deadline_at=?,published_at=CASE WHEN ?='published' THEN COALESCE(published_at,?) ELSE published_at END,revision=revision+1,updated_at=UTC_TIMESTAMP(3) WHERE id=?`, [input.title, input.description, input.visibility, input.status, input.rankingMode, input.allowRegistration ? 1 : 0, input.deadlineAt, input.status, Math.floor(Date.now() / 1000), problemSet.id]);
      if (input.problemIds) await saveItems(manager, problemSet.id, input.problemIds);
    });
    const updated = await findProblemSet(problemSet.id);
    syzoj.utils.apiV2.setResourceEtag(res, problemSetEditResource(updated));
    return syzoj.utils.apiV2.send(res, problemSetEditResource(updated));
  } catch (error) { return fail(res, error.statusCode || 422, error.code || 'VALIDATION_FAILED', error.message, error.field ? { [error.field]: 'invalid' } : {}); }
});

app.delete('/api/v2/problem-sets/:id', async (req, res) => {
  const problemSet = await requireManagedSet(req, res, 'problemset:delete'); if (!problemSet) return;
  await TypeORM.getConnection().query("UPDATE problem_set SET status='archived',visibility='private',revision=revision+1,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [problemSet.id]);
  return syzoj.utils.apiV2.send(res, { id: problemSet.id, archived: true });
});

app.post('/api/v2/problem-sets/:id/registration', async (req, res) => {
  const user = res.locals.user; const problemSet = await findProblemSet(req.params.id);
  if (!user || !problemSet) return fail(res, user ? 404 : 401, user ? 'RESOURCE_NOT_FOUND' : 'AUTHENTICATION_REQUIRED', user ? '题单不存在。' : '请登录后报名。');
  if (problemSet.status !== 'published' || problemSet.visibility !== 'public' || !problemSet.allow_registration || (problemSet.deadline_at && problemSet.deadline_at <= Math.floor(Date.now() / 1000))) return fail(res, 409, 'VALIDATION_FAILED', '该题单当前不开放报名。');
  await addParticipants(problemSet.id, [user.id], 'self'); return syzoj.utils.apiV2.send(res, { problem_set_id: problemSet.id, registered: true }, 201);
});
app.delete('/api/v2/problem-sets/:id/registration', async (req, res) => {
  const user = res.locals.user; const problemSet = await findProblemSet(req.params.id); if (!user || !problemSet) return fail(res, 404, 'RESOURCE_NOT_FOUND', '题单不存在。');
  const submitted = await TypeORM.getConnection().query('SELECT 1 FROM problem_set_submission WHERE problem_set_id=? AND user_id=? LIMIT 1', [problemSet.id, user.id]);
  if (submitted.length) return fail(res, 409, 'VALIDATION_FAILED', '已有题单提交后不能取消报名。');
  await TypeORM.getConnection().query('DELETE FROM problem_set_participant WHERE problem_set_id=? AND user_id=?', [problemSet.id, user.id]); return syzoj.utils.apiV2.send(res, { problem_set_id: problemSet.id, registered: false });
});

app.post('/api/v2/problem-sets/:id/participants', async (req, res) => {
  const problemSet = await requireManagedSet(req, res, 'problemset:registration.manage'); if (!problemSet) return;
  const requestedUserId = Number(req.body && req.body.user_id);
  if (Number.isSafeInteger(requestedUserId) && requestedUserId > 0) {
    const rows = await TypeORM.getConnection().query(
      `SELECT user.id AS user_id
         FROM user LEFT JOIN user_registration_profile profile ON profile.user_id=user.id AND profile.student_id_scope=?
         LEFT JOIN temporary_contest_account temporary_account ON temporary_account.user_id=user.id
        WHERE user.id=? AND temporary_account.user_id IS NULL AND COALESCE(user.is_admin,0)=0 LIMIT 1`,
      [ORDINARY_STUDENT_ID_SCOPE, requestedUserId]
    );
    if (!rows.length) return fail(res, 404, 'RESOURCE_NOT_FOUND', '未找到对应的普通账户。');
    const added = await addParticipants(problemSet.id, [requestedUserId], 'managed');
    return syzoj.utils.apiV2.send(res, { user_id: requestedUserId, added: !!added }, added ? 201 : 200);
  }
  const studentId = String(req.body && req.body.student_id || '').trim(); if (!/^\d{10}$/.test(studentId)) return fail(res, 422, 'VALIDATION_FAILED', '学号必须为 10 位数字。', { student_id: 'invalid' });
  const accounts = await ordinaryAccounts([studentId]); if (!accounts.has(studentId)) return fail(res, 404, 'RESOURCE_NOT_FOUND', '未找到对应的普通账户。');
  const account = accounts.get(studentId); const added = await addParticipants(problemSet.id, [account.user_id], 'managed'); return syzoj.utils.apiV2.send(res, { user_id: Number(account.user_id), added: !!added }, added ? 201 : 200);
});
app.delete('/api/v2/problem-sets/:id/participants/:userId', async (req, res) => {
  const problemSet = await requireManagedSet(req, res, 'problemset:registration.manage'); if (!problemSet) return;
  const userId = Number(req.params.userId);
  if (!Number.isSafeInteger(userId) || userId < 1) return fail(res, 422, 'VALIDATION_FAILED', '用户 ID 无效。', { user_id: 'invalid' });
  const result = await TypeORM.getConnection().query('DELETE FROM problem_set_participant WHERE problem_set_id=? AND user_id=?', [problemSet.id, userId]);
  return syzoj.utils.apiV2.send(res, { user_id: userId, removed: Number(result.affectedRows || 0) > 0 });
});
app.post('/api/v2/problem-sets/:id/participants/import', (req, res) => participantCsvUpload(req, res, async uploadError => {
  const problemSet = await requireManagedSet(req, res, 'problemset:registration.manage'); if (!problemSet) return;
  if (uploadError || !req.file) return fail(res, 422, 'VALIDATION_FAILED', uploadError ? uploadError.message : '请上传学号 CSV 文件。');
  try { const studentIds = normalizeStudentIdRows(req.file.buffer); const accounts = await ordinaryAccounts(studentIds); const added = await addParticipants(problemSet.id, Array.from(accounts.values()).map(account => account.user_id), 'csv'); return syzoj.utils.apiV2.send(res, { requested_count: studentIds.length, matched_count: accounts.size, added_count: added, missing_student_ids: studentIds.filter(id => !accounts.has(id)) }); } catch (error) { return fail(res, 422, 'VALIDATION_FAILED', error.message); }
}));
app.post('/api/v2/problem-sets/:id/participants/import-class', async (req, res) => {
  const problemSet = await requireManagedSet(req, res, 'problemset:registration.manage'); if (!problemSet) return;
  const classIds = classGroups.normalizeClassIds(req.body && req.body.class_ids); if (!classIds.length) return fail(res, 422, 'VALIDATION_FAILED', '请至少选择一个班级。');
  const groups = await TypeORM.getConnection().query("SELECT * FROM class_group WHERE status='active' AND id IN (?)", [classIds]);
  if (groups.length !== classIds.length || groups.some(group => !group.allow_activity_import && !classGroups.isUnrestricted(res.locals.user) && Number(group.owner_id) !== Number(res.locals.user.id))) return fail(res, 403, 'CAPABILITY_REQUIRED', '所选班级不存在或不允许用于活动报名。');
  const rows = await TypeORM.getConnection().query(`SELECT DISTINCT member.user_id FROM class_group_member member LEFT JOIN temporary_contest_account temporary ON temporary.user_id=member.user_id WHERE member.class_id IN (?) AND temporary.user_id IS NULL`, [classIds]);
  const added = await addParticipants(problemSet.id, rows.map(row => row.user_id), 'class'); return syzoj.utils.apiV2.send(res, { matched_count: rows.length, added_count: added, class_ids: classIds });
});

ensureSchema().catch(error => syzoj.log('[problem-sets] ' + (error.stack || error)));
syzoj.utils.problemSets = { ensureSchema, findProblemSet, canManage, loadItems };
