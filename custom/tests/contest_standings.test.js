'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { advanceStandingsPointers, calculateStandingRows, serializeStandingRow } = require('../libs/contest-standings');
const fs = require('node:fs');
const path = require('node:path');

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

test('contest route applies shared snapshot and standings access policies', () => {
  const route = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_contest_domain.js'), 'utf8');
  assert.match(route, /snapshotRefreshAllowed\(action\)/);
  assert.match(route, /problem_snapshot_id VARCHAR\(80\) NULL/);
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
