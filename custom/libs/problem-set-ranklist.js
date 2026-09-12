'use strict';

function assignRanks(items, mode) {
  let rank = 0;
  let previous = null;
  items.forEach((item, index) => {
    const key = mode === 'acm' ? `${item.player.score}:${item.tie}` : String(item.player.score);
    if (key !== previous) rank = index + 1;
    item.player.standing_rank = rank;
    previous = key;
  });
}

function cloneItem(item) {
  const details = {};
  Object.entries(item.player.score_details).forEach(([problemId, detail]) => {
    details[problemId] = detail && Object.assign({}, detail, { judge_state: detail.judge_state && Object.assign({}, detail.judge_state) });
  });
  return { user: Object.assign({}, item.user), player: Object.assign({}, item.player, { score_details: details }), tie: item.tie };
}

function buildRanklist(participants, submissions, problemIds, mode, startedAt) {
  const allowedProblems = new Set((problemIds || []).map(Number));
  const byUser = new Map();
  (participants || []).forEach(row => {
    const userId = Number(row.user_id);
    byUser.set(userId, {
      user: {
        id: userId,
        username: row.username,
        is_admin: !!row.is_admin,
        nameplate: row.nameplate || '',
        isTemporaryContestAccount: !!row.is_temporary
      },
      player: { id: userId, user_id: userId, score: 0, score_details: {} },
      tie: 0
    });
  });
  const ordered = (submissions || []).slice().sort((left, right) => Number(left.submit_time) - Number(right.submit_time) || Number(left.id) - Number(right.id));
  ordered.forEach(row => {
    const item = byUser.get(Number(row.user_id));
    const problemId = Number(row.problem_id);
    if (!item || !allowedProblems.has(problemId) || row.admin_action || row.pending) return;
    const status = String(row.status || '');
    if (mode === 'acm') {
      let detail = item.player.score_details[problemId];
      if (!detail) detail = item.player.score_details[problemId] = { accepted: false, unacceptedCount: 0, judge_id: Number(row.id) };
      if (detail.accepted) return;
      detail.judge_id = Number(row.id);
      if (status === 'Accepted') {
        detail.accepted = true;
        detail.acceptedTime = Number(row.submit_time);
      } else {
        detail.unacceptedCount++;
      }
    } else {
      const score = Math.max(0, Number(row.score || 0));
      const current = item.player.score_details[problemId];
      if (!current || score > Number(current.score || 0) || (score === Number(current.score || 0) && Number(row.submit_time) < Number(current.judge_state.submit_time))) {
        item.player.score_details[problemId] = {
          score,
          weighted_score: score,
          judge_id: Number(row.id),
          judge_state: { submit_time: Number(row.submit_time) }
        };
      }
    }
  });
  const items = Array.from(byUser.values());
  items.forEach(item => {
    if (mode === 'acm') {
      Object.values(item.player.score_details).forEach(detail => {
        if (!detail.accepted) return;
        item.player.score++;
        item.tie += Math.max(0, Number(detail.acceptedTime) - Number(startedAt || 0)) + Number(detail.unacceptedCount || 0) * 20 * 60;
      });
    } else {
      item.player.score = Object.values(item.player.score_details).reduce((total, detail) => total + Number(detail.weighted_score || 0), 0);
      item.tie = Math.max(0, ...Object.values(item.player.score_details).map(detail => Number(detail.judge_state && detail.judge_state.submit_time || 0)));
    }
  });
  items.sort((left, right) => right.player.score - left.player.score || left.tie - right.tie || left.user.id - right.user.id);
  assignRanks(items, mode);
  return items;
}

function filterRanklist(allItems, mode, accountFilter, classIds, membership) {
  const selected = new Set((classIds || []).map(Number));
  const filtered = allItems.filter(item => {
    const accountMatches = accountFilter === 'all' || (accountFilter === 'contest') === !!item.user.isTemporaryContestAccount;
    const classMatches = !selected.size || (membership.get(Number(item.user.id)) || []).some(group => selected.has(Number(group.id)));
    return accountMatches && classMatches;
  }).map(cloneItem);
  if (accountFilter !== 'all' || selected.size) {
    filtered.forEach(item => { item.player.overall_standing_rank = item.player.standing_rank; });
    assignRanks(filtered, mode);
  }
  return filtered;
}

module.exports = { assignRanks, buildRanklist, cloneItem, filterRanklist };
