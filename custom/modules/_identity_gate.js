const TypeORM = require('typeorm');
const { ensureRegistrationProfileSchema } = require('../libs/registration-profile-schema');

function ensureProfileSchema() {
  return ensureRegistrationProfileSchema();
}

ensureProfileSchema().catch(error => {
  syzoj.log('[identity-gate] ' + (error.stack || error));
  process.exit(1);
});

function isProfileComplete(profile) {
  return !!(profile && /^\d{10}$/.test(String(profile.student_id || '')) &&
    String(profile.real_name || '').trim() && String(profile.college || '').trim());
}

function mayCompleteIdentity(req, userId) {
  if (/^\/(?:self|static|socket\.io)(?:\/|$)/.test(req.path) || req.path === '/favicon.ico') return true;
  if (/^\/(?:login|logout|sign_up|password\/reset)(?:\/|$)/.test(req.path)) return true;
  if (/^\/api\/v2\/auth\/password\/reset(?:\/|$)/.test(req.path)) return true;
  if (/^\/email\/(?:send-verification|verification-pending|verify)(?:\/|$)/.test(req.path)) return true;
  return req.path === `/user/${userId}/edit`;
}

app.use(async (req, res, next) => {
  const user = res.locals.user;
  if (!user) return next();
  try {
    await ensureProfileSchema();
    const rows = await TypeORM.getConnection().query(
      'SELECT student_id,real_name,college FROM user_registration_profile WHERE user_id = ? LIMIT 1',
      [user.id]
    );
    const complete = isProfileComplete(rows[0]);
    res.locals.identityProfileComplete = complete;
    if (complete || mayCompleteIdentity(req, user.id)) return next();
    const editUrl = syzoj.utils.makeUrl(['user', user.id, 'edit'], { complete_profile: '1' });
    if (/^\/api(?:\/|$)/.test(req.path) || req.accepts(['html', 'json']) === 'json') {
      return res.status(428).send({
        error_code: 428,
        message: '请先补全实名资料。',
        redirect_url: editUrl
      });
    }
    res.redirect(303, editUrl);
  } catch (error) {
    next(error);
  }
});
