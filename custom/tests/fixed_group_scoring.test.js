'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyFixedGroupScoring } = require('../libs/fixed-group-scoring');
function fixture(times = [5, 15], bases = [5, 5]) { return { judge: { subtasks: [{ score: 100, cases: times.map((t, i) => ({ status: 2, result: { type: 1, scoringRate: 1, output: { content: `NOJ_FIXED_GROUP_V1 1 100 ${i + 1} 2 ${bases[i]}` }, spjMessage: `NOJ_FIXED_GROUP_V1 1 100 ${i + 1} 2 ${bases[i]} ${t}` } })) }] } }; }
test('uses ratio of group totals, not mean of per-case ratios', () => { const s = fixture(); assert.equal(applyFixedGroupScoring(s), true); assert.equal(s.judge.subtasks[0].score, 60); assert.equal(s.judge.subtasks[0].cases[0].result.type, 3); applyFixedGroupScoring(s); assert.equal(s.judge.subtasks[0].score, 60); });
test('better than fixed baseline is capped at full score', () => { const s = fixture([1, 1]); applyFixedGroupScoring(s); assert.equal(s.judge.subtasks[0].score, 100); });
test('illegal or missing case zeroes whole group', () => { for (const status of [0, 1, 3, 4]) { const s = fixture(); s.judge.subtasks[0].cases[1].status = status; applyFixedGroupScoring(s); assert.equal(s.judge.subtasks[0].score, 0); } const s = fixture(); s.judge.subtasks[0].cases[1].result.type = 11; applyFixedGroupScoring(s); assert.equal(s.judge.subtasks[0].score, 0); });
test('does not trust contestant stderr or mismatched metadata', () => { const s = fixture(); s.judge.subtasks[0].cases[1].result.spjMessage = ''; s.judge.subtasks[0].cases[1].result.userError = 'NOJ_FIXED_GROUP_V1 1 100 2 2 5 1'; applyFixedGroupScoring(s); assert.equal(s.judge.subtasks[0].score, 0); });
test('ordinary results are unchanged', () => { const s = { judge: { subtasks: [{ score: 42, cases: [{ status: 2, result: { type: 2, output: { content: '42' } } }] }] } }; const before = JSON.stringify(s); assert.equal(applyFixedGroupScoring(s), false); assert.equal(JSON.stringify(s), before); });
