'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_migration.js'), 'utf8');

test('submission migration creates a durable replay baseline for legacy projections', () => {
  assert.match(migration, /function migrationSubmissionStatus\(row\)/);
  assert.match(migration, /judgeStatus\.statusForJudge\(row\)/);
  assert.match(migration, /migrationSnapshotForSubmission/);
  assert.match(migration, /async function ensureSubmissionMigrationEvent\(manager, submissionId\)/);
  assert.match(migration, /submission\.projection\.seeded/);
  assert.match(migration, /await syzoj\.utils\.submissionV2\.ensureSchema\(\)/);
  assert.match(migration, /connection\.transaction\(async manager =>/);
  assert.match(migration, /await ensureSubmissionMigrationEvent\(manager, row\.id\)/);
  assert.match(migration, /ensureSubmissionCodeVersion\(manager, row\)/);
  assert.match(migration, /submission\.code_version\.backfilled/);
});

test('migration consistency detects missing projection IDs and event baselines, not only matching counts', () => {
  assert.match(migration, /identities_legacy_missing_v2/);
  assert.match(migration, /identities_v2_orphaned/);
  assert.match(migration, /identities_invalid_status/);
  assert.match(migration, /identities_missing_event_baseline/);
  assert.match(migration, /problems_legacy_missing_v2/);
  assert.match(migration, /problems_v2_orphaned/);
  assert.match(migration, /problems_missing_snapshot/);
  assert.match(migration, /submissions_legacy_missing_v2/);
  assert.match(migration, /submissions_v2_orphaned/);
  assert.match(migration, /submissions_missing_event_baseline/);
  assert.match(migration, /submissions_missing_snapshot/);
  assert.match(migration, /submissions_missing_code_version/);
  assert.match(migration, /submissions_code_version_orphaned/);
  assert.match(migration, /submissions_code_version_mismatch/);
  assert.match(migration, /submissions_code_version_event_missing/);
  assert.match(migration, /submissions_status_mismatch/);
  assert.match(migration, /submissions_identity_mismatch/);
  assert.match(migration, /contests_legacy_missing_config/);
  assert.match(migration, /contests_config_orphaned/);
  assert.match(migration, /ratings_value_mismatch/);
  assert.match(migration, /ratings_current_missing/);
  assert.match(migration, /ratings_current_value_mismatch/);
  assert.match(migration, /missing_event_baseline/);
  assert.match(migration, /migrationConsistency\.item\('contests'/);
  assert.doesNotMatch(migration, /details:\s*\{ state: Number\(row\.contests_state_v2\)/);
});

test('contest migration removes deleted-contest projections and never reports item failures as completed', () => {
  assert.match(migration, /async function removeOrphanContestProjections\(connection\)/);
  for (const table of ['contest_v2_state', 'contest_v2_config', 'contest_v2_problem_snapshot', 'contest_v2_standings_current', 'contest_v2_standings_version', 'contest_v2_standing_row']) {
    assert.match(migration, new RegExp('DELETE[^;]+' + table.replace(/_/g, '_'), 's'));
  }
  assert.match(migration, /const terminalState = result\.failures\.length \? 'failed' : 'completed'/);
  assert.match(migration, /removed_orphans/);
});

test('Rating history migration builds the current projection from each user\'s latest event', () => {
  assert.match(migration, /await syzoj\.utils\.ratingV2\.ensureSchema\(\)/);
  assert.match(migration, /INSERT INTO rating_v2_current/);
  assert.match(migration, /SELECT user_id,MAX\(id\) AS event_id FROM rating_v2_event/);
  assert.match(migration, /current\.user_id IS NULL/);
  assert.match(migration, /COALESCE\(event\.deviation_after,350\)/);
  assert.match(migration, /COALESCE\(event\.volatility_after,0\.06\)/);
});

test('migration compatibility observation records consistency and blocks rollback rehearsal before its gates', () => {
  assert.match(migration, /require\('\.\.\/libs\/migration-release-gate'\)/);
  assert.match(migration, /require\('\.\.\/libs\/migration-cycle-evidence'\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS api_v2_migration_compatibility/);
  assert.match(migration, /async function migrationConsistencyReport\(\)/);
  assert.match(migration, /async function migrationCompatibilityStatus\(report\)/);
  assert.match(migration, /complete_contest_cycles/);
  assert.match(migration, /\/api\/v2\/admin\/migrations\/compatibility\/start/);
  assert.match(migration, /\/api\/v2\/admin\/migrations\/compatibility\/rehearse-rollback/);
  assert.match(migration, /MIGRATION_NOT_CONSISTENT/);
  assert.match(migration, /MIGRATION_COMPATIBILITY_NOT_STARTED/);
  assert.match(migration, /rollback_rehearsed_at=UTC_TIMESTAMP\(3\)/);
  assert.match(migration, /rollback_rehearsal_json/);
  assert.match(migration, /UPDATE api_v2_rollout SET enabled=0,percentage=0/);
  assert.match(migration, /migrationReleaseGate\.sameRollouts/);
  assert.match(migration, /completedCycleSummary/);
  const evidence = fs.readFileSync(path.join(__dirname, '../libs/migration-cycle-evidence.js'), 'utf8');
  assert.match(evidence, /INNER JOIN judge_state submission/);
  assert.match(evidence, /contest_registration_removal removal/);
  assert.match(evidence, /evidence_hash/);
  assert.match(evidence, /UNION ALL/);
});
