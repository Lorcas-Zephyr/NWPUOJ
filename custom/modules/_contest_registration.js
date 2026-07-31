const crypto = require('crypto');
const TypeORM = require('typeorm');
const { AsyncLocalStorage } = require('async_hooks');
const contestMutation = require('../libs/contest-mutation');

const Contest = syzoj.model('contest');
const ContestPlayer = syzoj.model('contest_player');
const ContestRanklist = syzoj.model('contest_ranklist');
const JudgeState = syzoj.model('judge_state');
const Problem = syzoj.model('problem');
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
  return !!(user && await syzoj.utils.authorizationV2.authorize(
    user,
    'problem:edit',
    null,
    { scope: 'global' }
  ));
}

async function canManageContest(contest, user, capability = 'contest:edit') {
  if (!contest || !user) return false;
  const resource = {
    id: Number(contest.id),
    ownerId: Number(contest.holder_id),
    scope: `contest:${contest.id}`
  };
  if (await syzoj.utils.authorizationV2.authorize(user, capability, resource, { scope: resource.scope })) return true;
  return Number(contest.holder_id) === Number(user.id) ||
    String(contest.admins || '').split('|').includes(String(user.id));
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


app.get('/contests', (req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = function renderContestList(view, options) {
    if (view !== 'contests' || !options || !Array.isArray(options.contests)) {
      return originalRender.apply(res, arguments);
    }
    const contestIds = options.contests.map(contest => contest.id);
    const archivedPromise = contestIds.length && syzoj.utils.contestV2
      ? syzoj.utils.contestV2.ensureSchema().then(() => TypeORM.getConnection().query(
        "SELECT contest_id FROM contest_v2_state WHERE contest_id IN (?) AND status='archived'",
        [contestIds]
      ))
      : Promise.resolve([]);
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
      ratingPromise,
      archivedPromise
    ]).then(([entries, countRows, ratingRows, archivedRows]) => {
      const archivedIds = new Set(archivedRows.map(row => Number(row.contest_id)));
      options.contests = options.contests.filter(contest => !archivedIds.has(Number(contest.id)));
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
    if (!await canManageContest(contest, res.locals.user, 'contest:edit')) {
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

function normalizeIdList(value, label) {
  const values = value == null ? [] : (Array.isArray(value) ? value : [value]);
  const normalized = values.map(item => String(item == null ? '' : item).trim()).filter(Boolean);
  const ids = normalized.map(Number);
  if (normalized.some((item, index) => !/^[1-9]\d*$/.test(item) || !Number.isSafeInteger(ids[index]))) {
    throw contestMutation.mutationError(`${label}选择数据无效，请移除后重新添加。`);
  }
  return Array.from(new Set(ids));
}


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



async function canManageRegistrations(contest, user, capability = 'contest:registration.manage') {
  return canManageContest(contest, user, capability);
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

async function getContestParticipants(contestId) {
  return TypeORM.getConnection().query(
    `SELECT cp.id AS player_id, cp.user_id, u.username
     FROM contest_player cp
     INNER JOIN user u ON u.id = cp.user_id
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

app.get('/contest/:id/participants', async (req, res) => {
  try {
    const contestId = Number(req.params.id);
    const contest = Number.isSafeInteger(contestId) && contestId > 0 ? await Contest.findById(contestId) : null;
    if (!contest) throw new ErrorMessage('无此比赛。');
    const canManage = await canManageRegistrations(contest, res.locals.user);
    if (!contest.is_public && !canManage) {
      return res.status(403).render('error', { err: new ErrorMessage('比赛未公开，请耐心等待。') });
    }
    if (!res.locals.user && !canManage) {
      return res.status(401).render('error', { err: new ErrorMessage('请登录后查看参赛者。') });
    }
    res.render('contest_participants', {
      contest: contest,
      participants: await getContestParticipants(contestId)
    });
  } catch (error) {
    syzoj.log(error);
    res.status(error.statusCode || 500).render('error', { err: error });
  }
});

app.get('/contest/:id/registrations', async (req, res) => {
  try {
    const contestId = Number(req.params.id);
    const contest = Number.isSafeInteger(contestId) && contestId > 0 ? await Contest.findById(contestId) : null;
    if (!contest) throw new ErrorMessage('无此比赛。');
    const canManage = await canManageRegistrations(contest, res.locals.user);
    if (!canManage) {
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
      canManageRegistrations: true,
      registrationManagementCsrfToken: ensureCsrfToken(req)
    });
  } catch (error) {
    syzoj.log(error);
    res.status(error.statusCode || 500).render('error', { err: error });
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
