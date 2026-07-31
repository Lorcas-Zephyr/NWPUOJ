const crypto = require('crypto');
const TypeORM = require('typeorm');
const {
  ORDINARY_STUDENT_ID_SCOPE,
  ensureRegistrationProfileSchema
} = require('../libs/registration-profile-schema');

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
      await ensureRegistrationProfileSchema();
      const connection = TypeORM.getConnection();
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
    'SELECT user_id FROM user_registration_profile WHERE student_id_scope=? AND student_id=? AND user_id!=? LIMIT 1',
    [ORDINARY_STUDENT_ID_SCOPE, studentId, exceptUserId || 0]
  );
  if (rows.length) throw registrationError(2014, '该学号已被使用。');
}

function profileResource(profile) {
  const value = profile || {};
  const resource = {
    student_id: cleanText(value.student_id),
    real_name: cleanText(value.real_name),
    college: cleanText(value.college)
  };
  resource.complete = /^\d{10}$/.test(resource.student_id) && !!resource.real_name && COLLEGES.includes(resource.college);
  return resource;
}

async function saveProfileFields(manager, userId, body, allowChanges) {
  const rows = await manager.query(
    'SELECT user_id,student_id,real_name,college FROM user_registration_profile WHERE user_id = ? FOR UPDATE',
    [userId]
  );
  const profile = rows[0] || null;
  const current = profileResource(profile);
  const has = field => Object.prototype.hasOwnProperty.call(body || {}, field);
  const next = {
    student_id: has('student_id') ? cleanText(body.student_id) : current.student_id,
    real_name: has('real_name') ? cleanText(body.real_name) : current.real_name,
    college: has('college') ? cleanText(body.college) : current.college
  };

  if (!allowChanges) {
    for (const field of ['student_id', 'real_name', 'college']) {
      if (current[field] && next[field] !== current[field]) {
        throw registrationError(2017, '注册实名信息保存后不允许修改。');
      }
    }
  }
  if (!/^\d{10}$/.test(next.student_id)) throw registrationError(2011, '请填写 10 位数字学号。');
  if (!next.real_name || next.real_name.length > 64) throw registrationError(2012, '请填写姓名。');
  if (!COLLEGES.includes(next.college)) throw registrationError(2013, '请选择有效的学院。');

  const now = Math.floor(Date.now() / 1000);
  if (profile) {
    await manager.query(
      `UPDATE user_registration_profile SET student_id=?,real_name=?,college=?,updated_at=?
       WHERE user_id=?`,
      [next.student_id, next.real_name, next.college, now, userId]
    );
  } else {
    await manager.query(
      `INSERT INTO user_registration_profile
        (user_id,student_id,real_name,college,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
      [userId, next.student_id, next.real_name, next.college, now, now]
    );
  }
  return profileResource(next);
}

async function saveMissingProfileFields(userId, body, allowChanges) {
  await ensureRegistrationSchema();
  try {
    await TypeORM.getConnection().transaction(manager => saveProfileFields(manager, userId, body, allowChanges));
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
  await Promise.all([
    syzoj.utils.ensureAccountStateSchema(),
    syzoj.utils.apiV2.ensureFoundationSchema()
  ]);
  const passwordHash = data.passwordHash || await syzoj.utils.hashPassword(data.password);
  let userId;
  let domainEvent;
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
      await manager.query(
        `INSERT INTO auth_user_state (user_id,status,reason,changed_by,changed_at)
         VALUES (?,'active',NULL,NULL,FROM_UNIXTIME(?))`,
        [userId, now]
      );
      const eventResult = await manager.query(
        'INSERT INTO api_v2_event (stream,type,aggregate_id,actor_id,payload_json,created_at) VALUES (?,?,?,?,?,FROM_UNIXTIME(?))',
        [`identity:user:${userId}`, 'user.registered', String(userId), userId, JSON.stringify({ user_id: userId, account_status: 'active' }), now]
      );
      domainEvent = {
        id: String(eventResult.insertId), stream: `identity:user:${userId}`, type: 'user.registered',
        aggregate_id: String(userId), actor_id: userId,
        payload: { user_id: userId, account_status: 'active' },
        created_at: new Date(now * 1000).toISOString()
      };
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
  syzoj.utils.apiV2.publishEvent(domainEvent);
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
    2016: '两次输入的密码不一致。',
    2017: '注册实名信息保存后不允许修改。'
  };
  if (typeof error === 'number') return messages[error] || '注册失败。';
  return error.message || messages[error.registrationCode] || '注册失败。';
}

syzoj.utils.registrationIdentityV2 = Object.freeze({
  createAccount,
  ensureRegistrationSchema,
  findProfile,
  profileResource,
  registrationErrorText,
  saveProfileFields,
  validateAccount
});

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
  const actorCanManage = actorIsOwner || await syzoj.utils.authorizationV2.authorize(
    actor,
    'admin:user.manage',
    null,
    { scope: 'global' }
  );
  const actorCanGrant = actorIsOwner || await syzoj.utils.authorizationV2.authorize(
    actor,
    'admin:permission.grant',
    null,
    { scope: 'global' }
  );
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
    actorCanManage: actorCanManage,
    actorCanGrant: actorCanGrant
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
