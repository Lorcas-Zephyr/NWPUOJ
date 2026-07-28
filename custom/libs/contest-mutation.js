const TypeORM = require('typeorm');

const RETRYABLE_ERRORS = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', '1213', '1205']);
const ranklistRefreshTimers = new Map();

function mutationError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode || 400;
  return error;
}

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value || '');
  } catch (error) {
    return fallback;
  }
}

function sameJson(left, right) {
  return JSON.stringify(parseJson(left, {})) === JSON.stringify(parseJson(right, {}));
}

async function withTransactionRetry(work) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await TypeORM.getConnection().transaction('READ COMMITTED', work);
    } catch (error) {
      const code = String(error.code || error.errno || '');
      if (!RETRYABLE_ERRORS.has(code) || attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

function contestLockName(contestId) {
  return `nwpuoj:contest:${contestId || 'create'}`;
}

async function acquireContestLock(contestId) {
  const runner = TypeORM.getConnection().createQueryRunner();
  await runner.connect();
  const name = contestLockName(contestId);
  try {
    const rows = await runner.query('SELECT GET_LOCK(?, 10) AS acquired', [name]);
    if (!rows.length || Number(rows[0].acquired) !== 1) {
      throw mutationError('比赛操作繁忙，请稍后重试。', 503);
    }
  } catch (error) {
    await runner.release();
    throw error;
  }
  let released = false;
  return async function releaseContestLock() {
    if (released) return;
    released = true;
    try {
      await runner.query('SELECT RELEASE_LOCK(?)', [name]);
    } finally {
      await runner.release();
    }
  };
}

async function withContestLock(contestId, work) {
  const release = await acquireContestLock(contestId);
  try {
    return await work();
  } finally {
    await release();
  }
}

async function lockContestAndSetting(manager, contestId) {
  const contests = await manager.query('SELECT * FROM contest WHERE id = ? FOR UPDATE', [contestId]);
  if (!contests.length) throw mutationError('无此比赛。', 404);
  await manager.query(
    `INSERT INTO contest_registration_setting
      (contest_id,allow_late_registration,revision,updated_at)
     VALUES (?,0,0,?) ON DUPLICATE KEY UPDATE contest_id=VALUES(contest_id)`,
    [contestId, Math.floor(Date.now() / 1000)]
  );
  const settings = await manager.query(
    'SELECT allow_late_registration,revision FROM contest_registration_setting WHERE contest_id = ? FOR UPDATE',
    [contestId]
  );
  return { contest: contests[0], setting: settings[0] };
}

async function lockRanklist(manager, ranklistId) {
  const rows = await manager.query('SELECT id,ranking_params,ranklist FROM contest_ranklist WHERE id = ? FOR UPDATE', [ranklistId]);
  if (!rows.length) throw mutationError('比赛排行榜不存在。', 500);
  return rows[0];
}

async function rebuildRanklistMembership(manager, contest, ranklistRow) {
  const players = await manager.query(
    'SELECT id FROM contest_player WHERE contest_id = ? ORDER BY id ASC FOR UPDATE',
    [contest.id]
  );
  const validIds = new Set(players.map(player => Number(player.id)));
  const current = parseJson(ranklistRow.ranklist, { player_num: 0 });
  const orderedIds = [];
  for (let index = 1; index <= Number(current.player_num || 0); index++) {
    const playerId = Number(current[index]);
    if (validIds.delete(playerId)) orderedIds.push(playerId);
  }
  orderedIds.push(...Array.from(validIds));
  const next = { player_num: orderedIds.length };
  orderedIds.forEach((playerId, index) => { next[index + 1] = playerId; });
  await manager.query('UPDATE contest_ranklist SET ranklist = ? WHERE id = ?', [JSON.stringify(next), ranklistRow.id]);
  return next;
}

async function rebuildScoredRanklist(manager, contest, ranklistRow) {
  const players = await manager.query(
    'SELECT id,score,score_details FROM contest_player WHERE contest_id=? ORDER BY id ASC FOR UPDATE',
    [contest.id]
  );
  const rankingParams = parseJson(ranklistRow.ranking_params, {});
  const judgeIds = [];
  for (const player of players) {
    const details = parseJson(player.score_details, {});
    for (const detail of Object.values(details)) {
      if (detail && detail.judge_id) judgeIds.push(Number(detail.judge_id));
    }
  }
  const judgeTimes = new Map();
  if (judgeIds.length) {
    const rows = await manager.query('SELECT id,submit_time FROM judge_state WHERE id IN (?)', [Array.from(new Set(judgeIds))]);
    rows.forEach(row => judgeTimes.set(Number(row.id), Number(row.submit_time || 0)));
  }
  const ranked = players.map(player => {
    const details = parseJson(player.score_details, {});
    if (contest.type === 'noi' || contest.type === 'ioi') {
      let score = 0;
      let latest = 0;
      for (const [problemId, detail] of Object.entries(details)) {
        if (!detail) continue;
        score += Math.round(Number(detail.score || 0) * Number(rankingParams[problemId] || 1));
        latest = Math.max(latest, judgeTimes.get(Number(detail.judge_id)) || Number(detail.time || 0));
      }
      return { id: Number(player.id), score, tie: latest };
    }
    let accepted = 0;
    let penalty = 0;
    for (const detail of Object.values(details)) {
      if (!detail || !detail.accepted) continue;
      accepted += 1;
      penalty += Number(detail.acceptedTime || 0) - Number(contest.start_time) +
        Number(detail.unacceptedCount || 0) * 20 * 60;
    }
    return { id: Number(player.id), score: accepted, tie: penalty };
  });
  ranked.sort((left, right) => right.score - left.score || left.tie - right.tie || left.id - right.id);
  const next = { player_num: ranked.length };
  ranked.forEach((player, index) => { next[index + 1] = player.id; });
  await manager.query('UPDATE contest_ranklist SET ranklist=? WHERE id=?', [JSON.stringify(next), ranklistRow.id]);
}

function updateScoreDetails(contest, player, judgeState) {
  const details = parseJson(player.score_details, {});
  const problemId = String(judgeState.problem_id);
  const judgeId = Number(judgeState.id);
  const submitTime = Number(judgeState.submit_time || 0);
  if (contest.type === 'ioi') {
    if (judgeState.pending) return null;
    const detail = details[problemId] || { score: Number(judgeState.score || 0), judge_id: judgeId, submissions: {} };
    detail.submissions = detail.submissions || {};
    detail.submissions[judgeId] = { judge_id: judgeId, score: Number(judgeState.score || 0), time: submitTime };
    const submissions = Object.values(detail.submissions).sort((left, right) => left.time - right.time || left.judge_id - right.judge_id);
    let best = null;
    for (const submission of submissions) {
      if (!best || (submission.score >= best.score && best.score < 100)) best = submission;
    }
    detail.judge_id = best.judge_id;
    detail.score = best.score;
    detail.time = best.time;
    details[problemId] = detail;
  } else if (contest.type === 'noi') {
    if (judgeState.pending) return null;
    if (details[problemId] && Number(details[problemId].judge_id) > judgeId) return null;
    details[problemId] = { score: Number(judgeState.score || 0), judge_id: judgeId };
  } else {
    if (judgeState.pending) return null;
    const detail = details[problemId] || {
      accepted: false,
      unacceptedCount: 0,
      acceptedTime: 0,
      judge_id: 0,
      submissions: {}
    };
    detail.submissions = detail.submissions || {};
    detail.submissions[judgeId] = {
      judge_id: judgeId,
      accepted: judgeState.status === 'Accepted',
      compiled: judgeState.score != null,
      time: submitTime
    };
    const submissions = Object.values(detail.submissions).sort((left, right) => left.time - right.time || left.judge_id - right.judge_id);
    detail.unacceptedCount = 0;
    detail.judge_id = 0;
    detail.accepted = false;
    detail.acceptedTime = 0;
    for (const submission of submissions) {
      if (submission.accepted) {
        detail.accepted = true;
        detail.acceptedTime = submission.time;
        detail.judge_id = submission.judge_id;
        break;
      }
      if (submission.compiled) detail.unacceptedCount += 1;
    }
    if (!detail.accepted && submissions.length) detail.judge_id = submissions[submissions.length - 1].judge_id;
    details[problemId] = detail;
  }
  let score = 0;
  for (const detail of Object.values(details)) {
    if (contest.type === 'acm') score += detail && detail.accepted ? 1 : 0;
    else score += Number(detail && detail.score || 0);
  }
  return { details, score };
}

async function applyContestSubmission(contestId, judgeState) {
  const updated = await withTransactionRetry(async manager => {
    const contests = await manager.query('SELECT * FROM contest WHERE id=? FOR UPDATE', [contestId]);
    if (!contests.length) return false;
    const finalized = await manager.query(
      "SELECT contest_id FROM contest_rating_finalization WHERE contest_id=? AND status='completed' LIMIT 1",
      [contestId]
    );
    if (finalized.length) return false;
    const contest = contests[0];
    if (Number(judgeState.submit_time) < Number(contest.start_time) ||
        Number(judgeState.submit_time) >= Number(contest.end_time)) return false;
    const players = await manager.query(
      'SELECT id,score,score_details FROM contest_player WHERE contest_id=? AND user_id=? FOR UPDATE',
      [contestId, judgeState.user_id]
    );
    if (!players.length) return false;
    const next = updateScoreDetails(contest, players[0], judgeState);
    if (next) {
      await manager.query(
        'UPDATE contest_player SET score=?,score_details=? WHERE id=?',
        [next.score, JSON.stringify(next.details), players[0].id]
      );
    }
    return true;
  });
  if (updated) {
    if (syzoj.utils.invalidateContestReadCache) syzoj.utils.invalidateContestReadCache(contestId);
    scheduleRanklistRefresh(contestId);
  }
  return updated;
}

function scheduleRanklistRefresh(contestId) {
  const id = Number(contestId);
  const current = ranklistRefreshTimers.get(id);
  if (current) clearTimeout(current);
  const timer = setTimeout(async () => {
    ranklistRefreshTimers.delete(id);
    try {
      await withContestLock(id, () => withTransactionRetry(async manager => {
        const contests = await manager.query('SELECT * FROM contest WHERE id=? FOR UPDATE', [id]);
        if (!contests.length) return;
        const ranklist = await lockRanklist(manager, contests[0].ranklist_id);
        await rebuildScoredRanklist(manager, contests[0], ranklist);
      }));
      if (syzoj.utils.invalidateContestReadCache) syzoj.utils.invalidateContestReadCache(id);
    } catch (error) {
      syzoj.log('[contest-ranklist-refresh] ' + (error.stack || error));
    }
  }, 5000);
  if (timer.unref) timer.unref();
  ranklistRefreshTimers.set(id, timer);
}

async function rebuildContestPlayer(contestId, userId, options) {
  const rebuild = () => withTransactionRetry(async manager => {
    const contests = await manager.query('SELECT * FROM contest WHERE id=? FOR UPDATE', [contestId]);
    if (!contests.length) return false;
    const finalized = await manager.query(
      "SELECT contest_id FROM contest_rating_finalization WHERE contest_id=? AND status='completed' LIMIT 1",
      [contestId]
    );
    if (finalized.length) return false;
    const contest = contests[0];
    const ranklist = await lockRanklist(manager, contest.ranklist_id);
    const players = await manager.query(
      'SELECT id FROM contest_player WHERE contest_id=? AND user_id=? FOR UPDATE',
      [contestId, userId]
    );
    if (!players.length) return false;
    const submissions = await manager.query(
      `SELECT js.* FROM judge_state js
       LEFT JOIN judge_state_admin_action action ON action.judge_id=js.id
       WHERE js.type=1 AND js.type_info=? AND js.user_id=?
         AND js.submit_time>=? AND js.submit_time<? AND action.judge_id IS NULL
       ORDER BY js.submit_time ASC,js.id ASC`,
      [contestId, userId, contest.start_time, contest.end_time]
    );
    let player = { score: 0, score_details: '{}' };
    for (const submission of submissions) {
      const next = updateScoreDetails(contest, player, submission);
      if (next) player = { score: next.score, score_details: JSON.stringify(next.details) };
    }
    await manager.query(
      'UPDATE contest_player SET score=?,score_details=? WHERE id=?',
      [player.score, player.score_details, players[0].id]
    );
    await rebuildScoredRanklist(manager, contest, ranklist);
    return true;
  });
  if (options && options.skipLock) return rebuild();
  return withContestLock(contestId, rebuild);
}

async function rebuildContestStandings(contestId) {
  return withContestLock(contestId, async () => {
    const userIds = await withTransactionRetry(async manager => {
      const contests = await manager.query('SELECT * FROM contest WHERE id=? FOR UPDATE', [contestId]);
      if (!contests.length) throw mutationError('无此比赛。');
      const finalized = await manager.query(
        "SELECT contest_id FROM contest_rating_finalization WHERE contest_id=? AND status='completed' LIMIT 1",
        [contestId]
      );
      if (finalized.length) throw mutationError('比赛 Rating 已结算，不能重建排行榜。', 409);
      const contest = contests[0];
      const ranklist = await lockRanklist(manager, contest.ranklist_id);
      const submitters = await manager.query(
        `SELECT DISTINCT js.user_id FROM judge_state js
         LEFT JOIN contest_registration_removal removal
           ON removal.contest_id=? AND removal.user_id=js.user_id
         LEFT JOIN judge_state_admin_action action ON action.judge_id=js.id
         WHERE js.type=1 AND js.type_info=? AND js.submit_time>=? AND js.submit_time<?
           AND removal.user_id IS NULL AND action.judge_id IS NULL`,
        [contestId, contestId, contest.start_time, contest.end_time]
      );
      for (const submitter of submitters) {
        await manager.query(
          `INSERT INTO contest_player (contest_id,user_id,score,score_details,time_spent)
           VALUES (?,?,0,'{}',0) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id)`,
          [contestId, Number(submitter.user_id)]
        );
      }
      const players = await manager.query(
        'SELECT user_id FROM contest_player WHERE contest_id=? ORDER BY id ASC FOR UPDATE',
        [contestId]
      );
      await rebuildRanklistMembership(manager, contest, ranklist);
      return players.map(player => Number(player.user_id));
    });
    for (const userId of userIds) await rebuildContestPlayer(contestId, userId, { skipLock: true });
    return userIds.length;
  });
}

async function databaseNow(manager) {
  const rows = await manager.query('SELECT UNIX_TIMESTAMP() AS now');
  return Number(rows[0].now);
}

async function registerUser(contestId, userId) {
  return withContestLock(contestId, () => withTransactionRetry(async manager => {
    const context = await lockContestAndSetting(manager, contestId);
    const now = await databaseNow(manager);
    if (now >= Number(context.contest.end_time)) throw mutationError('比赛已结束，不能报名。');
    if (now >= Number(context.contest.start_time) && !context.setting.allow_late_registration) {
      throw mutationError('该比赛不允许开赛后报名。');
    }
    const removals = await manager.query(
      'SELECT user_id FROM contest_registration_removal WHERE contest_id=? AND user_id=? FOR UPDATE',
      [contestId, userId]
    );
    if (removals.length) throw mutationError('您已被比赛管理员移出报名名单。', 403);
    const ranklist = await lockRanklist(manager, context.contest.ranklist_id);
    await manager.query(
      `INSERT INTO contest_player (contest_id,user_id,score,score_details,time_spent)
       VALUES (?,?,0,'{}',0) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id)`,
      [contestId, userId]
    );
    const players = await manager.query(
      'SELECT id FROM contest_player WHERE contest_id=? AND user_id=? FOR UPDATE',
      [contestId, userId]
    );
    await rebuildRanklistMembership(manager, context.contest, ranklist);
    return Number(players[0].id);
  }));
}

async function unregisterUser(contestId, userId) {
  return withContestLock(contestId, () => withTransactionRetry(async manager => {
    const context = await lockContestAndSetting(manager, contestId);
    const now = await databaseNow(manager);
    if (now >= Number(context.contest.start_time)) throw mutationError('比赛开始后不能取消报名。');
    const ranklist = await lockRanklist(manager, context.contest.ranklist_id);
    const players = await manager.query(
      'SELECT id FROM contest_player WHERE contest_id=? AND user_id=? FOR UPDATE',
      [contestId, userId]
    );
    if (!players.length) return false;
    const submissions = await manager.query(
      'SELECT id FROM judge_state WHERE type=1 AND type_info=? AND user_id=? LIMIT 1 FOR UPDATE',
      [contestId, userId]
    );
    if (submissions.length) throw mutationError('已有比赛提交，不能取消报名。');
    await manager.query('DELETE FROM contest_player WHERE id=?', [players[0].id]);
    await rebuildRanklistMembership(manager, context.contest, ranklist);
    return true;
  }));
}

async function removeUser(contestId, userId, removedBy) {
  return withContestLock(contestId, () => withTransactionRetry(async manager => {
    const context = await lockContestAndSetting(manager, contestId);
    const now = await databaseNow(manager);
    if (now >= Number(context.contest.end_time)) throw mutationError('比赛结束后不能移除报名用户。', 409);
    const finalized = await manager.query(
      "SELECT contest_id FROM contest_rating_finalization WHERE contest_id=? AND status='completed' LIMIT 1",
      [contestId]
    );
    if (finalized.length) throw mutationError('比赛 Rating 已结算，不能再移除报名用户。', 409);
    await manager.query(
      `INSERT INTO contest_registration_removal (contest_id,user_id,removed_at,removed_by)
       VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE removed_at=VALUES(removed_at),removed_by=VALUES(removed_by)`,
       [contestId, userId, now, removedBy]
    );
    const ranklist = await lockRanklist(manager, context.contest.ranklist_id);
    await manager.query('DELETE FROM contest_player WHERE contest_id=? AND user_id=?', [contestId, userId]);
    await rebuildRanklistMembership(manager, context.contest, ranklist);
  }));
}

async function restoreUser(contestId, userId) {
  return withContestLock(contestId, async () => {
    const restored = await withTransactionRetry(async manager => {
      const context = await lockContestAndSetting(manager, contestId);
      const now = await databaseNow(manager);
      if (now >= Number(context.contest.end_time)) throw mutationError('比赛结束后不能恢复报名用户。', 409);
      const removals = await manager.query(
        'SELECT user_id FROM contest_registration_removal WHERE contest_id=? AND user_id=? FOR UPDATE',
        [contestId, userId]
      );
      if (!removals.length) return false;
      const ranklist = await lockRanklist(manager, context.contest.ranklist_id);
      await manager.query('DELETE FROM contest_registration_removal WHERE contest_id=? AND user_id=?', [contestId, userId]);
      await manager.query(
        `INSERT INTO contest_player (contest_id,user_id,score,score_details,time_spent)
         VALUES (?,?,0,'{}',0) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id)`,
        [contestId, userId]
      );
      await rebuildRanklistMembership(manager, context.contest, ranklist);
      return true;
    });
    if (restored) await rebuildContestPlayer(contestId, userId, { skipLock: true });
    return restored;
  });
}

async function saveContest(input) {
  return withContestLock(input.id, () => withTransactionRetry(async manager => {
    const now = await databaseNow(manager);
    if (!input.id) {
      const ranklistResult = await manager.query(
        "INSERT INTO contest_ranklist (ranking_params,ranklist) VALUES (?,?)",
        [JSON.stringify(input.rankingParams), JSON.stringify({ player_num: 0 })]
      );
      const contestResult = await manager.query(
        `INSERT INTO contest
          (title,subtitle,start_time,end_time,holder_id,type,information,problems,admins,ranklist_id,is_public,hide_statistics)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [input.title,input.subtitle,input.startTime,input.endTime,input.actorId,input.type,input.information,
          input.problems,input.admins,Number(ranklistResult.insertId),input.isPublic ? 1 : 0,input.hideStatistics ? 1 : 0]
      );
      const contestId = Number(contestResult.insertId);
      await manager.query(
        `INSERT INTO contest_rating_config (contest_id,is_rated,updated_at,updated_by)
         VALUES (?,?,?,?)`,
        [contestId,input.isRated ? 1 : 0,now,input.actorId]
      );
      await manager.query(
        `INSERT INTO contest_registration_setting
          (contest_id,allow_late_registration,revision,updated_at) VALUES (?,?,1,?)`,
        [contestId,input.allowLateRegistration ? 1 : 0,now]
      );
      return contestId;
    }

    const context = await lockContestAndSetting(manager, input.id);
    const ranklist = await lockRanklist(manager, context.contest.ranklist_id);
    await manager.query(
      `INSERT IGNORE INTO contest_rating_config (contest_id,is_rated,updated_at,updated_by)
       VALUES (?,0,?,NULL)`,
      [input.id,now]
    );
    const ratingConfigs = await manager.query(
      'SELECT is_rated FROM contest_rating_config WHERE contest_id=? FOR UPDATE',
      [input.id]
    );
    const currentRated = !!ratingConfigs[0].is_rated;
    const nextRated = !!input.isRated;
    if (Number(context.setting.revision) !== Number(input.revision)) {
      throw mutationError('比赛已被其他管理员修改，请刷新后重试。', 409);
    }
    if (now >= Number(context.contest.start_time)) {
      if (currentRated !== nextRated) throw mutationError('比赛开始后不能修改 Rated 状态。', 409);
      const criticalChanged = input.startTime !== Number(context.contest.start_time) ||
        input.endTime !== Number(context.contest.end_time) || input.problems !== String(context.contest.problems || '') ||
        !sameJson(ranklist.ranking_params, input.rankingParams);
      if (criticalChanged) throw mutationError('比赛开始后不能修改题目、时间或排行参数。', 409);
    } else {
      await manager.query('UPDATE contest_ranklist SET ranking_params=? WHERE id=?', [JSON.stringify(input.rankingParams), ranklist.id]);
    }
    await manager.query(
      `UPDATE contest SET title=?,subtitle=?,start_time=?,end_time=?,information=?,problems=?,admins=?,
        is_public=?,hide_statistics=? WHERE id=?`,
      [input.title,input.subtitle,input.startTime,input.endTime,input.information,input.problems,input.admins,
        input.isPublic ? 1 : 0,input.hideStatistics ? 1 : 0,input.id]
    );
    await manager.query(
      `UPDATE contest_registration_setting SET allow_late_registration=?,revision=revision+1,updated_at=?
       WHERE contest_id=?`,
      [input.allowLateRegistration ? 1 : 0,now,input.id]
    );
    await manager.query(
      'UPDATE contest_rating_config SET is_rated=?,updated_at=?,updated_by=? WHERE contest_id=?',
      [nextRated ? 1 : 0,now,input.actorId,input.id]
    );
    return input.id;
  }));
}

async function deleteContestInTransaction(manager, contestId, options) {
    options = options || {};
    const context = await lockContestAndSetting(manager, contestId);
    const now = await databaseNow(manager);
    if (!options.allowStarted && now >= Number(context.contest.start_time)) {
      throw mutationError('比赛开始后不能删除，以免产生孤立提交和排行榜记录。', 409);
    }
    const submissions = await manager.query(
      'SELECT id FROM judge_state WHERE type=1 AND type_info=? LIMIT 1 FOR UPDATE',
      [contestId]
    );
    if (!options.deleteSubmissions && submissions.length) {
      throw mutationError('已有比赛提交，不能删除该比赛。', 409);
    }
    if (options.deleteSubmissions) {
      const pendingSubmissions = await manager.query(
        `SELECT id FROM judge_state
         WHERE type=1 AND type_info=? AND (pending=1 OR status IN ('Waiting','Unknown'))
         LIMIT 1 FOR UPDATE`,
        [contestId]
      );
      if (pendingSubmissions.length) {
        throw mutationError('比赛仍有等待评测的提交，请等待评测完成后再删除。', 409);
      }
    }
    const finalized = await manager.query(
      "SELECT contest_id FROM contest_rating_finalization WHERE contest_id=? AND status='completed' LIMIT 1",
      [contestId]
    );
    if (!options.allowFinalized && finalized.length) {
      throw mutationError('比赛 Rating 已结算，不能删除该比赛。', 409);
    }
    await lockRanklist(manager, context.contest.ranklist_id);
    await manager.query('SELECT id FROM contest_player WHERE contest_id=? FOR UPDATE', [contestId]);
    if (options.deleteSubmissions && submissions.length) {
      await manager.query(
        `DELETE action FROM judge_state_admin_action action
         INNER JOIN judge_state state ON state.id=action.judge_id
         WHERE state.type=1 AND state.type_info=?`,
        [contestId]
      );
      await manager.query('DELETE FROM judge_state WHERE type=1 AND type_info=?', [contestId]);
    }
    await manager.query("DELETE FROM notification WHERE type='contest_rating' AND source_id=?", [contestId]);
    await manager.query('DELETE FROM contest_rating_finalization WHERE contest_id=?', [contestId]);
    await manager.query('DELETE FROM contest_registration_removal WHERE contest_id=?', [contestId]);
    await manager.query('DELETE FROM contest_registration_setting WHERE contest_id=?', [contestId]);
    await manager.query('DELETE FROM contest_rating_config WHERE contest_id=?', [contestId]);
    await manager.query('DELETE FROM contest_player WHERE contest_id=?', [contestId]);
    await manager.query('DELETE FROM contest WHERE id=?', [contestId]);
    await manager.query('DELETE FROM contest_ranklist WHERE id=?', [context.contest.ranklist_id]);
    return context.contest;
}

async function deleteContest(contestId) {
  return withContestLock(contestId, () => withTransactionRetry(async manager => {
    return deleteContestInTransaction(manager, contestId);
  }));
}

module.exports = {
  acquireContestLock,
  applyContestSubmission,
  rebuildContestPlayer,
  rebuildContestStandings,
  deleteContest,
  deleteContestInTransaction,
  mutationError,
  registerUser,
  removeUser,
  restoreUser,
  saveContest,
  unregisterUser,
  withTransactionRetry,
  withContestLock
};
