const jwt = require('jsonwebtoken');
const JudgeState = syzoj.model('judge_state');
const JudgeStateAdminAction = syzoj.model('judge-state-admin-action');
const User = syzoj.model('user');
const Contest = syzoj.model('contest');
const Problem = syzoj.model('problem');
const submissionsProcess = require('../libs/submissions_process');
const judger = require('../libs/judger');
const vjudge = require('../libs/vjudge');
const TypeORM = require('typeorm');

app.use(['/submissions', '/submission/:id', '/contest/:id/submissions', '/contest/submission/:id'], (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.setHeader('Cache-Control', 'private, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

const VALID_STATUSES = new Set([
  'Accepted', 'Wrong Answer', 'Runtime Error', 'Invalid Interaction',
  'Time Limit Exceeded', 'Memory Limit Exceeded', 'Output Limit Exceeded',
  'File Error', 'Waiting', 'Compile Error', 'System Error', 'No Testdata',
  'Partially Correct', 'Judgement Failed', 'Unknown', 'Cancelled', 'Cheated'
]);

function practiceDisplayConfig() {
  return {
    showScore: true,
    showUsage: true,
    showCode: true,
    showResult: true,
    showOthers: true,
    showTestdata: true,
    showDetailResult: true,
    showDiagnostics: true,
    inContest: false,
    showRejudge: false
  };
}

async function isContestSupervisor(contest, user) {
  return !!(user && (user.is_admin || await contest.isSupervisior(user)));
}

async function contestDisplayConfig(contest, user) {
  const supervisor = await isContestSupervisor(contest, user);
  const ended = contest.isEnded();
  return {
    showScore: supervisor || ended || contest.allowedSeeingScore(),
    showUsage: supervisor || ended,
    showCode: supervisor || ended,
    showResult: supervisor || ended || contest.allowedSeeingResult(),
    showOthers: supervisor || ended || contest.allowedSeeingOthers(),
    showTestdata: supervisor,
    showDetailResult: supervisor || ended || contest.allowedSeeingTestcase(),
    showDiagnostics: supervisor,
    inContest: true,
    showRejudge: false
  };
}

function parseScore(value, name) {
  if (value == null || value === '') return null;
  if (!/^\d{1,3}$/.test(String(value))) throw new ErrorMessage(`${name}必须是 0 到 100 的整数。`);
  const score = Number(value);
  if (score < 0 || score > 100) throw new ErrorMessage(`${name}必须是 0 到 100 的整数。`);
  return score;
}

function parseProblemId(value) {
  if (value == null || value === '') return null;
  if (!/^[1-9]\d*$/.test(String(value))) throw new ErrorMessage('题目编号不正确。');
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new ErrorMessage('题目编号不正确。');
  return id;
}

function validateLanguage(language) {
  if (!language || ['submit-answer', 'non-submit-answer'].includes(language)) return;
  const languages = new Set(syzoj.config.filter_enabled_languages || []);
  for (const provider of Object.keys(vjudge.languages || {})) {
    for (const value of Object.keys(vjudge.languages[provider] || {})) languages.add(value);
  }
  if (!languages.has(language)) throw new ErrorMessage('语言筛选参数不正确。');
}

function applyEffectiveStatus(query, status) {
  if (!status) return;
  const action = type => `EXISTS (
    SELECT 1 FROM judge_state_admin_action filter_action
    WHERE filter_action.judge_id = js.id AND filter_action.action_type = '${type}'
  )`;
  if (status === 'Cheated') {
    query.andWhere(action('cheated'));
  } else if (status === 'Cancelled') {
    query.andWhere(`(js.status = 'Cancelled' OR ${action('cancelled')})`);
  } else {
    query.andWhere('js.status = :filterStatus', { filterStatus: status });
    query.andWhere(`NOT EXISTS (
      SELECT 1 FROM judge_state_admin_action filter_action
      WHERE filter_action.judge_id = js.id
    )`);
  }
}

function applyLanguage(query, language) {
  if (!language) return;
  if (language === 'submit-answer') {
    query.andWhere('(js.language = :emptyLanguage OR js.language IS NULL)', { emptyLanguage: '' });
  } else if (language === 'non-submit-answer') {
    query.andWhere('js.language != :emptyLanguage AND js.language IS NOT NULL', { emptyLanguage: '' });
  } else {
    query.andWhere('js.language = :filterLanguage', { filterLanguage: language });
  }
}

async function getActions(judges) {
  if (!judges.length) return {};
  if (syzoj.utils.getJudgeAdminActions) {
    return syzoj.utils.getJudgeAdminActions(judges.map(judge => judge.id));
  }
  const rows = await JudgeStateAdminAction.createQueryBuilder()
    .where('judge_id IN (:...ids)', { ids: judges.map(judge => judge.id) })
    .getMany();
  const result = {};
  rows.forEach(row => { result[row.judge_id] = row; });
  return result;
}

async function loadJudgeRelationships(judges) {
  if (!judges.length) return;
  const userIds = Array.from(new Set(judges.map(judge => Number(judge.user_id)).filter(Boolean)));
  const problemIds = Array.from(new Set(judges.map(judge => Number(judge.problem_id)).filter(Boolean)));
  const [users, problems] = await Promise.all([
    userIds.length ? TypeORM.getConnection().query(
      'SELECT id,username,is_admin,nameplate,rating FROM user WHERE id IN (?)',
      [userIds]
    ) : [],
    Promise.all(problemIds.map(problemId => Problem.findById(problemId)))
  ]);
  const userById = new Map(users.map(user => [Number(user.id), user]));
  const problemById = new Map(problems.filter(Boolean).map(problem => [Number(problem.id), problem]));
  const contestProblemIds = Array.from(new Set(judges
    .filter(judge => Number(judge.type) === 1)
    .map(judge => Number(judge.problem_id))
    .filter(Boolean)));
  const latestTitles = new Map();
  if (contestProblemIds.length) {
    const rows = await TypeORM.getConnection().query(
      `SELECT state.problem_id,JSON_UNQUOTE(JSON_EXTRACT(version.content_json,'$.title')) AS title
         FROM problem_v2_state state
         JOIN problem_v2_version version ON version.id=state.current_version_id
        WHERE state.problem_id IN (?)`,
      [contestProblemIds]
    );
    rows.forEach(row => latestTitles.set(Number(row.problem_id), String(row.title || '')));
  }
  for (const judge of judges) {
    judge.user = userById.get(Number(judge.user_id));
    judge.problem = problemById.get(Number(judge.problem_id));
    if (judge.problem && Number(judge.type) === 1 && latestTitles.get(Number(judge.problem_id))) {
      judge.problem.title = latestTitles.get(Number(judge.problem_id));
    }
  }
}

function effectiveRoughResult(judge, displayConfig, action, roughOnly) {
  if (action && action.action_type === 'cheated') {
    return { result: 'Cheated', time: null, memory: null, score: displayConfig.showScore ? 0 : null };
  }
  if (action && action.action_type === 'cancelled') {
    return { result: 'Cancelled', time: null, memory: null, score: displayConfig.showScore ? 0 : null };
  }
  return submissionsProcess.getRoughResult(judge, displayConfig, roughOnly);
}

async function canAccessContestList(contest, user) {
  if (await isContestSupervisor(contest, user)) return true;
  if (contest.isEnded()) return !!contest.is_public;
  return !!(syzoj.utils.canParticipateInContest && await syzoj.utils.canParticipateInContest(contest, user));
}

async function renderSubmissionList(req, res, contest) {
  const curUser = res.locals.user;
  const inContest = !!contest;
  if (contest && !await canAccessContestList(contest, curUser)) {
    return res.status(403).render('error', { err: new ErrorMessage('您没有权限查看该比赛的提交记录。') });
  }
  const displayConfig = contest ? await contestDisplayConfig(contest, curUser) : practiceDisplayConfig();
  const query = JudgeState.createQueryBuilder('js');
  let isFiltered = false;

  if (contest) {
    query.andWhere('js.type = 1').andWhere('js.type_info = :contestId', { contestId: contest.id });
  } else {
    query.andWhere('js.type = 0');
  }

  const submitter = String(req.query.submitter || '').trim();
  if (submitter) {
    if (!displayConfig.showOthers && (!curUser || submitter !== curUser.username)) {
      throw new ErrorMessage('您没有权限查看其他用户的提交。');
    }
    const selectedUser = await User.fromName(submitter);
    query.andWhere('js.user_id = :submitterId', { submitterId: selectedUser ? selectedUser.id : 0 });
    isFiltered = true;
  } else if (!displayConfig.showOthers) {
    if (!curUser) throw new ErrorMessage('请登录后查看提交记录。');
    query.andWhere('js.user_id = :submitterId', { submitterId: curUser.id });
    isFiltered = true;
  }

  const minScore = parseScore(req.query.min_score, '最低分');
  const maxScore = parseScore(req.query.max_score, '最高分');
  if (minScore != null && maxScore != null && minScore > maxScore) {
    throw new ErrorMessage('最低分不能高于最高分。');
  }
  if ((minScore != null || maxScore != null) && !displayConfig.showScore) {
    throw new ErrorMessage('当前比赛不公开分数筛选。');
  }
  const effectiveScore = `CASE WHEN EXISTS (
    SELECT 1 FROM judge_state_admin_action score_action WHERE score_action.judge_id = js.id
  ) THEN 0 ELSE js.score END`;
  if (minScore != null) query.andWhere(`${effectiveScore} >= :minScore`, { minScore });
  if (maxScore != null) query.andWhere(`${effectiveScore} <= :maxScore`, { maxScore });
  if (minScore != null || maxScore != null) isFiltered = true;

  const language = String(req.query.language || '');
  validateLanguage(language);
  applyLanguage(query, language);
  if (language) isFiltered = true;

  const status = req.query.status === 'Pending' ? 'Waiting' : String(req.query.status || '');
  if (status && !VALID_STATUSES.has(status)) throw new ErrorMessage('状态筛选参数不正确。');
  if (status && !displayConfig.showResult) throw new ErrorMessage('当前比赛不公开结果筛选。');
  applyEffectiveStatus(query, status);
  if (status) isFiltered = true;

  const requestedProblemId = parseProblemId(req.query.problem_id);
  let contestProblemIds = null;
  if (contest) contestProblemIds = (await contest.getProblems()).map(Number);
  if (requestedProblemId != null) {
    let problemId = requestedProblemId;
    if (contest) {
      problemId = contestProblemIds[requestedProblemId - 1] || 0;
      if (!problemId) throw new ErrorMessage('比赛中没有该题目。');
    } else {
      const problem = await Problem.findById(problemId);
      if (!problem || !await problem.isAllowedUseBy(curUser)) throw new ErrorMessage('无此题目。');
    }
    query.andWhere('js.problem_id = :filterProblemId', { filterProblemId: problemId });
    isFiltered = true;
  } else if (!contest && !(curUser && await curUser.hasPrivilege('manage_problem'))) {
    query.andWhere('js.is_public = 1');
    query.andWhere(`NOT EXISTS (
      SELECT 1 FROM contest active_contest
      WHERE active_contest.end_time > UNIX_TIMESTAMP()
        AND CONCAT('|', COALESCE(active_contest.problems, ''), '|') LIKE CONCAT('%|', js.problem_id, '|%')
    )`);
  }

  const paginate = syzoj.utils.paginate(
    await JudgeState.countQuery(query),
    req.query.page,
    contest ? 20 : syzoj.config.page.judge_state
  );
  const judges = await JudgeState.queryPage(paginate, query, { id: 'DESC' }, true);
  await loadJudgeRelationships(judges);
  const actions = await getActions(judges);
  const contestRunning = !!(contest && !contest.isEnded());
  const privileges = curUser && Array.isArray(curUser.privileges)
    ? curUser.privileges
    : (curUser ? await curUser.getPrivileges() : []);
  const canManageDetails = !!(curUser && (
    curUser.is_admin || privileges.includes('manage_problem') || (contest && await contest.isSupervisior(curUser))
  ));
  for (const judge of judges) {
    judge.adminActionType = actions[judge.id] && actions[judge.id].action_type;
    judge.canViewDetail = contestRunning
      ? !!(curUser && (canManageDetails || Number(judge.user_id) === Number(curUser.id)))
      : !!(syzoj.utils.canViewSubmissionDetail && await syzoj.utils.canViewSubmissionDetail(judge, curUser));
    if (contest) {
      judge.contestProblemIndex = contestProblemIds.indexOf(Number(judge.problem_id)) + 1;
      judge.problem.title = syzoj.utils.removeTitleTag(judge.problem.title);
    }
  }

  const pushType = displayConfig.showResult ? 'rough' : 'compile';
  res.render('submissions', {
    vjudge,
    contest,
    items: judges.map(judge => {
      const itemDisplayConfig = Object.assign({}, displayConfig, {
        showProgress: !!(displayConfig.showDetailResult || curUser && Number(judge.user_id) === Number(curUser.id))
      });
      return {
        info: submissionsProcess.getSubmissionInfo(judge, displayConfig),
        token: judge.pending && judge.task_id != null ? jwt.sign({
          scope: 'submission-list',
          submissionId: judge.id,
          taskId: judge.task_id,
          contestId: contest ? Number(contest.id) : 0,
          viewerId: curUser ? Number(curUser.id) : 0,
        }, syzoj.config.session_secret, { expiresIn: '10m' }) : null,
        result: effectiveRoughResult(judge, itemDisplayConfig, actions[judge.id], true),
        running: false
      };
    }),
    paginate,
    pushType,
    form: req.query,
    displayConfig,
    isFiltered,
    fast_pagination: false
  });
}

app.get('/submissions', async (req, res, next) => {
  try {
    let contest = null;
    if (req.query.contest) {
      const contestId = parseProblemId(req.query.contest);
      contest = contestId && await Contest.findById(contestId);
      if (!contest) throw new ErrorMessage('无此比赛。');
    }
    await renderSubmissionList(req, res, contest);
  } catch (error) {
    syzoj.log('[submission-list] ' + (error.stack || error));
    res.status(error.statusCode || 400).render('error', { err: error });
  }
});

app.get('/contest/:id/submissions', async (req, res, next) => {
  try {
    const contestId = parseProblemId(req.params.id);
    const contest = contestId && await Contest.findById(contestId);
    if (!contest) throw new ErrorMessage('无此比赛。');
    await renderSubmissionList(req, res, contest);
  } catch (error) {
    syzoj.log('[contest-submission-list] ' + (error.stack || error));
    res.status(error.statusCode || 400).render('error', { err: error });
  }
});

app.get('/contest/submission/:id', async (req, res, next) => {
  try {
    const id = parseProblemId(req.params.id);
    const judge = id && await JudgeState.findById(id);
    if (!judge || judge.type !== 1 || judge.user_id === (res.locals.user && res.locals.user.id)) return next();
    if (syzoj.utils.canViewSubmissionDetail && await syzoj.utils.canViewSubmissionDetail(judge, res.locals.user)) {
      return res.redirect(syzoj.utils.makeUrl(['submission', judge.id]));
    }
    next();
  } catch (error) {
    next(error);
  }
});

app.get(['/submission/:id', '/contest/submission/:id'], async (req, res, next) => {
  try {
    const id = parseProblemId(req.params.id);
    const judge = id && await JudgeState.findById(id);
    let latestContestTitle = null;
    if (judge && Number(judge.type) === 1) {
      const rows = await TypeORM.getConnection().query(
        `SELECT JSON_UNQUOTE(JSON_EXTRACT(version.content_json,'$.title')) AS title
           FROM problem_v2_state state
           JOIN problem_v2_version version ON version.id=state.current_version_id
          WHERE state.problem_id=? LIMIT 1`,
        [Number(judge.problem_id)]
      );
      latestContestTitle = rows[0] && rows[0].title || null;
    }
    const originalRender = res.render.bind(res);
    res.render = function renderSubmissionWithSafeSocket(view, options) {
      if (view === 'submission' && options && options.info && options.displayConfig) {
        options.socketToken = null;
        options.submissionPending = !!(judge && judge.pending);
        if (latestContestTitle) options.info.problemName = String(latestContestTitle);
      }
      return originalRender.apply(res, arguments);
    };
    next();
  } catch (error) {
    next(error);
  }
});

function parseStatusTokens(req) {
  let tokens;
  try {
    tokens = JSON.parse(String(req.body && req.body.tokens || '[]'));
  } catch (error) {
    throw new ErrorMessage('状态凭证格式不正确。');
  }
  if (!Array.isArray(tokens) || tokens.length > 50) throw new ErrorMessage('状态凭证数量不正确。');
  return tokens;
}

function verifyStatusTokens(tokens, viewerId) {
  const payloads = [];
  for (const token of tokens) {
    try {
      const payload = jwt.verify(String(token || ''), syzoj.config.session_secret);
      if (payload.scope !== 'submission-list' || Number(payload.viewerId || 0) !== viewerId ||
        !Number.isSafeInteger(Number(payload.submissionId)) || !payload.taskId ||
        !Number.isSafeInteger(Number(payload.contestId || 0))) continue;
      payloads.push(payload);
    } catch (error) {}
  }
  return payloads;
}

async function currentViewer(user) {
  return user ? User.findById(user.id) : null;
}

async function getListStatuses(payloads, user) {
  if (!payloads.length) return [];
  const submissionIds = Array.from(new Set(payloads.map(payload => Number(payload.submissionId))));
  const judges = await JudgeState.createQueryBuilder('js')
    .where('js.id IN (:...submissionIds)', { submissionIds })
    .getMany();
  const judgeById = new Map(judges.map(judge => [Number(judge.id), judge]));
  const actions = await getActions(judges);
  const statuses = [];
  const contestCache = new Map();
  const practiceJudges = judges.filter(judge => Number(judge.type) === 0);
  let canManagePractice = false;
  const activeContestProblemIds = new Set();
  if (practiceJudges.length) {
    const privileges = user && Array.isArray(user.privileges)
      ? user.privileges
      : (user ? await user.getPrivileges() : []);
    canManagePractice = !!(user && (user.is_admin || privileges.includes('manage_problem')));
    if (!canManagePractice) {
      const rows = await TypeORM.getConnection().query(
        'SELECT problems FROM contest WHERE end_time > UNIX_TIMESTAMP()'
      );
      rows.forEach(row => String(row.problems || '').split('|').forEach(problemId => {
        if (/^[1-9]\d*$/.test(problemId)) activeContestProblemIds.add(Number(problemId));
      }));
    }
  }
  for (const payload of payloads) {
    const judge = judgeById.get(Number(payload.submissionId));
    if (!judge || String(judge.task_id || '') !== String(payload.taskId)) continue;
    const contestId = Number(payload.contestId || 0);
    let currentDisplayConfig;
    if (contestId) {
      if (Number(judge.type) !== 1 || Number(judge.type_info) !== contestId) continue;
      if (!contestCache.has(contestId)) contestCache.set(contestId, Contest.findById(contestId));
      const contest = await contestCache.get(contestId);
      if (!contest || !await canAccessContestList(contest, user)) continue;
      currentDisplayConfig = await contestDisplayConfig(contest, user);
      if (!currentDisplayConfig.showOthers && (!user || Number(judge.user_id) !== Number(user.id))) continue;
    } else {
      if (Number(judge.type) !== 0) continue;
      if (!canManagePractice && (!judge.is_public || activeContestProblemIds.has(Number(judge.problem_id)))) continue;
      currentDisplayConfig = practiceDisplayConfig();
    }
    currentDisplayConfig.showProgress = !!(currentDisplayConfig.showDetailResult ||
      user && Number(judge.user_id) === Number(user.id));
    statuses.push({
      submissionId: Number(judge.id),
      taskId: judge.task_id,
      pending: !!judge.pending,
      result: effectiveRoughResult(judge, currentDisplayConfig, actions[judge.id], false)
    });
  }
  return statuses;
}

function beginEventStream(res) {
  res.status(200);
  res.set({
    'Cache-Control': 'no-cache, no-store',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Content-Encoding': 'identity',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive'
  });
  if (res.flushHeaders) res.flushHeaders();
  res.write('retry: 2000\n\n');
}

function writeEvent(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  if (res.flush) res.flush();
}


app.post("/api/v2/submissions/events", async (req, res, next) => {
  const subscriptions = new Map();
  let heartbeat;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    subscriptions.forEach(unsubscribe => unsubscribe());
    subscriptions.clear();
    if (heartbeat) clearInterval(heartbeat);
  };

  try {
    const tokens = parseStatusTokens(req);
    const viewerId = res.locals.user ? Number(res.locals.user.id) : 0;
    const payloads = verifyStatusTokens(tokens, viewerId);
    if (!tokens.length || payloads.length !== tokens.length) {
      if (req.path.startsWith('/api/v2/')) {
        return syzoj.utils.apiV2.fail(res, 403, 'SUBMISSION_FORBIDDEN', 'Submission status credentials are invalid or expired.');
      }
      return res.status(403).json({ error: '状态凭证已失效。' });
    }

    beginEventStream(res);
    res.on('close', cleanup);
    heartbeat = setInterval(() => {
      if (!closed) res.write(': heartbeat\n\n');
    }, 15000);
    if (heartbeat.unref) heartbeat.unref();

    const payloadsByTask = new Map();
    payloads.forEach(payload => {
      const taskId = String(payload.taskId);
      if (!payloadsByTask.has(taskId)) payloadsByTask.set(taskId, []);
      payloadsByTask.get(taskId).push(payload);
    });
    const lastStatus = new Map();
    let initialized = false;
    const queuedTasks = new Set();

    const closeIfComplete = () => {
      if (!closed && subscriptions.size === 0) {
        cleanup();
        res.end();
      }
    };
    const updateTask = async taskId => {
      if (closed) return;
      if (res.writableLength > 1024 * 1024) {
        cleanup();
        return res.end();
      }
      const taskPayloads = payloadsByTask.get(taskId) || [];
      const viewer = await currentViewer(res.locals.user);
      const statuses = await getListStatuses(taskPayloads, viewer);
      if (statuses.length !== taskPayloads.length) {
        writeEvent(res, 'refresh-required', {});
        cleanup();
        return res.end();
      }
      for (const status of statuses) {
        const serialized = JSON.stringify(status);
        if (lastStatus.get(status.submissionId) !== serialized) {
          lastStatus.set(status.submissionId, serialized);
          writeEvent(res, 'status', status);
        }
      }
      if (statuses.every(status => !status.pending)) {
        const unsubscribe = subscriptions.get(taskId);
        if (unsubscribe) unsubscribe();
        subscriptions.delete(taskId);
        payloadsByTask.delete(taskId);
        closeIfComplete();
      }
    };
    const pendingUpdates = new Set();
    let processingUpdates = false;
    const processUpdates = async () => {
      if (processingUpdates || closed) return;
      processingUpdates = true;
      try {
        while (pendingUpdates.size && !closed) {
          const taskId = pendingUpdates.values().next().value;
          pendingUpdates.delete(taskId);
          await updateTask(taskId);
        }
      } catch (error) {
        syzoj.log('[submission-events] ' + (error.stack || error));
        cleanup();
        if (!res.finished) res.end();
      } finally {
        processingUpdates = false;
        if (pendingUpdates.size && !closed) processUpdates();
      }
    };
    const enqueueTask = taskId => {
      pendingUpdates.add(taskId);
      processUpdates();
    };
    for (const taskId of payloadsByTask.keys()) {
      subscriptions.set(taskId, judger.subscribeJudgeState(taskId, () => {
        if (!initialized) return queuedTasks.add(taskId);
        enqueueTask(taskId);
      }));
    }
    const initialViewer = await currentViewer(res.locals.user);
    const statuses = await getListStatuses(payloads, initialViewer);
    if (statuses.length !== payloads.length) {
      writeEvent(res, 'refresh-required', {});
      cleanup();
      return res.end();
    }
    statuses.forEach(status => {
      lastStatus.set(status.submissionId, JSON.stringify(status));
      writeEvent(res, 'status', status);
    });
    initialized = true;
    for (const status of statuses) {
      if (!status.pending) await updateTask(String(status.taskId));
    }
    queuedTasks.forEach(taskId => {
      if (payloadsByTask.has(taskId)) enqueueTask(taskId);
    });
  } catch (error) {
    cleanup();
    if (res.headersSent) return res.end();
    if (req.path.startsWith('/api/v2/')) {
      return syzoj.utils.apiV2.fail(res, error.statusCode || 400, error.code || 'REQUEST_FAILED', error.message || 'Submission events are unavailable.');
    }
    next(error);
  }
});
