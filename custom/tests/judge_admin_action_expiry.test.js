'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const seconds = time => Date.parse(time) / 1000;
const mark = (judgeId, userId, time, actionType = 'cheated') => Object.freeze({
  judge_id: judgeId, affected_user_id: userId, operator_time: seconds(time), action_type: actionType
});

function harness(initialRows = [], initialNow = '2026-10-18T12:00:00+08:00') {
  let rows = initialRows, now = seconds(initialNow), failure = false;
  const timers = [], errors = [];
  const actions = { async find() { if (failure) throw new Error('fixture read error'); return rows; } };
  const syzoj = { utils: {}, log: error => errors.push(error), model: name => {
    if (name === 'judge-state-admin-action') return actions;
    return {};
  } };
  const context = vm.createContext({
    syzoj, app: { post() {}, delete() {} }, require: () => ({}),
    Date: class extends Date { static now() { return now * 1000; } },
    setTimeout: (callback, delay) => timers.push({ type: 'timeout', callback, delay }),
    setInterval: (callback, delay) => timers.push({ type: 'interval', callback, delay })
  });
  vm.runInContext(read('modules/_judge_admin_action.js'), context);
  return { syzoj, context, timers, errors,
    expires: time => context.cheaterNameExpiresAt(seconds(time)),
    refresh: () => syzoj.utils.refreshJudgeAdminActionCache(),
    setNow: time => { now = seconds(time); },
    setRows: next => { rows = next; },
    failReads: () => { failure = true; }
  };
}

test('brown names expire after three calendar months in Beijing time, with month-end clamping', () => {
  const f = harness();
  for (const [start, end] of [
    ['2026-10-18T22:30:00+08:00', '2027-01-18T22:30:00+08:00'],
    ['2026-01-31T01:15:20+08:00', '2026-04-30T01:15:20+08:00'],
    ['2026-11-30T23:59:59+08:00', '2027-02-28T23:59:59+08:00'],
    ['2027-11-30T00:00:00+08:00', '2028-02-29T00:00:00+08:00'],
    ['2026-08-31T00:00:00+08:00', '2026-11-30T00:00:00+08:00'],
    ['2026-08-30T00:00:00+08:00', '2026-11-30T00:00:00+08:00'],
    ['2028-02-29T08:09:10+08:00', '2028-05-29T08:09:10+08:00']
  ]) assert.equal(f.expires(start), seconds(end), start);
  for (const invalid of [undefined, null, '', 'invalid', 0, -1, Infinity]) {
    assert.equal(f.context.cheaterNameExpiresAt(invalid), 0);
  }
});

test('expiry and automatic minute refresh change only the username cache, never historical submission marks', async () => {
  const rows = Object.freeze([
    mark(101, 7, '2026-07-18T12:00:00+08:00'),
    mark(102, 8, '2025-01-01T12:00:00+08:00', 'cancelled')
  ]);
  const before = JSON.stringify(rows);
  const f = harness(rows, '2026-10-18T11:59:59+08:00');
  const startup = f.timers.find(timer => timer.type === 'timeout');
  const periodic = f.timers.find(timer => timer.type === 'interval');
  assert.equal(startup.delay, 1000);
  assert.equal(periodic.delay, 60000);
  await startup.callback();
  assert.deepEqual([...f.syzoj.cheaterUserIds], [7]);
  f.setNow('2026-10-18T12:00:00+08:00');
  await periodic.callback();
  assert.deepEqual([...f.syzoj.cheaterUserIds], []);
  assert.deepEqual([...f.syzoj.cheatedJudgeIds], [101]);
  assert.deepEqual([...f.syzoj.cancelledJudgeIds], [102]);
  assert.equal(JSON.stringify(rows), before);
});

test('existing marks use their original date and the latest unrevoked cheating mark extends the period', async () => {
  const old = mark(101, 7, '2026-06-01T09:00:00+08:00');
  const recent = mark(102, 7, '2026-09-01T09:00:00+08:00');
  const f = harness([recent, old, mark(103, 8, '2026-10-18T09:00:00+08:00', 'cancelled')]);
  await f.refresh();
  assert.deepEqual([...f.syzoj.cheaterUserIds], [7]);
  f.setNow('2026-12-01T08:59:59+08:00');
  await f.refresh();
  assert.equal(f.syzoj.cheaterUserIds.has(7), true);
  f.setNow('2026-12-01T09:00:00+08:00');
  await f.refresh();
  assert.equal(f.syzoj.cheaterUserIds.has(7), false);
  assert.deepEqual([...f.syzoj.cheatedJudgeIds].sort(), [101, 102]);
  const repeated = mark(104, 7, '2026-12-02T10:00:00+08:00');
  f.setNow('2026-12-02T10:00:00+08:00');
  f.setRows([old, recent, repeated]);
  await f.refresh();
  assert.equal(f.syzoj.cheaterUserIds.has(7), true);
  f.setRows([old, recent]); // Revoking the only active mark restores the name early.
  await f.refresh();
  assert.equal(f.syzoj.cheaterUserIds.has(7), false);
});

test('a cache read failure keeps the previous complete cache and reports the error', async () => {
  const f = harness([mark(101, 7, '2026-10-01T09:00:00+08:00')]);
  await f.refresh();
  const previous = f.syzoj.cheaterUserIds;
  f.failReads();
  await f.refresh();
  assert.equal(f.syzoj.cheaterUserIds, previous);
  assert.equal(f.syzoj.cheatedJudgeIds.has(101), true);
  assert.equal(f.errors.length, 1);
});

test('expiry restores profile, submission and global/weekly client colors while preserving the cheating result', async () => {
  const f = harness([mark(101, 7, '2026-07-18T12:00:00+08:00')], '2026-10-18T11:59:59+08:00');
  f.syzoj.userHitScores = new Map([[7, { total: 250 }]]);
  f.syzoj.userTags = new Map([[7, { text: '原牌子', tier: 'blue' }]]);
  vm.runInContext(read('modules/_username_renderer.js'), f.context);
  const submissions = read('views/submissions.ejs');
  vm.runInContext(submissions.slice(submissions.indexOf('function submissionUserTier('), submissions.indexOf('function submissionLink(')), f.context);
  const header = read('views/app_header.ejs');
  const tierMap = () => vm.runInNewContext(header.slice(header.indexOf('let appTierMap ='), header.indexOf('const appCheatedJudgeIds =')) + '\nappTierMap;', { syzoj: f.syzoj });
  await f.refresh();
  assert.match(f.syzoj.utils.renderUsername({ id: 7, username: 'fixture-user' }), /username-tier-cheater/);
  assert.equal(f.context.submissionUserTier(7), 'cheater');
  assert.equal(f.context.submissionUserTag(7), null);
  assert.equal(tierMap()[7], 'cheater');
  f.setNow('2026-10-18T12:00:00+08:00');
  await f.refresh();
  const html = f.syzoj.utils.renderUsername({ id: 7, username: 'fixture-user' });
  assert.match(html, /username-tier-green/);
  assert.match(html, /原牌子/);
  assert.doesNotMatch(html, /username-tier-cheater|tag-tier-cheater/);
  assert.equal(f.context.submissionUserTier(7), 'green');
  assert.equal(f.context.submissionUserTag(7).text, '原牌子');
  assert.equal(tierMap()[7], 'green');
  assert.equal(f.syzoj.cheatedJudgeIds.has(101), true);
  assert.match(submissions, /adminActionType === 'cheated'\) return '作弊'/);
  assert.match(read('views/user_edit.ejs'), /最近一次作弊标记满 3 个月或全部标记撤销后恢复/);
});
