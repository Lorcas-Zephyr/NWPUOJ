const crypto = require('crypto');
const fs = require('fs');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SESSION_MAX_AGE = 12 * 60 * 60 * 1000;

function safeLocalUrl(value, fallback) {
  const url = String(value || '');
  return url.startsWith('/') && !url.startsWith('//') ? url : (fallback || '/');
}

function ensureCsrfToken(req) {
  if (!req.session.globalCsrfToken) {
    req.session.globalCsrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.globalCsrfToken;
}

function usesSecureCookies(req) {
  return process.env.SYZOJ_SECURE_COOKIES === 'true' || req.secure === true;
}

function secureCookieOptions(req) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: usesSecureCookies(req)
  };
}

function tokenMatches(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string' || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function isSameOrigin(req) {
  if (req.get('sec-fetch-site') === 'same-origin') return true;
  const source = req.get('origin') || req.get('referer');
  if (!source) return false;
  try {
    const sourceUrl = new URL(source);
    const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
    const protocol = forwardedProto || req.protocol;
    return sourceUrl.protocol === protocol + ':' && sourceUrl.host === req.get('host');
  } catch (error) {
    return false;
  }
}

syzoj.utils.safeLocalUrl = safeLocalUrl;
syzoj.utils.ensureGlobalCsrfToken = ensureCsrfToken;
syzoj.utils.secureCookieOptions = secureCookieOptions;
syzoj.utils.getPublicBaseUrl = function getPublicBaseUrl(req) {
  const configured = String(process.env.SYZOJ_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[^/]+$/i.test(configured)) return configured;
  return syzoj.utils.getCurrentLocation(req, true).replace(/\/+$/, '');
};
syzoj.utils.detectSafeRasterImage = function detectSafeRasterImage(filePath) {
  const header = Buffer.alloc(16);
  const fd = fs.openSync(filePath, 'r');
  let bytesRead;
  try {
    bytesRead = fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (bytesRead >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
  if (bytesRead >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytesRead >= 6 && ['GIF87a', 'GIF89a'].includes(header.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytesRead >= 12 && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
};

app.use((req, res, next) => {
  if (req.session && req.session.cookie) {
    req.session.cookie.httpOnly = true;
    req.session.cookie.sameSite = 'lax';
    req.session.cookie.secure = usesSecureCookies(req);
    req.session.cookie.maxAge = SESSION_MAX_AGE;
  }
  if (req.cookies && req.cookies.login) {
    res.clearCookie('login', secureCookieOptions(req));
  }
  next();
});

app.use((req, res, next) => {
  const expectedToken = ensureCsrfToken(req);
  res.locals.csrfToken = expectedToken;
  if (SAFE_METHODS.has(req.method)) return next();

  const actualToken = req.get('x-csrf-token') || (req.body && req.body._csrf);
  if (tokenMatches(expectedToken, actualToken) || isSameOrigin(req)) return next();

  const error = new ErrorMessage('请求来源验证失败，请刷新页面后重试。');
  if (/^\/api(?:\/|$)/.test(req.path) || req.accepts(['html', 'json']) === 'json') {
    return res.status(403).send({ error_code: 403, message: error.message });
  }
  res.status(403).render('error', { err: error });
});

app.get(['/login', '/sign_up'], (req, res, next) => {
  req.query.url = safeLocalUrl(req.query.url, '/');
  next();
});

app.post('/logout', (req, res, next) => {
  req.query.url = safeLocalUrl(req.query.url, '/');
  next();
});
