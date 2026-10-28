'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

function serviceHarness() {
  const members = new Set([2, 3]);
  const problems = new Map([[11, { id: 11, user_id: 2, is_public: false }], [12, { id: 12, user_id: 2, is_public: true }], [13, { id: 13, user_id: 3, is_public: true }], [20, { id: 20, user_id: 2, is_public: true }]]);
  const contests = new Map([[21, { id: 21, holder_id: 2, is_public: true, admins: '3' }]]);
  const activeProblems = new Set();
  const db = { query: async (sql, args = []) => {
    if (sql.startsWith('CREATE TABLE')) return [];
    if (sql.includes('FROM base_workspace_member')) return members.has(args[0]) ? [{ user_id: args[0] }] : [];
    if (sql.includes('FROM base_workspace_problem')) return args[0] >= 11 && args[0] <= 13 ? [{ problem_id: args[0] }] : [];
    if (sql.includes('FROM base_workspace_contest')) return contests.has(args[0]) ? [{ contest_id: args[0] }] : [];
    if (sql.startsWith('SELECT id FROM contest')) return activeProblems.has(Number(String(args[0]).replace(/[^0-9]/g, ''))) ? [{ id: 21 }] : [];
    throw new Error(sql);
  } };
  const syzoj = { siteOwnerUserId: 1, model: kind => ({ findById: async id => (kind === 'problem' ? problems : contests).get(id) }) };
  const context = { module: { exports: {} }, syzoj, require(name) {
    if (name === 'typeorm') return { getConnection: () => db };
    if (name === './request-read-cache') return { memo: (_, fn) => fn() };
    if (name === './contest-temp-accounts') return require('../libs/contest-temp-accounts');
    throw new Error(name);
  } };
  vm.runInNewContext(read('libs/base-workspace.js'), context);
  return { base: context.module.exports, members, problems, contests, activeProblems, syzoj };
}

test('membership matrix: site admin/owner bypass; unrelated managers, anonymous and removed authors do not', async () => {
  const { base, members, problems } = serviceHarness();
  assert.equal(await base.isMember(null), false);
  assert.equal(await base.isMember({ id: 1 }), true);
  assert.equal(await base.isMember({ id: 8, is_admin: true }), true);
  assert.equal(await base.isMember({ id: 4, privileges: ['manage_user', 'manage_problem', 'manage_contest'] }), false);
  assert.equal(await base.canReadProblem(problems.get(11), { id: 2 }), true);
  assert.equal(await base.canReadProblem(problems.get(11), { id: 3 }), false);
  assert.equal(await base.canReadProblem(problems.get(12), { id: 3 }), true);
  assert.equal(await base.canManage('problem', problems.get(12), { id: 3 }), false);
  assert.equal(await base.canManage('problem', problems.get(12), { id: 2 }), true);
  members.delete(2);
  assert.equal(await base.canReadProblem(problems.get(11), { id: 2 }), false);
  assert.equal(await base.canManage('problem', problems.get(12), { id: 2 }), false);
  assert.equal(await base.canAccessContest(21, { id: 2 }), false);
  assert.equal(await base.canAccessSubmission({ user_id: 2, problem_id: 12, type: 1, type_info: 21 }, { id: 2 }), false);
  assert.equal(await base.canAccessSubmission({ user_id: 2, problem_id: 12, type: 0 }, { id: 2 }), false);
});

test('legacy request-local editor elevation cannot grant base membership or manage other members content', async () => {
  const { base, contests } = serviceHarness();
  const elevated = Object.create({ id: 4, is_admin: false }); elevated.is_admin = true;
  assert.equal(base.isAdmin(elevated), false);
  assert.equal(await base.isMember(elevated), false);
  assert.equal(await base.canManage('contest', contests.get(21), elevated), false);
  assert.equal(await base.canManage('contest', contests.get(21), { id: 3, is_admin: false }), false);
});

test('workspace capabilities grant manage-own locally without granting global create or catalog administration', async () => {
  const { base } = serviceHarness();
  const owner = { id: 2 };
  for (const capability of ['problem:edit', 'problem:publish', 'problem:archive', 'problem:testdata.write', 'problem:delete']) {
    assert.equal(await base.authorize(owner, capability, {}, 'problem:11'), true);
    assert.equal(await base.authorize({ id: 3 }, capability, {}, 'problem:11'), false);
  }
  for (const capability of ['contest:edit', 'contest:delete', 'contest:registration.manage', 'contest:standings.export']) {
    assert.equal(await base.authorize(owner, capability, {}, 'contest:21'), true);
    assert.equal(await base.authorize({ id: 3 }, capability, {}, 'contest:21'), false);
  }
  assert.equal(await base.authorize(owner, 'problem:create', null, 'global'), null);
  assert.equal(await base.authorize(owner, 'submission:create', {}, 'problem:11'), true);
  assert.equal(await base.authorize({ id: 3 }, 'submission:create', {}, 'problem:12'), true);
  assert.equal(await base.authorize({ id: 3 }, 'submission:create', {}, 'problem:11'), false);
  assert.equal(await base.authorize({ id: 4 }, 'submission:create', {}, 'problem:12'), false);
  assert.equal(await base.authorize(owner, 'problem:tag.catalog.manage', {}, 'problem:11'), false);
  assert.equal(await base.allowCreate({ body: { workspace: 'base' } }, owner), true);
  assert.equal(await base.allowCreate({ body: { workspace: 'global' } }, owner), false);
  assert.equal(await base.allowCreate({ body: { workspace: 'base' } }, { id: 4 }), false);
});

test('contest selection requires base-published problems and rejects base problems in normal contests', async () => {
  const { base, problems } = serviceHarness();
  assert.equal(await base.validContestProblem(problems.get(11), true), false);
  assert.equal(await base.validContestProblem(problems.get(12), true), true);
  assert.equal(await base.validContestProblem(problems.get(13), true), true);
  assert.equal(await base.validContestProblem(problems.get(20), true), false);
  assert.equal(await base.validContestProblem(problems.get(12), false), false);
  assert.equal(await base.validContestProblem(problems.get(20), false), true);
});

test('contest selection is revalidated under a row lock and referenced base problems cannot become private', async () => {
  const { base } = serviceHarness();
  let rows = [{ id: 12, is_public: 1, base_id: 12 }];
  const manager = { query: async sql => { assert.match(sql, /FOR UPDATE/); return rows; } };
  await base.validateContestSelection(manager, [12], true);
  await assert.rejects(base.validateContestSelection(manager, [12], false), { code: 'CONTEST_PROBLEM_SCOPE_INVALID' });
  rows = [{ id: 12, is_public: 0, base_id: 12 }];
  await assert.rejects(base.validateContestSelection(manager, [12], true), { code: 'CONTEST_PROBLEM_SCOPE_INVALID' });
  rows = [];
  await assert.rejects(base.validateContestSelection(manager, [12], true), { code: 'CONTEST_PROBLEM_SCOPE_INVALID' });
  const queries = [];
  await assert.rejects(base.assertMayHideProblem({ query: async (sql, args) => { queries.push([sql, args]); return [{ id: 21 }]; } }, 12), { code: 'BASE_PROBLEM_IN_USE' });
  assert.match(queries[0][0], /FOR UPDATE/);
  assert.equal(queries[1][1][0], '%|12|%');
  await base.assertMayHideProblem({ query: async () => [] }, 12);
});

test('old operation responses recheck current membership and unpublished problem visibility', async () => {
  const { base, members } = serviceHarness();
  const created = { path: '/api/v2/problems', response_json: JSON.stringify({ data: { problem: { id: 11 } } }) };
  assert.equal(await base.canReadOperation(created, { id: 2 }), true);
  assert.equal(await base.canReadOperation(created, { id: 3 }), false);
  assert.equal(await base.canReadOperation({ path: '/api/v2/base/members' }, { id: 2 }), false);
  assert.equal(await base.canReadOperation({ path: '/api/v2/base/members' }, { id: 1 }), true);
  members.delete(2);
  assert.equal(await base.canReadOperation(created, { id: 2 }), false);
  assert.equal(await base.canReadOperation({ path: '/api/v2/contests/21/update' }, { id: 2 }), false);
  assert.equal(await base.canReadOperation({ path: '/api/v2/contests', response_json: '{"data":{"id":21}}' }, { id: 2 }), false);
  assert.equal(await base.canReadOperation({ path: '/api/v2/problems/20/update' }, { id: 2 }), true);
});

test('CSV validates header, BOM, duplicates, invalid rows, bounds and quoted cells without dropping valid rows', () => {
  const { base } = serviceHarness();
  const entries = base.csvEntries(Buffer.from('\uFEFF姓名,学号\r\n甲,"2026000001"\r\n乙,invalid\r\n丙,2026000001\r\n丁,2026000002\r\n'));
  assert.equal(entries.length, 4);
  assert.equal(entries[0].reason, null);
  assert.equal(entries[1].row, 3);
  assert.match(entries[1].reason, /10 位/);
  assert.match(entries[2].reason, /重复/);
  assert.equal(entries[3].student_id, '2026000002');
  assert.throws(() => base.csvEntries(Buffer.from('姓名\n甲')), /表头/);
  assert.throws(() => base.csvEntries(Buffer.from('学号\n')), /1 至 1000/);
  assert.throws(() => base.csvEntries(Buffer.from('学号\n' + '2026000001\n'.repeat(1001))), /1000/);
  assert.throws(() => base.csvEntries(Buffer.from('学号\n"123')), /引号/);
});

test('member revocation closes active connections immediately and normal SQL gates both contest and problem scope', () => {
  const { base } = serviceHarness();
  let ended = 0;
  const response = new EventEmitter(); response.end = () => { ended++; response.emit('close'); };
  base.trackConnection(2, response); base.revokeConnections([2]); base.revokeConnections([2]);
  assert.equal(ended, 1);
  const sql = base.visibleSubmissions('js', { id: 2 });
  assert.match(sql, /base_workspace_contest/);
  assert.match(sql, /base_workspace_problem/);
  assert.match(sql, /bm.user_id=2/);
  assert.match(sql, /bp.is_public=1 OR bp.user_id=2/);
});

test('base practice scope keeps normal and contest submissions out and rechecks privacy and active contests', async () => {
  const { base, members, activeProblems } = serviceHarness();
  const record = { id: 100, type: 0, user_id: 3, problem_id: 12 };
  assert.equal(await base.canReadPracticeSubmission(record, null), false);
  assert.equal(await base.canReadPracticeSubmission(record, { id: 4, privileges: ['manage_problem'] }), false);
  assert.equal(await base.canReadPracticeSubmission({ ...record, problem_id: 20 }, { id: 1 }), false);
  assert.equal(await base.canReadPracticeSubmission({ ...record, type: 1 }, { id: 1 }), false);
  assert.equal(await base.canReadPracticeSubmission({ ...record, problem_id: 11 }, { id: 3 }), false, 'hidden problem remains hidden even for submission author');
  assert.equal(await base.canReadPracticeSubmission(record, { id: 3 }), true);
  activeProblems.add(13);
  const active = { ...record, user_id: 1, problem_id: 13 };
  assert.equal(await base.canReadPracticeSubmission(active, { id: 2 }), false, 'active contest hides others practice');
  assert.equal(await base.canReadPracticeSubmission(active, { id: 3 }), true, 'problem author retains practice access');
  assert.equal(await base.canReadPracticeSubmission({ ...active, user_id: 2 }, { id: 2 }), true, 'own practice remains visible');
  assert.equal(await base.canReadPracticeSubmission(active, { id: 1 }), true);
  activeProblems.delete(13);
  assert.equal(await base.canReadPracticeSubmission(active, { id: 2 }), true);
  members.delete(2);
  assert.equal(await base.canReadPracticeSubmission(active, { id: 2 }), false, 'revocation affects already-issued tokens');
  const scoped = base.practiceSubmissionScope('js', { id: 2 });
  for (const clause of ['js.type=0', 'base_workspace_problem', 'bm.user_id=2', 'bp.is_public=1 OR bp.user_id=2', 'js.user_id=2', 'p.user_id=2', 'active_contest.end_time>UNIX_TIMESTAMP()']) assert.ok(scoped.includes(clause), clause);
  const admin = base.practiceSubmissionScope('js', { id: 1 });
  assert.match(admin, /js\.type=0/);
  assert.match(admin, /base_workspace_problem/);
  assert.doesNotMatch(admin, /active_contest|bm\.user_id/);
});

test('actual early HTTP guard denies anonymous, removed and encoded-route access including testdata, jobs and sources', async () => {
  const fixture = serviceHarness();
  fixture.base.migrationStates = async () => new Map();
  let middleware;
  const context = { app: { use: fn => { middleware = fn; } }, ErrorMessage: Error,
    syzoj: { ...fixture.syzoj, utils: {}, model: kind => kind === 'judge_state' ? { findById: async () => ({ problem_id: 12, type: 1, type_info: 21 }) } : fixture.syzoj.model(kind) },
    require(name) {
      if (name === '../libs/base-workspace') return fixture.base;
      if (name === 'typeorm') return { getConnection: () => ({ query: async () => [{ problem_id: 12 }] }) };
      throw new Error(name);
    }
  };
  vm.runInNewContext(read('modules/_base_access.js'), context);
  async function access(path, user, method = 'GET') {
    const res = { locals: { user }, set() {}, status(value) { this.code = value; return this; }, json(value) { this.data = value; return this; }, render() {}, once() {} };
    let proceeded = false;
    await middleware({ path, method, query: {} }, res, error => { if (error) throw error; proceeded = true; });
    return { res, proceeded };
  }
  for (const route of ['/base', '/base/members', '/base/submissions', '/BASE/submissions', '/api/v2/base/users/search', '/problem/12', '/Problem/12', '/problem/%31%32', '/problem/12/export', '/problem/12/testdata/download', '/contest/21/ranklist', '/contest/21/details', '/contest/21/problem/1', '/api/v2/contests/21/standings', '/submission/1', '/contest/submission/1', '/api/v2/submissions/1/events']) {
    for (const user of [null, { id: 4, privileges: ['manage_contest'] }]) {
      const result = await access(route, user); assert.equal(result.proceeded, false, route); assert.equal(result.res.code, 403, route);
    }
  }
  assert.equal((await access('/problem/12', { id: 3 })).proceeded, true);
  assert.equal((await access('/base/submissions', { id: 3 })).proceeded, true);
  assert.equal((await access('/submission/1', { id: 3 })).res.locals.baseContext, true);
  assert.equal((await access('/problem/11', { id: 3 })).proceeded, false);
  assert.equal((await access('/problem/12/testdata/download', { id: 3 })).proceeded, false);
  assert.equal((await access('/problem/12/testdata/download', { id: 2 })).proceeded, true);
  assert.equal((await access('/api/v2/contests/21/rating-preview', { id: 1 }, 'POST')).proceeded, false);
  assert.equal((await access('/api/v2/contests/21/temporary-accounts', { id: 1 }, 'POST')).proceeded, false);
  fixture.members.delete(2);
  assert.equal((await access('/contest/21/edit', { id: 2 })).proceeded, false);
});

test('creation mapping is inside the resource transaction, all rating paths and global discovery are scoped', () => {
  const problem = read('modules/_api_v2_problem_domain.js');
  const contest = read('libs/contest-mutation.js');
  const contestApi = read('modules/_api_v2_contest_domain.js');
  assert.match(problem, /transaction\(async manager[\s\S]*createProblemAggregate[\s\S]*INSERT INTO base_workspace_problem/);
  assert.match(contest, /withTransactionRetry\(async manager[\s\S]*INSERT INTO base_workspace_contest/);
  assert.match(contestApi, /baseWorkspace: baseContest/);
  assert.match(contestApi, /baseContest \? false/);
  assert.match(contestApi, /contains\('contest', contest.id\)\) next.rated_profile = null/);
  assert.match(read('libs/contest-rating.js'), /canonicalStandings[\s\S]*baseWorkspace.contains\('contest'/);
  assert.match(read('modules/_api_v2_search.js'), /baseSearch !== baseProblem/);
  assert.match(read('libs-built/problem_repositories.js'), /outside\('problem'/);
  assert.match(read('modules/_base_workspace.js'), /outside\('contest'/);
  assert.match(read('modules/_problem_sets.js'), /基地题目不能加入普通题单/);
  assert.match(read('modules/api_v2.js'), /base.canReadProblem[\s\S]*base.canAccessContest/);
});

test('all member writes require site admin, audit atomically, and removal never deletes users or content', () => {
  const source = read('modules/_base_workspace.js');
  for (const suffix of ['', '/import-classes', '/import-csv', '/remove']) assert.ok(source.includes("app.post('/api/v2/base/members" + suffix + "', requireAdmin"));
  assert.match(source, /if \(!base.isAdmin\(res.locals.user\)\)/);
  assert.match(source, /transaction\(async db[\s\S]*INSERT IGNORE INTO base_workspace_member[\s\S]*recordAudit/);
  assert.match(source, /DELETE FROM base_workspace_member[\s\S]*recordAudit/);
  assert.doesNotMatch(source, /DELETE FROM (user|problem|contest|judge_state)\b/);
  assert.match(source, /matches.length === 1/);
  assert.match(source, /LIMIT 100 OFFSET/);
});
