let HomepageBanner = syzoj.model('homepage-banner');
let User = syzoj.model('user');
let fs = require('fs');
let path = require('path');
let crypto = require('crypto');
let os = require('os');
let multer = require('multer');
let TypeORM = require('typeorm');
let contentDomain = require('../libs/content-domain');

const BANNER_UPLOAD_DIR = '/app/static/self/banner';
const MAX_BANNER_SIZE = 5 * 1024 * 1024;  // 5MB
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const IMAGE_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
};
const bannerUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_BANNER_SIZE, files: 1 },
  fileFilter: (req, file, callback) => {
    if (ALLOWED_MIME.includes(file.mimetype)) return callback(null, true);
    const error = new Error('仅支持 JPG / PNG / WebP / GIF 格式。');
    error.code = 'UNSAFE_FILE_TYPE';
    callback(error);
  }
}).single('image');

try { fs.mkdirSync(BANNER_UPLOAD_DIR, { recursive: true }); } catch (e) {}

// ============ 校验工具 ============
function sanitizeLinkUrl(url) {
  if (!url) return null;
  url = url.trim();
  if (!url) return null;
  // 只允许 http://, https://, 或相对路径 /
  if (url.startsWith('http://') || url.startsWith('https://') || (url.startsWith('/') && !url.startsWith('//'))) {
    return url.substring(0, 500);
  }
  return null;
}

async function canManageBanners(user) {
  return !!(user && await syzoj.utils.authorizationV2.authorize(user, 'announcement:manage', null, {}));
}

async function requireBannerAdmin(req, res, next) {
  if (!await canManageBanners(res.locals.user)) return res.status(403).render('error', { err: new ErrorMessage('您没有权限。') });
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return res.status(403).render('error', { err: new ErrorMessage('此操作需要重新登录或完成二次验证。') });
  next();
}

function receiveBanner(req, res, next) {
  bannerUpload(req, res, error => {
    if (!error) return next();
    const message = error.code === 'LIMIT_FILE_SIZE' ? '图片不能超过 5MB。' : (error.message || '图片上传失败。');
    res.status(400).render('error', { err: new ErrorMessage(message) });
  });
}

function legacyChangeReason(req, fallback) {
  return String(req.body && req.body.reason || fallback).trim().slice(0, 1000);
}

function requireBannerAdminCsrf(req) {
  const expected = req.session && req.session.adminCsrfToken;
  const actual = req.body && req.body.csrf_token;
  const valid = typeof expected === 'string' && typeof actual === 'string' && expected.length === actual.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  if (!valid) {
    const error = new ErrorMessage('页面已失效，请刷新后重试。');
    error.statusCode = 403;
    throw error;
  }
}

async function contentTransaction(work) {
  await syzoj.utils.apiV2.ensureFoundationSchema();
  return TypeORM.getConnection().transaction(work);
}

function auditRecorder(req) {
  return (event, manager) => syzoj.utils.authorizationV2.recordAudit(req, event, manager);
}

function bannerInputError(message) {
  const error = new ErrorMessage(message);
  error.statusCode = 400;
  return error;
}

// ============ admin: banner 管理列表 ============
app.get('/admin/banners', async (req, res) => {
  try {
    if (!await canManageBanners(res.locals.user)) throw new ErrorMessage('您没有权限。');
    let banners = await HomepageBanner.queryAll(HomepageBanner.createQueryBuilder()
      .orderBy('sort_order', 'DESC')
      .addOrderBy('id', 'DESC'));
    for (let b of banners) {
      if (b.created_by) b.creator = await User.findById(b.created_by);
    }
    res.render('admin_banners', { banners: banners });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ admin: 上传新 banner ============

// ============ admin: 编辑 banner(标题/链接/排序/启用) ============

// ============ admin: 删除 banner(同时删图片文件) ============
