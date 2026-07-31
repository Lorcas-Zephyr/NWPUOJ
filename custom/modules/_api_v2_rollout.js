const TypeORM = require('typeorm');
const crypto = require('crypto');
let schemaPromise = null;
const DOMAINS = ['api', 'problem', 'submission', 'contest', 'rating', 'vjudge', 'content', 'admin'];
const DOMAIN_ROUTES = Object.freeze([
  ['problem', /^\/problems?(?:\/|$)/],
  ['submission', /^\/submissions?(?:\/|$)/],
  ['contest', /^\/contests?(?:\/|$)/],
  ['rating', /^\/?ratings?(?:\/|$)/],
  ['vjudge', /^\/vjudge(?:\/|$)/],
  ['content', /^\/(?:announcements?|discussions?|messages?|notifications?|clipboard|tickets?|solutions?)(?:\/|$)/],
  ['admin', /^\/admin(?:\/|$)/]
]);
async function ensureRolloutSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    await TypeORM.getConnection().query(`CREATE TABLE IF NOT EXISTS api_v2_rollout (
      domain VARCHAR(32) NOT NULL PRIMARY KEY, enabled TINYINT(1) NOT NULL DEFAULT 1,
      percentage TINYINT UNSIGNED NOT NULL DEFAULT 100, updated_by INT NULL,
      updated_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    for (const domain of DOMAINS) {
      const enabled = domain === 'rating' ? 0 : 1;
      const percentage = domain === 'rating' ? 0 : 100;
      await TypeORM.getConnection().query('INSERT IGNORE INTO api_v2_rollout (domain,enabled,percentage,updated_at) VALUES (?,?,?,UTC_TIMESTAMP(3))', [domain, enabled, percentage]);
    }
    await TypeORM.getConnection().query("UPDATE api_v2_rollout SET enabled=0,percentage=0,updated_at=UTC_TIMESTAMP(3) WHERE domain='rating' AND updated_by IS NULL");
  })().catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}
function bucket(req, domain) { const user = req.res && req.res.locals && req.res.locals.user; const seed = user ? String(user.id) : String(req.ip || 'anonymous'); return crypto.createHash('sha256').update(`${domain}:${seed}`).digest().readUInt32BE(0) % 100; }
async function isEnabled(domain, req) { await ensureRolloutSchema(); const rows = await TypeORM.getConnection().query('SELECT enabled,percentage FROM api_v2_rollout WHERE domain=? LIMIT 1', [domain]); const row = rows[0] || { enabled: 1, percentage: 100 }; return !!row.enabled && bucket(req, domain) < Number(row.percentage); }
function routeDomain(pathname) {
  const path = String(pathname || '');
  if (path === '/meta/rollout' || path.startsWith('/admin/rollout/')) return null;
  for (const [domain, matcher] of DOMAIN_ROUTES) if (matcher.test(path)) return domain;
  return 'api';
}
syzoj.utils.apiV2Rollout = { ensureSchema: ensureRolloutSchema, isEnabled, routeDomain };
app.get('/api/v2/meta/rollout', async (req, res) => { await ensureRolloutSchema(); const rows = await TypeORM.getConnection().query('SELECT domain,enabled,percentage,updated_at FROM api_v2_rollout ORDER BY domain'); const detailed = !!(res.locals.user && await syzoj.utils.authorizationV2.authorize(res.locals.user, 'admin:config.read', null, {})); const resource = detailed ? { domains: rows.map(row => ({ domain: row.domain, enabled: !!row.enabled, percentage: Number(row.percentage), updated_at: syzoj.utils.apiV2.databaseIso(row.updated_at) })) } : { domains: rows.map(row => ({ domain: row.domain, enabled: !!row.enabled })) }; return syzoj.utils.apiV2.send(res, resource); });
app.patch('/api/v2/admin/rollout/:domain', async (req, res) => { const api = syzoj.utils.apiV2; const user = res.locals.user; if (!user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await syzoj.utils.authorizationV2.authorize(user, 'admin:config.write', null, {})) return api.fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: admin:config.write.'); if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api.fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again or complete MFA before changing rollout.'); if (!DOMAINS.includes(req.params.domain)) return api.fail(res, 404, 'ROLLOUT_DOMAIN_NOT_FOUND', 'Rollout domain was not found.'); if (!req.get('If-Match')) return api.fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when updating rollout configuration.', { if_match: 'required' }); const reason = syzoj.utils.operationReason(req, '更新 API 灰度配置'); const percentage = Number(req.body && req.body.percentage == null ? 100 : req.body.percentage); if (!Number.isSafeInteger(percentage) || percentage < 0 || percentage > 100) return api.fail(res, 422, 'VALIDATION_FAILED', 'An integer percentage from 0 to 100 is required.', { percentage: 'integer from 0 to 100' }); const enabled = req.body.enabled == null ? true : !!req.body.enabled; await ensureRolloutSchema(); try { const result = await TypeORM.getConnection().transaction(async manager => { const currentRows = await manager.query('SELECT domain,enabled,percentage,updated_at FROM api_v2_rollout ORDER BY domain FOR UPDATE'); const current = { domains: currentRows.map(row => ({ domain: row.domain, enabled: !!row.enabled, percentage: Number(row.percentage), updated_at: api.databaseIso(row.updated_at) })) }; if (!api.ifMatch(req, current)) { const error = new Error('Rollout configuration changed. Refresh it and try again.'); error.code = 'ETAG_MISMATCH'; error.statusCode = 412; throw error; } await manager.query('UPDATE api_v2_rollout SET enabled=?,percentage=?,updated_by=?,updated_at=UTC_TIMESTAMP(3) WHERE domain=?', [enabled ? 1 : 0, percentage, user.id, req.params.domain]); const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'admin:rollout.update', resourceType: 'rollout', resourceId: req.params.domain, reason, details: { enabled, percentage } }, manager); return { auditEventId }; }); return api.send(res, { domain: req.params.domain, enabled, percentage, audit_event_id: result.auditEventId }); } catch (error) { return api.fail(res, error.statusCode || 500, error.code || 'REQUEST_FAILED', error.message || 'Rollout configuration could not be updated.', error.fields || {}); } });

app.use('/api/v2', async (req, res, next) => {
  const domain = routeDomain(req.path);
  if (!domain) return next();
  try {
    if (await isEnabled(domain, req)) return next();
    return syzoj.utils.apiV2.fail(res, 503, 'API_DOMAIN_DISABLED', 'This API domain is not enabled for the current rollout.', {
      domain, action: 'contact_operator'
    });
  } catch (error) {
    syzoj.log(error);
    return syzoj.utils.apiV2.fail(res, 503, 'DEPENDENCY_UNAVAILABLE', 'Rollout configuration is temporarily unavailable.');
  }
});
ensureRolloutSchema().catch(error => syzoj.log(`[api-v2-rollout] schema initialization failed: ${error.stack || error.message}`));
