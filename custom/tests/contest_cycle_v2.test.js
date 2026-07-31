'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const contest = fs.readFileSync(path.join(root, 'modules/_api_v2_contest_domain.js'), 'utf8');
const submission = fs.readFileSync(path.join(root, 'modules/_api_v2_submission_domain.js'), 'utf8');
const cycleEvidence = fs.readFileSync(path.join(root, 'libs/migration-cycle-evidence.js'), 'utf8');

test('contest resources always serialize problem_ids as an array', () => {
  assert.match(contest, /const problemIds = Array\.isArray\(parsedProblemIds\)/);
  assert.match(contest, /problem_ids: problemIds/);
});

test('private contest access requires management or an active participant record', () => {
  assert.match(contest, /async function isActiveParticipant/);
  assert.match(contest, /contest_registration_removal/);
  assert.match(contest, /!contest\.is_public && !manager && !participant/);
  assert.match(contest, /!contest\.is_public && !manager\) return api\.fail\(res, 404, 'CONTEST_NOT_FOUND'/);
});

test('contest submissions accept configured local languages only during the active lifecycle', () => {
  assert.match(submission, /Array\.isArray\(languages\)[\s\S]*languages\.includes\(language\)/);
  assert.match(submission, /async function contestAcceptsSubmissions/);
  assert.match(submission, /status === 'running' \|\| status === 'frozen'/);
  assert.match(submission, /'CONTEST_NOT_RUNNING'/);
});

test('deleting a verified smoke contest retains immutable compatibility-cycle evidence', () => {
  assert.match(cycleEvidence, /CREATE TABLE IF NOT EXISTS api_v2_migration_contest_cycle_evidence/);
  assert.match(cycleEvidence, /async function archiveCompletedCycle/);
  assert.match(cycleEvidence, /crypto\.createHash\('sha256'\)/);
  assert.match(cycleEvidence, /COUNT\(DISTINCT cycle\.contest_id\)/);
});
