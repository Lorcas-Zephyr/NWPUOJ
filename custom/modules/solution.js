const TypeORM = require('typeorm');
let Problem = syzoj.model('problem');
let ProblemSolutionComment = syzoj.model('problem-solution-comment');
let ProblemSolution = syzoj.model('problem-solution');
let User = syzoj.model('user');
let ProblemSolutionSetting = syzoj.model('problem-solution-setting');

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
    let canReview = user && (user.is_admin || await user.hasPrivilege('manage_problem'));
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

    let canManageSetting = user && (user.is_admin || (user.privileges && user.privileges.includes('manage_problem')));

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

    if (!(await solution.isAllowedSeeBy(res.locals.user))) {
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
    solution.allowedComment = solution.isAllowedCommentBy(res.locals.user);
    solution.contentRendered = await syzoj.utils.markdown(solution.content || '');

    let canReview = res.locals.user && (res.locals.user.is_admin || await res.locals.user.hasPrivilege('manage_problem'));

    // 加载评论列表
    let commentsCount = await ProblemSolutionComment.count({ solution_id: solution.id });
    let pageSize = (syzoj.config.page && syzoj.config.page.article_comment) || 10;
    let paginate = syzoj.utils.paginate(commentsCount, req.query.page, pageSize);
    let comments = await ProblemSolutionComment.queryPage(paginate, { solution_id: solution.id }, {
      public_time: 'DESC'
    });

    for (let c of comments) {
      c.user = await User.findById(c.user_id);
      c.allowedEdit = await c.isAllowedEditBy(res.locals.user);
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
app.post('/solution/:id/edit', async (req, res) => {
  try {
    if (!res.locals.user) throw new ErrorMessage('请登录后继续。');

    let id = parseInt(req.params.id);
    let solution;
    let isNew = false;

    if (id === 0) {
      // 新建
      if (!await syzoj.utils.isEmailVerified(res.locals.user.id)) {
        throw new ErrorMessage('请先验证邮箱后再投稿题解。');
      }
      let pid = parseInt(req.body.problem_id);
      let problem = await Problem.findById(pid);
      if (!problem) throw new ErrorMessage('无此题目。');
      if (!await problem.isAllowedUseBy(res.locals.user)) {
        throw new ErrorMessage('您没有权限进行此操作。');
      }
      let setting = await ProblemSolutionSetting.findOne({ where: { problem_id: pid } });
      if (setting && setting.disable_submission) {
        throw new ErrorMessage('该题已关闭题解提交。');
      }

      solution = await ProblemSolution.create();
      solution.problem_id = pid;
      solution.user_id = res.locals.user.id;
      solution.public_time = parseInt((new Date()).getTime() / 1000);
      // 管理员投稿直接 accepted,普通用户 pending
      solution.status = res.locals.user.is_admin ? 'accepted' : 'pending';
      isNew = true;
    } else {
      solution = await ProblemSolution.findById(id);
      if (!solution) throw new ErrorMessage('无此题解。');
      if (!await solution.isAllowedEditBy(res.locals.user)) {
        throw new ErrorMessage('您没有权限编辑此题解。');
      }
    }

    let title = (req.body.title || '').trim();
    let content = (req.body.content || '').trim();

    if (!title) throw new ErrorMessage('标题不能为空。');
    if (title.length > 80) throw new ErrorMessage('标题过长(最多 80 字符)。');
    if (!content) throw new ErrorMessage('内容不能为空。');

    const updateTime = parseInt((new Date()).getTime() / 1000);
    const allowComment = req.body.allow_comment === 'on' || req.body.allow_comment === 'true';
    if (isNew) {
      solution.title = title;
      solution.content = content;
      solution.update_time = updateTime;
      solution.allow_comment = allowComment;
      await solution.save();
    } else {
      if (res.locals.user.is_admin) {
        await TypeORM.getConnection().query(`
          UPDATE problem_solution
          SET title=?,content=?,update_time=?,allow_comment=?
          WHERE id=?
        `, [title, content, updateTime, allowComment, solution.id]);
      } else {
        await TypeORM.getConnection().query(`
          UPDATE problem_solution
          SET title=?,content=?,update_time=?,allow_comment=?,status='pending',
              reviewer_id=NULL,reviewed_at=NULL,reject_reason=NULL
          WHERE id=? AND user_id=?
        `, [title, content, updateTime, allowComment, solution.id, res.locals.user.id]);
      }
      solution = await ProblemSolution.findById(solution.id);
      if (!solution) throw new ErrorMessage('题解已被删除。');
    }

    res.redirect(syzoj.utils.makeUrl(['solution', solution.id]));
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 撤回题解 ============
app.post('/solution/:id/withdraw', async (req, res) => {
  try {
    if (!res.locals.user) throw new ErrorMessage('请登录后继续。');

    let id = parseInt(req.params.id);
    let solution = await ProblemSolution.findById(id);
    if (!solution) throw new ErrorMessage('无此题解。');

    // 只有投稿人本人可以撤回
    if (solution.user_id !== res.locals.user.id) {
      throw new ErrorMessage('您没有权限撤回此题解。');
    }

    const result = await TypeORM.getConnection().query(`
      UPDATE problem_solution SET status='withdrawn',update_time=?
      WHERE id=? AND user_id=? AND status<>'withdrawn'
    `, [parseInt((new Date()).getTime() / 1000), id, res.locals.user.id]);
    if (!result || result.affectedRows !== 1) throw new ErrorMessage('题解状态已变更，请刷新页面。');

    res.redirect(syzoj.utils.makeUrl(['problem', solution.problem_id, 'solutions']));
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 删除题解 ============
app.post('/solution/:id/delete', async (req, res) => {
  try {
    if (!res.locals.user) throw new ErrorMessage('请登录后继续。');

    let id = parseInt(req.params.id);
    let solution = await ProblemSolution.findById(id);
    if (!solution) throw new ErrorMessage('无此题解。');

    if (!await solution.isAllowedEditBy(res.locals.user)) {
      throw new ErrorMessage('您没有权限删除此题解。');
    }

    let pid = solution.problem_id;
    await solution.destroy();

    res.redirect(syzoj.utils.makeUrl(['problem', pid, 'solutions']));
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});
// ============ 管理员:题解管理列表 ============
app.get('/admin/solutions', async (req, res) => {
  try {
    if (!res.locals.user || !(res.locals.user.is_admin || await res.locals.user.hasPrivilege('manage_problem'))) {
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
app.post('/solution/:id/approve', async (req, res) => {
  try {
    if (!res.locals.user || !(res.locals.user.is_admin || await res.locals.user.hasPrivilege('manage_problem'))) {
      throw new ErrorMessage('您没有权限进行此操作。');
    }

    let id = parseInt(req.params.id);
    let solution = await ProblemSolution.findById(id);
    if (!solution) throw new ErrorMessage('无此题解。');

    const reviewedAt = parseInt((new Date()).getTime() / 1000);
    const result = await TypeORM.getConnection().query(`
      UPDATE problem_solution
      SET status='accepted',reviewer_id=?,reviewed_at=?,reject_reason=NULL,update_time=?
      WHERE id=? AND status IN ('pending','rejected')
    `, [res.locals.user.id, reviewedAt, reviewedAt, id]);
    if (!result || result.affectedRows !== 1) throw new ErrorMessage('题解状态已被其他审核操作更新，请刷新页面。');
    solution = await ProblemSolution.findById(id);
    // 通知作者
    try {
      await syzoj.utils.createNotification({
        recipientId: solution.user_id,
        type: 'solution_approved',
        title: '您的题解《' + (solution.title || '无标题') + '》已通过审核',
        content: '审核员：' + res.locals.user.username,
        sourceUrl: syzoj.utils.makeUrl(['solution', solution.id]),
        sourceId: solution.id,
        actorId: res.locals.user.id
      });
    } catch (e) { syzoj.log('[notification] solution_approved failed: ' + e.message); }

    res.redirect(syzoj.utils.makeUrl(['solution', solution.id]));
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 管理员:审核拒绝 ============
app.post('/solution/:id/reject', async (req, res) => {
  try {
    if (!res.locals.user || !(res.locals.user.is_admin || await res.locals.user.hasPrivilege('manage_problem'))) {
      throw new ErrorMessage('您没有权限进行此操作。');
    }

    let id = parseInt(req.params.id);
    let solution = await ProblemSolution.findById(id);
    if (!solution) throw new ErrorMessage('无此题解。');

    const reason = (req.body.reason || '').trim();
    const reviewedAt = parseInt((new Date()).getTime() / 1000);
    const result = await TypeORM.getConnection().query(`
      UPDATE problem_solution
      SET status='rejected',reviewer_id=?,reviewed_at=?,reject_reason=?,update_time=?
      WHERE id=? AND status='pending'
    `, [res.locals.user.id, reviewedAt, reason, reviewedAt, id]);
    if (!result || result.affectedRows !== 1) throw new ErrorMessage('题解状态已被其他审核操作更新，请刷新页面。');
    solution = await ProblemSolution.findById(id);
    // 通知作者
    try {
      await syzoj.utils.createNotification({
        recipientId: solution.user_id,
        type: 'solution_rejected',
        title: '您的题解《' + (solution.title || '无标题') + '》未通过审核',
        content: '审核员：' + res.locals.user.username + '\n原因：' + reason,
        sourceUrl: syzoj.utils.makeUrl(['solution', solution.id]),
        sourceId: solution.id,
        actorId: res.locals.user.id
      });
    } catch (e) { syzoj.log('[notification] solution_rejected failed: ' + e.message); }

    res.redirect(syzoj.utils.makeUrl(['solution', solution.id]));
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 提交评论 ============
app.post('/solution/:id/comment', async (req, res) => {
  try {
    if (!res.locals.user) {
      throw new ErrorMessage('请登录后继续。', { '登录': syzoj.utils.makeUrl(['login'], { 'url': req.originalUrl }) });
    }

    let id = parseInt(req.params.id);
    let solution = await ProblemSolution.findById(id);
    if (!solution) throw new ErrorMessage('无此题解。');

    if (!solution.isAllowedCommentBy(res.locals.user)) {
      throw new ErrorMessage('您没有权限评论此题解。');
    }

    let content = (req.body.comment || '').trim();
    if (!content) throw new ErrorMessage('评论内容不能为空。');
    if (content.length > 5000) throw new ErrorMessage('评论内容过长(最多 5000 字)。');

    const publicTime = parseInt((new Date()).getTime() / 1000);
    await TypeORM.getConnection().transaction(async manager => {
      const rows = await manager.query(`
        SELECT id,user_id,status,allow_comment FROM problem_solution WHERE id=? FOR UPDATE
      `, [id]);
      if (!rows.length) throw new ErrorMessage('无此题解。');
      const current = rows[0];
      const canComment = current.status === 'accepted' && (
        current.allow_comment || res.locals.user.is_admin || current.user_id === res.locals.user.id
      );
      if (!canComment) throw new ErrorMessage('您没有权限评论此题解。');
      await manager.query(
        'INSERT INTO problem_solution_comment (content,solution_id,user_id,public_time) VALUES (?,?,?,?)',
        [content, id, res.locals.user.id, publicTime]
      );
      await manager.query(`
        UPDATE problem_solution
        SET comments_num=(SELECT COUNT(*) FROM problem_solution_comment WHERE solution_id=?)
        WHERE id=?
      `, [id, id]);
    });

    // ============ 通知逻辑 ============
    let viewerId = res.locals.user.id;
    let notifiedIds = new Set();
    notifiedIds.add(viewerId);

    // 1. 通知题解作者
    if (solution.user_id && !notifiedIds.has(solution.user_id)) {
      try {
        await syzoj.utils.createNotification({
          recipientId: solution.user_id,
          type: 'solution_comment',
          title: res.locals.user.username + ' 评论了你的题解',
          content: content.length > 100 ? content.substring(0, 100) + '...' : content,
          sourceUrl: syzoj.utils.makeUrl(['solution', solution.id]),
          sourceId: solution.id,
          actorId: viewerId
        });
        notifiedIds.add(solution.user_id);
      } catch (e) { syzoj.log('[solution] notify author failed: ' + e.message); }
    }

    // 2. @ 提及通知
    try {
      if (syzoj.utils.parseMentions) {
        let mentions = await syzoj.utils.parseMentions(content);
        for (let m of mentions) {
          if (notifiedIds.has(m.userId)) continue;
          await syzoj.utils.createNotification({
            recipientId: m.userId,
            type: 'solution_comment_mention',
            title: res.locals.user.username + ' 在题解评论里提到了你',
            content: content.length > 100 ? content.substring(0, 100) + '...' : content,
            sourceUrl: syzoj.utils.makeUrl(['solution', solution.id]),
            sourceId: solution.id,
            actorId: viewerId
          });
          notifiedIds.add(m.userId);
        }
      }
    } catch (e) { syzoj.log('[solution] @ mention notify failed: ' + e.message); }

    res.redirect(syzoj.utils.makeUrl(['solution', id]));
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 删除评论 ============
app.post('/solution/:sid/comment/:cid/delete', async (req, res) => {
  try {
    if (!res.locals.user) throw new ErrorMessage('请登录后继续。');

    let sid = parseInt(req.params.sid);
    let cid = parseInt(req.params.cid);
    const canManage = res.locals.user.is_admin || await res.locals.user.hasPrivilege('manage_problem');
    await TypeORM.getConnection().transaction(async manager => {
      const rows = await manager.query(`
        SELECT psc.user_id,ps.user_id AS solution_user_id
        FROM problem_solution_comment psc
        INNER JOIN problem_solution ps ON ps.id=psc.solution_id
        WHERE psc.id=? AND psc.solution_id=? FOR UPDATE
      `, [cid, sid]);
      if (!rows.length) throw new ErrorMessage('无此评论。');
      const allowed = canManage || rows[0].user_id === res.locals.user.id || rows[0].solution_user_id === res.locals.user.id;
      if (!allowed) throw new ErrorMessage('您没有权限删除此评论。');
      await manager.query('DELETE FROM problem_solution_comment WHERE id=? AND solution_id=?', [cid, sid]);
      await manager.query(`
        UPDATE problem_solution
        SET comments_num=(SELECT COUNT(*) FROM problem_solution_comment WHERE solution_id=?)
        WHERE id=?
      `, [sid, sid]);
    });

    res.redirect(syzoj.utils.makeUrl(['solution', sid]));
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});
// ============ 审核者:切换题目题解提交开关 ============
app.post('/problem/:pid/solution-toggle-submission', async (req, res) => {
  try {
    if (!res.locals.user) throw new ErrorMessage('请登录后继续。');
    let canManage = res.locals.user.is_admin || await res.locals.user.hasPrivilege('manage_problem');
    if (!canManage) throw new ErrorMessage('您没有权限进行此操作。');

    let pid = parseInt(req.params.pid);
    let problem = await Problem.findById(pid);
    if (!problem) throw new ErrorMessage('无此题目。');

    let setting = await ProblemSolutionSetting.findOne({ where: { problem_id: pid } });
    if (!setting) {
      setting = await ProblemSolutionSetting.create();
      setting.problem_id = pid;
      setting.disable_submission = false;
    }

    setting.disable_submission = !setting.disable_submission;
    setting.update_time = parseInt((new Date()).getTime() / 1000);
    setting.updated_by = res.locals.user.id;
    await setting.save();

    res.redirect(syzoj.utils.makeUrl(['problem', pid, 'solutions']));
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});
