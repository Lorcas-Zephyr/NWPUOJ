let PrivateMessage = syzoj.model('private-message');
let UserMessageSetting = syzoj.model('user-message-setting');
let User = syzoj.model('user');

// ---------- 工具函数 ----------

// 检查能否给某用户发消息
async function canSendTo(sender, receiver) {
  if (!sender) return { ok: false, reason: '请登录后继续。' };
  if (!receiver) return { ok: false, reason: '收件人不存在。' };
  if (sender.id === receiver.id) return { ok: false, reason: '不能给自己发送站内信。' };

  const canModerateMessages = await syzoj.utils.authorizationV2.authorize(
    sender,
    'admin:user.manage',
    null,
    { scope: 'global' }
  );

  // 账号管理员可以处理未验证账号的必要沟通。
  if (!canModerateMessages) {
    if (!await syzoj.utils.isEmailVerified(sender.id)) {
      return { ok: false, reason: '请先验证邮箱后再发送站内信。' };
    }
  }

  if (canModerateMessages) return { ok: true };
  // 检查接收方屏蔽设置
  let setting = await UserMessageSetting.findOne({ where: { user_id: receiver.id } });
  if (setting && setting.disable_messages) {
    return { ok: false, reason: '该用户已关闭站内信。' };
  }
  return { ok: true };
}

// 给某用户(可能不存在)创建/更新设置记录
async function getOrCreateSetting(userId) {
  let s = await UserMessageSetting.findOne({ where: { user_id: userId } });
  if (!s) {
    s = await UserMessageSetting.create();
    s.user_id = userId;
    s.disable_messages = false;
  }
  return s;
}

// 当前未读数
async function countUnread(userId) {
  return await PrivateMessage.count({
    receiver_id: userId,
    is_read: false,
    receiver_deleted: false
  });
}

// ---------- 路由 ----------

// ============ 收件箱(按对话方分组) ============
app.get('/messages', async (req, res) => {
  try {
    if (!res.locals.user) {
      throw new ErrorMessage('请登录后继续。', { '登录': syzoj.utils.makeUrl(['login'], { 'url': req.originalUrl }) });
    }
    let myId = res.locals.user.id;

    // 用 SQL 直接聚合"按对方分组"的最新消息+未读数
    // 使用 createQueryBuilder 的 raw query 能力
    // 思路:对每条消息计算 partner_id = (sender_id == myId ? receiver_id : sender_id),按 partner_id 分组取最新
    let qb = PrivateMessage.createQueryBuilder('m')
      .select('CASE WHEN m.sender_id = :myId THEN m.receiver_id ELSE m.sender_id END', 'partner_id')
      .addSelect('MAX(m.public_time)', 'last_time')
      .addSelect('SUM(CASE WHEN m.receiver_id = :myId AND m.is_read = 0 AND m.receiver_deleted = 0 THEN 1 ELSE 0 END)', 'unread')
      .where('(m.sender_id = :myId AND m.sender_deleted = 0) OR (m.receiver_id = :myId AND m.receiver_deleted = 0)', { myId: myId })
      .setParameter('myId', myId)
      .groupBy('partner_id')
      .orderBy('last_time', 'DESC');

    let raws = await qb.getRawMany();

    // 加载每个对话方的用户信息 + 最后一条消息内容
    let conversations = [];
    for (let r of raws) {
      let partnerId = parseInt(r.partner_id);
      if (!partnerId) continue;
      let partner = await User.findById(partnerId);
      if (!partner) continue;

      // 最后一条消息(可见的:发送者删除则发送方看不到,接收者删除则接收方看不到)
      let lastMsg = await PrivateMessage.findOne({
        where: [
          { sender_id: myId, receiver_id: partnerId, sender_deleted: false },
          { sender_id: partnerId, receiver_id: myId, receiver_deleted: false }
        ],
        order: { public_time: 'DESC' }
      });

      conversations.push({
        partner: partner,
        last_message: lastMsg,
        last_time: parseInt(r.last_time),
        unread: parseInt(r.unread) || 0
      });
    }
    res.render('messages_inbox', {
      conversations: conversations
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 与某用户的对话历史 ============
app.get('/messages/with/:uid', async (req, res) => {
  try {
    if (!res.locals.user) {
      throw new ErrorMessage('请登录后继续。', { '登录': syzoj.utils.makeUrl(['login'], { 'url': req.originalUrl }) });
    }
    let myId = res.locals.user.id;
    let partnerId = parseInt(req.params.uid);
    if (!partnerId || partnerId === myId) {
      throw new ErrorMessage('无效的对话对象。');
    }

    let partner = await User.findById(partnerId);
    if (!partner) throw new ErrorMessage('对方用户不存在。');

    // 查询双方互发的所有消息
    let qb = PrivateMessage.createQueryBuilder('m')
      .where(
        '((m.sender_id = :myId AND m.receiver_id = :partnerId AND m.sender_deleted = 0)' +
        ' OR (m.sender_id = :partnerId AND m.receiver_id = :myId AND m.receiver_deleted = 0))',
        { myId: myId, partnerId: partnerId }
      )
      .orderBy('m.public_time', 'ASC');

    let messages = await qb.getMany();

    // 给前端用的简化字段
    for (let m of messages) {
      m.is_self = (m.sender_id === myId);
      m.contentRendered = await syzoj.utils.markdown(m.content || '');
    }

    // 把所有未读消息标记为已读
    let unreadIds = messages.filter(m => !m.is_self && !m.is_read).map(m => m.id);
    if (unreadIds.length > 0) {
      await PrivateMessage.createQueryBuilder()
        .update()
        .set({ is_read: true })
        .where('id IN (:...ids)', { ids: unreadIds })
        .execute();
    }
    // 检查能否回复(对方是否屏蔽)
    let canReply = await canSendTo(res.locals.user, partner);

    res.render('messages_conversation', {
      partner: partner,
      messages: messages,
      canReply: canReply.ok,
      cannotReplyReason: canReply.ok ? null : canReply.reason
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 发送消息给某用户 ============

// ============ 发起新对话页 ============
app.get('/messages/new', async (req, res) => {
  try {
    if (!res.locals.user) {
      throw new ErrorMessage('请登录后继续。', { '登录': syzoj.utils.makeUrl(['login'], { 'url': req.originalUrl }) });
    }

    // 支持 ?to=xxx 预填收件人(uid 或 username)
    let prefill = (req.query.to || '').trim();

    res.render('messages_new', {
      prefill: prefill
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// 处理"发起新对话"表单提交:解析收件人 -> 重定向到 send 路由

// ============ 删除单条消息(软删) ============

// ============ 删除整个对话历史(对自己软删) ============

// ============ 标记某对话所有消息为已读 ============

// ============ 设置页 GET ============
app.get('/messages/settings', async (req, res) => {
  try {
    if (!res.locals.user) {
      throw new ErrorMessage('请登录后继续。', { '登录': syzoj.utils.makeUrl(['login'], { 'url': req.originalUrl }) });
    }
    let s = await getOrCreateSetting(res.locals.user.id);
    res.render('messages_settings', {
      setting: s
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 设置页 POST ============
