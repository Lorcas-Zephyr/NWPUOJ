// ============================================================
// Hit 值计算引擎
// - 启动时延后 30 秒做首次计算(等数据库连接稳定)
// - 每天 00:00 全量重算 + 写入历史
// - 每 60 秒从 user_hit_score 表刷新内存 Map
// - 维护 syzoj.userHitScores 给 username helper 用
// - 暴露 syzoj.recalcHitScores() 给后台手动触发
// ============================================================
let UserHitScore = syzoj.model('user-hit-score');
let UserHitScoreHistory = syzoj.model('user-hit-score-history');
let User = syzoj.model('user');
let JudgeState = syzoj.model('judge_state');
let Problem = syzoj.model('problem');
let ProblemSolution = syzoj.model('problem-solution');
let ContestPlayer = syzoj.model('contest_player');
let ProblemTagMap = syzoj.model('problem_tag_map');
let UserEmailStatus = syzoj.model('user-email-status');
let UserHitSetting = syzoj.model('user-hit-setting');
let Contest = syzoj.model('contest');
const crypto = require('crypto');
const TypeORM = require('typeorm');
const contentDomain = require('../libs/content-domain');

const CACHE_REFRESH_INTERVAL_MS = 60 * 1000;
const INITIAL_DELAY_MS = 30 * 1000;
const HISTORY_RETENTION_DAYS = 90;

// 全局内存 Map: userId -> { total, basic_score, contribution_score, contest_score, practice_score }
syzoj.userHitScores = new Map();

// ============ 工具:half-life 衰减 ============
function halfLifeDecay(value, daysSinceActive, halfLifeDays) {
  if (daysSinceActive <= 0) return value;
  let factor = Math.pow(0.5, daysSinceActive / halfLifeDays);
  return value * factor;
}

// ============ 单用户计算 ============
async function calcOneUser(user) {
  let now = parseInt((new Date()).getTime() / 1000);

  // -------- 基础信用分(满分 100,无保底)--------
  let basic = 0;
  try {
    if (await syzoj.utils.isEmailVerified(user.id)) basic += 60;
  } catch (e) {}

  if (user.information && String(user.information).trim().length > 0) basic += 10;
  if (user.register_time && now - user.register_time >= 7 * 86400) basic += 15;

  let cpAnyCount = await ContestPlayer.count({ user_id: user.id });
  if (cpAnyCount >= 1) basic += 15;

  if (basic > 100) basic = 100;

  // -------- 社区贡献分(满分 100)--------
  let contribution = 0;
  let acceptedSolutions = await ProblemSolution.count({
    user_id: user.id,
    status: 'accepted'
  });
  contribution += Math.min(acceptedSolutions * 2, 60);

  let problemsCreated = await Problem.count({ user_id: user.id });
  contribution += Math.min(problemsCreated * 4, 40);

  if (contribution > 100) contribution = 100;

  // -------- 比赛参与分(满分 100,30 天半衰减)--------
  let contestRaw = 0;
  let lastContestEnd = 0; // 最后一次有效参赛的比赛 end_time

  // 查 score > 0 的所有 contest_player 记录
  let activeCps = await ContestPlayer.createQueryBuilder('cp')
    .where('cp.user_id = :uid', { uid: user.id })
    .andWhere('cp.score > 0')
    .getMany();
    // 排除作弊比赛: 该用户在该比赛中有过 cheated 提交,则该比赛对其 Hit 比赛分无贡献
  const _cheaterMap = syzoj.contestCheaterMap || new Map();
  activeCps = activeCps.filter(cp => {
    const cset = _cheaterMap.get(cp.contest_id);
    return !cset || !cset.has(user.id);
  });

  contestRaw += Math.min(activeCps.length * 2.5, 60);

  // 计算每场的得分率(用该比赛最高分作为分母)
  let hasGoodScore = false;
  let hasAK = false;
  for (let cp of activeCps) {
    // 拿这场比赛的最高分
    let maxRow = await ContestPlayer.createQueryBuilder()
      .select('MAX(score)', 'max_score')
      .where('contest_id = :cid', { cid: cp.contest_id })
      .getRawOne();
    let maxScore = maxRow ? parseInt(maxRow.max_score) || 0 : 0;
    if (maxScore <= 0) continue;
    let rate = cp.score / maxScore;
    if (rate >= 0.6) hasGoodScore = true;
    if (rate >= 0.9) hasAK = true;

    // 跟踪最后一次有效参赛时间
    let contest = await Contest.findById(cp.contest_id);
    if (contest && contest.end_time && contest.end_time > lastContestEnd) {
      lastContestEnd = contest.end_time;
    }
  }
  if (hasGoodScore) contestRaw += 5;
  if (hasAK) contestRaw += 15;

  if (contestRaw > 100) contestRaw = 100;

  // 衰减
  let contestFinal = 0;
  if (lastContestEnd > 0) {
    let daysSince = (now - lastContestEnd) / 86400;
    contestFinal = Math.floor(halfLifeDecay(contestRaw, daysSince, 30));
  }
  if (contestFinal < 0) contestFinal = 0;

  // -------- 题目练习分(满分 100,14 天半衰减只作用于 ac 部分)--------
  let acNum = user.ac_num || 0;
  let acPart = 0;
  if (acNum > 0) {
    acPart = Math.min(Math.floor(Math.log2(acNum + 1) * 2.5), 75);
  }

  // 标签覆盖度(不衰减)
  let tagCount = 0;
  try {
    let tagRow = await ProblemTagMap.createQueryBuilder('m')
      .innerJoin('judge_state', 'js', 'js.problem_id = m.problem_id')
      .leftJoin('judge_state_admin_action', 'a', 'a.judge_id = js.id')
      .where('js.user_id = :uid', { uid: user.id })
      .andWhere('js.status = :st', { st: 'Accepted' })
      .andWhere('a.judge_id IS NULL')
      .select('COUNT(DISTINCT m.tag_id)', 'cnt')
      .getRawOne();
    tagCount = tagRow ? parseInt(tagRow.cnt) || 0 : 0;
  } catch (e) {}
  let tagPart = Math.min(Math.floor(tagCount * 0.2), 25);

  // 最后一次 AC 时间
  let lastAcRow = null;
  try {
    lastAcRow = await JudgeState.createQueryBuilder('js')
      .leftJoin('judge_state_admin_action', 'a', 'a.judge_id = js.id')
      .select('MAX(js.submit_time)', 'last_ac')
      .where('js.user_id = :uid', { uid: user.id })
      .andWhere('js.status = :st', { st: 'Accepted' })
      .andWhere('a.judge_id IS NULL')
      .getRawOne();
  } catch (e) {}
  let lastAcTime = lastAcRow ? parseInt(lastAcRow.last_ac) || 0 : 0;

  let acFinal = 0;
  if (acPart > 0 && lastAcTime > 0) {
    let daysSince = (now - lastAcTime) / 86400;
    acFinal = Math.floor(halfLifeDecay(acPart, daysSince, 14));
  }

  let practice = acFinal + tagPart;
  if (practice > 100) practice = 100;
  if (practice < 0) practice = 0;

  let total = basic + contribution + contestFinal + practice;
  if (total > 400) total = 400;
  if (total < 0) total = 0;

  return {
    user_id: user.id,
    total: total,
    basic_score: basic,
    contribution_score: contribution,
    contest_score: contestFinal,
    practice_score: practice
  };
}

// ============ 全量计算 ============
async function runFullRecalc() {
  let started = Date.now();
  syzoj.log('[hit-engine] Full recalc started');

  let users;
  try {
    users = await User.find({});
  } catch (e) {
    syzoj.log('[hit-engine] Failed to load users: ' + e.message);
    return;
  }

  let now = parseInt((new Date()).getTime() / 1000);
  let updated = 0;
  let failed = 0;

  for (let u of users) {
    try {
      let scores = await calcOneUser(u);

      // 更新当前分数
      let row = await UserHitScore.findOne({ where: { user_id: u.id } });
      if (!row) {
        row = await UserHitScore.create();
        row.user_id = u.id;
      }
      row.total = scores.total;
      row.basic_score = scores.basic_score;
      row.contribution_score = scores.contribution_score;
      row.contest_score = scores.contest_score;
      row.practice_score = scores.practice_score;
      row.last_calc_at = now;
      await row.save();

      // 写入历史
      let hist = await UserHitScoreHistory.create();
      hist.user_id = u.id;
      hist.total = scores.total;
      hist.basic_score = scores.basic_score;
      hist.contribution_score = scores.contribution_score;
      hist.contest_score = scores.contest_score;
      hist.practice_score = scores.practice_score;
      hist.recorded_at = now;
      await hist.save();

      updated++;
    } catch (e) {
      failed++;
      syzoj.log('[hit-engine] Failed for user ' + u.id + ': ' + e.message);
    }
  }

  // 清理超过保留期的历史
  try {
    let cutoff = now - HISTORY_RETENTION_DAYS * 86400;
    await UserHitScoreHistory.createQueryBuilder()
      .delete()
      .where('recorded_at < :cutoff', { cutoff: cutoff })
      .execute();
  } catch (e) {
    syzoj.log('[hit-engine] Failed to clean old history: ' + e.message);
  }

  let elapsed = ((Date.now() - started) / 1000).toFixed(1);
  syzoj.log('[hit-engine] Full recalc done: ' + updated + ' ok, ' + failed + ' failed, ' + elapsed + 's');

  // 立刻刷新内存
  await refreshMemoryCache();
}

let fullRecalcPromise = null;
function fullRecalc() {
  if (!fullRecalcPromise) {
    fullRecalcPromise = runFullRecalc().finally(() => { fullRecalcPromise = null; });
  }
  return fullRecalcPromise;
}

function startOfTodaySeconds() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor(today.getTime() / 1000);
}

async function needsStartupCatchup() {
  const [scoreStats, userCount] = await Promise.all([
    UserHitScore.createQueryBuilder('score')
      .select('COUNT(*)', 'count')
      .addSelect('MIN(score.last_calc_at)', 'oldest_calc')
      .getRawOne(),
    User.count()
  ]);
  const scoreCount = Number(scoreStats && scoreStats.count || 0);
  const oldestCalculation = Number(scoreStats && scoreStats.oldest_calc || 0);
  return scoreCount < Number(userCount || 0) ||
    (scoreCount > 0 && oldestCalculation < startOfTodaySeconds());
}

function formatLocalScheduleTime(date) {
  const pad = value => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' +
    pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

function scheduleNextDailyRecalc() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  syzoj.hitNextRecalcAt = Math.floor(next.getTime() / 1000);
  syzoj.log('[hit-engine] Next daily recalc scheduled at ' + formatLocalScheduleTime(next));
  setTimeout(async () => {
    try {
      await fullRecalc();
    } catch (error) {
      syzoj.log('[hit-engine] Daily recalc failed: ' + error.message);
    } finally {
      scheduleNextDailyRecalc();
    }
  }, Math.max(1000, next.getTime() - now.getTime()));
}

// ============ 刷新内存缓存 ============
async function refreshMemoryCache() {
  try {
    let rows = await UserHitScore.find({});
    let m = new Map();
    for (let r of rows) {
      m.set(r.user_id, {
        total: r.total,
        basic_score: r.basic_score,
        contribution_score: r.contribution_score,
        contest_score: r.contest_score,
        practice_score: r.practice_score
      });
    }
    syzoj.userHitScores = m;
  } catch (e) {
    syzoj.log('[hit-engine] Refresh memory cache failed: ' + e.message);
  }
}

// 暴露给外部:手动触发
syzoj.recalcHitScores = fullRecalc;

// 启动延迟初始化(让数据库准备好)
setTimeout(async () => {
  try {
    await refreshMemoryCache();
    syzoj.log('[hit-engine] Memory cache loaded: ' + syzoj.userHitScores.size + ' users');

    // 重启错过零点任务或存在尚未计算的新用户时立即补算。
    if (await needsStartupCatchup()) {
      syzoj.log('[hit-engine] Today\'s calculation is missing, doing startup catch-up...');
      await fullRecalc();
    }

    // 内存缓存按分钟刷新，全量计算固定在本地时区每天 00:00。
    setInterval(refreshMemoryCache, CACHE_REFRESH_INTERVAL_MS);
    scheduleNextDailyRecalc();
  } catch (e) {
    syzoj.log('[hit-engine] Init failed: ' + e.message);
  }
}, INITIAL_DELAY_MS);
// ============ 管理员手动触发重算 ============
app.post('/api/v2/admin/hit/recalculate', async (req, res) => {
  const api = syzoj.utils.apiV2;
  const user = res.locals.user;
  if (!user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!await syzoj.utils.authorizationV2.authorize(user, 'admin:job.manage', null, { scope: 'global' })) {
    return api.fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: admin:job.manage.');
  }
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) {
    return api.fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Sign in again before recalculating Hit scores.');
  }
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
    action: 'admin:hit.recalculate', resourceType: 'hit_score', resourceId: 'all', details: {}
  });
  await api.appendEvent({
    stream: 'admin:hit-score', type: 'hit_score.recalculation.queued', aggregateId: 'all',
    actor: user, payload: { audit_event_id: auditEventId }
  });
  fullRecalc().catch(error => syzoj.log('[hit-engine] Manual recalc failed: ' + error.message));
  return api.send(res, { state: 'queued', audit_event_id: String(auditEventId) }, 202);
});


// ============ 工具:获取或创建 Hit 设置记录 ============
async function getOrCreateHitSetting(userId) {
  let s = await UserHitSetting.findOne({ where: { user_id: userId } });
  if (!s) {
    s = await UserHitSetting.create();
    s.user_id = userId;
    s.hide_hit = false;
  }
  return s;
}

// 暴露给模板用:同步检查某用户是否选择了隐藏 Hit 卡片
// 用全局缓存(每分钟刷新一次同 hit score 缓存)
syzoj.userHitHidden = new Set();

async function refreshHitHiddenSet() {
  try {
    let rows = await UserHitSetting.createQueryBuilder()
      .where('hide_hit = TRUE')
      .getMany();
    let s = new Set();
    for (let r of rows) s.add(r.user_id);
    syzoj.userHitHidden = s;
  } catch (e) {
    syzoj.log('[hit-engine] Refresh hidden set failed: ' + e.message);
  }
}
// 启动时延后刷新(等数据库准备好)
setTimeout(refreshHitHiddenSet, 30 * 1000);
setInterval(refreshHitHiddenSet, 60 * 1000);

// ============ 用户保存 Hit 隐藏设置 ============
function hitSettingResource(row) {
  return {
    hide_hit: !!(row && row.hide_hit),
    updated_at: row && row.update_time ? new Date(Number(row.update_time) * 1000).toISOString() : null
  };
}

app.get('/api/v2/me/hit-settings', async (req, res) => {
  const user = res.locals.user;
  const api = syzoj.utils.apiV2;
  if (!user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!await syzoj.utils.authorizationV2.authorize(user, 'profile:edit', { ownerId: user.id, scope: `user:${user.id}` }, { scope: `user:${user.id}` })) {
    return api.fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: profile:edit.');
  }
  const rows = await TypeORM.getConnection().query(
    'SELECT hide_hit,update_time FROM user_hit_setting WHERE user_id=? LIMIT 1',
    [user.id]
  );
  const resource = hitSettingResource(rows[0]);
  if (api.apiNotModified(req, res, resource)) return;
  return api.send(res, resource);
});

app.patch('/api/v2/me/hit-settings', async (req, res) => {
  const user = res.locals.user;
  const api = syzoj.utils.apiV2;
  if (!user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!await syzoj.utils.authorizationV2.authorize(user, 'profile:edit', { ownerId: user.id, scope: `user:${user.id}` }, { scope: `user:${user.id}` })) {
    return api.fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: profile:edit.');
  }
  if (!req.get('If-Match')) return api.fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when editing Hit settings.', { if_match: 'required' });
  const hideHit = req.body && (req.body.hide_hit === true || req.body.hide_hit === 1 || req.body.hide_hit === '1' || req.body.hide_hit === 'true' || req.body.hide_hit === 'on');
  try {
    await api.ensureFoundationSchema();
    const saved = await TypeORM.getConnection().transaction(async manager => {
      const rows = await manager.query(
        'SELECT hide_hit,update_time FROM user_hit_setting WHERE user_id=? LIMIT 1 FOR UPDATE',
        [user.id]
      );
      const current = hitSettingResource(rows[0]);
      if (!api.ifMatch(req, current)) {
        const error = new Error('Hit settings changed. Refresh them and try again.');
        error.code = 'ETAG_MISMATCH';
        error.statusCode = 412;
        throw error;
      }
      const now = Math.floor(Date.now() / 1000);
      await manager.query(
        `INSERT INTO user_hit_setting (user_id,hide_hit,update_time) VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE hide_hit=VALUES(hide_hit),update_time=VALUES(update_time)`,
        [user.id, hideHit ? 1 : 0, now]
      );
      const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
        action: 'profile:hit-settings.update', resourceType: 'user', resourceId: user.id,
        details: { hide_hit: hideHit }
      }, manager);
      const eventId = await contentDomain.appendEvent(manager, {
        stream: `user:${user.id}`, type: 'profile.hit-settings.updated', aggregateId: user.id,
        actorId: user.id, payload: { hide_hit: hideHit, audit_event_id: auditEventId }
      });
      return { resource: hitSettingResource({ hide_hit: hideHit, update_time: now }), auditEventId, eventId };
    });
    if (hideHit) syzoj.userHitHidden.add(user.id);
    else syzoj.userHitHidden.delete(user.id);
    return api.send(res, { ...saved.resource, audit_event_id: saved.auditEventId, event_id: saved.eventId });
  } catch (error) {
    if (error && error.code === 'ETAG_MISMATCH') return api.fail(res, 412, error.code, error.message);
    syzoj.log('[hit-setting-v2] ' + (error.stack || error));
    return api.fail(res, 500, 'CONTENT_WRITE_FAILED', 'Hit settings could not be updated.');
  }
});


// ============ Hit 值帮助页 ============
app.get('/help/hit-value', async (req, res) => {
  try {
    res.render('help_hit_value');
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});
