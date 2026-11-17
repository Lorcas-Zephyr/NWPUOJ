'use strict';

const TypeORM = require('typeorm');
const connection = () => TypeORM.getConnection();
const api = () => syzoj.utils.apiV2;
const isAdmin = user => !!(user && (user.is_admin || Number(user.id) === Number(syzoj.siteOwnerUserId || 0)));
const activeSql = 'b.lifted_at IS NULL AND (b.expires_at IS NULL OR b.expires_at>UTC_TIMESTAMP(3))';
const banColumns = `b.*,u.username,creator.username AS creator_name,
  DATE_FORMAT(b.created_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS created_at,
  DATE_FORMAT(b.expires_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS expires_at,
  DATE_FORMAT(b.lifted_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS lifted_at,
  (${activeSql}) AS active`;
const banJoins = 'FROM account_ban b LEFT JOIN user u ON u.id=b.target_user_id LEFT JOIN user creator ON creator.id=b.created_by';

function failure(message, code = 'VALIDATION_FAILED', statusCode = 422) {
  return Object.assign(new Error(message), { code, statusCode });
}
function fail(res, error) {
  if (!error.statusCode) syzoj.log('[account-bans] ' + (error.stack || error.message));
  return api().fail(res, error.statusCode || 503, error.code && error.statusCode ? error.code : 'BAN_SERVICE_UNAVAILABLE',
    error.statusCode ? error.message : '封禁管理暂时不可用，请稍后重试。');
}
function positiveId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw failure('编号无效。');
  return id;
}
async function authorize(req, res, recent) {
  if (!res.locals.user) throw failure('请先登录。', 'AUTHENTICATION_REQUIRED', 401);
  if (!isAdmin(res.locals.user) || !await syzoj.utils.authorizationV2.authorize(res.locals.user, 'admin:user.manage', null, { req, scope: 'global' })) {
    throw failure('只有全站管理员可以管理封禁。', 'CAPABILITY_REQUIRED', 403);
  }
  if (recent && !syzoj.utils.authorizationV2.recentLoginSatisfied(req)) {
    throw failure('请重新登录后再执行封禁管理。', 'RECENT_LOGIN_REQUIRED', 403);
  }
  await syzoj.utils.ensureAccountBanSchema();
}
function resource(row) {
  return {
    id: Number(row.id), type: row.target_type, user_id: row.target_user_id == null ? null : Number(row.target_user_id),
    username: row.username || null, ip: row.target_ip || null, reason: row.reason || '',
    created_by: Number(row.created_by), creator_name: row.creator_name || null,
    created_at: row.created_at, expires_at: row.expires_at, lifted_at: row.lifted_at,
    lifted_by: row.lifted_by == null ? null : Number(row.lifted_by), active: !!Number(row.active)
  };
}
async function loginIps(userId, db = connection()) {
  const rows = await db.query(`SELECT ip_address,DATE_FORMAT(MAX(created_at),'%Y-%m-%dT%H:%i:%s.%fZ') AS last_login
    FROM auth_audit_event WHERE action='auth:login' AND resource_type='user' AND resource_id=?
    GROUP BY ip_address ORDER BY MAX(created_at) DESC LIMIT 200`, [String(userId)]);
  const ips = new Map();
  for (const row of rows) {
    const ip = syzoj.utils.normalizeBanIp(row.ip_address);
    if (ip && !ips.has(ip)) ips.set(ip, { ip, last_login: row.last_login });
  }
  return Array.from(ips.values());
}
async function list(query) {
  const keyword = String(query.q || '').trim().slice(0, 80);
  const conditions = [], values = [];
  if (query.status !== 'all') conditions.push(activeSql);
  if (keyword) {
    conditions.push('(u.username LIKE ? OR b.target_user_id=? OR b.target_ip LIKE ?)');
    const like = '%' + keyword.replace(/[\\%_]/g, '\\$&') + '%';
    values.push(like, /^\d+$/.test(keyword) ? keyword : 0, like);
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const [count] = await connection().query(`SELECT COUNT(*) AS total ${banJoins} ${where}`, values);
  const total = Number(count.total), pageCount = Math.max(1, Math.ceil(total / 30));
  const page = Math.min(positiveId(query.page || 1), pageCount);
  const rows = await connection().query(`SELECT ${banColumns} ${banJoins} ${where}
    ORDER BY (${activeSql}) DESC,b.created_at DESC,b.id DESC LIMIT 30 OFFSET ?`, [...values, (page - 1) * 30]);
  return { items: rows.map(resource), total, page, page_count: pageCount };
}
function protectAccount(actor, target) {
  if (Number(target.id) === Number(syzoj.siteOwnerUserId || 0)) throw failure('站长账号不能封禁。', 'OWNER_ACCOUNT_PROTECTED', 403);
  if (Number(target.id) === Number(actor.id)) throw failure('不能封禁自己的账号。', 'SELF_ACCOUNT_STATUS_FORBIDDEN', 409);
  if (target.is_admin && Number(actor.id) !== Number(syzoj.siteOwnerUserId || 0)) {
    throw failure('只有站长可以管理全站管理员的封禁。', 'OWNER_CAPABILITY_REQUIRED', 403);
  }
}
function expiry(body) {
  if (typeof body.permanent !== 'boolean') throw failure('请选择封禁期限。');
  if (body.permanent) return null;
  const raw = String(body.expires_at || '');
  const date = new Date(raw);
  if (!/(?:Z|[+-]\d\d:\d\d)$/i.test(raw) || !Number.isFinite(date.getTime()) || date.getTime() <= Date.now() || date.getUTCFullYear() > 9999) {
    throw failure('请选择未来的解封时间。');
  }
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

app.get('/admin/bans', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    await authorize(req, res, false);
    return res.render('admin_bans', { banList: await list(req.query), keyword: String(req.query.q || '').trim().slice(0, 80), showAll: req.query.status === 'all' });
  } catch (error) {
    if (!error.statusCode) syzoj.log(error);
    return res.status(error.statusCode || 503).render('error', { err: error });
  }
});

app.get('/api/v2/admin/bans', async (req, res) => {
  try { await authorize(req, res, false); return api().send(res, await list(req.query)); }
  catch (error) { return fail(res, error); }
});

app.get('/api/v2/admin/bans/users/:id', async (req, res) => {
  try {
    await authorize(req, res, false);
    const id = positiveId(req.params.id);
    const [user] = await connection().query('SELECT id,username FROM user WHERE id=?', [id]);
    if (!user) throw failure('用户不存在。', 'USER_NOT_FOUND', 404);
    const ips = await loginIps(id), addresses = ips.map(item => item.ip);
    const rows = await connection().query(`SELECT ${banColumns} ${banJoins}
      WHERE (${activeSql}) AND (b.target_user_id=? ${addresses.length ? 'OR b.target_ip IN (?)' : ''}) ORDER BY b.id DESC`,
    addresses.length ? [id, addresses] : [id]);
    return api().send(res, { user, ips, bans: rows.map(resource) });
  } catch (error) { return fail(res, error); }
});

app.post('/api/v2/admin/bans', async (req, res) => {
  try {
    await authorize(req, res, true);
    const body = req.body || {}, type = body.type, actor = res.locals.user;
    if (!['account', 'ip'].includes(type)) throw failure('请选择账号或 IP 封禁类型。');
    const expiresAt = expiry(body), reason = String(body.reason || '').trim();
    if (reason.length > 1000) throw failure('封禁原因不能超过 1000 个字符。');
    const targetIp = type === 'ip' ? syzoj.utils.normalizeBanIp(body.ip) : null;
    if (type === 'ip' && !targetIp) throw failure('请输入有效的 IPv4 或 IPv6 地址。');
    // A profile supplies user_id; a standalone admin entry can supply a username or an IP.
    const requestedId = body.user_id == null || body.user_id === '' ? null : positiveId(body.user_id);
    const username = String(body.username || '').trim();
    if (type === 'account' && requestedId == null && !username) throw failure('请输入用户名。');
    const result = await connection().transaction(async manager => {
      let target = null;
      if (requestedId != null || type === 'account') {
        const targets = await manager.query('SELECT id,username,is_admin FROM user WHERE ' + (requestedId != null ? 'id=?' : 'username=?') + ' LIMIT 1 FOR UPDATE', [requestedId == null ? username : requestedId]);
        if (!targets.length) throw failure('用户不存在。', 'USER_NOT_FOUND', 404);
        target = targets[0];
        protectAccount(actor, target);
        if (type === 'ip' && !(await loginIps(target.id, manager)).some(item => item.ip === targetIp)) {
          throw failure('请选择该账号的登录 IP。');
        }
      }
      const inserted = await manager.query(`INSERT INTO account_ban
        (target_type,target_user_id,target_ip,reason,created_by,created_at,expires_at)
        VALUES (?,?,?,?,?,UTC_TIMESTAMP(3),?)`, [type, target ? target.id : null, targetIp, reason || null, actor.id, expiresAt]);
      const id = Number(inserted.insertId);
      const auditId = await syzoj.utils.authorizationV2.recordAudit(req, {
        action: 'admin:account-ban.create', resourceType: 'account_ban', resourceId: id, reason,
        details: { type, user_id: target ? target.id : null, ip: targetIp, expires_at: expiresAt }
      }, manager);
      return { id, type, user_id: target ? Number(target.id) : null, ip: targetIp, audit_event_id: String(auditId) };
    });
    if (type === 'account') {
      await syzoj.utils.revokeUserSessions(req, result.user_id);
      if (syzoj.utils.baseWorkspace) syzoj.utils.baseWorkspace.revokeConnections([result.user_id]);
    } else await syzoj.utils.revokeIpSessions(req, targetIp);
    return api().send(res, result, 201);
  } catch (error) { return fail(res, error); }
});

app.delete('/api/v2/admin/bans/:id', async (req, res) => {
  try {
    await authorize(req, res, true);
    const id = positiveId(req.params.id);
    const auditId = await connection().transaction(async manager => {
      const [ban] = await manager.query('SELECT * FROM account_ban WHERE id=? FOR UPDATE', [id]);
      if (!ban) throw failure('封禁记录不存在。', 'BAN_NOT_FOUND', 404);
      if (ban.target_user_id) {
        const [target] = await manager.query('SELECT id,is_admin FROM user WHERE id=? FOR UPDATE', [ban.target_user_id]);
        if (target && target.is_admin && Number(res.locals.user.id) !== Number(syzoj.siteOwnerUserId || 0)) {
          throw failure('只有站长可以管理全站管理员的封禁。', 'OWNER_CAPABILITY_REQUIRED', 403);
        }
      }
      if (ban.lifted_at) return null;
      await manager.query('UPDATE account_ban SET lifted_by=?,lifted_at=UTC_TIMESTAMP(3) WHERE id=?', [res.locals.user.id, id]);
      return syzoj.utils.authorizationV2.recordAudit(req, { action: 'admin:account-ban.lift', resourceType: 'account_ban', resourceId: id }, manager);
    });
    return api().send(res, { id, lifted: true, audit_event_id: auditId == null ? null : String(auditId) });
  } catch (error) { return fail(res, error); }
});
