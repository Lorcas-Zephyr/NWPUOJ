'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const standings = require('../libs/contest-standings');

function harness(options = {}) {
  let now = 300;
  let freezeMinutes = 2;
  let latestQuery;
  const users = new Map([1, 2, 3, 7, 8, 9].map(id => [id, {
    id, username: 'user' + id, is_admin: id === 1,
    privileges: id === 3 ? ['manage_problem'] : [],
    getPrivileges: async () => [], hasPrivilege: async name => id === 3 && name === 'manage_problem'
  }]));
  const problem = { id: 11, title: 'Problem', getDisplayId: () => '11', getVJudgeLanguages: () => null };
  const contest = { id: 21, holder_id: 1, type: options.type || 'acm', start_time: 100, end_time: 400, is_public: true,
    isSupervisior: async user => !!user && [1, 2].includes(user.id),
    isEnded: () => now >= 400, getProblems: async () => [11],
    allowedSeeingScore: () => options.showScore !== false, allowedSeeingOthers: () => true,
    allowedSeeingResult: () => true, allowedSeeingTestcase: () => false };
  const submissions = [
    { id: 1, user_id: 8, submit_time: 219, status: 'Accepted', score: 100 },
    { id: 2, user_id: 7, submit_time: 220, status: 'Accepted', score: 100 },
    { id: 3, user_id: 8, submit_time: 240, status: 'Wrong Answer', score: 0 },
    { id: 4, user_id: 8, submit_time: 250, status: 'Waiting', score: 40, pending: 1 },
    { id: 5, user_id: 8, submit_time: 255, status: 'Compile Error', score: null }
  ].map(judge => ({ pending: 0, type: 1, type_info: 21, problem_id: 11,
    total_time: 123, max_memory: 456, language: 'cpp', code_length: 99, task_id: 'task-' + judge.id, ...judge }));
  function queryBuilder() {
    const builder = { conditions: [], parameters: {},
      setParameters(values) { Object.assign(this.parameters, values); return this; },
      where(sql, params) { return this.andWhere(sql, params); },
      andWhere(sql, params) { this.conditions.push(sql); return this.setParameters(params); },
      getMany: async () => submissions.map(judge => ({ ...judge })) };
    latestQuery = builder;
    return builder;
  }
  const models = {
    judge_state: { createQueryBuilder: queryBuilder, countQuery: async () => submissions.length,
      queryPage: async () => submissions.map(judge => ({ ...judge })) },
    user: { fromName: async name => [...users.values()].find(user => user.username === name), findById: async id => users.get(id) },
    problem: { findById: async () => ({ ...problem }) }, contest: { findById: async () => contest }
  };
  const routes = new Map();
  const app = { use() {}, get: (route, handler) => routes.set('GET ' + route, handler), post: (route, handler) => routes.set('POST ' + route, handler) };
  const utils = { formatDate: value => String(value), removeTitleTag: value => value,
    paginate: count => ({ count, currPage: 1, perPage: 20 }),
    getJudgeAdminActions: async () => ({}), canParticipateInContest: async (_contest, user) => !!user,
    canViewSubmissionDetail: async (judge, user) => !!user && ([1, 2, 3].includes(user.id) || judge.user_id === user.id),
    contestV2: {
      standingsView: async (_contest, user) => standings.selectStandingsView(
        standings.resolveStandingsFreeze(contest, { security: { standings_freeze_after_minutes: freezeMinutes } }, null, now),
        !!user && [1, 2].includes(user.id))
    },
    apiV2: { send: (res, data) => (res.data = data), fail: (res, status, code) => (res.data = { status, code }) }
  };
  if (options.baseContest !== undefined) utils.baseWorkspace = {
    contains: async (kind, id) => !!options.baseContest && kind === 'contest' && Number(id) === 21,
    canAccessContest: async () => options.baseAccess !== false,
    visibleSubmissions: () => 'BASE_VISIBILITY'
  };
  utils.contestV2.isSubmissionFrozen = async (judge, user) => standings.submissionHiddenByFreeze(judge, await utils.contestV2.standingsView(contest, user), user);
  const judgeCache = { getCachedJudgeState: () => ({ result: 'Running 2/5' }), getCachedJudgeDetail: () => null };
  const syzoj = { utils, config: { session_secret: 'test-only', page: { judge_state: 20 }, filter_enabled_languages: ['cpp'] },
    languages: { cpp: { show: 'C++ 23' } }, model: name => models[name] || {}, log: message => { throw new Error(message); } };
  const processContext = { module: { exports: {} }, syzoj, require: () => judgeCache };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../libs-built/submissions_process.js'), 'utf8'), processContext);
  const dependencies = { jsonwebtoken: { sign: payload => JSON.stringify(payload) },
    '../libs/submissions_process': processContext.module.exports, '../libs/judger': {},
    '../libs/compiler-message': {}, '../libs/contest-standings': standings,
    typeorm: { getConnection: () => ({ query: async sql => /FROM user WHERE/.test(sql) ? [...users.values()] : [] }) } };
  const context = vm.createContext({ app, syzoj, ErrorMessage: Error, Map, Set, console,
    Date: class extends Date { static now() { return now * 1000; } }, require: name => dependencies[name] || require(name) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../modules/_submission_routes.js'), 'utf8'), context);
  return { submissions, users, routes, context,
    setNow: value => { now = value; }, setFreeze: value => { freezeMinutes = value; },
    get query() { return latestQuery; },
    async list(userId, query = {}) {
      let result;
      const res = { locals: { user: users.get(userId) }, status() { return this; }, render: (_view, value) => { result = value; } };
      await routes.get('GET /contest/:id/submissions')({ params: { id: '21' }, query }, res);
      return result;
    },
    statuses: userId => context.getListStatuses(submissions.map(judge => ({ submissionId: judge.id, taskId: judge.task_id, contestId: 21, view: 'list' })), users.get(userId))
  };
}

test('ordinary and temporary participants see their own real verdicts; others see Waiting without results or detail links', async () => {
  const app = harness();
  for (const viewer of [3, 7, 8, 9]) {
    const result = await app.list(viewer, { problem_id: '1' });
    assert.equal(result.items.length, 5);
    for (const [i, item] of result.items.entries()) {
      const judge = app.submissions[i];
      const hidden = judge.submit_time >= 220 && judge.user_id !== viewer;
      if (hidden) {
        assert.deepEqual(item.result, standings.frozenSubmissionResult());
        assert.equal(item.token, null);
        assert.equal(item.running, false);
        assert.equal(item.info.canViewDetail, false);
      } else {
        assert.equal(item.result.result, judge.pending ? 'Running 2/5' : judge.status);
        assert.equal(!!item.token, !!judge.pending);
      }
    }
  }
});

test('site and scoped contest managers always receive real statuses without selecting live standings', async () => {
  const app = harness();
  for (const viewer of [1, 2]) {
    const result = await app.list(viewer);
    for (const [i, item] of result.items.entries()) {
      const judge = app.submissions[i];
      assert.equal(item.result.result, judge.pending ? 'Running 2/5' : judge.status);
      assert.equal(item.result.frozen, undefined);
    }
  }
});

test('previously issued status streams recheck masking for pending and completed submissions, preserving own real progress', async () => {
  const app = harness();
  for (const viewer of [1, 2, 3, 7, 8, 9]) {
    const statuses = await app.statuses(viewer);
    assert.equal(statuses.length, 5);
    for (const [i, status] of statuses.entries()) {
      const judge = app.submissions[i];
      const hidden = viewer > 2 && judge.submit_time >= 220 && judge.user_id !== viewer;
      assert.equal(status.result.result, hidden ? 'Waiting' : judge.pending ? 'Running 2/5' : judge.status);
      assert.equal(status.pending, hidden ? false : !!judge.pending);
      if (hidden) assert.deepEqual(status.result, standings.frozenSubmissionResult());
    }
  }
});

test('ending or disabling freeze reveals list and streamed verdicts, including submissions at the cutoff', async () => {
  const app = harness();
  for (const unfreeze of [() => app.setNow(400), () => { app.setNow(300); app.setFreeze(null); }]) {
    unfreeze();
    assert.equal((await app.list(9)).items[1].result.result, 'Accepted');
    assert.equal((await app.statuses(9))[1].result.result, 'Accepted');
  }
});

test('status and score filters exclude hidden real results, Waiting includes them, managers keep normal filtering', async () => {
  const app = harness();
  await app.list(7, { status: 'Accepted', min_score: '100' });
  const hiddenSql = 'NOT ((js.submit_time >= :freezeAt AND js.user_id != :freezeViewerId))';
  assert.ok(app.query.conditions.includes(hiddenSql));
  assert.equal(app.query.parameters.freezeAt, 220);
  assert.equal(app.query.parameters.freezeViewerId, 7);
  await app.list(7, { status: 'Waiting' });
  assert.ok(app.query.conditions.some(sql => sql.includes('OR (js.status = :filterStatus')));
  for (const viewer of [1, 2]) {
    await app.list(viewer, { status: 'Accepted' });
    assert.equal(app.query.parameters.freezeAt, undefined);
    assert.ok(!app.query.conditions.includes(hiddenSql));
  }
});

test('base ACM participants can filter minimum and maximum scores without exposing a score column', async () => {
  const app = harness({ baseContest: true, showScore: false });
  for (const query of [{ min_score: '0' }, { max_score: '100' }, { min_score: '20', max_score: '80' }, { min_score: '100', max_score: '100' }]) {
    const result = await app.list(7, query);
    assert.equal(result.displayConfig.showScore, false);
    assert.equal(result.displayConfig.showScoreFilter, true);
    assert.equal(result.isFiltered, true);
    assert.equal(app.query.parameters.contestId, 21);
    assert.equal(app.query.parameters.minScore, query.min_score == null ? undefined : Number(query.min_score));
    assert.equal(app.query.parameters.maxScore, query.max_score == null ? undefined : Number(query.max_score));
    assert.ok(app.query.conditions.some(sql => sql.includes('CASE WHEN EXISTS') && sql.includes('THEN 0 ELSE js.score END')));
    assert.ok(app.query.conditions.includes('NOT ((js.submit_time >= :freezeAt AND js.user_id != :freezeViewerId))'));
    assert.equal(app.query.parameters.freezeViewerId, 7);
    assert.equal(result.items[0].result.score, null, 'score disclosure remains unchanged');
  }
});

test('base score filters reject invalid ranges and never bypass membership or hidden NOI scores', async () => {
  const app = harness({ baseContest: true, showScore: false });
  for (const query of [{ min_score: '-1' }, { max_score: '101' }, { min_score: '1.5' }, { min_score: '80', max_score: '20' }]) {
    await assert.rejects(app.list(7, query), /必须是 0 到 100 的整数|最低分不能高于最高分/);
  }
  const outside = harness({ baseContest: true, baseAccess: false, showScore: false });
  const denied = await outside.list(7, { min_score: '0', max_score: '100' });
  assert.match(denied.err.message, /没有权限/);
  assert.equal(outside.query, undefined, 'nonmembers are rejected before querying submissions');
  const normal = harness({ baseContest: false, showScore: false });
  assert.equal((await normal.list(7)).displayConfig.showScoreFilter, false);
  await assert.rejects(normal.list(7, { min_score: '100', workspace: 'base', base: '1' }), /不公开分数筛选/);
  const noi = harness({ baseContest: true, type: 'noi', showScore: false });
  assert.equal((await noi.list(7)).displayConfig.showScoreFilter, false);
  await assert.rejects(noi.list(7, { min_score: '100' }), /不公开分数筛选/);
  const manager = await noi.list(1, { min_score: '0', max_score: '100' });
  assert.equal(manager.displayConfig.showScoreFilter, true);
  assert.equal(noi.query.parameters.freezeAt, undefined);
  noi.setNow(400);
  assert.equal((await noi.list(7, { min_score: '0' })).displayConfig.showScoreFilter, true);
});

test('visibility polling authorizes the viewer and reports unfreeze for terminal Waiting rows', async () => {
  const app = harness();
  const route = app.routes.get('GET /api/v2/contests/:id/submission-visibility');
  const res = { locals: { user: app.users.get(7) }, setHeader() {} };
  await route({ params: { id: '21' } }, res);
  assert.equal(res.data.frozen, true);
  assert.equal(res.data.canManage, false);
  app.setNow(400);
  await route({ params: { id: '21' } }, res);
  assert.equal(res.data.frozen, false);
  app.setNow(300);
  res.locals.user = null;
  await route({ params: { id: '21' } }, res);
  assert.equal(res.data.status, 403);
});

test('v2 serialization removes sealed verdict, usage and completion time; detail readers cannot bypass freeze with judge privileges', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_submission_domain.js'), 'utf8');
  let frozen = true;
  const context = vm.createContext({
    submissionDomain: require('../libs/submission-domain'),
    syzoj: { utils: {
      apiV2: { databaseIso: value => value },
      contestV2: { isSubmissionFrozen: async () => frozen },
      authorizationV2: { authorize: async () => true }
    } }
  });
  vm.runInContext(source.slice(source.indexOf('function publicSubmission('), source.indexOf('function publishDomainEvent(')), context);
  vm.runInContext(source.slice(source.indexOf('async function canViewSubmission('), source.indexOf('async function canViewSubmissionDiagnostics(')), context);
  const row = { submission_id: 2, user_id: 7, contest_id: 21, problem_id: 11, submit_time: 220,
    status: 'accepted', score: 100, total_time: 123, max_memory: 456, updated_at: 'completion time' };
  const hidden = context.publicSubmission(row, 8, { frozen: true });
  assert.equal(hidden.status, 'queued');
  assert.equal(hidden.frozen, true);
  for (const field of ['score', 'total_time', 'memory', 'updated_at']) assert.equal(hidden[field], null);
  assert.equal(hidden.source, undefined);
  const visible = context.publicSubmission(row, 7);
  assert.equal(visible.status, 'accepted');
  assert.equal(visible.score, 100);
  assert.equal(await context.canViewSubmission(row, { id: 8 }), false);
  assert.equal(await context.canViewSubmission(row, { id: 7 }), true);
  frozen = false;
  assert.equal(await context.canViewSubmission(row, { id: 8 }), true);
});
