const TypeORM = require('typeorm');
const { ensureRegistrationProfileSchema, ORDINARY_STUDENT_ID_SCOPE } = require('../libs/registration-profile-schema');

app.get('/api/v2/search/users/:keyword*?', async (req, res) => {
  const api = syzoj.utils.apiV2;
  try {
    const keyword = String(req.params.keyword || '').trim();
    const uid = Number.parseInt(keyword, 10);
    const terms = [];
    const params = [];
    if (Number.isSafeInteger(uid) && uid > 0 && String(uid) === keyword) {
      terms.push('(u.id = ? OR profile.student_id = ?)');
      params.push(uid, keyword);
    }
    if (keyword.length >= 2) {
      terms.push('(u.username LIKE ? OR profile.student_id LIKE ? OR profile.real_name LIKE ?)');
      const pattern = `%${keyword}%`;
      params.push(pattern, pattern, pattern);
    }
    if (!terms.length) return api.send(res, []);
    await ensureRegistrationProfileSchema();
    let sql = `SELECT DISTINCT u.id,u.username,profile.student_id,profile.real_name,profile.college
                 FROM user u
                 LEFT JOIN user_registration_profile profile ON profile.user_id=u.id AND profile.student_id_scope=?`;
    const queryParams = [ORDINARY_STUDENT_ID_SCOPE];
    // Keep ordinary search scoped away from temporary users (the legacy equivalent was
    // `FROM temporary_contest_account WHERE user_id IN (?)`).
    if (req.query.ordinary === '1') sql += ' LEFT JOIN temporary_contest_account temporary_account ON temporary_account.user_id=u.id';
    sql += ` WHERE (${terms.join(' OR ')})`;
    queryParams.push(...params);
    if (req.query.ordinary === '1') sql += ' AND temporary_account.user_id IS NULL AND COALESCE(u.is_admin,0)=0';
    sql += ' ORDER BY u.username ASC LIMIT 50';
    const users = await TypeORM.getConnection().query(sql, queryParams);
    return api.send(res, users.map(user => ({
      name: user.username,
      username: user.username,
      value: user.id,
      student_id: user.student_id || null,
      real_name: user.real_name || null,
      college: user.college || null,
      url: syzoj.utils.makeUrl(['user', user.id])
    })));
  } catch (error) {
    syzoj.log(error);
    return api.fail(res, 503, 'SEARCH_UNAVAILABLE', 'User search is temporarily unavailable.');
  }
});

app.get('/api/v2/search/problems/:keyword*?', async (req, res) => {
  const api = syzoj.utils.apiV2;
  try {
    const Problem = syzoj.model('problem');
    const keyword = String(req.params.keyword || '').trim();
    const problems = keyword ? await Problem.createQueryBuilder('problem')
      .leftJoin('problem_v2_state', 'problem_state', 'problem_state.problem_id = problem.id')
      .leftJoin('problem_v2_version', 'current_version', 'current_version.id = problem_state.current_version_id')
      .where("COALESCE(JSON_UNQUOTE(JSON_EXTRACT(current_version.content_json, '$.title')), problem.title) LIKE :title", {
        title: `%${keyword}%`
      })
      .orderBy('problem.id', 'ASC')
      .getMany() : [];
    const result = [];
    const id = Number.parseInt(keyword, 10);
    const contestOnly = req.query.contest === '1';

    async function mayReturn(problem) {
      if (!problem || !await problem.isAllowedUseBy(res.locals.user)) return false;
      if (contestOnly && syzoj.utils.contestSubmissionEnabled && !syzoj.utils.contestSubmissionEnabled(problem)) return false;
      if (!syzoj.utils.canAccessProblemOutsideContest) return true;
      return syzoj.utils.canAccessProblemOutsideContest(problem.id, res.locals.user);
    }

    if (Number.isSafeInteger(id) && id > 0) {
      const problemById = await Problem.findById(id);
      if (await mayReturn(problemById)) result.push(problemById);
    }
    for (const problem of problems) {
      if (problem.id !== id && await mayReturn(problem)) result.push(problem);
    }
    if (syzoj.utils.problemV2 && syzoj.utils.problemV2.loadCurrentVersionContent) {
      await Promise.all(result.map(async problem => {
        const current = await syzoj.utils.problemV2.loadCurrentVersionContent(problem.id);
        if (current) Object.assign(problem, current.content);
      }));
    }
    return api.send(res, result.map(problem => ({
      name: `${problem.getDisplayId()}. ${problem.title}`,
      value: problem.id,
      url: syzoj.utils.makeUrl(['problem', problem.id])
    })));
  } catch (error) {
    syzoj.log(error);
    return api.fail(res, 503, 'SEARCH_UNAVAILABLE', 'Problem search is temporarily unavailable.');
  }
});

app.get('/api/v2/search/tags/:keyword*?', async (req, res) => {
  const api = syzoj.utils.apiV2;
  try {
    const ProblemTag = syzoj.model('problem_tag');
    const tags = await ProblemTag.find({
      where: { name: TypeORM.Like(`%${req.params.keyword || ''}%`) },
      order: { name: 'ASC' }
    });
    return api.send(res, tags.slice(0, syzoj.config.page.edit_problem_tag_list)
      .map(tag => ({ name: tag.name, value: tag.id })));
  } catch (error) {
    syzoj.log(error);
    return api.fail(res, 503, 'SEARCH_UNAVAILABLE', 'Tag search is temporarily unavailable.');
  }
});

app.post('/api/v2/markdown', async (req, res) => {
  const api = syzoj.utils.apiV2;
  try {
    const source = req.body && req.body.s;
    if (typeof source !== 'string') {
      return api.fail(res, 422, 'VALIDATION_FAILED', 'Markdown source is required.', { s: 'required string' });
    }
    const html = await syzoj.utils.markdown(source, null, req.body.noReplaceUI === 'true');
    return api.send(res, { html });
  } catch (error) {
    syzoj.log(error);
    return api.fail(res, 500, 'MARKDOWN_RENDER_FAILED', 'Markdown could not be rendered.');
  }
});
