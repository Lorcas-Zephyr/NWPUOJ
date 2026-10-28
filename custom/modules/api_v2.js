const jwt = require('jsonwebtoken');
const url = require('url');

// Some public gateways reject PATCH/PUT/DELETE before the request reaches OJ.
// Accept a POST transport while restoring the effective method for downstream routes.
const OVERRIDABLE_METHODS = new Set(['PATCH', 'PUT', 'DELETE']);
app.apiRouter.use((req, res, next) => {
  if (req.method !== 'POST' || !/^\/api\/v2(?:\/|$)/.test(req.path)) return next();
  const override = String(req.get('x-http-method-override') || '').trim().toUpperCase();
  if (!OVERRIDABLE_METHODS.has(override)) return next();
  req.originalMethod = req.method;
  req.method = override;
  next();
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
    if (verifyJWT(token)) {
      const base = syzoj.utils.baseWorkspace;
      if (base) {
        const sourcePath = decodeURIComponent(url.parse(String(data.originUrl || '')).pathname || '').toLowerCase();
        const problemMatch = /^\/problem\/(\d+)\//.exec(sourcePath);
        const contestMatch = /^\/contest\/(\d+)\//.exec(sourcePath);
        if (res.locals.user && syzoj.utils.isTemporaryContestAccount &&
            await syzoj.utils.isTemporaryContestAccount(res.locals.user.id)) {
          const contestId = contestMatch && Number(contestMatch[1]);
          if (!contestId || !syzoj.utils.temporaryContestContentAllowed ||
              !await syzoj.utils.temporaryContestContentAllowed(res.locals.user.id, contestId)) {
            return res.status(403).send('临时比赛账户只能下载当前比赛中交卷前可见的附件。');
          }
        }
        if (problemMatch && await base.contains('problem', problemMatch[1])) {
          const problem = await syzoj.model('problem').findById(Number(problemMatch[1]));
          if (!await base.canReadProblem(problem, res.locals.user)) return res.status(403).send('仅基地成员可以下载此文件。');
          if (sourcePath.includes('/testdata/') && !await base.canManage('problem', problem, res.locals.user)) return res.status(403).send('只有题目创建者或全站管理员可以下载评测数据。');
        }
        if (contestMatch && !await base.canAccessContest(Number(contestMatch[1]), res.locals.user)) return res.status(403).send('仅基地成员可以下载此文件。');
      }
      res.download(data.filename, data.sendName);
    }
    else res.redirect(data.originUrl);
  } catch (error) {
    syzoj.log(error);
    res.render('error', { err: error });
  }
});
