'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const auth = require('../libs/authorization-v2');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function section(file, start, end) {
  const source = read(file), from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}

function fixture() {
  const routes = new Map(), writes = [], scheduled = [], denied = new Set();
  let accessible = true, frozen = false;
  class Problem {
    async isAllowedEditBy() { return false; }
    async isAllowedUseBy() { return false; }
    async isAllowedManageBy() { return false; }
    static async findById(id) { return problems.get(id) || null; }
  }
  const problems = new Map([11, 12].map(id => [id, Object.assign(new Problem(), { id, user_id: id === 11 ? 2 : 3, is_public: false })]));
  const judges = new Map([
    [101, { id: 101, problem_id: 11, user_id: 3, type: 0, is_public: false }],
    [102, { id: 102, problem_id: 12, user_id: 2, type: 0, is_public: false }],
    [103, { id: 103, problem_id: 11, user_id: 3, type: 1, type_info: 21, is_public: false }],
    [104, { id: 104, problem_id: 11, user_id: 3, type: 1, type_info: 22, is_public: false }]
  ]);
  const users = new Map([1, 2, 3, 4, 5, 6, 7, 8].map(id => [id, { id, is_admin: id === 1, hasPrivilege: async () => false }]));
  const contest = { id: 21, holder_id: 6, admins: '7', isSupervisior: async user => !!user && [6, 7].includes(user.id) };
  class JudgeState {
    static async findById(id) { return judges.get(id) || null; }
    async loadRelationships() { this.problem = problems.get(this.problem_id); this.user = users.get(this.user_id); }
    async isAllowedVisitBy() { await this.loadRelationships(); return false; }
  }
  for (const [id, data] of judges) judges.set(id, Object.assign(new JudgeState(), data, {
    code: 'int main() {}', compilation: 'compile details', result: { compile: { message: 'compile details' } }
  }));
  const manager = { query: async (sql, args) => {
    if (sql.startsWith('SELECT id,admins')) return args[0] === 21 ? [contest] : [];
    if (sql.includes('FROM submission_v2_projection')) return [{ ...judges.get(args[0]), submission_id: args[0], source_visibility: 'private' }];
    if (sql.includes('FROM submission_v2_result_revision')) return [];
    writes.push({ sql, args }); return {};
  } };
  const utils = {
    baseWorkspace: { contains: async () => false, canAccessSubmission: async () => accessible, authorize: async () => null },
    contestV2: { isSubmissionFrozen: async () => frozen },
    operationReason: () => 'Uploader rejudge regression',
    apiV2: {
      fail: (res, status, code) => { res.status = status; res.error = code; },
      send: (res, data, status = 200) => { res.status = status; res.data = data; },
      publishEvent() {}, parseLimit: () => 10, decodeCursor: () => null, databaseIso: value => value
    }
  };
  const syzoj = { utils, siteOwnerUserId: 1, model: name => {
    assert.equal(name, 'problem'); return Problem;
  } };
  const context = vm.createContext({ ...auth, syzoj, Problem, judgeStatus: require('../libs/judge-status'),
    Contest: { findById: async id => id === 21 ? contest : null },
    JudgeState,
    TypeORM: { getConnection: () => ({ ...manager, transaction: fn => fn(manager) }) },
    effectiveCapabilities: async user => user.id === 1 ? ['*'] : user.id === 4 ? ['judge:read', 'submission:rejudge'] : user.id === 5 ? ['judge:read'] : [],
    policyDecision: async (_user, capability) => ({ effect: denied.has(capability) ? 'deny' : null }),
    requestReads: { memo: (_key, fn) => fn() },
    ensureSubmissionSchema: async () => {},
    projectStatus: async () => {},
    hasValidAcceptedSubmission: async () => false,
    hasAccessiblePublishedProblemSet: async () => false,
    crypto: { randomUUID: () => 'fixture-job' },
    setImmediate: fn => scheduled.push(fn),
    submissionDomain: { ...require('../libs/submission-domain'), appendEvent: async (_manager, input) => input },
    app: { post: (route, fn) => routes.set(route, fn), get: (route, fn) => routes.set(route, fn) }
  });
  vm.runInContext(section('modules/_api_v2_authorization.js', 'async function assignedContestAdministratorAllows(', 'function recentLoginSatisfied('), context);
  utils.authorizationV2 = { authorize: context.authorize, recentLoginSatisfied: () => true, recordAudit: async () => 'fixture-audit' };
  vm.runInContext(section('modules/_judge_admin_action.js', 'async function canAccessProblemSubmission(', 'function operationReason('), context);
  utils.canManageJudgeAction = context.canManageJudgeAction;
  vm.runInContext(section('modules/_user_privilege_loader.js', 'const originalProblemEdit =', '\nensureSiteOwner()'), context);
  vm.runInContext(section('modules/_submission_visibility.js', 'const originalAllowedVisit =', 'async function guardSubmissionDetail('), context);
  vm.runInContext(section('modules/_submission_visibility.js', 'async function canViewSubmissionDetail(', 'async function problemSetSubmissionContext('), context);
  vm.runInContext(section('modules/_api_v2_submission_domain.js', 'async function canViewSubmission(', 'function validLanguage('), context);
  vm.runInContext(section('modules/_api_v2_submission_domain.js', 'function publicSubmission(', 'function publishDomainEvent('), context);
  vm.runInContext(section('modules/_api_v2_submission_domain.js', "app.get('/api/v2/submissions/:id',", "app.get('/api/v2/submissions/:id/testpoints'"), context);
  vm.runInContext(section('modules/_api_v2_submission_domain.js', "app.post('/api/v2/submissions/:id/rejudge'", 'async function runProjectionRebuildJob('), context);
  vm.runInContext(section('modules/_api_v2_submission_domain.js', "app.get('/api/v2/submissions/:id/testpoints'", "app.get('/api/v2/submissions/:id/events'"), context);
  return { context, utils, users, problems, judges, contest, writes, scheduled, denied,
    accessible(value) { accessible = value; }, frozen(value) { frozen = value; },
    async request(route, userId, judgeId = 101, body = {}) {
      const res = { locals: { user: users.get(userId), apiMeta: {} } };
      await routes.get(route)({ params: { id: String(judgeId) }, query: {}, body, res }, res);
      return res;
    }
  };
}

test('problem uploaders keep problem management after upload privileges are removed', async () => {
  const f = fixture();
  for (const method of ['isAllowedEditBy', 'isAllowedManageBy']) {
    assert.equal(await f.problems.get(11)[method](f.users.get(2)), true);
    assert.equal(await f.problems.get(12)[method](f.users.get(2)), false);
    assert.equal(await f.problems.get(11)[method](null), false);
    f.denied.add('problem:edit');
    assert.equal(await f.problems.get(11)[method](f.users.get(2)), false);
    f.denied.clear();
  }
});

test('uploaders manage only submissions for their own problems, including contest submissions', async () => {
  const f = fixture();
  for (const id of [101, 103]) {
    assert.equal(await f.utils.canManageJudgeAction(f.users.get(2), f.judges.get(id)), true);
    assert.equal(await f.utils.canReadJudgeDetails(f.users.get(2), f.judges.get(id)), true);
  }
  assert.equal(await f.utils.canManageJudgeAction(f.users.get(2), f.judges.get(102)), false, 'submission author is not the problem uploader');
  assert.equal(await f.utils.canManageJudgeAction(f.users.get(3), f.judges.get(101)), false);
  assert.equal(await f.utils.canManageJudgeAction(null, f.judges.get(101)), false);
  for (const id of [1, 4]) assert.equal(await f.utils.canManageJudgeAction(f.users.get(id), f.judges.get(102)), true);
  assert.equal(await f.utils.canManageJudgeAction(f.users.get(6), f.judges.get(103)), true, 'contest manager preserved');
  for (const capability of ['submission:rejudge', 'judge:read', 'admin:job.manage']) {
    assert.equal(await f.context.authorize(f.users.get(2), capability, null, {}), false, 'no global grants');
  }
  f.problems.get(11).user_id = 3;
  assert.equal(await f.utils.canManageJudgeAction(f.users.get(2), f.judges.get(101)), false, 'ownership is read from saved problem, not judge or request');
});

test('scoped submission ownership cannot be confused with global, contest or submission ownership', () => {
  const user = { id: 2 };
  for (const capability of ['submission:rejudge', 'judge:read']) {
    assert.equal(auth.resourceOwnerAllows(user, capability, { id: 11, ownerId: 2, scope: 'problem:11' }), true);
    for (const resource of [{ ownerId: 2 }, { id: 11, ownerId: 2, scope: 'global' },
      { id: 11, ownerId: 2, scope: 'submission:11' }, { id: 11, ownerId: 2, scope: 'contest:11' },
      { id: 12, ownerId: 2, scope: 'problem:11' }]) {
      assert.equal(auth.resourceOwnerAllows(user, capability, resource), false);
    }
    assert.equal(auth.resourceOwnerAllows(user, capability, { id: 11, ownerId: 2, scope: 'problem:11' }, 'problem:12'), false);
  }
});

test('actual rejudge API queues and audits uploader jobs but denies submitter-only, forged and missing targets', async () => {
  const f = fixture(), route = '/api/v2/submissions/:id/rejudge';
  for (const id of [101, 103]) {
    const res = await f.request(route, 2, id);
    assert.equal(res.status, 202);
    assert.equal(res.data.submission_id, id);
    assert.equal(res.data.audit_event_id, 'fixture-audit');
  }
  assert.equal(f.scheduled.length, 2);
  const inserts = f.writes.filter(row => row.sql.startsWith('INSERT INTO submission_v2_job'));
  assert.deepEqual(inserts.map(row => Array.from(row.args)), [101, 103].map(id => ['fixture-job', id, 2, 'Uploader rejudge regression']));
  const before = f.writes.length;
  assert.equal((await f.request(route, 3)).status, 403);
  assert.equal((await f.request(route, 2, 102, { problem_id: 11, ownerId: 2 })).status, 403);
  assert.equal((await f.request(route, null)).status, 401);
  assert.equal((await f.request(route, 2, 999)).status, 404);
  assert.equal(f.writes.length, before);
});

test('explicit denies and workspace access restrictions still block uploader management', async () => {
  const f = fixture(), route = '/api/v2/submissions/:id/rejudge';
  f.denied.add('submission:rejudge');
  assert.equal((await f.request(route, 2)).status, 403);
  assert.equal((await f.request(route, 2, 103)).status, 403);
  f.denied.clear(); f.accessible(false);
  for (const userId of [1, 2, 4, 6]) {
    assert.equal((await f.request(route, userId, 103)).status, 403);
    assert.equal(await f.utils.canReadJudgeDetails(f.users.get(userId), f.judges.get(103)), false);
  }
  assert.equal(f.writes.length, 0);
});

test('uploader can view private testpoints and result history without exposing other problems', async () => {
  const f = fixture();
  for (const route of ['/api/v2/submissions/:id/testpoints', '/api/v2/submissions/:id/result-revisions']) {
    assert.equal((await f.request(route, 2)).status, 200);
    assert.equal((await f.request(route, 6)).status, 403);
    f.frozen(true);
    assert.equal((await f.request(route, 2, 103)).status, 200);
    assert.equal((await f.request(route, 5, 103)).status, 403, 'read-only global privilege does not bypass freeze');
    f.frozen(false);
  }
  f.accessible(false);
  assert.equal((await f.request('/api/v2/submissions/:id/result-revisions', 2)).status, 403);
});

test('contest creator and assigned managers read private code, testpoints and history only within that contest', async () => {
  const f = fixture();
  for (const frozen of [false, true]) {
    f.frozen(frozen);
    for (const userId of [6, 7]) {
      assert.equal(await f.context.canViewSubmissionDetail(f.judges.get(103), f.users.get(userId)), true);
      for (const route of ['/api/v2/submissions/:id', '/api/v2/submissions/:id/testpoints', '/api/v2/submissions/:id/result-revisions']) {
        const res = await f.request(route, userId, 103);
        assert.equal(res.status, 200, `${route}, manager ${userId}`);
        if (route === '/api/v2/submissions/:id') {
          assert.equal(res.data.source, 'int main() {}');
          assert.equal(res.data.compilation, 'compile details');
          assert.ok(res.data.result);
        }
        assert.equal((await f.request(route, userId, 104)).status, 403, 'other contest');
        assert.equal((await f.request(route, userId, 101)).status, 403, 'practice submission for same problem');
        assert.equal((await f.request(route, 8, 103)).status, 403, 'unrelated user');
      }
    }
  }
  f.contest.admins = '';
  assert.equal((await f.request('/api/v2/submissions/:id', 7, 103)).status, 403, 'assignment removal applies immediately');
  f.denied.add('contest:edit');
  assert.equal((await f.request('/api/v2/submissions/:id', 6, 103)).status, 403, 'explicit policy deny');
  f.denied.clear(); f.accessible(false);
  assert.equal((await f.request('/api/v2/submissions/:id', 6, 103)).status, 403, 'workspace gate');
});

test('scoped detail permission loads relationships before the legacy controller reads judge.problem', async () => {
  for (const userId of [2, 6, 7]) {
    const f = fixture(), judge = f.judges.get(103), user = f.users.get(userId);
    assert.equal(judge.problem, undefined, 'findById does not hydrate relations');
    assert.equal(await judge.isAllowedVisitBy(user), true);
    assert.equal(judge.problem, f.problems.get(11));
    assert.equal(judge.user, f.users.get(3));
    assert.equal(await judge.problem.isAllowedEditBy(user), userId === 2, 'legacy controller can read the related problem without crashing');
    assert.equal(user.is_admin, false);
  }
  const f = fixture();
  assert.equal(await f.judges.get(103).isAllowedVisitBy(f.users.get(8)), false);
});
