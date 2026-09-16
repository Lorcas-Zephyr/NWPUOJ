'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { advanceStandingsPointers, calculateStandingRows, serializeStandingRow } = require('../libs/contest-standings');
const fs = require('node:fs');
const path = require('node:path');
const { buildContestRanklistCsv, buildContestRanklistRows, csvCell, problemAlias } = require('../libs/contest-ranklist-export');
const { normalizeFreezeAfterMinutes, resolveStandingsFreeze, selectStandingsView, scoreDetailsBefore } = require('../libs/contest-standings');

test('freeze configuration accepts disabled, zero and integer minutes, rejects invalid or end-boundary values', () => {
  for (const value of [null, undefined, '']) assert.equal(normalizeFreezeAfterMinutes(value, 100, 3700), null);
  for (const value of [0, 1, '59']) assert.equal(normalizeFreezeAfterMinutes(value, 100, 3700), Number(value));
  for (const value of [-1, 1.5, 'abc', ' ', true, [], {}, 60, 61, Infinity]) {
    assert.throws(() => normalizeFreezeAfterMinutes(value, 100, 3700), { code: 'CONTEST_FREEZE_INVALID', statusCode: 422 });
  }
});

test('freeze starts exactly at the configured minute, ends automatically and defaults off for old contests', () => {
  const contest = { start_time: 100, end_time: 3700 };
  const config = { security: { standings_freeze_after_minutes: 30 } };
  for (const [now, frozen] of [[99, false], [1899, false], [1900, true], [3699, true], [3700, false]]) {
    assert.equal(resolveStandingsFreeze(contest, config, null, now).frozen, frozen);
  }
  assert.equal(resolveStandingsFreeze(contest, {}, null, 2000).frozen, false);
  assert.equal(resolveStandingsFreeze(contest, { security: { standings_freeze_after_minutes: 0 } }, null, 100).frozen, true);
  const manual = { status: 'frozen', frozen_at_seconds: 200 };
  assert.equal(resolveStandingsFreeze(contest, {}, manual, 300).freezeAt, 200);
  assert.equal(resolveStandingsFreeze(contest, config, manual, 3700).frozen, false);
});

test('live standings require contest management and explicit opt-in and never change other viewers', () => {
  const freeze = { frozen: true, freezeAt: 1900, ended: false };
  for (const view of [undefined, 'public', 'frozen', 'final', 'live']) {
    assert.equal(selectStandingsView(freeze, false, view).cutoff, 1900);
  }
  assert.equal(selectStandingsView(freeze, true, undefined).cutoff, 1900);
  assert.equal(selectStandingsView(freeze, true, 'live').cutoff, null);
  assert.equal(selectStandingsView(freeze, true, 'public').showLive, false);
  assert.equal(freeze.frozen, true);
  assert.equal(selectStandingsView({ ...freeze, frozen: false, ended: true }, false).cutoff, null);
});

const freezeContest = { type: 'acm', problems: '11|12', start_time: 100, end_time: 3700 };
function judge(id, time, score = 0, status = 'Wrong Answer', extra = {}) {
  return { id, user_id: 7, problem_id: 11, submit_time: time, score, status, pending: 0, ...extra };
}

test('ACM freeze excludes the boundary, late AC, CE penalty, cancelled and pending submissions', () => {
  const submissions = [judge(1, 99), judge(2, 110), judge(3, 120, null, 'Compile Error'),
    judge(4, 150, 0, 'Wrong Answer', { pending: 1 }), judge(5, 180, 0, 'Cancelled'),
    judge(6, 190, 100, 'Accepted', { action_type: 'cheated' }),
    judge(7, 200, 100, 'Accepted'), judge(8, 230, 100, 'Accepted')];
  const frozen = scoreDetailsBefore(submissions, freezeContest, 200).get(7)[11];
  assert.equal(frozen.accepted, false);
  assert.equal(frozen.unacceptedCount, 1);
  assert.equal(frozen.judge_id, 3);
  const final = scoreDetailsBefore(submissions, freezeContest, 3700).get(7)[11];
  assert.equal(final.accepted, true);
  assert.equal(final.acceptedTime, 200);
  assert.equal(final.unacceptedCount, 1);
  assert.deepEqual(scoreDetailsBefore(submissions, freezeContest, 100), new Map());
});

test('IOI best-score and NOI latest-score rules are reconstructed before cutoff, with correct weighted ranks', () => {
  const submissions = [judge(1, 110, 60), judge(2, 150, 30), judge(3, 190, 80), judge(4, 200, 100, 'Accepted'),
    judge(5, 170, 100, 'Accepted', { user_id: 8 }), judge(6, 180, 100, 'Accepted', { user_id: 8 }),
    judge(7, 185, 90, 'Wrong Answer', { problem_id: 99 })];
  const ioi = scoreDetailsBefore(submissions, { ...freezeContest, type: 'ioi' }, 180);
  const noi = scoreDetailsBefore(submissions, { ...freezeContest, type: 'noi' }, 180);
  assert.equal(ioi.get(7)[11].score, 60);
  assert.equal(noi.get(7)[11].score, 30);
  assert.equal(ioi.get(8)[11].judge_id, 5);
  assert.equal(ioi.get(7)[99], undefined);
  const rows = calculateStandingRows({ type: 'ioi', rankingParams: { 11: 2 }, players: [7, 8, 9].map(id => ({
    user_id: id, player_id: id, details: ioi.get(id) || {}
  })) });
  assert.deepEqual(rows.map(row => [row.user_id, row.score, row.rank]), [[8, 200, 1], [7, 120, 2], [9, 0, 3]]);
});

test('ACM standings use accepted count, penalty, stable ties, and competition ranks', () => {
  const rows = calculateStandingRows({
    type: 'acm',
    startTime: 1000,
    players: [
      { player_id: 3, user_id: 30, username: 'c', details: { 1: { accepted: true, acceptedTime: 1600, unacceptedCount: 1 } } },
      { player_id: 2, user_id: 20, username: 'b', details: { 1: { accepted: true, acceptedTime: 1600, unacceptedCount: 1 } } },
      { player_id: 1, user_id: 10, username: 'a', details: { 1: { accepted: true, acceptedTime: 1700, unacceptedCount: 0 }, 2: { accepted: true, acceptedTime: 2000, unacceptedCount: 0 } } }
    ]
  });
  assert.deepEqual(rows.map(row => [row.user_id, row.score, row.penalty, row.rank]), [
    [10, 2, 1700, 1], [20, 1, 1800, 2], [30, 1, 1800, 2]
  ]);
});

test('IOI standings apply weights and tie only on score', () => {
  const rows = calculateStandingRows({
    type: 'ioi',
    rankingParams: { 1: 2, 2: 0.5 },
    judgeTimes: new Map([[11, 5000], [12, 3000], [21, 4000]]),
    players: [
      { player_id: 2, user_id: 2, username: 'later', details: { 1: { score: 50, judge_id: 21 } } },
      { player_id: 1, user_id: 1, username: 'earlier', details: { 1: { score: 40, judge_id: 11 }, 2: { score: 40, judge_id: 12 } } }
    ]
  });
  assert.deepEqual(rows.map(row => [row.user_id, row.score, row.penalty, row.rank]), [[2, 100, 4000, 1], [1, 100, 5000, 1]]);
});

test('public standings remove judge identifiers and submission diagnostics', () => {
  const row = { rank: 1, participant_id: 4, user_id: 8, username: 'member', score: 1, penalty: 120, details: { 9: { accepted: true, acceptedTime: 120, unacceptedCount: 2, judge_id: 99, submissions: { 99: { score: 100 } } } }, diagnostics: { source: 'projection' } };
  const publicRow = serializeStandingRow(row, { type: 'acm', scope: 'public' });
  assert.deepEqual(publicRow.details, { 9: { accepted: true, attempts: 3, accepted_at: 120 } });
  assert.equal('diagnostics' in publicRow, false);
  assert.equal(serializeStandingRow(row, { type: 'acm', scope: 'manager' }).details['9'].judge_id, 99);
});

test('frozen standings keep the public pointer stable while live results advance', () => {
  let pointers = advanceStandingsPointers(null, 1, 'realtime', 'running');
  assert.deepEqual(pointers, { live_version_id: 1, public_version_id: 1, frozen_version_id: null, final_version_id: null });
  pointers = advanceStandingsPointers(pointers, 2, 'frozen', 'frozen');
  assert.equal(pointers.live_version_id, 1);
  assert.equal(pointers.public_version_id, 2);
  assert.equal(pointers.frozen_version_id, 2);
  pointers = advanceStandingsPointers(pointers, 3, 'realtime', 'frozen');
  assert.equal(pointers.live_version_id, 3);
  assert.equal(pointers.public_version_id, 2);
  pointers = advanceStandingsPointers(pointers, 4, 'unfrozen', 'running');
  assert.equal(pointers.public_version_id, 4);
  pointers = advanceStandingsPointers(pointers, 5, 'final', 'ended');
  assert.equal(pointers.final_version_id, 5);
  assert.equal(pointers.public_version_id, 5);
});

test('ACM ranklist exports identity, total result, and per-problem details', () => {
  const contest = { type: 'acm', start_time: 1000 };
  const items = [{
    user: { id: 7, username: 'student' },
    player: {
      standing_rank: 2,
      overall_standing_rank: 5,
      score: 1,
      score_details: {
        11: { accepted: true, acceptedTime: 1600, unacceptedCount: 2 },
        12: { accepted: false, unacceptedCount: 1 }
      }
    },
    tie: 3000
  }];
  const profiles = new Map([[7, { real_name: '张三', student_id: '2026000001', college: '计算机学院' }]]);
  const rows = buildContestRanklistRows({ contest, items, problemIds: [11, 12], profiles, accountFilter: 'ordinary' });
  assert.deepEqual(rows[0], ['当前名次', '总名次', '用户名', '姓名', '学号', '学院', '班级', '通过题数', '罚时（秒）', 'A-结果', 'A-尝试次数', 'A-通过用时（秒）', 'B-结果', 'B-尝试次数', 'B-通过用时（秒）']);
  assert.deepEqual(rows[1], [2, 5, 'student', '张三', '2026000001', '计算机学院', '', 1, 3000, '通过', 3, 600, '未通过', 1, '']);
});

test('IOI ranklist exports total and weighted problem scores', () => {
  const options = {
    contest: { type: 'ioi', start_time: 1000 },
    items: [{
      user: { id: 8, username: '=unsafe' },
      player: { standing_rank: 1, score: 140, score_details: { 21: { weighted_score: 80, judge_state: { submit_time: 1300 } }, 22: { weighted_score: 60, judge_state: { submit_time: 1450 } } } }
    }],
    problemIds: [21, 22],
    profiles: new Map([[8, { real_name: '李四', student_id: '2026000002', college: '软件学院' }]]),
    accountFilter: 'all'
  };
  const rows = buildContestRanklistRows(options);
  assert.deepEqual(rows[0], ['名次', '用户名', '姓名', '学号', '学院', '班级', '总分', 'A-得分', 'A-提交时间（秒）', 'B-得分', 'B-提交时间（秒）']);
  assert.deepEqual(rows[1], [1, '=unsafe', '李四', '2026000002', '软件学院', '', 140, 80, 300, 60, 450]);
  const csv = buildContestRanklistCsv(options);
  assert.equal(csv.startsWith('\uFEFF'), true);
  assert.match(csv, /"'=unsafe"/);
});

test('ranklist CSV aliases continue after Z and neutralize spreadsheet formulas', () => {
  assert.equal(problemAlias(0), 'A');
  assert.equal(problemAlias(25), 'Z');
  assert.equal(problemAlias(26), 'AA');
  assert.equal(csvCell('  +SUM(A1:A2)'), '"\'  +SUM(A1:A2)"');
});

test('contest route applies shared snapshot and standings access policies', () => {
  const route = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_contest_domain.js'), 'utf8');
  assert.match(route, /snapshotRefreshAllowed\(action\)/);
  assert.match(route, /problem_snapshot_id VARCHAR\(80\) NULL/);
  assert.match(route, /snapshotProblems,/);
  assert.match(route, /problemV2\.snapshotForCurrentVersion\(problem/);
  assert.match(route, /includeDraft: true/);
  assert.match(route, /trackProblemSnapshot: trackContestProblemSnapshot/);
  assert.match(route, /SELECT id,content_hash FROM problem_v2_snapshot/);
  assert.match(route, /problem_snapshot_id,snapshot_hash/);
  assert.match(route, /app\.get\('\/api\/v2\/contests\/:id\/problem-snapshots'/);
  assert.match(route, /function serializeContestProblemSnapshot\(row\)/);
  assert.match(route, /ORDER BY ordinal ASC LIMIT \?/);
  assert.match(route, /app\.get\('\/api\/v2\/contests\/:id\/events'[\s\S]*?return api\.sse\(req, res, `contest:\$\{contest\.id\}`\)/);
  assert.match(route, /const access = standingsVisibility\(\{/);
  assert.match(route, /access === 'not_found'/);
  assert.match(route, /access === 'hidden'/);
});
