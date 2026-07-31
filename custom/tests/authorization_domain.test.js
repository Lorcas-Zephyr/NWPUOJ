'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const domain = require('../libs/authorization-domain');

function scriptedManager(handler) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      const compact = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: compact, params });
      return handler(compact, params, calls);
    }
  };
}

function recorder(manager, order, id = '701') {
  return async event => {
    order.push('audit');
    await manager.query('INSERT INTO auth_audit_event VALUES (?)', [event.action]);
    return id;
  };
}

test('organization creation persists creator membership, audit, and event on one manager', async () => {
  const order = [];
  const manager = scriptedManager(sql => {
    if (sql.startsWith('INSERT INTO auth_organization ')) { order.push('organization'); return { insertId: 31 }; }
    if (sql.startsWith('INSERT INTO auth_organization_member ')) { order.push('membership'); return { affectedRows: 1 }; }
    if (sql.startsWith('INSERT INTO auth_audit_event ')) return { insertId: 701 };
    if (sql.startsWith('INSERT INTO api_v2_event ')) { order.push('event'); return { insertId: 801 }; }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const result = await domain.createOrganization(manager, {
    slug: 'nwpu-icpc', name: 'NWPU ICPC', actorId: 1,
    recordAudit: recorder(manager, order)
  });
  assert.deepEqual(order, ['organization', 'membership', 'audit', 'event']);
  assert.deepEqual(result, { id: 31, slug: 'nwpu-icpc', name: 'NWPU ICPC', status: 'active', auditEventId: '701', eventId: '801' });
  assert.equal(manager.calls.every(call => typeof call.sql === 'string'), true);
});

test('team creation binds organization, contest scope, creator, audit, and event atomically', async () => {
  const order = [];
  const manager = scriptedManager(sql => {
    if (sql.startsWith('SELECT id,status FROM auth_organization')) return [{ id: 5, status: 'active' }];
    if (sql.startsWith('INSERT INTO auth_team ')) { order.push('team'); return { insertId: 41 }; }
    if (sql.startsWith('INSERT INTO auth_team_scope ')) { order.push('scope'); return { affectedRows: 1 }; }
    if (sql.startsWith('INSERT INTO auth_team_member ')) { order.push('membership'); return { affectedRows: 1 }; }
    if (sql.startsWith('INSERT INTO auth_audit_event ')) return { insertId: 702 };
    if (sql.startsWith('INSERT INTO api_v2_event ')) { order.push('event'); return { insertId: 802 }; }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const result = await domain.createTeam(manager, {
    organizationId: 5, slug: 'acm-team', name: 'ACM Team', scope: 'contest:9', actorId: 1,
    recordAudit: recorder(manager, order, '702')
  });
  assert.deepEqual(order, ['team', 'scope', 'membership', 'audit', 'event']);
  assert.deepEqual(result.scope, { type: 'contest', id: '9' });
  assert.deepEqual(manager.calls.find(call => call.sql.startsWith('INSERT INTO auth_team_scope ')).params, [41, 'contest', '9']);
});

test('membership replacement checks the locked current resource before writing', async () => {
  const stale = scriptedManager(sql => {
    if (sql.startsWith('SELECT id,status FROM auth_organization')) return [{ id: 5, status: 'active' }];
    if (sql.startsWith('SELECT id FROM user ')) return [{ id: 17 }];
    if (sql.startsWith('SELECT status FROM auth_organization_member ')) return [{ status: 'active' }];
    throw new Error(`Unexpected SQL after stale membership ETag: ${sql}`);
  });
  await assert.rejects(
    () => domain.setOrganizationMembership(stale, { organizationId: 5, userId: 17, active: false, actorId: 1, ifMatch: () => false, recordAudit: async () => '0' }),
    error => error.code === 'ETAG_MISMATCH' && error.statusCode === 412
  );
  assert.equal(stale.calls.length, 3);

  const order = [];
  const manager = scriptedManager(sql => {
    if (sql.startsWith('SELECT id,status FROM auth_team')) return [{ id: 9, status: 'active' }];
    if (sql.startsWith('SELECT id FROM user ')) return [{ id: 17 }];
    if (sql.startsWith('SELECT status FROM auth_team_member ')) return [{ status: 'inactive' }];
    if (sql.startsWith('INSERT INTO auth_team_member ')) { order.push('membership'); return { affectedRows: 1 }; }
    if (sql.startsWith('INSERT INTO auth_audit_event ')) return { insertId: 708 };
    if (sql.startsWith('INSERT INTO api_v2_event ')) { order.push('event'); return { insertId: 808 }; }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const result = await domain.setTeamMembership(manager, {
    teamId: 9, userId: 17, active: true, actorId: 1,
    ifMatch: current => assert.deepEqual(current, { team_id: 9, user_id: 17, active: false }) === undefined,
    recordAudit: recorder(manager, order, '708')
  });
  assert.deepEqual(order, ['membership', 'audit', 'event']);
  assert.equal(result.active, true);
});

test('role grant locks subject and role, rejects duplicates, and writes audit plus event', async () => {
  const order = [];
  const manager = scriptedManager(sql => {
    if (sql.startsWith('SELECT id FROM user ')) return [{ id: 17 }];
    if (sql.startsWith('SELECT id FROM auth_role ')) return [{ id: 9 }];
    if (sql.startsWith('SELECT id FROM auth_grant ')) return [];
    if (sql.startsWith('INSERT INTO auth_grant ')) { order.push('grant'); return { insertId: 51 }; }
    if (sql.startsWith('INSERT INTO auth_audit_event ')) return { insertId: 703 };
    if (sql.startsWith('INSERT INTO api_v2_event ')) { order.push('event'); return { insertId: 803 }; }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const result = await domain.grantRole(manager, {
    subjectType: 'user', subjectId: 17, roleName: 'problem_editor', scope: 'problem:3', actorId: 1,
    recordAudit: recorder(manager, order, '703')
  });
  assert.deepEqual(order, ['grant', 'audit', 'event']);
  assert.equal(result.id, 51);
  assert.deepEqual(result.scope, { type: 'problem', id: '3' });

  const duplicateManager = scriptedManager(sql => {
    if (sql.startsWith('SELECT id FROM user ')) return [{ id: 17 }];
    if (sql.startsWith('SELECT id FROM auth_role ')) return [{ id: 9 }];
    if (sql.startsWith('SELECT id FROM auth_grant ')) return [{ id: 51 }];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  await assert.rejects(
    () => domain.grantRole(duplicateManager, { subjectId: 17, roleName: 'problem_editor', scope: 'problem:3', actorId: 1, recordAudit: async () => '0' }),
    error => error.code === 'GRANT_ALREADY_EXISTS' && error.statusCode === 409
  );
});

test('grant revocation locks the grant and persists state, audit, and event in order', async () => {
  const order = [];
  const manager = scriptedManager(sql => {
    if (sql.startsWith('SELECT grant_row.*,role.name AS role_name')) return [{ id: 51, subject_type: 'user', subject_id: 17, scope_type: 'problem', scope_id: '3', role_name: 'problem_editor', revoked_at: null }];
    if (sql.startsWith('UPDATE auth_grant SET revoked_at=')) { order.push('revoke'); return { affectedRows: 1 }; }
    if (sql.startsWith('INSERT INTO auth_audit_event ')) return { insertId: 704 };
    if (sql.startsWith('INSERT INTO api_v2_event ')) { order.push('event'); return { insertId: 804 }; }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const result = await domain.revokeGrant(manager, { grantId: 51, actorId: 1, recordAudit: recorder(manager, order, '704') });
  assert.deepEqual(order, ['revoke', 'audit', 'event']);
  assert.equal(result.roleName, 'problem_editor');
  assert.equal(result.auditEventId, '704');
  assert.equal(result.eventId, '804');
});

test('event failure escapes the domain service so the surrounding transaction can roll back', async () => {
  const persisted = [];
  const manager = scriptedManager(sql => {
    if (sql.startsWith('SELECT id FROM user ')) return [{ id: 17 }];
    if (sql.startsWith('SELECT id FROM auth_role ')) return [{ id: 9 }];
    if (sql.startsWith('SELECT id FROM auth_grant ')) return [];
    if (sql.startsWith('INSERT INTO auth_grant ')) { persisted.push('grant'); return { insertId: 51 }; }
    if (sql.startsWith('INSERT INTO auth_audit_event ')) { persisted.push('audit'); return { insertId: 705 }; }
    if (sql.startsWith('INSERT INTO api_v2_event ')) throw new Error('event unavailable');
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const before = persisted.slice();
  await assert.rejects(async () => {
    try {
      await domain.grantRole(manager, {
        subjectId: 17, roleName: 'problem_editor', scope: 'problem:3', actorId: 1,
        recordAudit: recorder(manager, [], '705')
      });
    } catch (error) {
      persisted.splice(0, persisted.length, ...before);
      throw error;
    }
  }, /event unavailable/);
  assert.deepEqual(persisted, []);
});

test('policy creation validates conditions and persists audit plus event atomically', async () => {
  const order = [];
  const manager = scriptedManager(sql => {
    if (sql.startsWith('INSERT INTO auth_policy ')) { order.push('policy'); return { insertId: 61 }; }
    if (sql.startsWith('INSERT INTO auth_audit_event ')) return { insertId: 706 };
    if (sql.startsWith('INSERT INTO api_v2_event ')) { order.push('event'); return { insertId: 806 }; }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const result = await domain.createPolicy(manager, {
    name: 'Private problem review window', effect: 'deny', capability: 'problem:publish',
    scope: 'problem:9', conditions: { resource: { states: ['draft'] } }, enabled: true,
    actorId: 1, recordAudit: recorder(manager, order, '706')
  });
  assert.deepEqual(order, ['policy', 'audit', 'event']);
  assert.deepEqual(result.scope, { type: 'problem', id: '9' });
  assert.deepEqual(result.conditions, { resource: { states: ['draft'] } });
  await assert.rejects(
    () => domain.createPolicy(manager, { name: 'Bad', effect: 'allow', capability: 'problem:edit', conditions: { script: 'true' }, actorId: 1, recordAudit: async () => '0' }),
    error => error.code === 'VALIDATION_FAILED' && error.fields['conditions.script'] === 'invalid condition'
  );
});

test('policy update checks the locked ETag and writes state, audit, and event in order', async () => {
  const order = [];
  const current = {
    id: 61, name: 'Review window', effect: 'deny', capability: 'problem:publish',
    scope_type: 'problem', scope_id: '9', conditions_json: '{}', enabled: 1
  };
  const manager = scriptedManager(sql => {
    if (sql.startsWith('SELECT * FROM auth_policy ')) return [current];
    if (sql.startsWith('UPDATE auth_policy SET ')) { order.push('policy'); return { affectedRows: 1 }; }
    if (sql.startsWith('INSERT INTO auth_audit_event ')) return { insertId: 707 };
    if (sql.startsWith('INSERT INTO api_v2_event ')) { order.push('event'); return { insertId: 807 }; }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const result = await domain.updatePolicy(manager, {
    policyId: 61, patch: { enabled: false }, actorId: 1, ifMatch: locked => locked === current,
    recordAudit: recorder(manager, order, '707')
  });
  assert.deepEqual(order, ['policy', 'audit', 'event']);
  assert.equal(result.enabled, false);
  assert.deepEqual(result.changedFields, ['enabled']);

  const staleManager = scriptedManager(sql => {
    if (sql.startsWith('SELECT * FROM auth_policy ')) return [current];
    throw new Error(`Unexpected SQL after stale ETag: ${sql}`);
  });
  await assert.rejects(
    () => domain.updatePolicy(staleManager, { policyId: 61, patch: { enabled: false }, actorId: 1, ifMatch: () => false, recordAudit: async () => '0' }),
    error => error.code === 'ETAG_MISMATCH' && error.statusCode === 412
  );
});

test('authorization API routes wrap all authorization mutations in database transactions', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_authorization.js'), 'utf8');
  for (const operation of ['createOrganization', 'setOrganizationMembership', 'createTeam', 'setTeamMembership', 'grantRole', 'revokeGrant', 'createPolicy', 'updatePolicy']) {
    assert.match(source, new RegExp(`transaction\\(manager => authorizationDomain\\.${operation}\\(manager`));
  }
  assert.match(source, /CREATE TRIGGER auth_audit_event_immutable_update/);
  assert.match(source, /CREATE TRIGGER auth_audit_event_immutable_delete/);
  assert.match(source, /ALTER TABLE auth_policy ADD COLUMN scope_id/);
  assert.match(source, /idx_auth_policy_lookup/);
  assert.match(source, /capability === 'owner:transfer'\) return baseAllowed/);
  assert.match(source, /app\.post\('\/api\/v2\/admin\/policies', requireScopedCapability\('owner:transfer'/);
  assert.match(source, /PRECONDITION_REQUIRED[\s\S]*authorization policy/);
  assert.match(source, /app\.get\('\/api\/v2\/admin\/organizations\/:id\/members\/:userId'/);
  assert.match(source, /app\.get\('\/api\/v2\/admin\/teams\/:id\/members\/:userId'/);
  assert.match(source, /If-Match is required when replacing organization membership/);
  assert.match(source, /If-Match is required when replacing team membership/);
});
