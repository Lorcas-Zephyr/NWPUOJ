const TypeORM = require('typeorm');

let profileSchemaPromise = null;
function ensureProfileSchema() {
  if (!profileSchemaPromise) {
    profileSchemaPromise = TypeORM.getConnection().query(`
      CREATE TABLE IF NOT EXISTS user_registration_profile (
        user_id INT NOT NULL,
        student_id VARCHAR(10) NULL,
        real_name VARCHAR(64) NULL,
        college VARCHAR(100) NULL,
        created_at INT NOT NULL,
        updated_at INT NOT NULL,
        PRIMARY KEY (user_id),
        UNIQUE KEY uq_user_registration_profile_student_id (student_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `).catch(error => {
      profileSchemaPromise = null;
      throw error;
    });
  }
  return profileSchemaPromise;
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
  if (/^\/(?:login|logout|sign_up)(?:\/|$)/.test(req.path)) return true;
  if (/^\/api\/(?:login|forget|forget_confirm|reset_password)(?:\/|$)/.test(req.path)) return true;
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
