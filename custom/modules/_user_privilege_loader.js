// 给每个请求注入用户辅助信息到模板:
// 1. user.privileges - 权限数组
// 2. res.locals.pendingSolutionsCount - 待审核题解数(仅审核者)
// 3. res.locals.unreadMessagesCount - 未读站内信数
// 4. user.is_email_verified - 邮箱是否已验证
let UserPrivilege = syzoj.model('user_privilege');
let User = syzoj.model('user');
let ProblemSolution = syzoj.model('problem-solution');
let PrivateMessage = syzoj.model('private-message');
let UserEmailStatus = syzoj.model('user-email-status');
let Problem = syzoj.model('problem');
let Article = syzoj.model('article');
let Contest = syzoj.model('contest');
let querystring = require('querystring');
let crypto = require('crypto');
const TypeORM = require('typeorm');
let siteOwnerPromise = null;
const requestUserStateCache = new Map();

function cachedUserState(kind, userId, loader) {
  const key = `${kind}:${Number(userId)}`;
  const now = Date.now();
  const current = requestUserStateCache.get(key);
  if (current && current.expiresAt > now) return current.promise;
  const entry = { expiresAt: Infinity, promise: null };
  const promise = Promise.resolve().then(loader).then(result => {
    entry.expiresAt = Date.now() + 10000;
    return result;
  }).catch(error => {
    if (requestUserStateCache.get(key) === entry) requestUserStateCache.delete(key);
    throw error;
  });
  entry.promise = promise;
  requestUserStateCache.set(key, entry);
  return promise;
}

syzoj.utils.invalidateUserRequestStateCache = function invalidateUserRequestStateCache(userId) {
  const suffix = ':' + Number(userId);
  for (const key of requestUserStateCache.keys()) {
    if (key.endsWith(suffix)) requestUserStateCache.delete(key);
  }
};

async function ensureSiteOwnerTable() {
  await TypeORM.getConnection().query(`
    CREATE TABLE IF NOT EXISTS site_security_state (
      id TINYINT NOT NULL,
      site_owner_user_id INT NOT NULL,
      created_at INT NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_site_security_owner (site_owner_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

async function ensureSiteOwner() {
  if (!siteOwnerPromise) {
    siteOwnerPromise = (async () => {
      await ensureSiteOwnerTable();
      let rows = await TypeORM.getConnection().query(
        'SELECT site_owner_user_id FROM site_security_state WHERE id = 1 LIMIT 1'
      );
      if (!rows.length) {
        const users = await TypeORM.getConnection().query('SELECT COUNT(*) AS count FROM user');
        if (Number(users[0].count) === 0) {
          syzoj.siteOwnerUserId = null;
          return null;
        }
        const configuredId = Number(process.env.SYZOJ_SITE_OWNER_USER_ID || 0);
        let candidates;
        if (Number.isSafeInteger(configuredId) && configuredId > 0) {
          candidates = await TypeORM.getConnection().query(
            'SELECT id FROM user WHERE id = ? AND is_admin = 1 LIMIT 1',
            [configuredId]
          );
        } else {
          candidates = await TypeORM.getConnection().query(
            "SELECT id FROM user WHERE BINARY username = 'NWPU-ICPC' AND is_admin = 1 LIMIT 2"
          );
        }
        if (candidates.length !== 1) {
          throw new Error('无法安全迁移站长身份，请设置 SYZOJ_SITE_OWNER_USER_ID 指向现有全站管理员。');
        }
        await TypeORM.getConnection().query(
          'INSERT IGNORE INTO site_security_state (id,site_owner_user_id,created_at) VALUES (1,?,?)',
          [candidates[0].id, Math.floor(Date.now() / 1000)]
        );
        rows = await TypeORM.getConnection().query(
          'SELECT site_owner_user_id FROM site_security_state WHERE id = 1 LIMIT 1'
        );
      }
      const owner = rows.length ? await User.findById(Number(rows[0].site_owner_user_id)) : null;
      if (!owner) throw new Error('站长账户不存在，请修复 site_security_state。');
      if (!owner.is_admin) {
        owner.is_admin = true;
        await owner.save();
      }
      syzoj.siteOwnerUserId = owner.id;
      syzoj.utils.siteOwnerUsername = owner.username;
      return owner;
    })().catch(error => {
      siteOwnerPromise = null;
      throw error;
    });
  }
  return siteOwnerPromise;
}

async function isSiteOwner(user) {
  if (!user) return false;
  const owner = await ensureSiteOwner();
  return !!owner && user.id === owner.id;
}

async function claimSiteOwner(manager, userId) {
  await manager.query(
    'INSERT IGNORE INTO site_security_state (id,site_owner_user_id,created_at) VALUES (1,?,?)',
    [userId, Math.floor(Date.now() / 1000)]
  );
  const rows = await manager.query(
    'SELECT site_owner_user_id FROM site_security_state WHERE id = 1 FOR UPDATE'
  );
  const ownerId = Number(rows[0].site_owner_user_id);
  if (ownerId === Number(userId)) {
    await manager.query('UPDATE user SET is_admin = 1 WHERE id = ?', [userId]);
  }
  syzoj.siteOwnerUserId = ownerId;
  siteOwnerPromise = null;
  return ownerId;
}

syzoj.utils.ensureSiteOwner = ensureSiteOwner;
syzoj.utils.isSiteOwnerAccount = isSiteOwner;
syzoj.utils.claimSiteOwner = claimSiteOwner;

const originalIsContestSupervisior = Contest.prototype.isSupervisior;
Contest.prototype.isSupervisior = async function isSupervisior(user) {
  if (user && Array.isArray(user.privileges) && user.privileges.includes('manage_contest')) return true;
  if (user && !Array.isArray(user.privileges) && await user.hasPrivilege('manage_contest')) return true;
  return originalIsContestSupervisior.call(this, user);
};

ensureSiteOwner()
  .then(async owner => {
    if (!owner) return;
    if (typeof syzoj.refreshAdminUserIds === 'function') await syzoj.refreshAdminUserIds();
    if (syzoj.utils && typeof syzoj.utils.refreshUserTagsCache === 'function') {
      await syzoj.utils.refreshUserTagsCache();
    }
  })
  .catch(error => {
    syzoj.log('[site-owner] ' + (error.stack || error));
    process.exit(1);
  });

function parseVjudgeDisplayId(value) {
  let match = /^([UHP])([1-9]\d*)$/i.exec(String(value || '').trim());
  if (!match) return null;
  const types = { U: 'vjudge:uoj', H: 'vjudge:hdu', P: 'vjudge:poj' };
  return {
    type: types[match[1].toUpperCase()],
    remoteId: match[2]
  };
}

function contestSubmissionEnabled(problem) {
  if (!problem || typeof problem.type !== 'string') return true;
  if (problem.type === 'vjudge:luogu') return !!syzoj.config.luogu_openapi_token;
  if (problem.type === 'vjudge:uoj') {
    return process.env.SYZOJ_WEB_UOJ_ALLOW_CONTESTS === 'true' &&
      !!process.env.SYZOJ_WEB_UOJ_USERNAME && !!process.env.SYZOJ_WEB_UOJ_PASSWORD;
  }
  if (problem.type === 'vjudge:hdu') {
    return process.env.SYZOJ_WEB_HDU_ALLOW_CONTESTS === 'true' &&
      !!process.env.SYZOJ_WEB_HDU_USERNAME && !!process.env.SYZOJ_WEB_HDU_PASSWORD;
  }
  if (problem.type === 'vjudge:poj') {
    return process.env.SYZOJ_WEB_POJ_ALLOW_CONTESTS === 'true' &&
      !!process.env.SYZOJ_WEB_POJ_USERNAME && !!process.env.SYZOJ_WEB_POJ_PASSWORD;
  }
  return true;
}

syzoj.utils.contestSubmissionEnabled = contestSubmissionEnabled;

const recentVjudgeSubmissions = new Map();

app.get('/problem/:id', async (req, res, next) => {
  try {
    let displayId = parseVjudgeDisplayId(req.params.id);
    if (!displayId) return next();
    let problem = await Problem.findOne({ where: { type: displayId.type, vjudge_config: displayId.remoteId } });
    if (!problem) throw new ErrorMessage('无此题目。');
    if (!await problem.isAllowedUseBy(res.locals.user)) throw new ErrorMessage('无此题目。');
    res.redirect(syzoj.utils.makeUrl(['problem', problem.id]));
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

app.get('/problems/search', async (req, res, next) => {
  try {
    let displayId = parseVjudgeDisplayId(req.query.keyword);
    if (!displayId) return next();
    let requestedRepository = ['all', 'main', 'uoj', 'hdu', 'poj'].includes(req.query.repository) ? req.query.repository : 'all';
    let displayRepository = { 'vjudge:uoj': 'uoj', 'vjudge:hdu': 'hdu', 'vjudge:poj': 'poj' }[displayId.type];
    if (requestedRepository !== 'all' && requestedRepository !== displayRepository) return next();
    let problem = await Problem.findOne({ where: { type: displayId.type, vjudge_config: displayId.remoteId } });
    if (!problem) return next();
    if (!await problem.isAllowedUseBy(res.locals.user)) return next();
    res.redirect(syzoj.utils.makeUrl(['problem', problem.id]));
  } catch (e) {
    next(e);
  }
});


app.get('/problem/:id/submissions', (req, res, next) => {
  let problemId = parseInt(req.params.id);
  if (!problemId) return next();

  res.locals.problemContextRequest = {
    problemId: problemId,
    section: 'submissions'
  };
  req.query.problem_id = String(problemId);
  req.url = '/submissions?' + querystring.stringify(req.query);
  next();
});

app.get('/contest/:id/problem/:pid/submissions', async (req, res, next) => {
  try {
    let contestId = parseInt(req.params.id);
    let contestProblemId = parseInt(req.params.pid);
    let contest = await Contest.findById(contestId);
    if (!contest) throw new ErrorMessage('无此比赛。');
    if (!syzoj.utils.canViewContestProblems || !await syzoj.utils.canViewContestProblems(contest, res.locals.user)) {
      return res.status(403).render('error', {
        err: new ErrorMessage(contest.isRunning() ? '请先报名后参加比赛。' : '比赛尚未开始。')
      });
    }

    let problemIds = await contest.getProblems();
    if (!contestProblemId || contestProblemId < 1 || contestProblemId > problemIds.length) {
      throw new ErrorMessage('无此题目。');
    }

    let problemId = problemIds[contestProblemId - 1];
    res.locals.problemContextRequest = {
      problemId: problemId,
      section: 'submissions',
      contest: contest,
      contestProblemId: contestProblemId
    };

    if (contest.isEnded()) {
      req.query.contest = String(contestId);
      req.query.problem_id = String(contestProblemId);
      req.url = '/submissions?' + querystring.stringify(req.query);
    } else {
      req.query.problem_id = String(contestProblemId);
      req.url = '/contest/' + contestId + '/submissions?' + querystring.stringify(req.query);
    }
    next();
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

app.get('/contest/:id/submissions', async (req, res, next) => {
  try {
    if (res.locals.problemContextRequest) return next();
    let contest = await Contest.findById(parseInt(req.params.id));
    if (!contest || !contest.isEnded()) return next();

    res.locals.contestHeaderRequest = {
      contestId: contest.id,
      section: 'submissions'
    };
    req.query.contest = String(contest.id);
    req.url = '/submissions?' + querystring.stringify(req.query);
    next();
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

app.use(async (req, res, next) => {
  try {
    if (res.locals.user && !res.locals.user.privileges) {
      res.locals.user.privileges = await cachedUserState('privileges', res.locals.user.id, async () => {
        let records = await UserPrivilege.find({ where: { user_id: res.locals.user.id } });
        return records.map(r => r.privilege);
      });
    }
  } catch (e) {
    if (res.locals.user) res.locals.user.privileges = [];
  }

  try {
    res.locals.isSiteOwner = await isSiteOwner(res.locals.user);
  } catch (e) {
    res.locals.isSiteOwner = false;
    syzoj.log('[site-owner] ' + (e.message || e));
  }

  res.locals.appCapabilities = [];
  res.locals.appHasCapability = function () { return false; };
  res.locals.appCanAccessAdmin = false;
  res.locals.appAdminHome = '/admin/info';
  if (res.locals.user && syzoj.utils.authorizationV2) {
    try {
      const capabilities = await syzoj.utils.authorizationV2.effectiveCapabilities(res.locals.user, 'global');
      const hasCapability = capability => capabilities.some(granted => syzoj.utils.authorizationV2.capabilityMatches(granted, capability));
      const adminHome = syzoj.utils.authorizationV2.firstAdminWorkspace(capabilities);
      res.locals.appCapabilities = capabilities;
      res.locals.appHasCapability = hasCapability;
      res.locals.appCanAccessAdmin = !!adminHome;
      res.locals.appAdminHome = adminHome || '/admin/info';
    } catch (e) {
      syzoj.log('[authorization-v2] failed to build UI capability context: ' + (e.message || e));
    }
  }

  res.locals.adminCsrfToken = null;
  if (res.locals.user && res.locals.appCanAccessAdmin) {
    if (!req.session.adminCsrfToken) {
      req.session.adminCsrfToken = crypto.randomBytes(32).toString('hex');
    }
    res.locals.adminCsrfToken = req.session.adminCsrfToken;
  }

  try {
    let createProblemRoute = req.path.match(/^\/problem\/([^/]+)\/(edit|import)\/?$/i);
    if (createProblemRoute) {
      let routeId = decodeURIComponent(createProblemRoute[1]);
      let routeProblemId = Number(routeId);
      let problem = /^[1-9]\d*$/.test(routeId) && Number.isSafeInteger(routeProblemId)
        ? await Problem.findById(routeProblemId)
        : null;
      if (!problem) {
        let canCreateProblem = res.locals.user && await res.locals.user.hasPrivilege('manage_problem');
        if (!canCreateProblem) {
          throw new ErrorMessage('您没有添加题目的权限。');
        }
      }
    }
  } catch (e) {
    syzoj.log(e);
    return res.status(403).render('error', { err: e });
  }

  try {
    res.locals.problemContext = null;
    if (req.method === 'GET') {
      let problemId = null;
      let section = null;
      let contextRoute;
      let contextContest = null;
      let contextContestProblemId = null;
      let contextAllowed = false;

      if (res.locals.problemContextRequest) {
        problemId = res.locals.problemContextRequest.problemId;
        section = res.locals.problemContextRequest.section;
        contextContest = res.locals.problemContextRequest.contest || null;
        contextContestProblemId = res.locals.problemContextRequest.contestProblemId || null;
        if (contextContest) {
          contextAllowed = await syzoj.utils.canViewContestProblems(contextContest, res.locals.user);
          contextContest.ended = contextContest.isEnded();
          contextContest.running = contextContest.isRunning();
        }
      } else if ((contextRoute = req.path.match(/^\/problem\/(\d+)\/statistics(?:\/[^/]+)?\/?$/))) {
        problemId = parseInt(contextRoute[1]);
        section = 'statistics';
      } else if ((contextRoute = req.path.match(/^\/problem\/(\d+)\/testdata\/?$/))) {
        problemId = parseInt(contextRoute[1]);
        section = 'testdata';
      } else if ((contextRoute = req.path.match(/^\/discussion\/problem\/(\d+)\/?$/))) {
        problemId = parseInt(contextRoute[1]);
        section = 'discussion';
      } else if ((contextRoute = req.path.match(/^\/problem\/(\d+)\/solutions\/?$/))) {
        problemId = parseInt(contextRoute[1]);
        section = 'solutions';
      } else if ((contextRoute = req.path.match(/^\/problem\/(\d+)\/submit\/?$/))) {
        problemId = parseInt(contextRoute[1]);
        section = 'submit';
      }

      if (problemId) {
        let contextProblem = await Problem.findById(problemId);
        let canUseProblem = contextContest ? contextAllowed : (
          contextProblem && await contextProblem.isAllowedUseBy(res.locals.user)
        );
        if (contextProblem && canUseProblem) {
          contextProblem.allowedEdit = await contextProblem.isAllowedEditBy(res.locals.user);
          contextProblem.allowedManage = await contextProblem.isAllowedManageBy(res.locals.user);
          await contextProblem.loadRelationships();

          let isVJudge = typeof contextProblem.type === 'string' && contextProblem.type.startsWith('vjudge:');
          let testcases = isVJudge ? [] : await syzoj.utils.parseTestdata(
            contextProblem.getTestdataPath(),
            contextProblem.type === 'submit-answer'
          );

          res.locals.problemContext = {
            problem: contextProblem,
            section: section,
            testcases: testcases,
            discussionCount: await Article.count({ problem_id: problemId }),
            contest: contextContest,
            contestProblemId: contextContestProblemId
          };
        }
      }
    }
  } catch (e) {
    syzoj.log('[problem-context] ' + (e.message || e));
    res.locals.problemContext = null;
  }

  try {
    res.locals.contestHeader = null;
    let contestRoute = !res.locals.problemContextRequest && req.method === 'GET' &&
      req.path.match(/^\/contest\/(\d+)(?:\/(details|ranklist|submissions|participants|registrations))?\/?$/);
    let contestProblemRoute = req.method === 'GET' &&
      req.path.match(/^\/contest\/(\d+)\/problem\/\d+\/?$/);
    let contestId = res.locals.contestHeaderRequest
      ? res.locals.contestHeaderRequest.contestId
      : (contestRoute ? parseInt(contestRoute[1]) : (contestProblemRoute ? parseInt(contestProblemRoute[1]) : null));
    let contestSection = res.locals.contestHeaderRequest
      ? res.locals.contestHeaderRequest.section
      : (contestRoute ? (contestRoute[2] || 'problems') : (contestProblemRoute ? 'problems' : null));
    if (contestId) {
      let contest = await Contest.findById(contestId);
      let user = res.locals.user;
      let canView = !!contest;
      if (canView) {
        let isSupervisior = await contest.isSupervisior(user);
        contest.running = contest.isRunning();
        contest.ended = contest.isEnded();
        let seeResult = isSupervisior || contest.ended;
        res.locals.contestHeader = {
          contest: contest,
          section: contestSection,
          timerOnly: !!contestProblemRoute,
          subtitle: await syzoj.utils.markdown(contest.subtitle || ''),
          isSupervisior: isSupervisior,
          seeRanklist: seeResult || (contest.allowedSeeingResult() && contest.allowedSeeingOthers()),
          submissionsUrl: syzoj.utils.makeUrl(['contest', contest.id, 'submissions'])
        };
      }
    }
  } catch (e) {
    syzoj.log('[contest-header] ' + (e.message || e));
    res.locals.contestHeader = null;
  }

  try {
    res.locals.pendingSolutionsCount = 0;
    let user = res.locals.user;
    if (user) {
      let canReview = user.is_admin || (user.privileges && user.privileges.includes('manage_problem'));
      if (canReview) {
        res.locals.pendingSolutionsCount = await ProblemSolution.count({ status: 'pending' });
      }
    }
  } catch (e) {
    res.locals.pendingSolutionsCount = 0;
  }

  try {
    res.locals.unreadMessagesCount = 0;
    if (res.locals.user) {
      res.locals.unreadMessagesCount = await cachedUserState('messages', res.locals.user.id, () =>
        PrivateMessage.count({
          receiver_id: res.locals.user.id,
          is_read: false,
          receiver_deleted: false
        })
      );
    }
  } catch (e) {
    res.locals.unreadMessagesCount = 0;
  }
  // 通知中心未读数
  try {
    res.locals.unreadNotificationsCount = 0;
    if (res.locals.user && syzoj.utils.countUnreadNotifications) {
      res.locals.unreadNotificationsCount = await cachedUserState('notifications', res.locals.user.id, () =>
        syzoj.utils.countUnreadNotifications(res.locals.user.id)
      );
    }
  } catch (e) {
    res.locals.unreadNotificationsCount = 0;
  }

  try {
    if (res.locals.user) {
      res.locals.user.is_email_verified = await syzoj.utils.isEmailVerified(res.locals.user.id);
    }
  } catch (e) {
    if (res.locals.user) res.locals.user.is_email_verified = false;
  }

  next();
});

app.get('/user/:id', (req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = function renderUserWithDisplayProblemIds(view, options) {
    if (view !== 'user' || !options || !options.show_user || !Array.isArray(options.show_user.ac_problems)) {
      return originalRender.apply(res, arguments);
    }
    TypeORM.getConnection().query(
      `SELECT DISTINCT js.problem_id FROM judge_state js
       LEFT JOIN judge_state_admin_action action ON action.judge_id=js.id
       WHERE js.user_id=? AND js.type!=1 AND js.status='Accepted' AND action.judge_id IS NULL
       ORDER BY js.problem_id ASC`,
      [options.show_user.id]
    ).then(rows => Promise.all(rows.map(async row => {
      const problem = await Problem.findById(Number(row.problem_id));
      return problem ? { id: problem.id, displayId: problem.getDisplayId() } : null;
    }))).then(problems => {
      options.show_user.ac_problems = problems.filter(Boolean);
      originalRender(view, options);
    }).catch(next);
    return res;
  };
  next();
});

app.get('/user/:id/edit', async (req, res, next) => {
  try {
    const owner = await ensureSiteOwner();
    if (owner && parseInt(req.params.id) === owner.id && !await isSiteOwner(res.locals.user)) {
      throw new ErrorMessage('只有站长本人可以修改站长账户。');
    }
    next();
  } catch (e) {
    syzoj.log(e);
    res.status(403).render('error', { err: e });
  }
});


app.use(async (req, res, next) => {
  try {
    const user = res.locals.user;
    if (!user || user.is_admin || !/^\/contests?(?:\/|$)/.test(req.path)) return next();
    if (!await user.hasPrivilege('manage_contest')) return next();

    const elevatedUser = Object.create(user);
    elevatedUser.is_admin = true;
    res.locals.user = elevatedUser;

    const originalRender = res.render;
    let restored = false;
    const restoreUser = () => {
      if (restored) return;
      restored = true;
      res.locals.user = user;
      res.render = originalRender;
    };
    res.render = function renderWithOriginalUser() {
      restoreUser();
      return originalRender.apply(res, arguments);
    };
    res.once('finish', restoreUser);
    res.once('close', restoreUser);
    next();
  } catch (e) {
    next(e);
  }
});

app.get('/problem/:id/submit', async (req, res) => {
  try {
    if (!res.locals.user) {
      return res.status(401).render('error', {
        err: new ErrorMessage('请登录后提交代码。', {
          '登录': syzoj.utils.makeUrl(['login'], { url: req.originalUrl })
        })
      });
    }
    let context = res.locals.problemContext;
    if (!context || !context.problem) throw new ErrorMessage('无此题目或您没有权限进行此操作。');
    if (!context.testcases || context.testcases.error) throw new ErrorMessage('该题暂无可用测试数据。');

    let problem = context.problem;
    if (syzoj.utils.canAccessProblemOutsideContest &&
      !await syzoj.utils.canAccessProblemOutsideContest(problem.id, res.locals.user)) {
      return res.status(403).render('error', {
        err: new ErrorMessage('该题属于尚未结束的比赛，请从比赛页面进入。')
      });
    }
    res.render('problem_submit', {
      problem: problem,
      contest: null,
      state: await problem.getJudgeState(res.locals.user, false),
      testcases: context.testcases,
      lastLanguage: res.locals.user ? await res.locals.user.getLastSubmitLanguage() : null,
      languages: problem.getVJudgeLanguages()
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

app.get('/contest/:id/problem/:pid/submit', async (req, res) => {
  try {
    let contestId = parseInt(req.params.id);
    let contestProblemId = parseInt(req.params.pid);
    let contest = await Contest.findById(contestId);
    if (!contest) throw new ErrorMessage('无此比赛。');

    let problemIds = await contest.getProblems();
    if (!contestProblemId || contestProblemId < 1 || contestProblemId > problemIds.length) {
      throw new ErrorMessage('无此题目。');
    }

    if (!syzoj.utils.canParticipateInContest || !await syzoj.utils.canParticipateInContest(contest, res.locals.user)) {
      return res.status(403).render('error', {
        err: new ErrorMessage(contest.isRunning() ? '请先报名后参加比赛。' : '比赛未开始或已结束。')
      });
    }

    let problem = await Problem.findById(problemIds[contestProblemId - 1]);
    if (!problem) throw new ErrorMessage('无此题目。');
    if (!contestSubmissionEnabled(problem)) {
      throw new ErrorMessage('该远程题库当前未开放比赛提交。');
    }
    problem.allowedEdit = await problem.isAllowedEditBy(res.locals.user);
    problem.allowedManage = await problem.isAllowedManageBy(res.locals.user);
    await problem.loadRelationships();

    let testcases = typeof problem.type === 'string' && problem.type.startsWith('vjudge:') ? [] : await syzoj.utils.parseTestdata(
      problem.getTestdataPath(),
      problem.type === 'submit-answer'
    );
    if (!testcases || testcases.error) throw new ErrorMessage('该题暂无可用测试数据。');

    contest.ended = contest.isEnded();
    res.locals.problemContext = {
      problem: problem,
      section: 'submit',
      testcases: testcases,
      discussionCount: await Article.count({ problem_id: problem.id }),
      contest: contest,
      contestProblemId: contestProblemId
    };

    res.render('problem_submit', {
      problem: problem,
      contest: contest,
      pid: contestProblemId,
      state: await problem.getJudgeState(res.locals.user, false),
      testcases: testcases,
      lastLanguage: res.locals.user ? await res.locals.user.getLastSubmitLanguage() : null,
      languages: problem.getVJudgeLanguages()
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

require('../libs/problem_repositories')();
