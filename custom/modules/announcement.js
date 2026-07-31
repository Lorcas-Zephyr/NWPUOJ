let Announcement = syzoj.model('announcement');
const crypto = require('crypto');
const TypeORM = require('typeorm');
const contentDomain = require('../libs/content-domain');
const { sortAnnouncements } = require('../libs/announcement-order');

async function canManageAnnouncements(user) {
  return !!(user && await syzoj.utils.authorizationV2.authorize(user, 'announcement:manage', null, {}));
}

function requireRecentAdminLogin(req) {
  if (syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return;
  const error = new ErrorMessage('此操作需要重新登录或完成二次验证。');
  error.statusCode = 403;
  throw error;
}

function requireAdminCsrf(req) {
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

function legacyChangeReason(req, fallback) {
  return String(req.body && req.body.reason || fallback).trim().slice(0, 1000);
}

// ============ 前台:全部已启用公告 ============
app.get('/announcements', async (req, res) => {
  try {
    let announcements = await Announcement.createQueryBuilder()
      .where('is_active = 1')
      .getMany();

    const now = Math.floor(Date.now() / 1000);
    sortAnnouncements(announcements, now);
    for (let announcement of announcements) {
      announcement.contentRendered = await syzoj.utils.markdown(announcement.content || '');
    }

    res.render('announcements', {
      announcements: announcements,
      now
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 后台:公告管理列表 ============
app.get('/admin/announcements', async (req, res) => {
  try {
    if (!await canManageAnnouncements(res.locals.user)) {
      throw new ErrorMessage('您没有权限进行此操作。');
    }

    let pageSize = 20;
    let total = await Announcement.count({});
    let paginate = syzoj.utils.paginate(total, req.query.page, pageSize);
    let announcements = await Announcement.queryPage(paginate, {}, {
      public_time: 'DESC'
    });

    let now = parseInt((new Date()).getTime() / 1000);
    for (let a of announcements) {
      a.isLive = a.isCurrentlyActive();
    }

    res.render('admin_announcements', {
      announcements: announcements,
      paginate: paginate,
      now: now
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 后台:编辑/新建公告 GET ============
app.get('/admin/announcement/:id/edit', async (req, res) => {
  try {
    if (!await canManageAnnouncements(res.locals.user)) {
      throw new ErrorMessage('您没有权限进行此操作。');
    }

    let id = parseInt(req.params.id);
    let announcement;
    if (id === 0) {
      announcement = await Announcement.create();
      announcement.id = 0;
      announcement.title = '';
      announcement.content = '';
      announcement.level = 'info';
      announcement.is_active = true;
      // 默认生效时间:从现在开始,到 7 天后
      let now = parseInt((new Date()).getTime() / 1000);
      announcement.start_time = now;
      announcement.end_time = now + 7 * 24 * 3600;
    } else {
      announcement = await Announcement.findById(id);
      if (!announcement) throw new ErrorMessage('无此公告。');
    }

    res.render('admin_announcement_edit', {
      announcement: announcement
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 后台:编辑/新建公告 POST ============

// ============ 后台:启用/停用切换 ============

// ============ 后台:删除公告 ============
