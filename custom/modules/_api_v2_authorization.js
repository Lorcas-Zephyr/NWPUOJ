const TypeORM = require('typeorm');
const authorizationDomain = require('../libs/authorization-domain');
const {
  BUILT_IN_ROLES,
  HIGH_RISK_CAPABILITIES,
  authorizationError,
  capabilityMatches,
  evaluatePolicies,
  firstAdminWorkspace,
  legacyPrivilegeCapabilities,
  normalizeScope,
  normalizePolicyConditions,
  recentAuthentication,
  resourceOwnerAllows,
  scopeMatches
} = require('../libs/authorization-v2');

let schemaPromise = null;

async function ensureAuthorizationSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const connection = TypeORM.getConnection();
    await connection.query(`
      CREATE TABLE IF NOT EXISTS auth_organization (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        slug VARCHAR(120) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        created_by INT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS auth_organization_member (
        organization_id BIGINT UNSIGNED NOT NULL,
        user_id INT NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        created_at DATETIME(3) NOT NULL,
        PRIMARY KEY (organization_id,user_id),
        KEY idx_auth_org_member_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS auth_team (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        organization_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
        slug VARCHAR(120) NOT NULL,
        name VARCHAR(255) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        created_by INT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_auth_team_org_slug (organization_id,slug)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const teamColumns = await connection.query(
      "SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='auth_team' AND COLUMN_NAME='organization_id' LIMIT 1"
    );
    if (teamColumns[0] && teamColumns[0].IS_NULLABLE === 'YES') {
      await connection.query('UPDATE auth_team SET organization_id=0 WHERE organization_id IS NULL');
      await connection.query('ALTER TABLE auth_team MODIFY organization_id BIGINT UNSIGNED NOT NULL DEFAULT 0');
    }
    await connection.query(`
      CREATE TABLE IF NOT EXISTS auth_team_member (
        team_id BIGINT UNSIGNED NOT NULL,
        user_id INT NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        created_at DATETIME(3) NOT NULL,
        PRIMARY KEY (team_id,user_id),
        KEY idx_auth_team_member_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS auth_team_scope (
        team_id BIGINT UNSIGNED NOT NULL,
        scope_type VARCHAR(40) NOT NULL,
        scope_id VARCHAR(120) NOT NULL DEFAULT '',
        created_at DATETIME(3) NOT NULL,
        PRIMARY KEY (team_id,scope_type,scope_id),
        KEY idx_auth_team_scope (scope_type,scope_id,team_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS auth_role (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(120) NOT NULL UNIQUE,
        description VARCHAR(500) NULL,
        built_in TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS auth_role_capability (
        role_id BIGINT UNSIGNED NOT NULL,
        capability VARCHAR(160) NOT NULL,
        PRIMARY KEY (role_id,capability),
        KEY idx_auth_capability_name (capability)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS auth_grant (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        subject_type VARCHAR(24) NOT NULL,
        subject_id BIGINT UNSIGNED NOT NULL,
        role_id BIGINT UNSIGNED NOT NULL,
        scope_type VARCHAR(40) NOT NULL DEFAULT 'global',
        scope_id VARCHAR(120) NULL,
        granted_by INT NULL,
        created_at DATETIME(3) NOT NULL,
        expires_at DATETIME(3) NULL,
        revoked_at DATETIME(3) NULL,
        KEY idx_auth_grant_subject (subject_type,subject_id,revoked_at),
        KEY idx_auth_grant_scope (scope_type,scope_id,revoked_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS auth_policy (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(120) NOT NULL UNIQUE,
        effect VARCHAR(16) NOT NULL DEFAULT 'deny',
        capability VARCHAR(160) NOT NULL,
        scope_type VARCHAR(40) NOT NULL DEFAULT 'global',
        scope_id VARCHAR(120) NULL,
        conditions_json LONGTEXT NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const policyColumns = await connection.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='auth_policy'"
    );
    if (!policyColumns.some(row => row.COLUMN_NAME === 'scope_id')) {
      await connection.query('ALTER TABLE auth_policy ADD COLUMN scope_id VARCHAR(120) NULL AFTER scope_type');
    }
    const policyIndexes = await connection.query(
      "SELECT DISTINCT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='auth_policy'"
    );
    if (!policyIndexes.some(row => row.INDEX_NAME === 'idx_auth_policy_lookup')) {
      await connection.query('ALTER TABLE auth_policy ADD KEY idx_auth_policy_lookup (enabled,capability,scope_type,scope_id)');
    }
    await connection.query(`
      CREATE TABLE IF NOT EXISTS auth_audit_event (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        actor_id INT NULL,
        action VARCHAR(160) NOT NULL,
        resource_type VARCHAR(80) NULL,
        resource_id VARCHAR(120) NULL,
        scope_type VARCHAR(40) NULL,
        scope_id VARCHAR(120) NULL,
        reason VARCHAR(1000) NULL,
        request_id VARCHAR(128) NULL,
        ip_address VARCHAR(80) NULL,
        details_json LONGTEXT NOT NULL,
        created_at DATETIME(3) NOT NULL,
        KEY idx_auth_audit_created (created_at,id),
        KEY idx_auth_audit_resource (resource_type,resource_id,id),
        KEY idx_auth_audit_actor (actor_id,id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const auditTriggers = await connection.query(
      "SELECT TRIGGER_NAME FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='auth_audit_event'"
    );
    const triggerNames = new Set(auditTriggers.map(row => row.TRIGGER_NAME));
    if (!triggerNames.has('auth_audit_event_immutable_update')) {
      await connection.query(`CREATE TRIGGER auth_audit_event_immutable_update
        BEFORE UPDATE ON auth_audit_event FOR EACH ROW
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Authorization audit events are immutable'`);
    }
    if (!triggerNames.has('auth_audit_event_immutable_delete')) {
      await connection.query(`CREATE TRIGGER auth_audit_event_immutable_delete
        BEFORE DELETE ON auth_audit_event FOR EACH ROW
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Authorization audit events are immutable'`);
    }

    for (const [name, capabilities] of Object.entries(BUILT_IN_ROLES)) {
      await connection.query(
        `INSERT INTO auth_role (name,description,built_in,created_at,updated_at) VALUES (?,?,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE description=VALUES(description),built_in=1,updated_at=UTC_TIMESTAMP(3)`,
        [name, `Built-in ${name} role`]
      );
      const rows = await connection.query('SELECT id FROM auth_role WHERE name=? LIMIT 1', [name]);
      const roleId = rows[0].id;
      await connection.query('DELETE FROM auth_role_capability WHERE role_id=?', [roleId]);
      for (const capability of capabilities) {
        await connection.query('INSERT IGNORE INTO auth_role_capability (role_id,capability) VALUES (?,?)', [roleId, capability]);
      }
    }
  })().catch(error => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

async function persistentCapabilities(user, scope) {
  if (!user) return [];
  await ensureAuthorizationSchema();
  const requested = normalizeScope(scope);
  const teamRows = await TypeORM.getConnection().query(
    "SELECT team_id FROM auth_team_member WHERE user_id=? AND status='active'",
    [user.id]
  );
  const subjects = [{ type: 'user', id: Number(user.id) }].concat(teamRows.map(row => ({ type: 'team', id: Number(row.team_id) })));
  const clauses = subjects.map(() => '(grant_row.subject_type=? AND grant_row.subject_id=?)').join(' OR ');
  const params = subjects.flatMap(subject => [subject.type, subject.id]);
  const rows = await TypeORM.getConnection().query(
    `SELECT grant_row.scope_type,grant_row.scope_id,capability.capability
       FROM auth_grant grant_row
       JOIN auth_role_capability capability ON capability.role_id=grant_row.role_id
      WHERE (${clauses}) AND grant_row.revoked_at IS NULL
        AND (grant_row.expires_at IS NULL OR grant_row.expires_at>UTC_TIMESTAMP(3))`,
    params
  );
  return rows.filter(row => scopeMatches(row.scope_type, row.scope_id, requested)).map(row => row.capability);
}

async function authorizedScopeIds(user, scopeType, capability) {
  if (!user) return [];
  await ensureAuthorizationSchema();
  const teamRows = await TypeORM.getConnection().query(
    "SELECT team_id FROM auth_team_member WHERE user_id=? AND status='active'",
    [user.id]
  );
  const subjects = [{ type: 'user', id: Number(user.id) }].concat(teamRows.map(row => ({ type: 'team', id: Number(row.team_id) })));
  const clauses = subjects.map(() => '(grant_row.subject_type=? AND grant_row.subject_id=?)').join(' OR ');
  const params = subjects.flatMap(subject => [subject.type, subject.id]);
  params.push(String(scopeType));
  const rows = await TypeORM.getConnection().query(
    `SELECT DISTINCT grant_row.scope_id,capability_row.capability
       FROM auth_grant grant_row
       JOIN auth_role_capability capability_row ON capability_row.role_id=grant_row.role_id
      WHERE (${clauses}) AND grant_row.scope_type=? AND grant_row.scope_id IS NOT NULL
        AND grant_row.revoked_at IS NULL
        AND (grant_row.expires_at IS NULL OR grant_row.expires_at>UTC_TIMESTAMP(3))`,
    params
  );
  return Array.from(new Set(rows
    .filter(row => capabilityMatches(row.capability, capability))
    .map(row => String(row.scope_id))));
}

async function effectiveCapabilities(subject, scope) {
  const capabilities = new Set(BUILT_IN_ROLES.guest);
  if (!subject) return Array.from(capabilities).sort();
  if (Number(subject.id) === Number(syzoj.siteOwnerUserId || 0)) return ['*'];

  (await persistentCapabilities(subject, scope)).forEach(value => capabilities.add(value));
  BUILT_IN_ROLES.member.forEach(value => capabilities.add(value));
  legacyPrivilegeCapabilities(subject.privileges).forEach(value => capabilities.add(value));
  if (subject.is_admin) BUILT_IN_ROLES.site_admin.forEach(value => capabilities.add(value));
  return Array.from(capabilities).sort();
}

async function policyDecision(subject, capability, resource, context, scope) {
  await ensureAuthorizationSchema();
  const connection = TypeORM.getConnection();
  const policies = await connection.query(
    'SELECT id,name,effect,capability,scope_type,scope_id,conditions_json,enabled FROM auth_policy WHERE enabled=1 ORDER BY id ASC'
  );
  if (!policies.length) return { effect: null, matchedPolicyIds: [], invalidPolicyIds: [] };
  const [teams, organizations] = await Promise.all([
    connection.query("SELECT team_id FROM auth_team_member WHERE user_id=? AND status='active'", [subject.id]),
    connection.query("SELECT organization_id FROM auth_organization_member WHERE user_id=? AND status='active'", [subject.id])
  ]);
  const req = context && context.req;
  const decision = evaluatePolicies(policies, capability, scope, {
    userId: Number(subject.id),
    teamIds: teams.map(row => Number(row.team_id)),
    organizationIds: organizations.map(row => Number(row.organization_id)),
    ipAddress: req && (req.ip || req.socket && req.socket.remoteAddress),
    riskLevel: context && (context.riskLevel || context.risk),
    visibility: context && context.visibility || resource && resource.visibility,
    state: context && context.state || resource && (resource.state || resource.status),
    ownerId: resource && resource.ownerId
  });
  if (context) context.policyDecision = decision;
  return decision;
}

async function authorize(subject, capability, resource, context = {}) {
  if (!subject) return false;
  const scope = context.scope || (resource && resource.scope) || 'global';
  const baseAllowed = resourceOwnerAllows(subject, capability, resource) ||
    (await effectiveCapabilities(subject, scope)).some(value => capabilityMatches(value, capability));
  if (capability === 'owner:transfer') return baseAllowed;
  const decision = await policyDecision(subject, capability, resource, context, scope);
  if (decision.effect === 'deny') return false;
  if (decision.effect === 'allow') return true;
  return baseAllowed;
}

function recentLoginSatisfied(req) {
  return recentAuthentication(req && req.session).satisfied;
}

function failAuthorization(res, code, capability) {
  const error = authorizationError(code, capability);
  return syzoj.utils.apiV2.fail(res, error.status, error.code, error.message, error.fields);
}

async function recordAudit(req, event, manager = null) {
  await ensureAuthorizationSchema();
  const actor = req && req.res && req.res.locals ? req.res.locals.user : null;
  const scope = normalizeScope(event.scope);
  const queryable = manager || TypeORM.getConnection();
  const result = await queryable.query(
    `INSERT INTO auth_audit_event (actor_id,action,resource_type,resource_id,scope_type,scope_id,reason,request_id,ip_address,details_json,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`,
    [actor ? actor.id : null, event.action, event.resourceType || null, event.resourceId == null ? null : String(event.resourceId), scope.type, scope.id, event.reason || null, req ? req.id : null, req ? req.ip : null, JSON.stringify(event.details || {})]
  );
  return String(result.insertId);
}

function requireScopedCapability(capability, getResource) {
  return async (req, res, next) => {
    const api = syzoj.utils.apiV2;
    const user = res.locals.user;
    if (!user) return failAuthorization(res, 'AUTHENTICATION_REQUIRED', capability);
    try {
      const resource = getResource ? await getResource(req, res) : null;
      if (!await authorize(user, capability, resource, { req, scope: resource && resource.scope })) {
        return failAuthorization(res, 'CAPABILITY_REQUIRED', capability);
      }
      if (HIGH_RISK_CAPABILITIES.has(capability) && !recentLoginSatisfied(req)) {
        return failAuthorization(res, 'RECENT_LOGIN_REQUIRED', capability);
      }
      res.locals.apiV2Authorization = { capability, resource };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

syzoj.utils.authorizationV2 = {
  roles: BUILT_IN_ROLES,
  ensureSchema: ensureAuthorizationSchema,
  normalizeScope,
  capabilityMatches,
  firstAdminWorkspace,
  scopeMatches,
  persistentCapabilities,
  policyDecision,
  authorizedScopeIds,
  effectiveCapabilities,
  authorize,
  requireScopedCapability,
  recordAudit,
  recentLoginSatisfied
};

app.get('/api/v2/admin/audit-events', requireScopedCapability('admin:audit.read'), async (req, res) => {
  const api = syzoj.utils.apiV2;
  const limit = api.parseLimit(req, 50, 100);
  const cursor = api.decodeCursor(req.query.cursor);
  await ensureAuthorizationSchema();
  const rows = await TypeORM.getConnection().query(
    `SELECT id,actor_id,action,resource_type,resource_id,scope_type,scope_id,reason,request_id,ip_address,details_json,created_at
       FROM auth_audit_event WHERE (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?`,
    [cursor || null, cursor || null, limit + 1]
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(row => ({
    id: String(row.id), actor_id: row.actor_id, action: row.action, resource_type: row.resource_type,
    resource_id: row.resource_id, scope: { type: row.scope_type, id: row.scope_id }, reason: row.reason,
    request_id: row.request_id, ip_address: row.ip_address, details: JSON.parse(row.details_json || '{}'),
    created_at: syzoj.utils.apiV2.databaseIso(row.created_at)
  }));
  res.locals.apiMeta.next_cursor = hasMore ? api.encodeCursor(rows[limit - 1].id) : null;
  res.locals.apiMeta.limit = limit;
  return api.send(res, page);
});

function authorizationFailure(res, error) {
  return syzoj.utils.apiV2.fail(
    res,
    error.statusCode || 409,
    error.code || 'AUTHORIZATION_WRITE_FAILED',
    error.message || 'The authorization change could not be completed.',
    error.fields || {}
  );
}

function roleScopeResource(req) {
  return { scope: normalizeScope(req.body && req.body.scope) };
}

async function teamScopeResource(req) {
  await ensureAuthorizationSchema();
  const rows = await TypeORM.getConnection().query(
    `SELECT team.organization_id,scope.scope_type,scope.scope_id
       FROM auth_team team LEFT JOIN auth_team_scope scope ON scope.team_id=team.id
      WHERE team.id=? LIMIT 1`,
    [Number(req.params.id)]
  );
  if (!rows.length) throw authorizationDomain.domainError('TEAM_NOT_FOUND', 'Team was not found.', 404);
  const row = rows[0];
  return { scope: row.organization_id ? { type: 'organization', id: String(row.organization_id) } : { type: row.scope_type || 'team', id: row.scope_id || String(req.params.id) } };
}

async function grantScopeResource(req, res) {
  await ensureAuthorizationSchema();
  const rows = await TypeORM.getConnection().query(
    `SELECT grant_row.*,role.name AS role_name FROM auth_grant grant_row
       INNER JOIN auth_role role ON role.id=grant_row.role_id
      WHERE grant_row.id=? LIMIT 1`,
    [Number(req.params.id)]
  );
  if (!rows.length) throw authorizationDomain.domainError('GRANT_NOT_FOUND', 'Grant was not found.', 404);
  res.locals.authorizationGrant = rows[0];
  return { scope: { type: rows[0].scope_type, id: rows[0].scope_id } };
}

function auditRecorder(req, reason, manager) {
  return event => recordAudit(req, Object.assign({}, event, { reason }), manager);
}

function serializeGrant(row) {
  return {
    id: String(row.id), subject_type: row.subject_type, subject_id: Number(row.subject_id),
    role: row.role_name, scope: { type: row.scope_type, id: row.scope_id },
    granted_by: row.granted_by == null ? null : Number(row.granted_by),
    created_at: syzoj.utils.apiV2.databaseIso(row.created_at),
    expires_at: syzoj.utils.apiV2.databaseIso(row.expires_at),
    revoked_at: syzoj.utils.apiV2.databaseIso(row.revoked_at)
  };
}

function serializePolicy(row) {
  let conditions = null;
  let conditionsValid = true;
  try {
    conditions = normalizePolicyConditions(row.conditions_json == null ? row.conditions : row.conditions_json);
  } catch (error) {
    conditionsValid = false;
  }
  return {
    id: String(row.id), name: row.name, effect: row.effect, capability: row.capability,
    scope: { type: row.scope_type || row.scope && row.scope.type || 'global', id: row.scope_id == null ? row.scope && row.scope.id || null : String(row.scope_id) },
    conditions, conditions_valid: conditionsValid, enabled: !!row.enabled,
    created_by: row.created_by == null ? null : Number(row.created_by),
    created_at: row.created_at ? syzoj.utils.apiV2.databaseIso(row.created_at) : null,
    updated_at: row.updated_at ? syzoj.utils.apiV2.databaseIso(row.updated_at) : null
  };
}

async function currentPolicyResource(req, res) {
  await ensureAuthorizationSchema();
  const rows = await TypeORM.getConnection().query('SELECT * FROM auth_policy WHERE id=? LIMIT 1', [Number(req.params.id)]);
  if (!rows.length) throw authorizationDomain.domainError('POLICY_NOT_FOUND', 'Policy was not found.', 404);
  res.locals.authorizationPolicy = rows[0];
  return { scope: { type: rows[0].scope_type, id: rows[0].scope_id } };
}

app.get('/api/v2/admin/roles', requireScopedCapability('admin:permission.grant'), async (req, res) => {
  await ensureAuthorizationSchema();
  const api = syzoj.utils.apiV2;
  const limit = api.parseLimit(req, 50, 100);
  const cursor = Number(api.decodeCursor(req.query.cursor) || 0);
  const rows = await TypeORM.getConnection().query(
    `SELECT role.id,role.name,role.description,role.built_in,role.created_at,role.updated_at,
            GROUP_CONCAT(capability.capability ORDER BY capability.capability SEPARATOR ',') AS capabilities
       FROM auth_role role LEFT JOIN auth_role_capability capability ON capability.role_id=role.id
      WHERE role.id>? GROUP BY role.id ORDER BY role.id ASC LIMIT ?`,
    [cursor, limit + 1]
  );
  const more = rows.length > limit;
  res.locals.apiMeta.limit = limit;
  res.locals.apiMeta.next_cursor = more ? api.encodeCursor(rows[limit - 1].id) : null;
  return api.send(res, rows.slice(0, limit).map(row => ({
    id: String(row.id), name: row.name, description: row.description, built_in: !!row.built_in,
    capabilities: row.capabilities ? row.capabilities.split(',') : [],
    created_at: api.databaseIso(row.created_at), updated_at: api.databaseIso(row.updated_at)
  })));
});

app.get('/api/v2/admin/policies', requireScopedCapability('admin:permission.grant'), async (req, res) => {
  await ensureAuthorizationSchema();
  const api = syzoj.utils.apiV2;
  const limit = api.parseLimit(req, 50, 100);
  const cursor = Number(api.decodeCursor(req.query.cursor) || 0);
  const rows = await TypeORM.getConnection().query(
    'SELECT * FROM auth_policy WHERE id>? ORDER BY id ASC LIMIT ?',
    [cursor, limit + 1]
  );
  const more = rows.length > limit;
  res.locals.apiMeta.limit = limit;
  res.locals.apiMeta.next_cursor = more ? api.encodeCursor(rows[limit - 1].id) : null;
  return api.send(res, rows.slice(0, limit).map(serializePolicy));
});

app.get('/api/v2/admin/policies/:id', requireScopedCapability('admin:permission.grant', currentPolicyResource), async (req, res) => {
  return syzoj.utils.apiV2.send(res, serializePolicy(res.locals.authorizationPolicy));
});

app.post('/api/v2/admin/policies', requireScopedCapability('owner:transfer', roleScopeResource), async (req, res) => {
  const reason = syzoj.utils.operationReason(req, '创建条件授权策略');
  try {
    const result = await TypeORM.getConnection().transaction(manager => authorizationDomain.createPolicy(manager, {
      name: req.body && req.body.name, effect: req.body && req.body.effect,
      capability: req.body && req.body.capability, scope: req.body && req.body.scope,
      conditions: req.body && req.body.conditions, enabled: !req.body || req.body.enabled !== false,
      actorId: res.locals.user.id, recordAudit: auditRecorder(req, reason, manager)
    }));
    return syzoj.utils.apiV2.send(res, {
      id: String(result.id), name: result.name, effect: result.effect, capability: result.capability,
      scope: result.scope, conditions: result.conditions, conditions_valid: true, enabled: result.enabled,
      audit_event_id: result.auditEventId, event_id: result.eventId
    }, 201);
  } catch (error) {
    return authorizationFailure(res, error);
  }
});

app.patch('/api/v2/admin/policies/:id', requireScopedCapability('owner:transfer', currentPolicyResource), async (req, res) => {
  if (!req.get('If-Match')) return syzoj.utils.apiV2.fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when editing an authorization policy.', { if_match: 'required' });
  const reason = syzoj.utils.operationReason(req, '更新条件授权策略');
  try {
    const result = await TypeORM.getConnection().transaction(manager => authorizationDomain.updatePolicy(manager, {
      policyId: req.params.id, patch: req.body || {}, actorId: res.locals.user.id,
      ifMatch: locked => syzoj.utils.apiV2.ifMatch(req, serializePolicy(locked)),
      recordAudit: auditRecorder(req, reason, manager)
    }));
    return syzoj.utils.apiV2.send(res, {
      id: String(result.id), name: result.name, effect: result.effect, capability: result.capability,
      scope: result.scope, conditions: result.conditions, conditions_valid: true, enabled: result.enabled,
      changed_fields: result.changedFields, audit_event_id: result.auditEventId, event_id: result.eventId
    });
  } catch (error) {
    return authorizationFailure(res, error);
  }
});

app.get('/api/v2/admin/users/:id/grants', requireScopedCapability('admin:permission.grant', req => ({ scope: normalizeScope(req.query.scope) })), async (req, res) => {
  await ensureAuthorizationSchema();
  const api = syzoj.utils.apiV2;
  const userId = Number(req.params.id);
  if (!Number.isSafeInteger(userId) || userId < 1) return api.fail(res, 422, 'VALIDATION_FAILED', 'User ID must be a positive integer.', { user_id: 'positive integer required' });
  const limit = api.parseLimit(req, 50, 100);
  const cursor = Number(api.decodeCursor(req.query.cursor) || 0);
  const rows = await TypeORM.getConnection().query(
    `SELECT grant_row.*,role.name AS role_name FROM auth_grant grant_row
       INNER JOIN auth_role role ON role.id=grant_row.role_id
      WHERE grant_row.subject_type='user' AND grant_row.subject_id=? AND grant_row.id>?
      ORDER BY grant_row.id ASC LIMIT ?`,
    [userId, cursor, limit + 1]
  );
  const more = rows.length > limit;
  res.locals.apiMeta.limit = limit;
  res.locals.apiMeta.next_cursor = more ? api.encodeCursor(rows[limit - 1].id) : null;
  return api.send(res, rows.slice(0, limit).map(serializeGrant));
});

async function grantSubjectRole(req, res, subjectType, subjectId) {
  const api = syzoj.utils.apiV2;
  const roleName = String(req.body && req.body.role || '').trim();
  if (['owner', 'site_admin'].includes(roleName) && !await authorize(res.locals.user, 'owner:transfer', null, { req, scope: 'global' })) {
    return failAuthorization(res, 'OWNER_CAPABILITY_REQUIRED', 'owner:transfer');
  }
  const reason = syzoj.utils.operationReason(req, '调整用户或团队权限');
  try {
    const result = await TypeORM.getConnection().transaction(manager => authorizationDomain.grantRole(manager, {
      subjectType, subjectId, roleName, scope: req.body && req.body.scope,
      expiresAt: req.body && req.body.expires_at, actorId: res.locals.user.id,
      recordAudit: auditRecorder(req, reason, manager)
    }));
    return api.send(res, {
      grant_id: String(result.id), subject_type: result.subjectType, subject_id: result.subjectId,
      role: result.roleName, scope: result.scope,
      expires_at: result.expiresAt ? result.expiresAt.toISOString() : null,
      audit_event_id: result.auditEventId, event_id: result.eventId
    }, 201);
  } catch (error) {
    return authorizationFailure(res, error);
  }
}

app.post('/api/v2/admin/users/:id/roles', requireScopedCapability('admin:permission.grant', roleScopeResource), (req, res) => grantSubjectRole(req, res, 'user', req.params.id));
app.post('/api/v2/admin/teams/:id/roles', requireScopedCapability('admin:permission.grant', roleScopeResource), (req, res) => grantSubjectRole(req, res, 'team', req.params.id));

app.delete('/api/v2/admin/grants/:id', requireScopedCapability('admin:permission.grant', grantScopeResource), async (req, res) => {
  const grant = res.locals.authorizationGrant;
  if (grant && ['owner', 'site_admin'].includes(grant.role_name) && !await authorize(res.locals.user, 'owner:transfer', null, { req, scope: 'global' })) {
    return failAuthorization(res, 'OWNER_CAPABILITY_REQUIRED', 'owner:transfer');
  }
  const reason = syzoj.utils.operationReason(req, '撤销用户或团队权限');
  try {
    const result = await TypeORM.getConnection().transaction(manager => authorizationDomain.revokeGrant(manager, {
      grantId: req.params.id, actorId: res.locals.user.id, recordAudit: auditRecorder(req, reason, manager)
    }));
    return syzoj.utils.apiV2.send(res, {
      grant_id: String(result.id), revoked: true, subject_type: result.subjectType,
      subject_id: result.subjectId, role: result.roleName, scope: result.scope,
      audit_event_id: result.auditEventId, event_id: result.eventId
    });
  } catch (error) {
    return authorizationFailure(res, error);
  }
});

app.get('/api/v2/admin/organizations', requireScopedCapability('admin:permission.grant'), async (req, res) => {
  await ensureAuthorizationSchema();
  const api = syzoj.utils.apiV2;
  const limit = api.parseLimit(req, 50, 100);
  const cursor = Number(api.decodeCursor(req.query.cursor) || 0);
  const rows = await TypeORM.getConnection().query(
    `SELECT organization.*,COUNT(member.user_id) AS member_count
       FROM auth_organization organization LEFT JOIN auth_organization_member member
         ON member.organization_id=organization.id AND member.status='active'
      WHERE organization.id>? GROUP BY organization.id ORDER BY organization.id ASC LIMIT ?`,
    [cursor, limit + 1]
  );
  const more = rows.length > limit;
  res.locals.apiMeta.limit = limit;
  res.locals.apiMeta.next_cursor = more ? api.encodeCursor(rows[limit - 1].id) : null;
  return api.send(res, rows.slice(0, limit).map(row => ({
    id: String(row.id), slug: row.slug, name: row.name, status: row.status,
    member_count: Number(row.member_count || 0), created_by: row.created_by,
    created_at: api.databaseIso(row.created_at), updated_at: api.databaseIso(row.updated_at)
  })));
});

app.post('/api/v2/admin/organizations', requireScopedCapability('admin:permission.grant'), async (req, res) => {
  const reason = syzoj.utils.operationReason(req, '创建组织');
  try {
    const result = await TypeORM.getConnection().transaction(manager => authorizationDomain.createOrganization(manager, {
      slug: req.body && req.body.slug, name: req.body && req.body.name, actorId: res.locals.user.id,
      recordAudit: auditRecorder(req, reason, manager)
    }));
    return syzoj.utils.apiV2.send(res, {
      id: String(result.id), slug: result.slug, name: result.name, status: result.status,
      audit_event_id: result.auditEventId, event_id: result.eventId
    }, 201);
  } catch (error) {
    return authorizationFailure(res, error);
  }
});

app.get('/api/v2/admin/organizations/:id/members/:userId', requireScopedCapability('admin:permission.grant', req => ({ scope: { type: 'organization', id: String(req.params.id) } })), async (req, res) => {
  await ensureAuthorizationSchema();
  const rows = await TypeORM.getConnection().query(`SELECT organization.id AS organization_id,u.id AS user_id,member.status FROM auth_organization organization INNER JOIN user u ON u.id=? LEFT JOIN auth_organization_member member ON member.organization_id=organization.id AND member.user_id=u.id WHERE organization.id=? LIMIT 1`, [Number(req.params.userId), Number(req.params.id)]);
  if (!rows.length) return syzoj.utils.apiV2.fail(res, 404, 'ORGANIZATION_MEMBERSHIP_NOT_FOUND', 'Organization or user was not found.');
  return syzoj.utils.apiV2.send(res, { organization_id: Number(rows[0].organization_id), user_id: Number(rows[0].user_id), active: rows[0].status === 'active' });
});

app.put('/api/v2/admin/organizations/:id/members/:userId', requireScopedCapability('admin:permission.grant', req => ({ scope: { type: 'organization', id: String(req.params.id) } })), async (req, res) => {
  if (!req.get('If-Match')) return syzoj.utils.apiV2.fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when replacing organization membership.', { if_match: 'required' });
  const reason = syzoj.utils.operationReason(req, req.body && req.body.active === false ? '移除组织成员' : '添加组织成员');
  try {
    const result = await TypeORM.getConnection().transaction(manager => authorizationDomain.setOrganizationMembership(manager, {
      organizationId: req.params.id, userId: req.params.userId, active: !req.body || req.body.active !== false,
      actorId: res.locals.user.id, ifMatch: current => syzoj.utils.apiV2.ifMatch(req, current), recordAudit: auditRecorder(req, reason, manager)
    }));
    return syzoj.utils.apiV2.send(res, {
      organization_id: String(result.organizationId), user_id: result.userId, active: result.active,
      audit_event_id: result.auditEventId, event_id: result.eventId
    });
  } catch (error) {
    return authorizationFailure(res, error);
  }
});

app.get('/api/v2/admin/teams', requireScopedCapability('admin:permission.grant'), async (req, res) => {
  await ensureAuthorizationSchema();
  const api = syzoj.utils.apiV2;
  const limit = api.parseLimit(req, 50, 100);
  const cursor = Number(api.decodeCursor(req.query.cursor) || 0);
  const rows = await TypeORM.getConnection().query(
    `SELECT team.*,scope.scope_type,scope.scope_id,COUNT(member.user_id) AS member_count
       FROM auth_team team LEFT JOIN auth_team_scope scope ON scope.team_id=team.id
       LEFT JOIN auth_team_member member ON member.team_id=team.id AND member.status='active'
      WHERE team.id>? GROUP BY team.id,scope.scope_type,scope.scope_id ORDER BY team.id ASC LIMIT ?`,
    [cursor, limit + 1]
  );
  const more = rows.length > limit;
  res.locals.apiMeta.limit = limit;
  res.locals.apiMeta.next_cursor = more ? api.encodeCursor(rows[limit - 1].id) : null;
  return api.send(res, rows.slice(0, limit).map(row => ({
    id: String(row.id), organization_id: Number(row.organization_id) > 0 ? String(row.organization_id) : null,
    slug: row.slug, name: row.name, status: row.status, member_count: Number(row.member_count || 0),
    scope: { type: row.scope_type || 'global', id: row.scope_id || null },
    created_by: row.created_by, created_at: api.databaseIso(row.created_at), updated_at: api.databaseIso(row.updated_at)
  })));
});

app.post('/api/v2/admin/teams', requireScopedCapability('admin:permission.grant', req => ({
  scope: req.body && req.body.organization_id ? { type: 'organization', id: String(req.body.organization_id) } : normalizeScope(req.body && req.body.scope)
})), async (req, res) => {
  const reason = syzoj.utils.operationReason(req, '创建团队');
  try {
    const result = await TypeORM.getConnection().transaction(manager => authorizationDomain.createTeam(manager, {
      organizationId: req.body && req.body.organization_id, slug: req.body && req.body.slug,
      name: req.body && req.body.name, scope: req.body && req.body.scope,
      actorId: res.locals.user.id, recordAudit: auditRecorder(req, reason, manager)
    }));
    return syzoj.utils.apiV2.send(res, {
      id: String(result.id), organization_id: result.organizationId == null ? null : String(result.organizationId),
      slug: result.slug, name: result.name, status: result.status, scope: result.scope,
      audit_event_id: result.auditEventId, event_id: result.eventId
    }, 201);
  } catch (error) {
    return authorizationFailure(res, error);
  }
});

app.get('/api/v2/admin/teams/:id/members/:userId', requireScopedCapability('admin:permission.grant', teamScopeResource), async (req, res) => {
  await ensureAuthorizationSchema();
  const rows = await TypeORM.getConnection().query(`SELECT team.id AS team_id,u.id AS user_id,member.status FROM auth_team team INNER JOIN user u ON u.id=? LEFT JOIN auth_team_member member ON member.team_id=team.id AND member.user_id=u.id WHERE team.id=? LIMIT 1`, [Number(req.params.userId), Number(req.params.id)]);
  if (!rows.length) return syzoj.utils.apiV2.fail(res, 404, 'TEAM_MEMBERSHIP_NOT_FOUND', 'Team or user was not found.');
  return syzoj.utils.apiV2.send(res, { team_id: Number(rows[0].team_id), user_id: Number(rows[0].user_id), active: rows[0].status === 'active' });
});

app.put('/api/v2/admin/teams/:id/members/:userId', requireScopedCapability('admin:permission.grant', teamScopeResource), async (req, res) => {
  if (!req.get('If-Match')) return syzoj.utils.apiV2.fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when replacing team membership.', { if_match: 'required' });
  const reason = syzoj.utils.operationReason(req, req.body && req.body.active === false ? '移除团队成员' : '添加团队成员');
  try {
    const result = await TypeORM.getConnection().transaction(manager => authorizationDomain.setTeamMembership(manager, {
      teamId: req.params.id, userId: req.params.userId, active: !req.body || req.body.active !== false,
      actorId: res.locals.user.id, ifMatch: current => syzoj.utils.apiV2.ifMatch(req, current), recordAudit: auditRecorder(req, reason, manager)
    }));
    return syzoj.utils.apiV2.send(res, {
      team_id: String(result.teamId), user_id: result.userId, active: result.active,
      audit_event_id: result.auditEventId, event_id: result.eventId
    });
  } catch (error) {
    return authorizationFailure(res, error);
  }
});

ensureAuthorizationSchema().catch(error => syzoj.log(`[authorization-v2] schema initialization failed: ${error.stack || error.message}`));
