const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const TypeORM = require('typeorm');
const contentDomain = require('../libs/content-domain');

const User = syzoj.model('user');
const AVATAR_DIR = '/app/static/self/avatar';
const AVATAR_URL_PREFIX = '/self/avatar/';
const DEFAULT_AVATAR = '/self/logo.png';
const MAX_AVATAR_SIZE = 2 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const IMAGE_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp'
};

let schemaPromise = null;
let avatarCache = new Map();
let avatarEmailCache = new Map();

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

function ensureAvatarSchema() {
  if (!schemaPromise) {
    schemaPromise = TypeORM.getConnection().query(`
      CREATE TABLE IF NOT EXISTS user_avatar (
        user_id INT NOT NULL,
        image_path VARCHAR(255) NOT NULL,
        updated_at INT NOT NULL,
        PRIMARY KEY (user_id),
        KEY idx_user_avatar_updated_at (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `).then(() => refreshAvatarCache()).catch(error => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function refreshAvatarCache() {
  const rows = await TypeORM.getConnection().query(
    `SELECT avatar.user_id,avatar.image_path,avatar.updated_at,user.email
     FROM user_avatar avatar INNER JOIN user ON user.id=avatar.user_id`
  );
  const nextById = new Map();
  const nextByEmail = new Map();
  for (const row of rows) {
    const record = {
      path: String(row.image_path),
      updatedAt: Number(row.updated_at || 0)
    };
    nextById.set(Number(row.user_id), record);
    nextByEmail.set(String(row.email || '').toLowerCase(), record);
  }
  avatarCache = nextById;
  avatarEmailCache = nextByEmail;
}

function appendVersion(url, updatedAt) {
  return `${url}?v=${encodeURIComponent(updatedAt || 'local')}`;
}

function avatarUrl(userOrEmail) {
  let record = null;
  if (userOrEmail && typeof userOrEmail === 'object') {
    record = avatarCache.get(Number(userOrEmail.id));
  } else if (Number.isSafeInteger(Number(userOrEmail)) && Number(userOrEmail) > 0) {
    record = avatarCache.get(Number(userOrEmail));
  } else {
    record = avatarEmailCache.get(String(userOrEmail || '').toLowerCase());
  }
  return record ? appendVersion(record.path, record.updatedAt) : appendVersion(DEFAULT_AVATAR, 'default-1');
}

function hasCustomAvatar(userOrId) {
  const id = userOrId && typeof userOrId === 'object' ? userOrId.id : userOrId;
  return avatarCache.has(Number(id));
}

syzoj.utils.avatar = avatarUrl;
syzoj.utils.hasCustomAvatar = hasCustomAvatar;
syzoj.utils.refreshAvatarCache = refreshAvatarCache;
// Keep native and third-party templates on the same local-only avatar source.
syzoj.utils.gravatar = avatarUrl;
syzoj.utils.ensureAvatarSchema = ensureAvatarSchema;

try { fs.mkdirSync(AVATAR_DIR, { recursive: true }); } catch (error) {}

const avatarUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_AVATAR_SIZE, files: 1 },
  fileFilter: (req, file, callback) => {
    if (ALLOWED_MIME.has(file.mimetype)) return callback(null, true);
    const error = new Error('仅支持 JPG、PNG 或 WebP 格式。');
    error.code = 'UNSAFE_FILE_TYPE';
    callback(error);
  }
}).single('avatar');

function receiveAvatar(req, res, next) {
  avatarUpload(req, res, error => {
    if (!error) return next();
    const message = error.code === 'LIMIT_FILE_SIZE' ? '头像不能超过 2MB。' : (error.message || '头像上传失败。');
    res.status(400).render('error', { err: new ErrorMessage(message) });
  });
}

function receiveAvatarApi(req, res, next) {
  avatarUpload(req, res, error => {
    if (!error) return next();
    const message = error.code === 'LIMIT_FILE_SIZE' ? '头像不能超过 2 MiB。' : (error.message || '头像上传失败。');
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 422;
    return syzoj.utils.apiV2.fail(res, status, error.code === 'LIMIT_FILE_SIZE' ? 'AVATAR_TOO_LARGE' : 'AVATAR_UPLOAD_INVALID', message);
  });
}

function ensureAvatarCsrfToken(req) {
  if (!req.session.avatarCsrfToken) req.session.avatarCsrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.avatarCsrfToken;
}

function validAvatarCsrfToken(req) {
  const expected = req.session && req.session.avatarCsrfToken;
  const actual = req.body && req.body.avatar_csrf_token;
  return typeof expected === 'string' && typeof actual === 'string' && expected.length === actual.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

async function canManageAvatar(actor, targetId) {
  if (!actor) return false;
  if (Number(syzoj.deletedAccountUserId || 0) === Number(targetId)) return false;
  if (Number(actor.id) === Number(targetId)) return true;
  if (Number(syzoj.siteOwnerUserId || 0) === Number(targetId)) return false;
  return syzoj.utils.authorizationV2.authorize(actor, 'admin:user.manage', {
    id: Number(targetId),
    scope: `user:${targetId}`
  }, { scope: 'global' });
}

async function recordAvatarChange(manager, req, targetId, kind) {
  const actor = req.res.locals.user;
  const administrative = Number(actor.id) !== Number(targetId);
  const reason = administrative ? syzoj.utils.operationReason(req, kind === 'updated' ? '代用户上传头像' : '代用户恢复默认头像') : '';
  const auditEventId = administrative ? await syzoj.utils.authorizationV2.recordAudit(req, {
    action: kind === 'updated' ? 'admin:user.avatar.update' : 'admin:user.avatar.delete',
    resourceType: 'user',
    resourceId: targetId,
    scope: `user:${targetId}`,
    reason
  }, manager) : null;
  const eventId = await contentDomain.appendEvent(manager, {
    stream: `user:${targetId}`,
    type: `user.avatar.${kind}`,
    aggregateId: targetId,
    actorId: actor.id,
    payload: { user_id: targetId, administrative, audit_event_id: auditEventId }
  });
  return { auditEventId, eventId };
}

function cleanupFile(filePath) {
  if (filePath) {
    try { fs.unlinkSync(filePath); } catch (error) {}
  }
}

function storedFilePath(imagePath) {
  if (!String(imagePath || '').startsWith(AVATAR_URL_PREFIX)) return null;
  const filename = path.basename(String(imagePath));
  if (!filename || filename === '.' || filename === '..') return null;
  return path.join(AVATAR_DIR, filename);
}

async function updateAvatar(userId, file, req) {
  const detectedMime = syzoj.utils.detectSafeRasterImage(file.path);
  if (!detectedMime || !ALLOWED_MIME.has(detectedMime)) {
    throw Object.assign(new ErrorMessage('图片内容不是有效的 JPG、PNG 或 WebP。'), { statusCode: 400 });
  }
  const extension = IMAGE_EXTENSIONS[detectedMime];
  const filename = `${userId}-${crypto.randomBytes(16).toString('hex')}${extension}`;
  const targetPath = path.join(AVATAR_DIR, filename);
  const imagePath = AVATAR_URL_PREFIX + filename;
  let previousPath = null;
  let event = null;
  try {
    fs.copyFileSync(file.path, targetPath, fs.constants.COPYFILE_EXCL);
    await TypeORM.getConnection().transaction(async manager => {
      const previous = await manager.query('SELECT image_path FROM user_avatar WHERE user_id=? FOR UPDATE', [userId]);
      previousPath = previous.length ? storedFilePath(previous[0].image_path) : null;
      await manager.query(
        `INSERT INTO user_avatar (user_id,image_path,updated_at) VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE image_path=VALUES(image_path),updated_at=VALUES(updated_at)`,
        [userId, imagePath, Math.floor(Date.now() / 1000)]
      );
      event = await recordAvatarChange(manager, req, userId, 'updated');
    });
    cleanupFile(previousPath);
    await refreshAvatarCache();
  } catch (error) {
    cleanupFile(targetPath);
    throw error;
  } finally {
    cleanupFile(file.path);
  }
  return { imagePath, auditEventId: event && event.auditEventId, eventId: event && event.eventId };
}

async function removeAvatar(userId, req) {
  let previousPath = null;
  let event = null;
  await TypeORM.getConnection().transaction(async manager => {
    const rows = await manager.query('SELECT image_path FROM user_avatar WHERE user_id=? LIMIT 1 FOR UPDATE', [userId]);
    previousPath = rows.length ? storedFilePath(rows[0].image_path) : null;
    await manager.query('DELETE FROM user_avatar WHERE user_id=?', [userId]);
    event = await recordAvatarChange(manager, req, userId, 'removed');
  });
  cleanupFile(previousPath);
  await refreshAvatarCache();
  return { auditEventId: event && event.auditEventId, eventId: event && event.eventId };
}

syzoj.utils.userAvatarV2 = {
  canManageAvatar,
  cleanupFile,
  receiveAvatarApi,
  removeAvatar,
  updateAvatar
};

app.use(async (req, res, next) => {
  try {
    await ensureAvatarSchema();
    if (req.path === '/user/' + String(req.params.id || '') + '/edit' || /^\/user\/\d+\/edit\/?$/.test(req.path)) {
      res.locals.avatarCsrfToken = res.locals.user ? ensureAvatarCsrfToken(req) : null;
    }
    next();
  } catch (error) {
    next(error);
  }
});



ensureAvatarSchema().catch(error => {
  syzoj.log('[user-avatar] schema initialization failed: ' + errorText(error));
  process.exit(1);
});
