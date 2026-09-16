'use strict';

function normalizeFreezeAfterMinutes(value, startTime, endTime) {
  if (value == null || value === '') return null;
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) ||
      Number(value) * 60 >= Number(endTime) - Number(startTime)) {
    throw Object.assign(new Error('封榜时间必须是非负整数分钟，且早于比赛结束时间。'), {
      code: 'CONTEST_FREEZE_INVALID', statusCode: 422
    });
  }
  return Number(value);
}

function resolveStandingsFreeze(contest, config, state, nowSeconds) {
  const now = nowSeconds == null ? Math.floor(Date.now() / 1000) : Number(nowSeconds);
  const start = Number(contest.start_time);
  const end = Number(contest.end_time);
  const minutes = config && config.security && config.security.standings_freeze_after_minutes;
  const scheduled = minutes != null && minutes !== '' && Number.isSafeInteger(Number(minutes)) && Number(minutes) >= 0;
  let freezeAt = scheduled ? start + Number(minutes) * 60 : null;
  if (state && state.status === 'frozen') {
    const manual = Number(state.frozen_at_seconds);
    const manualAt = Number.isFinite(manual) && manual > 0 ? manual : start;
    freezeAt = freezeAt == null ? manualAt : Math.min(freezeAt, manualAt);
  }
  const ended = now >= end || !!(state && ['ended', 'rated', 'archived'].includes(state.status));
  const frozen = !ended && now >= start && freezeAt != null && freezeAt < end && now >= freezeAt;
  return { frozen, freezeAt, ended };
}

function selectStandingsView(freeze, canManage, requestedView) {
  const showLive = freeze.frozen && !!canManage && requestedView === 'live';
  return { ...freeze, canManage: !!canManage, showLive,
    cutoff: freeze.frozen && !showLive ? freeze.freezeAt : null };
}

// Reconstruct from submissions, never from the latest score: a later AC or a
// latest-only NOI score cannot safely be rolled back from contest_player.
function scoreDetailsBefore(submissions, contest, cutoff) {
  const result = new Map();
  const problemIds = new Set(String(contest.problems || '').split('|').map(Number));
  const ordered = submissions.filter(row => !row.pending && !row.action_type &&
    !['Cancelled', 'Cheated'].includes(row.status) && problemIds.has(Number(row.problem_id)) &&
    Number(row.submit_time) >= Number(contest.start_time) &&
    Number(row.submit_time) < Math.min(cutoff, Number(contest.end_time)))
    .sort((a, b) => Number(a.submit_time) - Number(b.submit_time) || Number(a.id) - Number(b.id));
  for (const row of ordered) {
    const userId = Number(row.user_id);
    if (!result.has(userId)) result.set(userId, {});
    const details = result.get(userId);
    const problemId = Number(row.problem_id);
    const previous = details[problemId];
    if (contest.type === 'acm') {
      const detail = previous || { accepted: false, unacceptedCount: 0, acceptedTime: 0, judge_id: 0 };
      if (!detail.accepted) {
        detail.judge_id = Number(row.id);
        detail.time = Number(row.submit_time);
        if (row.status === 'Accepted') {
          detail.accepted = true;
          detail.acceptedTime = Number(row.submit_time);
        } else if (row.score != null) detail.unacceptedCount++;
      }
      details[problemId] = detail;
    } else if (!previous || (contest.type === 'noi'
      ? Number(row.id) > previous.judge_id
      : Number(row.score || 0) >= previous.score && previous.score < 100)) {
      details[problemId] = { score: Number(row.score || 0), judge_id: Number(row.id), time: Number(row.submit_time) };
    }
  }
  return result;
}

async function loadFrozenScoreDetails(connection, contest, cutoff) {
  const submissions = await connection.query(
    `SELECT js.id,js.user_id,js.problem_id,js.submit_time,js.status,js.score
       FROM judge_state js
       LEFT JOIN judge_state_admin_action action ON action.judge_id=js.id
      WHERE js.type=1 AND js.type_info=? AND js.pending=0 AND action.judge_id IS NULL
        AND js.submit_time>=? AND js.submit_time<?
      ORDER BY js.submit_time ASC,js.id ASC`,
    [Number(contest.id), Number(contest.start_time), Math.min(cutoff, Number(contest.end_time))]
  );
  return scoreDetailsBefore(submissions, contest, cutoff);
}

function parseDetails(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch (_) { return {}; }
}

function normalizeProblemDetails(value) {
  const details = parseDetails(value);
  const normalized = {};
  for (const problemId of Object.keys(details).sort((left, right) => Number(left) - Number(right))) {
    if (details[problemId] && typeof details[problemId] === 'object') {
      normalized[String(problemId)] = Object.assign({}, details[problemId]);
    }
  }
  return normalized;
}

function judgeTime(detail, judgeTimes) {
  return Number(judgeTimes.get(Number(detail && detail.judge_id)) || (detail && detail.time) || 0);
}

function calculateStandingRows(input) {
  const type = ['ioi', 'noi'].includes(input.type) ? input.type : 'acm';
  const startTime = Number(input.startTime || 0);
  const rankingParams = input.rankingParams || {};
  const judgeTimes = input.judgeTimes || new Map();
  const rows = (input.players || []).map(player => {
    const details = normalizeProblemDetails(player.details == null ? player.score_details : player.details);
    let score = 0;
    let penalty = 0;
    if (type === 'acm') {
      for (const detail of Object.values(details)) {
        if (!detail.accepted) continue;
        score += 1;
        penalty += Math.max(0, Number(detail.acceptedTime || 0) - startTime) +
          Math.max(0, Number(detail.unacceptedCount || 0)) * 20 * 60;
      }
    } else {
      for (const [problemId, detail] of Object.entries(details)) {
        score += Math.round(Number(detail.score || 0) * Number(rankingParams[problemId] == null ? 1 : rankingParams[problemId]));
        penalty = Math.max(penalty, judgeTime(detail, judgeTimes));
      }
    }
    return {
      participant_id: Number(player.participant_id == null ? player.player_id : player.participant_id),
      user_id: Number(player.user_id),
      username: String(player.username || ''),
      score,
      penalty,
      details
    };
  });
  rows.sort((left, right) => right.score - left.score || left.penalty - right.penalty || left.participant_id - right.participant_id);
  let rank = 0;
  let previousKey = null;
  rows.forEach((row, index) => {
    const key = type === 'acm' ? `${row.score}:${row.penalty}` : String(row.score);
    if (key !== previousKey) rank = index + 1;
    row.rank = rank;
    previousKey = key;
  });
  return rows;
}

function publicProblemDetails(details, type) {
  const result = {};
  for (const [problemId, detail] of Object.entries(normalizeProblemDetails(details))) {
    if (type === 'acm') {
      result[problemId] = {
        accepted: !!detail.accepted,
        attempts: Math.max(0, Number(detail.unacceptedCount || 0)) + (detail.accepted ? 1 : 0),
        accepted_at: detail.accepted ? Number(detail.acceptedTime || 0) : null
      };
    } else {
      result[problemId] = { score: Number(detail.score || 0) };
    }
  }
  return result;
}

function serializeStandingRow(row, options) {
  const scope = options && options.scope || 'public';
  const type = options && options.type || 'acm';
  const serialized = {
    rank: Number(row.rank),
    participant_id: Number(row.participant_id),
    user_id: Number(row.user_id),
    username: String(row.username || ''),
    score: Number(row.score || 0),
    penalty: Number(row.penalty || 0),
    details: scope === 'manager' ? normalizeProblemDetails(row.details) : publicProblemDetails(row.details, type)
  };
  if (scope === 'manager') serialized.diagnostics = row.diagnostics || {};
  return serialized;
}

function advanceStandingsPointers(current, versionId, kind, status) {
  const pointers = {
    live_version_id: current && current.live_version_id || null,
    public_version_id: current && current.public_version_id || null,
    frozen_version_id: current && current.frozen_version_id || null,
    final_version_id: current && current.final_version_id || null
  };
  if (kind === 'frozen') {
    pointers.frozen_version_id = Number(versionId);
    pointers.public_version_id = Number(versionId);
    return pointers;
  }
  pointers.live_version_id = Number(versionId);
  if (kind === 'final' || ['ended', 'rated', 'archived'].includes(status)) {
    pointers.final_version_id = Number(versionId);
    pointers.public_version_id = Number(versionId);
  } else if (kind === 'unfrozen' || status !== 'frozen') {
    pointers.public_version_id = Number(versionId);
  }
  return pointers;
}

module.exports = { advanceStandingsPointers, calculateStandingRows, normalizeProblemDetails, publicProblemDetails, serializeStandingRow,
  normalizeFreezeAfterMinutes, resolveStandingsFreeze, selectStandingsView, scoreDetailsBefore, loadFrozenScoreDetails };
