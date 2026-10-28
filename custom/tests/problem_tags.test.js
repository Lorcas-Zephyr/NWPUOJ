'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const domain = require('../libs/problem-domain');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

// Execute the deployed model and save handler against a transactional database
// fixture. SQL writes intentionally do not invalidate process-local caches.
function fixture() {
  const catalog = new Map([
    [7, { id: 7, name: '动态规划', color: 'violet', category: 'algorithm' }],
    [8, { id: 8, name: '基地练习', color: 'pink', category: 'source' }]
  ]);
  let assigned = [], failWrite = false;
  const db = {
    async query(sql, params = []) {
      if (sql.startsWith('SELECT tag.id,tag.name')) {
        assert.equal(params[0], 12);
        return assigned.map(id => catalog.get(id)).filter(Boolean)
          .sort((a, b) => a.color.localeCompare(b.color) || a.id - b.id).map(tag => ({ ...tag }));
      }
      if (sql.startsWith('SELECT id FROM problem_tag')) return params.filter(id => catalog.has(id)).map(id => ({ id }));
      if (sql.startsWith('DELETE FROM problem_tag_map')) { assigned = []; return {}; }
      if (sql.startsWith('INSERT INTO problem_tag_map')) {
        if (failWrite) throw new Error('write failed');
        assigned.push(params[1]); return {};
      }
      throw new Error(sql);
    },
    async transaction(work) {
      const before = [...assigned];
      try { return await work(db); } catch (error) { assigned = before; throw error; }
    }
  };
  const typeorm = new Proxy({ getConnection: () => db }, { get(target, name) { return target[name] || (() => () => {}); } });
  function Model() {}
  Model.deleteFromCache = async () => {};
  const modelContext = vm.createContext({ exports: {}, syzoj: { config: { db: { cache_size: 100 } } }, require(name) {
    if (name === 'typeorm') return typeorm;
    if (name === './common') return { default: Model };
    if (name === 'lru-cache') return class extends Map { del(key) { this.delete(key); } };
    if (name === './problem_tag_map') return { default: { find: async () => assigned.map(tag_id => ({ tag_id })) } };
    if (name === './problem_tag') return { default: { findById: async id => catalog.get(id) } };
    return {};
  } });
  vm.runInContext('Array.prototype.mapAsync = function (fn) { return Promise.all(this.map(fn)); };', modelContext);
  vm.runInContext(read('models-built/problem.js'), modelContext);
  const Problem = modelContext.exports.default;
  const problem = Object.assign(new Problem(), domain.contentFromInput({ title: '基地题目', description: '题面' }), { id: 12, user_id: 2, is_public: false });
  Problem.findById = async () => problem;
  const members = new Set([2, 3]);
  const baseContext = vm.createContext({ module: { exports: {} }, syzoj: { siteOwnerUserId: 1, model: () => Problem }, require(name) {
    if (name === 'typeorm') return { getConnection: () => ({ query: async (sql, params) => {
      if (sql.startsWith('CREATE TABLE')) return [];
      if (sql.includes('FROM base_workspace_member')) return members.has(params[0]) ? [{ user_id: params[0] }] : [];
      if (sql.includes('FROM base_workspace_problem')) return Number(params[0]) === 12 ? [{ problem_id: 12 }] : [];
      throw new Error(sql);
    } }) };
    if (name === './request-read-cache') return { memo: (_, work) => work() };
    if (name === './contest-temp-accounts') return {};
    throw new Error(name);
  } });
  vm.runInContext(read('libs/base-workspace.js'), baseContext);
  const base = baseContext.module.exports;
  const api = { ifMatch: req => req.body.if_match === 'current', appendEvent: async () => {},
    send: (res, data) => { res.data = data; }, fail: (res, status, code) => { res.status = status; res.code = code; } };
  const context = vm.createContext({
    ...domain, TypeORM: typeorm, app: { patch() {}, post() {} },
    syzoj: { model: () => Problem, utils: { apiV2: api } },
    ensureProblemSchema: async () => {}, loadState: async () => ({}), loadProblem: async () => problem,
    serializeProblem: value => ({ id: value.id }),
    updateProblemAggregate: async () => ({ version: { id: '99' }, legacy_projection_updated: true }),
    requireCapability: capability => async (req, res, next) => {
      if (!await base.authorize(res.locals.user, capability, problem, 'problem:12')) return api.fail(res, 403, 'CAPABILITY_REQUIRED');
      return next();
    }
  });
  const source = read('modules/_api_v2_problem_domain.js');
  vm.runInContext(source.slice(source.indexOf('async function updateProblemV2('), source.indexOf("app.get('/api/v2/problems/:id/versions'")), context);
  return {
    problem, catalog, members,
    replace: ids => { assigned = [...ids]; }, failWrite: () => { failWrite = true; },
    save: async (tagIds, user = { id: 2 }, ifMatch = 'current') => {
      const req = { body: { workspace: 'base', tag_ids: tagIds, if_match: ifMatch }, get: () => '', params: { id: '12' } };
      const res = { locals: { user } };
      await context.updateProblemV2(req, res, error => { if (error) throw error; });
      return res;
    }
  };
}

test('base member tag saves immediately appear in a previously read problem and persist on the next save', async () => {
  const f = fixture();
  assert.deepEqual(await f.problem.getTags(), []);
  assert.equal((await f.save([7])).data.problem.id, 12);
  assert.deepEqual((await f.problem.getTags()).map(tag => tag.id), [7]);
  await f.save((await f.problem.getTags()).map(tag => tag.id));
  assert.deepEqual((await f.problem.getTags()).map(tag => tag.id), [7]);
  await f.save([8]);
  assert.deepEqual((await f.problem.getTags()).map(tag => tag.id), [8]);
  await f.save([]);
  assert.deepEqual(await f.problem.getTags(), []);
});

test('administrator and bulk SQL changes are visible to the editor and statement without restart', async () => {
  const f = fixture();
  await f.problem.getTags();
  await f.save([7], { id: 1 });
  assert.equal((await f.problem.getTags())[0].name, '动态规划');
  f.replace([7, 8]);
  assert.deepEqual((await f.problem.getTags()).map(tag => tag.id), [8, 7]);
  f.catalog.get(7).name = '动态规划（已修改）';
  assert.equal((await f.problem.getTags())[1].name, '动态规划（已修改）');
  f.catalog.delete(7);
  assert.deepEqual((await f.problem.getTags()).map(tag => tag.id), [8]);
});

test('tag saving rejects nonowners, removed members, unknown tags and stale requests without changing tags', async () => {
  const f = fixture();
  f.replace([7]);
  for (const user of [null, { id: 3 }, { id: 4, privileges: ['manage_problem'] }]) {
    assert.equal((await f.save([8], user)).status, 403);
  }
  assert.equal((await f.save([8], { id: 2 }, 'stale')).status, 412);
  await assert.rejects(f.save([999]), { code: 'TAG_NOT_FOUND' });
  f.members.delete(2);
  assert.equal((await f.save([8])).status, 403);
  assert.deepEqual((await f.problem.getTags()).map(tag => tag.id), [7]);
});

test('failed tag replacement rolls back and the next page read retains the original tags', async () => {
  const f = fixture();
  f.replace([7]);
  await f.problem.getTags();
  f.failWrite();
  await assert.rejects(f.save([8]), /write failed/);
  assert.deepEqual((await f.problem.getTags()).map(tag => tag.id), [7]);
});
