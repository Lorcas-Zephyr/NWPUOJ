'use strict';

const { csvCell, problemAlias } = require('./contest-ranklist-export');

function buildProblemSetRanklistCsv({ problemSet, items, problemIds, profiles, classMembership, filtered }) {
  const aliases = problemIds.map((_id, index) => problemAlias(index));
  const headers = (filtered ? ['当前名次', '总名次'] : ['名次'])
    .concat(['用户名', '姓名', '学号', '学院', '班级'])
    .concat(problemSet.ranking_mode === 'acm'
      ? ['通过题数', '罚时（秒）'].concat(aliases.flatMap(alias => [alias + '-结果', alias + '-尝试次数', alias + '-通过用时（秒）']))
      : ['总分'].concat(aliases.map(alias => alias + '-得分')));
  const rows = items.map(item => {
    const profile = profiles.get(Number(item.user.id)) || {};
    const rank = filtered ? [item.player.standing_rank, item.player.overall_standing_rank] : [item.player.standing_rank];
    const identity = [item.user.username, profile.real_name || '', profile.student_id || '', profile.college || '', (classMembership.get(Number(item.user.id)) || []).map(group => group.name).join(' / ')];
    let scores;
    if (problemSet.ranking_mode === 'acm') {
      scores = [item.player.score, item.tie];
      problemIds.forEach(problemId => {
        const detail = item.player.score_details[problemId] || {};
        scores.push(detail.accepted ? '通过' : (detail.unacceptedCount ? '未通过' : '未提交'), detail.accepted ? Number(detail.unacceptedCount || 0) + 1 : Number(detail.unacceptedCount || 0), detail.accepted ? Math.max(0, Number(detail.acceptedTime) - Number(problemSet.published_at || 0)) : '');
      });
    } else {
      scores = [item.player.score].concat(problemIds.map(problemId => Number(item.player.score_details[problemId] && item.player.score_details[problemId].weighted_score || 0)));
    }
    return rank.concat(identity, scores);
  });
  return '\uFEFF' + [headers].concat(rows).map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { buildProblemSetRanklistCsv };
