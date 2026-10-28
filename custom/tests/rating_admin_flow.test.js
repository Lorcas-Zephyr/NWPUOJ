'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('privilege context is registered before every early admin workspace', () => {
  const order = read('custom/module-order.js');
  const privilege = order.indexOf("'_user_privilege_loader.js'");

  assert.ok(privilege > -1);
  for (const moduleName of ['_admin_overview.js', '_admin_users.js', '_contest_rating.js']) {
    assert.ok(privilege < order.indexOf(`'${moduleName}'`), moduleName + ' must run after the privilege loader');
  }
});

test('rating workspace is status-only and exposes one manual calculation action', () => {
  const route = read('custom/modules/_contest_rating.js');
  const view = read('custom/views/admin_rating.ejs');

  assert.match(route, /app\.post\('\/api\/v2\/admin\/rating\/calculate-pending'/);
  assert.doesNotMatch(route, /scheduleFinalization|setInterval\([^)]*finaliz/i);
  assert.match(view, /Rating 计算状态/);
  assert.match(view, /一键计算/);
  assert.match(view, /先处理作弊、取消等无效提交/);
  assert.doesNotMatch(view, /生成预览|审批|calcs/);
});

test('pending rating calculation preserves chronological baselines', () => {
  const rating = read('custom/libs/contest-rating.js');

  assert.match(rating, /ORDER BY contest\.end_time ASC,contest\.id ASC/);
  assert.match(rating, /if \(result\.status === 'deferred'\) break;/);
});

test('contest deletion uses transactional downstream rating recalculation', () => {
  const route = read('custom/modules/_api_v2_contest_domain.js');
  const deletion = read('custom/libs/contest-deletion.js');
  const rating = read('custom/libs/contest-rating.js');

  assert.match(route, /contestDeletion\.deleteContest\(req, contest, res\.locals\.user\)/);
  assert.match(deletion, /contestRating\.deleteContestAndRecalculate\(contest\.id, \{ actorId: actor\.id \}\)/);
  assert.match(rating, /deleteContestInTransaction\(manager, contestId/);
  assert.match(rating, /cycleEvidence: deletionOptions\.cycleEvidence/);
  assert.match(rating, /for \(const affectedContestId of affectedContestIds\)/);
  assert.match(rating, /finalizeContestInTransaction\(manager, affectedContestId,/);
});

test('user profiles separate the Rating chart from real contest participation links', () => {
  const route = read('custom/modules/_contest_rating.js');
  const view = read('custom/views/user.ejs');
  const css = read('custom/app-features.css');

  assert.match(route, /FROM contest_player cp/);
  assert.match(route, /removal\.user_id IS NULL/);
  assert.match(route, /canViewPrivateParticipation \? '' : ' AND c\.is_public=1'/);
  assert.match(route, /options\.participatedContests = participantRows\.map/);
  assert.match(view, /id="user-rating-chart"/);
  assert.match(view, /id="user-rating-series"/);
  assert.match(view, /appParticipatedContests/);
  assert.match(view, /makeUrl\(\['contest', contest\.id\]\)/);
  assert.doesNotMatch(view, /history\.rank|history\.participants|\['contest', history\.contestId, 'ranklist'\]/);
  assert.match(css, /\.app-rating-chart canvas/);
  assert.match(css, /\.app-contest-link-list > a/);
});

test('contest rollback rejects unauthorized or malformed requests before changing Rating', async () => {
  const vm = require('node:vm');
  const source = read('custom/modules/_contest_rating.js');
  const start = source.indexOf("app.post('/api/v2/admin/rating/contests/:id/rollback'");
  const end = source.indexOf('\napp.use(', start);
  let handler, allowed = false, recent = true, mutations = 0;
  const api = { fail: (res, status, code) => ({ status, code }), send: (res, data) => ({ status: 200, data }) };
  vm.runInNewContext(source.slice(start, end), {
    app: { post: (url, fn) => { handler = fn; } },
    syzoj: { log() {}, utils: { apiV2: api, authorizationV2: { authorize: async () => allowed, recentLoginSatisfied: () => recent } } },
    ensureRatingSchema: async () => {},
    contestRating: { recalculateRatingsFrom: async () => { mutations++; return { contestIds: [20], contestCount: 1, userIds: [7], auditEventId: 1 }; } },
    contestRatingRequestCache: { clear() {} }, ranklistRatingCache: { invalidate() {} }
  });
  const req = { params: { id: '20' }, body: { calculation_ids: [2] } };
  assert.equal((await handler(req, { locals: {} })).status, 401);
  const res = { locals: { user: { id: 7 } } };
  assert.equal((await handler(req, res)).status, 403);
  allowed = true; recent = false;
  assert.equal((await handler(req, res)).code, 'RECENT_LOGIN_REQUIRED');
  recent = true;
  assert.equal((await handler({ ...req, body: { calculation_ids: ['bad'] } }, res)).status, 422);
  assert.equal(mutations, 0);
  assert.equal((await handler(req, res)).status, 200);
  assert.equal(mutations, 1);
});
