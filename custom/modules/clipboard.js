let ClipboardItem = syzoj.model('clipboard-item');
let User = syzoj.model('user');

const MAX_CONTENT_BYTES = 100 * 1024; // 100KB

// 生成 32 位随机 token(用 crypto 模块,无需新装包)
function genShareToken() {
  let crypto = require('crypto');
  return crypto.randomBytes(20).toString('hex');
}

// ============ 我的剪贴板列表 ============
app.get('/clipboard', async (req, res) => {
  try {
    if (!res.locals.user) {
      throw new ErrorMessage('请登录后继续。', { '登录': syzoj.utils.makeUrl(['login'], { 'url': req.originalUrl }) });
    }
    let myId = res.locals.user.id;

    let pageSize = 20;
    let where = { user_id: myId };
    let total = await ClipboardItem.count(where);
    let paginate = syzoj.utils.paginate(total, req.query.page, pageSize);
    let items = await ClipboardItem.queryPage(paginate, where, {
      update_time: 'DESC'
    });

    res.render('clipboard_list', {
      items: items,
      paginate: paginate,
      total: total,
      isOwn: true,
      pageOwner: res.locals.user
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 看某用户的公开剪贴板 ============
app.get('/clipboard/user/:uid', async (req, res) => {
  try {
    let uid = parseInt(req.params.uid);
    let owner = await User.findById(uid);
    if (!owner) throw new ErrorMessage('用户不存在。');

    let isOwn = res.locals.user && res.locals.user.id === uid;

    let where;
    if (isOwn) {
      where = { user_id: uid };
    } else {
      where = { user_id: uid, visibility: 'public' };
    }

    let pageSize = 20;
    let total = await ClipboardItem.count(where);
    let paginate = syzoj.utils.paginate(total, req.query.page, pageSize);
    let items = await ClipboardItem.queryPage(paginate, where, {
      update_time: 'DESC'
    });

    res.render('clipboard_list', {
      items: items,
      paginate: paginate,
      total: total,
      isOwn: isOwn,
      pageOwner: owner
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 看某条剪贴板 ============
app.get('/clipboard/:id', async (req, res) => {
  try {
    let id = parseInt(req.params.id);
    let item = await ClipboardItem.findById(id);
    if (!item) throw new ErrorMessage('该剪贴板不存在。');

    let isOwn = res.locals.user && res.locals.user.id === item.user_id;

    if (!isOwn) {
      // 非作者本人:仅 public 可见
      if (item.visibility !== 'public') {
        throw new ErrorMessage('您没有权限查看此剪贴板。');
      }
    }
    let owner = await User.findById(item.user_id);
    item.contentRendered = await syzoj.utils.markdown(item.content || '');

    // 给前端用的分享 URL(只在作者本人页面显示)
    let shareUrl = null;
    if (isOwn && item.visibility === 'link' && item.share_token) {
      shareUrl = syzoj.utils.makeUrl(['clipboard', 'share', item.share_token]);
    }

    res.render('clipboard_view', {
      item: item,
      owner: owner,
      isOwn: isOwn,
      shareUrl: shareUrl
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 通过分享 token 访问 ============
app.get('/clipboard/share/:token', async (req, res) => {
  try {
    let token = String(req.params.token || '').trim();
    if (!token) throw new ErrorMessage('分享链接无效。');

    let item = await ClipboardItem.findOne({ where: { share_token: token } });
    if (!item) throw new ErrorMessage('分享链接无效或已被作者撤销。');

    if (!item.isShareLinkValid()) {
      throw new ErrorMessage('此分享链接已过期或已被撤销。');
    }
    
    let owner = await User.findById(item.user_id);
    item.contentRendered = await syzoj.utils.markdown(item.content || '');

    res.render('clipboard_view', {
      item: item,
      owner: owner,
      isOwn: false,
      shareUrl: null,
      viaShareLink: true
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 编辑/新建 GET ============
app.get('/clipboard/:id/edit', async (req, res) => {
  try {
    if (!res.locals.user) {
      throw new ErrorMessage('请登录后继续。', { '登录': syzoj.utils.makeUrl(['login'], { 'url': req.originalUrl }) });
    }

    let id = parseInt(req.params.id);
    let item;
    if (id === 0) {
      item = await ClipboardItem.create();
      item.id = 0;
      item.user_id = res.locals.user.id;
      item.title = '';
      item.content = '';
      item.visibility = 'private';
      item.share_expires = null;
    } else {
      item = await ClipboardItem.findById(id);
      if (!item) throw new ErrorMessage('剪贴板不存在。');
      if (!item.isOwnedBy(res.locals.user)) {
        throw new ErrorMessage('您没有权限编辑此剪贴板。');
      }
    }

    res.render('clipboard_edit', { item: item });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 编辑/新建 POST ============

// ============ 重新生成分享链接 ============

// ============ 删除 ============
