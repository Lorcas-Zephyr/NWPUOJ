'use strict';

// Execute the actual authorization, editor guard and save entry point with
// isolated resources; no production accounts or permissions are modified.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const auth = require('../libs/authorization-v2');
const standings = require('../libs/contest-standings');
const requestReads = require('../libs/request-read-cache');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function section(file, from, to) {
  const source = read(file), start = source.indexOf(from), end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, from);
  return source.slice(start, end);
}

function harness() {
  const queries = [], writes = [], contests = new Map(), users = new Map(), problems = new Map();
  const baseMembers = new Set([2, 3, 4]);
  let deny = false;
  class Contest {
    static async findById(id) { queries.push(id); return contests.get(id) || null; }
    async isSupervisior(user) {
      return !!user && (user.is_admin || this.holder_id === user.id || this.admins.split('|').includes(String(user.id)));
    }
  }
  for (const [id, holder, admins] of [[21, 2, '3|4'], [22, 4, ''], [23, 2, ''], [31, 2, '3|4']]) {
    contests.set(id, Object.assign(new Contest(), { id, holder_id: holder, admins,
      title: 'Test contest', type: 'acm', start_time: 100, end_time: 400,
      is_public: true, getProblems: async () => [11] }));
  }
  for (const id of [11, 12, 13, 14]) problems.set(id, { id, isAllowedUseBy: async () => id === 12 || id === 14 });
  for (const id of [1, 2, 3, 4, 5, 6, 8, 13]) {
    const privileges = [4, 5].includes(id) ? ['manage_contest'] : [];
    users.set(id, { id, is_admin: id === 8, privileges, hasPrivilege: async name => privileges.includes(name) });
  }
  const base = {
    contains: async (kind, id) => kind === 'contest' && Number(id) === 31,
    validContestProblem: async (problem, baseContest) => baseContest || problem.id !== 14,
    canManage: async (_kind, contest, user) => !!user && (user.is_admin || user.id === 1 || baseMembers.has(user.id) && user.id === contest.holder_id),
    async authorize(user, capability, _resource, scope) {
      const normalized = auth.normalizeScope(scope);
      if (normalized.type !== 'contest' || Number(normalized.id) !== 31) return null;
      return base.canManage('contest', contests.get(31), user);
    }
  };
  const syzoj = { siteOwnerUserId: 1, model: kind => { assert.equal(kind, 'contest'); return Contest; }, utils: {
    baseWorkspace: base,
    contestV2: { ensureConfig: async () => ({ security: { standings_freeze_after_minutes: null, medal_percentages: {} } }) },
    apiV2: {
      fail: (res, status, code, message) => { res.statusCode = status; res.error = { code, message }; },
      ifMatch: req => req.body.if_match === 'current-version',
      ensureFoundationSchema: async () => {},
      send: (res, data, status) => { res.data = data; res.statusCode = status; }
    }
  } };
  const context = vm.createContext({ ...auth, Contest, syzoj, requestReads, ErrorMessage: Error,
    effectiveCapabilities: async user => user.id === 1 ? ['*'] : [
      ...auth.BUILT_IN_ROLES.member, ...auth.legacyPrivilegeCapabilities(user.privileges),
      ...(user.is_admin ? auth.BUILT_IN_ROLES.site_admin : [])
    ],
    policyDecision: async () => ({ effect: deny ? 'deny' : null }),
    stateFor: async () => ({ status: 'draft' }),
    serializeContest: contest => ({ id: contest.id, title: contest.title, admins: contest.admins }),
    loadContestConfig: async () => ({ security: { standings_freeze_after_minutes: null },
      registration: { enabled: true }, scoring: { problems: [{ problem_id: 11, score: 1 }] } }),
    normalizeFreezeAfterMinutes: standings.normalizeFreezeAfterMinutes,
    normalizeMedalPercentages: standings.normalizeMedalPercentages,
    instant: (_value, fallback) => fallback * 1000,
    plainObject: value => !!value && typeof value === 'object' && !Array.isArray(value),
    contestConfigurationLocked: () => false,
    lifecycleFor: () => 'draft',
    ensureContestV2Schema: async () => {},
    invalidateRegistrationReadState: () => {},
    Problem: { findById: async id => problems.get(id) || null },
    User: { findById: async id => users.get(id) || null },
    TypeORM: { getConnection: () => ({ query: async (sql, args) => {
      if (sql === 'SELECT id,admins FROM contest WHERE id=? LIMIT 1') {
        queries.push(args[0]);
        const contest = contests.get(args[0]);
        return contest ? [{ id: contest.id, admins: contest.admins }] : [];
      }
      assert.match(sql, /^SELECT revision FROM contest_registration_setting/);
      return [{ revision: 1 }];
    } }) },
    contestMutation: { saveContest: async input => {
      writes.push(input);
      Object.assign(contests.get(input.id), { title: input.title, admins: input.admins });
      return input.id;
    } }
  });
  vm.runInContext(section('modules/_api_v2_authorization.js', 'async function assignedContestAdministratorAllows(', 'function recentLoginSatisfied('), context);
  syzoj.utils.authorizationV2 = { authorize: context.authorize };
  vm.runInContext(section('modules/_user_privilege_loader.js', 'const originalIsContestSupervisior =', 'const originalProblemEdit ='), context);
  vm.runInContext(section('modules/_contest_registration.js', 'async function canManageContest(', 'async function canViewContestProblems('), context);
  vm.runInContext(section('modules/_contest_registration.js', 'async function guardContestEditor(', "app.get('/contest/:id/edit'"), context);
  vm.runInContext(section('modules/_api_v2_contest_domain.js', 'async function requireManager(', 'async function canManageContest('), context);
  vm.runInContext(section('modules/_api_v2_contest_domain.js', 'async function saveContestV2(', "app.post('/api/v2/contests'"), context);
  vm.runInContext(section('modules/_contest_temp_accounts.js', 'async function canManageContestRegistrations(', 'async function importTemporaryAccounts('), context);
  function response(user) {
    return { locals: { user }, statusCode: 200, status(code) { this.statusCode = code; return this; },
      render(view, data) { this.view = view; this.data = data; } };
  }
  return { contests, users, problems, queries, writes, context, baseMembers,
    setDeny(value) { deny = value; },
    resource(id) { return { id, ownerId: contests.get(id)?.holder_id, scope: `contest:${id}` }; },
    authorize(userId, capability, id) {
      return context.authorize(users.get(userId) || null, capability, this.resource(id), { scope: `contest:${id}` });
    },
    async editor(userId, contestId = 21) {
      const res = response(users.get(userId) || null);
      await context.guardContestEditor({ params: { id: String(contestId) } }, res, error => {
        if (error) throw error;
        res.passed = true;
      });
      return res;
    },
    async saveWithoutEtag(userId, contestId = 21) {
      const res = response(users.get(userId) || null);
      await context.saveContestV2({ body: {}, get: () => undefined }, res, contestId);
      return res;
    },
    async save(userId, body = {}, contestId = 21) {
      const res = response(users.get(userId) || null);
      await context.saveContestV2({ body: { if_match: 'current-version', ...body }, get: () => undefined }, res, contestId);
      return res;
    }
  };
}

test('assigned ordinary users and contest managers can see and enter only their assigned contest management page', async () => {
  const f = harness();
  for (const id of [1, 2, 3, 4, 8]) {
    assert.equal(await f.contests.get(21).isSupervisior(f.users.get(id)), true, `button for user ${id}`);
    assert.equal((await f.editor(id)).passed, true, `editor for user ${id}`);
  }
  for (const id of [null, 5, 6, 13]) {
    assert.equal(await f.contests.get(21).isSupervisior(f.users.get(id)), false);
    assert.equal((await f.editor(id)).statusCode, 403);
  }
  for (const id of [3, 4]) {
    assert.equal(await f.contests.get(23).isSupervisior(f.users.get(id)), false);
    assert.equal((await f.editor(id, 23)).statusCode, 403);
  }
  assert.equal((await f.editor(4, 22)).passed, true, 'manage-own remains available');
  assert.equal(f.users.get(3).is_admin, false, 'legacy editor flag never changes the real identity');
  assert.equal(f.users.get(4).is_admin, false);
});

test('assigned management authorizes scoped operations without granting global privileges or new-contest creation', async () => {
  const f = harness();
  for (const capability of auth.RESOURCE_OWNER_RESTRICTED_CAPABILITIES) {
    if (!capability.startsWith('contest:')) continue;
    for (const id of [3, 4]) {
      assert.equal(await f.authorize(id, capability, 21), true, capability);
      assert.equal(await f.authorize(id, capability, 23), false, `unassigned ${capability}`);
    }
  }
  for (const capability of ['contest:create', 'admin:user.manage', 'admin:permission.grant', 'problem:edit', 'rating:publish', 'submission:rejudge']) {
    assert.equal(await f.context.authorize(f.users.get(3), capability, null, { scope: 'global' }), false);
  }
  assert.equal((await f.editor(3, 0)).statusCode, 403);
  assert.equal((await f.editor(4, 0)).passed, true, 'existing manage_contest can still create');
  for (const id of [3, 4]) {
    assert.equal(await f.context.canManageContestRegistrations(f.contests.get(21), f.users.get(id)), true, 'legacy scope-only resources work');
    assert.equal(await f.context.canManageContestRegistrations(f.contests.get(23), f.users.get(id)), false);
  }
});

test('save APIs admit assigned admins but still enforce If-Match; unrelated and anonymous users remain denied', async () => {
  const f = harness();
  for (const id of [3, 4]) {
    const allowed = await f.saveWithoutEtag(id);
    assert.equal(allowed.statusCode, 428);
    assert.equal(allowed.error.code, 'PRECONDITION_REQUIRED');
    const denied = await f.saveWithoutEtag(id, 23);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.error.code, 'CAPABILITY_REQUIRED');
  }
  assert.equal((await f.saveWithoutEtag(null)).statusCode, 401);
  assert.equal((await f.save(3, { if_match: 'stale-version' })).statusCode, 412);
  assert.equal(f.writes.length, 0);
});

test('assigned admins can save settings while retaining existing private problems, but cannot add unrelated private or base problems', async () => {
  const f = harness();
  for (const id of [3, 4]) {
    const res = await f.save(id, { title: 'Updated by assigned manager', problem_ids: [11] });
    assert.equal(res.statusCode, 200, JSON.stringify(res.error));
    assert.equal(res.data.title, 'Updated by assigned manager');
    assert.equal(f.writes[f.writes.length - 1].actorId, id);
  }
  const before = f.writes.length;
  const unavailable = await f.save(3, { problem_ids: [11, 13] });
  assert.equal(unavailable.error.code, 'CONTEST_PROBLEM_INVALID');
  const outsideWorkspace = await f.save(3, { problem_ids: [11, 14] });
  assert.equal(outsideWorkspace.error.code, 'CONTEST_PROBLEM_SCOPE_INVALID');
  assert.equal((await f.save(3, {}, 23)).statusCode, 403);
  assert.equal(f.writes.length, before);
  assert.equal((await f.save(3, { problem_ids: [11, 12] })).statusCode, 200, 'new public problems remain usable');
  f.problems.delete(11);
  assert.equal((await f.save(3)).error.code, 'CONTEST_PROBLEM_INVALID', 'missing existing problems cannot be retained');
});

test('saving removal of a designated administrator revokes subsequent editor and API access', async () => {
  const f = harness();
  assert.equal((await f.save(3, { admins: [4] })).statusCode, 200);
  assert.equal(f.contests.get(21).admins, '4');
  assert.equal((await f.editor(3)).statusCode, 403);
  assert.equal((await f.save(3)).statusCode, 403);
  assert.equal((await f.editor(4)).passed, true);
});

test('contest save preserves the requested problem order instead of sorting by ID', async () => {
  const f = harness();
  const res = await f.save(3, { problem_ids: [12, 11] });
  assert.equal(res.statusCode, 200, JSON.stringify(res.error));
  assert.equal(f.writes.at(-1).problems, '12|11', 'save retains the chosen order');
  assert.equal((await f.save(3, { problem_ids: [12, 11, 12] })).statusCode, 422, 'duplicate IDs remain invalid');
});

test('assignment removal is rechecked on the next request and exact IDs cannot cross contest scopes', async () => {
  const f = harness(), user = f.users.get(3);
  const inRequest = fn => new Promise((resolve, reject) => requestReads.middleware({ method: 'GET', path: '/contest/21/edit' }, {}, () => Promise.resolve().then(fn).then(resolve, reject)));
  await inRequest(async () => {
    assert.equal(await f.authorize(3, 'contest:edit', 21), true);
    assert.equal(await f.authorize(3, 'contest:registration.manage', 21), true);
    assert.equal(f.queries.length, 1, 'duplicate reads are request-local');
  });
  const staleContest = Object.assign(Object.create(Object.getPrototypeOf(f.contests.get(21))), f.contests.get(21));
  f.contests.get(21).admins = '4|13';
  await inRequest(async () => {
    assert.equal(await f.authorize(3, 'contest:edit', 21), false);
    assert.equal(await f.contests.get(21).isSupervisior(user), false);
    assert.equal(await staleContest.isSupervisior(user), false, 'legacy cached admin lists cannot retain access');
  });
  assert.equal((await f.editor(3)).statusCode, 403);
  assert.equal((await f.saveWithoutEtag(3)).statusCode, 403);
  f.contests.get(21).admins = '3|4';
  for (const [resource, scope] of [
    [{ id: 23, scope: 'contest:21' }, 'contest:21'],
    [{ id: 21, scope: 'contest:23' }, 'contest:21'],
    [{ id: 21 }, 'global'], [{ id: 21 }, 'problem:21'],
    [{ id: 21, admins: '3' }, 'contest:23'], [{ id: 999, admins: '3' }, 'contest:999']
  ]) assert.equal(await f.context.authorize(user, 'contest:edit', resource, { scope }), false);
  assert.equal(await f.context.authorize(user, 'contest:edit', { ownerId: 2, scope: 'contest:21' }, { scope: { type: 'contest', id: '21' } }), true);
  // The production base gate accepts a string scope; an object-form scope
  // must not let this delegation fallback grant base contest management.
  f.context.syzoj.utils.baseWorkspace.authorize = async () => null;
  assert.equal(await f.context.authorize(user, 'contest:edit', { id: 31, ownerId: 2 }, { scope: { type: 'contest', id: '31' } }), false);
});

test('explicit policy denies and the base workspace boundary remain effective for assigned administrators', async () => {
  const f = harness();
  f.setDeny(true);
  assert.equal(await f.authorize(3, 'contest:edit', 21), false);
  assert.equal(await f.contests.get(21).isSupervisior(f.users.get(3)), false);
  assert.equal((await f.editor(3)).statusCode, 403);
  f.setDeny(false);
  for (const id of [3, 4]) {
    assert.equal(await f.authorize(id, 'contest:edit', 31), false);
    assert.equal(await f.contests.get(31).isSupervisior(f.users.get(id)), false);
    assert.equal((await f.editor(id, 31)).statusCode, 403);
  }
  assert.equal((await f.editor(2, 31)).passed, true);
  f.baseMembers.delete(2);
  assert.equal((await f.editor(2, 31)).statusCode, 403);
});
