'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const auth = require('../libs/authorization-v2');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function fixture() {
  const rows = Array.from({ length: 15 }, (_, index) => ({
    id: index + 1, is_public: index % 2 === 0, user_id: index % 4 === 1 ? 2 : 3,
    title: index < 10 ? 'Alpha' : 'Beta', tagIds: [index < 10 ? 1 : 2],
    getJudgeState: async () => null, getTags: async () => []
  }));
  const routes = new Map(), denied = new Set(), hydrated = [], events = [];
  const submissions = [{ problem_id: 1, user_id: 2, status: 'Accepted' },
    { problem_id: 3, user_id: 2, status: 'Wrong Answer' },
    { problem_id: 5, user_id: 2, status: 'Accepted', adminAction: true },
    { problem_id: 2, user_id: 2, status: 'Accepted' }];
  class Brackets { constructor(whereFactory) { this.whereFactory = whereFactory; } }
  class Query {
    constructor() { this.alias = 'problem'; this.matches = () => true; this.params = {}; this.order = []; }
    clone() { return Object.assign(new Query(), this, { params: { ...this.params }, order: [...this.order] }); }
    condition(sql, params) {
      Object.assign(this.params, params);
      if (sql instanceof Brackets) {
        const nested = new Query(); sql.whereFactory(nested); return nested.matches;
      }
      if (sql.includes('base_scope')) return row => !row.base;
      if (sql.includes('archived_problem')) return row => !row.archived;
      if (sql.includes('active_contest')) return row => !row.activeContest;
      if (sql.includes('progress_state')) return row => {
        const states = submissions.filter(state => state.user_id === this.params.progressUserId && state.problem_id === row.id);
        const solved = states.some(state => state.status === 'Accepted' && !state.adminAction);
        if (sql.startsWith('NOT EXISTS')) return !states.length;
        if (sql.includes('AND NOT EXISTS (\n    SELECT')) return !!states.length && !solved;
        return solved;
      };
      if (sql.includes('problem_tag_map')) return row => row.tagIds.includes(Object.values(params)[0]);
      if (/is_public = [01]$/.test(sql)) return row => Number(row.is_public) === Number(sql.slice(-1));
      if (sql.endsWith('user_id = :viewerId')) return row => row.user_id === params.viewerId;
      if (sql.includes('deniedProblemIds')) return row => !params.deniedProblemIds.includes(row.id);
      if (sql === 'title LIKE :title') return row => row.title.includes(params.title.slice(1, -1));
      if (sql === 'id = :problemId') return row => row.id === params.problemId;
      throw new Error('Unhandled test condition: ' + sql);
    }
    where(sql, params) { this.matches = this.condition(sql, params); return this; }
    andWhere(sql, params) { const before = this.matches, next = this.condition(sql, params); this.matches = row => before(row) && next(row); return this; }
    orWhere(sql, params) { const before = this.matches, next = this.condition(sql, params); this.matches = row => before(row) || next(row); return this; }
    setParameter(key, value) { this.params[key] = value; return this; }
    select() { return this; }
    addSelect() { return this; }
    orderBy(key, direction) { this.order = [[key, direction]]; return this; }
    addOrderBy(key, direction) { this.order.push([key, direction]); return this; }
    async getRawMany() { events.push('private-candidates'); return rows.filter(this.matches).map(row => ({ id: row.id, user_id: row.user_id })); }
    result() {
      return rows.filter(this.matches).sort((a, b) => {
        for (const [key, direction] of this.order) {
          const value = key.startsWith('CASE') ? Number(b.id === this.params.problemId) - Number(a.id === this.params.problemId) :
            typeof a[key] === 'number' ? a[key] - b[key] : String(a[key]).localeCompare(String(b[key]));
          if (value) return direction === 'DESC' ? -value : value;
        }
        return 0;
      });
    }
  }
  const Problem = {
    createQueryBuilder: () => new Query(),
    countForPagination: async query => { events.push('count'); return query.result().length; },
    queryPage: async (page, query) => {
      events.push('page');
      const result = query.result().slice((page.page - 1) * page.perPage, page.page * page.perPage);
      hydrated.push(...result.map(row => row.id));
      return result.map(row => ({ ...row }));
    }
  };
  const utils = {
    baseWorkspace: { ensureSchema: async () => {}, outside: () => 'base_scope', authorize: async () => null },
    paginate: (count, page, perPage) => ({ count, page: Number(page) || 1, perPage }),
    makeUrl: () => '/problems'
  };
  const syzoj = { utils, siteOwnerUserId: 1, config: { page: { problem: 3 }, sorting: { problem: { field: 'id', order: 'asc' } } },
    model: name => name === 'problem' ? Problem : { find: async () => [], findById: async id => ({ id }) },
    log: error => { throw error; }
  };
  const context = vm.createContext({ ...auth, syzoj, ErrorMessage: Error, module: { exports: {} },
    app: { get: (route, fn) => routes.set(route, fn) },
    require: name => name === 'typeorm' ? { Brackets, getConnection: () => ({ query: async () => [] }) } : require(name),
    effectiveCapabilities: async user => user.is_admin || user.id === 1 ? ['*'] : [...auth.BUILT_IN_ROLES.guest, ...auth.legacyPrivilegeCapabilities(user.privileges)],
    assignedContestAdministratorAllows: async () => false,
    policyDecision: async (_user, _capability, resource) => ({ effect: resource && denied.has(resource.id) ? 'deny' : null })
  });
  const source = read('modules/_api_v2_authorization.js');
  vm.runInContext(source.slice(source.indexOf('async function authorize('), source.indexOf('function recentLoginSatisfied(')), context);
  utils.authorizationV2 = { authorize: context.authorize, authorizedScopeIds: async () => ['4'] };
  vm.runInContext(read('libs-built/problem_repositories.js'), context);
  context.module.exports();
  return { rows, denied, events, hydrated, authorize: context.authorize,
    async request(user, query = {}, route = '/problems') {
      let rendered;
      const res = { locals: { user }, render: (view, data) => { assert.equal(view, 'problems'); rendered = data; } };
      await routes.get(route)({ query, params: { tagIDs: '1' }, session: {} }, res);
      return rendered;
    }
  };
}

const member = { id: 9, privileges: [] };
const ids = result => Array.from(result.problems, row => row.id);

test('ordinary read capability never includes hidden problems in totals or page offsets', async () => {
  const f = fixture();
  assert.equal(await f.authorize(member, 'problem:read', null, { scope: 'global' }), true);
  for (const user of [null, member, { id: 9, privileges: ['manage_problem'] }]) {
    const pages = [];
    for (let page = 1; page <= 3; page++) {
      const result = await f.request(user, { page });
      assert.equal(result.paginate.count, 8);
      pages.push(ids(result));
    }
    assert.deepEqual(pages, [[1, 3, 5], [7, 9, 11], [13, 15]]);
  }
  assert.ok(f.hydrated.every(id => id % 2 === 1), 'hidden rows are never hydrated after pagination');
});

test('uploaders and administrators retain private entries, with explicit denies applied before pagination', async () => {
  const f = fixture();
  f.denied.add(6);
  const uploader = { id: 2, privileges: [] };
  assert.equal((await f.request(uploader)).paginate.count, 11);
  assert.deepEqual(ids(await f.request(uploader, { page: 2 })), [5, 7, 9]);
  for (const user of [{ id: 8, is_admin: true }, { id: 1 }]) {
    assert.equal((await f.request(user)).paginate.count, 14);
    assert.deepEqual(ids(await f.request(user, { page: 2 })), [4, 5, 7]);
  }
  assert.ok(f.events.indexOf('private-candidates') < f.events.indexOf('count'));
  assert.ok(f.events.indexOf('count') < f.events.indexOf('page'));
});

test('keyword, numeric ID, tag and progress filters share the same visible result set and sorting', async () => {
  const f = fixture();
  for (const route of ['/problems', '/problems/search', '/problems/tag/:tagIDs']) {
    const first = await f.request(member, { keyword: 'Alpha', order: 'desc' }, route);
    assert.equal(first.paginate.count, 5);
    assert.deepEqual(ids(first), [9, 7, 5]);
    assert.deepEqual(ids(await f.request(member, { keyword: 'Alpha', order: 'desc', page: 2 }, route)), [3, 1]);
    const hidden = await f.request(member, { keyword: '4' }, route);
    assert.equal(hidden.paginate.count, 0);
    assert.deepEqual(ids(hidden), []);
    assert.deepEqual(ids(await f.request(member, { keyword: '3' }, route)), [3]);
    const uploader = { id: 2 };
    assert.deepEqual(ids(await f.request(uploader, { progress: 'solved' }, route)), [1, 2]);
    assert.deepEqual(ids(await f.request(uploader, { progress: 'attempted' }, route)), [3, 5]);
    assert.deepEqual(ids(await f.request(uploader, { progress: 'unattempted' }, route)), [6, 7, 9]);
  }
});

test('base, archived and active-contest exclusions are also applied before counting', async () => {
  const f = fixture();
  f.rows[0].base = true;
  f.rows[2].archived = true;
  f.rows[4].activeContest = true;
  for (const user of [null, member]) {
    const result = await f.request(user);
    assert.equal(result.paginate.count, 5);
    assert.deepEqual(ids(result), [7, 9, 11]);
    assert.deepEqual(ids(await f.request(user, { page: 2 })), [13, 15]);
  }
  const admin = await f.request({ id: 1 });
  assert.equal(admin.paginate.count, 13);
  assert.deepEqual(ids(admin), [2, 4, 5]);
});

test('the view renders the already-authorized page without removing rows', () => {
  const view = read('views/problems.ejs');
  assert.doesNotMatch(view, /problems\.filter\(|if \(!\(problem\.is_public \|\| problem\.allowedEdit\)\) continue/);
});
