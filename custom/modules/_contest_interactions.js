const TypeORM = require('typeorm');
const { AsyncLocalStorage } = require('async_hooks');
const problemDomain = require('../libs/problem-domain');

const Contest = syzoj.model('contest');
const ContestRanklist = syzoj.model('contest_ranklist');
const Problem = syzoj.model('problem');
const User = syzoj.model('user');
const { linkUserMentions } = require('../libs/user-mentions');
const { buildContestRanklistCsv } = require('../libs/contest-ranklist-export');
const classGroups = require('../libs/class-groups');
const { loadFrozenScoreDetails } = require('../libs/contest-standings');
const { ReadCache } = require('../libs/read-cache');
const ranklistAuxCache = new ReadCache(128);

const contestOverviewContext = new AsyncLocalStorage();
const contestStatisticsCache = new Map();
const contestRanklistCache = new Map();
const contestProblemCache = new Map();
const originalGetPlayers = ContestRanklist.prototype.getPlayers;

app.use('/contest/:id', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.setHeader('Cache-Control', 'private, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || ''); } catch (error) { return fallback; }
}

function normalizeRanklistAccountFilter(value) {
  const filter = String(value || 'all').trim().toLowerCase();
  return filter === 'contest' || filter === 'ordinary' || filter === 'ai' ? filter : 'all';
}

function accountMatchesFilter(item, accountFilter) {
  if (accountFilter === 'all') return true;
  if (accountFilter === 'contest') return !!item.user.isTemporaryContestAccount;
  if (accountFilter === 'ai') return !!item.user.isAiAccount;
  return !item.user.isTemporaryContestAccount && !item.user.isAiAccount;
}

function assignStandingRanks(items, contestType) {
  let rank = 0;
  let previous = null;
  items.forEach((item, index) => {
    const key = contestType === 'acm'
      ? `${item.player.score}:${item.tie}`
      : String(item.player.score);
    if (key !== previous) rank = index + 1;
    item.player.standing_rank = rank;
    previous = key;
  });
}

function ranklistItemsForAccountFilter(allItems, accountFilter, contest) {
  const filteredItems = allItems.filter(item => accountMatchesFilter(item, accountFilter));
  const rankedItems = filteredItems.map(cloneRanklistItem);
  if (accountFilter !== 'all') {
    rankedItems.forEach(item => {
      item.player.overall_standing_rank = item.player.standing_rank;
    });
    assignStandingRanks(rankedItems, contest.type);
  }
  return rankedItems;
}

function ranklistItemsForFilters(allItems, accountFilter, classIds, membership, contest) {
  const selected = new Set(classGroups.normalizeClassIds(classIds));
  const filtered = allItems.filter(item => {
    const accountMatches = accountMatchesFilter(item, accountFilter);
    const classMatches = !selected.size || (membership.byUser.get(Number(item.user.id)) || [])
      .some(group => selected.has(Number(group.id)));
    return accountMatches && classMatches;
  });
  const items = filtered.map(cloneRanklistItem);
  if (accountFilter !== 'all' || selected.size) {
    items.forEach(item => { item.player.overall_standing_rank = item.player.standing_rank; });
    assignStandingRanks(items, contest.type);
  }
  return items;
}

async function canExportContestRanklist(contest, user) {
  if (!contest || !user) return false;
  const resource = {
    id: Number(contest.id),
    ownerId: Number(contest.holder_id),
    scope: `contest:${contest.id}`
  };
  return syzoj.utils.authorizationV2.authorize(user, 'contest:standings.export', resource, { scope: resource.scope });
}

async function loadRanklistProfiles(items) {
  const userIds = Array.from(new Set(items.map(item => Number(item.user.id)).filter(Boolean)));
  if (!userIds.length) return new Map();
  const rows = await TypeORM.getConnection().query(
    'SELECT user_id,student_id,real_name,college FROM user_registration_profile WHERE user_id IN (?)',
    [userIds]
  );
  return new Map(rows.map(row => [Number(row.user_id), row]));
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
  while (cache.size > 256) cache.delete(cache.keys().next().value);
  return promise;
}

syzoj.utils.invalidateContestReadCache = function invalidateContestReadCache(contestId) {
  const prefix = String(Number(contestId)) + ':';
  ranklistAuxCache.invalidate(prefix);
  for (const key of contestStatisticsCache.keys()) {
    if (key.startsWith(prefix)) contestStatisticsCache.delete(key);
  }
  for (const key of contestRanklistCache.keys()) {
    if (key.startsWith(prefix)) contestRanklistCache.delete(key);
  }
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

async function loadContestRanklist(contest, cutoff = null) {
  return cached(contestRanklistCache, `${Number(contest.id)}:${cutoff == null ? 'live' : cutoff}:${contest.type}:${contest.start_time}:${contest.end_time}:${contest.problems}`, 2000, async () => {
    if (syzoj.utils.aiContest && syzoj.utils.aiContest.ensureSchema) await syzoj.utils.aiContest.ensureSchema();
    const rows = await TypeORM.getConnection().query(
      `SELECT cp.id AS player_id,cp.user_id,cp.score,cp.score_details,cp.time_spent,
              u.username,u.is_admin,u.nameplate,u.rating,
              temporary_account.user_id AS temporary_account_user_id,
              ai_agent.user_id AS ai_agent_user_id
       FROM contest_player cp
       INNER JOIN user u ON u.id=cp.user_id
       LEFT JOIN temporary_contest_account temporary_account
         ON temporary_account.contest_id=cp.contest_id AND temporary_account.user_id=cp.user_id
       LEFT JOIN contest_registration_removal removal
         ON removal.contest_id=cp.contest_id AND removal.user_id=cp.user_id
       LEFT JOIN ai_agent_account ai_agent ON ai_agent.user_id=cp.user_id AND ai_agent.enabled=1
       WHERE cp.contest_id=? AND removal.user_id IS NULL`,
      [contest.id]
    );
    const rankingRows = await TypeORM.getConnection().query('SELECT ranking_params FROM contest_ranklist WHERE id=? LIMIT 1', [contest.ranklist_id]);
    const rankingParams = parseJson(rankingRows[0] && rankingRows[0].ranking_params, {});
    const activeProblems = new Set(String(contest.problems || '').split('|'));
    const frozenDetails = cutoff == null ? null : await loadFrozenScoreDetails(TypeORM.getConnection(), contest, cutoff);
    const judgeIds = [];
    const items = rows.map(row => {
      const details = frozenDetails ? frozenDetails.get(Number(row.user_id)) || {} : parseJson(row.score_details, {});
      for (const detail of Object.values(details)) {
        if (detail && detail.judge_id) judgeIds.push(Number(detail.judge_id));
      }
      return {
        user: {
          id: Number(row.user_id),
          username: row.username,
          is_admin: !!row.is_admin,
          nameplate: row.nameplate || '',
          rating: Number(row.rating || syzoj.config.default.user.rating),
          isTemporaryContestAccount: row.temporary_account_user_id != null,
          isAiAccount: row.ai_agent_user_id != null
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
        if (!activeProblems.has(String(problemId))) {
          delete item.player.score_details[problemId];
          continue;
        }
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
    assignStandingRanks(items, contest.type);
    return items;
  });
}

async function loadContestProblemPresentation(problem, contestId) {
  let contestSnapshot = null;
  let testdataPath = problem.getTestdataPath();
  if (contestId && syzoj.utils.contestV2 && syzoj.utils.contestV2.getProblemSnapshot) {
    contestSnapshot = await syzoj.utils.contestV2.getProblemSnapshot(contestId, problem.id);
    if (contestSnapshot && contestSnapshot.problem_snapshot_id) {
      const rows = await TypeORM.getConnection().query(
        'SELECT testdata_path FROM problem_v2_snapshot WHERE id=? AND problem_id=? LIMIT 1',
        [String(contestSnapshot.problem_snapshot_id), Number(problem.id)]
      );
      if (rows[0] && rows[0].testdata_path) testdataPath = rows[0].testdata_path;
    }
  }
  const cacheKey = `${Number(problem.id)}:${problem.contestVersionId || 'legacy'}:${contestSnapshot && contestSnapshot.problem_snapshot_id || 'live'}`;
  return cached(contestProblemCache, cacheKey, 5000, async () => {
    const fields = ['description', 'input_format', 'output_format', 'example', 'limit_and_hint'];
    const rendered = {};
    for (const field of fields) rendered[field] = problem[field] || '';
    const [specialJudge, testcases] = await Promise.all([
      problem.hasSpecialJudge(),
      syzoj.utils.parseTestdata(testdataPath, problem.type === 'submit-answer'),
      syzoj.utils.markdown(rendered, fields)
    ]);
    await Promise.all(fields.map(async field => {
      rendered[field] = await linkUserMentions(rendered[field]);
    }));
    return { rendered, specialJudge, testcases };
  });
}

async function applyCurrentProblemVersions(problems) {
  const valid = (problems || []).filter(Boolean);
  const ids = Array.from(new Set(valid.map(problem => Number(problem.id)).filter(Boolean)));
  if (!ids.length) return valid;
  const rows = await TypeORM.getConnection().query(
    `SELECT state.problem_id,state.current_version_id,version.content_json
       FROM problem_v2_state state
       JOIN problem_v2_version version ON version.id=state.current_version_id
      WHERE state.problem_id IN (?)`,
    [ids]
  );
  const versions = new Map(rows.map(row => [Number(row.problem_id), row]));
  for (const problem of valid) {
    const row = versions.get(Number(problem.id));
    if (!row || !row.content_json) continue;
    Object.assign(problem, problemDomain.parseStoredContent(row.content_json));
    problem.contestVersionId = String(row.current_version_id);
  }
  return valid;
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
    player: Object.assign({}, item.player, { score_details: details }),
    tie: item.tie
  };
}

app.get('/contest/:id', (req, res, next) => {
  if (req.query.view === 'problems') {
    const state = res.locals.contestRegistration;
    if (state && state.submitted && !state.ended && !state.isSupervisior) return res.redirect(syzoj.utils.makeUrl(['contest', req.params.id, 'details']));
    return contestOverviewContext.run(true, next);
  }
  return res.redirect(302, syzoj.utils.makeUrl(['contest', req.params.id, 'details']));
});

app.get('/contest/:id/edit', (req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = function renderContestEditorWithCurrentProblems(view, options) {
    if (view !== 'contest_edit' || !options || !Array.isArray(options.problems)) {
      return originalRender.apply(res, arguments);
    }
    applyCurrentProblemVersions(options.problems)
      .then(() => originalRender(view, options))
      .catch(next);
    return res;
  };
  next();
});

app.get('/contest/:id/details', async (req, res) => {
  try {
    const contestId = Number(req.params.id);
    const contest = Number.isSafeInteger(contestId) && contestId > 0 ? await Contest.findById(contestId) : null;
    if (!contest) throw new ErrorMessage('无此比赛。');
    const supervisor = await contest.isSupervisior(res.locals.user);
    if (!contest.is_public && !supervisor) throw new ErrorMessage('比赛未公开，请耐心等待。');
    const content = {
      subtitle: String(contest.subtitle || ''),
      information: String(contest.information || '')
    };
    await syzoj.utils.markdown(content, ['subtitle', 'information']);
    try {
      content.information = await linkUserMentions(content.information);
    } catch (error) {
      syzoj.log('[contest-details] mention rendering failed: ' + error.message);
    }
    res.render('contest_details', {
      contest,
      contestDetails: content
    });
  } catch (error) {
    syzoj.log(error);
    res.status(error.statusCode || 400).render('error', { err: error });
  }
});

app.get('/contest/:id', (req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = function renderContestWithCanonicalStatistics(view, options) {
    if (view !== 'contest' || !options || !options.contest || !Array.isArray(options.problems)) {
      return originalRender.apply(res, arguments);
    }
    options.contest.running = options.contest.isRunning();
    options.contest.ended = options.contest.isEnded();
    const problemIds = options.problems.map(item => Number(item.problem && item.problem.id)).filter(Boolean);
    Promise.all([
      loadContestStatistics(Number(options.contest.id), problemIds),
      applyCurrentProblemVersions(options.problems.map(item => item.problem))
    ]).then(([statistics]) => {
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

async function contestRanklistView(req, res) {
    const contestId = Number(req.params.id);
    const contest = Number.isSafeInteger(contestId) && contestId > 0 ? await Contest.findById(contestId) : null;
    if (!contest) throw Object.assign(new ErrorMessage('无此比赛。'), { statusCode: 404 });
    const supervisor = await contest.isSupervisior(res.locals.user);
    if (!contest.is_public && (!res.locals.user || (!res.locals.user.is_admin && !supervisor && !String(contest.admins || '').split('|').includes(String(res.locals.user.id))))) {
      throw Object.assign(new ErrorMessage('比赛未公开，请耐心等待。'), { statusCode: 403 });
    }
    let registration = res.locals.contestRegistration;
    if (!registration && res.locals.user) {
      const participants = await TypeORM.getConnection().query('SELECT id,submitted_at FROM contest_player WHERE contest_id=? AND user_id=? LIMIT 1', [contest.id, res.locals.user.id]);
      registration = { registered: !!participants.length, submitted: !!(participants[0] && participants[0].submitted_at) };
    }
    const submitted = !!(registration && registration.submitted);
    const publicReadOnly = !!contest.is_public && !supervisor && !(registration && registration.registered);
    if ([publicReadOnly, contest.allowedSeeingResult() && contest.allowedSeeingOthers(), contest.isEnded(), supervisor, submitted].every(value => !value)) {
      throw Object.assign(new ErrorMessage('您没有权限进行此操作。'), { statusCode: 403 });
    }
    if (typeof syzoj.utils.ensureTemporaryContestAccountSchema === 'function') {
      await syzoj.utils.ensureTemporaryContestAccountSchema();
    }
    const standingsView = await syzoj.utils.contestV2.standingsView(contest, res.locals.user, String(req.query.view || 'public'));
    const allItems = await loadContestRanklist(contest, standingsView.cutoff);
    const accountFilter = normalizeRanklistAccountFilter(req.query.account);
    const classMembership = await loadRanklistClasses(contest, allItems);
    const requestedClassIds = classGroups.normalizeClassIds(req.query.classes);
    const availableClassIds = new Set(classMembership.classes.map(group => group.id));
    const selectedClassIds = requestedClassIds.filter(id => availableClassIds.has(id));
    const rankedItems = ranklistItemsForFilters(allItems, accountFilter, selectedClassIds, classMembership, contest);
    const paginate = syzoj.utils.paginate(rankedItems.length, req.query.page, 100);
    const offset = (paginate.currPage - 1) * paginate.perPage;
    const ranklist = rankedItems.slice(offset, offset + paginate.perPage);
    const problemIds = await contest.getProblems();
    const problems = await loadRanklistProblems(problemIds);
    const canManageRanklist = standingsView.canManage;
    const showRanklistIdentities = canManageRanklist && String(req.query.identity || '') === 'real';
    const ranklistProfiles = showRanklistIdentities ? await loadRanklistProfiles(ranklist) : new Map();
    return {
      contest,
      ranklist,
      problems,
      paginate,
      rankOffset: offset,
      ranklistAccountFilter: accountFilter,
      ranklistClassOptions: classMembership.classes,
      ranklistSelectedClassIds: selectedClassIds,
      ranklistClassMembership: classMembership.byUser,
      ranklistTotal: rankedItems.length,
      canManageRanklist,
      canExportRanklist: canManageRanklist,
      showRanklistIdentities,
      ranklistProfiles,
      standingsView,
      ranklistSupervisor: supervisor,
      paginationBasePath: ['contest', contest.id, 'ranklist']
    };
}

function loadRanklistClasses(contest, items) {
  const ids = items.map(item => item.user.id);
  return ranklistAuxCache.get(`${contest.id}:classes:${ids.join(',')}`, 2000, () => classGroups.membershipForUsers(ids));
}

async function loadRanklistProblems(ids) {
  if (!ids.length) return [];
  // One batch read of current titles, never a cached copy of problem statements.
  const rows = await TypeORM.getConnection().query(`SELECT p.id,
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(version.content_json,'$.title')),p.title) AS title
    FROM problem p LEFT JOIN problem_v2_state state ON state.problem_id=p.id
    LEFT JOIN problem_v2_version version ON version.id=state.current_version_id
    WHERE p.id IN (?)`, [ids]);
  const byId = new Map(rows.map(row => [Number(row.id), row]));
  return ids.map(id => byId.get(Number(id))).filter(Boolean);
}

app.get('/contest/:id/ranklist', async (req, res) => {
  try {
    res.render('contest_ranklist', await contestRanklistView(req, res));
  } catch (error) {
    syzoj.log(error);
    res.status(error.statusCode || 400).render('error', { err: error });
  }
});

app.get('/api/v2/contests/:id/ranklist-view', async (req, res) => {
  const api = syzoj.utils.apiV2;
  try {
    const options = await contestRanklistView(req, res);
    if (syzoj.utils.enrichContestRanklistRating) await syzoj.utils.enrichContestRanklistRating(options);
    options.ranklistPartial = true;
    // Per-view versioning skips EJS rendering as well as payload transfer when
    // nothing changed. Permissions and current titles were re-read above.
    const revision = api.etagFor({
      viewer: Number(res.locals.user && res.locals.user.id || 0),
      contest: [options.contest.id, options.contest.title, options.contest.type, options.contest.start_time, options.contest.end_time, options.contest.isEnded()],
      rows: options.ranklist, problems: options.problems, page: options.paginate,
      account: options.ranklistAccountFilter, classes: options.ranklistClassOptions, selected: options.ranklistSelectedClassIds,
      total: options.ranklistTotal, manager: options.canManageRanklist, supervisor: options.ranklistSupervisor,
      identity: options.showRanklistIdentities, profiles: Array.from(options.ranklistProfiles.entries()),
      view: options.standingsView, rated: options.contestRated, rating: options.contestRatingStatus,
      finalized: options.contestRatingFinalized,
      cheaters: Array.from(syzoj.contestCheaterMap && syzoj.contestCheaterMap.get(options.contest.id) || []),
      // Username colours, tags and class tags are live in-memory projections.
      names: options.ranklist.map(item => syzoj.utils.renderUsername(item.user))
    });
    const unchanged = req.query.revision === revision;
    const html = unchanged ? null : await new Promise((resolve, reject) => res.render('contest_ranklist', options, (error, output) => error ? reject(error) : resolve(output)));
    const now = Math.floor(Date.now() / 1000);
    const boundary = options.standingsView.freezeAt > now && !options.standingsView.frozen
      ? Math.min(options.standingsView.freezeAt, options.contest.end_time) : options.contest.end_time;
    const nextUpdate = options.contest.isEnded() ? 30000 : Math.max(1000, Math.min(15000, (boundary - now) * 1000));
    return api.send(res, { unchanged, revision, html, next_update_ms: nextUpdate,
      can_manage: options.canManageRanklist, frozen: options.standingsView.frozen,
      show_live: options.standingsView.showLive, title: options.contest.title,
      clock: { start: Number(options.contest.start_time), end: Number(options.contest.end_time), now } });
  } catch (error) {
    syzoj.log(error);
    return api.fail(res, error.statusCode || 500, 'REQUEST_FAILED', '无法更新排行榜，请刷新页面确认访问权限。');
  }
});

app.get('/contest/:id/ranklist/export', async (req, res) => {
  try {
    const contestId = Number(req.params.id);
    const contest = Number.isSafeInteger(contestId) && contestId > 0 ? await Contest.findById(contestId) : null;
    if (!contest) throw new ErrorMessage('无此比赛。');
    if (!await canExportContestRanklist(contest, res.locals.user)) {
      return res.status(res.locals.user ? 403 : 401).render('error', {
        err: new ErrorMessage(res.locals.user ? '您没有权限导出该比赛的排行榜。' : '请登录后导出排行榜。')
      });
    }
    if (typeof syzoj.utils.ensureTemporaryContestAccountSchema === 'function') {
      await syzoj.utils.ensureTemporaryContestAccountSchema();
    }
    const accountFilter = normalizeRanklistAccountFilter(req.query.account);
    const standingsView = await syzoj.utils.contestV2.standingsView(contest, res.locals.user, String(req.query.view || 'public'));
    const allItems = await loadContestRanklist(contest, standingsView.cutoff);
    const classMembership = await loadRanklistClasses(contest, allItems);
    const availableClassIds = new Set(classMembership.classes.map(group => group.id));
    const selectedClassIds = classGroups.normalizeClassIds(req.query.classes).filter(id => availableClassIds.has(id));
    const items = ranklistItemsForFilters(allItems, accountFilter, selectedClassIds, classMembership, contest);
    const problemIds = (await contest.getProblems()).map(Number).filter(Boolean);
    const profiles = await loadRanklistProfiles(items);
    const csv = buildContestRanklistCsv({ contest, items, problemIds, profiles, accountFilter, selectedClassIds, classMembership: classMembership.byUser });
    const suffix = [accountFilter === 'all' ? '' : accountFilter, selectedClassIds.length ? 'classes' : ''].filter(Boolean).map(value => '-' + value).join('');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    const viewSuffix = standingsView.cutoff != null ? '-frozen' : standingsView.showLive ? '-live' : '';
    res.setHeader('Content-Disposition', `attachment; filename="contest-${contest.id}-ranklist${suffix}${viewSuffix}.csv"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(csv);
  } catch (error) {
    syzoj.log(error);
    return res.status(error.statusCode || 500).render('error', { err: error });
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
    if (syzoj.utils.contestV2 && syzoj.utils.contestV2.syncProblemSnapshotsForProblem) {
      await syzoj.utils.contestV2.syncProblemSnapshotsForProblem(problem.id, res.locals.user, req);
    }
    await applyCurrentProblemVersions([problem]);
    const supervisor = await contest.isSupervisior(res.locals.user);
    contest.ended = contest.isEnded();
    if (!supervisor && !(contest.isRunning() || contest.ended)) {
      if (await problem.isAllowedUseBy(res.locals.user)) {
        return res.redirect(syzoj.utils.makeUrl(['problem', problem.id]));
      }
      throw new ErrorMessage('比赛尚未开始。');
    }
    const presentation = await loadContestProblemPresentation(problem, contest.id);
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
