const crypto = require('crypto');
const TypeORM = require('typeorm');
const apiHelpers = require('../libs/api-v2');
const authorizationDefinitions = require('../libs/authorization-v2');

const operationMemory = new Map();
const eventStreams = new Map();
let schemaPromise = null;

function isoNow() {
  return new Date().toISOString();
}

function operationId() {
  return `op_${crypto.randomUUID().replace(/-/g, '')}`;
}

function hashPayload(payload) {
  return apiHelpers.sha256(JSON.stringify(payload == null ? null : payload));
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify({ value })).toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    return decoded && decoded.value != null ? decoded.value : null;
  } catch (error) {
    return null;
  }
}

async function ensureFoundationSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const connection = TypeORM.getConnection();
    await connection.query(`
        CREATE TABLE IF NOT EXISTS api_v2_operation (
          id VARCHAR(80) PRIMARY KEY,
          idempotency_key VARCHAR(255) NULL,
          actor_id INT NULL,
          principal_key VARCHAR(80) NOT NULL,
          method VARCHAR(16) NOT NULL,
          path VARCHAR(512) NOT NULL,
          request_hash CHAR(64) NOT NULL,
          status VARCHAR(32) NOT NULL,
          response_status INT NULL,
          response_json LONGTEXT NULL,
          created_at DATETIME(3) NOT NULL,
          updated_at DATETIME(3) NOT NULL,
          expires_at DATETIME(3) NULL,
          UNIQUE KEY uq_api_v2_operation_principal_key (principal_key, idempotency_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const operationColumns = await connection.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='api_v2_operation'"
    );
    if (!operationColumns.some(row => row.COLUMN_NAME === 'principal_key')) {
      await connection.query("ALTER TABLE api_v2_operation ADD COLUMN principal_key VARCHAR(80) NULL AFTER actor_id");
      await connection.query("UPDATE api_v2_operation SET principal_key=IF(actor_id IS NULL,'anonymous',CONCAT('user:',actor_id)) WHERE principal_key IS NULL");
      await connection.query("ALTER TABLE api_v2_operation MODIFY principal_key VARCHAR(80) NOT NULL");
    }
    const operationIndexes = await connection.query(
      "SELECT DISTINCT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='api_v2_operation'"
    );
    if (!operationIndexes.some(row => row.INDEX_NAME === 'uq_api_v2_operation_principal_key')) {
      await connection.query(`DELETE older FROM api_v2_operation older
          INNER JOIN api_v2_operation newer
            ON newer.principal_key=older.principal_key
           AND newer.idempotency_key=older.idempotency_key
           AND (newer.created_at>older.created_at OR (newer.created_at=older.created_at AND newer.id>older.id))
         WHERE older.idempotency_key IS NOT NULL`);
      await connection.query('ALTER TABLE api_v2_operation ADD UNIQUE KEY uq_api_v2_operation_principal_key (principal_key,idempotency_key)');
    }
    await connection.query(`
        CREATE TABLE IF NOT EXISTS api_v2_event (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          stream VARCHAR(160) NOT NULL,
          type VARCHAR(120) NOT NULL,
          aggregate_id VARCHAR(120) NULL,
          actor_id INT NULL,
          payload_json LONGTEXT NOT NULL,
          created_at DATETIME(3) NOT NULL,
          KEY idx_api_v2_event_stream_id (stream, id),
          KEY idx_api_v2_event_aggregate (aggregate_id, id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  })().catch(error => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

function actorId(req) {
  const user = req && req.res && req.res.locals ? req.res.locals.user : null;
  return user ? Number(user.id) || null : null;
}

function principalKey(req) {
  const id = actorId(req);
  return id == null ? 'anonymous' : `user:${id}`;
}

function operationKey(req) {
  const key = req.get('Idempotency-Key');
  return key && key.trim() ? key.trim().slice(0, 255) : null;
}

function operationLookupKey(req, key) {
  return `${principalKey(req)}:${key}`;
}

async function findOperation(req, key, ignoreMemory = false) {
  if (!key) return null;
  const memoryKey = operationLookupKey(req, key);
  const memory = ignoreMemory ? null : operationMemory.get(memoryKey);
  if (memory && memory.expiresAt > Date.now()) return memory;
  try {
    await ensureFoundationSchema();
    const rows = await TypeORM.getConnection().query(
      'SELECT * FROM api_v2_operation WHERE principal_key=? AND idempotency_key=? AND expires_at > UTC_TIMESTAMP(3) LIMIT 1',
      [principalKey(req), key]
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      id: row.id,
      requestHash: row.request_hash,
      status: row.status,
      responseStatus: row.response_status,
      response: row.response_json ? JSON.parse(row.response_json) : null,
      expiresAt: new Date(row.expires_at).getTime()
    };
  } catch (error) {
    return null;
  }
}

async function reserveOperation(req) {
  const key = operationKey(req);
  const requestHash = hashPayload({ method: req.method, path: req.originalUrl || req.url, body: req.body || null });
  const existing = key ? await findOperation(req, key) : null;
  if (existing) {
    req.apiV2OperationId = existing.id;
    const decision = apiHelpers.classifyIdempotency(existing, requestHash);
    if (decision.kind === 'conflict') return { conflict: true, operation: existing };
    if (decision.kind === 'pending') return { pending: true, operation: existing };
    return { replay: decision.response, operation: existing };
  }
  const record = {
    id: operationId(),
    requestHash,
    status: 'started',
    responseStatus: null,
    response: null,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000
  };
  req.apiV2OperationId = record.id;
  try {
    await ensureFoundationSchema();
    if (key) {
      await TypeORM.getConnection().query(
        'DELETE FROM api_v2_operation WHERE principal_key=? AND idempotency_key=? AND expires_at<=UTC_TIMESTAMP(3)',
        [principalKey(req), key]
      );
    }
    await TypeORM.getConnection().query(
      `INSERT INTO api_v2_operation (id,idempotency_key,actor_id,principal_key,method,path,request_hash,status,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),?)`,
      [record.id, key, actorId(req), principalKey(req), req.method, req.originalUrl || req.url, requestHash, record.status, new Date(record.expiresAt)]
    );
  } catch (error) {
    if (key && (error.code === 'ER_DUP_ENTRY' || error.errno === 1062)) {
      const memoryKey = operationLookupKey(req, key);
      operationMemory.delete(memoryKey);
      const raced = await findOperation(req, key, true);
      if (raced) {
        req.apiV2OperationId = raced.id;
        const decision = apiHelpers.classifyIdempotency(raced, requestHash);
        if (decision.kind === 'conflict') return { conflict: true, operation: raced };
        if (decision.kind === 'pending') return { pending: true, operation: raced };
        return { replay: decision.response, operation: raced };
      }
    }
    // In-memory reservation still prevents duplicate writes during a short DB outage.
  }
  if (key) operationMemory.set(operationLookupKey(req, key), record);
  return { operation: record };
}

async function completeOperation(req, status, response) {
  const key = operationKey(req);
  const memoryKey = key ? operationLookupKey(req, key) : null;
  const record = memoryKey ? operationMemory.get(memoryKey) : null;
  const storedStatus = req.apiV2SensitiveResponse ? 409 : status;
  const storedResponse = req.apiV2SensitiveResponse ? {
    data: null,
    meta: response && response.meta ? response.meta : {},
    error: {
      code: 'SENSITIVE_RESPONSE_NOT_REPLAYABLE',
      message: 'This one-time sensitive response cannot be replayed. Check the resulting resources instead.',
      fields: {}
    }
  } : response;
  if (record) {
    record.status = 'completed';
    record.responseStatus = storedStatus;
    record.response = storedResponse;
  }
  try {
    await ensureFoundationSchema();
    await TypeORM.getConnection().query(
      'UPDATE api_v2_operation SET status=?,response_status=?,response_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?',
      ['completed', storedStatus, JSON.stringify(storedResponse), req.apiV2OperationId]
    );
  } catch (error) {
    // Best effort persistence; response has already been sent to the client.
  }
}

function etagFor(value) {
  return apiHelpers.etagFor(value);
}

function setResourceEtag(res, value) {
  const tag = etagFor(value);
  res.set('ETag', tag);
  return tag;
}

function ifMatch(req, currentValue) {
  if (!req.get('If-Match')) {
    const error = new Error('If-Match is required for this editable resource.');
    error.code = 'PRECONDITION_REQUIRED';
    error.statusCode = 428;
    error.fields = { if_match: 'required' };
    throw error;
  }
  return apiHelpers.ifMatchSatisfied(req, etagFor(currentValue), { required: true });
}

function publishEvent(event) {
  if (!eventStreams.has(event.stream)) eventStreams.set(event.stream, []);
  eventStreams.get(event.stream).push(event);
  if (eventStreams.get(event.stream).length > 1000) eventStreams.get(event.stream).shift();
  const listeners = eventStreams.get(`${event.stream}:listeners`) || [];
  listeners.slice().forEach(listener => listener(event));
  return event;
}

async function appendEvent({ stream, type, aggregateId = null, actor = null, payload = {} }) {
  const event = {
    id: `${stream}:${Date.now()}:${crypto.randomUUID()}`,
    stream,
    type,
    aggregate_id: aggregateId == null ? null : String(aggregateId),
    actor_id: actor && actor.id ? Number(actor.id) : null,
    payload,
    created_at: isoNow()
  };
  try {
    await ensureFoundationSchema();
    const result = await TypeORM.getConnection().query(
      'INSERT INTO api_v2_event (stream,type,aggregate_id,actor_id,payload_json,created_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))',
      [stream, type, event.aggregate_id, event.actor_id, JSON.stringify(payload)]
    );
    if (result && result.insertId) event.id = String(result.insertId);
  } catch (error) {
    // The in-process stream remains available for SSE until persistence recovers.
  }
  return publishEvent(event);
}

function subscribeEvents(stream, listener) {
  const key = `${stream}:listeners`;
  if (!eventStreams.has(key)) eventStreams.set(key, []);
  eventStreams.get(key).push(listener);
  return () => {
    const list = eventStreams.get(key) || [];
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  };
}

async function recentEvents(stream, afterId) {
  const inMemory = (eventStreams.get(stream) || []).filter(event => !afterId || String(event.id) !== String(afterId));
  try {
    await ensureFoundationSchema();
    const rows = await TypeORM.getConnection().query(
      'SELECT id,stream,type,aggregate_id,actor_id,payload_json,created_at FROM api_v2_event WHERE stream=? AND (? IS NULL OR id>?) ORDER BY id ASC LIMIT 100',
      [stream, afterId || null, afterId || null]
    );
    return rows.map(row => ({ id: String(row.id), stream: row.stream, type: row.type, aggregate_id: row.aggregate_id, actor_id: row.actor_id, payload: JSON.parse(row.payload_json), created_at: apiHelpers.databaseIso(row.created_at) }));
  } catch (error) {
    return inMemory;
  }
}

async function sse(req, res, stream, options = {}) {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const serialize = typeof options.serialize === 'function' ? options.serialize : event => event;
  const writeEvent = event => {
    const visibleEvent = serialize(event);
    res.write(`id: ${visibleEvent.id}\ndata: ${JSON.stringify(visibleEvent)}\n\n`);
  };
  (await recentEvents(stream, req.get('Last-Event-ID'))).forEach(writeEvent);
  const unsubscribe = subscribeEvents(stream, writeEvent);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
  return res;
}

function requestId(req) {
  return apiHelpers.requestId(req);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.uname || user.username,
    avatar: user.avatar || null,
    email_verified: !!user.is_email_verified
  };
}

function capabilitiesFor(user) {
  const capabilities = new Set(authorizationDefinitions.BUILT_IN_ROLES.guest);
  if (!user) return Array.from(capabilities).sort();
  authorizationDefinitions.BUILT_IN_ROLES.member.forEach((item) => capabilities.add(item));
  authorizationDefinitions.legacyPrivilegeCapabilities(user.privileges)
    .forEach((item) => capabilities.add(item));
  if (user.is_admin) authorizationDefinitions.BUILT_IN_ROLES.site_admin.forEach((item) => capabilities.add(item));
  return Array.from(capabilities).sort();
}

function authorizeV2(user, capability) {
  return capabilitiesFor(user).includes(capability);
}

async function effectiveCapabilitiesFor(user, scope = 'global') {
  const authorization = syzoj.utils.authorizationV2;
  if (authorization && typeof authorization.effectiveCapabilities === 'function') {
    return authorization.effectiveCapabilities(user, scope);
  }
  return capabilitiesFor(user);
}

async function authorizeCurrent(user, capability, resource = null, context = {}) {
  const authorization = syzoj.utils.authorizationV2;
  if (authorization && typeof authorization.authorize === 'function') {
    return authorization.authorize(user, capability, resource, context);
  }
  return authorizeV2(user, capability);
}

function apiMeta(req) {
  return { request_id: req.id, api_version: '2', timestamp: isoNow() };
}

function apiSend(res, payload, status = 200) {
  const body = { data: payload, meta: res.locals.apiMeta || {}, error: null };
  if (res.locals.apiOperationId) body.meta.operation_id = res.locals.apiOperationId;
  setResourceEtag(res, payload);
  if (res.req && res.req.method !== 'GET' && !res.req.apiV2SkipOperationCompletion) completeOperation(res.req, status, body).catch(() => {});
  return res.status(status).json(body);
}

function apiFail(res, status, code, message, details) {
  const body = { data: null, meta: res.locals.apiMeta || {}, error: { code, message, fields: details || {} } };
  if (res.locals.apiOperationId) body.meta.operation_id = res.locals.apiOperationId;
  if (res.req && res.req.method !== 'GET' && !res.req.apiV2SkipOperationCompletion) completeOperation(res.req, status, body).catch(() => {});
  return res.status(status).json(body);
}

async function loadReadableOperation(req, res) {
  await ensureFoundationSchema();
  const rows = await TypeORM.getConnection().query(
    'SELECT id,actor_id,status,response_status,response_json,created_at,updated_at,expires_at FROM api_v2_operation WHERE id=? LIMIT 1',
    [req.params.id]
  );
  const operation = rows[0];
  if (!operation) {
    apiFail(res, 404, 'OPERATION_NOT_FOUND', 'Operation was not found.');
    return null;
  }
  const isJobManager = await authorizeCurrent(res.locals.user, 'admin:job.manage', null, { req, scope: 'global' });
  if (!isJobManager && Number(operation.actor_id) !== Number(res.locals.user.id)) {
    apiFail(res, 403, 'OPERATION_FORBIDDEN', 'You cannot inspect this operation.');
    return null;
  }
  return operation;
}

function parseLimit(req, defaultLimit = 50, maximum = 100) {
  const raw = Number.parseInt(req.query.limit, 10);
  if (!Number.isFinite(raw) || raw < 1) return defaultLimit;
  return Math.min(raw, maximum);
}

function pageFrom(items, req, getCursorValue = item => item && item.id) {
  const limit = parseLimit(req);
  const cursor = decodeCursor(req.query.cursor);
  const filtered = cursor == null ? items : items.filter(item => String(getCursorValue(item)) > String(cursor));
  const page = filtered.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page,
    next_cursor: filtered.length > limit && last ? encodeCursor(getCursorValue(last)) : null,
    limit
  };
}

function apiNotModified(req, res, value) {
  const tag = setResourceEtag(res, value);
  if (req.get('If-None-Match') === tag) {
    res.status(304).end();
    return true;
  }
  return false;
}

function operationMiddleware(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  reserveOperation(req).then(result => {
    if (result.conflict) {
      req.apiV2SkipOperationCompletion = true;
      return apiFail(res, 409, 'IDEMPOTENCY_CONFLICT', 'The idempotency key was already used with a different request.');
    }
    if (result.pending) {
      req.apiV2SkipOperationCompletion = true;
      return apiFail(res, 409, 'OPERATION_IN_PROGRESS', 'An operation with this Idempotency-Key is still in progress.');
    }
    if (result.replay) return res.status(result.operation.responseStatus || 200).json(result.operation.response);
    res.locals.apiOperationId = result.operation.id;
    return next();
  }).catch(error => next(error));
}

const rateBuckets = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;

function gatewayLimits(req, res) {
  const bodyLimit = apiHelpers.requestBodyLimit(req.originalUrl, req.get('content-type'), {
    defaultBytes: MAX_BODY_BYTES,
    multipartOverheadBytes: MAX_BODY_BYTES,
    testdataArchiveBytes: 200 * 1024 * 1024,
    testdataFilesBytes: Number(syzoj.config.limit && syzoj.config.limit.testdata || 200 * 1024 * 1024),
    additionalFileBytes: Number(syzoj.config.limit && syzoj.config.limit.data_size || 200 * 1024 * 1024)
  });
  const contentLength = Number(req.get('content-length') || 0);
  const bodyBytes = apiHelpers.bodySize(req.body);
  if (contentLength > bodyLimit || bodyBytes > bodyLimit) {
    apiFail(res, 413, 'REQUEST_BODY_TOO_LARGE', 'The request body exceeds the API limit.', { maximum_bytes: bodyLimit });
    return false;
  }
  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const limit = isWrite ? 60 : 180;
  const actor = res.locals.user ? `user:${res.locals.user.id}` : `ip:${req.ip || 'unknown'}`;
  const key = `${actor}:${isWrite ? 'write' : 'read'}`;
  if (rateBuckets.size > 10000) {
    const now = Date.now();
    for (const [bucketKey, bucket] of rateBuckets) {
      if (bucket.resetAt <= now) rateBuckets.delete(bucketKey);
      if (rateBuckets.size <= 8000) break;
    }
  }
  const decision = apiHelpers.consumeFixedWindow(rateBuckets, key, Date.now(), RATE_WINDOW_MS, limit);
  res.set('X-RateLimit-Limit', String(limit));
  res.set('X-RateLimit-Remaining', String(decision.remaining));
  res.set('X-RateLimit-Reset', String(Math.ceil(decision.resetAt / 1000)));
  if (!decision.allowed) {
    res.set('Retry-After', String(Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000))));
    apiFail(res, 429, 'RATE_LIMITED', 'Too many API requests. Retry after the current window.');
    return false;
  }
  return true;
}

function requireCapability(capability) {
  return async (req, res, next) => {
    const user = res.locals.user;
    if (!user) {
      const error = authorizationDefinitions.authorizationError('AUTHENTICATION_REQUIRED', capability);
      return apiFail(res, error.status, error.code, error.message, error.fields);
    }
    try {
      if (!await authorizeCurrent(user, capability, null, { req, scope: 'global' })) {
        const error = authorizationDefinitions.authorizationError('CAPABILITY_REQUIRED', capability);
        return apiFail(res, error.status, error.code, error.message, error.fields);
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function capabilityList(user, scope) {
  return effectiveCapabilitiesFor(user, scope);
}

syzoj.utils.apiV2 = {
  send: apiSend,
  fail: apiFail,
  authorize: authorizeV2,
  requireCapability,
  capabilitiesFor,
  publicUser,
  capabilityList,
  appendEvent,
  publishEvent,
  subscribeEvents,
  recentEvents,
  sse,
  ensureFoundationSchema,
  reserveOperation,
  completeOperation,
  etagFor,
  setResourceEtag,
  ifMatch,
  apiNotModified,
  parseLimit,
  pageFrom,
  encodeCursor,
  decodeCursor,
  databaseIso: apiHelpers.databaseIso
};

app.use('/api/v2', (req, res, next) => {
  req.id = requestId(req);
  res.set('X-Request-ID', req.id);
  res.locals.apiMeta = apiMeta(req);
  res.set('Cache-Control', req.method === 'GET' ? 'private, max-age=0' : 'no-store');
  if (!gatewayLimits(req, res)) return;
  return operationMiddleware(req, res, next);
});


app.get('/api/v2/meta', (req, res) => apiSend(res, {
  api_version: '2',
  service: 'nwpuoj',
  capabilities: {
    events: true,
    idempotency_keys: true,
    scoped_authorization: true,
    dark_mode: true,
    operation_resources: true,
    rate_limits: true,
    maximum_body_bytes: MAX_BODY_BYTES
  }
}));

app.get('/api/v2/operations/:id', async (req, res) => {
  if (!res.locals.user) return apiFail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  try {
    const operation = await loadReadableOperation(req, res);
    if (!operation) return;
    return apiSend(res, {
      id: operation.id,
      status: operation.status,
      response_status: operation.response_status,
      response: operation.response_json ? JSON.parse(operation.response_json) : null,
      created_at: apiHelpers.databaseIso(operation.created_at),
      updated_at: apiHelpers.databaseIso(operation.updated_at),
      expires_at: apiHelpers.databaseIso(operation.expires_at)
    });
  } catch (error) {
    return apiFail(res, 503, 'DEPENDENCY_UNAVAILABLE', 'Operation data is temporarily unavailable.');
  }
});

app.get('/api/v2/operations/:id/events', async (req, res) => {
  if (!res.locals.user) return apiFail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  try {
    const operation = await loadReadableOperation(req, res);
    if (!operation) return;
  } catch (error) {
    return apiFail(res, 503, 'DEPENDENCY_UNAVAILABLE', 'Operation data is temporarily unavailable.');
  }
  const stream = `operation:${req.params.id}`;
  return sse(req, res, stream);
});

app.get('/api/v2/events/:stream', async (req, res) => {
  if (!res.locals.user || !await authorizeCurrent(res.locals.user, 'admin:audit.read', null, { req, scope: 'global' })) {
    return apiFail(res, res.locals.user ? 403 : 401, res.locals.user ? 'CAPABILITY_REQUIRED' : 'AUTHENTICATION_REQUIRED', res.locals.user ? 'Capability required: admin:audit.read.' : 'Authentication is required.');
  }
  const stream = String(req.params.stream || '').slice(0, 160);
  if (!stream || !/^[a-zA-Z0-9:_-]+$/.test(stream)) return apiFail(res, 400, 'INVALID_STREAM', 'The event stream is invalid.');
  return sse(req, res, stream);
});

app.get('/api/v2/auth/session', async (req, res) => {
  const user = res.locals.user || null;
  return apiSend(res, {
    authenticated: !!user,
    user: publicUser(user)
  });
});

app.get('/api/v2/me/capabilities', requireCapability('profile:edit'), async (req, res) => {
  const user = res.locals.user;
  const scope = String(req.query.context || 'global').slice(0, 160);
  return apiSend(res, {
    user: publicUser(user),
    capabilities: await capabilityList(user, scope),
    context: { scope, locale: req.locale || 'zh-CN', timezone: 'Asia/Shanghai' }
  });
});

app.get('/api/v2/admin/health', requireCapability('admin:health.read'), async (req, res) => {
  try {
    const rows = await TypeORM.getConnection().query(`
      SELECT
        (SELECT COUNT(*) FROM judge_state WHERE pending=1) AS pending_judgements,
        (SELECT COUNT(*) FROM problem_solution WHERE status='pending') AS pending_solutions,
        (SELECT COUNT(*) FROM ticket WHERE status IN ('pending','in_progress')) AS open_tickets,
        (SELECT COUNT(*) FROM user) AS users,
        (SELECT COUNT(*) FROM problem) AS problems,
        (SELECT COUNT(*) FROM contest) AS contests
    `);
    const row = rows[0] || {};
    return apiSend(res, {
      status: 'ok',
      database: 'ok',
      queue: {
        pending_judgements: Number(row.pending_judgements || 0),
        pending_solutions: Number(row.pending_solutions || 0)
      },
      counts: {
        users: Number(row.users || 0),
        problems: Number(row.problems || 0),
        contests: Number(row.contests || 0),
        open_tickets: Number(row.open_tickets || 0)
      }
    });
  } catch (error) {
    syzoj.log(`[api-v2] health check failed: ${error.stack || error.message}`);
    return apiFail(res, 503, 'DEPENDENCY_UNAVAILABLE', 'Health data is temporarily unavailable.');
  }
});

ensureFoundationSchema().catch(error => syzoj.log(`[api-v2] foundation schema initialization failed: ${error.stack || error.message}`));
