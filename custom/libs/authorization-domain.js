'use strict';

const { normalizePolicyConditions } = require('./authorization-v2');

function domainError(code, message, statusCode, fields) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.fields = fields || {};
  return error;
}

function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw domainError('VALIDATION_FAILED', `${field} must be a positive integer.`, 422, { [field]: 'positive integer required' });
  }
  return id;
}

function requiredText(value, field, maximum) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > maximum) {
    throw domainError('VALIDATION_FAILED', `${field} is required and must not exceed ${maximum} characters.`, 422, { [field]: `required, maximum ${maximum} characters` });
  }
  return text;
}

function slug(value) {
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/.test(normalized)) {
    throw domainError('VALIDATION_FAILED', 'slug must contain lowercase letters, numbers, or internal hyphens.', 422, { slug: 'invalid slug' });
  }
  return normalized;
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

function policyCapability(value) {
  const capability = requiredText(value, 'capability', 160).toLowerCase();
  if (capability !== '*' && !/^[a-z][a-z0-9._-]{0,79}:(?:[a-z][a-z0-9._-]{0,79}|\*)$/.test(capability)) {
    throw domainError('VALIDATION_FAILED', 'capability must use the resource:action format.', 422, { capability: 'invalid capability' });
  }
  return capability;
}

function policyEffect(value) {
  const effect = String(value == null ? '' : value).trim().toLowerCase();
  if (!['allow', 'deny'].includes(effect)) {
    throw domainError('VALIDATION_FAILED', 'effect must be allow or deny.', 422, { effect: 'allow or deny required' });
  }
  return effect;
}

function policyScope(value) {
  const scope = normalizeScope(value);
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(scope.type)) {
    throw domainError('VALIDATION_FAILED', 'scope type is invalid.', 422, { scope: 'invalid scope type' });
  }
  if (scope.type === 'global') return { type: 'global', id: null };
  if (!scope.id || scope.id.length > 120) {
    throw domainError('VALIDATION_FAILED', 'A scoped policy requires a scope ID.', 422, { scope: 'scope ID required' });
  }
  return scope;
}

function policyConditions(value) {
  try {
    return normalizePolicyConditions(value);
  } catch (error) {
    throw domainError('VALIDATION_FAILED', error.message, 422, { [error.field || 'conditions']: 'invalid condition' });
  }
}

async function appendEvent(manager, event) {
  const result = await manager.query(
    `INSERT INTO api_v2_event (stream,type,aggregate_id,actor_id,payload_json,created_at)
     VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))`,
    [event.stream, event.type, event.aggregateId == null ? null : String(event.aggregateId), event.actorId || null, JSON.stringify(event.payload || {})]
  );
  return String(result.insertId);
}

async function requireUser(manager, userId) {
  const id = positiveId(userId, 'user_id');
  const rows = await manager.query('SELECT id FROM user WHERE id=? LIMIT 1 FOR UPDATE', [id]);
  if (!rows.length) throw domainError('USER_NOT_FOUND', 'User was not found.', 404);
  return id;
}

async function requireOrganization(manager, organizationId) {
  const id = positiveId(organizationId, 'organization_id');
  const rows = await manager.query('SELECT id,status FROM auth_organization WHERE id=? LIMIT 1 FOR UPDATE', [id]);
  if (!rows.length) throw domainError('ORGANIZATION_NOT_FOUND', 'Organization was not found.', 404);
  if (rows[0].status !== 'active') throw domainError('ORGANIZATION_INACTIVE', 'Organization is not active.', 409);
  return id;
}

async function requireTeam(manager, teamId) {
  const id = positiveId(teamId, 'team_id');
  const rows = await manager.query('SELECT id,status FROM auth_team WHERE id=? LIMIT 1 FOR UPDATE', [id]);
  if (!rows.length) throw domainError('TEAM_NOT_FOUND', 'Team was not found.', 404);
  if (rows[0].status !== 'active') throw domainError('TEAM_INACTIVE', 'Team is not active.', 409);
  return id;
}

async function createOrganization(manager, input) {
  const organizationSlug = slug(input.slug);
  const name = requiredText(input.name, 'name', 255);
  const actorId = positiveId(input.actorId, 'actor_id');
  try {
    const result = await manager.query(
      `INSERT INTO auth_organization (slug,name,status,created_by,created_at,updated_at)
       VALUES (?,?,'active',?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
      [organizationSlug, name, actorId]
    );
    const id = Number(result.insertId);
    await manager.query(
      `INSERT INTO auth_organization_member (organization_id,user_id,status,created_at)
       VALUES (?,?,'active',UTC_TIMESTAMP(3))`,
      [id, actorId]
    );
    const auditEventId = await input.recordAudit({
      action: 'admin:organization.create', resourceType: 'organization', resourceId: id,
      scope: { type: 'organization', id }, details: { slug: organizationSlug, name }
    });
    const eventId = await appendEvent(manager, {
      stream: `authorization:organization:${id}`, type: 'organization.created', aggregateId: id, actorId,
      payload: { slug: organizationSlug, name, audit_event_id: auditEventId }
    });
    return { id, slug: organizationSlug, name, status: 'active', auditEventId, eventId };
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
      throw domainError('ORGANIZATION_SLUG_CONFLICT', 'An organization with this slug already exists.', 409, { slug: 'already exists' });
    }
    throw error;
  }
}

async function setOrganizationMembership(manager, input) {
  const organizationId = await requireOrganization(manager, input.organizationId);
  const userId = await requireUser(manager, input.userId);
  const active = input.active !== false;
  const currentRows = await manager.query(
    'SELECT status FROM auth_organization_member WHERE organization_id=? AND user_id=? LIMIT 1 FOR UPDATE',
    [organizationId, userId]
  );
  const current = { organization_id: organizationId, user_id: userId, active: !!(currentRows[0] && currentRows[0].status === 'active') };
  if (input.ifMatch && !input.ifMatch(current)) throw domainError('ETAG_MISMATCH', 'Organization membership changed. Refresh it and try again.', 412);
  await manager.query(
    `INSERT INTO auth_organization_member (organization_id,user_id,status,created_at)
     VALUES (?,?,?,UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE status=VALUES(status)`,
    [organizationId, userId, active ? 'active' : 'inactive']
  );
  const auditEventId = await input.recordAudit({
    action: active ? 'admin:organization.member.add' : 'admin:organization.member.remove',
    resourceType: 'organization', resourceId: organizationId,
    scope: { type: 'organization', id: organizationId }, details: { user_id: userId }
  });
  const eventId = await appendEvent(manager, {
    stream: `authorization:organization:${organizationId}`,
    type: active ? 'organization.member_added' : 'organization.member_removed',
    aggregateId: organizationId, actorId: input.actorId,
    payload: { user_id: userId, audit_event_id: auditEventId }
  });
  return { organizationId, userId, active, auditEventId, eventId };
}

async function createTeam(manager, input) {
  const teamSlug = slug(input.slug);
  const name = requiredText(input.name, 'name', 255);
  const actorId = positiveId(input.actorId, 'actor_id');
  const organizationId = input.organizationId == null ? null : await requireOrganization(manager, input.organizationId);
  const scope = normalizeScope(input.scope);
  try {
    const result = await manager.query(
      `INSERT INTO auth_team (organization_id,slug,name,status,created_by,created_at,updated_at)
       VALUES (?,?,?,'active',?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
      [organizationId || 0, teamSlug, name, actorId]
    );
    const id = Number(result.insertId);
    await manager.query(
      `INSERT INTO auth_team_scope (team_id,scope_type,scope_id,created_at)
       VALUES (?,?,?,UTC_TIMESTAMP(3))`,
      [id, scope.type, scope.id || '']
    );
    await manager.query(
      `INSERT INTO auth_team_member (team_id,user_id,status,created_at)
       VALUES (?,?,'active',UTC_TIMESTAMP(3))`,
      [id, actorId]
    );
    const auditEventId = await input.recordAudit({
      action: 'admin:team.create', resourceType: 'team', resourceId: id, scope,
      details: { slug: teamSlug, name, organization_id: organizationId }
    });
    const eventId = await appendEvent(manager, {
      stream: `authorization:team:${id}`, type: 'team.created', aggregateId: id, actorId,
      payload: { slug: teamSlug, name, organization_id: organizationId, scope, audit_event_id: auditEventId }
    });
    return { id, slug: teamSlug, name, organizationId, scope, status: 'active', auditEventId, eventId };
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
      throw domainError('TEAM_SLUG_CONFLICT', 'A team with this slug already exists in the organization.', 409, { slug: 'already exists' });
    }
    throw error;
  }
}

async function setTeamMembership(manager, input) {
  const teamId = await requireTeam(manager, input.teamId);
  const userId = await requireUser(manager, input.userId);
  const active = input.active !== false;
  const currentRows = await manager.query(
    'SELECT status FROM auth_team_member WHERE team_id=? AND user_id=? LIMIT 1 FOR UPDATE',
    [teamId, userId]
  );
  const current = { team_id: teamId, user_id: userId, active: !!(currentRows[0] && currentRows[0].status === 'active') };
  if (input.ifMatch && !input.ifMatch(current)) throw domainError('ETAG_MISMATCH', 'Team membership changed. Refresh it and try again.', 412);
  await manager.query(
    `INSERT INTO auth_team_member (team_id,user_id,status,created_at)
     VALUES (?,?,?,UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE status=VALUES(status)`,
    [teamId, userId, active ? 'active' : 'inactive']
  );
  const auditEventId = await input.recordAudit({
    action: active ? 'admin:team.member.add' : 'admin:team.member.remove',
    resourceType: 'team', resourceId: teamId,
    scope: { type: 'team', id: teamId }, details: { user_id: userId }
  });
  const eventId = await appendEvent(manager, {
    stream: `authorization:team:${teamId}`,
    type: active ? 'team.member_added' : 'team.member_removed',
    aggregateId: teamId, actorId: input.actorId,
    payload: { user_id: userId, audit_event_id: auditEventId }
  });
  return { teamId, userId, active, auditEventId, eventId };
}

async function grantRole(manager, input) {
  const subjectType = input.subjectType === 'team' ? 'team' : 'user';
  const subjectId = subjectType === 'team'
    ? await requireTeam(manager, input.subjectId)
    : await requireUser(manager, input.subjectId);
  const roleName = requiredText(input.roleName, 'role', 120);
  const roleRows = await manager.query('SELECT id FROM auth_role WHERE name=? LIMIT 1 FOR UPDATE', [roleName]);
  if (!roleRows.length) throw domainError('ROLE_NOT_FOUND', 'Role was not found.', 404, { role: 'unknown role' });
  const scope = normalizeScope(input.scope);
  const expiresAt = input.expiresAt == null ? null : new Date(input.expiresAt);
  if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
    throw domainError('VALIDATION_FAILED', 'Expiry must be a future ISO 8601 timestamp.', 422, { expires_at: 'future timestamp required' });
  }
  const existing = await manager.query(
    `SELECT id FROM auth_grant
      WHERE subject_type=? AND subject_id=? AND role_id=? AND scope_type=? AND scope_id <=> ?
        AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>UTC_TIMESTAMP(3))
      LIMIT 1 FOR UPDATE`,
    [subjectType, subjectId, roleRows[0].id, scope.type, scope.id]
  );
  if (existing.length) throw domainError('GRANT_ALREADY_EXISTS', 'This role is already active in the requested scope.', 409, { grant_id: String(existing[0].id) });
  const result = await manager.query(
    `INSERT INTO auth_grant (subject_type,subject_id,role_id,scope_type,scope_id,granted_by,created_at,expires_at,revoked_at)
     VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3),?,NULL)`,
    [subjectType, subjectId, roleRows[0].id, scope.type, scope.id, input.actorId, expiresAt]
  );
  const id = Number(result.insertId);
  const auditEventId = await input.recordAudit({
    action: 'admin:permission.grant', resourceType: subjectType, resourceId: subjectId, scope,
    details: { grant_id: String(id), role: roleName, expires_at: expiresAt ? expiresAt.toISOString() : null }
  });
  const eventId = await appendEvent(manager, {
    stream: `authorization:${subjectType}:${subjectId}`, type: 'role.granted', aggregateId: subjectId, actorId: input.actorId,
    payload: { grant_id: String(id), role: roleName, scope, expires_at: expiresAt ? expiresAt.toISOString() : null, audit_event_id: auditEventId }
  });
  return { id, subjectType, subjectId, roleName, scope, expiresAt, auditEventId, eventId };
}

async function revokeGrant(manager, input) {
  const grantId = positiveId(input.grantId, 'grant_id');
  const rows = await manager.query(
    `SELECT grant_row.*,role.name AS role_name FROM auth_grant grant_row
       INNER JOIN auth_role role ON role.id=grant_row.role_id
      WHERE grant_row.id=? LIMIT 1 FOR UPDATE`,
    [grantId]
  );
  if (!rows.length) throw domainError('GRANT_NOT_FOUND', 'Grant was not found.', 404);
  const grant = rows[0];
  if (grant.revoked_at) throw domainError('GRANT_ALREADY_REVOKED', 'Grant has already been revoked.', 409);
  await manager.query('UPDATE auth_grant SET revoked_at=UTC_TIMESTAMP(3) WHERE id=?', [grantId]);
  const scope = { type: grant.scope_type, id: grant.scope_id == null ? null : String(grant.scope_id) };
  const auditEventId = await input.recordAudit({
    action: 'admin:permission.revoke', resourceType: grant.subject_type, resourceId: grant.subject_id, scope,
    details: { grant_id: String(grantId), role: grant.role_name }
  });
  const eventId = await appendEvent(manager, {
    stream: `authorization:${grant.subject_type}:${grant.subject_id}`, type: 'role.revoked', aggregateId: grant.subject_id, actorId: input.actorId,
    payload: { grant_id: String(grantId), role: grant.role_name, scope, audit_event_id: auditEventId }
  });
  return { id: grantId, subjectType: grant.subject_type, subjectId: Number(grant.subject_id), roleName: grant.role_name, scope, auditEventId, eventId };
}

async function createPolicy(manager, input) {
  const name = requiredText(input.name, 'name', 120);
  const effect = policyEffect(input.effect);
  const capability = policyCapability(input.capability);
  const scope = policyScope(input.scope);
  const conditions = policyConditions(input.conditions);
  const actorId = positiveId(input.actorId, 'actor_id');
  try {
    const result = await manager.query(
      `INSERT INTO auth_policy (name,effect,capability,scope_type,scope_id,conditions_json,enabled,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
      [name, effect, capability, scope.type, scope.id, JSON.stringify(conditions), input.enabled === false ? 0 : 1, actorId]
    );
    const id = Number(result.insertId);
    const auditEventId = await input.recordAudit({
      action: 'admin:policy.create', resourceType: 'authorization_policy', resourceId: id, scope,
      details: { name, effect, capability, conditions, enabled: input.enabled !== false }
    });
    const eventId = await appendEvent(manager, {
      stream: `authorization:policy:${id}`, type: 'policy.created', aggregateId: id, actorId,
      payload: { name, effect, capability, scope, enabled: input.enabled !== false, audit_event_id: auditEventId }
    });
    return { id, name, effect, capability, scope, conditions, enabled: input.enabled !== false, auditEventId, eventId };
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
      throw domainError('POLICY_NAME_CONFLICT', 'A policy with this name already exists.', 409, { name: 'already exists' });
    }
    throw error;
  }
}

async function updatePolicy(manager, input) {
  const id = positiveId(input.policyId, 'policy_id');
  const rows = await manager.query('SELECT * FROM auth_policy WHERE id=? LIMIT 1 FOR UPDATE', [id]);
  if (!rows.length) throw domainError('POLICY_NOT_FOUND', 'Policy was not found.', 404);
  const current = rows[0];
  if (input.ifMatch && !input.ifMatch(current)) {
    throw domainError('ETAG_MISMATCH', 'The policy changed. Refresh it and try again.', 412);
  }
  const has = field => Object.prototype.hasOwnProperty.call(input.patch || {}, field);
  const patch = input.patch || {};
  const name = has('name') ? requiredText(patch.name, 'name', 120) : current.name;
  const effect = has('effect') ? policyEffect(patch.effect) : current.effect;
  const capability = has('capability') ? policyCapability(patch.capability) : current.capability;
  const scope = has('scope') ? policyScope(patch.scope) : { type: current.scope_type, id: current.scope_id == null ? null : String(current.scope_id) };
  const conditions = has('conditions') ? policyConditions(patch.conditions) : policyConditions(current.conditions_json);
  const enabled = has('enabled') ? patch.enabled !== false : !!current.enabled;
  const changedFields = ['name', 'effect', 'capability', 'scope', 'conditions', 'enabled'].filter(field => {
    const before = field === 'scope' ? { type: current.scope_type, id: current.scope_id == null ? null : String(current.scope_id) }
      : field === 'conditions' ? policyConditions(current.conditions_json)
        : field === 'enabled' ? !!current.enabled : current[field];
    const after = field === 'scope' ? scope : field === 'conditions' ? conditions : field === 'enabled' ? enabled : { name, effect, capability }[field];
    return JSON.stringify(before) !== JSON.stringify(after);
  });
  try {
    await manager.query(
      `UPDATE auth_policy SET name=?,effect=?,capability=?,scope_type=?,scope_id=?,conditions_json=?,enabled=?,updated_at=UTC_TIMESTAMP(3)
        WHERE id=?`,
      [name, effect, capability, scope.type, scope.id, JSON.stringify(conditions), enabled ? 1 : 0, id]
    );
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
      throw domainError('POLICY_NAME_CONFLICT', 'A policy with this name already exists.', 409, { name: 'already exists' });
    }
    throw error;
  }
  const auditEventId = await input.recordAudit({
    action: 'admin:policy.update', resourceType: 'authorization_policy', resourceId: id, scope,
    details: { changed_fields: changedFields, name, effect, capability, conditions, enabled }
  });
  const eventId = await appendEvent(manager, {
    stream: `authorization:policy:${id}`, type: enabled ? 'policy.updated' : 'policy.disabled', aggregateId: id,
    actorId: input.actorId, payload: { changed_fields: changedFields, name, effect, capability, scope, enabled, audit_event_id: auditEventId }
  });
  return { id, name, effect, capability, scope, conditions, enabled, changedFields, auditEventId, eventId };
}

module.exports = {
  appendEvent,
  createPolicy,
  createOrganization,
  createTeam,
  domainError,
  grantRole,
  normalizeScope,
  revokeGrant,
  setOrganizationMembership,
  setTeamMembership,
  updatePolicy
};
