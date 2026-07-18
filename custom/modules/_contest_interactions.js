const TypeORM = require('typeorm');
const { AsyncLocalStorage } = require('async_hooks');

const Contest = syzoj.model('contest');
const ContestRanklist = syzoj.model('contest_ranklist');
const Problem = syzoj.model('problem');

const contestOverviewContext = new AsyncLocalStorage();
const contestStatisticsCache = new Map();
const contestRanklistCache = new Map();
const contestProblemCache = new Map();
const originalGetPlayers = ContestRanklist.prototype.getPlayers;

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || ''); } catch (error) { return fallback; }
}

function cached(cache, key, ttl, loader) {
  const now = Date.now();
  const current = cache.get(key);
  if (current && current.expiresAt > now) return current.promise;
  const entry = { expiresAt: Infinity, promise: null };
  const promise = Promise.resolve().then(loader).then(result => {
    entry.expiresAt = Date.now() + ttl;
    return result;
  }).catch(error => {
    if (cache.get(key) && cache.get(key).promise === promise) cache.delete(key);
    throw error;
  });
  entry.promise = promise;
  cache.set(key, entry);
  return promise;
}

syzoj.utils.invalidateContestReadCache = function invalidateContestReadCache(contestId) {
  const prefix = String(Number(contestId)) + ':';
  for (const key of contestStatisticsCache.keys()) {
    if (key.startsWith(prefix)) contestStatisticsCache.delete(key);
  }
  contestRanklistCache.delete(Number(contestId));
};

ContestRanklist.prototype.getPlayers = function getPlayersWithoutOverviewFanout() {
  if (contestOverviewContext.getStore()) return Promise.resolve([]);
  return originalGetPlayers.call(this);
};

async function loadContestStatistics(contestId, problemIds) {
  const key = `${contestId}:${problemIds.join(',')}`;
  return cached(contestStatisticsCache, key, 1000, async () => {
    if (!problemIds.length) return new Map();
    const rows = await TypeORM.getConnection().query(
      `SELECT user_result.problem_id,
              COUNT(*) AS attempt,
              COALESCE(SUM(user_result.accepted),0) AS accepted,
              COALESCE(SUM(user_result.accepted=0 AND user_result.best_score>0 AND user_result.best_score<100),0) AS partially
       FROM (
         SELECT js.problem_id,js.user_id,
                MAX(js.status='Accepted') AS accepted,
                MAX(COALESCE(js.score,0)) AS best_score
         FROM judge_state js
         LEFT JOIN judge_state_admin_action action ON action.judge_id=js.id
         WHERE js.type=1 AND js.type_info=? AND js.problem_id IN (?) AND action.judge_id IS NULL
         GROUP BY js.problem_id,js.user_id
       ) user_result
       GROUP BY user_result.problem_id`,
      [contestId, problemIds]
    );
    return new Map(rows.map(row => [Number(row.problem_id), {
      attempt: Number(row.attempt || 0),
      accepted: Number(row.accepted || 0),
      partially: Number(row.partially || 0)
    }]));
  });
}

async function loadContestRanklist(contest) {
  return cached(contestRanklistCache, Number(contest.id), 1000, async () => {
    const rows = await TypeORM.getConnection().query(
      `SELECT cp.id AS player_id,cp.user_id,cp.score,cp.score_details,cp.time_spent,
              u.username,u.is_admin,u.nameplate,u.rating
       FROM contest_player cp
       INNER JOIN user u ON u.id=cp.user_id
       LEFT JOIN contest_registration_removal removal
         ON removal.contest_id=cp.contest_id AND removal.user_id=cp.user_id
       WHERE cp.contest_id=? AND removal.user_id IS NULL`,
      [contest.id]
    );
    const rankingParams = parseJson(contest.ranklist && contest.ranklist.ranking_params, {});
    const judgeIds = [];
    const items = rows.map(row => {
      const details = parseJson(row.score_details, {});
      for (const detail of Object.values(details)) {
        if (detail && detail.judge_id) judgeIds.push(Number(detail.judge_id));
      }
      return {
        user: {
          id: Number(row.user_id),
          username: row.username,
          is_admin: !!row.is_admin,
          nameplate: row.nameplate || '',
          rating: Number(row.rating || syzoj.config.default.user.rating)
        },
        player: {
          id: Number(row.player_id),
          user_id: Number(row.user_id),
          score: Number(row.score || 0),
          score_details: details,
          time_spent: Number(row.time_spent || 0)
        }
      };
    });
    const judgeTimes = new Map();
    if (judgeIds.length) {
      const judgeRows = await TypeORM.getConnection().query(
        'SELECT id,submit_time FROM judge_state WHERE id IN (?)',
        [Array.from(new Set(judgeIds))]
      );
      judgeRows.forEach(row => judgeTimes.set(Number(row.id), Number(row.submit_time || 0)));
    }
    for (const item of items) {
      let score = 0;
      let tie = 0;
      for (const [problemId, detail] of Object.entries(item.player.score_details)) {
        if (!detail) continue;
        detail.judge_state = { submit_time: judgeTimes.get(Number(detail.judge_id)) || Number(detail.time || 0) };
        if (contest.type === 'acm') {
          if (!detail.accepted) continue;
          score++;
          tie += Number(detail.acceptedTime || 0) - Number(contest.start_time) +
            Number(detail.unacceptedCount || 0) * 20 * 60;
        } else {
          detail.weighted_score = detail.score == null
            ? null
            : Math.round(Number(detail.score) * Number(rankingParams[problemId] || 1));
          score += Number(detail.weighted_score || 0);
          tie = Math.max(tie, detail.judge_state.submit_time);
        }
      }
      item.player.score = score;
      item.tie = tie;
    }
    items.sort((left, right) =>
      right.player.score - left.player.score || left.tie - right.tie || left.player.id - right.player.id
    );
    let rank = 0;
    let previous = null;
    items.forEach((item, index) => {
      const key = contest.type === 'acm' ? `${item.player.score}:${item.tie}` : String(item.player.score);
      if (key !== previous) rank = index + 1;
      item.player.standing_rank = rank;
      previous = key;
    });
    return items;
  });
}

async function loadContestProblemPresentation(problem) {
  return cached(contestProblemCache, Number(problem.id), 5000, async () => {
    const fields = ['description', 'input_format', 'output_format', 'example', 'limit_and_hint'];
    const rendered = {};
    for (const field of fields) rendered[field] = problem[field] || '';
    const [specialJudge, testcases] = await Promise.all([
      problem.hasSpecialJudge(),
      syzoj.utils.parseTestdata(problem.getTestdataPath(), problem.type === 'submit-answer'),
      syzoj.utils.markdown(rendered, fields)
    ]);
    return { rendered, specialJudge, testcases };
  });
}

function cloneRanklistItem(item) {
  const details = {};
  for (const [problemId, detail] of Object.entries(item.player.score_details)) {
    details[problemId] = detail && Object.assign({}, detail, {
      judge_state: detail.judge_state && Object.assign({}, detail.judge_state)
    });
  }
  return {
    user: Object.assign({}, item.user),
    player: Object.assign({}, item.player, { score_details: details })
  };
}

app.get('/contest/:id', (req, res, next) => contestOverviewContext.run(true, next));

app.get('/contest/:id', (req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = function renderContestWithCanonicalStatistics(view, options) {
    if (view !== 'contest' || !options || !options.contest || !Array.isArray(options.problems)) {
      return originalRender.apply(res, arguments);
    }
    options.contest.running = options.contest.isRunning();
    options.contest.ended = options.contest.isEnded();
    const problemIds = options.problems.map(item => Number(item.problem && item.problem.id)).filter(Boolean);
    loadContestStatistics(Number(options.contest.id), problemIds).then(statistics => {
      for (const item of options.problems) {
        item.statistics = statistics.get(Number(item.problem && item.problem.id)) || {
          attempt: 0,
          accepted: 0,
          partially: 0
        };
      }
      originalRender(view, options);
    }).catch(next);
    return res;
  };
  next();
});

app.get('/contest/:id/ranklist', async (req, res, next) => {
  try {
    const contestId = Number(req.params.id);
    const contest = Number.isSafeInteger(contestId) && contestId > 0 ? await Contest.findById(contestId) : null;
    if (!contest) throw new ErrorMessage('无此比赛。');
    if (!contest.is_public && (!res.locals.user ||
        (!res.locals.user.is_admin && !String(contest.admins || '').split('|').includes(String(res.locals.user.id))))) {
      throw new ErrorMessage('比赛未公开，请耐心等待。');
    }
    if (![contest.allowedSeeingResult() && contest.allowedSeeingOthers(), contest.isEnded(),
      await contest.isSupervisior(res.locals.user)].some(Boolean)) {
      throw new ErrorMessage('您没有权限进行此操作。');
    }
    await contest.loadRelationships();
    const allItems = await loadContestRanklist(contest);
    const paginate = syzoj.utils.paginate(allItems.length, req.query.page, 25);
    const offset = (paginate.currPage - 1) * paginate.perPage;
    const ranklist = allItems.slice(offset, offset + paginate.perPage).map(cloneRanklistItem);
    const problemIds = await contest.getProblems();
    const problems = (await Promise.all(problemIds.map(id => Problem.findById(id)))).filter(Boolean);
    res.render('contest_ranklist', {
      contest,
      ranklist,
      problems,
      paginate,
      rankOffset: offset
    });
  } catch (error) {
    syzoj.log(error);
    res.status(error.statusCode || 400).render('error', { err: error });
  }
});

app.get('/contest/:id/problem/:pid', async (req, res, next) => {
  try {
    const contestId = Number(req.params.id);
    const problemIndex = Number(req.params.pid);
    const contest = Number.isSafeInteger(contestId) && contestId > 0 ? await Contest.findById(contestId) : null;
    if (!contest) throw new ErrorMessage('无此比赛。');
    const problemIds = await contest.getProblems();
    if (!Number.isSafeInteger(problemIndex) || problemIndex < 1 || problemIndex > problemIds.length) {
      throw new ErrorMessage('无此题目。');
    }
    const problem = await Problem.findById(problemIds[problemIndex - 1]);
    if (!problem) throw new ErrorMessage('无此题目。');
    const supervisor = await contest.isSupervisior(res.locals.user);
    contest.ended = contest.isEnded();
    if (!supervisor && !(contest.isRunning() || contest.ended)) {
      if (await problem.isAllowedUseBy(res.locals.user)) {
        return res.redirect(syzoj.utils.makeUrl(['problem', problem.id]));
      }
      throw new ErrorMessage('比赛尚未开始。');
    }
    const presentation = await loadContestProblemPresentation(problem);
    Object.assign(problem, presentation.rendered);
    problem.specialJudge = presentation.specialJudge;
    await problem.loadRelationships();
    const [state, lastLanguage] = await Promise.all([
      problem.getJudgeState(res.locals.user, false),
      res.locals.user ? res.locals.user.getLastSubmitLanguage() : null
    ]);
    res.render('problem', {
      pid: problemIndex,
      contest,
      problem,
      state,
      lastLanguage,
      testcases: presentation.testcases,
      languages: problem.getVJudgeLanguages()
    });
  } catch (error) {
    syzoj.log(error);
    res.status(error.statusCode || 400).render('error', { err: error });
  }
});
