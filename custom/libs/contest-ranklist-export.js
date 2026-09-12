'use strict';

function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text) || /^\s+[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function problemAlias(index) {
  let value = Number(index) + 1;
  let alias = '';
  while (value > 0) {
    value--;
    alias = String.fromCharCode(65 + value % 26) + alias;
    value = Math.floor(value / 26);
  }
  return alias;
}

function elapsedSeconds(timestamp, startTime) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  return Math.max(0, Math.round(value - Number(startTime || 0)));
}

function identityColumns(item, profiles, classMembership) {
  const profile = profiles.get(Number(item.user.id)) || {};
  return [
    item.user.username,
    profile.real_name || '',
    profile.student_id || '',
    profile.college || '',
    (classMembership && classMembership.get(Number(item.user.id)) || []).map(group => group.name).join(' / ')
  ];
}

function acmColumns(item, problemIds, contest) {
  const columns = [Math.max(0, Number(item.player.score || 0)), Math.max(0, Math.round(Number(item.tie || 0)))];
  for (const problemId of problemIds) {
    const detail = item.player.score_details[problemId] || {};
    const wrongAttempts = Math.max(0, Number(detail.unacceptedCount || 0));
    const accepted = !!detail.accepted;
    columns.push(
      accepted ? '通过' : (wrongAttempts ? '未通过' : '未提交'),
      accepted ? wrongAttempts + 1 : wrongAttempts,
      accepted ? elapsedSeconds(detail.acceptedTime, contest.start_time) : ''
    );
  }
  return columns;
}

function scoreColumns(item, problemIds, contest) {
  const columns = [Number(item.player.score || 0)];
  for (const problemId of problemIds) {
    const detail = item.player.score_details[problemId] || {};
    columns.push(
      detail.weighted_score == null ? '' : Number(detail.weighted_score),
      detail.judge_state ? elapsedSeconds(detail.judge_state.submit_time, contest.start_time) : ''
    );
  }
  return columns;
}

function buildContestRanklistRows({ contest, items, problemIds, profiles, accountFilter, selectedClassIds, classMembership }) {
  const filtered = (accountFilter && accountFilter !== 'all') || (selectedClassIds && selectedClassIds.length);
  const identityHeaders = ['用户名', '姓名', '学号', '学院', '班级'];
  const aliases = problemIds.map((problemId, index) => problemAlias(index));
  const scoreHeaders = contest.type === 'acm'
    ? ['通过题数', '罚时（秒）'].concat(aliases.flatMap(alias => [alias + '-结果', alias + '-尝试次数', alias + '-通过用时（秒）']))
    : ['总分'].concat(aliases.flatMap(alias => [alias + '-得分', alias + '-提交时间（秒）']));
  const header = (filtered ? ['当前名次', '总名次'] : ['名次']).concat(identityHeaders, scoreHeaders);
  const rows = items.map(item => {
    const ranks = filtered
      ? [item.player.standing_rank, item.player.overall_standing_rank]
      : [item.player.standing_rank];
    const scores = contest.type === 'acm'
      ? acmColumns(item, problemIds, contest)
      : scoreColumns(item, problemIds, contest);
    return ranks.concat(identityColumns(item, profiles, classMembership), scores);
  });
  return [header].concat(rows);
}

function buildContestRanklistCsv(options) {
  const rows = buildContestRanklistRows(options);
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = {
  buildContestRanklistCsv,
  buildContestRanklistRows,
  csvCell,
  problemAlias
};
