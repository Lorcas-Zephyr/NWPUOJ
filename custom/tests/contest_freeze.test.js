'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const standings = require('../libs/contest-standings');
const lifecycle = require('../libs/contest-lifecycle');

// Execute the actual API and HTML handlers against a deterministic database
// fixture. This covers permissions, cache separation, API projections and CSV.
function harness() {
  let now = 300;
  let freezeMinutes = 2;
  const submissions = [
    { id: 1, user_id: 7, problem_id: 11, submit_time: 150, status: 'Wrong Answer', score: 0 },
    { id: 2, user_id: 8, problem_id: 11, submit_time: 200, status: 'Accepted', score: 100 },
    { id: 3, user_id: 7, problem_id: 11, submit_time: 220, status: 'Accepted', score: 100 }
  ];
  const contest = { id: 21, holder_id: 1, title: 'Freeze fixture', type: 'acm', problems: '11',
    start_time: 100, end_time: 400, ranklist_id: 1, is_public: true,
    ranklist: { ranking_params: {} },
    getProblems: async () => [11], loadRelationships: async () => {},
    isSupervisior: async user => !!user && [1, 2].includes(user.id),
    isEnded: () => now >= 400, allowedSeeingResult: () => true, allowedSeeingOthers: () => true
  };
  const live = standings.scoreDetailsBefore(submissions, contest, 400);
  const players = [7, 8, 9].map(id => ({ player_id: id, participant_id: id, user_id: id,
    username: 'player' + id, score_details: live.get(id) || {}, rating: 1500,
    temporary_account_user_id: id === 8 ? id : null, ai_agent_user_id: null }));
  const versions = [], rows = new Map();
  let pointers = null;
  const db = { transaction: async (_level, callback) => callback(db), query: async (sql, args = []) => {
    if (/^CREATE TABLE/.test(sql)) return [];
    if (/^SHOW COLUMNS/.test(sql)) return [{ Field: 'exists' }];
    if (/SELECT security_json FROM contest_v2_config/.test(sql)) return [{ security_json: JSON.stringify({ standings_freeze_after_minutes: freezeMinutes }) }];
    if (/SELECT \* FROM contest_v2_config/.test(sql)) return [{ contest_id: 21, timezone: 'Asia/Shanghai', security_json: JSON.stringify({ standings_freeze_after_minutes: freezeMinutes }), revision: 1 }];
    if (/FROM contest_v2_state/.test(sql)) return [{ contest_id: 21, status: 'running', revision: 1 }];
    if (/SELECT \* FROM contest WHERE/.test(sql)) return [contest];
    if (/FROM contest_player cp/.test(sql)) return players.map(player => ({ ...player }));
    if (/SELECT id FROM contest_player/.test(sql)) return [ { id: 7 } ];
    if (/SELECT revision FROM contest_registration_setting/.test(sql)) return [{ revision: 1 }];
    if (/SELECT ranking_params FROM contest_ranklist/.test(sql)) return [{ ranking_params: '{}' }];
    if (/SELECT id,submit_time FROM judge_state/.test(sql)) return submissions.filter(row => args[0].includes(row.id));
    if (/SELECT js.id,js.user_id/.test(sql)) return submissions.filter(row => row.submit_time >= args[1] && row.submit_time < args[2]);
    if (/SELECT MAX\(id\)/.test(sql)) return [{ id: Math.max(...submissions.filter(row => row.submit_time < args[1]).map(row => row.id)) }];
    if (/INSERT INTO contest_v2_standings_version/.test(sql)) {
      const [contest_id, version_number, kind, contest_status, source_submission_id, row_count, content_hash, reason] = args;
      const version = { id: versions.length + 1, contest_id, version_number, kind, contest_status, source_submission_id, row_count, content_hash, reason };
      versions.push(version);
      return { insertId: version.id };
    }
    if (/SELECT \* FROM contest_v2_standings_version/.test(sql)) {
      if (/WHERE id=/.test(sql)) return versions.filter(version => version.id === args[0]);
      return versions.filter(version => args.length === 1 || version.kind === args[1]).slice(-1);
    }
    if (/INSERT INTO contest_v2_standing_row/.test(sql)) {
      for (let i = 0; i < args.length; i += 10) {
        const [version_id, position, rank, participant_id, user_id, username, score, penalty, details_json, diagnostics_json] = args.slice(i, i + 10);
        if (!rows.has(version_id)) rows.set(version_id, []);
        rows.get(version_id).push({ position, rank, participant_id, user_id, username, score, penalty, details_json, diagnostics_json });
      }
      return {};
    }
    if (/FROM contest_v2_standing_row/.test(sql)) return (rows.get(args[0]) || []).filter(row => row.position > args[1]).slice(0, args[2]);
    if (/FROM contest_v2_standings_current/.test(sql)) return pointers ? [pointers] : [];
    if (/INSERT INTO contest_v2_standings_current/.test(sql)) {
      pointers = { live_version_id: args[1], public_version_id: args[2], frozen_version_id: args[3], final_version_id: args[4] };
      return {};
    }
    if (/FROM problem_v2_state/.test(sql)) return [];
    if (/FROM user_registration_profile/.test(sql)) return [{ user_id: 7, real_name: '甲', student_id: '20260007', college: '学院' }];
    throw new Error('Unexpected fixture query: ' + sql);
  } };
  const routes = new Map();
  const app = { use: () => {} };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) app[method] = (route, handler) => routes.set(method + ' ' + route, handler);
  const api = { send: (res, value) => (res.apiResult = value), fail: (res, status, code) => (res.apiResult = { error: { status, code } }),
    parseLimit: () => 100, decodeCursor: value => value || 0, encodeCursor: value => value,
    appendEvent: async () => {}, ensureFoundationSchema: async () => {}, ifMatch: req => req.body.if_match === 'fixture-etag' };
  const utils = { apiV2: api, authorizationV2: { authorize: async (user, _action, resource) =>
    !!user && (user.id === 1 || user.id === 2 && resource && resource.id === 21) },
    paginate: (count, page, perPage) => ({ currPage: Number(page || 1), perPage, count }) };
  function Ranklist() {}
  Ranklist.prototype.getPlayers = async () => [];
  const classGroups = { normalizeClassIds: value => value ? String(value).split(',').map(Number).filter(id => id > 0) : [],
    membershipForUsers: async () => ({ classes: [{ id: 3, name: '班级' }], byUser: new Map([[7, [{ id: 3, name: '班级' }]], [9, [{ id: 3, name: '班级' }]]]) }) };
  const dependencies = {
    typeorm: { getConnection: () => db },
    multer: Object.assign(() => ({ single: () => () => {} }), { memoryStorage: () => ({}) }),
    '../libs/contest-standings': { ...standings, resolveStandingsFreeze: (contest, config, state) => standings.resolveStandingsFreeze(contest, config, state, now) },
    '../libs/contest-lifecycle': { ...lifecycle, resolveContestStatus: (contest, state) => lifecycle.resolveContestStatus(contest, state, now) },
    '../libs/contest-mutation': { saveContest: async input => { freezeMinutes = input.freezeAfterMinutes; return 21; } },
    '../libs/contest-deletion': {}, '../libs/contest-temp-accounts': {},
    '../libs/registration-profile-schema': {}, '../libs/problem-domain': {}, '../libs/user-mentions': {},
    '../libs/class-groups': classGroups, '../libs/contest-ranklist-export': require('../libs/contest-ranklist-export')
  };
  const context = vm.createContext({ app, console, Buffer, Map, Set, ErrorMessage: Error,
    Date: class extends Date { static now() { return now * 1000; } },
    setImmediate: () => {}, setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
    require: name => dependencies[name] || require(name),
    syzoj: { utils, config: { default: { user: { rating: 1500 } } }, log: error => { throw error; },
      model: name => name === 'contest' ? { findById: async () => contest } : name === 'contest_ranklist' ? Ranklist : { findById: async () => ({ id: 11, title: 'Problem', isAllowedUseBy: async () => true }) } }
  });
  for (const filename of ['_api_v2_contest_domain.js', '_contest_interactions.js']) {
    vm.runInContext('{\n' + fs.readFileSync(path.join(__dirname, '../modules', filename), 'utf8') + '\n}', context, { filename });
  }
  async function request(method, route, userId, query = {}, body = {}) {
    const res = { locals: { user: userId ? { id: userId, is_admin: userId === 1 } : null, apiMeta: {} },
      setHeader: () => {}, render: (_template, values) => values, send: value => value, status: () => res };
    const req = { params: { id: '21' }, query, body, res, get: () => null };
    // HTML handlers return via res.render rather than returning its value.
    let rendered;
    res.render = (_template, values) => { rendered = values; return values; };
    const result = await routes.get(method + ' ' + route)(req, res);
    return res.apiResult || (result === undefined ? rendered : result);
  }
  return { get: (route, userId, query) => request('get', route, userId, query),
    save: (userId, body) => request('post', '/api/v2/contests/:id/update', userId, {}, body),
    create: (userId, body) => request('post', '/api/v2/contests', userId, {}, body),
    setNow: value => { now = value; }, setFreeze: value => { freezeMinutes = value; utils.invalidateContestReadCache(21); }, versions };
}

test('contest creation and external-compatible editing validate and preserve the freeze setting', async () => {
  const app = harness();
  assert.equal((await app.create(1, { title: 'New contest', start_at: 100, end_at: 400, problem_ids: [11], standings_freeze_after_minutes: 2 })).id, 21);
  const route = '/contest/:id/ranklist';
  assert.equal((await app.get(route, 7)).standingsView.frozen, true);
  assert.equal((await app.save(1, { standings_freeze_after_minutes: null })).error.code, 'PRECONDITION_REQUIRED');
  assert.equal((await app.save(3, { if_match: 'fixture-etag', standings_freeze_after_minutes: null })).error.code, 'CAPABILITY_REQUIRED');
  assert.equal((await app.save(2, { if_match: 'stale', standings_freeze_after_minutes: null })).error.code, 'ETAG_MISMATCH');
  for (const value of [-1, 1.5, 5, 'bad']) {
    assert.equal((await app.save(2, { if_match: 'fixture-etag', standings_freeze_after_minutes: value })).error.code, 'CONTEST_FREEZE_INVALID');
  }
  assert.equal((await app.save(2, { if_match: 'fixture-etag', standings_freeze_after_minutes: null })).id, 21);
  assert.equal((await app.get(route, 7)).standingsView.frozen, false);
  assert.equal((await app.save(2, { if_match: 'fixture-etag', standings_freeze_after_minutes: 0 })).id, 21);
  assert.equal((await app.get(route, 7)).standingsView.frozen, true);
  assert.equal((await app.save(2, { if_match: 'fixture-etag', title: 'Rename only' })).id, 21);
  assert.equal((await app.get(route, 7)).standingsView.freezeAt, 100);
});

test('actual standings API defaults managers to frozen and denies participant/guest/unrelated manager live bypass', async () => {
  const app = harness();
  const route = '/api/v2/contests/:id/standings';
  for (const userId of [1, 2, 7, 3]) {
    const result = await app.get(route, userId);
    assert.equal(result.frozen, true);
    assert.equal(result.rows.find(row => row.user_id === 7).score, 0);
  }
  for (const userId of [7, 3]) {
    for (const view of ['live', 'final', 'frozen']) {
      const result = await app.get(route, userId, { view });
      assert.equal(result.rows.find(row => row.user_id === 7).score, 0);
      assert.equal(result.view, 'public');
    }
  }
  assert.equal((await app.get(route, null, { view: 'live' })).error.code, 'STANDINGS_HIDDEN');
  for (const userId of [1, 2]) assert.equal((await app.get(route, userId, { view: 'live' })).rows.find(row => row.user_id === 7).score, 1);
  const again = await app.get(route, 2);
  assert.equal(again.rows.find(row => row.user_id === 7).score, 0);
  assert.equal(app.versions.filter(version => version.kind === 'frozen').length, 1);
  app.setNow(400);
  const ended = await app.get(route, 7);
  assert.equal(ended.frozen, false);
  assert.equal(ended.version.kind, 'final');
  assert.equal(ended.rows.find(row => row.user_id === 7).score, 1);
});

test('HTML standings isolate live cache, retain class/account ranks and export the selected view', async () => {
  const app = harness();
  const route = '/contest/:id/ranklist';
  const live = await app.get(route, 2, { view: 'live' });
  assert.equal(live.ranklist.find(row => row.user.id === 7).player.score, 1);
  for (const userId of [null, 7, 3, 1, 2]) {
    const frozen = await app.get(route, userId);
    assert.equal(frozen.ranklist.find(row => row.user.id === 7).player.score, 0);
  }
  const bypass = await app.get(route, 3, { view: 'live' });
  assert.equal(bypass.standingsView.showLive, false);
  const filtered = await app.get(route, 2, { account: 'ordinary', classes: '3', identity: 'real' });
  assert.deepEqual(Array.from(filtered.ranklist, row => [row.user.id, row.player.standing_rank, row.player.overall_standing_rank]), [[7, 1, 2], [9, 1, 2]]);
  assert.equal(filtered.ranklistProfiles.get(7).real_name, '甲');
  const exported = await app.get('/contest/:id/ranklist/export', 2);
  assert.match(exported, /"player7","甲","20260007","学院","班级","0","0","未通过","1",""/);
  const liveExported = await app.get('/contest/:id/ranklist/export', 2, { view: 'live' });
  assert.match(liveExported, /"player7","甲","20260007","学院","班级","1","1320","通过","2","120"/);
  for (const userId of [null, 7, 3]) assert.ok((await app.get('/contest/:id/ranklist/export', userId, { view: 'live' })).err);
  app.setFreeze(null);
  assert.equal((await app.get(route, 7)).ranklist.find(row => row.user.id === 7).player.score, 1);
  app.setFreeze(2);
  app.setNow(400);
  assert.equal((await app.get(route, 7)).ranklist.find(row => row.user.id === 7).player.score, 1);
});
