'use strict';

const DEFAULT_RULES = Object.freeze({ population: 'all', count_absent: false });

function normalizeRules(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['all', 'solved'].includes(value.population || 'all') ||
      (value.count_absent !== undefined && typeof value.count_absent !== 'boolean')) {
    throw Object.assign(new Error('总榜人数或缺席计分规则不正确。'), { statusCode: 422 });
  }
  return { population: value.population || 'all', count_absent: value.count_absent === true };
}

function nowcoderScore(solved, leaderSolved, population, rank) {
  if (solved <= 0 || leaderSolved <= 0 || population <= 0) return 0;
  if (population === 1) return 200;
  return 100 * (solved / leaderSolved) * (2 * population - 2) / (population + rank - 2);
}

// All ranks, reference scores and population sizes are recalculated inside the
// selected roster. No global contest rank or already rounded score is reused.
function calculateWeeklyStandings({ members, contests, standings, attendance = [], rules, now = Math.floor(Date.now() / 1000) }) {
  const config = normalizeRules(rules);
  const selected = Array.from(new Map(members.map(member => [Number(member.user_id), member])).values());
  const rounds = contests.slice().sort((a, b) => Number(a.start_time) - Number(b.start_time) || Number(a.id) - Number(b.id));
  const onsite = new Set(attendance.filter(row => !!Number(row.onsite)).map(row => `${Number(row.user_id)}:${Number(row.contest_id)}`));
  const rows = selected.map(member => ({ ...member, user_id: Number(member.user_id), cells: [], s1: 0, s2: 0, g1: 0, g2: 0, total: 0, onsite_count: 0, g2_count: 0 }));
  for (const contest of rounds) {
    const finished = Number(contest.end_time) <= now;
    const totalProblems = new Set(String(contest.problems || '').split('|').map(Number)
      .filter(id => Number.isSafeInteger(id) && id > 0)).size;
    const source = new Map((standings[String(contest.id)] || []).map(row => [Number(row.user_id), row]));
    const ranking = rows.map(member => {
      const record = source.get(member.user_id) || {};
      return { user_id: member.user_id, solved: Math.max(0, Number(record.score) || 0), penalty: Math.max(0, Number(record.penalty) || 0), participated: !!record.participated };
    }).sort((a, b) => b.solved - a.solved || a.penalty - b.penalty || a.user_id - b.user_id);
    const population = config.population === 'all' ? rows.length : ranking.filter(row => row.solved > 0).length;
    const leader = ranking[0] && ranking[0].solved || 0;
    const positions = new Map();
    let rank = 0, previous;
    ranking.forEach((row, i) => {
      const key = `${row.solved}:${row.penalty}`;
      if (previous !== key) rank = i + 1;
      positions.set(row.user_id, { ...row, rank });
      previous = key;
    });
    for (const member of rows) {
      const result = positions.get(member.user_id);
      const offline = onsite.has(`${member.user_id}:${contest.id}`);
      member.cells.push({ contest_id: Number(contest.id), finished, onsite: offline,
        participated: offline || result.participated || result.solved > 0,
        solved: finished ? result.solved : null, total_problems: totalProblems, penalty: finished ? result.penalty : null,
        rank: finished ? result.rank : null, population: finished ? population : null,
        score: finished ? nowcoderScore(result.solved, leader, population, result.rank) : null, group: null });
    }
  }
  for (const member of rows) {
    const offline = member.cells.filter(cell => cell.finished && cell.onsite);
    member.onsite_count = offline.length;
    const best = new Set(offline.slice().sort((a, b) => b.score - a.score || member.cells.indexOf(a) - member.cells.indexOf(b)).slice(0, 4));
    for (const cell of member.cells) {
      if (!cell.finished) continue;
      if (best.has(cell)) { cell.group = 'g1'; member.s1 += cell.score; }
      else if (config.count_absent || cell.participated) { cell.group = 'g2'; member.s2 += cell.score; member.g2_count++; }
    }
    member.g1 = member.s1 / 4;
    member.g2 = member.g2_count ? member.s2 / member.g2_count : 0;
    member.total = member.g1 * 0.6 + member.g2 * 0.4;
  }
  rows.sort((a, b) => b.total - a.total || a.user_id - b.user_id);
  let rank = 0, lastScore = null;
  rows.forEach((row, i) => {
    if (lastScore === null || Math.abs(row.total - lastScore) > 1e-9) rank = i + 1;
    row.rank = rank; lastScore = row.total;
  });
  return { rules: config, contests: rounds, rows, member_count: rows.length, finished_count: rounds.filter(c => Number(c.end_time) <= now).length };
}

module.exports = { DEFAULT_RULES, normalizeRules, nowcoderScore, calculateWeeklyStandings };
