'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const domain = require('../libs/submission-domain');

function event(id, type, payload = {}) { return { id, type, payload }; }
function scriptedManager(handler) {
  const calls = [];
  return { calls, async query(sql, params = []) {
    const compact = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: compact, params });
    return handler(compact, params, calls);
  } };
}

const created = event(1, 'submission.created', {
  submission_id: 51, problem_id: 7, snapshot_id: 'snap-7', user_id: 3, contest_id: null,
  language: 'cpp', code_version_id: 'code-version-51', source_visibility: 'private'
});

test('source visibility is explicit and grants code only to its owner, operators, or public viewers', () => {
  assert.equal(domain.normalizeSourceVisibility(undefined), 'private');
  assert.equal(domain.normalizeSourceVisibility('PUBLIC'), 'public');
  assert.throws(() => domain.normalizeSourceVisibility('contest'), error => error.code === 'VALIDATION_FAILED' && error.statusCode === 422);
  assert.equal(domain.sourceVisibleTo({ ownerId: 3, viewerId: 3, visibility: 'private' }), true);
  assert.equal(domain.sourceVisibleTo({ ownerId: 3, viewerId: 4, visibility: 'private' }), false);
  assert.equal(domain.sourceVisibleTo({ ownerId: 3, viewerId: 4, visibility: 'public' }), true);
  assert.equal(domain.sourceVisibleTo({ ownerId: 3, viewerId: 4, visibility: 'private', canReadAll: true }), true);
});

test('code versions persist immutable source metadata with a stable hash', async () => {
  const manager = scriptedManager(sql => {
    if (sql.startsWith('INSERT INTO submission_v2_code_version')) return { affectedRows: 1 };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const version = await domain.createCodeVersion(manager, {
    id: 'version-51', submissionId: 51, userId: 3, language: 'cpp', source: 'int main() {}', sourceVisibility: 'public'
  });
  assert.equal(version.id, 'version-51');
  assert.equal(version.source_hash, '00096d96da5299e65479678a8e79b07ab36e6185120e892a1360e1be25e84fbb');
  assert.equal(version.visibility, 'public');
  assert.equal(manager.calls.length, 1);
  assert.equal(manager.calls[0].params[5], 'int main() {}');
});

test('submission state machine permits observed phase skips but protects terminal results', () => {
  assert.equal(domain.canTransition(null, 'created'), true);
  assert.equal(domain.canTransition('created', 'judging'), true);
  assert.equal(domain.canTransition('queued', 'accepted'), true);
  assert.equal(domain.canTransition('accepted', 'queued'), false);
  assert.equal(domain.canTransition('accepted', 'queued', { allowTerminalReset: true }), true);
  assert.equal(domain.canTransition('wrong_answer', 'judging'), false);
  assert.throws(() => domain.assertTransition('accepted', 'judging'), error => error.code === 'SUBMISSION_TRANSITION_INVALID');
});

test('event replay deterministically rebuilds runtime and dispatch state', () => {
  const state = domain.replaySubmissionEvents([
    created,
    event(2, 'submission.queued', { dispatch_enabled: true }),
    event(3, 'submission.dispatch_failed', { dispatch_attempts: 1, error_code: 'JUDGE_DISPATCH_UNAVAILABLE', next_retry_at: '2026-07-30T01:02:03.000Z' }),
    event(4, 'submission.dispatched'),
    event(5, 'submission.status.changed', { status: 'judging' }),
    event(6, 'submission.status.changed', { status: 'accepted' })
  ]);
  assert.equal(state.status, 'accepted');
  assert.equal(state.dispatch_attempts, 1);
  assert.equal(state.dispatch_enabled, false);
  assert.equal(state.last_error, null);
  assert.equal(state.problem_id, 7);
  assert.equal(state.snapshot_id, 'snap-7');
  assert.equal(state.code_version_id, 'code-version-51');
});

test('projection seed is a replay checkpoint and rebuild markers do not mutate state', () => {
  const seeded = event(20, 'submission.projection.seeded', {
    submission_id: 51, problem_id: 7, user_id: 3, language: 'cpp', source_visibility: 'private',
    status: 'judging', attempts: 1, dispatch_attempts: 2, dispatch_enabled: false
  });
  const state = domain.replaySubmissionEvents([
    created, event(2, 'submission.status.changed', { status: 'wrong_answer' }), seeded,
    event(21, 'submission.projection.rebuilt', { status: 'judging' }),
    event(22, 'submission.status.changed', { status: 'accepted' })
  ]);
  assert.equal(state.status, 'accepted');
  assert.equal(state.attempts, 1);
  assert.equal(state.dispatch_attempts, 2);
});

test('only system errors are eligible for bounded automatic retry', () => {
  assert.equal(domain.shouldRetryAutomatically('system_error', 0), true);
  assert.equal(domain.shouldRetryAutomatically('system_error', 1), true);
  assert.equal(domain.shouldRetryAutomatically('system_error', 2), false);
  for (const status of ['accepted', 'wrong_answer', 'compile_error', 'runtime_error', 'time_limit', 'memory_limit']) {
    assert.equal(domain.shouldRetryAutomatically(status, 0), false, status);
  }
  assert.deepEqual([1, 2, 3, 7, 99].map(domain.retryDelaySeconds), [10, 20, 40, 300, 300]);
});

test('submission jobs recover only when replay is idempotent', () => {
  assert.equal(domain.recoveryDisposition('projection_rebuild', 'running'), 'queued');
  assert.equal(domain.recoveryDisposition('projection_rebuild', 'cancelling'), 'queued');
  assert.equal(domain.recoveryDisposition('rejudge', 'running'), 'failed');
  assert.equal(domain.recoveryDisposition('rejudge', 'cancelling'), 'failed');
  assert.equal(domain.recoveryDisposition('rejudge', 'queued', true), 'cancelled');
  assert.equal(domain.recoveryDisposition('projection_rebuild', 'completed'), 'completed');
});

test('public submission events expose only the state projection, not diagnostics or audit data', () => {
  const raw = {
    id: 99, stream: 'submission:51', type: 'submission.cancelled', aggregate_id: '51', actor_id: 8,
    created_at: '2026-07-30T00:00:00.000Z',
    payload: {
      submission_id: 51, problem_id: 7, status: 'cancelled', language: 'cpp',
      last_error: 'JUDGE_DISPATCH_UNAVAILABLE', dispatch_attempts: 2, attempt_id: '14',
      revision_id: '23', audit_event_id: 'audit-7', reason: 'operator note'
    }
  };
  const publicEvent = domain.serializeEventForViewer(raw);
  assert.deepEqual(publicEvent.payload, { submission_id: 51, problem_id: 7, language: 'cpp', status: 'cancelled' });
  assert.equal(Object.hasOwn(publicEvent, 'actor_id'), false);
  const diagnosticEvent = domain.serializeEventForViewer(raw, true);
  assert.equal(diagnosticEvent.payload.audit_event_id, 'audit-7');
  assert.equal(diagnosticEvent.actor_id, 8);
});

test('transactional transition locks projection before writing attempt and immutable event', async () => {
  const order = [];
  const manager = scriptedManager(sql => {
    if (sql.startsWith('SELECT * FROM submission_v2_projection')) { order.push('lock'); return [{ submission_id: 51, status: 'queued', attempts: 0, dispatch_attempts: 0, dispatch_enabled: 1 }]; }
    if (sql.startsWith('UPDATE submission_v2_projection')) { order.push('projection'); return { affectedRows: 1 }; }
    if (sql.startsWith('INSERT INTO submission_v2_attempt')) { order.push('attempt'); return { insertId: 31 }; }
    if (sql.startsWith('INSERT INTO api_v2_event')) { order.push('event'); return { insertId: 41 }; }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const result = await domain.transitionProjection(manager, {
    submissionId: 51, status: 'judging', operation: 'runtime_status', actorId: 3,
    eventType: 'submission.status.changed'
  });
  assert.deepEqual(order, ['lock', 'projection', 'attempt', 'event']);
  assert.equal(result.event.id, '41');
  assert.equal(result.projection.status, 'judging');
  assert.equal(result.event.payload.attempt_id, '31');
});

test('event insert failure escapes the domain transition so its transaction can roll back', async () => {
  const manager = scriptedManager(sql => {
    if (sql.startsWith('SELECT * FROM submission_v2_projection')) return [{ submission_id: 51, status: 'queued', attempts: 0, dispatch_attempts: 0, dispatch_enabled: 1 }];
    if (sql.startsWith('UPDATE submission_v2_projection')) return { affectedRows: 1 };
    if (sql.startsWith('INSERT INTO submission_v2_attempt')) return { insertId: 31 };
    if (sql.startsWith('INSERT INTO api_v2_event')) throw new Error('event store unavailable');
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  await assert.rejects(() => domain.transitionProjection(manager, {
    submissionId: 51, status: 'judging', operation: 'runtime_status'
  }), /event store unavailable/);
});

test('projection rebuild replays the stream and repairs all mutable fields atomically', async () => {
  const order = [];
  const manager = scriptedManager(sql => {
    if (sql.startsWith('SELECT * FROM submission_v2_projection')) { order.push('projection-lock'); return [{ submission_id: 51, status: 'queued' }]; }
    if (sql.startsWith('SELECT id,stream,type')) {
      order.push('event-lock');
      return [created, event(2, 'submission.queued'), event(3, 'submission.status.changed', { status: 'accepted' })]
        .map(item => ({ ...item, payload_json: JSON.stringify(item.payload), payload: undefined }));
    }
    if (sql.startsWith('UPDATE submission_v2_projection')) { order.push('projection'); return { affectedRows: 1 }; }
    if (sql.startsWith('INSERT INTO submission_v2_attempt')) { order.push('attempt'); return { insertId: 32 }; }
    if (sql.startsWith('INSERT INTO api_v2_event')) { order.push('event'); return { insertId: 42 }; }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const result = await domain.rebuildProjection(manager, { submissionId: 51, actorId: 1, reason: 'repair', auditEventId: '91' });
  assert.deepEqual(order, ['projection-lock', 'event-lock', 'projection', 'attempt', 'event']);
  assert.equal(result.projection.status, 'accepted');
  assert.equal(result.replayedEventCount, 3);
  assert.equal(result.event.payload.audit_event_id, '91');
});

test('submission API creates and cancels legacy compatibility rows in the projection transaction', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_submission_domain.js'), 'utf8');
  assert.match(source, /submissionStorage\.insertSubmission\(manager/);
  assert.match(source, /submissionStorage\.cancelSubmission\(manager/);
  assert.match(source, /const created = await submissionTransaction\(async manager => \{[\s\S]*insertSubmission[\s\S]*createCodeVersion[\s\S]*createProjection/);
  assert.match(source, /const transition = await submissionTransaction\(async manager => \{[\s\S]*cancelSubmission[\s\S]*transitionProjection/);
});

test('submission API exposes every v2 workflow route and reads immutable code versions under policy', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_submission_domain.js'), 'utf8');
  for (const route of [
    "app.get('/api/v2/submissions'",
    "app.get('/api/v2/submissions/:id'",
    "app.get('/api/v2/submissions/:id/testpoints'",
    "app.get('/api/v2/submissions/:id/events'",
    "app.post('/api/v2/submissions/:id/cancel'",
    "app.post('/api/v2/submissions/:id/rejudge'"
  ]) assert.ok(source.includes(route), route);
  assert.match(source, /LEFT JOIN submission_v2_code_version code_version ON code_version\.id=projection\.code_version_id/);
  assert.match(source, /submissionDomain\.sourceVisibleTo/);
  assert.match(source, /code_version_id: created\.codeVersion\.id/);
  assert.doesNotMatch(source, /problem_title,judge[\s\S]{0,180}judge\.code\n/);
});

test('submission diagnostics are restricted consistently across detail, testpoints, and SSE', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_submission_domain.js'), 'utf8');
  assert.match(source, /async function canViewSubmissionDiagnostics\(judge, user\)/);
  assert.match(source, /testpoints: canReadDiagnostics \? judge\.result \|\| null : null/);
  assert.match(source, /const visibleEvent = submissionDomain\.serializeEventForViewer\(event, canReadDiagnostics\)/);
  assert.match(source, /return api\.sse\(req, res, stream, \{ serialize: event => \{/);
});

test('contest submissions bind to their locked contest problem snapshot instead of the mutable current problem snapshot', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_submission_domain.js'), 'utf8');
  const contestSource = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_contest_domain.js'), 'utf8');
  assert.match(source, /async function resolveSubmissionSnapshot\(problem, contest, actorId\)/);
  assert.match(source, /contestV2\.getProblemSnapshot\(contest\.id, problem\.id\)/);
  assert.match(source, /PROBLEM_SNAPSHOT_REQUIRED/);
  assert.match(source, /const snapshotId = await resolveSubmissionSnapshot\(problem, contest, user\.id\)/);
  assert.match(contestSource, /async function loadContestProblemSnapshot\(contestId, problemId\)/);
  assert.match(contestSource, /getProblemSnapshot: loadContestProblemSnapshot/);
});

test('judge dispatch materializes immutable execution settings from the persisted problem snapshot', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_submission_domain.js'), 'utf8');
  assert.match(source, /async function immutableExecutionProblem\(problem, snapshotId\)[\s\S]*SELECT problem_id,content_hash,content_json,provider_config,testdata_hash,testdata_path FROM problem_v2_snapshot WHERE id=\? LIMIT 1/);
  assert.match(source, /Object\.assign\(\{\}, problem, content, \{[\s\S]*judge_snapshot_id/);
  assert.match(source, /content\.vjudge_config == null && rows\[0\]\.provider_config != null/);
  assert.match(source, /ensureSnapshotTestdata\(problem, snapshotId\)/);
  assert.match(source, /judge_testdata_path/);
  assert.match(source, /judge_testdata_hash/);
  assert.match(source, /const executionProblem = await immutableExecutionProblem\(problem, snapshotId\);[\s\S]*Judger\.judge\(judge, executionProblem, contest \? 3 : 2, \{ snapshotId \}\)/);
  assert.match(source, /const executionProblem = await immutableExecutionProblem\(problem, rows\[0\]\.snapshot_id\);[\s\S]*Judger\.judge\(judge, executionProblem, contest \? 3 : 2, \{ snapshotId: rows\[0\]\.snapshot_id \}\)/);
});

test('submission list supports an explicit descending cursor for recent-workbench queries', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_submission_domain.js'), 'utf8');
  assert.match(source, /const descending = String\(req\.query\.order \|\| ''\)\.toLowerCase\(\) === 'desc'/);
  assert.match(source, /const cursorOperator = descending \? '<' : '>'/);
  assert.match(source, /ORDER BY projection\.submission_id \$\{orderDirection\} LIMIT \?/);
  assert.match(source, /problem\.title AS problem_title/);
});
