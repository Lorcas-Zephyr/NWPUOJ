const crypto = require('crypto');
const TypeORM = require('typeorm');

const User = syzoj.model('user');
const MANAGED_PRIVILEGES = ['manage_problem', 'manage_problem_tag', 'manage_contest', 'manage_user'];
const COLLEGES = [
  '航空学院',
  '航天学院',
  '航海学院',
  '材料学院',
  '机电学院',
  '力学与交通运载工程学院',
  '动力与能源学院',
  '电子信息学院',
  '自动化学院',
  '计算机学院',
  '软件学院',
  '集成电路学院（微电子学院）',
  '网络空间安全学院 / 国家保密学院',
  '民航学院',
  '数学与统计学院',
  '物理科学与技术学院',
  '化学与化工学院',
  '生命科学与医学学部',
  '管理学院',
  '公共政策与管理学院',
  '外国语学院',
  '马克思主义学院',
  '教育实验学院',
  '伦敦玛丽女王大学工程学院',
  '莫斯科航空学院',
  '国家卓越工程师学院',
  '继续教育学院'
];

let registrationSchemaPromise = null;
function ensureRegistrationSchema() {
  if (!registrationSchemaPromise) {
    registrationSchemaPromise = (async () => {
      const connection = TypeORM.getConnection();
      await connection.query(`
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
      `);
      await connection.query("UPDATE user SET email = LOWER(TRIM(email)) WHERE email IS NOT NULL AND email != LOWER(TRIM(email))");
      await connection.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_user_email ON user (email)');
    })().catch(error => {
      registrationSchemaPromise = null;
      throw error;
    });
  }
  return registrationSchemaPromise;
}

ensureRegistrationSchema().catch(error => {
  syzoj.log('[registration-schema] ' + (error.stack || error));
  process.exit(1);
});

function cleanText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeEmail(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function registrationError(code, message) {
  const error = new Error(message);
  error.registrationCode = code;
  return error;
}

function validateIdentity(body, required) {
  const studentId = cleanText(body.student_id);
  const realName = cleanText(body.real_name);
  const college = cleanText(body.college);
  if ((required || studentId) && !/^\d{10}$/.test(studentId)) {
    throw registrationError(2011, '学号必须为 10 位数字。');
  }
  if ((required || realName) && (!realName || realName.length > 64)) {
    throw registrationError(2012, '请填写姓名，且长度不能超过 64 个字符。');
  }
  if ((required || college) && !COLLEGES.includes(college)) {
    throw registrationError(2013, '请选择有效的学院。');
  }
  return { studentId, realName, college };
}

async function findProfile(userId) {
  await ensureRegistrationSchema();
  const rows = await TypeORM.getConnection().query(
    'SELECT user_id, student_id, real_name, college FROM user_registration_profile WHERE user_id = ? LIMIT 1',
    [userId]
  );
  return rows[0] || null;
}

async function ensureStudentIdAvailable(studentId, exceptUserId) {
  const rows = await TypeORM.getConnection().query(
    'SELECT user_id FROM user_registration_profile WHERE student_id = ? AND user_id != ? LIMIT 1',
    [studentId, exceptUserId || 0]
  );
  if (rows.length) throw registrationError(2014, '该学号已被使用。');
}

async function saveMissingProfileFields(userId, body, allowChanges) {
  await ensureRegistrationSchema();
  try {
    await TypeORM.getConnection().transaction(async manager => {
      const rows = await manager.query(
        'SELECT user_id,student_id,real_name,college FROM user_registration_profile WHERE user_id = ? FOR UPDATE',
        [userId]
      );
      const profile = rows[0] || null;
      const submitted = validateIdentity(body, !!allowChanges);
      const current = {
        studentId: cleanText(profile && profile.student_id),
        realName: cleanText(profile && profile.real_name),
        college: cleanText(profile && profile.college)
      };

      if (!allowChanges) {
        for (const field of ['studentId', 'realName', 'college']) {
          if (current[field] && submitted[field] && current[field] !== submitted[field]) {
            throw new Error('注册实名信息保存后不允许修改。');
          }
        }
      }
      const next = allowChanges ? submitted : {
          studentId: current.studentId || submitted.studentId,
          realName: current.realName || submitted.realName,
          college: current.college || submitted.college
        };
      if (!/^\d{10}$/.test(next.studentId)) throw registrationError(2011, '请填写 10 位数字学号。');
      if (!next.realName || next.realName.length > 64) throw registrationError(2012, '请填写姓名。');
      if (!COLLEGES.includes(next.college)) throw registrationError(2013, '请选择有效的学院。');

      const now = Math.floor(Date.now() / 1000);
      if (profile) {
        await manager.query(
          `UPDATE user_registration_profile SET student_id=?,real_name=?,college=?,updated_at=?
           WHERE user_id=?`,
          [next.studentId, next.realName, next.college, now, userId]
        );
      } else {
        await manager.query(
          `INSERT INTO user_registration_profile
            (user_id,student_id,real_name,college,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
          [userId, next.studentId, next.realName, next.college, now, now]
        );
      }
    });
    return findProfile(userId);
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY' && /student/i.test(error.message || '')) {
      throw registrationError(2014, '该学号已被使用。');
    }
    throw error;
  }
}

async function validateAccount(body, passwordHash) {
  if (!body) throw 2001;
  const username = cleanText(body.username);
  const password = String(body.password || '');
  const email = normalizeEmail(body.email);
  if (!syzoj.utils.isValidUsername(username)) throw 2002;
  if (passwordHash) {
    if (!syzoj.utils.isStoredPassword(passwordHash)) throw 2007;
  } else {
    try {
      syzoj.utils.validateNewPassword(password);
    } catch (error) {
      throw registrationError(2007, error.message);
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw 2004;
  if (await User.fromName(username)) throw 2008;
  if (await User.findOne({ where: { email } })) throw 2009;
  const identity = validateIdentity(body, true);
  await ensureStudentIdAvailable(identity.studentId, 0);
  return { username, password, passwordHash: passwordHash || null, email, identity };
}

async function createAccount(data) {
  await ensureRegistrationSchema();
  await syzoj.utils.ensureSiteOwner();
  const passwordHash = data.passwordHash || await syzoj.utils.hashPassword(data.password);
  let userId;
  try {
    await TypeORM.getConnection().transaction(async manager => {
      const now = Math.floor(Date.now() / 1000);
      const result = await manager.query(
        `INSERT INTO user
          (username,password,email,is_admin,is_show,public_email,prefer_formatted_code,rating,register_time)
         VALUES (?,?,?,0,?,1,1,?,?)`,
        [
          data.username,
          passwordHash,
          data.email,
          Number(syzoj.config.default.user.show),
          Number(syzoj.config.default.user.rating),
          now
        ]
      );
      userId = Number(result.insertId);
      await manager.query(
        `INSERT INTO user_registration_profile
          (user_id,student_id,real_name,college,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
        [userId, data.identity.studentId, data.identity.realName, data.identity.college, now, now]
      );
      await syzoj.utils.claimSiteOwner(manager, userId);
    });
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      const message = String(error.message || '');
      if (/student/i.test(message)) throw 2014;
      if (/email/i.test(message)) throw 2009;
      if (/username/i.test(message)) throw 2008;
    }
    throw error;
  }
  return User.findById(userId);
}

function validRegistrationCsrf(req) {
  const expected = req.session && req.session.registrationCsrfToken;
  const actual = req.body && req.body.registration_csrf_token;
  if (typeof expected !== 'string' || typeof actual !== 'string' || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function safePrevUrl(value) {
  const url = String(value || '/');
  return url.startsWith('/') && !url.startsWith('//') ? url : '/';
}

function safeRegistrationRedirect(value) {
  const url = safePrevUrl(value);
  return /^\/(?:login|sign_up)(?:[/?#]|$)/.test(url) ? '/' : url;
}

function ensureRegistrationCsrf(req) {
  if (!req.session.registrationCsrfToken) {
    req.session.registrationCsrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.registrationCsrfToken;
}

function registrationErrorText(error) {
  const messages = {
    2001: '服务器未收到注册数据。',
    2002: '用户名仅允许字母、数字、连字符和下划线。',
    2004: '请输入正确的邮箱。',
    2007: '密码不得为空。',
    2008: '该用户名已被使用。',
    2009: '该邮箱地址已被使用。',
    2011: '学号必须为 10 位数字。',
    2012: '请填写姓名，且长度不能超过 64 个字符。',
    2013: '请选择有效的学院。',
    2014: '该学号已被使用。',
    2015: '页面已失效，请重新提交。',
    2016: '两次输入的密码不一致。'
  };
  if (typeof error === 'number') return messages[error] || '注册失败。';
  return error.message || messages[error.registrationCode] || '注册失败。';
}

function renderSignUp(req, res, options) {
  const settings = options || {};
  res.render('sign_up', {
    colleges: COLLEGES,
    registrationCsrfToken: ensureRegistrationCsrf(req),
    registrationPrevUrl: safeRegistrationRedirect(settings.prevUrl || req.query.url),
    registrationValues: settings.values || {},
    registrationErrorInfo: settings.error || null,
    registrationNotice: settings.notice || null
  });
}

// These routes load before SYZOJ's built-in api.js and user.js routes.
app.get('/sign_up', async (req, res) => {
  if (res.locals.user) {
    return res.render('error', {
      err: new ErrorMessage('您已经登录了，请先注销。', {
        '注销': syzoj.utils.makeUrl(['logout'], { url: req.originalUrl })
      })
    });
  }
  renderSignUp(req, res);
});

app.post('/sign_up', async (req, res) => {
  if (res.locals.user) return res.redirect(303, '/');
  const body = req.body || {};
  const values = {
    username: cleanText(body.username),
    student_id: cleanText(body.student_id),
    real_name: cleanText(body.real_name),
    college: cleanText(body.college),
    email: cleanText(body.email)
  };
  const prevUrl = safeRegistrationRedirect(body.prevUrl);
  try {
    if (!validRegistrationCsrf(req)) {
      req.session.registrationCsrfToken = crypto.randomBytes(32).toString('hex');
      throw registrationError(2015, '页面已失效，请重新提交。');
    }
    const plainPassword = String(body.password || '');
    if (!plainPassword) throw registrationError(2007, '密码不得为空。');
    if (plainPassword !== String(body.confirm_password || '')) {
      throw registrationError(2016, '两次输入的密码不一致。');
    }
    const data = await validateAccount(Object.assign({}, body, values, { password: plainPassword }));

    const user = await createAccount(data);
    await syzoj.utils.establishAuthenticatedSession(req, user.id);
    delete req.session.registrationCsrfToken;
    syzoj.utils.clearLegacyLoginCookie(req, res);
    req.session.postVerificationRedirect = prevUrl;
    let sent = true;
    try {
      await syzoj.utils.sendEmailVerification(req, user);
    } catch (mailError) {
      sent = false;
      syzoj.log('[registration] verification email failed: ' + (mailError.stack || mailError));
    }
    res.redirect(303, '/email/verification-pending?sent=' + (sent ? '1' : '0'));
  } catch (error) {
    syzoj.log(error);
    renderSignUp(req, res, {
      prevUrl: prevUrl,
      values: values,
      error: registrationErrorText(error)
    });
  }
});

app.post('/api/sign_up', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    if (!validRegistrationCsrf(req)) throw registrationError(2015, '页面已失效，请刷新后重试。');
    const data = await validateAccount(req.body);
    const prevUrl = safeRegistrationRedirect(req.body.prevUrl);

    const user = await createAccount(data);
    await syzoj.utils.establishAuthenticatedSession(req, user.id);
    syzoj.utils.clearLegacyLoginCookie(req, res);
    req.session.postVerificationRedirect = prevUrl;
    let sent = true;
    try {
      await syzoj.utils.sendEmailVerification(req, user);
    } catch (mailError) {
      sent = false;
      syzoj.log('[registration] verification email failed: ' + (mailError.stack || mailError));
    }
    res.send({
      error_code: 1,
      redirect_url: '/email/verification-pending?sent=' + (sent ? '1' : '0')
    });
  } catch (error) {
    syzoj.log(error);
    res.send({
      error_code: typeof error === 'number' ? error : (error.registrationCode || 1000),
      message: typeof error === 'number' ? undefined : error.message
    });
  }
});

app.get('/api/sign_up_confirm', async (req, res) => {
  res.status(410).render('error', {
    err: new ErrorMessage('旧版注册链接已失效，请重新注册。', {
      '重新注册': syzoj.utils.makeUrl(['sign_up'])
    })
  });
});

app.get('/api/sign_up/:token', (req, res) => {
  res.status(410).render('error', {
    err: new ErrorMessage('该注册链接已失效，请重新注册。', {
      '重新注册': syzoj.utils.makeUrl(['sign_up'])
    })
  });
});

async function loadUserEditContext(req, res) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== req.params.id) {
    throw new ErrorMessage('用户 ID 不正确。');
  }
  const editedUser = await User.findById(id);
  if (!editedUser) throw new ErrorMessage('无此用户。');
  if (id === Number(syzoj.deletedAccountUserId || 0)) throw new ErrorMessage('系统保留账号不能修改。');
  const actor = res.locals.user;
  if (!actor) throw new ErrorMessage('请登录后继续。');
  const actorIsOwner = await syzoj.utils.isSiteOwnerAccount(actor);
  const targetIsOwner = await syzoj.utils.isSiteOwnerAccount(editedUser);
  const actorCanManage = actorIsOwner || await actor.hasPrivilege('manage_user');
  if (targetIsOwner && !actorIsOwner) {
    throw new ErrorMessage('只有站长本人可以修改站长账户。');
  }
  if (editedUser.is_admin && editedUser.id !== actor.id && !actorIsOwner) {
    throw new ErrorMessage('只有站长可以修改其他全站管理员。');
  }
  if (editedUser.id !== actor.id && !actorCanManage) {
    throw new ErrorMessage('您没有权限进行此操作。');
  }
  editedUser.privileges = await editedUser.getPrivileges();
  res.locals.user.allowedManage = actorCanManage;
  return {
    editedUser: editedUser,
    profile: await findProfile(editedUser.id),
    actorIsOwner: actorIsOwner,
    actorCanManage: actorCanManage
  };
}

function renderUserEdit(res, context, errorInfo) {
  res.render('user_edit', {
    edited_user: context.editedUser,
    registrationProfile: context.profile,
    registrationColleges: COLLEGES,
    error_info: errorInfo
  });
}

app.get('/user/:id/edit', async (req, res) => {
  try {
    renderUserEdit(res, await loadUserEditContext(req, res), null);
  } catch (error) {
    syzoj.log(error);
    res.render('error', { err: error });
  }
});

app.post('/user/:id/edit', async (req, res) => {
  let context;
  let passwordChanged = false;
  let emailChanged = false;
  try {
    context = await loadUserEditContext(req, res);
    const editedUser = context.editedUser;

    const submittedEmail = normalizeEmail(req.body.email || editedUser.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(submittedEmail)) {
      throw new ErrorMessage('请输入正确的邮箱。');
    }
    emailChanged = submittedEmail !== normalizeEmail(editedUser.email);
    let currentPasswordVerified = false;
    if (editedUser.id === res.locals.user.id && (emailChanged || req.body.new_password)) {
      currentPasswordVerified = !!req.body.old_password &&
        await syzoj.utils.verifyPassword(req.body.old_password, editedUser.password);
      if (!currentPasswordVerified) throw new ErrorMessage('旧密码错误。');
    }

    if (req.body.new_password) {
      if (editedUser.id === res.locals.user.id) {
        if (!currentPasswordVerified) throw new ErrorMessage('旧密码错误。');
      } else if (!res.locals.user.allowedManage) {
        throw new ErrorMessage('您没有权限重置该用户的密码。');
      }
      editedUser.password = await syzoj.utils.hashPassword(req.body.new_password);
      passwordChanged = true;
    }

    if (res.locals.user.allowedManage) {
      if (!syzoj.utils.isValidUsername(req.body.username)) throw new ErrorMessage('无效的用户名。');
      editedUser.username = req.body.username;
    }
    if (emailChanged && editedUser.id !== res.locals.user.id && !res.locals.user.allowedManage) {
      throw new ErrorMessage('您没有权限修改该用户的邮箱。');
    }
    if (emailChanged) {
      const emailOwner = await User.findOne({ where: { email: submittedEmail } });
      if (emailOwner && emailOwner.id !== editedUser.id) throw new ErrorMessage('该邮箱地址已被使用。');
    }
    editedUser.email = submittedEmail;

    let requestedPrivileges = null;
    if (res.locals.user.is_admin) {
      requestedPrivileges = req.body.privileges || [];
      if (!Array.isArray(requestedPrivileges)) requestedPrivileges = [requestedPrivileges];
      requestedPrivileges = requestedPrivileges.filter(value => MANAGED_PRIVILEGES.includes(value));
    }

    if (typeof res.locals.requestedSiteAdmin === 'boolean') {
      editedUser.is_admin = res.locals.requestedSiteAdmin;
    }

    editedUser.information = req.body.information;
    editedUser.sex = req.body.sex;
    editedUser.public_email = req.body.public_email === 'on';
    editedUser.prefer_formatted_code = req.body.prefer_formatted_code === 'on';

    context.profile = await saveMissingProfileFields(editedUser.id, req.body, context.actorCanManage);
    if (editedUser.id === res.locals.user.id) res.locals.identityProfileComplete = true;
    if (requestedPrivileges) {
      await editedUser.setPrivileges(requestedPrivileges);
      if (syzoj.utils.invalidateUserRequestStateCache) {
        syzoj.utils.invalidateUserRequestStateCache(editedUser.id);
      }
    }
    await editedUser.save();
    if (syzoj.utils && typeof syzoj.utils.refreshAvatarCache === 'function') {
      await syzoj.utils.refreshAvatarCache();
    }
    if (emailChanged) {
      await TypeORM.getConnection().transaction(async manager => {
        await manager.query(
          `UPDATE user_email_status
           SET is_email_verified=0,verified_email=NULL,verified_at=NULL,last_send_at=NULL WHERE user_id=?`,
          [editedUser.id]
        );
        await manager.query(
          `UPDATE email_verification_token SET used=1
           WHERE user_id=? AND purpose='verify_email' AND used=0`,
          [editedUser.id]
        );
      });
      if (syzoj.utils.refreshVerifiedCache) await syzoj.utils.refreshVerifiedCache();
    }
    if (passwordChanged) {
      await syzoj.utils.revokeUserSessions(req, editedUser.id);
      if (editedUser.id === res.locals.user.id) {
        await syzoj.utils.establishAuthenticatedSession(req, editedUser.id);
      }
      syzoj.utils.clearLegacyLoginCookie(req, res);
    }
    if (typeof syzoj.refreshAdminUserIds === 'function') await syzoj.refreshAdminUserIds();
    if (syzoj.utils && typeof syzoj.utils.refreshUserTagsCache === 'function') {
      await syzoj.utils.refreshUserTagsCache();
    }

    if (editedUser.id === res.locals.user.id) res.locals.user = editedUser;
    editedUser.privileges = await editedUser.getPrivileges();
    res.locals.user.allowedManage = context.actorCanManage;
    renderUserEdit(res, context, '');
  } catch (error) {
    syzoj.log(error);
    if (!context) return res.render('error', { err: error });
    try {
      context.editedUser.privileges = await context.editedUser.getPrivileges();
      context.profile = await findProfile(context.editedUser.id);
      res.locals.user.allowedManage = context.actorCanManage;
    } catch (contextError) {
      syzoj.log(contextError);
    }
    renderUserEdit(res, context, error.message || '修改失败。');
  }
});
