// 比赛删除路由(SYZOJ 原生没有提供此功能)
// 文件名以 _ 开头确保字母序较早加载
let Contest = syzoj.model('contest');
let crypto = require('crypto');
let contestMutation = require('../libs/contest-mutation');

// 权限:管理员 OR 比赛创建者(holder_id) OR 拥有比赛管理权限的用户
async function canDeleteContest(user, contest) {
  if (!user) return false;
  if (user.is_admin) return true;
  if (contest.holder_id === user.id) return true;
  if (await user.hasPrivilege('manage_contest')) return true;
  return false;
}

app.post('/contest/:id/delete', async (req, res) => {
  try {
    if (!res.locals.user) throw new ErrorMessage('请登录后继续。');

    let id = parseInt(req.params.id);
    let contest = await Contest.findById(id);
    if (!contest) throw new ErrorMessage('无此比赛。');

    if (!await canDeleteContest(res.locals.user, contest)) {
      throw new ErrorMessage('您没有权限删除此比赛。');
    }
    const expectedToken = req.session && req.session.adminCsrfToken;
    const actualToken = req.body && req.body.csrf_token;
    if (typeof expectedToken !== 'string' || typeof actualToken !== 'string' || expectedToken.length !== actualToken.length ||
      !crypto.timingSafeEqual(Buffer.from(expectedToken), Buffer.from(actualToken))) {
      res.status(403);
      throw new ErrorMessage('页面已失效，请刷新比赛编辑页后重试。');
    }

    await contestMutation.deleteContest(id);

    res.redirect(syzoj.utils.makeUrl(['contests']));
  } catch (e) {
    syzoj.log(e);
    res.status(e.statusCode || 400).render('error', { err: e });
  }
});
