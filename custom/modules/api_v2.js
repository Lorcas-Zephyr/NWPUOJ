const jwt = require('jsonwebtoken');
const url = require('url');

app.get('/api/v2/search/users/:keyword*?', async (req, res) => {
  try {
    const User = syzoj.model('user');
    const keyword = req.params.keyword || '';
    const conditions = [];
    const uid = parseInt(keyword) || 0;
    if (uid != null && !isNaN(uid)) conditions.push({ id: uid });
    if (keyword != null && String(keyword).length >= 2) {
      conditions.push({ username: TypeORM.Like(`%${req.params.keyword}%`) });
    }
    if (!conditions.length) return res.send({ success: true, results: [] });
    const users = await User.find({ where: conditions, order: { username: 'ASC' } });
    res.send({
      success: true,
      results: users.map(user => ({
        name: user.username,
        value: user.id,
        url: syzoj.utils.makeUrl(['user', user.id])
      }))
    });
  } catch (error) {
    syzoj.log(error);
    res.send({ success: false });
  }
});

app.get('/api/v2/search/problems/:keyword*?', async (req, res) => {
  try {
    const Problem = syzoj.model('problem');
    const keyword = req.params.keyword || '';
    const problems = await Problem.find({
      where: { title: TypeORM.Like(`%${keyword}%`) },
      order: { id: 'ASC' }
    });
    const result = [];
    const id = parseInt(keyword);
    const contestOnly = req.query.contest === '1';

    async function mayReturn(problem) {
      if (!problem || !await problem.isAllowedUseBy(res.locals.user)) return false;
      if (contestOnly && syzoj.utils.contestSubmissionEnabled && !syzoj.utils.contestSubmissionEnabled(problem)) {
        return false;
      }
      if (!syzoj.utils.canAccessProblemOutsideContest) return true;
      return syzoj.utils.canAccessProblemOutsideContest(problem.id, res.locals.user);
    }

    if (id) {
      const problemById = await Problem.findById(id);
      if (await mayReturn(problemById)) result.push(problemById);
    }
    for (const problem of problems) {
      if (result.length >= syzoj.config.page.edit_contest_problem_list) break;
      if (problem.id !== id && await mayReturn(problem)) result.push(problem);
    }
    res.send({
      success: true,
      results: result.map(problem => ({
        name: `${problem.getDisplayId()}. ${problem.title}`,
        value: problem.id,
        url: syzoj.utils.makeUrl(['problem', problem.id])
      }))
    });
  } catch (error) {
    syzoj.log(error);
    res.send({ success: false });
  }
});

app.get('/api/v2/search/tags/:keyword*?', async (req, res) => {
  try {
    const ProblemTag = syzoj.model('problem_tag');
    const tags = await ProblemTag.find({
      where: { name: TypeORM.Like(`%${req.params.keyword || ''}%`) },
      order: { name: 'ASC' }
    });
    res.send({
      success: true,
      results: tags.slice(0, syzoj.config.page.edit_problem_tag_list)
        .map(tag => ({ name: tag.name, value: tag.id }))
    });
  } catch (error) {
    syzoj.log(error);
    res.send({ success: false });
  }
});

app.apiRouter.post('/api/v2/markdown', async (req, res) => {
  try {
    res.send(await syzoj.utils.markdown(req.body.s.toString(), null, req.body.noReplaceUI === 'true'));
  } catch (error) {
    syzoj.log(error);
    res.send(error);
  }
});

function verifyJWT(token) {
  try {
    jwt.verify(token, syzoj.config.session_secret);
    return true;
  } catch (error) {
    return false;
  }
}

app.apiRouter.get('/api/v2/download/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const data = jwt.decode(token);
    if (!data) throw new ErrorMessage('无效的令牌。');
    if (url.parse(syzoj.utils.getCurrentLocation(req, true)).href !== url.parse(syzoj.config.site_for_download).href) {
      throw new ErrorMessage('无效的下载地址。');
    }
    if (verifyJWT(token)) res.download(data.filename, data.sendName);
    else res.redirect(data.originUrl);
  } catch (error) {
    syzoj.log(error);
    res.render('error', { err: error });
  }
});
