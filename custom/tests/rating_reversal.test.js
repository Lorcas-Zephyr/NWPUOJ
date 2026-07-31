'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const reversal = require('../libs/rating-reversal');

function managerFor(options = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const compact = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: compact, params });
      if (compact.startsWith('SELECT * FROM rating_v2_event WHERE id=')) return [options.original || { id: 41, profile_id: 'icpc', user_id: 7, contest_id: 10, delta: 100 }];
      if (compact.startsWith('SELECT id FROM rating_v2_event WHERE supersedes_event_id=')) return options.duplicate ? [{ id: 43 }] : [];
      if (compact.startsWith('SELECT * FROM rating_v2_profile')) return [{ id: 'icpc', enabled: 1 }];
      if (compact.startsWith('INSERT INTO rating_v2_event')) return { insertId: 42 };
      if (compact.startsWith('INSERT INTO rating_v2_current')) return { affectedRows: 1 };
      if (compact.startsWith('UPDATE user SET rating=')) return { affectedRows: 1 };
      if (compact.startsWith('INSERT INTO rating_v2_contest_override')) return { affectedRows: 1 };
      if (compact.startsWith('INSERT INTO rating_v2_job')) return { affectedRows: 1 };
      if (compact.startsWith('UPDATE rating_v2_job SET audit_event_id=')) return { affectedRows: 1 };
      if (compact.startsWith('INSERT INTO api_v2_event')) return { insertId: 88 };
      throw new Error(`Unexpected SQL: ${compact}`);
    }
  };
}

function input(reversalType, eligibility = null) {
  return {
    originalId: 41,
    reversalType,
    eligibility,
    requestedUserId: 7,
    requestedProfileId: 'icpc',
    actorId: 1,
    reason: 'operator correction',
    jobId: 'job-10',
    sourceId: `source-${reversalType}`,
    currentProjection: async () => ({ rating: 1600, deviation: 120, volatility: 0.05 }),
    recordAudit: async () => 77
  };
}

test('all Rating reversal types atomically write projection, eligibility, job, audit link, and domain event', async () => {
  const cases = [
    ['cancellation', null, 'contest_cancelled', 'cancelled'],
    ['disqualification', null, 'contest_disqualified', 'disqualified'],
    ['cheating', null, 'contest_cheating', 'cheating'],
    ['correction', 'excluded', 'rating_corrected', 'disqualified'],
    ['correction', 'eligible', 'rating_corrected', 'eligible']
  ];
  for (const [type, eligibility, kind, status] of cases) {
    const manager = managerFor();
    const result = await reversal.reverseInTransaction(manager, input(type, eligibility));
    assert.equal(result.kind, kind);
    assert.equal(result.rating_before, 1600);
    assert.equal(result.rating_after, 1500);
    assert.equal(result.audit_event_id, '77');
    assert.equal(result.domain_event.type, `rating.${type}`);
    const override = manager.calls.find(call => call.sql.startsWith('INSERT INTO rating_v2_contest_override'));
    assert.equal(override.params[3], status);
    assert.ok(manager.calls.some(call => call.sql.startsWith('UPDATE rating_v2_job SET audit_event_id=')));
    assert.ok(manager.calls.some(call => call.sql.startsWith('INSERT INTO api_v2_event')));
  }
});

test('duplicate reversal and audit persistence failure escape without a success result', async () => {
  await assert.rejects(
    reversal.reverseInTransaction(managerFor({ duplicate: true }), input('cheating')),
    error => error.code === 'RATING_EVENT_ALREADY_REVERSED' && error.statusCode === 409
  );
  const manager = managerFor();
  const value = input('correction', 'eligible');
  value.recordAudit = async () => { throw new Error('audit unavailable'); };
  await assert.rejects(reversal.reverseInTransaction(manager, value), /audit unavailable/);
  assert.equal(manager.calls.some(call => call.sql.startsWith('INSERT INTO api_v2_event')), false);
});

test('Rating reversal route commits the domain transaction before publishing its persisted event', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_rating_domain.js'), 'utf8');
  assert.match(source, /transaction\(manager => ratingReversal\.reverseInTransaction\(manager/);
  assert.match(source, /recordAudit:[\s\S]*\}, manager\)/);
  assert.match(source, /const \{ domain_event: domainEvent, \.\.\.result \} = transactionResult;[\s\S]*api\(\)\.publishEvent\(domainEvent\)/);
  assert.doesNotMatch(source, /deleteFromCache\(result\.user_id\); const auditEventId/);
});
