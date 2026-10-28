'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

// Exercise the real render middleware and result projector with isolated data.
// Access guards still run independently; this fixture covers display rights.
function fixture({ viewerId = 1, submitterId = viewerId, pending = false, type = 'acm' } = {}) {
  const viewer = { id: viewerId, is_admin: viewerId === 1 };
  const result = {
    compile: { message: '<b>compile diagnostic</b>', status: 2 },
    judge: { subtasks: [{ score: 0, resultType: 2, cases: Array.from({ length: 20 }, (_, i) => ({
      status: 2, errorMessage: 'case diagnostic', result: { type: 2, time: 3, memory: 256, scoringRate: 0,
        input: { name: (i + 1) + '.in', content: 'fixture input' },
        output: { name: (i + 1) + '.out', content: 'fixture answer' },
        userOutput: 'fixture user output', userError: 'fixture stderr', spjMessage: 'fixture checker', systemMessage: 'fixture system' }
    })) }] }
  };
  const judge = { id: 13528, user_id: submitterId, type: 1, type_info: 900096, problem_id: 911181,
    pending, task_id: 'fixture-task', status: 'Wrong Answer', score: 0, total_time: 60, max_memory: 256, result };
  const contest = { id: 900096, type,
    isSupervisior: async user => !!user && [2, 10].includes(user.id),
    isEnded: () => false, allowedSeeingScore: () => type !== 'acm',
    allowedSeeingResult: () => true, allowedSeeingOthers: () => true,
    allowedSeeingTestcase: () => type === 'ioi' };
  const cache = { getCachedJudgeState: () => ({ result: 'Running 2/20' }), getCachedJudgeDetail: () => null };
  const processor = { module: { exports: {} }, require: () => cache };
  vm.runInNewContext(read('libs-built/submissions_process.js'), processor);
  const processResults = processor.module.exports;
  const routes = new Map();
  const utils = { makeUrl: parts => '/' + parts.join('/'), canViewSubmissionDetail: async () => true };
  const dependencies = {
    jsonwebtoken: { sign: JSON.stringify },
    '../libs/submissions_process': processResults, '../libs/judger': cache,
    '../libs/compiler-message': require('../libs/compiler-message'),
    '../libs/contest-standings': require('../libs/contest-standings'),
    typeorm: { getConnection: () => ({ query: async () => [{ title: 'Latest problem title' }] }) }
  };
  const models = { judge_state: { findById: async () => judge }, contest: { findById: async () => contest } };
  const context = { syzoj: { utils, model: name => models[name] || {}, config: { session_secret: 'fixture-only' } },
    ErrorMessage: Error, require: name => { if (!(name in dependencies)) throw Error(name); return dependencies[name]; },
    app: { use() {}, post() {}, get(route, handler) {
      for (const name of Array.isArray(route) ? route : [route]) {
        if (!routes.has(name)) routes.set(name, []);
        routes.get(name).push(handler);
      }
    } }
  };
  vm.runInNewContext(read('modules/_submission_routes.js'), context);
  function participantConfig() {
    return { showScore: contest.allowedSeeingScore(), showUsage: false, showCode: true,
      showResult: true, showOthers: true, showDetailResult: contest.allowedSeeingTestcase(),
      showTestdata: false, inContest: true, showRejudge: false };
  }
  return { judge, result, async render(route = '/contest/submission/:id') {
    // Build the options produced by the legacy controller before our wrapper.
    const config = route.startsWith('/contest/') ? participantConfig() : {
      ...participantConfig(), showScore: true, showUsage: true, showTestdata: true,
      showDetailResult: true, inContest: false, showRejudge: true
    };
    const options = { info: { submissionId: judge.id, problemName: 'Old problem title' }, displayConfig: config,
      roughResult: processResults.getRoughResult(judge, config, false),
      detailResult: processResults.processOverallResult(result, config) };
    let rendered;
    const res = { locals: { user: viewer }, render(view, values) { rendered = { view, values }; },
      redirect(url) { rendered = { redirect: url }; } };
    const req = { params: { id: String(judge.id) }, query: {} };
    const handlers = routes.get(route);
    for (const handler of handlers) {
      let nextCalled = false, failure;
      await handler(req, res, error => { nextCalled = true; failure = error; });
      if (failure) throw failure;
      if (!nextCalled) return rendered;
    }
    res.render('submission', options);
    return { ...rendered, originalConfig: config };
  } };
}

test('site admins and relevant contest managers see all testpoints in their own contest submissions', async () => {
  for (const viewerId of [1, 2, 10]) {
    const f = fixture({ viewerId });
    const { values, originalConfig } = await f.render();
    assert.equal(values.displayConfig.inContest, true);
    assert.equal(values.displayConfig.showRejudge, false, 'display fix does not grant rejudge permissions');
    for (const flag of ['showScore', 'showUsage', 'showCode', 'showResult', 'showTestdata', 'showDetailResult', 'showDiagnostics']) assert.equal(values.displayConfig[flag], true, flag);
    const cases = values.detailResult.judge.subtasks[0].cases;
    assert.equal(cases.length, 20);
    for (const key of ['input', 'output', 'userOutput', 'userError', 'spjMessage', 'systemMessage']) assert.deepEqual(cases[0].result[key], f.result.judge.subtasks[0].cases[0].result[key], key);
    assert.equal(values.roughResult.time, 60);
    assert.equal(values.roughResult.memory, 256);
    assert.equal(values.info.problemName, 'Latest problem title');
    assert.equal(values.compileMessageHtml, '<b>compile diagnostic</b>');
    assert.equal(originalConfig.showDetailResult, false, 'request-specific rights do not mutate a shared config');
    assert.equal(originalConfig.showUsage, false);
    assert.equal(values.submissionStatusToken, null);
  }
});

test('manager access to other submissions keeps the existing redirect and global navigation', async () => {
  for (const viewerId of [1, 2]) {
    const f = fixture({ viewerId, submitterId: 7 });
    assert.equal((await f.render()).redirect, '/submission/13528');
    const { values } = await f.render('/submission/:id');
    assert.equal(values.displayConfig.inContest, false);
    assert.equal(values.displayConfig.showRejudge, true);
    assert.equal(values.detailResult.judge.subtasks[0].cases.length, 20);
    assert.equal(values.detailResult.judge.subtasks[0].cases[0].result.systemMessage, 'fixture system');
  }
});

test('ordinary and unrelated administrators keep ACM and IOI participant disclosure restrictions', async () => {
  for (const viewerId of [3, 7]) {
    const { values } = await fixture({ viewerId }).render();
    assert.equal(values.detailResult.judge, null);
    assert.equal(values.displayConfig.showTestdata, false);
    assert.equal(values.displayConfig.showDetailResult, false);
    assert.equal(values.displayConfig.showUsage, false);
    const ioi = (await fixture({ viewerId, type: 'ioi' }).render()).values;
    assert.equal(ioi.detailResult.judge.subtasks[0].cases.length, 20);
    const result = ioi.detailResult.judge.subtasks[0].cases[0].result;
    for (const key of ['input', 'output', 'userOutput', 'userError', 'spjMessage', 'systemMessage', 'time', 'memory']) assert.equal(result[key], undefined, key);
    assert.equal(ioi.detailResult.judge.subtasks[0].cases[0].errorMessage, undefined);
  }
});

test('pending manager submissions keep stable progress without provisional testpoint results', async () => {
  const { values } = await fixture({ pending: true }).render();
  assert.equal(values.detailResult, null);
  assert.equal(values.roughResult.result, 'Running 2/20');
  assert.equal(values.roughResult.time, 0);
  assert.equal(values.submissionPending, true);
  assert.equal(JSON.parse(values.submissionStatusToken).viewerId, 1);
  assert.equal(values.socketToken, null);
});
