'use strict';

const crypto = require('crypto');
const fs = require('fs');
const TypeORM = require('typeorm');
const contentDomain = require('../libs/content-domain');

const DEFAULT_HELP = fs.readFileSync('/app/default-help.md', 'utf8');
const MAX_HELP_SIZE = 200 * 1024;
let helpSchemaPromise = null;

function ensureHelpSchema() {
  if (!helpSchemaPromise) {
    helpSchemaPromise = (async () => {
      const connection = TypeORM.getConnection();
      await connection.query(`
        CREATE TABLE IF NOT EXISTS site_help_page (
          id TINYINT NOT NULL,
          content MEDIUMTEXT NOT NULL,
          revision INT NOT NULL DEFAULT 1,
          updated_by INT NULL,
          updated_at INT NOT NULL,
          PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await connection.query(`
        CREATE TABLE IF NOT EXISTS site_help_page_history (
          id BIGINT NOT NULL AUTO_INCREMENT,
          revision INT NOT NULL,
          content MEDIUMTEXT NOT NULL,
          updated_by INT NULL,
          updated_at INT NOT NULL,
          archived_at INT NOT NULL,
          PRIMARY KEY (id),
          KEY idx_site_help_history_revision (revision)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await connection.query(
        `INSERT IGNORE INTO site_help_page (id,content,revision,updated_by,updated_at)
         VALUES (1,?,1,NULL,?)`,
        [DEFAULT_HELP, Math.floor(Date.now() / 1000)]
      );
    })().catch(error => {
      helpSchemaPromise = null;
      throw error;
    });
  }
  return helpSchemaPromise;
}

async function requireHelpAdmin(res, capability) {
  if (!res.locals.user || !await syzoj.utils.authorizationV2.authorize(res.locals.user, capability, null, { scope: 'global' })) {
    const error = new ErrorMessage('您没有权限管理帮助页。');
    error.statusCode = 403;
    throw error;
  }
}

function validAdminCsrf(req) {
  const expected = req.session && req.session.adminCsrfToken;
  const actual = req.body && req.body.csrf_token;
  return typeof expected === 'string' && typeof actual === 'string' && expected.length === actual.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

async function loadHelpPage() {
  await ensureHelpSchema();
  const rows = await TypeORM.getConnection().query(
    `SELECT page.content,page.revision,page.updated_by,page.updated_at,user.username AS updater_name
     FROM site_help_page page LEFT JOIN user ON user.id=page.updated_by WHERE page.id=1 LIMIT 1`
  );
  if (!rows.length) throw new Error('帮助页数据不存在。');
  return rows[0];
}

app.get('/help', async (req, res) => {
  try {
    const helpPage = await loadHelpPage();
    res.render('help', {
      helpPage,
      helpContentRendered: await syzoj.utils.markdown(helpPage.content || '')
    });
  } catch (error) {
    syzoj.log('[help-page] ' + (error.stack || error));
    res.status(500).render('error', { err: error });
  }
});

app.get('/admin/help', async (req, res) => {
  try {
    await requireHelpAdmin(res, 'admin:config.read');
    res.render('admin_help_edit', { helpPage: await loadHelpPage() });
  } catch (error) {
    if (!error.statusCode || error.statusCode >= 500) syzoj.log('[help-page] ' + (error.stack || error));
    res.status(error.statusCode || 500).render('error', { err: error });
  }
});


async function requireHelpCapability(res, capability) {
  const api = syzoj.utils.apiV2; const user = res.locals.user;
  if (!user) { api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); return false; }
  if (!await syzoj.utils.authorizationV2.authorize(user, capability, null, {})) { api.fail(res, 403, 'CAPABILITY_REQUIRED', `Capability required: ${capability}.`); return false; }
  return true;
}
function helpResource(row) { return { slug: 'main', content: row.content, revision: Number(row.revision), updated_by: row.updated_by == null ? null : Number(row.updated_by), updater_name: row.updater_name || null, updated_at: new Date(Number(row.updated_at) * 1000).toISOString() }; }

app.get('/api/v2/admin/help/pages', async (req, res) => {
  if (!await requireHelpCapability(res, 'admin:config.read')) return; const page = helpResource(await loadHelpPage()); syzoj.utils.apiV2.setResourceEtag(res, page); return syzoj.utils.apiV2.send(res, [page]);
});

app.get('/api/v2/admin/help/pages/:slug', async (req, res) => {
  if (!await requireHelpCapability(res, 'admin:config.read')) return; if (req.params.slug !== 'main') return syzoj.utils.apiV2.fail(res, 404, 'HELP_PAGE_NOT_FOUND', 'Help page was not found.'); const page = helpResource(await loadHelpPage()); syzoj.utils.apiV2.setResourceEtag(res, page); return syzoj.utils.apiV2.send(res, page);
});

app.put('/api/v2/admin/help/pages/:slug', async (req, res) => {
  const api = syzoj.utils.apiV2; if (!await requireHelpCapability(res, 'admin:config.write')) return; if (req.params.slug !== 'main') return api.fail(res, 404, 'HELP_PAGE_NOT_FOUND', 'Help page was not found.'); if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api.fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again or complete MFA before changing help content.');
  const content = String(req.body && req.body.content || '').trim(); const reason = syzoj.utils.operationReason(req, '更新帮助页'); if (!content) return api.fail(res, 422, 'VALIDATION_FAILED', 'Content is required.', { content: 'required' }); if (Buffer.byteLength(content, 'utf8') > MAX_HELP_SIZE) return api.fail(res, 413, 'REQUEST_BODY_TOO_LARGE', 'Help content cannot exceed 200 KiB.');
  const currentPage = helpResource(await loadHelpPage()); if (!req.get('If-Match')) return api.fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when updating help content.'); if (!api.ifMatch(req, currentPage)) return api.fail(res, 412, 'ETAG_MISMATCH', 'Help content changed. Reload it before saving.'); const now = Math.floor(Date.now() / 1000);
  try {
    await api.ensureFoundationSchema();
    const saved = await TypeORM.getConnection().transaction(async manager => { const rows = await manager.query('SELECT * FROM site_help_page WHERE id=1 FOR UPDATE'); const current = rows[0]; if (!current || Number(current.revision) !== currentPage.revision) { const error = new Error('Help content changed. Reload it before saving.'); error.code = 'ETAG_MISMATCH'; error.statusCode = 412; throw error; } await manager.query('INSERT INTO site_help_page_history (revision,content,updated_by,updated_at,archived_at) VALUES (?,?,?,?,?)', [current.revision, current.content, current.updated_by, current.updated_at, now]); await manager.query('UPDATE site_help_page SET content=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=1', [content, res.locals.user.id, now]); const next = { slug: 'main', content, revision: Number(current.revision) + 1, updated_by: Number(res.locals.user.id), updater_name: res.locals.user.username, updated_at: new Date(now * 1000).toISOString() }; const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'admin:help.update', resourceType: 'help_page', resourceId: 'main', reason, details: { from_revision: currentPage.revision, to_revision: next.revision, content_bytes: Buffer.byteLength(content, 'utf8') } }, manager); const eventId = await contentDomain.appendEvent(manager, { stream: 'content:help:main', type: 'help.updated', aggregateId: 'main', actorId: res.locals.user.id, payload: { revision: next.revision, audit_event_id: auditEventId } }); return { next, auditEventId, eventId }; });
    api.setResourceEtag(res, saved.next); return api.send(res, { ...saved.next, audit_event_id: saved.auditEventId, event_id: saved.eventId });
  } catch (error) {
    if (error.code === 'ETAG_MISMATCH') return api.fail(res, 412, error.code, error.message);
    syzoj.log('[help-page] API save failed: ' + (error.stack || error));
    return api.fail(res, 500, 'HELP_PAGE_UPDATE_FAILED', 'Help content could not be updated.');
  }
});

ensureHelpSchema().catch(error => {
  syzoj.log('[help-page] schema initialization failed: ' + (error.stack || error));
  process.exit(1);
});
