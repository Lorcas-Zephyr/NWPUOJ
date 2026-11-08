'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadProblem(rows) {
  const context = {
    exports: {},
    syzoj: { utils: { lock: async (_key, work) => work() } },
    require(name) {
      if (name === 'typeorm') return {
        Entity: () => () => {}, Column: () => () => {},
        Index: () => () => {}, PrimaryGeneratedColumn: () => () => {},
        Not: value => ({ not: value })
      };
      if (name === './common') return { default: function Model() {} };
      if (name === './judge_state') return { default: {
        count: async where => rows.filter(row => Object.entries(where).every(([key, value]) =>
          value && typeof value === 'object'
            ? row[key] != null && row[key] !== value.not
            : row[key] === value
        )).length
      } };
      return {};
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../models-built/problem.js'), 'utf8'), context);
  const problem = new context.exports.default();
  problem.id = 911331;
  problem.ac_num = 0;
  problem.submit_num = 0;
  problem.save = async () => problem;
  return problem;
}

test('problem counts use AC verdicts for every maximum score and exclude contest submissions', async () => {
  const row = (status, score, type = 0, problem_id = 911331) => ({ status, score, type, problem_id });
  const problem = loadProblem([
    ...[10, 15, 20, 100, 100].map(score => row('Accepted', score)),
    row('Wrong Answer', 100), row('Waiting', 0),
    row('Accepted', 10, 1), row('Accepted', 100, 1),
    row('Accepted', 100, null), row('Accepted', 100, 0, 911332)
  ]);
  await problem.resetSubmissionCount();
  assert.equal(problem.ac_num, 5);
  assert.equal(problem.submit_num, 7);
});

test('recounting after rejudge removes the former AC and restores it when judging finishes', async () => {
  const submission = { problem_id: 911331, type: 0, status: 'Accepted', score: 10 };
  const problem = loadProblem([submission]);
  await problem.resetSubmissionCount();
  assert.equal(problem.ac_num, 1);
  submission.status = 'Waiting';
  submission.score = 0;
  await problem.resetSubmissionCount();
  assert.equal(problem.ac_num, 0);
  assert.equal(problem.submit_num, 1);
  submission.status = 'Accepted';
  submission.score = 10;
  await problem.resetSubmissionCount();
  assert.equal(problem.ac_num, 1);
});
