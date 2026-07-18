const crypto = require('crypto');
const TypeORM = require('typeorm');
const { sendSiteMail } = require('../libs/site-mail');

const User = syzoj.model('user');
const TOKEN_TTL_SECONDS = 24 * 60 * 60;
const RESEND_COOLDOWN_SECONDS = 60;
const TOKEN_VERSION = 1;

let schemaPromise = null;
function ensureEmailVerificationSchema() {
  if (!schemaPromise) {
    const connection = TypeORM.getConnection();
    schemaPromise = (async () => {
      await connection.query(
        'ALTER TABLE user_email_status ADD COLUMN IF NOT EXISTS verified_email VARCHAR(120) NULL AFTER is_email_verified'
      );
      await connection.query(
        'ALTER TABLE email_verification_token ADD COLUMN IF NOT EXISTS token_version TINYINT NOT NULL DEFAULT 0 AFTER purpose'
      );
      await connection.query(`
        UPDATE user_email_status s
        INNER JOIN user u ON u.id = s.user_id
        SET s.verified_email = LOWER(TRIM(u.email))
        WHERE s.is_email_verified = 1 AND (s.verified_email IS NULL OR s.verified_email = '')
      `);
      await connection.query(
        'DELETE FROM email_verification_token WHERE expires_at < ? AND used = 1',
        [Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60]
      );
    })().catch(error => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

ensureEmailVerificationSchema().catch(error => {
  syzoj.log('[email-verification] ' + (error.stack || error));
  process.exit(1);
});

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

async function deliverVerificationEmail(req, user, email, token) {
  const verifyUrl = syzoj.utils.getPublicBaseUrl(req) + '/email/verify/' + encodeURIComponent(token);
  const siteName = String(process.env.SYZOJ_WEB_SMTP_FROM_NAME || syzoj.config.title || 'Online Judge');
  await sendSiteMail({
    to: email,
    subject: `【${siteName}】请验证你的邮箱`,
    html: `<p>你好 <strong>${escapeHtml(user.username)}</strong>，</p>` +
      `<p>请点击下方链接验证邮箱：</p>` +
      `<p><a href="${escapeHtml(verifyUrl)}">${escapeHtml(verifyUrl)}</a></p>` +
      '<p>链接将在 24 小时后失效，且只能使用一次。</p>'
  });
}

async function reserveVerificationToken(userId, email) {
  const now = Math.floor(Date.now() / 1000);
  const token = crypto.randomBytes(32).toString('hex');
  const hash = tokenHash(token);
  const result = await TypeORM.getConnection().transaction(async manager => {
    await manager.query(
      `INSERT INTO user_email_status
        (user_id,is_email_verified,verified_email,verified_at,last_send_at)
       VALUES (?,0,NULL,NULL,NULL)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
      [userId]
    );
    const statusRows = await manager.query(
      'SELECT is_email_verified,verified_email,last_send_at FROM user_email_status WHERE user_id = ? FOR UPDATE',
      [userId]
    );
    const status = statusRows[0];
    if (status.is_email_verified && normalizeEmail(status.verified_email) === email) {
      return { alreadyVerified: true };
    }
    if (status.last_send_at && now - Number(status.last_send_at) < RESEND_COOLDOWN_SECONDS) {
      return { retryAfter: RESEND_COOLDOWN_SECONDS - (now - Number(status.last_send_at)) };
    }
    await manager.query(
      `UPDATE user_email_status
       SET is_email_verified = IF(verified_email = ?, is_email_verified, 0),
           verified_email = IF(verified_email = ?, verified_email, NULL),
           verified_at = IF(verified_email = ?, verified_at, NULL),
           last_send_at = ?
       WHERE user_id = ?`,
      [email, email, email, now, userId]
    );
    await manager.query(
      `UPDATE email_verification_token SET used = 1
       WHERE user_id = ? AND purpose = 'verify_email' AND token_version = ? AND used = 0`,
      [userId, TOKEN_VERSION]
    );
    await manager.query(
      `INSERT INTO email_verification_token
        (token,user_id,email,purpose,token_version,created_at,expires_at,used)
       VALUES (?,?,?,'verify_email',?,?,?,0)`,
      [hash, userId, email, TOKEN_VERSION, now, now + TOKEN_TTL_SECONDS]
    );
    return { token, tokenHash: hash, reservedAt: now };
  });
  return result;
}

async function sendEmailVerification(req, user) {
  await ensureEmailVerificationSchema();
  const email = normalizeEmail(user && user.email);
  if (!email) throw new ErrorMessage('您的账号没有邮箱地址，请先完善个人资料。');
  const reservation = await reserveVerificationToken(user.id, email);
  if (reservation.alreadyVerified) throw new ErrorMessage('您的邮箱已验证。');
  if (reservation.retryAfter) {
    throw new ErrorMessage(`请求过于频繁，请 ${reservation.retryAfter} 秒后重试。`);
  }
  try {
    await deliverVerificationEmail(req, user, email, reservation.token);
  } catch (error) {
    await TypeORM.getConnection().transaction(async manager => {
      await manager.query('DELETE FROM email_verification_token WHERE token = ?', [reservation.tokenHash]);
      await manager.query(
        'UPDATE user_email_status SET last_send_at = NULL WHERE user_id = ? AND last_send_at = ?',
        [user.id, reservation.reservedAt]
      );
    });
    throw error;
  }
  return email;
}

async function isEmailVerified(userId) {
  if (!userId) return false;
  await ensureEmailVerificationSchema();
  const rows = await TypeORM.getConnection().query(
    `SELECT s.user_id FROM user_email_status s
     INNER JOIN user u ON u.id = s.user_id
     WHERE s.user_id = ? AND s.is_email_verified = 1
       AND s.verified_email = LOWER(TRIM(u.email)) LIMIT 1`,
    [userId]
  );
  return rows.length > 0;
}

syzoj.utils.sendEmailVerification = sendEmailVerification;
syzoj.utils.isEmailVerified = isEmailVerified;
syzoj.utils.normalizeEmail = normalizeEmail;

app.post('/email/send-verification', async (req, res) => {
  try {
    if (!res.locals.user) throw new ErrorMessage('请登录后继续。');
    const email = await sendEmailVerification(req, res.locals.user);
    res.render('email_verify_pending', { email });
  } catch (error) {
    syzoj.log(error);
    res.status(error && error.code ? 500 : 400).render('error', { err: error });
  }
});

app.get('/email/verification-pending', async (req, res) => {
  if (!res.locals.user) {
    return res.redirect(syzoj.utils.makeUrl(['login'], { url: req.originalUrl }));
  }
  res.render('email_verify_pending', {
    email: normalizeEmail(res.locals.user.email),
    verificationEmailSent: req.query.sent !== '0',
    continueUrl: syzoj.utils.safeLocalUrl(req.session.postVerificationRedirect, '/')
  });
});

app.get('/email/verify/:token', async (req, res) => {
  try {
    await ensureEmailVerificationSchema();
    const rawToken = String(req.params.token || '');
    if (!/^[a-f0-9]{64}$/i.test(rawToken)) {
      return res.status(410).render('email_verify_result', {
        success: false,
        message: '此验证链接无效或已被使用。'
      });
    }
    const now = Math.floor(Date.now() / 1000);
    const outcome = await TypeORM.getConnection().transaction(async manager => {
      const records = await manager.query(
        `SELECT token,user_id,email FROM email_verification_token
         WHERE token = ? AND purpose = 'verify_email' AND token_version = ?
           AND used = 0 AND expires_at >= ? FOR UPDATE`,
        [tokenHash(rawToken), TOKEN_VERSION, now]
      );
      if (!records.length) return { success: false, message: '此验证链接无效、已过期或已被使用。' };
      const record = records[0];
      const users = await manager.query('SELECT email FROM user WHERE id = ? FOR UPDATE', [record.user_id]);
      if (!users.length || normalizeEmail(users[0].email) !== normalizeEmail(record.email)) {
        await manager.query('UPDATE email_verification_token SET used = 1 WHERE token = ?', [record.token]);
        return { success: false, message: '账号邮箱已变更，请重新发送验证邮件。' };
      }
      await manager.query(
        `INSERT INTO user_email_status
          (user_id,is_email_verified,verified_email,verified_at,last_send_at)
         VALUES (?,1,?,?,NULL)
         ON DUPLICATE KEY UPDATE is_email_verified=1,verified_email=VALUES(verified_email),verified_at=VALUES(verified_at)`,
        [record.user_id, normalizeEmail(record.email), now]
      );
      await manager.query(
        `UPDATE email_verification_token SET used = 1
         WHERE user_id = ? AND purpose = 'verify_email' AND token_version = ?`,
        [record.user_id, TOKEN_VERSION]
      );
      return { success: true, message: '邮箱验证成功。' };
    });
    if (outcome.success && syzoj.utils.refreshVerifiedCache) await syzoj.utils.refreshVerifiedCache();
    res.status(outcome.success ? 200 : 410).render('email_verify_result', outcome);
  } catch (error) {
    syzoj.log(error);
    res.status(410).render('email_verify_result', {
      success: false,
      message: error.message || '验证过程发生错误。'
    });
  }
});
