'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { TRANSITIONS, contestConfigurationLocked, resolveContestStatus, snapshotRefreshAllowed, standingsVisibility, transitionAllowed } = require('../libs/contest-lifecycle');

const contestMutationSource = fs.readFileSync(path.join(__dirname, '../libs/contest-mutation.js'), 'utf8');
const contestRouteSource = fs.readFileSync(path.join(__dirname, '../modules/_contest_registration.js'), 'utf8');
const contestApiSource = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_contest_domain.js'), 'utf8');

test('contest lifecycle contains every designed state and only explicit transitions', () => {
  assert.deepEqual(Object.keys(TRANSITIONS), ['draft', 'review', 'scheduled', 'running', 'frozen', 'ended', 'rated', 'archived']);
  assert.equal(transitionAllowed('draft', 'review'), true);
  assert.equal(transitionAllowed('review', 'scheduled'), true);
  assert.equal(transitionAllowed('running', 'frozen'), true);
  assert.equal(transitionAllowed('frozen', 'running'), true);
  assert.equal(transitionAllowed('ended', 'rated'), true);
  assert.equal(transitionAllowed('rated', 'running'), false);
  assert.equal(transitionAllowed('archived', 'draft'), false);
});

test('scheduled and running states advance from database time without overriding explicit workflow states', () => {
  const contest = { start_time: 100, end_time: 200 };
  assert.equal(resolveContestStatus(contest, null, 50), 'scheduled');
  assert.equal(resolveContestStatus(contest, { status: 'scheduled' }, 150), 'running');
  assert.equal(resolveContestStatus(contest, { status: 'running' }, 250), 'ended');
  assert.equal(resolveContestStatus(contest, { status: 'frozen' }, 250), 'frozen');
  assert.equal(resolveContestStatus(contest, { status: 'draft' }, 250), 'draft');
});

test('critical contest configuration is locked from running through archive', () => {
  assert.equal(contestConfigurationLocked('scheduled'), false);
  for (const status of ['running', 'frozen', 'ended', 'rated', 'archived']) assert.equal(contestConfigurationLocked(status), true);
});

test('contest snapshots are refreshed while publishing, never while entering the running state', () => {
  assert.equal(snapshotRefreshAllowed('publish'), true);
  for (const action of ['start', 'freeze', 'unfreeze', 'end', 'rate', 'archive']) assert.equal(snapshotRefreshAllowed(action), false);
});

test('standings visibility distinguishes hidden contests, participants, public results, and operators', () => {
  assert.equal(standingsVisibility({ isPublic: false, status: 'running', participant: false, fullScope: false, canSeeResults: false, canSeeOthers: false }), 'not_found');
  assert.equal(standingsVisibility({ isPublic: true, status: 'scheduled', participant: false, fullScope: false, canSeeResults: false, canSeeOthers: false }), 'hidden');
  assert.equal(standingsVisibility({ isPublic: true, status: 'running', participant: true, fullScope: false, canSeeResults: true, canSeeOthers: true }), 'visible');
  assert.equal(standingsVisibility({ isPublic: true, status: 'frozen', participant: true, fullScope: false, canSeeResults: true, canSeeOthers: false }), 'hidden');
  assert.equal(standingsVisibility({ isPublic: true, status: 'ended', participant: false, fullScope: false, canSeeResults: false, canSeeOthers: false }), 'visible');
  assert.equal(standingsVisibility({ isPublic: false, status: 'scheduled', participant: false, fullScope: true, canSeeResults: false, canSeeOthers: false }), 'visible');
});

test('contest writes atomically maintain legacy rows, v2 projections, and the domain event', () => {
  assert.match(contestMutationSource, /async function syncContestV2Projection\(manager, contestId, input, isNew, now\)/);
  assert.match(contestMutationSource, /!problemIds\.length \? 'draft'/);
  assert.match(contestMutationSource, /INSERT INTO contest_v2_state/);
  assert.match(contestMutationSource, /INSERT INTO contest_v2_config/);
  assert.match(contestMutationSource, /INSERT IGNORE INTO contest_v2_standings_current/);
  assert.match(contestMutationSource, /INSERT INTO api_v2_event/);
  assert.equal((contestMutationSource.match(/await syncContestV2Projection\(manager,/g) || []).length, 2);
  assert.doesNotMatch(contestRouteSource, /app\.(?:post|put|patch|delete)\('\/contest\//);
  assert.match(contestApiSource, /Promise\.all\(\[ensureContestV2Schema\(\), api\.ensureFoundationSchema\(\)\]\)[\s\S]*contestMutation\.saveContest/);
});

test('v2 contest writes retain legacy validation and shared deletion behavior', () => {
  const deletion = fs.readFileSync(path.join(__dirname, '../libs/contest-deletion.js'), 'utf8');
  assert.match(contestApiSource, /Problem\.findById\(problemId\)/);
  assert.match(contestApiSource, /problem\.isAllowedUseBy\(user\)/);
  assert.match(contestApiSource, /CONTEST_PROBLEM_UNAVAILABLE/);
  assert.match(contestApiSource, /CONTEST_RANKING_INVALID/);
  assert.match(contestApiSource, /User\.findById\(adminId\)/);
  assert.match(contestApiSource, /app\.delete\('\/api\/v2\/contests\/:id'/);
  assert.match(contestApiSource, /contestDeletion\.deleteContest\(req, contest, res\.locals\.user\)/);
  assert.match(deletion, /action: 'contest:delete'/);
  assert.match(deletion, /contest\.deleted/);
});

test('contest deletion removes every rebuildable v2 projection in the legacy transaction', () => {
  for (const table of ['contest_v2_standing_row', 'contest_v2_standings_current', 'contest_v2_standings_version', 'contest_v2_problem_snapshot', 'contest_v2_config', 'contest_v2_state']) {
    assert.match(contestMutationSource, new RegExp('DELETE[^;]+' + table, 's'));
  }
});

test('authorized deletion supports a running contest and removes every submission projection', () => {
  const contestRatingSource = fs.readFileSync(path.join(__dirname, '../libs/contest-rating.js'), 'utf8');
  const registrationView = fs.readFileSync(path.join(__dirname, '../views/contest_registrations.ejs'), 'utf8');

  assert.match(contestRatingSource, /allowStarted: true,[\s\S]*allowPending: true,[\s\S]*deleteSubmissions: true/);
  for (const table of [
    'vjudge_v2_submission_sync', 'admin_v2_rejudge_item', 'submission_v2_job',
    'submission_v2_result_revision', 'submission_v2_attempt', 'submission_v2_projection',
    'submission_v2_code_version', 'judge_state_admin_action', 'judge_state'
  ]) assert.match(contestMutationSource, new RegExp('DELETE[^;]+' + table, 's'));
  assert.match(registrationView, /class="app-icon-button app-icon-danger" type="submit" title="删除参赛者" aria-label="删除参赛者"/);
  assert.doesNotMatch(registrationView, /<\/i>删除参赛者<\/button>/);
});
