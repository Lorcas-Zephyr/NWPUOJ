const crypto = require('crypto');
const TypeORM = require('typeorm');
const { AsyncLocalStorage } = require('async_hooks');
const contestMutation = require('../libs/contest-mutation');

const Contest = syzoj.model('contest');
const ContestPlayer = syzoj.model('contest_player');
const ContestRanklist = syzoj.model('contest_ranklist');
const JudgeState = syzoj.model('judge_state');
const User = syzoj.model('user');
const ProblemSolution = syzoj.model('problem-solution');
const Article = syzoj.model('article');
const contestLockContext = new AsyncLocalStorage();
const submissionRequestContext = new AsyncLocalStorage();
const registrationCache = new Map();
const registrationSettingCache = new Map();
const registrationRemovalCache = new Map();
const contestSubmissionQueues = new Map();

Contest.cache = false;
ContestPlayer.cache = false;
ContestRanklist.cache = false;

let registrationIndexPromise = null;
function ensureRegistrationIndex() {
  if (!registrationIndexPromise) {
    registrationIndexPromise = (async () => {
      await TypeORM.getConnection().query(`
        CREATE TABLE IF NOT EXISTS contest_registration_setting (
          contest_id INT NOT NULL,
          allow_late_registration TINYINT(1) NOT NULL DEFAULT 0,
          revision INT NOT NULL DEFAULT 0,
          updated_at INT NOT NULL,
          PRIMARY KEY (contest_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await TypeORM.getConnection().query(
        'ALTER TABLE contest_registration_setting ADD COLUMN IF NOT EXISTS revision INT NOT NULL DEFAULT 0 AFTER allow_late_registration'
      );
      await TypeORM.getConnection().query(`
        CREATE TABLE IF NOT EXISTS contest_registration_removal (
          contest_id INT NOT NULL,
          user_id INT NOT NULL,
          removed_at INT NOT NULL,
          removed_by INT NOT NULL,
          PRIMARY KEY (contest_id,user_id),
          KEY idx_contest_registration_removal_user (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await TypeORM.getConnection().query(
        'UPDATE contest SET is_public = 1 WHERE is_public IS NULL'
      );
      await TypeORM.getConnection().query(
        'CREATE UNIQUE INDEX IF NOT EXISTS uq_contest_player_registration ON contest_player (contest_id,user_id)'
      );
      await TypeORM.getConnection().query(
        'CREATE INDEX IF NOT EXISTS idx_judge_state_contest_user ON judge_state (type,type_info,user_id)'
      );
    })().catch(error => {
      registrationIndexPromise = null;
      throw error;
    });
  }
  return registrationIndexPromise;
}

ensureRegistrationIndex().catch(error => {
  syzoj.log('[contest-registration] ' + (error.stack || error));
  process.exit(1);
});

function ensureCsrfToken(req) {
  if (!req.session.contestRegistrationCsrfToken) {
    req.session.contestRegistrationCsrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.contestRegistrationCsrfToken;
}

function validCsrfToken(req) {
  const expected = req.session && req.session.contestRegistrationCsrfToken;
  const actual = req.body && req.body.csrf_token;
  if (typeof expected !== 'string' || typeof actual !== 'string' || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function registrationReturnUrl(req, contestId) {
  const fallback = syzoj.utils.makeUrl(['contest', contestId]);
  const returnUrl = String((req.body && req.body.return_url) || '');
  if (!returnUrl.startsWith('/') || returnUrl.startsWith('//')) return fallback;
  if (!/^\/contests(?:[/?#]|$)/.test(returnUrl)) return fallback;
  return returnUrl;
}

async function findRegistration(contestId, userId) {
  if (!userId) return null;
  await ensureRegistrationIndex();
  const key = `${Number(contestId)}:${Number(userId)}`;
  const now = Date.now();
  const cached = registrationCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  const entry = { expiresAt: Infinity, promise: null };
  const promise = ContestPlayer.findInContest({ contest_id: contestId, user_id: userId }).then(result => {
    entry.expiresAt = Date.now() + 5000;
    return result;
  }).catch(error => {
    registrationCache.delete(key);
    throw error;
  });
  entry.promise = promise;
  registrationCache.set(key, entry);
  return promise;
}

async function getRegistrationSetting(contestId) {
  await ensureRegistrationIndex();
  const key = Number(contestId);
  const now = Date.now();
  const cached = registrationSettingCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  const entry = { expiresAt: Infinity, promise: null };
  const promise = TypeORM.getConnection().query(
    'SELECT allow_late_registration,revision FROM contest_registration_setting WHERE contest_id = ? LIMIT 1',
    [contestId]
  ).then(rows => ({
    allowLateRegistration: !!(rows[0] && rows[0].allow_late_registration),
    revision: Number(rows[0] && rows[0].revision || 0)
  })).then(result => {
    entry.expiresAt = Date.now() + 5000;
    return result;
  }).catch(error => {
    registrationSettingCache.delete(key);
    throw error;
  });
  entry.promise = promise;
  registrationSettingCache.set(key, entry);
  return promise;
}

async function wasRemoved(contestId, userId) {
  if (!userId) return false;
  const key = `${Number(contestId)}:${Number(userId)}`;
  const now = Date.now();
  const cached = registrationRemovalCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  const entry = { expiresAt: Infinity, promise: null };
  const promise = TypeORM.getConnection().query(
    'SELECT user_id FROM contest_registration_removal WHERE contest_id=? AND user_id=? LIMIT 1',
    [contestId, userId]
  ).then(rows => rows.length > 0).then(result => {
    entry.expiresAt = Date.now() + 5000;
    return result;
  }).catch(error => {
    registrationRemovalCache.delete(key);
    throw error;
  });
  entry.promise = promise;
  registrationRemovalCache.set(key, entry);
  return promise;
}

function invalidateRegistrationCache(contestId, userId) {
  const key = `${Number(contestId)}:${Number(userId)}`;
  registrationCache.delete(key);
  registrationRemovalCache.delete(key);
  registrationSettingCache.delete(Number(contestId));
  if (syzoj.utils.invalidateContestReadCache) syzoj.utils.invalidateContestReadCache(contestId);
}

async function isProblemManager(user) {
  return !!(user && (user.is_admin || await user.hasPrivilege('manage_problem')));
}

async function canViewContestProblems(contest, user) {
  if (await contest.isSupervisior(user)) return true;
  if (contest.isEnded()) return true;
  if (contest.isRunning() && user && await findRegistration(contest.id, user.id)) return true;
  return isProblemManager(user);
}

async function canParticipateInContest(contest, user) {
  if (await contest.isSupervisior(user)) return true;
  if (!contest.isRunning() || !user) return false;
  return !!await findRegistration(contest.id, user.id);
}

async function canAccessProblemOutsideContest(problemId, user) {
  if (await isProblemManager(user)) return true;
  const now = syzoj.utils.getCurrentDate();
  const rows = await TypeORM.getConnection().query(
    `SELECT id
     FROM contest
     WHERE end_time > ?
       AND CONCAT('|', COALESCE(problems, ''), '|') LIKE ?`,
    [now, '%|' + problemId + '|%']
  );
  for (const row of rows) {
    const contest = await Contest.findById(Number(row.id));
    if (contest && !await contest.isSupervisior(user)) return false;
  }
  return true;
}

async function getRegistrationState(contest, user, req) {
  const registeredPlayer = user ? await findRegistration(contest.id, user.id) : null;
  const isSupervisior = await contest.isSupervisior(user);
  const setting = await getRegistrationSetting(contest.id);
  const removedByAdmin = user ? await wasRemoved(contest.id, user.id) : false;
  const now = syzoj.utils.getCurrentDate();
  const beforeStart = now < contest.start_time;
  const running = contest.isRunning(now);
  const ended = contest.isEnded(now);
  const registrationOpen = !ended && (beforeStart || (running && setting.allowLateRegistration));
  const canParticipate = isSupervisior || (running && !!registeredPlayer);
  const canViewProblems = isSupervisior || ended || (running && !!registeredPlayer) || await isProblemManager(user);
  return {
    contestId: Number(contest.id),
    registered: !!registeredPlayer,
    playerId: registeredPlayer ? registeredPlayer.id : null,
    isSupervisior: isSupervisior,
    beforeStart: beforeStart,
    running: running,
    ended: ended,
    allowLateRegistration: setting.allowLateRegistration,
    revision: setting.revision,
    removedByAdmin: removedByAdmin,
    registrationOpen: registrationOpen,
    canViewProblems: canViewProblems,
    canParticipate: canParticipate,
    canRegister: !!user && registrationOpen && !registeredPlayer && !isSupervisior && !removedByAdmin,
    canCancel: !!user && beforeStart && !!registeredPlayer && !isSupervisior,
    csrfToken: user ? ensureCsrfToken(req) : null
  };
}

syzoj.utils.isContestRegistered = async function isContestRegistered(contestId, userId) {
  return !!await findRegistration(contestId, userId);
};
syzoj.utils.canViewContestProblems = canViewContestProblems;
syzoj.utils.canParticipateInContest = canParticipateInContest;
syzoj.utils.canAccessProblemOutsideContest = canAccessProblemOutsideContest;
syzoj.utils.runWithContestLockContext = (contestId, work) => contestLockContext.run({ contestId: Number(contestId) }, work);

Contest.prototype.newSubmission = async function updateRegisteredPlayerOnly(judgeState) {
  const update = () => contestMutation.applyContestSubmission(this.id, judgeState);
  const currentLock = contestLockContext.getStore();
  if (currentLock && Number(currentLock.contestId) === Number(this.id)) return update();
  const contestId = Number(this.id);
  const previous = contestSubmissionQueues.get(contestId) || Promise.resolve();
  const queued = previous.catch(error => {
    syzoj.log('[contest-submission-queue] ' + (error.stack || error));
  }).then(async () => {
    let attempt = 0;
    while (true) {
      try {
        return await contestMutation.withContestLock(contestId, update);
      } catch (error) {
        if (error.statusCode !== 503) throw error;
        attempt++;
        await new Promise(resolve => setTimeout(resolve, Math.min(2000, 250 * attempt)));
      }
    }
  });
  contestSubmissionQueues.set(contestId, queued);
  try {
    return await queued;
  } catch (error) {
    syzoj.log('[contest-submission-update] ' + (error.stack || error));
    return false;
  } finally {
    if (contestSubmissionQueues.get(contestId) === queued) contestSubmissionQueues.delete(contestId);
  }
};

if (!JudgeState.prototype.__skipInitialContestStandingsUpdate) {
  const originalUpdateRelatedInfo = JudgeState.prototype.updateRelatedInfo;
  JudgeState.prototype.updateRelatedInfo = function updateRelatedInfoAfterQueue(newSubmission) {
    if (Number(this.type) === 1 && newSubmission) return Promise.resolve();
    return originalUpdateRelatedInfo.call(this, newSubmission);
  };
  const originalSave = JudgeState.prototype.save;
  JudgeState.prototype.save = async function saveWithSubmissionRequestId() {
    const result = await originalSave.apply(this, arguments);
    const context = submissionRequestContext.getStore();
    if (context && Number(this.type) === 1 && Number(this.type_info) === context.contestId &&
        Number(this.user_id) === context.userId && this.id) {
      context.submissionId = Number(this.id);
    }
    return result;
  };
  JudgeState.prototype.__skipInitialContestStandingsUpdate = true;
}

app.post('/problem/:id/submit', async (req, res, next) => {
  const contestId = Number(req.query.contest_id || 0);
  if (!Number.isSafeInteger(contestId) || contestId <= 0) return next();
  const context = {
    contestId,
    userId: Number(res.locals.user && res.locals.user.id || 0),
    submissionId: null
  };
  const originalRedirect = res.redirect.bind(res);
  res.redirect = function redirectWithSubmissionId() {
    if (context.submissionId && !res.headersSent) {
      res.setHeader('X-Submission-Id', String(context.submissionId));
    }
    return originalRedirect.apply(res, arguments);
  };
  submissionRequestContext.run(context, next);
});

app.get('/contests', (req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = function renderContestList(view, options) {
    if (view !== 'contests' || !options || !Array.isArray(options.contests)) {
      return originalRender.apply(res, arguments);
    }
    const contestIds = options.contests.map(contest => contest.id);
    const countPromise = contestIds.length ? TypeORM.getConnection().query(
      `SELECT contest_id, COUNT(*) AS count
       FROM contest_player
       WHERE contest_id IN (?)
       GROUP BY contest_id`,
      [contestIds]
    ) : Promise.resolve([]);
    const ratingPromise = contestIds.length
      ? Promise.resolve(typeof syzoj.utils.ensureContestRatingSchema === 'function'
        ? syzoj.utils.ensureContestRatingSchema()
        : null).then(() => TypeORM.getConnection().query(
          'SELECT contest_id,is_rated FROM contest_rating_config WHERE contest_id IN (?)',
          [contestIds]
        ))
      : Promise.resolve([]);
    Promise.all([
      Promise.all(options.contests.map(async contest => {
        const state = await getRegistrationState(contest, res.locals.user, req);
        return [contest.id, state];
      })),
      countPromise,
      ratingPromise
    ]).then(([entries, countRows, ratingRows]) => {
      const counts = Object.fromEntries(countRows.map(row => [Number(row.contest_id), Number(row.count)]));
      entries.forEach(([contestId, state]) => {
        state.registeredCount = counts[contestId] || 0;
      });
      options.contestRegistrations = Object.fromEntries(entries);
      options.contestRatedById = Object.fromEntries(
        ratingRows.map(row => [Number(row.contest_id), !!row.is_rated])
      );
      originalRender(view, options);
    }).catch(error => {
      syzoj.log('[contest-registration-list] ' + (error.stack || error));
      originalRender('error', { err: error });
    });
  };
  next();
});

async function guardContestEditor(req, res, next) {
  try {
    const contestId = Number(req.params.id);
    if (!Number.isSafeInteger(contestId) || contestId <= 0) return next();
    const contest = await Contest.findById(contestId);
    if (!contest) return next();
    if (!res.locals.user || !await contest.isSupervisior(res.locals.user)) {
      return res.status(403).render('error', { err: new ErrorMessage('您没有权限编辑该比赛。') });
    }
    if (!res.locals.user.is_admin) {
      const elevatedUser = Object.create(res.locals.user);
      elevatedUser.is_admin = true;
      res.locals.user = elevatedUser;
    }
    next();
  } catch (error) {
    next(error);
  }
}

app.get('/contest/:id/edit', guardContestEditor);
app.post('/contest/:id/edit', guardContestEditor);

app.use('/contest/:id', async (req, res, next) => {
  try {
    const contestId = Number(req.params.id);
    if (!Number.isSafeInteger(contestId) || contestId <= 0) return next();
    const contest = await Contest.findById(contestId);
    if (!contest || contest.is_public || (res.locals.user && res.locals.user.is_admin)) return next();
    if (!res.locals.user || !await contest.isSupervisior(res.locals.user)) {
      return res.status(403).render('error', { err: new ErrorMessage('该比赛已隐藏，仅管理员可以访问。') });
    }
    const elevatedUser = Object.create(res.locals.user);
    elevatedUser.is_admin = true;
    res.locals.user = elevatedUser;
    next();
  } catch (error) {
    next(error);
  }
});

function normalizeIdList(value) {
  const values = value == null ? [] : (Array.isArray(value) ? value : [value]);
  return Array.from(new Set(values.map(Number).filter(id => Number.isSafeInteger(id) && id > 0)));
}

app.post('/contest/:id/edit', async (req, res) => {
  try {
    const contestId = Number(req.params.id);
    const user = res.locals.user;
    if (!Number.isSafeInteger(contestId) || contestId < 0) throw contestMutation.mutationError('比赛 ID 不正确。');
    if (!user) throw contestMutation.mutationError('您没有权限进行此操作。', 403);
    if (typeof syzoj.utils.ensureContestRatingSchema === 'function') {
      await syzoj.utils.ensureContestRatingSchema();
    }
    if (contestId === 0 && !user.is_admin && !await user.hasPrivilege('manage_contest')) {
      throw contestMutation.mutationError('您没有权限创建比赛。', 403);
    }
    const title = String(req.body.title || '').trim();
    if (!title || title.length > 80) throw contestMutation.mutationError('比赛名称不能为空且不能超过 80 个字符。');
    const startTime = Number(syzoj.utils.parseDate(req.body.start_time));
    const endTime = Number(syzoj.utils.parseDate(req.body.end_time));
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime) {
      throw contestMutation.mutationError('比赛时间不正确。');
    }
    let rankingParams;
    try {
      rankingParams = JSON.parse(req.body.ranking_params || '{}');
      if (!rankingParams || Array.isArray(rankingParams) || typeof rankingParams !== 'object') throw new Error();
    } catch (error) {
      throw contestMutation.mutationError('排行参数必须是 JSON 对象。');
    }
    const problemIds = normalizeIdList(req.body.problems);
    const adminIds = normalizeIdList(req.body.admins);
    for (const problemId of problemIds) {
      const problem = await Problem.findById(problemId);
      if (!problem || !await problem.isAllowedUseBy(user)) {
        throw contestMutation.mutationError(`题目 #${problemId} 不存在或当前用户无权使用。`);
      }
      if (syzoj.utils.contestSubmissionEnabled && !syzoj.utils.contestSubmissionEnabled(problem)) {
        throw contestMutation.mutationError(`${problem.getDisplayId()} 当前未启用比赛提交，请从试题列表中移除。`);
      }
    }
    for (const adminId of adminIds) {
      if (!await User.findById(adminId)) throw contestMutation.mutationError(`管理员用户 #${adminId} 不存在。`);
    }
    for (const [problemId, multiplier] of Object.entries(rankingParams)) {
      const numericProblemId = Number(problemId);
      const numericMultiplier = Number(multiplier);
      if (!problemIds.includes(numericProblemId) || !Number.isFinite(numericMultiplier) || numericMultiplier <= 0 || numericMultiplier > 1000) {
        throw contestMutation.mutationError('排行参数只能包含比赛题目，且权重必须是 0 到 1000 之间的正数。');
      }
      rankingParams[problemId] = numericMultiplier;
    }
    const type = String(req.body.type || '');
    if (contestId === 0 && !['noi', 'ioi', 'acm'].includes(type)) {
      throw contestMutation.mutationError('无效的赛制。');
    }
    const savedContestId = await contestMutation.saveContest({
      id: contestId,
      actorId: user.id,
      title,
      subtitle: String(req.body.subtitle || ''),
      information: String(req.body.information || ''),
      problems: problemIds.join('|'),
      admins: adminIds.join('|'),
      type,
      rankingParams,
      startTime,
      endTime,
      hideStatistics: req.body.hide_statistics === 'on',
      isPublic: req.body.hide_contest !== 'on',
      allowLateRegistration: req.body.allow_late_registration === 'on',
      isRated: req.body.is_rated === 'on',
      revision: Number(req.body.contest_revision || 0)
    });
    res.redirect(303, syzoj.utils.makeUrl(['contest', savedContestId]));
  } catch (error) {
    syzoj.log(error);
    res.status(error.statusCode || 400).render('error', { err: error });
  }
});

app.use(async (req, res, next) => {
  try {
    const match = /^\/contest\/(\d+)(?:\/|$)/.exec(req.path);
    if (!match) return next();
    const contest = await Contest.findById(Number(match[1]));
    if (!contest) return next();
    res.locals.contestRegistration = await getRegistrationState(contest, res.locals.user, req);
    next();
  } catch (error) {
    next(error);
  }
});

app.post('/contest/:id/register', async (req, res) => {
  try {
    const contestId = Number(req.params.id);
    const user = res.locals.user;
    if (!Number.isSafeInteger(contestId) || contestId <= 0) throw new ErrorMessage('比赛 ID 不正确。');
    if (!user) throw new ErrorMessage('请登录后报名。');
    if (!validCsrfToken(req)) throw new ErrorMessage('页面已失效，请刷新后重试。');

    const contest = await Contest.findById(contestId);
    if (!contest) throw new ErrorMessage('无此比赛。');
    if (await contest.isSupervisior(user)) throw new ErrorMessage('比赛管理人员无需报名。');
    await contestMutation.registerUser(contestId, user.id);
    invalidateRegistrationCache(contestId, user.id);

    res.redirect(303, registrationReturnUrl(req, contestId));
  } catch (error) {
    syzoj.log(error);
    res.status(error.statusCode || 403).render('error', { err: error });
  }
});

app.post('/contest/:id/unregister', async (req, res) => {
  try {
    const contestId = Number(req.params.id);
    const user = res.locals.user;
    if (!Number.isSafeInteger(contestId) || contestId <= 0) throw new ErrorMessage('比赛 ID 不正确。');
    if (!user) throw new ErrorMessage('请登录后继续。');
    if (!validCsrfToken(req)) throw new ErrorMessage('页面已失效，请刷新后重试。');

    await contestMutation.unregisterUser(contestId, user.id);
    invalidateRegistrationCache(contestId, user.id);

    res.redirect(303, registrationReturnUrl(req, contestId));
  } catch (error) {
    syzoj.log(error);
    res.status(error.statusCode || 403).render('error', { err: error });
  }
});

async function canManageRegistrations(contest, user) {
  return !!(user && await contest.isSupervisior(user));
}

async function getContestRegistrations(contestId) {
  return TypeORM.getConnection().query(
    `SELECT cp.id AS player_id, cp.user_id, u.username,
            profile.student_id, profile.real_name, profile.college
     FROM contest_player cp
     INNER JOIN user u ON u.id = cp.user_id
     LEFT JOIN user_registration_profile profile ON profile.user_id = cp.user_id
     WHERE cp.contest_id = ?
     ORDER BY cp.id ASC`,
    [contestId]
  );
}

function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text) || /^\s+[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

app.get('/contest/:id/registrations', async (req, res) => {
  try {
    const contestId = Number(req.params.id);
    const contest = Number.isSafeInteger(contestId) && contestId > 0 ? await Contest.findById(contestId) : null;
    if (!contest) throw new ErrorMessage('无此比赛。');
    if (!await canManageRegistrations(contest, res.locals.user)) {
      return res.status(403).render('error', { err: new ErrorMessage('您没有权限管理该比赛的报名。') });
    }
    const registrations = await getContestRegistrations(contestId);
    const removedRegistrations = await TypeORM.getConnection().query(
      `SELECT removal.user_id,removal.removed_at,u.username,
              profile.student_id,profile.real_name,profile.college
       FROM contest_registration_removal removal
       INNER JOIN user u ON u.id=removal.user_id
       LEFT JOIN user_registration_profile profile ON profile.user_id=removal.user_id
       WHERE removal.contest_id=? ORDER BY removal.removed_at DESC`,
      [contestId]
    );
    res.render('contest_registrations', {
      contest: contest,
      registrations: registrations,
      removedRegistrations: removedRegistrations,
      registrationManagementCsrfToken: ensureCsrfToken(req)
    });
  } catch (error) {
    syzoj.log(error);
    res.render('error', { err: error });
  }
});

app.get('/contest/:id/registrations/export', async (req, res) => {
  try {
    const contestId = Number(req.params.id);
    const contest = Number.isSafeInteger(contestId) && contestId > 0 ? await Contest.findById(contestId) : null;
    if (!contest) throw new ErrorMessage('无此比赛。');
    if (!await canManageRegistrations(contest, res.locals.user)) {
      return res.status(403).render('error', { err: new ErrorMessage('您没有权限导出该比赛的报名信息。') });
    }
    const registrations = await getContestRegistrations(contestId);
    const rows = [
      ['UID', '用户名', '姓名', '学号', '学院'],
      ...registrations.map(registration => [
        registration.user_id,
        registration.username,
        registration.real_name,
        registration.student_id,
        registration.college
      ])
    ];
    const csv = '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const filename = `contest-${contestId}-registrations.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(csv);
  } catch (error) {
    syzoj.log(error);
    res.status(error.statusCode || 500).render('error', { err: error });
  }
});

app.post('/contest/:id/registrations/:userId/remove', async (req, res) => {
  try {
    const contestId = Number(req.params.id);
    const userId = Number(req.params.userId);
    const contest = Number.isSafeInteger(contestId) && contestId > 0 ? await Contest.findById(contestId) : null;
    if (!contest || !Number.isSafeInteger(userId) || userId <= 0) throw new ErrorMessage('报名记录不正确。');
    if (!await canManageRegistrations(contest, res.locals.user)) {
      return res.status(403).render('error', { err: new ErrorMessage('您没有权限管理该比赛的报名。') });
    }
    if (!validCsrfToken(req)) {
      return res.status(403).render('error', { err: new ErrorMessage('页面已失效，请刷新后重试。') });
    }

    await contestMutation.removeUser(contestId, userId, res.locals.user.id);
    invalidateRegistrationCache(contestId, userId);
    res.redirect(303, syzoj.utils.makeUrl(['contest', contestId, 'registrations']));
  } catch (error) {
    syzoj.log(error);
    res.status(error.statusCode || 403).render('error', { err: error });
  }
});

app.post('/contest/:id/registrations/:userId/restore', async (req, res) => {
  try {
    const contestId = Number(req.params.id);
    const userId = Number(req.params.userId);
    const contest = Number.isSafeInteger(contestId) && contestId > 0 ? await Contest.findById(contestId) : null;
    if (!contest || !Number.isSafeInteger(userId) || userId <= 0) throw new ErrorMessage('报名记录不正确。');
    if (!await canManageRegistrations(contest, res.locals.user)) {
      return res.status(403).render('error', { err: new ErrorMessage('您没有权限管理该比赛的报名。') });
    }
    if (!validCsrfToken(req)) {
      return res.status(403).render('error', { err: new ErrorMessage('页面已失效，请刷新后重试。') });
    }
    await contestMutation.restoreUser(contestId, userId);
    invalidateRegistrationCache(contestId, userId);
    res.redirect(303, syzoj.utils.makeUrl(['contest', contestId, 'registrations']));
  } catch (error) {
    syzoj.log(error);
    res.status(error.statusCode || 403).render('error', { err: error });
  }
});

app.post('/contest/:id/rebuild-standings', async (req, res) => {
  try {
    const contestId = Number(req.params.id);
    const contest = Number.isSafeInteger(contestId) && contestId > 0 ? await Contest.findById(contestId) : null;
    if (!contest) throw new ErrorMessage('无此比赛。');
    if (!await canManageRegistrations(contest, res.locals.user)) {
      return res.status(403).render('error', { err: new ErrorMessage('您没有权限维护该比赛排行榜。') });
    }
    if (!validCsrfToken(req)) {
      return res.status(403).render('error', { err: new ErrorMessage('页面已失效，请刷新后重试。') });
    }
    await contestMutation.rebuildContestStandings(contestId);
    res.redirect(303, syzoj.utils.makeUrl(['contest', contestId, 'ranklist']));
  } catch (error) {
    syzoj.log(error);
    res.status(error.statusCode || 400).render('error', { err: error });
  }
});

async function guardContestContent(req, res, next) {
  try {
    const contest = await Contest.findById(Number(req.params.id));
    if (!contest) return next();
    const state = res.locals.contestRegistration;
    const canView = state && Number(state.contestId) === Number(contest.id)
      ? state.canViewProblems
      : await canViewContestProblems(contest, res.locals.user);
    if (!canView) {
      const message = contest.isRunning() ? '请先报名后参加比赛。' : '比赛尚未开始。';
      return res.status(403).render('error', { err: new ErrorMessage(message) });
    }
    next();
  } catch (error) {
    next(error);
  }
}

app.get('/contest/:id/problem/:pid', guardContestContent);
app.get('/contest/:id/:pid/download/additional_file', guardContestContent);
app.get('/contest/:id/ranklist', guardContestContent);
app.get('/contest/:id/submissions', guardContestContent);

app.use('/problem/:id', async (req, res, next) => {
  try {
    if (!/^[1-9]\d*$/.test(req.params.id)) return next();
    if (req.query.contest_id) {
      const contestId = Number(req.query.contest_id);
      const contest = Number.isSafeInteger(contestId) && contestId > 0 ? await Contest.findById(contestId) : null;
      if (contest && await canParticipateInContest(contest, res.locals.user)) {
        const problemIds = (await contest.getProblems()).map(Number);
        if (problemIds.includes(Number(req.params.id))) return next();
      }
    }
    if (!await canAccessProblemOutsideContest(Number(req.params.id), res.locals.user)) {
      return res.status(403).render('error', {
        err: new ErrorMessage('该题属于尚未结束的比赛，请从比赛页面进入。')
      });
    }
    next();
  } catch (error) {
    next(error);
  }
});

async function protectedProblemId(req) {
  let match = req.path.match(/^\/discussion\/problem\/(\d+)(?:\/|$)/);
  if (match) return Number(match[1]);
  if (req.path === '/submissions' && /^[1-9]\d*$/.test(String(req.query.problem_id || ''))) {
    return Number(req.query.problem_id);
  }
  match = req.path.match(/^\/solution\/(\d+)(?:\/|$)/);
  if (match) {
    const solutionId = Number(match[1]);
    if (solutionId === 0) return Number((req.body && req.body.problem_id) || req.query.pid || 0);
    const solution = await ProblemSolution.findById(solutionId);
    return solution ? Number(solution.problem_id) : null;
  }
  match = req.path.match(/^\/article\/(\d+)(?:\/|$)/);
  if (match) {
    const article = await Article.findById(Number(match[1]));
    return article && article.problem_id ? Number(article.problem_id) : null;
  }
  return null;
}

app.use(async (req, res, next) => {
  try {
    if (res.locals.problemContextRequest && res.locals.problemContextRequest.contest) return next();
    const problemId = await protectedProblemId(req);
    if (!problemId || await canAccessProblemOutsideContest(problemId, res.locals.user)) return next();
    res.status(403).render('error', {
      err: new ErrorMessage('该内容属于尚未结束的比赛，请从比赛页面进入。')
    });
  } catch (error) {
    next(error);
  }
});

async function filterVisibleProblemItems(items, user, idSelector) {
  const visible = [];
  for (const item of items || []) {
    const problemId = Number(idSelector(item));
    if (!problemId || await canAccessProblemOutsideContest(problemId, user)) visible.push(item);
  }
  return visible;
}

app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const originalRender = res.render.bind(res);
  res.render = function renderWithContestProblemVisibility(view, options) {
    if (!options) return originalRender.apply(res, arguments);
    let filterPromise = null;
    if (view === 'index' && Array.isArray(options.problems)) {
      filterPromise = filterVisibleProblemItems(options.problems, res.locals.user, item => item.id)
        .then(items => { options.problems = items; });
    } else if (view === 'discussion' && Array.isArray(options.articles)) {
      filterPromise = filterVisibleProblemItems(
        options.articles,
        res.locals.user,
        item => item.problem_id || (item.problem && item.problem.id)
      ).then(items => { options.articles = items; });
    }
    if (!filterPromise) return originalRender.apply(res, arguments);
    filterPromise.then(() => originalRender(view, options)).catch(next);
    return res;
  };
  next();
});
