const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const TypeORM = require('typeorm');
const { sendSiteMail } = require('../libs/site-mail');

const User = syzoj.model('user');
const CURRENT_PREFIX = 'bcrypt$';
const LEGACY_BCRYPT_PREFIX = 'bcrypt-md5$';
const LEGACY_MD5_PATTERN = /^[a-f0-9]{32}$/i;
const EMPTY_LEGACY_PASSWORD = '59cb65ba6f9ad18de0dcd12d5ae11bd2';
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 128;
const RESET_TOKEN_TTL = 60 * 60;
const LOGIN_FAILURE_WINDOW = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const loginFailures = new Map();
const BCRYPT_WORKER_COUNT = Math.min(16, Math.max(4, Number(process.env.SYZOJ_AUTH_VERIFY_WORKERS || 16)));

class BcryptWorkerPool {
  constructor(size) {
    this.workerPath = path.join(__dirname, '_password_verify_worker.js');
    this.workers = [];
    this.queue = [];
    this.nextId = 1;
    for (let i = 0; i < size; i++) this.spawn();
  }

  spawn() {
    const state = { worker: null, busy: false, task: null, failed: false };
    state.worker = new Worker(this.workerPath, { execArgv: [] });
    state.worker.on('message', message => {
      if (!state.task || state.task.id !== message.id) return;
      const task = state.task;
      state.task = null;
      state.busy = false;
      if (message.ok) task.resolve(message.value);
      else task.reject(new Error(message.error || 'bcrypt worker failed'));
      this.drain();
    });
    state.worker.on('error', error => {
      if (state.failed) return;
      state.failed = true;
      if (state.task) state.task.reject(error);
      state.task = null;
      state.busy = false;
      this.workers = this.workers.filter(item => item !== state);
      this.drain();
      this.spawn();
    });
    state.worker.on('exit', code => {
      if (code !== 0 && !state.failed) {
        state.failed = true;
        if (state.task) state.task.reject(new Error('bcrypt worker exited with code ' + code));
        state.task = null;
        state.busy = false;
        this.workers = this.workers.filter(item => item !== state);
        this.drain();
        this.spawn();
      }
    });
    this.workers.push(state);
  }

  run(operation, password, hash) {
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, operation, password, hash, resolve, reject });
      this.drain();
    });
  }

  drain() {
    for (const state of this.workers) {
      if (state.failed || state.busy || !this.queue.length) continue;
      state.task = this.queue.shift();
      state.busy = true;
      state.worker.postMessage({
        id: state.task.id,
        operation: state.task.operation,
        password: state.task.password,
        hash: state.task.hash
      });
    }
  }
}

const bcryptPool = new BcryptWorkerPool(BCRYPT_WORKER_COUNT);
syzoj.log('[auth-security] bcrypt worker pool initialized: ' + BCRYPT_WORKER_COUNT);

let resetTablePromise = null;
function ensureResetTable() {
  if (!resetTablePromise) {
    resetTablePromise = (async () => {
      const connection = TypeORM.getConnection();
      await connection.query(`
        CREATE TABLE IF NOT EXISTS account_password_reset (
          token_hash CHAR(64) NOT NULL,
          user_id INT NOT NULL,
          expires_at INT NOT NULL,
          consumed_at INT NULL,
          created_at INT NOT NULL,
          PRIMARY KEY (token_hash),
          KEY idx_account_password_reset_user (user_id),
          KEY idx_account_password_reset_expiry (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await connection.query(`
        CREATE TABLE IF NOT EXISTS auth_user_state (
          user_id INT NOT NULL PRIMARY KEY,
          status VARCHAR(24) NOT NULL DEFAULT 'active',
          reason VARCHAR(1000) NULL,
          changed_by INT NULL,
          changed_at DATETIME(3) NOT NULL,
          KEY idx_auth_user_state_status (status,changed_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    })().catch(error => {
      resetTablePromise = null;
      throw error;
    });
  }
  return resetTablePromise;
}

ensureResetTable().catch(error => {
  syzoj.log('[auth-security] ' + (error.stack || error));
  process.exit(1);
});

function legacyDigest(password) {
  return crypto.createHash('md5').update(password + 'syzoj2_xxx').digest('hex');
}

function safeEqual(left, right) {
  const first = Buffer.from(String(left));
  const second = Buffer.from(String(right));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function validateNewPassword(password) {
  const value = String(password || '');
  if (value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) {
    throw new ErrorMessage(`密码长度应为 ${PASSWORD_MIN_LENGTH} 至 ${PASSWORD_MAX_LENGTH} 个字符。`);
  }
  return value;
}

async function hashPassword(password) {
  return CURRENT_PREFIX + await bcryptPool.run('hash', validateNewPassword(password), null);
}

async function verifyPassword(password, storedPassword) {
  const supplied = String(password || '');
  const stored = String(storedPassword || '');
  if (stored.startsWith(CURRENT_PREFIX)) {
    return bcryptPool.run('compare', supplied, stored.slice(CURRENT_PREFIX.length));
  }
  if (stored.startsWith(LEGACY_BCRYPT_PREFIX)) {
    return bcryptPool.run('compare', legacyDigest(supplied), stored.slice(LEGACY_BCRYPT_PREFIX.length));
  }
  if (!LEGACY_MD5_PATTERN.test(stored) || stored === EMPTY_LEGACY_PASSWORD) return false;
  return safeEqual(legacyDigest(supplied), stored.toLowerCase());
}

function passwordNeedsUpgrade(storedPassword) {
  return !String(storedPassword || '').startsWith(CURRENT_PREFIX);
}

function isStoredPassword(value) {
  return String(value || '').startsWith(CURRENT_PREFIX);
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(error => error ? reject(error) : resolve());
  });
}

async function establishAuthenticatedSession(req, userId) {
  await regenerateSession(req);
  req.session.user_id = Number(userId);
  req.session.apiV2AuthenticatedAt = Date.now();
  if (typeof syzoj.utils.ensureGlobalCsrfToken === 'function') {
    syzoj.utils.ensureGlobalCsrfToken(req);
  }
}

async function revokeUserSessions(req, userId) {
  const storePath = req.sessionStore && req.sessionStore.options && req.sessionStore.options.path;
  if (!storePath) return;
  let files;
  try {
    files = await fs.promises.readdir(storePath);
  } catch (error) {
    syzoj.log('[auth-security] list sessions failed: ' + error.message);
    return;
  }
  await Promise.all(files.filter(file => file.endsWith('.json')).map(async file => {
    const filePath = path.join(storePath, file);
    try {
      const session = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
      if (Number(session.user_id) === Number(userId)) await fs.promises.unlink(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') syzoj.log('[auth-security] revoke session failed: ' + error.message);
    }
  }));
}

async function getUserAccountState(userId) {
  await ensureResetTable();
  const rows = await TypeORM.getConnection().query(
    'SELECT status,reason,changed_by,changed_at FROM auth_user_state WHERE user_id=? LIMIT 1',
    [Number(userId)]
  );
  return rows[0] || { status: 'active', reason: null, changed_by: null, changed_at: null };
}

async function isUserAccountActive(userId) {
  return (await getUserAccountState(userId)).status !== 'disabled';
}

function clearLegacyLoginCookie(req, res) {
  res.clearCookie('login', syzoj.utils.secureCookieOptions(req));
}

function loginFailureKey(req, username) {
  return `${req.ip}|${String(username || '').trim().toLowerCase()}`;
}

function loginIsBlocked(key) {
  const state = loginFailures.get(key);
  if (!state) return false;
  if (Date.now() - state.startedAt >= LOGIN_FAILURE_WINDOW) {
    loginFailures.delete(key);
    return false;
  }
  return state.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(key) {
  const state = loginFailures.get(key);
  if (!state || Date.now() - state.startedAt >= LOGIN_FAILURE_WINDOW) {
    loginFailures.set(key, { count: 1, startedAt: Date.now() });
  } else {
    state.count += 1;
  }
}

function resetTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function validResetToken(token) {
  return /^[a-f0-9]{64}$/i.test(String(token || ''));
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

syzoj.utils.hashPassword = hashPassword;
syzoj.utils.verifyPassword = verifyPassword;
syzoj.utils.validateNewPassword = validateNewPassword;
syzoj.utils.passwordNeedsUpgrade = passwordNeedsUpgrade;
syzoj.utils.isStoredPassword = isStoredPassword;
syzoj.utils.establishAuthenticatedSession = establishAuthenticatedSession;
syzoj.utils.revokeUserSessions = revokeUserSessions;
syzoj.utils.clearLegacyLoginCookie = clearLegacyLoginCookie;
syzoj.utils.ensureAccountStateSchema = ensureResetTable;
syzoj.utils.getUserAccountState = getUserAccountState;
syzoj.utils.isUserAccountActive = isUserAccountActive;

app.use(async (req, res, next) => {
  if (!res.locals.user) return next();
  try {
    const state = await getUserAccountState(res.locals.user.id);
    if (state.status !== 'disabled') return next();
    const disabledUserId = Number(res.locals.user.id);
    res.locals.user = null;
    if (req.session) delete req.session.user_id;
    clearLegacyLoginCookie(req, res);
    const error = new ErrorMessage('账号已停用，请联系管理员。');
    error.statusCode = 403;
    error.code = 'ACCOUNT_DISABLED';
    if (req.path.startsWith('/api/v2/') && syzoj.utils.apiV2) {
      return syzoj.utils.apiV2.fail(res, 403, 'ACCOUNT_DISABLED', 'This account has been disabled.', { user_id: disabledUserId });
    }
    return res.status(403).render('error', { err: error });
  } catch (error) {
    syzoj.log('[auth-security] account state check failed: ' + (error.stack || error.message));
    return next(error);
  }
});

app.use(async (req, res, next) => {
  clearLegacyLoginCookie(req, res);
  if (!req.cookies || !req.cookies.login || !res.locals.user) return next();
  const stored = String(res.locals.user.password || '');
  if (!LEGACY_MD5_PATTERN.test(stored)) return next();
  try {
    const migrated = LEGACY_BCRYPT_PREFIX + await bcryptPool.run('hash', stored.toLowerCase(), null);
    const result = await TypeORM.getConnection().query(
      'UPDATE user SET password = ? WHERE id = ? AND password = ?',
      [migrated, res.locals.user.id, stored]
    );
    if (result && result.affectedRows) res.locals.user.password = migrated;
    next();
  } catch (error) {
    next(error);
  }
});



app.get('/password/reset/:token', async (req, res) => {
  try {
    await ensureResetTable();
    const token = String(req.params.token || '');
    if (!validResetToken(token)) throw new ErrorMessage('密码重置链接无效或已过期。');
    const rows = await TypeORM.getConnection().query(
      `SELECT token_hash FROM account_password_reset
       WHERE token_hash = ? AND consumed_at IS NULL AND expires_at >= ? LIMIT 1`,
      [resetTokenHash(token), Math.floor(Date.now() / 1000)]
    );
    if (!rows.length) throw new ErrorMessage('密码重置链接无效或已过期。');
    res.render('forget_confirm', { token });
  } catch (error) {
    res.status(410).render('error', { err: error });
  }
});
