const TypeORM = require('typeorm');

app.get('/api/v2/search/users/:keyword*?', async (req, res) => {
  const api = syzoj.utils.apiV2;
  try {
    const User = syzoj.model('user');
    const keyword = req.params.keyword || '';
    const conditions = [];
    const uid = Number.parseInt(keyword, 10);
    if (Number.isSafeInteger(uid) && uid > 0) conditions.push({ id: uid });
    if (keyword.length >= 2) conditions.push({ username: TypeORM.Like(`%${keyword}%`) });
    if (!conditions.length) return api.send(res, []);
    const users = await User.find({ where: conditions, order: { username: 'ASC' } });
    return api.send(res, users.map(user => ({
      name: user.username,
      value: user.id,
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
    const keyword = req.params.keyword || '';
    const problems = await Problem.find({
      where: { title: TypeORM.Like(`%${keyword}%`) },
      order: { id: 'ASC' }
    });
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
      if (result.length >= syzoj.config.page.edit_contest_problem_list) break;
      if (problem.id !== id && await mayReturn(problem)) result.push(problem);
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
