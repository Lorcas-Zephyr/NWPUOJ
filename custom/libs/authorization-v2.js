'use strict';

const net = require('node:net');

const BUILT_IN_ROLES = Object.freeze({
  guest: Object.freeze(['problem:read', 'contest:read', 'ranking:read', 'discussion:read', 'announcement:read', 'banner:read']),
  member: Object.freeze(['submission:create', 'contest:register', 'contest:submit', 'solution:create', 'discussion:create', 'message:own', 'notification:read', 'clipboard:own', 'ticket:create', 'profile:edit']),
  participant: Object.freeze(['contest:read', 'contest:submit', 'submission:own.read', 'ranking:read']),
  problem_editor: Object.freeze(['problem:read', 'problem:create', 'problem:edit', 'problem:testdata.write', 'problem:tag.manage']),
  problem_reviewer: Object.freeze(['problem:read', 'problem:edit', 'problem:publish', 'problem:archive', 'problem:testdata.write', 'problem:tag.manage']),
  contest_manager: Object.freeze(['contest:read', 'contest:create', 'contest:edit', 'contest:publish', 'contest:registration.manage', 'contest:standings.rebuild']),
  judge_operator: Object.freeze(['judge:read', 'judge:worker.restart', 'submission:rejudge']),
  content_moderator: Object.freeze(['discussion:moderate', 'solution:moderate', 'announcement:manage', 'ticket:manage', 'ticket:create']),
  rating_manager: Object.freeze(['rating:read', 'rating:preview', 'rating:publish', 'rating:recalculate']),
  vjudge_manager: Object.freeze(['vjudge:source.manage', 'vjudge:import.create', 'vjudge:submission.create']),
  site_admin: Object.freeze([
    'admin:health.read', 'admin:audit.read', 'admin:user.manage', 'admin:permission.grant',
    'admin:config.read', 'admin:config.write', 'admin:job.manage', 'admin:content.manage',
    'problem:read', 'problem:create', 'problem:edit', 'problem:publish', 'problem:archive',
    'problem:testdata.write', 'problem:tag.manage', 'contest:read', 'contest:create',
    'contest:edit', 'contest:publish', 'contest:registration.manage', 'contest:standings.rebuild',
    'judge:read', 'judge:worker.restart', 'submission:rejudge',
    'vjudge:source.manage', 'vjudge:import.create', 'vjudge:submission.create',
    'discussion:moderate', 'solution:moderate', 'announcement:manage',
    'ticket:manage', 'rating:read'
  ]),
  owner: Object.freeze(['*'])
});

const LEGACY_ROLE_MAP = Object.freeze({
  manage_problem: 'problem_editor',
  manage_problem_tag: 'problem_editor',
  manage_contest: 'contest_manager',
  manage_solution: 'content_moderator',
  manage_ticket: 'content_moderator'
});

const LEGACY_CAPABILITY_MAP = Object.freeze({
  manage_user: Object.freeze(['admin:user.manage'])
});

const HIGH_RISK_CAPABILITIES = new Set([
  'problem:archive', 'rating:publish', 'rating:recalculate', 'judge:worker.restart',
  'submission:rejudge', 'vjudge:import.create', 'vjudge:source.manage', 'admin:permission.grant', 'admin:config.write',
  'admin:user.disable', 'admin:secret.read', 'owner:transfer'
]);
const RESOURCE_OWNER_CAPABILITIES = new Set([
  'problem:read', 'problem:edit',
  'contest:edit', 'contest:publish', 'contest:start', 'contest:freeze', 'contest:end'
]);

const AUTHENTICATION_WINDOW_MS = 15 * 60 * 1000;
const AUTHORIZATION_ERRORS = Object.freeze({
  AUTHENTICATION_REQUIRED: Object.freeze({
    status: 401,
    message: 'Authentication is required.',
    fields: Object.freeze({ action: 'login', login_url: '/login' })
  }),
  CAPABILITY_REQUIRED: Object.freeze({
    status: 403,
    message: 'You do not have permission to perform this action.',
    fields: Object.freeze({ action: 'request_access' })
  }),
  RECENT_LOGIN_REQUIRED: Object.freeze({
    status: 403,
    message: 'Sign in again or complete MFA before performing this high-risk action.',
    fields: Object.freeze({
      action: 'reauthenticate_or_verify_mfa',
      login_url: '/login',
      mfa_challenge_url: '/api/v2/auth/mfa/challenge'
    })
  }),
  OWNER_CAPABILITY_REQUIRED: Object.freeze({
    status: 403,
    message: 'Only the site owner can perform this action.',
    fields: Object.freeze({ action: 'contact_owner', required_capability: 'owner:transfer' })
  })
});

const ADMIN_WORKSPACES = Object.freeze([
  Object.freeze({ capability: 'admin:health.read', path: '/admin/info' }),
  Object.freeze({ capability: 'judge:read', path: '/admin/judge-workers' }),
  Object.freeze({ capability: 'vjudge:source.manage', path: '/admin/other' }),
  Object.freeze({ capability: 'rating:read', path: '/admin/rating' }),
  Object.freeze({ capability: 'admin:user.manage', path: '/admin/users' }),
  Object.freeze({ capability: 'announcement:manage', path: '/admin/announcements' }),
  Object.freeze({ capability: 'solution:moderate', path: '/admin/solutions' }),
  Object.freeze({ capability: 'submission:rejudge', path: '/admin/rejudge' }),
  Object.freeze({ capability: 'admin:config.read', path: '/admin/config' }),
  Object.freeze({ capability: 'admin:content.manage', path: '/admin/banners' }),
  Object.freeze({ capability: 'admin:permission.grant', path: '/admin/privilege' })
]);

function capabilityMatches(granted, requested) {
  return granted === '*' || granted === requested || (granted.endsWith(':*') && requested.startsWith(granted.slice(0, -1)));
}

function normalizeScope(scope) {
  if (!scope) return { type: 'global', id: null };
  if (typeof scope === 'string') {
    const separator = scope.indexOf(':');
    if (separator === -1) return { type: scope || 'global', id: null };
    return { type: scope.slice(0, separator) || 'global', id: scope.slice(separator + 1) || null };
  }
  return { type: String(scope.type || 'global'), id: scope.id == null ? null : String(scope.id) };
}

function scopeMatches(grantedType, grantedId, requestedScope) {
  const requested = normalizeScope(requestedScope);
  if (grantedType === 'global') return true;
  return grantedType === requested.type && String(grantedId || '') === String(requested.id || '');
}

function resourceOwnerAllows(subject, capability, resource) {
  return !!(
    subject && resource &&
    Number(resource.ownerId) === Number(subject.id) &&
    RESOURCE_OWNER_CAPABILITIES.has(capability)
  );
}

function roleAllows(role, capability) {
  return (BUILT_IN_ROLES[role] || []).some(granted => capabilityMatches(granted, capability));
}

function legacyPrivilegeCapabilities(privileges) {
  const capabilities = new Set();
  for (const privilege of Array.isArray(privileges) ? privileges : []) {
    const role = LEGACY_ROLE_MAP[privilege];
    (BUILT_IN_ROLES[role] || []).forEach(capability => capabilities.add(capability));
    (LEGACY_CAPABILITY_MAP[privilege] || []).forEach(capability => capabilities.add(capability));
  }
  return Array.from(capabilities).sort();
}

function conditionError(field, message) {
  const error = new TypeError(message);
  error.code = 'INVALID_POLICY_CONDITIONS';
  error.field = field;
  return error;
}

function rejectUnknownKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw conditionError(`${field}.${key}`, `Unsupported policy condition: ${field}.${key}.`);
  }
}

function conditionArray(value, field, normalize) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) {
    throw conditionError(field, `${field} must contain between 1 and 500 values.`);
  }
  const normalized = value.map((item, index) => normalize(item, `${field}.${index}`));
  return Array.from(new Set(normalized));
}

function conditionId(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw conditionError(field, `${field} must be a positive integer.`);
  return id;
}

function conditionToken(value, field) {
  const token = String(value == null ? '' : value).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(token)) throw conditionError(field, `${field} is invalid.`);
  return token;
}

function conditionTimestamp(value, field) {
  const timestamp = String(value == null ? '' : value).trim();
  if (!/(?:Z|[+-]\d\d:\d\d)$/i.test(timestamp)) throw conditionError(field, `${field} must include a timezone.`);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) throw conditionError(field, `${field} must be an ISO 8601 timestamp.`);
  return parsed.toISOString();
}

function normalizePolicyConditions(input) {
  let source = input;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch (error) {
      throw conditionError('conditions', 'conditions must be valid JSON.');
    }
  }
  if (source == null) source = {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw conditionError('conditions', 'conditions must be an object.');
  }
  rejectUnknownKeys(source, new Set(['subject', 'request', 'resource', 'time']), 'conditions');
  const normalized = {};

  if (source.subject != null) {
    if (!source.subject || typeof source.subject !== 'object' || Array.isArray(source.subject)) {
      throw conditionError('conditions.subject', 'conditions.subject must be an object.');
    }
    rejectUnknownKeys(source.subject, new Set(['user_ids', 'team_ids', 'organization_ids']), 'conditions.subject');
    const subject = {};
    if (source.subject.user_ids != null) subject.user_ids = conditionArray(source.subject.user_ids, 'conditions.subject.user_ids', conditionId);
    if (source.subject.team_ids != null) subject.team_ids = conditionArray(source.subject.team_ids, 'conditions.subject.team_ids', conditionId);
    if (source.subject.organization_ids != null) subject.organization_ids = conditionArray(source.subject.organization_ids, 'conditions.subject.organization_ids', conditionId);
    if (Object.keys(subject).length) normalized.subject = subject;
  }

  if (source.request != null) {
    if (!source.request || typeof source.request !== 'object' || Array.isArray(source.request)) {
      throw conditionError('conditions.request', 'conditions.request must be an object.');
    }
    rejectUnknownKeys(source.request, new Set(['ip_addresses', 'risk_levels']), 'conditions.request');
    const request = {};
    if (source.request.ip_addresses != null) {
      request.ip_addresses = conditionArray(source.request.ip_addresses, 'conditions.request.ip_addresses', (value, field) => {
        const address = String(value == null ? '' : value).trim().toLowerCase().replace(/^::ffff:/, '');
        if (!net.isIP(address)) throw conditionError(field, `${field} must be an IPv4 or IPv6 address.`);
        return address;
      });
    }
    if (source.request.risk_levels != null) request.risk_levels = conditionArray(source.request.risk_levels, 'conditions.request.risk_levels', conditionToken);
    if (Object.keys(request).length) normalized.request = request;
  }

  if (source.resource != null) {
    if (!source.resource || typeof source.resource !== 'object' || Array.isArray(source.resource)) {
      throw conditionError('conditions.resource', 'conditions.resource must be an object.');
    }
    rejectUnknownKeys(source.resource, new Set(['visibilities', 'states', 'owner_only']), 'conditions.resource');
    const resource = {};
    if (source.resource.visibilities != null) resource.visibilities = conditionArray(source.resource.visibilities, 'conditions.resource.visibilities', conditionToken);
    if (source.resource.states != null) resource.states = conditionArray(source.resource.states, 'conditions.resource.states', conditionToken);
    if (source.resource.owner_only != null) {
      if (typeof source.resource.owner_only !== 'boolean') throw conditionError('conditions.resource.owner_only', 'conditions.resource.owner_only must be boolean.');
      resource.owner_only = source.resource.owner_only;
    }
    if (Object.keys(resource).length) normalized.resource = resource;
  }

  if (source.time != null) {
    if (!source.time || typeof source.time !== 'object' || Array.isArray(source.time)) {
      throw conditionError('conditions.time', 'conditions.time must be an object.');
    }
    rejectUnknownKeys(source.time, new Set(['not_before', 'not_after']), 'conditions.time');
    const time = {};
    if (source.time.not_before != null) time.not_before = conditionTimestamp(source.time.not_before, 'conditions.time.not_before');
    if (source.time.not_after != null) time.not_after = conditionTimestamp(source.time.not_after, 'conditions.time.not_after');
    if (time.not_before && time.not_after && new Date(time.not_before).getTime() >= new Date(time.not_after).getTime()) {
      throw conditionError('conditions.time', 'conditions.time.not_after must be later than not_before.');
    }
    if (Object.keys(time).length) normalized.time = time;
  }
  return normalized;
}

function policyConditionsMatch(conditions, facts = {}, now = Date.now()) {
  const source = normalizePolicyConditions(conditions);
  const subject = source.subject || {};
  const request = source.request || {};
  const resource = source.resource || {};
  const time = source.time || {};
  const includesAny = (expected, actual) => !expected || expected.some(value => (actual || []).includes(value));
  if (subject.user_ids && !subject.user_ids.includes(Number(facts.userId))) return false;
  if (!includesAny(subject.team_ids, (facts.teamIds || []).map(Number))) return false;
  if (!includesAny(subject.organization_ids, (facts.organizationIds || []).map(Number))) return false;
  const ipAddress = String(facts.ipAddress || '').toLowerCase().replace(/^::ffff:/, '');
  if (request.ip_addresses && !request.ip_addresses.includes(ipAddress)) return false;
  if (request.risk_levels && !request.risk_levels.includes(String(facts.riskLevel || '').toLowerCase())) return false;
  if (resource.visibilities && !resource.visibilities.includes(String(facts.visibility || '').toLowerCase())) return false;
  if (resource.states && !resource.states.includes(String(facts.state || '').toLowerCase())) return false;
  if (resource.owner_only != null) {
    const isOwner = facts.ownerId != null && Number(facts.ownerId) === Number(facts.userId);
    if (resource.owner_only !== isOwner) return false;
  }
  if (time.not_before && now < new Date(time.not_before).getTime()) return false;
  if (time.not_after && now >= new Date(time.not_after).getTime()) return false;
  return true;
}

function evaluatePolicies(policies, capability, scope, facts = {}, now = Date.now()) {
  const matched = [];
  const invalidPolicyIds = [];
  for (const policy of Array.isArray(policies) ? policies : []) {
    if (policy.enabled === false || Number(policy.enabled) === 0) continue;
    if (!capabilityMatches(String(policy.capability || ''), capability)) continue;
    if (!scopeMatches(String(policy.scope_type || policy.scopeType || 'global'), policy.scope_id == null ? policy.scopeId : policy.scope_id, scope)) continue;
    try {
      const conditions = policy.conditions_json == null ? policy.conditions : policy.conditions_json;
      if (!policyConditionsMatch(conditions, facts, now)) continue;
      matched.push(policy);
    } catch (error) {
      invalidPolicyIds.push(String(policy.id));
    }
  }
  const denied = matched.filter(policy => policy.effect === 'deny');
  const allowed = matched.filter(policy => policy.effect === 'allow');
  const selected = denied.length ? denied : allowed;
  return {
    effect: denied.length ? 'deny' : allowed.length ? 'allow' : null,
    matchedPolicyIds: selected.map(policy => String(policy.id)),
    invalidPolicyIds
  };
}

function recentAuthentication(session, now = Date.now(), windowMs = AUTHENTICATION_WINDOW_MS) {
  const source = session || {};
  const authenticatedAt = Number(source.apiV2AuthenticatedAt || source.authenticatedAt || 0);
  const mfaVerifiedAt = Number(source.apiV2MfaVerifiedAt || 0);
  const isFresh = value => Number.isFinite(value) && value > 0 && value <= now && now - value <= windowMs;
  const recentLogin = isFresh(authenticatedAt);
  const recentMfa = isFresh(mfaVerifiedAt);
  return { recentLogin, recentMfa, satisfied: recentLogin || recentMfa };
}

function authorizationError(code, capability) {
  const definition = AUTHORIZATION_ERRORS[code] || AUTHORIZATION_ERRORS.CAPABILITY_REQUIRED;
  const fields = Object.assign({}, definition.fields);
  if (capability) fields.required_capability = capability;
  return { status: definition.status, code, message: definition.message, fields };
}

function firstAdminWorkspace(capabilities) {
  const granted = Array.isArray(capabilities) ? capabilities : [];
  const workspace = ADMIN_WORKSPACES.find(item => granted.some(value => capabilityMatches(value, item.capability)));
  return workspace ? workspace.path : null;
}

module.exports = {
  ADMIN_WORKSPACES,
  AUTHENTICATION_WINDOW_MS,
  AUTHORIZATION_ERRORS,
  BUILT_IN_ROLES,
  HIGH_RISK_CAPABILITIES,
  LEGACY_CAPABILITY_MAP,
  LEGACY_ROLE_MAP,
  RESOURCE_OWNER_CAPABILITIES,
  capabilityMatches,
  authorizationError,
  firstAdminWorkspace,
  legacyPrivilegeCapabilities,
  normalizeScope,
  normalizePolicyConditions,
  evaluatePolicies,
  policyConditionsMatch,
  recentAuthentication,
  resourceOwnerAllows,
  roleAllows,
  scopeMatches
};
