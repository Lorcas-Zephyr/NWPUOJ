'use strict';

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
  pointers.live_version_id = Number(versionId);
  if (kind === 'frozen') {
    pointers.frozen_version_id = Number(versionId);
    pointers.public_version_id = Number(versionId);
  } else if (kind === 'final' || ['ended', 'rated', 'archived'].includes(status)) {
    pointers.final_version_id = Number(versionId);
    pointers.public_version_id = Number(versionId);
  } else if (kind === 'unfrozen' || status !== 'frozen') {
    pointers.public_version_id = Number(versionId);
  }
  return pointers;
}

module.exports = { advanceStandingsPointers, calculateStandingRows, normalizeProblemDetails, publicProblemDetails, serializeStandingRow };
