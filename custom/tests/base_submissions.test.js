'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function harness() {
  let member = true, streamAllowed = true, latestQuery, counted = 0;
  const user = { id: 2, username: 'member', privileges: [], getPrivileges: async () => [], hasPrivilege: async () => false };
  const problem = { id: 12, title: '基地练习', is_public: false, user_id: 2, getDisplayId: () => '12', getVJudgeLanguages: () => null };
  const judge = { id: 100, type: 0, problem_id: 12, user_id: 2, task_id: 'task-100', pending: 1, is_public: false, language: 'cpp', code_length: 20, submit_time: 10 };
  const routes = new Map();
  const base = {
    isMember: async viewer => !!viewer && member,
    visibleSubmissions: () => 'BASE_VISIBILITY', practiceSubmissionScope: () => 'BASE_PRACTICE_SCOPE',
    contains: async (kind, id) => kind === 'problem' && Number(id) === 12,
    canReadProblem: async (_problem, viewer) => !!viewer && member,
    canAccessSubmission: async (_judge, viewer) => !!viewer && member,
    canReadPracticeSubmission: async (_judge, viewer) => !!viewer && member && streamAllowed
  };
  const model = {
    judge_state: {
      createQueryBuilder: () => {
        const builder = { conditions: [], parameters: {},
          where(sql, params) { return this.andWhere(sql, params); },
          andWhere(sql, params) { this.conditions.push(sql); Object.assign(this.parameters, params); return this; },
          getMany: async () => [judge] };
        latestQuery = builder; return builder;
      },
      countQuery: async () => { counted++; return 101; }, queryPage: async () => [{ ...judge }]
    },
    user: { fromName: async name => name === user.username ? user : null },
    problem: { findById: async id => Number(id) === 12 ? { ...problem } : null }
  };
  const utils = { baseWorkspace: base, formatDate: String, paginate: (count, page, perPage) => ({ currPage: Number(page || 1), pageCnt: Math.ceil(count / perPage) }),
    getJudgeAdminActions: async () => ({}), canViewSubmissionDetail: async () => true };
  const syzoj = { model: name => model[name] || {}, utils, log() {}, config: { session_secret: 'test-only', page: { judge_state: 20 }, filter_enabled_languages: ['cpp'] }, languages: { cpp: { show: 'C++ 23' } } };
  const processContext = { module: { exports: {} }, syzoj, require: () => ({ getCachedJudgeState: () => ({ result: 'Running 1/2' }) }) };
  vm.runInNewContext(read('libs-built/submissions_process.js'), processContext);
  const deps = { jsonwebtoken: { sign: JSON.stringify, verify: JSON.parse }, '../libs/submissions_process': processContext.module.exports,
    '../libs/judger': {}, '../libs/compiler-message': {},
    '../libs/contest-standings': require('../libs/contest-standings'),
    typeorm: { getConnection: () => ({ query: async sql => sql.includes('FROM user WHERE') ? [user] : [] }) } };
  const context = vm.createContext({ syzoj, ErrorMessage: Error, Map, Set,
    app: { use() {}, get: (route, handler) => routes.set(String(route), handler), post() {} },
    require: name => { if (!(name in deps)) throw Error(name); return deps[name]; } });
  vm.runInContext(read('modules/_submission_routes.js'), context);
  return { user, judge, context,
    get query() { return latestQuery; }, get counted() { return counted; },
    revoke() { member = false; }, blockStream() { streamAllowed = false; },
    async list(query = {}, viewer = user) {
      const res = { locals: { user: viewer }, status(code) { this.code = code; return this; }, render(view, data) { this.view = view; this.data = data; } };
      let error;
      await routes.get('/base/submissions')({ query }, res, err => { error = err; });
      if (error) throw error;
      return res;
    },
    statuses: () => context.getListStatuses([{ submissionId: 100, taskId: 'task-100', contestId: 0, view: 'base' }], user)
  };
}

test('base submissions reuse the normal renderer with scoped SQL, filters, pagination and live tokens', async () => {
  const app = harness();
  const response = await app.list({ problem_id: '12', submitter: 'member', language: 'cpp', status: 'Waiting', min_score: '0', max_score: '100', page: '2', contest: '999' });
  const data = response.data;
  assert.equal(response.view, 'submissions');
  assert.equal(data.displayConfig.inBase, true);
  assert.equal(data.displayConfig.inContest, false);
  assert.equal(data.baseContext, true);
  assert.deepEqual(Array.from(data.paginationBasePath), ['base', 'submissions']);
  assert.equal(data.paginate.currPage, 2);
  for (const sql of ['BASE_VISIBILITY', 'BASE_PRACTICE_SCOPE', 'js.type = 0']) assert.ok(app.query.conditions.includes(sql));
  assert.ok(!app.query.conditions.includes('js.is_public = 1'), 'own hidden practice must not be excluded');
  assert.equal(app.query.parameters.filterProblemId, 12);
  assert.equal(app.query.parameters.submitterId, 2);
  assert.equal(app.query.parameters.filterLanguage, 'cpp');
  assert.equal(app.query.parameters.contestId, undefined, 'query parameter cannot switch to contest results');
  assert.equal(data.items[0].info.language, 'C++ 23');
  assert.equal(data.items[0].result.result, 'Running 1/2');
  const token = JSON.parse(data.items[0].token);
  assert.equal(token.view, 'base');
  assert.equal(token.viewerId, 2);
  assert.equal(app.context.verifyStatusTokens([data.items[0].token], 2).length, 1);
  assert.equal(app.context.verifyStatusTokens([data.items[0].token], 3).length, 0);
});

test('base list checks membership before data reads and rejects outside problem/filter parameters', async () => {
  const app = harness();
  assert.equal((await app.list({}, null)).code, 403);
  assert.equal(app.counted, 0);
  for (const query of [{ problem_id: '99' }, { problem_id: '-1' }, { min_score: '101' }, { status: 'bad' }, { language: 'unknown' }]) assert.equal((await app.list(query)).code, 400);
  assert.equal(app.counted, 0);
  app.revoke();
  assert.equal((await app.list()).code, 403);
  assert.equal(app.counted, 0);
});

test('base live status displays own unpublished practice but rechecks workspace visibility', async () => {
  const app = harness();
  const updates = await app.statuses();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].result.result, 'Running 1/2');
  app.blockStream();
  assert.equal((await app.statuses()).length, 0, 'active contest changes cannot be bypassed by old tokens');
  app.revoke();
  assert.equal((await app.statuses()).length, 0);
});

test('base navigation, submission redirect and detail return links remain in the workspace', () => {
  assert.match(read('views/base_workspace.ejs'), /href="\/base\/submissions"/);
  assert.match(read('views/submissions.ejs'), /displayConfig\.inBase \? \['base', 'submissions'\]/);
  assert.match(read('views/submissions.ejs'), /href="\/base\/submissions" aria-current="page"/);
  assert.match(read('views/problem_submit_form.ejs'), /const baseSubmissionListUrl = !contest && !appProblemSet/);
  assert.match(read('views/submission.ejs'), /baseContext \? syzoj\.utils\.makeUrl\(\['base', 'submissions'\]\)/);
});
