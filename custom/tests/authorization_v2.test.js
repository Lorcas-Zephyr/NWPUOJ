'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  AUTHENTICATION_WINDOW_MS,
  BUILT_IN_ROLES,
  HIGH_RISK_CAPABILITIES,
  authorizationError,
  evaluatePolicies,
  firstAdminWorkspace,
  legacyPrivilegeCapabilities,
  normalizePolicyConditions,
  policyConditionsMatch,
  recentAuthentication,
  resourceOwnerAllows,
  roleAllows,
  scopeMatches
} = require('../libs/authorization-v2');

test('all documented built-in roles exist', () => {
  assert.deepEqual(Object.keys(BUILT_IN_ROLES), [
    'guest', 'member', 'participant', 'problem_editor', 'problem_reviewer',
    'contest_manager', 'judge_operator', 'content_moderator', 'rating_manager',
    'vjudge_manager', 'site_admin', 'owner'
  ]);
});

test('dedicated high-risk roles own their capabilities', () => {
  assert.equal(roleAllows('rating_manager', 'rating:publish'), true);
  assert.equal(roleAllows('judge_operator', 'judge:worker.restart'), true);
  assert.equal(roleAllows('vjudge_manager', 'vjudge:source.manage'), true);
});

test('site admin follows the documented operations matrix', () => {
  assert.equal(roleAllows('site_admin', 'rating:publish'), false);
  assert.equal(roleAllows('site_admin', 'rating:recalculate'), false);
  assert.equal(roleAllows('site_admin', 'judge:worker.restart'), true);
  assert.equal(roleAllows('site_admin', 'vjudge:source.manage'), true);
  assert.equal(roleAllows('site_admin', 'admin:config.write'), true);
});

test('owner wildcard and high-risk catalog behave consistently', () => {
  assert.equal(roleAllows('owner', 'owner:transfer'), true);
  assert.equal(HIGH_RISK_CAPABILITIES.has('owner:transfer'), true);
  assert.equal(HIGH_RISK_CAPABILITIES.has('rating:publish'), true);
  assert.equal(HIGH_RISK_CAPABILITIES.has('submission:rejudge'), true);
});

test('guest and session-safe public capabilities include rankings', () => {
  assert.equal(roleAllows('guest', 'ranking:read'), true);
});

test('built-in roles follow the documented domain permission matrix', () => {
  const expected = {
    member: ['submission:create', 'contest:register', 'solution:create', 'message:own', 'notification:read', 'ticket:create'],
    problem_editor: ['problem:edit', 'problem:testdata.write'],
    contest_manager: ['contest:edit', 'contest:registration.manage'],
    judge_operator: ['judge:read', 'submission:rejudge'],
    rating_manager: ['rating:preview', 'rating:publish', 'rating:recalculate'],
    content_moderator: ['solution:moderate', 'discussion:moderate', 'announcement:manage', 'ticket:manage'],
    vjudge_manager: ['vjudge:source.manage', 'vjudge:import.create', 'vjudge:submission.create'],
    site_admin: ['admin:user.manage', 'admin:permission.grant', 'admin:config.write']
  };
  for (const [role, capabilities] of Object.entries(expected)) {
    for (const capability of capabilities) assert.equal(roleAllows(role, capability), true, `${role} must allow ${capability}`);
  }
  assert.equal(roleAllows('member', 'solution:moderate'), false);
  assert.equal(roleAllows('member', 'ticket:manage'), false);
  assert.equal(roleAllows('problem_editor', 'solution:moderate'), false);
  assert.equal(roleAllows('content_moderator', 'problem:edit'), false);
});

test('specialist roles land in the first workspace they can actually use', () => {
  assert.equal(firstAdminWorkspace(BUILT_IN_ROLES.judge_operator), '/admin/judge-workers');
  assert.equal(firstAdminWorkspace(BUILT_IN_ROLES.vjudge_manager), '/admin/other');
  assert.equal(firstAdminWorkspace(BUILT_IN_ROLES.rating_manager), '/admin/rating');
  assert.equal(firstAdminWorkspace(BUILT_IN_ROLES.content_moderator), '/admin/announcements');
  assert.equal(firstAdminWorkspace(BUILT_IN_ROLES.member), null);
  assert.equal(firstAdminWorkspace(['*']), '/admin/info');
});

test('legacy user management remains a specialist workspace without site-admin elevation', () => {
  const capabilities = legacyPrivilegeCapabilities(['manage_user']);
  assert.deepEqual(capabilities, ['admin:user.manage']);
  assert.equal(firstAdminWorkspace(capabilities), '/admin/users');
  assert.equal(capabilities.includes('admin:health.read'), false);
  assert.equal(capabilities.includes('admin:permission.grant'), false);
  assert.equal(capabilities.includes('admin:config.write'), false);
});

test('every built-in role has an explicit allowed and denied matrix branch', () => {
  const matrix = {
    guest: { allow: 'problem:read', deny: 'submission:create' },
    member: { allow: 'submission:create', deny: 'problem:edit' },
    participant: { allow: 'contest:submit', deny: 'contest:edit' },
    problem_editor: { allow: 'problem:edit', deny: 'problem:publish' },
    problem_reviewer: { allow: 'problem:publish', deny: 'contest:edit' },
    contest_manager: { allow: 'contest:edit', deny: 'rating:publish' },
    judge_operator: { allow: 'judge:worker.restart', deny: 'admin:user.manage' },
    content_moderator: { allow: 'discussion:moderate', deny: 'problem:testdata.write' },
    rating_manager: { allow: 'rating:publish', deny: 'admin:config.write' },
    vjudge_manager: { allow: 'vjudge:source.manage', deny: 'rating:publish' },
    site_admin: { allow: 'admin:permission.grant', deny: 'rating:publish' },
    owner: { allow: 'owner:transfer', deny: null }
  };
  assert.deepEqual(Object.keys(matrix), Object.keys(BUILT_IN_ROLES));
  for (const [role, branch] of Object.entries(matrix)) {
    assert.equal(roleAllows(role, branch.allow), true, `${role} must allow ${branch.allow}`);
    if (branch.deny) assert.equal(roleAllows(role, branch.deny), false, `${role} must deny ${branch.deny}`);
  }
});

test('resource ownership and scoped grants do not cross resource boundaries', () => {
  const subject = { id: 17 };
  assert.equal(resourceOwnerAllows(subject, 'problem:edit', { ownerId: 17 }), true);
  assert.equal(resourceOwnerAllows(subject, 'problem:publish', { ownerId: 17 }), false);
  assert.equal(resourceOwnerAllows(subject, 'problem:edit', { ownerId: 18 }), false);
  assert.equal(scopeMatches('global', null, 'contest:9'), true);
  assert.equal(scopeMatches('contest', '9', 'contest:9'), true);
  assert.equal(scopeMatches('contest', '9', 'contest:10'), false);
  assert.equal(scopeMatches('problem', '9', 'contest:9'), false);
});

test('recent login or MFA satisfies the high-risk window without accepting future timestamps', () => {
  const now = 2_000_000;
  assert.deepEqual(recentAuthentication({ apiV2AuthenticatedAt: now - 1000 }, now), { recentLogin: true, recentMfa: false, satisfied: true });
  assert.deepEqual(recentAuthentication({ apiV2MfaVerifiedAt: now - 1000 }, now), { recentLogin: false, recentMfa: true, satisfied: true });
  assert.equal(recentAuthentication({ apiV2AuthenticatedAt: now - AUTHENTICATION_WINDOW_MS - 1 }, now).satisfied, false);
  assert.equal(recentAuthentication({ apiV2MfaVerifiedAt: now + 1 }, now).satisfied, false);
  assert.equal(recentAuthentication({}, now).satisfied, false);
});

test('authorization failures expose stable codes and actionable next steps', () => {
  assert.deepEqual(authorizationError('AUTHENTICATION_REQUIRED', 'profile:edit'), {
    status: 401,
    code: 'AUTHENTICATION_REQUIRED',
    message: 'Authentication is required.',
    fields: { action: 'login', login_url: '/login', required_capability: 'profile:edit' }
  });
  const denied = authorizationError('CAPABILITY_REQUIRED', 'rating:publish');
  assert.equal(denied.status, 403);
  assert.equal(denied.fields.action, 'request_access');
  assert.equal(denied.fields.required_capability, 'rating:publish');
  const recent = authorizationError('RECENT_LOGIN_REQUIRED', 'submission:rejudge');
  assert.equal(recent.fields.action, 'reauthenticate_or_verify_mfa');
  assert.equal(recent.fields.mfa_challenge_url, '/api/v2/auth/mfa/challenge');
});

test('policy conditions normalize constrained subject, request, resource, and time facts', () => {
  const normalized = normalizePolicyConditions({
    subject: { user_ids: ['17', 17], team_ids: [3], organization_ids: [5] },
    request: { ip_addresses: ['::ffff:127.0.0.1'], risk_levels: ['HIGH'] },
    resource: { visibilities: ['PRIVATE'], states: ['REVIEW'], owner_only: true },
    time: { not_before: '2026-07-30T03:00:00Z', not_after: '2026-07-30T04:00:00+00:00' }
  });
  assert.deepEqual(normalized, {
    subject: { user_ids: [17], team_ids: [3], organization_ids: [5] },
    request: { ip_addresses: ['127.0.0.1'], risk_levels: ['high'] },
    resource: { visibilities: ['private'], states: ['review'], owner_only: true },
    time: { not_before: '2026-07-30T03:00:00.000Z', not_after: '2026-07-30T04:00:00.000Z' }
  });
  const facts = { userId: 17, teamIds: [3], organizationIds: [5], ipAddress: '::ffff:127.0.0.1', riskLevel: 'high', visibility: 'private', state: 'review', ownerId: 17 };
  assert.equal(policyConditionsMatch(normalized, facts, Date.parse('2026-07-30T03:30:00Z')), true);
  assert.equal(policyConditionsMatch(normalized, Object.assign({}, facts, { state: 'published' }), Date.parse('2026-07-30T03:30:00Z')), false);
  assert.equal(policyConditionsMatch(normalized, facts, Date.parse('2026-07-30T04:00:00Z')), false);
  assert.throws(() => normalizePolicyConditions({ request: { ip_addresses: ['campus'] } }), error => error.code === 'INVALID_POLICY_CONDITIONS');
  assert.throws(() => normalizePolicyConditions({ script: 'return true' }), error => error.field === 'conditions.script');
});

test('matching deny policies take priority while invalid or cross-scope policies cannot allow', () => {
  const policies = [
    { id: 1, effect: 'allow', capability: 'problem:*', scope_type: 'problem', scope_id: '9', conditions_json: '{"subject":{"team_ids":[3]}}', enabled: 1 },
    { id: 2, effect: 'deny', capability: 'problem:edit', scope_type: 'problem', scope_id: '9', conditions_json: '{"request":{"risk_levels":["high"]}}', enabled: 1 },
    { id: 3, effect: 'allow', capability: 'problem:edit', scope_type: 'problem', scope_id: '10', conditions_json: '{}', enabled: 1 },
    { id: 4, effect: 'allow', capability: 'problem:edit', scope_type: 'problem', scope_id: '9', conditions_json: '{broken', enabled: 1 },
    { id: 5, effect: 'deny', capability: 'problem:edit', scope_type: 'problem', scope_id: '9', conditions_json: '{}', enabled: 0 }
  ];
  assert.deepEqual(evaluatePolicies(policies, 'problem:edit', 'problem:9', { teamIds: [3], riskLevel: 'high' }), {
    effect: 'deny', matchedPolicyIds: ['2'], invalidPolicyIds: ['4']
  });
  assert.deepEqual(evaluatePolicies(policies, 'problem:edit', 'problem:9', { teamIds: [3], riskLevel: 'low' }), {
    effect: 'allow', matchedPolicyIds: ['1'], invalidPolicyIds: ['4']
  });
  assert.deepEqual(evaluatePolicies(policies, 'problem:edit', 'problem:11', { teamIds: [3], riskLevel: 'low' }), {
    effect: null, matchedPolicyIds: [], invalidPolicyIds: []
  });
});
