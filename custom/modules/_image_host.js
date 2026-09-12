'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const multer = require('multer');
const TypeORM = require('typeorm');

const IMAGE_HOST_DIR = '/app/static/self/image-assets';
const IMAGE_HOST_URL_PREFIX = '/self/image-assets/';
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const IMAGE_EXTENSIONS = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
});
let schemaPromise = null;

function api() { return syzoj.utils.apiV2; }

function ensureImageHostSchema() {
  if (!schemaPromise) {
    schemaPromise = TypeORM.getConnection().query(`
      CREATE TABLE IF NOT EXISTS image_host_asset (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        uploader_id INT NOT NULL,
        storage_name VARCHAR(255) NOT NULL UNIQUE,
        original_name VARCHAR(255) NOT NULL,
        mime_type VARCHAR(64) NOT NULL,
        file_size INT UNSIGNED NOT NULL,
        created_at DATETIME(3) NOT NULL,
        KEY idx_image_host_uploader_created (uploader_id, created_at, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `).catch(error => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

function isUnrestricted(user) {
  return !!(user && (user.is_admin || Number(user.id) === Number(syzoj.siteOwnerUserId || 0)));
}

async function canUseImageHost(user, req) {
  if (!user) return false;
  if (isUnrestricted(user)) return true;
  if (syzoj.utils.authorizationV2 && typeof syzoj.utils.authorizationV2.authorize === 'function') {
    return !!await syzoj.utils.authorizationV2.authorize(user, 'problem:edit', null, { req, scope: 'global' });
  }
  return typeof user.hasPrivilege === 'function' && !!await user.hasPrivilege('manage_problem');
}

async function requireImageHost(req, res, next) {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  try {
    if (!await canUseImageHost(user, req)) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: problem:edit.');
    return next();
  } catch (error) {
    return next(error);
  }
}

const imageUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_IMAGE_SIZE, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (ALLOWED_MIME.has(file.mimetype)) return callback(null, true);
    const error = new Error('仅支持 JPG、PNG、WebP 或 GIF 图片。');
    error.code = 'IMAGE_HOST_UNSUPPORTED_TYPE';
    return callback(error);
  }
}).single('image');

function receiveImage(req, res, next) {
  imageUpload(req, res, error => {
    if (!error) return next();
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 422;
    const code = error.code === 'LIMIT_FILE_SIZE' ? 'IMAGE_HOST_TOO_LARGE' : (error.code || 'IMAGE_HOST_UPLOAD_INVALID');
    return api().fail(res, status, code, error.code === 'LIMIT_FILE_SIZE' ? '图片不能超过 10 MiB。' : (error.message || '图片上传失败。'));
  });
}

function cleanup(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch (_) {}
}

function storedPath(storageName) {
  const value = String(storageName || '');
  const segments = value.split('/');
  if (!value || path.posix.isAbsolute(value) || value.includes('\\') || value.includes('\0') || segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
  return path.join(IMAGE_HOST_DIR, ...segments);
}

function publicUrl(req, storageName) {
  const relative = IMAGE_HOST_URL_PREFIX + String(storageName).split('/').map(encodeURIComponent).join('/');
  return `${syzoj.utils.getPublicBaseUrl(req)}${relative}`;
}

function resource(row, req) {
  const url = publicUrl(req, row.storage_name);
  return {
    id: Number(row.id),
    original_name: String(row.original_name),
    mime_type: String(row.mime_type),
    file_size: Number(row.file_size),
    created_at: api().databaseIso(row.created_at),
    url,
    relative_url: IMAGE_HOST_URL_PREFIX + encodeURIComponent(String(row.storage_name)),
    markdown: `![${String(row.original_name).replace(/[\[\]]/g, '')}](${url})`,
    uploader_id: Number(row.uploader_id)
  };
}

async function recordAudit(req, action, id, details, manager) {
  if (!syzoj.utils.authorizationV2 || typeof syzoj.utils.authorizationV2.recordAudit !== 'function') return null;
  return syzoj.utils.authorizationV2.recordAudit(req, {
    action,
    resourceType: 'image_host_asset',
    resourceId: id == null ? null : String(id),
    scope: 'global',
    reason: syzoj.utils.operationReason(req, action === 'image-host.delete' ? '删除图床图片' : '上传图床图片'),
    details: details || {}
  }, manager);
}

app.get('/image-host', async (req, res, next) => {
  try {
    if (!await canUseImageHost(res.locals.user, req)) return res.status(res.locals.user ? 403 : 401).render('error', { err: new ErrorMessage(res.locals.user ? '您没有题目管理权限。' : '请先登录。') });
    await ensureImageHostSchema();
    const rows = await TypeORM.getConnection().query(
      'SELECT id,uploader_id,storage_name,original_name,mime_type,file_size,created_at FROM image_host_asset WHERE uploader_id=? ORDER BY id DESC',
      [res.locals.user.id]
    );
    return res.render('image_host', { assets: rows.map(row => resource(row, req)) });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/v2/image-host', requireImageHost, async (req, res, next) => {
  try {
    await ensureImageHostSchema();
    const rows = await TypeORM.getConnection().query(
      'SELECT id,uploader_id,storage_name,original_name,mime_type,file_size,created_at FROM image_host_asset WHERE uploader_id=? ORDER BY id DESC',
      [res.locals.user.id]
    );
    const items = rows.map(row => resource(row, req));
    res.locals.apiMeta.count = items.length;
    return api().send(res, items);
  } catch (error) {
    return api().fail(res, 503, 'IMAGE_HOST_UNAVAILABLE', error.message || '图床暂时不可用。');
  }
});

app.post('/api/v2/image-host', requireImageHost, receiveImage, async (req, res, next) => {
  if (!req.file) return api().fail(res, 422, 'IMAGE_HOST_UPLOAD_INVALID', '请选择图片文件。', { image: 'required' });
  let targetPath = null;
  try {
    const detectedMime = syzoj.utils.detectSafeRasterImage(req.file.path);
    const extension = IMAGE_EXTENSIONS[detectedMime];
    if (!extension) return api().fail(res, 422, 'IMAGE_HOST_UNSAFE_CONTENT', '图片内容不是有效的 JPG、PNG、WebP 或 GIF。');
    fs.mkdirSync(IMAGE_HOST_DIR, { recursive: true });
    const storageName = `${crypto.randomUUID().replace(/-/g, '')}${extension}`;
    targetPath = storedPath(storageName);
    fs.copyFileSync(req.file.path, targetPath, fs.constants.COPYFILE_EXCL);
    await ensureImageHostSchema();
    if (syzoj.utils.authorizationV2 && typeof syzoj.utils.authorizationV2.ensureSchema === 'function') await syzoj.utils.authorizationV2.ensureSchema();
    const saved = await TypeORM.getConnection().transaction(async manager => {
      const result = await manager.query(
        `INSERT INTO image_host_asset (uploader_id,storage_name,original_name,mime_type,file_size,created_at)
         VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))`,
        [res.locals.user.id, storageName, String(req.file.originalname || 'image').slice(0, 255), detectedMime, Number(req.file.size || 0)]
      );
      const auditEventId = await recordAudit(req, 'image-host.upload', result.insertId, { mime_type: detectedMime, file_size: Number(req.file.size || 0) }, manager);
      const rows = await manager.query('SELECT id,uploader_id,storage_name,original_name,mime_type,file_size,created_at FROM image_host_asset WHERE id=? LIMIT 1', [result.insertId]);
      return { row: rows[0], auditEventId };
    });
    targetPath = null;
    const result = resource(saved.row, req);
    if (saved.auditEventId) res.set('X-Audit-Event-ID', String(saved.auditEventId));
    return api().send(res, { ...result, audit_event_id: saved.auditEventId }, 201);
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    return api().fail(res, status, error.code || 'IMAGE_HOST_UPLOAD_FAILED', error.message || '图片上传失败。', error.fields || {});
  } finally {
    cleanup(req.file && req.file.path);
    if (targetPath) cleanup(targetPath);
  }
});

app.delete('/api/v2/image-host/:id', requireImageHost, async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return api().fail(res, 422, 'VALIDATION_FAILED', 'A positive image ID is required.', { id: 'positive integer required' });
  try {
    await ensureImageHostSchema();
    const rows = await TypeORM.getConnection().query('SELECT id,uploader_id,storage_name FROM image_host_asset WHERE id=? LIMIT 1', [id]);
    if (!rows.length) return api().fail(res, 404, 'IMAGE_HOST_NOT_FOUND', 'Image was not found.');
    const asset = rows[0];
    if (!isUnrestricted(res.locals.user) && Number(asset.uploader_id) !== Number(res.locals.user.id)) {
      return api().fail(res, 403, 'IMAGE_HOST_FORBIDDEN', 'You can only delete images uploaded by yourself.');
    }
    await TypeORM.getConnection().transaction(async manager => {
      await manager.query('DELETE FROM image_host_asset WHERE id=?', [id]);
      await recordAudit(req, 'image-host.delete', id, { storage_name: asset.storage_name }, manager);
    });
    cleanup(storedPath(asset.storage_name));
    return api().send(res, { id, deleted: true });
  } catch (error) {
    return api().fail(res, Number.isInteger(error.statusCode) ? error.statusCode : 409, error.code || 'IMAGE_HOST_DELETE_FAILED', error.message || '图片删除失败。');
  }
});

try { fs.mkdirSync(IMAGE_HOST_DIR, { recursive: true }); } catch (_) {}
ensureImageHostSchema().catch(error => syzoj.log('[image-host] schema initialization failed: ' + (error.message || error)));

syzoj.utils.imageHost = { canUseImageHost, ensureImageHostSchema, publicUrl };
