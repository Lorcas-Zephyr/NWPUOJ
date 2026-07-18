const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const TypeORM = require('typeorm');

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
  return !!(actor.is_admin || await actor.hasPrivilege('manage_user'));
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

async function updateAvatar(userId, file) {
  const detectedMime = syzoj.utils.detectSafeRasterImage(file.path);
  if (!detectedMime || !ALLOWED_MIME.has(detectedMime)) {
    throw Object.assign(new ErrorMessage('图片内容不是有效的 JPG、PNG 或 WebP。'), { statusCode: 400 });
  }
  const extension = IMAGE_EXTENSIONS[detectedMime];
  const filename = `${userId}-${crypto.randomBytes(16).toString('hex')}${extension}`;
  const targetPath = path.join(AVATAR_DIR, filename);
  const imagePath = AVATAR_URL_PREFIX + filename;
  let previousPath = null;
  try {
    fs.copyFileSync(file.path, targetPath);
    await TypeORM.getConnection().transaction(async manager => {
      const previous = await manager.query('SELECT image_path FROM user_avatar WHERE user_id=? FOR UPDATE', [userId]);
      previousPath = previous.length ? storedFilePath(previous[0].image_path) : null;
      await manager.query(
        `INSERT INTO user_avatar (user_id,image_path,updated_at) VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE image_path=VALUES(image_path),updated_at=VALUES(updated_at)`,
        [userId, imagePath, Math.floor(Date.now() / 1000)]
      );
    });
    cleanupFile(previousPath);
    await refreshAvatarCache();
  } catch (error) {
    cleanupFile(targetPath);
    throw error;
  } finally {
    cleanupFile(file.path);
  }
}

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

app.post('/user/:id/avatar', receiveAvatar, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const actor = res.locals.user;
    if (!Number.isSafeInteger(targetId) || targetId <= 0 || !await canManageAvatar(actor, targetId)) {
      throw Object.assign(new ErrorMessage('您没有权限修改该用户的头像。'), { statusCode: 403 });
    }
    if (!validAvatarCsrfToken(req)) {
      throw Object.assign(new ErrorMessage('页面已失效，请刷新资料编辑页后重试。'), { statusCode: 403 });
    }
    if (!req.file) throw Object.assign(new ErrorMessage('请选择要上传的头像。'), { statusCode: 400 });
    if (!await User.findById(targetId)) throw Object.assign(new ErrorMessage('用户不存在。'), { statusCode: 404 });
    await updateAvatar(targetId, req.file);
    res.redirect(303, syzoj.utils.makeUrl(['user', targetId, 'edit'], { avatar: 'uploaded' }));
  } catch (error) {
    cleanupFile(req.file && req.file.path);
    syzoj.log('[user-avatar] ' + errorText(error));
    res.status(error.statusCode || 400).render('error', { err: error });
  }
});

app.post('/user/:id/avatar/delete', async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const actor = res.locals.user;
    if (!Number.isSafeInteger(targetId) || targetId <= 0 || !await canManageAvatar(actor, targetId)) {
      throw Object.assign(new ErrorMessage('您没有权限修改该用户的头像。'), { statusCode: 403 });
    }
    if (!validAvatarCsrfToken(req)) {
      throw Object.assign(new ErrorMessage('页面已失效，请刷新资料编辑页后重试。'), { statusCode: 403 });
    }
    const rows = await TypeORM.getConnection().query('SELECT image_path FROM user_avatar WHERE user_id=? LIMIT 1', [targetId]);
    await TypeORM.getConnection().query('DELETE FROM user_avatar WHERE user_id=?', [targetId]);
    cleanupFile(rows.length ? storedFilePath(rows[0].image_path) : null);
    await refreshAvatarCache();
    res.redirect(303, syzoj.utils.makeUrl(['user', targetId, 'edit'], { avatar: 'removed' }));
  } catch (error) {
    syzoj.log('[user-avatar] ' + errorText(error));
    res.status(error.statusCode || 400).render('error', { err: error });
  }
});

ensureAvatarSchema().catch(error => {
  syzoj.log('[user-avatar] schema initialization failed: ' + errorText(error));
  process.exit(1);
});
