'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const status = require('../libs/judge-status');
const consistency = require('../libs/migration-consistency');
const releaseGate = require('../libs/migration-release-gate');

test('v2 schema initialization is additive and never destructively alters legacy tables', () => {
  const modulesRoot = path.join(__dirname, '../modules');
  const sources = fs.readdirSync(modulesRoot)
    .filter(name => /^_api_v2.*\.js$/.test(name))
    .map(name => fs.readFileSync(path.join(modulesRoot, name), 'utf8'))
    .join('\n');
  const destructiveSchema = /\b(?:DROP\s+TABLE|TRUNCATE\s+TABLE|DROP\s+COLUMN|RENAME\s+TABLE)\b/i;
  const legacyTables = new Set([
    'user', 'problem', 'submission', 'contest', 'rating_history', 'article', 'discussion',
    'solution', 'message', 'notification', 'ticket', 'banner'
  ]);
  const alteredTables = Array.from(sources.matchAll(/ALTER\s+TABLE\s+([a-z][a-z0-9_]*)/gi), match => match[1].toLowerCase());

  assert.doesNotMatch(sources, destructiveSchema);
  assert.ok(alteredTables.length > 0, 'the audit must cover real additive schema upgrades');
  for (const table of alteredTables) {
    assert.equal(legacyTables.has(table), false, `v2 schema initialization must not alter legacy table ${table}`);
  }
  assert.match(sources, /CREATE TABLE IF NOT EXISTS api_v2_event/);
  assert.match(sources, /CREATE TABLE IF NOT EXISTS problem_v2_version/);
  assert.match(sources, /CREATE TABLE IF NOT EXISTS submission_v2_projection/);
  assert.match(sources, /CREATE TABLE IF NOT EXISTS contest_v2_state/);
  assert.match(sources, /CREATE TABLE IF NOT EXISTS rating_v2_event/);
});

test('judge status rules match the runtime queue semantics', () => {
  assert.equal(status.statusForJudge({ status: 'Waiting', pending: 1 }), 'queued');
  assert.equal(status.statusForJudge({ status: 'Compiling', pending: 1 }), 'compiling');
  assert.equal(status.statusForJudge({ status: 'Judging', pending: 1 }), 'judging');
  assert.equal(status.statusForJudge({ status: 'Accepted', pending: 0 }), 'accepted');
  assert.equal(status.statusForJudge({ status: 'Unknown', pending: '1' }), 'judging');
  assert.equal(status.statusForJudge({ status: 'Unknown', pending: '0' }), 'queued');
  assert.equal(status.statusForJudge({ status: 'Accepted', pending: 0 }, 'cancelled'), 'cancelled');
});

test('migration status SQL contains the same explicit legacy states', () => {
  const sql = status.sqlStatusCase('legacy.status', 'legacy.pending');
  for (const state of ['Waiting', 'Compiling', 'Judging', 'Accepted', 'Cancelled']) assert.match(sql, new RegExp(`WHEN '${state}'`));
  assert.match(sql, /legacy\.pending=1/);
});

test('consistency details are discrepancies, not raw projection counts', () => {
  const item = consistency.item('contests', 3, 3, { state: 3, missing_config: 0 });
  assert.deepEqual(item.details, { state: 3, missing_config: 0 });
  assert.equal(item.migration_domain, 'contest');
  assert.equal(item.consistent, false);
  assert.equal(consistency.item('contests', 3, 3, { missing_config: 0 }).consistent, true);
});

test('migration archive keeps canonical domain mappings without exposing mutation controls', () => {
  const expected = { identity: 'identity', problems: 'problem', submissions: 'submission', contests: 'contest', ratings: 'rating' };
  for (const [domain, migrationDomain] of Object.entries(expected)) {
    assert.equal(consistency.item(domain, 0, 0, {}).migration_domain, migrationDomain);
  }
});

test('migration status uses the canonical v2 route and restores the latest run for every domain', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_migration.js'), 'utf8');
  const view = fs.readFileSync(path.join(__dirname, '../views/admin_info.ejs'), 'utf8');

  assert.match(source, /app\.get\('\/api\/v2\/admin\/migrations\/consistency'/);
  assert.doesNotMatch(source, /app\.get\('\/api\/v2\/admin\/migrations-consistency'/);
  assert.match(source, /async function latestMigrationRuns\(\)/);
  assert.match(source, /NOT EXISTS \([\s\S]*newer\.domain=run\.domain/);
  assert.match(source, /return \{ \.\.\.report, compatibility, runs \}/);
  assert.doesNotMatch(view, /fetch\('\/api\/v2\/admin\/migrations\/consistency'/);
  assert.doesNotMatch(view, /updateRuns\(data\.runs\)/);
});

test('migration creation reuses an active domain run and prevents concurrent projection rebuilds', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_migration.js'), 'utf8');

  assert.match(source, /idx_api_v2_migration_active\(domain,state,created_at\)/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS api_v2_migration_lock/);
  assert.match(source, /SELECT domain FROM api_v2_migration_lock WHERE domain=\? FOR UPDATE/);
  assert.match(source, /TypeORM\.getConnection\(\)\.transaction\(async manager =>/);
  assert.match(source, /state IN \('queued','running','cancelling'\)[^;]+FOR UPDATE/);
  assert.match(source, /if \(active\.length\) return \{ created: false, run: serialize\(active\[0\]\), auditEventId: null \}/);
  assert.match(source, /reused_existing_run: !result\.created/);
  assert.match(source, /if \(result\.created\) \{[\s\S]*setImmediate\(\(\) => runMigration/);
});

test('migration archive is removed from the admin overview after the final consistency pass', () => {
  const view = fs.readFileSync(path.join(__dirname, '../views/admin_info.ejs'), 'utf8');

  assert.doesNotMatch(view, /迁移归档|迁移发布证据|data-migration-workspace|data-migration-domains|data-migration-compatibility/);
  assert.doesNotMatch(view, /\/api\/v2\/admin\/(?:jobs|migrations)/);
});

test('v2 release remains blocked until a consistent observation window records a contest cycle and rollback rehearsal', () => {
  const domains = [{ domain: 'problems', consistent: true }, { domain: 'contests', consistent: true }];
  const rollouts = releaseGate.REQUIRED_ROLLOUT_DOMAINS.map(domain => ({ domain, enabled: true, percentage: 100 }));
  const rollbackRehearsal = { version: 1, consistency_verified: true, disabled_verified: true, restored_verified: true, rollouts };
  const initial = releaseGate.releaseGate({ domains });
  assert.deepEqual(initial.blockers, [
    'compatibility_window_not_started', 'rollout_not_fully_enabled', 'complete_contest_cycle_not_observed', 'rollback_rehearsal_missing'
  ]);
  const inconsistent = releaseGate.releaseGate({
    domains: [{ domain: 'submissions', consistent: false }], compatibility_started_at: '2026-07-30T00:00:00.000Z',
    complete_contest_cycles: 1, rollback_rehearsed_at: '2026-07-31T00:00:00.000Z', rollback_rehearsal: rollbackRehearsal,
    rollouts
  });
  assert.deepEqual(inconsistent.inconsistent_domains, ['submissions']);
  assert.equal(inconsistent.ready_for_v2_release, false);
  const ready = releaseGate.releaseGate({
    domains, compatibility_started_at: '2026-07-30T00:00:00.000Z', complete_contest_cycles: 1,
    rollback_rehearsed_at: '2026-07-31T00:00:00.000Z', rollback_rehearsal: rollbackRehearsal,
    rollouts
  });
  assert.equal(ready.v1_routes_removed, true);
  assert.equal(ready.ready_for_v2_release, true);
});

test('rollout and rollback evidence must remain exact after rehearsal', () => {
  const rollouts = releaseGate.REQUIRED_ROLLOUT_DOMAINS.map(domain => ({ domain, enabled: true, percentage: 100 }));
  const proof = { version: 1, consistency_verified: true, disabled_verified: true, restored_verified: true, rollouts };
  const changed = rollouts.map(row => row.domain === 'rating' ? { ...row, enabled: false, percentage: 0 } : row);
  const status = releaseGate.releaseGate({
    domains: [], rollouts: changed, compatibility_started_at: '2026-07-30T00:00:00.000Z', complete_contest_cycles: 1,
    rollback_rehearsed_at: '2026-07-31T00:00:00.000Z', rollback_rehearsal: proof
  });
  assert.deepEqual(status.incomplete_rollout_domains, ['rating']);
  assert.equal(status.rollback_rehearsal_verified, false);
  assert.ok(status.blockers.includes('rollout_not_fully_enabled'));
  assert.ok(status.blockers.includes('rollback_rehearsal_unverified'));
});

test('compatibility observation cannot start while any projection is inconsistent', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_migration.js'), 'utf8');
  const startRoute = source.slice(
    source.indexOf("app.post('/api/v2/admin/migrations/compatibility/start'"),
    source.indexOf("app.post('/api/v2/admin/migrations/compatibility/rehearse-rollback'")
  );

  assert.match(startRoute, /const report = await migrationConsistencyReport\(\)/);
  assert.match(startRoute, /if \(!report\.consistent\) return api\(\)\.fail\(res, 409, 'MIGRATION_NOT_CONSISTENT'/);
  assert.match(startRoute, /MIGRATION_ROLLOUT_INCOMPLETE/);
  assert.ok(startRoute.indexOf('MIGRATION_NOT_CONSISTENT') < startRoute.indexOf('api_v2_migration_compatibility'));
});

test('problem migration backfills stable VJudge source mappings and audits mapping discrepancies', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_migration.js'), 'utf8');
  const problemDomainSource = fs.readFileSync(path.join(__dirname, '../libs/problem-domain.js'), 'utf8');
  assert.match(source, /problemDomain\.syncSourceProjection\(manager, problem\)/);
  assert.match(source, /async function migrateProblemSource/);
  assert.match(problemDomainSource, /INSERT INTO vjudge_v2_remote_problem/);
  assert.match(problemDomainSource, /VJUDGE_SOURCE_CONFLICT/);
  assert.match(source, /syzoj\.utils\.vjudgeV2\.ensureSchema\(\)/);
  for (const field of ['remote_source_missing', 'remote_source_orphaned', 'remote_source_mismatch', 'remote_source_invalid', 'remote_source_duplicates']) {
    assert.match(source, new RegExp(field));
  }
});

test('problem migration retries transient lock failures before recording a real failure', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_migration.js'), 'utf8');
  assert.match(source, /const RETRYABLE_MIGRATION_ERRORS = new Set\(\['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', '1213', '1205'\]\)/);
  assert.match(source, /async function retryMigrationStep\(work\)/);
  assert.match(source, /retryMigrationStep\(\(\) => syzoj\.utils\.problemV2\.ensureCurrentSnapshot/);
  assert.match(source, /retryMigrationStep\(\(\) => migrateProblemSource/);
  assert.match(source, /const terminalState = result\.failures\.length \? 'failed' : 'completed'/);
});

test('identity migration projects legacy users without duplicating or rewriting the canonical user table', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_migration.js'), 'utf8');
  const registration = fs.readFileSync(path.join(__dirname, '../modules/_registration_identity.js'), 'utf8');

  assert.match(source, /async function migrateIdentities\(runId\)/);
  assert.match(source, /INSERT IGNORE INTO auth_user_state/);
  assert.match(source, /identity\.projection\.seeded/);
  assert.match(source, /event\.type IN \('user\.registered','identity\.projection\.seeded'\)/);
  assert.match(source, /\['identity', 'problem', 'submission', 'contest', 'rating'\]/);
  assert.match(source, /migrationConsistency\.item\('identity'/);
  assert.doesNotMatch(source, /migrateIdentities[\s\S]*?UPDATE user SET/);

  const createAccount = registration.slice(
    registration.indexOf('async function createAccount'),
    registration.indexOf('function validRegistrationCsrf')
  );
  assert.match(createAccount, /TypeORM\.getConnection\(\)\.transaction\(async manager =>/);
  assert.match(createAccount, /INSERT INTO user\s/);
  assert.match(createAccount, /INSERT INTO auth_user_state/);
  assert.match(createAccount, /'user\.registered'/);
  assert.match(createAccount, /apiV2\.publishEvent\(domainEvent\)/);
});
