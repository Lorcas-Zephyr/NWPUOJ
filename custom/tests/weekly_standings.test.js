'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_RULES, normalizeRules, nowcoderScore, calculateWeeklyStandings } = require('../libs/weekly-standings');

test('weekly CSV upload reserves multipart overhead without raising JSON limits', () => {
  const api = require('../libs/api-v2');
  assert.equal(api.requestBodyLimit('/api/v2/weekly-ranklist/members/import-csv', 'multipart/form-data; boundary=x'), 2 * 1024 * 1024);
  assert.equal(api.requestBodyLimit('/api/v2/weekly-ranklist/config', 'application/json'), 1024 * 1024);
});

function fixture(offline, count = 10) {
  return { members: [{ user_id: 1, username: '选手' }],
    contests: Array.from({ length: count }, (_, i) => ({ id: i + 1, start_time: i, end_time: 100 + i })),
    standings: Object.fromEntries(Array.from({ length: count }, (_, i) => [i + 1, [{ user_id: 1, score: 1, penalty: 0, participated: true }]])),
    attendance: Array.from({ length: offline }, (_, i) => ({ user_id: 1, contest_id: i + 1, onsite: 1 })), now: 1000 };
}
test('Nowcoder formula, zero solves and single-member edge case', () => {
  assert.equal(nowcoderScore(6, 10, 100, 10), 110);
  assert.equal(nowcoderScore(10, 10, 100, 1), 200);
  assert.equal(nowcoderScore(0, 0, 0, 1), 0);
  assert.equal(nowcoderScore(1, 1, 1, 1), 200);
});
test('4 onsite + 6 online; 3 onsite + 7 online; 5 onsite + 5 online', () => {
  for (const [offline, s1, g1, s2, n2, total] of [[4, 800, 200, 1200, 6, 200], [3, 600, 150, 1400, 7, 170], [5, 800, 200, 1200, 6, 200]]) {
    const row = calculateWeeklyStandings(fixture(offline)).rows[0];
    assert.deepEqual([row.s1, row.g1, row.s2, row.g2_count, row.total], [s1, g1, s2, n2, total]);
    assert.equal(row.cells.filter(c => c.group === 'g1').length, Math.min(offline, 4));
  }
});
test('best four onsite scores form G1, lower onsite scores belong to G2', () => {
  const input = fixture(5);
  input.members.push({ user_id: 2, username: 'leader' });
  Object.values(input.standings).forEach((rows, i) => { rows[0].score = i + 1; rows.push({ user_id: 2, score: 10, penalty: 0 }); });
  const row = calculateWeeklyStandings(input).rows.find(r => r.user_id === 1);
  assert.deepEqual(row.cells.filter(c => c.group === 'g1').map(c => c.contest_id), [2, 3, 4, 5]);
  assert.equal(row.cells[0].group, 'g2');
});
test('adding/removing members recomputes ranks, population and leader from scratch', () => {
  const input = fixture(0, 1);
  input.standings[1].push({ user_id: 2, score: 2, penalty: 0 });
  assert.equal(calculateWeeklyStandings(input).rows[0].cells[0].score, 200);
  input.members.push({ user_id: 2 });
  const row = calculateWeeklyStandings(input).rows.find(r => r.user_id === 1);
  assert.equal(row.cells[0].rank, 2);
  assert.equal(row.cells[0].population, 2);
  assert.equal(row.cells[0].score, 50);
});
test('unfinished contests never disclose results or affect denominators', () => {
  const input = fixture(2, 3); input.now = 101;
  const row = calculateWeeklyStandings(input).rows[0];
  assert.equal(row.cells[2].score, null); assert.equal(row.cells[2].solved, null);
  assert.equal(row.cells[2].group, null); assert.equal(row.g2_count, 0);
  assert.equal(row.g2, 0); assert.equal(row.g1, 100);
});
test('absence policy, empty roster and tied ranks are deterministic', () => {
  const input = fixture(0, 2); input.standings[2] = [];
  assert.equal(calculateWeeklyStandings(input).rows[0].g2, 200);
  input.rules = { count_absent: true };
  assert.equal(calculateWeeklyStandings(input).rows[0].g2, 100);
  input.rules = { count_absent: false };
  assert.equal(calculateWeeklyStandings(input).rows[0].g2, 200);
  input.members = []; assert.deepEqual(calculateWeeklyStandings(input).rows, []);
});
test('confirmed defaults include every member in N but exclude absent G2 rounds', () => {
  assert.deepEqual(DEFAULT_RULES, { population: 'all', count_absent: false });
  const input = fixture(0, 1);
  input.members.push({ user_id: 2 }, { user_id: 3 }, { user_id: 4 });
  input.standings[1].push({ user_id: 2, score: 1, penalty: 0, participated: true },
    { user_id: 3, score: 0, penalty: 0, participated: true });
  const rows = calculateWeeklyStandings(input).rows;
  assert.deepEqual(rows.map(r => r.cells[0].rank), [1, 1, 3, 3]);
  assert.ok(rows.every(r => r.cells[0].population === 4));
  assert.equal(rows.find(r => r.user_id === 3).g2_count, 1);
  assert.equal(rows.find(r => r.user_id === 4).g2_count, 0);
  assert.equal(rows.find(r => r.user_id === 4).cells[0].group, null);
  input.members = input.members.filter(r => r.user_id !== 4);
  assert.ok(calculateWeeklyStandings(input).rows.every(r => r.cells[0].population === 3));
});
test('an onsite zero-submission round counts as attended, but keeps zero score', () => {
  const input = fixture(1, 2); input.standings[1] = [];
  const row = calculateWeeklyStandings(input).rows[0];
  assert.equal(row.onsite_count, 1);
  assert.equal(row.cells[0].participated, true);
  assert.equal(row.cells[0].group, 'g1');
  assert.equal(row.g1, 0);
  assert.equal(row.g2, 200);
});
test('invalid rule payloads are validation errors, not server errors', () => {
  for (const value of [null, [], 'all', { count_absent: 'false' }, { population: 'unknown' }]) {
    assert.throws(() => normalizeRules(value), { statusCode: 422 });
  }
});
test('each round exposes its current problem count without revealing unfinished solves', () => {
  const input = fixture(0, 3);
  input.contests[0].problems = '11|12|13';
  input.contests[1].problems = '11|12|12|';
  input.contests[2].problems = '';
  input.now = 101;
  input.standings[2] = [];
  let cells = calculateWeeklyStandings(input).rows[0].cells;
  assert.deepEqual(cells.map(c => [c.solved, c.total_problems]), [[1, 3], [0, 2], [null, 0]]);
  input.contests[0].problems = '11|12|13|14';
  cells = calculateWeeklyStandings(input).rows[0].cells;
  assert.equal(cells[0].total_problems, 4);
});
