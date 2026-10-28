'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../modules/_user_privilege_loader.js'), 'utf8');
const route = '/contest/:id/problem/:pid/submissions';
const start = source.indexOf("app.get('" + route + "'");
const end = source.indexOf('\napp.use(', start);
assert.ok(start >= 0 && end > start);

function harness({ ended = false, allowed = true, missing = false } = {}) {
  const routes = new Map();
  const contest = { id: 21, isEnded: () => ended, isRunning: () => !ended,
    getProblems: async () => [911105, 911106] };
  vm.runInNewContext(source.slice(start, end), {
    app: { get: (url, handler) => routes.set(url, handler) },
    Contest: { findById: async id => !missing && id === 21 ? contest : null },
    ErrorMessage: Error,
    syzoj: { log() {}, utils: {
      canViewContestProblems: async () => allowed,
      makeUrl: (parts, query) => '/' + parts.join('/') + '?' + new URLSearchParams(query)
    } }
  });
  return async (pid = '2', query = {}) => {
    const req = { params: { id: '21', pid }, query,
      url: '/contest/21/problem/' + pid + '/submissions' };
    const res = { locals: { user: { id: 7 } }, statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      render(view, data) { this.view = view; this.data = data; },
      redirect(url) { this.location = url; } };
    await routes.get(route)(req, res, () => { res.nextCalled = true; });
    return { req, res };
  };
}

test('legacy contest problem links redirect to the contest list with the contest ordinal before and after ending', async () => {
  for (const ended of [false, true]) {
    const query = { contest: '999', problem_id: '911106', submitter: 'member', language: 'cpp',
      min_score: '20', max_score: '100', status: 'Accepted', page: '2' };
    const original = { ...query };
    const { req, res } = await harness({ ended })('2', query);
    const url = new URL(res.location, 'http://test.local');
    assert.equal(url.pathname, '/contest/21/submissions');
    assert.equal(url.searchParams.get('problem_id'), '2');
    assert.equal(url.searchParams.has('contest'), false);
    for (const key of ['submitter', 'language', 'min_score', 'max_score', 'status', 'page']) {
      assert.equal(url.searchParams.get(key), query[key]);
    }
    assert.equal(res.nextCalled, undefined);
    assert.equal(res.locals.problemContextRequest, undefined);
    assert.equal(req.url, '/contest/21/problem/2/submissions');
    assert.deepEqual(query, original);
  }
});

test('legacy contest submission links still enforce access and reject invalid contest ordinals', async () => {
  for (const ended of [false, true]) {
    const { res } = await harness({ ended, allowed: false })();
    assert.equal(res.statusCode, 403);
    assert.equal(res.location, undefined);
    assert.equal(res.view, 'error');
  }
  for (const pid of ['0', '-1', '3', '911106']) {
    const { res } = await harness()(pid);
    assert.equal(res.location, undefined);
    assert.match(res.data.err.message, /无此题目/);
  }
  const { res } = await harness({ missing: true })();
  assert.equal(res.location, undefined);
  assert.match(res.data.err.message, /无此比赛/);
});

test('contest problem navigation uses the canonical list and no longer rewrites ended lists to global submissions', () => {
  const template = fs.readFileSync(path.join(__dirname, '../views/problem_context.ejs'), 'utf8');
  assert.match(template, /\['contest', contextContest\.id, 'submissions'\], \{ problem_id: contextContestProblemId \}/);
  assert.doesNotMatch(source, /app\.get\('\/contest\/:id\/submissions'/);
  assert.doesNotMatch(source.slice(start, end), /req\.url\s*=/);
});
