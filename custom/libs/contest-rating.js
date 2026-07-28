const TypeORM = require('typeorm');
const { calculateRatingChanges } = require('./rating');
const contestMutation = require('./contest-mutation');

const ALGORITHM_VERSION = 1;

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || ''); } catch (error) { return fallback; }
}

function adminIds(contest) {
  return new Set(String(contest.admins || '').split('|').map(Number).filter(Boolean).concat(Number(contest.holder_id)));
}

async function canonicalStandings(manager, contest) {
  const pending = await manager.query(
    `SELECT id FROM judge_state WHERE type=1 AND type_info=? AND submit_time>=? AND submit_time<?
     AND (pending=1 OR status IN ('Waiting','Unknown')) LIMIT 1 FOR UPDATE`,
    [contest.id, contest.start_time, contest.end_time]
  );
  if (pending.length) return { deferred: true, contestants: [] };

  const validSubmitters = await manager.query(
    `SELECT DISTINCT user_id FROM judge_state
     WHERE type=1 AND type_info=? AND submit_time>=? AND submit_time<? AND pending=0
       AND status NOT IN ('Waiting','Unknown','Cancelled')`,
    [contest.id, contest.start_time, contest.end_time]
  );
  const submitted = new Set(validSubmitters.map(row => Number(row.user_id)));
  const cheaters = await manager.query(
    `SELECT DISTINCT js.user_id FROM judge_state js
     INNER JOIN judge_state_admin_action action ON action.judge_id=js.id
     WHERE js.type=1 AND js.type_info=? AND action.action_type='cheated'`,
    [contest.id]
  );
  const cheated = new Set(cheaters.map(row => Number(row.user_id)));
  const excludedAdmins = adminIds(contest);
  const players = await manager.query(
    `SELECT cp.id,cp.user_id,cp.score_details,u.rating,u.is_admin
     FROM contest_player cp INNER JOIN user u ON u.id=cp.user_id
     LEFT JOIN contest_registration_removal removal
       ON removal.contest_id=cp.contest_id AND removal.user_id=cp.user_id
     WHERE cp.contest_id=? AND removal.user_id IS NULL ORDER BY cp.id ASC FOR UPDATE`,
    [contest.id]
  );
  const judgeIds = [];
  for (const player of players) {
    const details = parseJson(player.score_details, {});
    for (const detail of Object.values(details)) if (detail && detail.judge_id) judgeIds.push(Number(detail.judge_id));
  }
  const judgeTimes = new Map();
  if (judgeIds.length) {
    const rows = await manager.query('SELECT id,submit_time FROM judge_state WHERE id IN (?)', [Array.from(new Set(judgeIds))]);
    rows.forEach(row => judgeTimes.set(Number(row.id), Number(row.submit_time || 0)));
  }
  const ranklistRows = await manager.query('SELECT ranking_params FROM contest_ranklist WHERE id=? FOR UPDATE', [contest.ranklist_id]);
  const rankingParams = parseJson(ranklistRows[0] && ranklistRows[0].ranking_params, {});
  const standings = [];
  for (const player of players) {
    const userId = Number(player.user_id);
    if (!submitted.has(userId) || cheated.has(userId) || excludedAdmins.has(userId) || player.is_admin) continue;
    const details = parseJson(player.score_details, {});
    if (contest.type === 'noi' || contest.type === 'ioi') {
      let score = 0;
      let latest = 0;
      for (const [problemId, detail] of Object.entries(details)) {
        if (!detail) continue;
        score += Math.round(Number(detail.score || 0) * Number(rankingParams[problemId] || 1));
        latest = Math.max(latest, judgeTimes.get(Number(detail.judge_id)) || Number(detail.time || 0));
      }
      standings.push({ userId, currentRating: Number(player.rating || 1500), score, tie: latest });
    } else {
      let score = 0;
      let penalty = 0;
      for (const detail of Object.values(details)) {
        if (!detail || !detail.accepted) continue;
        score += 1;
        penalty += Number(detail.acceptedTime || 0) - Number(contest.start_time) +
          Number(detail.unacceptedCount || 0) * 20 * 60;
      }
      standings.push({ userId, currentRating: Number(player.rating || 1500), score, tie: penalty });
    }
  }
  standings.sort((left, right) => right.score - left.score || left.tie - right.tie || left.userId - right.userId);
  let rank = 0;
  let previous = null;
  standings.forEach((standing, index) => {
    const tieKey = contest.type === 'acm' ? `${standing.score}:${standing.tie}` : String(standing.score);
    if (tieKey !== previous) rank = index + 1;
    standing.rank = rank;
    previous = tieKey;
  });
  return { deferred: false, contestants: standings };
}

async function finalizeContestInTransaction(manager, contestId) {
    const contests = await manager.query('SELECT * FROM contest WHERE id=? FOR UPDATE', [contestId]);
    if (!contests.length) return { status: 'missing', userIds: [] };
    const contest = contests[0];
    const configs = await manager.query(
      'SELECT is_rated FROM contest_rating_config WHERE contest_id=? FOR UPDATE',
      [contestId]
    );
    if (!configs.length || !configs[0].is_rated) return { status: 'unrated', userIds: [] };
    const nowRows = await manager.query('SELECT UNIX_TIMESTAMP() AS now');
    const now = Number(nowRows[0].now);
    if (now < Number(contest.end_time)) return { status: 'not_ended', userIds: [] };
    const existing = await manager.query('SELECT status FROM contest_rating_finalization WHERE contest_id=? FOR UPDATE', [contestId]);
    if (existing.length) return { status: existing[0].status, userIds: [] };

    const standingResult = await canonicalStandings(manager, contest);
    if (standingResult.deferred) return { status: 'deferred', userIds: [] };
    const contestants = standingResult.contestants;
    if (contestants.length < 2) {
      await manager.query(
        `INSERT INTO contest_rating_finalization
          (contest_id,rating_calculation_id,status,participant_count,algorithm_version,completed_at,skip_reason)
         VALUES (?,NULL,'skipped',?,?,?,'fewer_than_two_eligible_participants')`,
        [contestId,contestants.length,ALGORITHM_VERSION,now]
      );
      return { status: 'skipped', userIds: [] };
    }
    const rated = calculateRatingChanges(contestants);
    const calculationResult = await manager.query('INSERT INTO rating_calculation (contest_id) VALUES (?)', [contestId]);
    const calculationId = Number(calculationResult.insertId);
    for (const contestant of rated) {
      await manager.query(
        'INSERT INTO rating_history (rating_calculation_id,user_id,rating_after,rank) VALUES (?,?,?,?)',
        [calculationId,contestant.userId,contestant.ratingAfter,contestant.rank]
      );
      await manager.query('UPDATE user SET rating=? WHERE id=?', [contestant.ratingAfter,contestant.userId]);
      const signedDelta = contestant.delta >= 0 ? `+${contestant.delta}` : String(contestant.delta);
      await manager.query(
        `INSERT INTO notification
          (recipient_id,type,title,content,source_url,source_id,actor_id,is_read,created_at,read_at)
         VALUES (?,'contest_rating',?,?,?, ?,NULL,0,?,NULL)`,
        [
          contestant.userId,
          `${contest.title} Rating 已更新`,
          `第 ${contestant.rank} / ${rated.length} 名，Rating ${contestant.currentRating} → ${contestant.ratingAfter}（${signedDelta}）`,
          `/contest/${contestId}/ranklist`,
          contestId,
          now
        ]
      );
    }
    await manager.query(
      `INSERT INTO contest_rating_finalization
        (contest_id,rating_calculation_id,status,participant_count,algorithm_version,completed_at,skip_reason)
       VALUES (?,?,'completed',?,?,?,NULL)`,
      [contestId,calculationId,rated.length,ALGORITHM_VERSION,now]
    );
    return { status: 'completed', userIds: rated.map(contestant => contestant.userId) };
}

function invalidateUserCache(userIds) {
  if (userIds.length) {
    const User = syzoj.model('user');
    userIds.forEach(userId => User.deleteFromCache(userId));
  }
}

async function finalizeContest(contestId) {
  const result = await contestMutation.withContestLock(contestId, () => contestMutation.withTransactionRetry(
    manager => finalizeContestInTransaction(manager, contestId)
  ));
  invalidateUserCache(result.userIds || []);
  return result;
}

async function recalculateRatingsFrom(contestId) {
  const releaseFinalizer = await contestMutation.acquireContestLock('rating-finalizer');
  const contestReleases = [];
  try {
    const targetRows = await TypeORM.getConnection().query(
      `SELECT contest.id,contest.end_time,config.is_rated
       FROM contest
       LEFT JOIN contest_rating_config config ON config.contest_id=contest.id
       WHERE contest.id=? LIMIT 1`,
      [contestId]
    );
    if (!targetRows.length) throw contestMutation.mutationError('无此比赛。', 404);
    const target = targetRows[0];
    if (!target.is_rated) throw contestMutation.mutationError('Unrated 比赛不能重新计算 Rating。', 409);

    const nowRows = await TypeORM.getConnection().query('SELECT UNIX_TIMESTAMP() AS now');
    const now = Number(nowRows[0].now);
    if (Number(target.end_time) > now) throw contestMutation.mutationError('比赛结束后才能重新计算 Rating。', 409);

    const affectedContests = await TypeORM.getConnection().query(
      `SELECT contest.id,contest.end_time
       FROM contest
       INNER JOIN contest_rating_config config ON config.contest_id=contest.id AND config.is_rated=1
       WHERE contest.end_time<=?
         AND (contest.end_time>? OR (contest.end_time=? AND contest.id>=?))
       ORDER BY contest.end_time ASC,contest.id ASC`,
      [now,target.end_time,target.end_time,contestId]
    );
    const affectedContestIds = affectedContests.map(contest => Number(contest.id));
    if (!affectedContestIds.length || affectedContestIds[0] !== Number(contestId)) {
      throw contestMutation.mutationError('比赛 Rating 配置已变化，请刷新后重试。', 409);
    }
    for (const affectedContestId of affectedContestIds) {
      contestReleases.push(await contestMutation.acquireContestLock(affectedContestId));
    }

    const result = await contestMutation.withTransactionRetry(async manager => {
      const lockedContests = await manager.query(
        `SELECT contest.id,contest.end_time
         FROM contest
         INNER JOIN contest_rating_config config ON config.contest_id=contest.id AND config.is_rated=1
         WHERE contest.id IN (?) ORDER BY contest.end_time ASC,contest.id ASC FOR UPDATE`,
        [affectedContestIds]
      );
      if (lockedContests.length !== affectedContestIds.length ||
          lockedContests.some((contest, index) => Number(contest.id) !== affectedContestIds[index])) {
        throw contestMutation.mutationError('比赛 Rating 配置已变化，请刷新后重试。', 409);
      }

      const calculationRows = await manager.query(
        'SELECT id,contest_id FROM rating_calculation WHERE contest_id IN (?) ORDER BY id ASC FOR UPDATE',
        [affectedContestIds]
      );
      const affectedCalculationIds = new Set(calculationRows.map(row => Number(row.id)));
      const affectedUserIds = new Set();
      const baselines = new Map();
      let calculationBoundary = null;
      if (calculationRows.length) {
        calculationBoundary = Number(calculationRows[0].id);
        const laterCalculations = await manager.query(
          'SELECT id,contest_id FROM rating_calculation WHERE id>=? ORDER BY id ASC FOR UPDATE',
          [calculationBoundary]
        );
        if (laterCalculations.some(row => !affectedCalculationIds.has(Number(row.id)))) {
          throw contestMutation.mutationError(
            '后续存在无法关联到当前比赛序列的 Rating 历史，不能安全地级联重算。',
            409
          );
        }
        const userRows = await manager.query(
          'SELECT DISTINCT user_id FROM rating_history WHERE rating_calculation_id>=? FOR UPDATE',
          [calculationBoundary]
        );
        userRows.forEach(row => affectedUserIds.add(Number(row.user_id)));
        if (affectedUserIds.size) {
          const baselineRows = await manager.query(
            `SELECT history.user_id,history.rating_after
             FROM rating_history history
             INNER JOIN (
               SELECT user_id,MAX(rating_calculation_id) AS calculation_id
               FROM rating_history
               WHERE user_id IN (?) AND rating_calculation_id<?
               GROUP BY user_id
             ) latest ON latest.user_id=history.user_id
               AND latest.calculation_id=history.rating_calculation_id`,
            [Array.from(affectedUserIds),calculationBoundary]
          );
          baselineRows.forEach(row => baselines.set(Number(row.user_id), Number(row.rating_after)));
        }
      }

      await manager.query(
        "DELETE FROM notification WHERE type='contest_rating' AND source_id IN (?)",
        [affectedContestIds]
      );
      await manager.query('DELETE FROM contest_rating_finalization WHERE contest_id IN (?)', [affectedContestIds]);
      if (calculationBoundary !== null) {
        await manager.query('DELETE FROM rating_history WHERE rating_calculation_id>=?', [calculationBoundary]);
        await manager.query('DELETE FROM rating_calculation WHERE id>=?', [calculationBoundary]);
        const defaultRating = Number(syzoj.config.default.user.rating || 1500);
        for (const userId of affectedUserIds) {
          await manager.query('UPDATE user SET rating=? WHERE id=?', [baselines.get(userId) || defaultRating,userId]);
        }
      }

      const summaries = [];
      for (const affectedContestId of affectedContestIds) {
        const summary = await finalizeContestInTransaction(manager, affectedContestId);
        if (summary.status === 'deferred') {
          throw contestMutation.mutationError(
            `比赛 #${affectedContestId} 仍有等待评测的提交，Rating 未重新计算。`,
            409
          );
        }
        if (!['completed', 'skipped'].includes(summary.status)) {
          throw contestMutation.mutationError(`比赛 #${affectedContestId} 无法重新计算 Rating。`, 409);
        }
        summary.userIds.forEach(userId => affectedUserIds.add(Number(userId)));
        summaries.push({ contestId: affectedContestId, status: summary.status });
      }
      return {
        contestCount: summaries.length,
        completedCount: summaries.filter(summary => summary.status === 'completed').length,
        skippedCount: summaries.filter(summary => summary.status === 'skipped').length,
        userIds: Array.from(affectedUserIds)
      };
    });
    invalidateUserCache(result.userIds);
    return result;
  } finally {
    while (contestReleases.length) await contestReleases.pop()();
    await releaseFinalizer();
  }
}

async function deleteContestAndRecalculate(contestId) {
  const releaseFinalizer = await contestMutation.acquireContestLock('rating-finalizer');
  const contestReleases = [];
  try {
    const targetRows = await TypeORM.getConnection().query(
      `SELECT contest.id,contest.end_time,COALESCE(config.is_rated,0) AS is_rated
       FROM contest
       LEFT JOIN contest_rating_config config ON config.contest_id=contest.id
       WHERE contest.id=? LIMIT 1`,
      [contestId]
    );
    if (!targetRows.length) throw contestMutation.mutationError('无此比赛。', 404);
    const target = targetRows[0];
    const nowRows = await TypeORM.getConnection().query('SELECT UNIX_TIMESTAMP() AS now');
    const now = Number(nowRows[0].now);
    const affectedContests = Number(target.is_rated) !== 1 ? [] : await TypeORM.getConnection().query(
      `SELECT contest.id,contest.end_time
       FROM contest
       INNER JOIN contest_rating_config config ON config.contest_id=contest.id AND config.is_rated=1
       WHERE contest.end_time<=?
         AND (contest.end_time>? OR (contest.end_time=? AND contest.id>=?))
       ORDER BY contest.end_time ASC,contest.id ASC`,
      [now,target.end_time,target.end_time,contestId]
    );
    const affectedContestIds = affectedContests.map(contest => Number(contest.id));
    const lockIds = Array.from(new Set([Number(contestId), ...affectedContestIds])).sort((a, b) => a - b);
    for (const lockId of lockIds) contestReleases.push(await contestMutation.acquireContestLock(lockId));

    const result = await contestMutation.withTransactionRetry(async manager => {
      const lockedTargetRows = await manager.query('SELECT id,end_time FROM contest WHERE id=? FOR UPDATE', [contestId]);
      if (!lockedTargetRows.length || Number(lockedTargetRows[0].end_time) !== Number(target.end_time)) {
        throw contestMutation.mutationError('比赛已被修改，请刷新后重试。', 409);
      }
      if (affectedContestIds.length) {
        const lockedContests = await manager.query(
          `SELECT contest.id,contest.end_time
           FROM contest
           INNER JOIN contest_rating_config config ON config.contest_id=contest.id AND config.is_rated=1
           WHERE contest.id IN (?) ORDER BY contest.end_time ASC,contest.id ASC FOR UPDATE`,
          [affectedContestIds]
        );
        if (lockedContests.length !== affectedContestIds.length ||
            lockedContests.some((contest, index) => Number(contest.id) !== affectedContestIds[index])) {
          throw contestMutation.mutationError('比赛 Rating 配置已变化，请刷新后重试。', 409);
        }
      }

      const calculationRows = affectedContestIds.length ? await manager.query(
        'SELECT id,contest_id FROM rating_calculation WHERE contest_id IN (?) ORDER BY id ASC FOR UPDATE',
        [affectedContestIds]
      ) : [];
      const affectedCalculationIds = new Set(calculationRows.map(row => Number(row.id)));
      const affectedUserIds = new Set();
      const baselines = new Map();
      let calculationBoundary = null;
      if (calculationRows.length) {
        calculationBoundary = Number(calculationRows[0].id);
        const laterCalculations = await manager.query(
          'SELECT id,contest_id FROM rating_calculation WHERE id>=? ORDER BY id ASC FOR UPDATE',
          [calculationBoundary]
        );
        if (laterCalculations.some(row => !affectedCalculationIds.has(Number(row.id)))) {
          throw contestMutation.mutationError(
            '后续存在无法关联到当前比赛序列的 Rating 历史，不能安全地级联重算。',
            409
          );
        }
        const userRows = await manager.query(
          'SELECT DISTINCT user_id FROM rating_history WHERE rating_calculation_id>=? FOR UPDATE',
          [calculationBoundary]
        );
        userRows.forEach(row => affectedUserIds.add(Number(row.user_id)));
        if (affectedUserIds.size) {
          const baselineRows = await manager.query(
            `SELECT history.user_id,history.rating_after
             FROM rating_history history
             INNER JOIN (
               SELECT user_id,MAX(rating_calculation_id) AS calculation_id
               FROM rating_history
               WHERE user_id IN (?) AND rating_calculation_id<?
               GROUP BY user_id
             ) latest ON latest.user_id=history.user_id
               AND latest.calculation_id=history.rating_calculation_id`,
            [Array.from(affectedUserIds),calculationBoundary]
          );
          baselineRows.forEach(row => baselines.set(Number(row.user_id), Number(row.rating_after)));
        }
      }

      if (affectedContestIds.length) {
        await manager.query("DELETE FROM notification WHERE type='contest_rating' AND source_id IN (?)", [affectedContestIds]);
        await manager.query('DELETE FROM contest_rating_finalization WHERE contest_id IN (?)', [affectedContestIds]);
      }
      if (calculationBoundary !== null) {
        await manager.query('DELETE FROM rating_history WHERE rating_calculation_id>=?', [calculationBoundary]);
        await manager.query('DELETE FROM rating_calculation WHERE id>=?', [calculationBoundary]);
        const defaultRating = Number(syzoj.config.default.user.rating || 1500);
        for (const userId of affectedUserIds) {
          await manager.query('UPDATE user SET rating=? WHERE id=?', [baselines.get(userId) || defaultRating,userId]);
        }
      }

      await contestMutation.deleteContestInTransaction(manager, contestId, {
        allowStarted: true,
        allowFinalized: true,
        deleteSubmissions: true
      });

      const summaries = [];
      for (const affectedContestId of affectedContestIds) {
        if (affectedContestId === Number(contestId)) continue;
        const summary = await finalizeContestInTransaction(manager, affectedContestId);
        if (summary.status === 'deferred') {
          throw contestMutation.mutationError(
            `后续比赛 #${affectedContestId} 仍有等待评测的提交，不能安全删除并重算 Rating。`,
            409
          );
        }
        if (!['completed', 'skipped'].includes(summary.status)) {
          throw contestMutation.mutationError(`后续比赛 #${affectedContestId} 无法重新计算 Rating。`, 409);
        }
        summary.userIds.forEach(userId => affectedUserIds.add(Number(userId)));
        summaries.push({ contestId: affectedContestId, status: summary.status });
      }
      return {
        contestCount: summaries.length,
        userIds: Array.from(affectedUserIds)
      };
    });
    invalidateUserCache(result.userIds);
    return result;
  } finally {
    while (contestReleases.length) await contestReleases.pop()();
    await releaseFinalizer();
  }
}

module.exports = {
  ALGORITHM_VERSION,
  canonicalStandings,
  deleteContestAndRecalculate,
  finalizeContest,
  finalizeContestInTransaction,
  recalculateRatingsFrom
};
