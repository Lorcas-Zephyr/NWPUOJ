'use strict';

const TypeORM = require('typeorm');

let schemaPromise = null;
function api() { return syzoj.utils.apiV2; }
function connection() { return TypeORM.getConnection(); }
function now() { return Math.floor(Date.now() / 1000); }
function reason(req, fallback) { return syzoj.utils.operationReason(req, fallback || '管理全站通知'); }
async function isSiteAdmin(res) {
  const user = res.locals.user;
  if (!user) return false;
  if (user.is_admin || res.locals.isSiteOwner) return true;
  return typeof syzoj.utils.isSiteOwnerAccount === 'function' && await syzoj.utils.isSiteOwnerAccount(user);
}
async function requireSiteAdmin(req, res) {
  if (await isSiteAdmin(res)) return true;
  api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Only site administrators can manage notifications.');
  return false;
}
function resource(row) {
  return {
    id: Number(row.id), title: row.title || '', content: row.content || '',
    level: row.level || 'info', audience: row.audience || 'all', status: row.status || 'draft',
    scheduled_at: row.scheduled_at == null ? null : new Date(Number(row.scheduled_at) * 1000).toISOString(),
    published_at: row.published_at == null ? null : new Date(Number(row.published_at) * 1000).toISOString(),
    created_by: row.created_by == null ? null : Number(row.created_by),
    updated_at: row.updated_at == null ? null : new Date(Number(row.updated_at) * 1000).toISOString()
  };
}

async function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = connection().query(`CREATE TABLE IF NOT EXISTS site_notification (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL, content TEXT NOT NULL,
    level VARCHAR(16) NOT NULL DEFAULT 'info', audience VARCHAR(16) NOT NULL DEFAULT 'all',
    status VARCHAR(16) NOT NULL DEFAULT 'draft', scheduled_at INT NULL, published_at INT NULL,
    created_by INT NULL, updated_by INT NULL, created_at INT NOT NULL, updated_at INT NOT NULL,
    KEY idx_site_notification_status(status,updated_at), KEY idx_site_notification_publish(published_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}

function validate(body, current) {
  const source = body || {};
  const title = source.title == null && current ? current.title : String(source.title || '').trim();
  const content = source.content == null && current ? current.content : String(source.content || '').trim();
  const level = source.level == null && current ? current.level : String(source.level || 'info').trim();
  const errors = {};
  if (!title) errors.title = '标题不能为空'; else if (title.length > 255) errors.title = '标题不能超过 255 个字符';
  if (!content) errors.content = '内容不能为空'; else if (Buffer.byteLength(content, 'utf8') > 60 * 1024) errors.content = '内容不能超过 60 KiB';
  if (!['info', 'warning', 'important'].includes(level)) errors.level = '通知级别无效';
  return { errors, value: { title, content, level, audience: 'all' } };
}

async function insertRecipients(manager, notificationId, value, actorId, publishedAt) {
  // A site notification is copied to each active user's inbox at publish time.
  // INSERT ... SELECT avoids constructing a request-sized VALUES list.
  if (typeof syzoj.utils.ensureAccountStateSchema === 'function') await syzoj.utils.ensureAccountStateSchema();
  await manager.query(
    `INSERT INTO notification
       (recipient_id,type,title,content,source_url,source_id,actor_id,is_read,created_at)
     SELECT u.id,'site_notification',?,?,?, ?,?,0,?
       FROM user u LEFT JOIN auth_user_state state ON state.user_id=u.id
      WHERE COALESCE(state.status,'active') <> 'disabled'`,
    [value.title, value.content, '/notifications', Number(notificationId), Number(actorId), Number(publishedAt)]
  );
}

async function load(id, lock) {
  const rows = await connection().query(`SELECT * FROM site_notification WHERE id=? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [Number(id)]);
  return rows[0] || null;
}

app.get('/admin/notifications', async (req, res) => {
  try {
    if (!await isSiteAdmin(res)) throw new ErrorMessage('只有全站管理员可以管理通知。');
    await ensureSchema();
    const rows = await connection().query('SELECT * FROM site_notification ORDER BY updated_at DESC,id DESC LIMIT 100');
    res.render('admin_notifications', { notifications: rows.map(resource) });
  } catch (error) { syzoj.log(error); res.status(error.statusCode || 403).render('error', { err: error }); }
});

app.get('/admin/notification/:id/edit', async (req, res) => {
  try {
    if (!await isSiteAdmin(res)) throw new ErrorMessage('只有全站管理员可以管理通知。');
    await ensureSchema();
    const row = Number(req.params.id) > 0 ? await load(req.params.id, false) : null;
    if (req.params.id !== '0' && !row) throw new ErrorMessage('通知不存在。');
    res.render('admin_notification_edit', {
      notification: row || { id: 0, title: '', content: '', level: 'info', status: 'draft' },
      notificationEtag: row ? api().etagFor(resource(row)) : ''
    });
  } catch (error) { syzoj.log(error); res.status(error.statusCode || 403).render('error', { err: error }); }
});

app.get('/api/v2/admin/notifications', async (req, res) => {
  if (!await requireSiteAdmin(req, res)) return;
  await ensureSchema();
  const rows = await connection().query('SELECT * FROM site_notification ORDER BY updated_at DESC,id DESC LIMIT 100');
  return api().send(res, rows.map(resource));
});

app.get('/api/v2/admin/notifications/:id', async (req, res) => {
  if (!await requireSiteAdmin(req, res)) return;
  await ensureSchema();
  const row = await load(req.params.id, false);
  if (!row) return api().fail(res, 404, 'NOTIFICATION_NOT_FOUND', 'Notification was not found.');
  const value = resource(row); api().setResourceEtag(res, value); return api().send(res, value);
});

app.post('/api/v2/admin/notifications', async (req, res) => {
  if (!await requireSiteAdmin(req, res)) return;
  await ensureSchema();
  const checked = validate(req.body); if (Object.keys(checked.errors).length) return api().fail(res, 422, 'VALIDATION_FAILED', 'Notification fields are invalid.', checked.errors);
  const stamp = now();
  try {
    const result = await connection().transaction(async manager => {
      const inserted = await manager.query('INSERT INTO site_notification (title,content,level,audience,status,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,\'all\',\'draft\',?,?,?,?)', [checked.value.title, checked.value.content, checked.value.level, res.locals.user.id, res.locals.user.id, stamp, stamp]);
      const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'admin:notification.create', resourceType: 'site_notification', resourceId: Number(inserted.insertId), reason: reason(req, '创建全站通知') }, manager);
      return { id: Number(inserted.insertId), auditEventId };
    });
    res.locals.apiMeta.audit_event_id = result.auditEventId;
    return api().send(res, resource(await load(result.id, false)), 201);
  } catch (error) { return api().fail(res, error.statusCode || 500, error.code || 'NOTIFICATION_CREATE_FAILED', error.message || 'Notification could not be created.'); }
});

app.patch('/api/v2/admin/notifications/:id', async (req, res) => {
  if (!await requireSiteAdmin(req, res)) return;
  if (!(req.get('If-Match') || req.body && req.body.if_match)) return api().fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when editing a notification.', { if_match: 'required' });
  await ensureSchema();
  try {
    const result = await connection().transaction(async manager => {
      const rows = await manager.query('SELECT * FROM site_notification WHERE id=? LIMIT 1 FOR UPDATE', [Number(req.params.id)]);
      if (!rows.length) throw Object.assign(new Error('Notification was not found.'), { statusCode: 404, code: 'NOTIFICATION_NOT_FOUND' });
      if (rows[0].status === 'published') throw Object.assign(new Error('已发布通知不能直接编辑，请新建通知。'), { statusCode: 409, code: 'NOTIFICATION_ALREADY_PUBLISHED' });
      const current = rows[0]; const currentResource = resource(current);
      if (!api().ifMatch(req, currentResource)) throw Object.assign(new Error('Notification changed. Reload it before saving.'), { statusCode: 412, code: 'ETAG_MISMATCH' });
      const checked = validate(req.body, current); if (Object.keys(checked.errors).length) throw Object.assign(new Error('Notification fields are invalid.'), { statusCode: 422, code: 'VALIDATION_FAILED', fields: checked.errors });
      const stamp = now(); await manager.query('UPDATE site_notification SET title=?,content=?,level=?,updated_by=?,updated_at=? WHERE id=?', [checked.value.title, checked.value.content, checked.value.level, res.locals.user.id, stamp, Number(req.params.id)]);
      const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'admin:notification.update', resourceType: 'site_notification', resourceId: Number(req.params.id), reason: reason(req, '编辑全站通知') }, manager);
      return { auditEventId };
    });
    res.locals.apiMeta.audit_event_id = result.auditEventId;
    return api().send(res, resource(await load(req.params.id, false)));
  } catch (error) { return api().fail(res, error.statusCode || 500, error.code || 'NOTIFICATION_UPDATE_FAILED', error.message || 'Notification could not be updated.', error.fields || {}); }
});

app.post('/api/v2/admin/notifications/:id/publish', async (req, res) => {
  if (!await requireSiteAdmin(req, res)) return;
  if (!(req.get('If-Match') || req.body && req.body.if_match)) return api().fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when publishing a notification.', { if_match: 'required' });
  await ensureSchema(); const stamp = now();
  try {
    const result = await connection().transaction(async manager => {
      const rows = await manager.query('SELECT * FROM site_notification WHERE id=? LIMIT 1 FOR UPDATE', [Number(req.params.id)]);
      if (!rows.length) throw Object.assign(new Error('Notification was not found.'), { statusCode: 404, code: 'NOTIFICATION_NOT_FOUND' });
      const current = rows[0]; if (!api().ifMatch(req, resource(current))) throw Object.assign(new Error('Notification changed. Reload it before publishing.'), { statusCode: 412, code: 'ETAG_MISMATCH' });
      if (current.status === 'published') return { already: true, id: Number(current.id) };
      await manager.query("UPDATE site_notification SET status='published',published_at=?,updated_by=?,updated_at=? WHERE id=?", [stamp, res.locals.user.id, stamp, Number(req.params.id)]);
      await insertRecipients(manager, current.id, current, res.locals.user.id, stamp);
      const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'admin:notification.publish', resourceType: 'site_notification', resourceId: Number(current.id), reason: reason(req, '发布全站通知') }, manager);
      return { id: Number(current.id), auditEventId };
    });
    if (!result.already) await api().appendEvent({ stream: `notifications:site:${result.id}`, type: 'site_notification.published', aggregateId: result.id, actor: res.locals.user, payload: { notification_id: result.id, audit_event_id: result.auditEventId } });
    res.locals.apiMeta.audit_event_id = result.auditEventId || null;
    res.locals.apiMeta.already_published = !!result.already;
    return api().send(res, resource(await load(result.id, false)));
  } catch (error) { return api().fail(res, error.statusCode || 500, error.code || 'NOTIFICATION_PUBLISH_FAILED', error.message || 'Notification could not be published.', error.fields || {}); }
});

ensureSchema().catch(error => syzoj.log(`[site-notification] schema initialization failed: ${error.stack || error.message}`));
