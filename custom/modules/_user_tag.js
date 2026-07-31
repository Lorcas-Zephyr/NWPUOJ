// 用户名牌子(tag) 系统
const TypeORM = require('typeorm');
let UserTag = syzoj.model('user-tag');
let User = syzoj.model('user');

let userTagSettingSchemaPromise = null;
syzoj.userTagsEnabled = true;
syzoj.userTags = new Map();

async function ensureUserTagSettingSchema() {
  if (userTagSettingSchemaPromise) return userTagSettingSchemaPromise;
  userTagSettingSchemaPromise = (async () => {
    const connection = TypeORM.getConnection();
    await connection.query(`CREATE TABLE IF NOT EXISTS user_tag_global_setting (
      scope VARCHAR(32) NOT NULL PRIMARY KEY,enabled TINYINT(1) NOT NULL DEFAULT 1,
      updated_by INT NULL,updated_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query("INSERT IGNORE INTO user_tag_global_setting (scope,enabled,updated_by,updated_at) VALUES ('global',1,NULL,UTC_TIMESTAMP(3))");
  })().catch(error => { userTagSettingSchemaPromise = null; throw error; });
  return userTagSettingSchemaPromise;
}

async function readUserTagGlobalSetting(connection = TypeORM.getConnection()) {
  await ensureUserTagSettingSchema();
  const rows = await connection.query("SELECT enabled,updated_by,updated_at FROM user_tag_global_setting WHERE scope='global' LIMIT 1");
  const row = rows[0] || { enabled: 1, updated_by: null, updated_at: null };
  return { enabled: !!row.enabled, updated_by: row.updated_by == null ? null : Number(row.updated_by), updated_at: row.updated_at || null };
}

function hasAdminRole(user) {
  if (!user) return false;
  if (user.is_admin) return true;
  if (user.privileges && (
    user.privileges.includes('manage_problem') ||
    user.privileges.includes('manage_problem_tag') ||
    user.privileges.includes('manage_contest') ||
    user.privileges.includes('manage_user')
  )) return true;
  return false;
}

async function canManageUserTags(user) {
  return !!(user && await syzoj.utils.authorizationV2.authorize(
    user,
    'admin:user.manage',
    null,
    { scope: 'global' }
  ));
}

function calcUserTier(userId, isAdminFlag) {
  if (isAdminFlag) return 'admin';
  if (syzoj.adminUserIds && syzoj.adminUserIds.has(userId)) return 'admin';
  if (syzoj.userHitScores && syzoj.userHitScores.has(userId)) {
    let s = syzoj.userHitScores.get(userId);
    let h = s.total || 0;
    if (h >= 350) return 'red';
    if (h >= 280) return 'orange';
    if (h >= 200) return 'green';
    if (h >= 100) return 'blue';
    return 'gray';
  }
  return 'default';
}

async function refreshUserTagsCache() {
  try {
    const setting = await readUserTagGlobalSetting();
    syzoj.userTagsEnabled = setting.enabled;
    if (!setting.enabled) {
      syzoj.userTags = new Map();
      return;
    }
    // 拿所有未禁用的记录(包括 is_visible=false 的,用于判断"显式存在")
    let allRows = await UserTag.createQueryBuilder()
      .where('is_disabled = FALSE')
      .getMany();

    // existsForUid: 数据库里"显式"有该用户记录的 user_id 集合
    let existsForUid = new Set(allRows.map(r => r.user_id));

    let newCache = new Map();

    // 只把 is_visible=true 且 tag_text 非空的记录加入缓存
    for (let r of allRows) {
      if (r.is_visible && r.tag_text && r.tag_text.length > 0) {
        let tier = calcUserTier(r.user_id, false);
        newCache.set(r.user_id, { text: r.tag_text, tier: tier });
      }
    }

    // admin fallback: adminUserIds 里且数据库中"完全没有显式记录"的用户 → "管理员"
    // 数据库里有记录的 admin(无论 is_visible 是 true 还是 false)都尊重数据库
    if (syzoj.adminUserIds && syzoj.adminUserIds.size > 0) {
      for (let uid of syzoj.adminUserIds) {
        if (!existsForUid.has(uid) && !newCache.has(uid)) {
          newCache.set(uid, { text: '管理员', tier: 'admin' });
        }
      }
    }
    if (syzoj.siteOwnerUserId) {
      newCache.set(syzoj.siteOwnerUserId, { text: '站长', tier: 'admin' });
    }

    syzoj.userTags = newCache;
    syzoj.log('[user-tag-cache] Refreshed: ' + newCache.size + ' user tags');
  } catch (e) {
    syzoj.log('[user-tag-cache] refresh failed: ' + e.message);
  }
}

setTimeout(refreshUserTagsCache, 8 * 1000);
setInterval(refreshUserTagsCache, 60 * 1000);

async function getUserTagState(user) {
  if (syzoj.userTagsEnabled === false) return { hasPermission: false, isAutoFromAdmin: false, record: null, isDisabled: false };
  if (!user) return { hasPermission: false, isAutoFromAdmin: false, record: null };

  let record = await UserTag.findOne({ where: { user_id: user.id } });

  if (record && record.is_disabled) {
    return { hasPermission: false, isAutoFromAdmin: false, record: record, isDisabled: true };
  }

  let isAdmin = hasAdminRole(user);
  if (isAdmin) {
    return { hasPermission: true, isAutoFromAdmin: true, record: record };
  }
  if (record && !record.is_disabled) {
    return { hasPermission: true, isAutoFromAdmin: false, record: record };
  }
  return { hasPermission: false, isAutoFromAdmin: false, record: null };
}

syzoj.utils.getUserTagState = getUserTagState;
syzoj.utils.refreshUserTagsCache = refreshUserTagsCache;
syzoj.utils.userTagSettings = Object.freeze({ ensureSchema: ensureUserTagSettingSchema, read: readUserTagGlobalSetting });


app.get('/admin/user-tags', async (req, res) => {
  try {
    if (!await canManageUserTags(res.locals.user)) {
      throw new ErrorMessage('您没有权限管理账户牌子。');
    }

    let records = await UserTag.createQueryBuilder()
      .orderBy('user_id', 'ASC')
      .getMany();

    let userIds = [...new Set(records.map(r => r.user_id))];
    let granterIds = [...new Set(records.map(r => r.granted_by).filter(x => x))];
    let disablerIds = [...new Set(records.map(r => r.disabled_by).filter(x => x))];
    let allIds = [...new Set([...userIds, ...granterIds, ...disablerIds])];

    let userMap = {};
    if (allIds.length > 0) {
      let users = await User.createQueryBuilder()
        .where('id IN (:...ids)', { ids: allIds })
        .getMany();
      for (let u of users) userMap[u.id] = u;
    }

    const setting = await readUserTagGlobalSetting();
    const canConfigureUserTags = !!(res.locals.user && await syzoj.utils.authorizationV2.authorize(res.locals.user, 'admin:config.write', null, { scope: 'global' }));
    res.render('admin_user_tags', {
      records: records,
      userMap: userMap,
      userTagsEnabled: setting.enabled,
      canConfigureUserTags
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});
