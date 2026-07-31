const TypeORM = require('typeorm');
let Problem = syzoj.model('problem');
let ProblemSolutionComment = syzoj.model('problem-solution-comment');
let ProblemSolution = syzoj.model('problem-solution');
let User = syzoj.model('user');
let ProblemSolutionSetting = syzoj.model('problem-solution-setting');

async function canReviewSolutions(user) {
  return !!(user && await syzoj.utils.authorizationV2.authorize(user, 'solution:moderate', null, { scope: 'global' }));
}

async function canManageSolutionSetting(user, problem) {
  return !!(user && problem && await syzoj.utils.authorizationV2.authorize(user, 'problem:edit', {
    ownerId: problem.user_id, scope: `problem:${problem.id}`
  }, { scope: `problem:${problem.id}` }));
}

// ============ 题目下的题解列表 ============
app.get('/problem/:pid/solutions', async (req, res) => {
  try {
    let pid = parseInt(req.params.pid);
    let problem = await Problem.findById(pid);
    if (!problem) throw new ErrorMessage('无此题目。');
    if (!await problem.isAllowedUseBy(res.locals.user)) {
      throw new ErrorMessage('您没有权限进行此操作。');
    }

    let user = res.locals.user;

    // 普通用户只能看 accepted 的;管理员看所有;投稿人能看自己的所有
    let canReview = await canReviewSolutions(user);
    let where;
    if (canReview) {
      where = { problem_id: pid };
    } else if (user) {
      // 公开通过的 OR 自己投的
      where = [
        { problem_id: pid, status: 'accepted' },
        { problem_id: pid, user_id: user.id }
      ];
    } else {
      where = { problem_id: pid, status: 'accepted' };
    }

    let pageSize = 20;
    let total = await ProblemSolution.count(where);
    let paginate = syzoj.utils.paginate(total, req.query.page, pageSize);
    let solutions = await ProblemSolution.queryPage(paginate, where, {
      public_time: 'DESC'
    });

    // 加载作者信息
    for (let sol of solutions) {
      sol.user = await User.findById(sol.user_id);
      sol.allowedEdit = await sol.isAllowedEditBy(res.locals.user);
    }
    // 检查题目是否禁用了题解投稿
    let setting = await ProblemSolutionSetting.findOne({ where: { problem_id: pid } });
    let submissionDisabled = !!(setting && setting.disable_submission);

    let canManageSetting = await canManageSolutionSetting(user, problem);

    // 当前用户能否投稿(登录 + 没禁用 || 是审核者)
    // 审核者也无法投稿,但他能看到关闭状态并切换
    let allowedPost = !!user && !submissionDisabled && await syzoj.utils.isEmailVerified(user.id);

    res.render('solutions', {
      problem: problem,
      solutions: solutions,
      paginate: paginate,
      allowedPost: allowedPost,
      submissionDisabled: submissionDisabled,
      canManageSetting: canManageSetting
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 跳转到新建页面 ============
app.get('/problem/:pid/solution/new', async (req, res) => {
  try {
    if (!res.locals.user) {
      throw new ErrorMessage('请登录后继续。', {
        '登录': syzoj.utils.makeUrl(['login'], { 'url': req.originalUrl })
      });
    }

    let pid = parseInt(req.params.pid);
    let problem = await Problem.findById(pid);
    if (!problem) throw new ErrorMessage('无此题目。');
    if (!await problem.isAllowedUseBy(res.locals.user)) {
      throw new ErrorMessage('您没有权限进行此操作。');
    }
    // 检查题目是否禁用了题解投稿
    let setting = await ProblemSolutionSetting.findOne({ where: { problem_id: pid } });
    if (setting && setting.disable_submission) {
      throw new ErrorMessage('该题已关闭题解提交。', {
        '查看现有题解': syzoj.utils.makeUrl(['problem', pid, 'solutions'])
      });
    }
    
    // 检查邮箱是否已验证
    if (!await syzoj.utils.isEmailVerified(res.locals.user.id)) {
      throw new ErrorMessage('请先验证邮箱后再投稿题解。', {
        '前往验证': syzoj.utils.makeUrl(['user', res.locals.user.id, 'edit'])
      });
    }

    res.redirect(syzoj.utils.makeUrl(['solution', 0, 'edit'], { pid: pid }));
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 题解详情 ============
app.get('/solution/:id', async (req, res) => {
  try {
    let id = parseInt(req.params.id);
    let solution = await ProblemSolution.findById(id);
    if (!solution) throw new ErrorMessage('无此题解。');

    const canReview = await canReviewSolutions(res.locals.user);
    if (!canReview && !(await solution.isAllowedSeeBy(res.locals.user))) {
      throw new ErrorMessage('您没有权限查看此题解。');
    }

    let problem = await Problem.findById(solution.problem_id);
    if (!problem) throw new ErrorMessage('题解所属题目不存在。');
    if (!await problem.isAllowedUseBy(res.locals.user)) {
      throw new ErrorMessage('您没有权限查看此题解。');
    }

    solution.user = await User.findById(solution.user_id);
    // 加载审核员信息
    if (solution.reviewer_id) {
      solution.reviewer = await User.findById(solution.reviewer_id);
    }
    solution.allowedEdit = await solution.isAllowedEditBy(res.locals.user);
    solution.allowedComment = solution.status === 'accepted' && (
      canReview || solution.isAllowedCommentBy(res.locals.user)
    );
    solution.contentRendered = await syzoj.utils.markdown(solution.content || '');

    // 加载评论列表
    let commentsCount = await ProblemSolutionComment.count({ solution_id: solution.id });
    let pageSize = (syzoj.config.page && syzoj.config.page.article_comment) || 10;
    let paginate = syzoj.utils.paginate(commentsCount, req.query.page, pageSize);
    let comments = await ProblemSolutionComment.queryPage(paginate, { solution_id: solution.id }, {
      public_time: 'DESC'
    });

    for (let c of comments) {
      c.user = await User.findById(c.user_id);
      c.allowedEdit = canReview || await c.isAllowedEditBy(res.locals.user);
      c.contentRendered = await syzoj.utils.markdown(c.content || '');
    }
    res.render('solution', {
      solution: solution,
      problem: problem,
      canReview: canReview,
      comments: comments,
      commentsCount: commentsCount,
      paginate: paginate
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 编辑/新建页面 GET ============
app.get('/solution/:id/edit', async (req, res) => {
  try {
    if (!res.locals.user) {
      throw new ErrorMessage('请登录后继续。', {
        '登录': syzoj.utils.makeUrl(['login'], { 'url': req.originalUrl })
      });
    }

    let id = parseInt(req.params.id);
    let solution;
    let problem;

    if (id === 0) {
      // 新建
      if (!await syzoj.utils.isEmailVerified(res.locals.user.id)) {
        throw new ErrorMessage('请先验证邮箱后再投稿题解。');
      }
      let pid = parseInt(req.query.pid);
      problem = await Problem.findById(pid);
      if (!problem) throw new ErrorMessage('无此题目。');
      if (!await problem.isAllowedUseBy(res.locals.user)) {
        throw new ErrorMessage('您没有权限进行此操作。');
      }
      // 检查题目是否禁用了题解投稿
      let setting = await ProblemSolutionSetting.findOne({ where: { problem_id: pid } });
      if (setting && setting.disable_submission) {
        throw new ErrorMessage('该题已关闭题解提交。');
      }
      solution = await ProblemSolution.create();
      solution.id = 0;
      solution.problem_id = pid;
      solution.title = '';
      solution.content = '';
      solution.allowedEdit = true;
    } else {
      // 编辑
      solution = await ProblemSolution.findById(id);
      if (!solution) throw new ErrorMessage('无此题解。');

      if (!await solution.isAllowedEditBy(res.locals.user)) {
        throw new ErrorMessage('您没有权限编辑此题解。');
      }

      problem = await Problem.findById(solution.problem_id);
      if (!problem) throw new ErrorMessage('题解所属题目不存在。');
      solution.allowedEdit = true;
    }

    res.render('solution_edit', {
      solution: solution,
      problem: problem
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 编辑/新建页面 POST ============

// ============ 撤回题解 ============

// ============ 删除题解 ============
// ============ 管理员:题解管理列表 ============
app.get('/admin/solutions', async (req, res) => {
  try {
    if (!await canReviewSolutions(res.locals.user)) {
      throw new ErrorMessage('您没有权限进行此操作。');
    }

    // 按状态筛选,默认 pending(待审核)
    let status = req.query.status || 'pending';
    let validStatus = ['pending', 'accepted', 'rejected', 'withdrawn', 'all'];
    if (!validStatus.includes(status)) status = 'pending';

    let where = (status === 'all') ? {} : { status: status };

    let pageSize = 30;
    let total = await ProblemSolution.count(where);
    let paginate = syzoj.utils.paginate(total, req.query.page, pageSize);
    let solutions = await ProblemSolution.queryPage(paginate, where, {
      public_time: 'DESC'
    });

    // 加载关联信息
    for (let sol of solutions) {
      sol.user = await User.findById(sol.user_id);
      sol.problem = await Problem.findById(sol.problem_id);
      // 加载审核员信息
      if (sol.reviewer_id) {
        sol.reviewer = await User.findById(sol.reviewer_id);
      }
    }
    // 各状态计数(用于在标签上显示数字)
    let counts = {
      pending: await ProblemSolution.count({ status: 'pending' }),
      accepted: await ProblemSolution.count({ status: 'accepted' }),
      rejected: await ProblemSolution.count({ status: 'rejected' }),
      withdrawn: await ProblemSolution.count({ status: 'withdrawn' })
    };
    counts.all = counts.pending + counts.accepted + counts.rejected + counts.withdrawn;

    res.render('admin_solutions', {
      solutions: solutions,
      paginate: paginate,
      currentStatus: status,
      counts: counts
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 管理员:审核通过 ============

// ============ 管理员:审核拒绝 ============

// ============ 提交评论 ============

// ============ 删除评论 ============
// ============ 审核者:切换题目题解提交开关 ============
