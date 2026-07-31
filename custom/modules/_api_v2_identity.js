const TypeORM = require('typeorm');
const crypto = require('crypto');
const { sendSiteMail } = require('../libs/site-mail');
const contentDomain = require('../libs/content-domain');
const User = syzoj.model('user');

const loginFailures = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const MFA_TTL_SECONDS = 10 * 60;
const RESET_TTL_SECONDS = 60 * 60;
const mfaHmacKey = process.env.SYZOJ_AUTH_MFA_SECRET || crypto.randomBytes(32).toString('hex');
let identitySchemaPromise = null;

function ensureIdentitySchema() {
  if (identitySchemaPromise) return identitySchemaPromise;
  identitySchemaPromise = TypeORM.getConnection().query(`CREATE TABLE IF NOT EXISTS auth_mfa_challenge (
    id CHAR(36) NOT NULL PRIMARY KEY, user_id INT NOT NULL, code_hash CHAR(64) NOT NULL,
    state VARCHAR(20) NOT NULL DEFAULT 'pending', attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    expires_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL, verified_at DATETIME(3) NULL,
    KEY idx_auth_mfa_user(user_id,created_at), KEY idx_auth_mfa_expiry(state,expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(error => { identitySchemaPromise = null; throw error; });
  return identitySchemaPromise;
}

function api() { return syzoj.utils.apiV2; }
function loginKey(req, username) { return `${req.ip || 'unknown'}:${String(username || '').trim().toLowerCase()}`; }
function loginBlocked(key) {
  const state = loginFailures.get(key);
  if (!state || state.resetAt <= Date.now()) { loginFailures.delete(key); return false; }
  return state.count >= LOGIN_MAX_FAILURES;
}
function recordFailure(key) {
  const current = loginFailures.get(key);
  if (!current || current.resetAt <= Date.now()) loginFailures.set(key, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  else current.count += 1;
}
function publicMe(user) {
  return {
    id: Number(user.id),
    username: user.username,
    email: user.email || null,
    email_verified: !!user.is_email_verified,
    information: user.information || '',
    sex: user.sex || '',
    public_email: !!user.public_email,
    prefer_formatted_code: !!user.prefer_formatted_code,
    rating: Number(user.rating || 1500),
    registered_at: user.register_time ? new Date(Number(user.register_time) * 1000).toISOString() : null
  };
}
async function publicMeWithIdentity(user) {
  const identity = syzoj.utils.registrationIdentityV2;
  return {
    ...publicMe(user),
    identity: identity.profileResource(await identity.findProfile(user.id))
  };
}
function booleanInput(value, fallback) {
  if (value == null) return fallback;
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}
function profileFailure(res, error) {
  const registrationCode = Number(error && error.registrationCode);
  if (registrationCode === 2011) return api().fail(res, 422, 'VALIDATION_FAILED', error.message, { student_id: 'invalid' });
  if (registrationCode === 2012) return api().fail(res, 422, 'VALIDATION_FAILED', error.message, { real_name: 'invalid' });
  if (registrationCode === 2013) return api().fail(res, 422, 'VALIDATION_FAILED', error.message, { college: 'invalid' });
  if (registrationCode === 2014) return api().fail(res, 409, 'STUDENT_ID_ALREADY_USED', error.message, { student_id: 'already used' });
  if (registrationCode === 2017) return api().fail(res, 409, 'IDENTITY_PROFILE_LOCKED', error.message);
  if (error && error.code === 'ER_DUP_ENTRY') {
    const field = /student/i.test(String(error.message || '')) ? 'student_id' : 'email';
    return api().fail(res, 409, field === 'student_id' ? 'STUDENT_ID_ALREADY_USED' : 'EMAIL_ALREADY_USED', field === 'student_id' ? 'This student ID is already in use.' : 'This email address is already in use.', { [field]: 'already used' });
  }
  if (error && error.code === 'ETAG_MISMATCH') return api().fail(res, 412, error.code, error.message);
  syzoj.log('[identity-v2] profile update failed: ' + (error && (error.stack || error.message) || error));
  return api().fail(res, 500, 'CONTENT_WRITE_FAILED', 'The profile could not be updated.');
}
function destroySession(req) {
  return new Promise((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve()));
}
function mfaHash(challengeId, code) { return crypto.createHmac('sha256', mfaHmacKey).update(`${challengeId}:${code}`).digest('hex'); }
function safeEqual(left, right) {
  const first = Buffer.from(String(left)); const second = Buffer.from(String(right));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}
function maskEmail(value) {
  const [name, domain] = String(value || '').split('@');
  if (!name || !domain) return null;
  return `${name.slice(0, 2)}***@${domain}`;
}
function resetHash(token) { return crypto.createHash('sha256').update(String(token || '')).digest('hex'); }
function validResetToken(token) { return /^[a-f0-9]{64}$/i.test(String(token || '')); }
function escapeHtml(value) { return String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }

app.post('/api/v2/auth/login', async (req, res) => {
  const username = String(req.body && req.body.username || '').trim();
  const password = String(req.body && req.body.password || '');
  const key = loginKey(req, username);
  if (!username || !password) return api().fail(res, 422, 'VALIDATION_FAILED', 'Username and password are required.', { username: !username ? 'required' : undefined, password: !password ? 'required' : undefined });
  if (loginBlocked(key)) return api().fail(res, 429, 'LOGIN_RATE_LIMITED', 'Too many failed sign-in attempts. Try again later.');
  try {
    const user = await User.fromName(username);
    if (!user || !await syzoj.utils.verifyPassword(password, user.password)) {
      recordFailure(key);
      return api().fail(res, 401, 'INVALID_CREDENTIALS', 'The username or password is incorrect.');
    }
    if (syzoj.utils.isUserAccountActive && !await syzoj.utils.isUserAccountActive(user.id)) {
      return api().fail(res, 403, 'ACCOUNT_DISABLED', 'This account has been disabled. Contact an administrator.');
    }
    if (syzoj.utils.isTemporaryAccountLoginAllowed && !await syzoj.utils.isTemporaryAccountLoginAllowed(user.id)) {
      recordFailure(key);
      return api().fail(res, 401, 'INVALID_CREDENTIALS', 'The username or password is incorrect.');
    }
    if (syzoj.utils.passwordNeedsUpgrade(user.password)) {
      user.password = await syzoj.utils.hashPassword(password);
      await user.save();
    }
    loginFailures.delete(key);
    await syzoj.utils.establishAuthenticatedSession(req, user.id);
    syzoj.utils.clearLegacyLoginCookie(req, res);
    res.locals.user = user;
    await syzoj.utils.authorizationV2.recordAudit(req, { action: 'auth:login', resourceType: 'user', resourceId: user.id });
    return api().send(res, { authenticated: true, user: publicMe(user) });
  } catch (error) {
    syzoj.log('[identity-v2] login failed: ' + (error.stack || error.message));
    return api().fail(res, 503, 'AUTHENTICATION_UNAVAILABLE', 'Sign-in is temporarily unavailable.');
  }
});

app.post('/api/v2/auth/logout', async (req, res) => {
  const user = res.locals.user;
  if (user) await syzoj.utils.authorizationV2.recordAudit(req, { action: 'auth:logout', resourceType: 'user', resourceId: user.id });
  await destroySession(req);
  res.clearCookie('connect.sid', { path: '/', httpOnly: true, sameSite: 'lax', secure: req.secure });
  syzoj.utils.clearLegacyLoginCookie(req, res);
  if (req.accepts && req.accepts('html') && !req.is('application/json')) {
    return res.redirect(303, syzoj.utils.makeUrl(['login']));
  }
  return api().send(res, { authenticated: false });
});

app.post('/api/v2/auth/mfa/challenge', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!user.email || !user.is_email_verified) return api().fail(res, 409, 'VERIFIED_EMAIL_REQUIRED', 'Verify an email address before using email MFA.');
  await ensureIdentitySchema();
  const recent = await TypeORM.getConnection().query('SELECT created_at FROM auth_mfa_challenge WHERE user_id=? ORDER BY created_at DESC LIMIT 1', [user.id]);
  if (recent.length && Date.now() - new Date(recent[0].created_at).getTime() < 60 * 1000) return api().fail(res, 429, 'MFA_CHALLENGE_RATE_LIMITED', 'Wait before requesting another verification code.');
  const id = crypto.randomUUID(); const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await TypeORM.getConnection().query("UPDATE auth_mfa_challenge SET state='superseded' WHERE user_id=? AND state='pending'", [user.id]);
  await TypeORM.getConnection().query('INSERT INTO auth_mfa_challenge (id,user_id,code_hash,state,attempts,expires_at,created_at) VALUES (?,?,?,\'pending\',0,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? SECOND),UTC_TIMESTAMP(3))', [id, user.id, mfaHash(id, code), MFA_TTL_SECONDS]);
  try {
    await sendSiteMail({ to: user.email, subject: `${syzoj.config.title} 安全验证码`, html: `<p>${escapeHtml(user.username)}，你的安全验证码是：</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p><p>验证码将在 10 分钟后失效。</p>` });
  } catch (error) {
    await TypeORM.getConnection().query("UPDATE auth_mfa_challenge SET state='delivery_failed' WHERE id=?", [id]);
    syzoj.log('[identity-v2] MFA delivery failed: ' + (error.stack || error.message));
    return api().fail(res, 503, 'MFA_DELIVERY_FAILED', 'The verification code could not be delivered.');
  }
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'auth:mfa.challenge', resourceType: 'user', resourceId: user.id });
  return api().send(res, { challenge_id: id, method: 'email', destination: maskEmail(user.email), expires_at: new Date(Date.now() + MFA_TTL_SECONDS * 1000).toISOString(), audit_event_id: auditEventId }, 201);
});

app.post('/api/v2/auth/mfa/verify', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  const challengeId = String(req.body && req.body.challenge_id || ''); const code = String(req.body && req.body.code || '');
  if (!/^[0-9]{6}$/.test(code) || !/^[a-f0-9-]{36}$/i.test(challengeId)) return api().fail(res, 422, 'VALIDATION_FAILED', 'A valid challenge and six-digit code are required.');
  await ensureIdentitySchema();
  const verified = await TypeORM.getConnection().transaction(async manager => {
    const rows = await manager.query('SELECT * FROM auth_mfa_challenge WHERE id=? AND user_id=? FOR UPDATE', [challengeId, user.id]);
    if (!rows.length || rows[0].state !== 'pending' || new Date(rows[0].expires_at).getTime() <= Date.now() || Number(rows[0].attempts) >= 5) return false;
    if (!safeEqual(rows[0].code_hash, mfaHash(challengeId, code))) {
      await manager.query("UPDATE auth_mfa_challenge SET attempts=attempts+1,state=CASE WHEN attempts+1>=5 THEN 'failed' ELSE state END WHERE id=?", [challengeId]);
      return false;
    }
    await manager.query("UPDATE auth_mfa_challenge SET state='verified',verified_at=UTC_TIMESTAMP(3) WHERE id=?", [challengeId]);
    return true;
  });
  if (!verified) return api().fail(res, 400, 'MFA_CODE_INVALID', 'The verification code is invalid or expired.');
  req.session.apiV2MfaVerifiedAt = Date.now();
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'auth:mfa.verify', resourceType: 'user', resourceId: user.id });
  return api().send(res, { verified: true, valid_until: new Date(Date.now() + 15 * 60 * 1000).toISOString(), audit_event_id: auditEventId });
});

app.post('/api/v2/auth/password/reset', async (req, res) => {
  const token = String(req.body && req.body.token || '');
  if (!token) {
    const email = String(req.body && req.body.email || '').trim().toLowerCase();
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const user = await User.findOne({ where: { email } });
      if (user) {
        const recent = await TypeORM.getConnection().query('SELECT created_at FROM account_password_reset WHERE user_id=? ORDER BY created_at DESC LIMIT 1', [user.id]);
        const now = Math.floor(Date.now() / 1000);
        if (!recent.length || now - Number(recent[0].created_at) >= 60) {
          const resetToken = crypto.randomBytes(32).toString('hex');
          await TypeORM.getConnection().query('INSERT INTO account_password_reset (token_hash,user_id,expires_at,consumed_at,created_at) VALUES (?,?,?,?,?)', [resetHash(resetToken), user.id, now + RESET_TTL_SECONDS, null, now]);
          const resetUrl = syzoj.utils.getPublicBaseUrl(req) + syzoj.utils.makeUrl(['password', 'reset', resetToken]);
          try {
            await sendSiteMail({ to: user.email, subject: `${syzoj.config.title} 密码重置`, html: `<p>${escapeHtml(user.username)}，请使用以下链接重置密码：</p><p><a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a></p><p>链接将在 1 小时后失效。</p>` });
          } catch (error) {
            await TypeORM.getConnection().query('DELETE FROM account_password_reset WHERE token_hash=?', [resetHash(resetToken)]);
            syzoj.log('[identity-v2] reset delivery failed: ' + (error.stack || error.message));
          }
        }
      }
    }
    return api().send(res, { accepted: true }, 202);
  }
  const password = String(req.body && (req.body.new_password || req.body.password) || '');
  if (!validResetToken(token) || !password) return api().fail(res, 422, 'VALIDATION_FAILED', 'A valid reset token and new password are required.');
  let passwordHash;
  try { passwordHash = await syzoj.utils.hashPassword(password); } catch (error) { return api().fail(res, 422, 'VALIDATION_FAILED', error.message, { new_password: 'invalid' }); }
  let userId = null;
  try {
    await TypeORM.getConnection().transaction(async manager => {
      const rows = await manager.query('SELECT user_id FROM account_password_reset WHERE token_hash=? AND consumed_at IS NULL AND expires_at>=? FOR UPDATE', [resetHash(token), Math.floor(Date.now() / 1000)]);
      if (!rows.length) { const error = new Error('The password reset token is invalid or expired.'); error.code = 'PASSWORD_RESET_INVALID'; error.statusCode = 400; throw error; }
      userId = Number(rows[0].user_id);
      await manager.query('UPDATE user SET password=? WHERE id=?', [passwordHash, userId]);
      await manager.query('UPDATE account_password_reset SET consumed_at=? WHERE token_hash=?', [Math.floor(Date.now() / 1000), resetHash(token)]);
    });
  } catch (error) { return api().fail(res, error.statusCode || 409, error.code || 'PASSWORD_RESET_FAILED', error.message); }
  await syzoj.utils.revokeUserSessions(req, userId); User.deleteFromCache(userId);
  return api().send(res, { reset: true });
});

app.get('/api/v2/me', async (req, res) => {
  if (!res.locals.user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  const payload = await publicMeWithIdentity(res.locals.user);
  if (api().apiNotModified(req, res, payload)) return;
  return api().send(res, payload);
});

app.patch('/api/v2/me', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!await syzoj.utils.authorizationV2.authorize(user, 'profile:edit', { ownerId: user.id, scope: `user:${user.id}` }, { scope: `user:${user.id}` })) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: profile:edit.');
  const current = await publicMeWithIdentity(user);
  if (!req.get('If-Match')) return api().fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when editing a profile.', { if_match: 'required' });
  if (!api().ifMatch(req, current)) return api().fail(res, 412, 'ETAG_MISMATCH', 'The profile changed. Refresh it and try again.');
  const body = req.body || {};
  const nextEmail = body.email == null ? String(user.email || '') : String(body.email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) return api().fail(res, 422, 'VALIDATION_FAILED', 'A valid email address is required.', { email: 'invalid' });
  const emailChanged = nextEmail !== String(user.email || '').trim().toLowerCase();
  const passwordChanged = !!body.new_password;
  if ((emailChanged || passwordChanged) && !await syzoj.utils.verifyPassword(body.current_password, user.password)) return api().fail(res, 403, 'CURRENT_PASSWORD_REQUIRED', 'The current password is required to change email or password.', { current_password: 'incorrect' });
  if (emailChanged) {
    const owners = await TypeORM.getConnection().query('SELECT id FROM user WHERE email=? AND id<>? LIMIT 1', [nextEmail, user.id]);
    if (owners.length) return api().fail(res, 409, 'EMAIL_ALREADY_USED', 'This email address is already in use.', { email: 'already used' });
  }
  let passwordHash = null;
  try {
    if (passwordChanged) passwordHash = await syzoj.utils.hashPassword(body.new_password);
  } catch (error) {
    return api().fail(res, 422, 'VALIDATION_FAILED', error.message, { new_password: 'invalid' });
  }
  const information = body.information == null ? String(user.information || '') : String(body.information).slice(0, 10000);
  const sex = body.sex == null ? String(user.sex || '') : String(body.sex).slice(0, 20);
  const publicEmail = booleanInput(body.public_email, !!user.public_email);
  const formattedCode = booleanInput(body.prefer_formatted_code, !!user.prefer_formatted_code);
  const identitySubmitted = ['student_id', 'real_name', 'college'].some(field => Object.prototype.hasOwnProperty.call(body, field));
  const canManageIdentity = identitySubmitted && (
    await syzoj.utils.isSiteOwnerAccount(user) ||
    await syzoj.utils.authorizationV2.authorize(user, 'admin:user.manage', null, { scope: 'global' })
  );
  let writeResult;
  try {
    await syzoj.utils.registrationIdentityV2.ensureRegistrationSchema();
    writeResult = await TypeORM.getConnection().transaction(async manager => {
      const userRows = await manager.query('SELECT * FROM user WHERE id=? FOR UPDATE', [user.id]);
      const profileRows = await manager.query('SELECT user_id,student_id,real_name,college FROM user_registration_profile WHERE user_id=? FOR UPDATE', [user.id]);
      const lockedUser = Object.assign({}, user, userRows[0] || {});
      const lockedIdentity = syzoj.utils.registrationIdentityV2.profileResource(profileRows[0]);
      if (!api().ifMatch(req, { ...publicMe(lockedUser), identity: lockedIdentity })) {
        const conflict = new Error('The profile changed. Refresh it and try again.');
        conflict.code = 'ETAG_MISMATCH';
        throw conflict;
      }
      if (emailChanged) {
        const owners = await manager.query('SELECT id FROM user WHERE email=? AND id<>? LIMIT 1 FOR UPDATE', [nextEmail, user.id]);
        if (owners.length) {
          const conflict = new Error('This email address is already in use.');
          conflict.code = 'ER_DUP_ENTRY';
          conflict.message = 'Duplicate email';
          throw conflict;
        }
      }
      const identity = identitySubmitted
        ? await syzoj.utils.registrationIdentityV2.saveProfileFields(manager, user.id, body, canManageIdentity)
        : lockedIdentity;
      await manager.query('UPDATE user SET email=?,information=?,sex=?,public_email=?,prefer_formatted_code=?' + (passwordHash ? ',password=?' : '') + ' WHERE id=?', passwordHash
        ? [nextEmail, information, sex, publicEmail ? 1 : 0, formattedCode ? 1 : 0, passwordHash, user.id]
        : [nextEmail, information, sex, publicEmail ? 1 : 0, formattedCode ? 1 : 0, user.id]);
      if (emailChanged) {
        await manager.query('UPDATE user_email_status SET is_email_verified=0,verified_email=NULL,verified_at=NULL,last_send_at=NULL WHERE user_id=?', [user.id]);
        await manager.query("UPDATE email_verification_token SET used=1 WHERE user_id=? AND purpose='verify_email' AND used=0", [user.id]);
      }
      const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
        action: 'profile:update', resourceType: 'user', resourceId: user.id,
        details: { email_changed: emailChanged, password_changed: passwordChanged, identity_changed: identitySubmitted }
      }, manager);
      const eventId = await contentDomain.appendEvent(manager, {
        stream: `user:${user.id}`, type: 'profile.updated', aggregateId: user.id, actorId: user.id,
        payload: { email_changed: emailChanged, password_changed: passwordChanged, identity_changed: identitySubmitted, audit_event_id: auditEventId }
      });
      return { identity, auditEventId, eventId };
    });
  } catch (error) {
    return profileFailure(res, error);
  }
  if (passwordChanged) {
    await syzoj.utils.revokeUserSessions(req, user.id);
    await syzoj.utils.establishAuthenticatedSession(req, user.id);
  }
  if (emailChanged && syzoj.utils.refreshVerifiedCache) await syzoj.utils.refreshVerifiedCache();
  User.deleteFromCache(user.id);
  const updated = await User.findById(user.id);
  return api().send(res, { ...publicMe(updated), identity: writeResult.identity, audit_event_id: writeResult.auditEventId, event_id: writeResult.eventId });
});

ensureIdentitySchema().catch(error => syzoj.log('[identity-v2] schema initialization failed: ' + (error.stack || error.message)));
