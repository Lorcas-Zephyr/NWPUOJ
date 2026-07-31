let UserFollow = syzoj.model('user-follow');
let User = syzoj.model('user');
const TypeORM = require('typeorm');
const contentDomain = require('../libs/content-domain');

async function setFollow(actorId, targetId, following) {
  if (!Number.isSafeInteger(actorId) || actorId <= 0 || !Number.isSafeInteger(targetId) || targetId <= 0) {
    throw Object.assign(new Error('用户参数不正确。'), { statusCode: 422, code: 'VALIDATION_FAILED' });
  }
  if (actorId === targetId) throw Object.assign(new Error('不能关注自己。'), { statusCode: 409, code: 'SELF_FOLLOW_FORBIDDEN' });
  return TypeORM.getConnection().transaction('READ COMMITTED', async manager => {
    const actors = await manager.query('SELECT id FROM user WHERE id=? FOR UPDATE', [actorId]);
    const targets = await manager.query('SELECT id FROM user WHERE id=? LIMIT 1', [targetId]);
    if (!actors.length) throw Object.assign(new Error('请先登录。'), { statusCode: 401, code: 'AUTHENTICATION_REQUIRED' });
    if (!targets.length) throw Object.assign(new Error('用户不存在。'), { statusCode: 404, code: 'USER_NOT_FOUND' });
    const existing = await manager.query('SELECT id FROM user_follow WHERE follower_id=? AND followee_id=? ORDER BY id ASC FOR UPDATE', [actorId, targetId]);
    let changed = false;
    if (following && !existing.length) {
      await manager.query('INSERT INTO user_follow (follower_id,followee_id,created_at) VALUES (?,?,?)', [actorId, targetId, Math.floor(Date.now() / 1000)]);
      changed = true;
    } else if (!following && existing.length) {
      await manager.query('DELETE FROM user_follow WHERE follower_id=? AND followee_id=?', [actorId, targetId]);
      changed = true;
    }
    const eventId = await contentDomain.appendEvent(manager, {
      stream: `user-follow:${actorId}`,
      type: following ? 'user.followed' : 'user.unfollowed',
      aggregateId: targetId,
      actorId,
      payload: { target_user_id: targetId, changed }
    });
    return { follower_id: actorId, followee_id: targetId, following, changed, event_id: eventId };
  });
}

// ============ 通用工具:获取关系状态 ============
async function getFollowRelation(viewerId, targetId) {
  if (!viewerId || viewerId === targetId) {
    return { iFollow: false, theyFollow: false, mutual: false };
  }
  let conn = require('typeorm').getConnection();
  let rows = await conn.query(
    `SELECT follower_id, followee_id FROM user_follow
     WHERE (follower_id = ? AND followee_id = ?)
        OR (follower_id = ? AND followee_id = ?)`,
    [viewerId, targetId, targetId, viewerId]
  );
  let iFollow = false, theyFollow = false;
  for (let r of rows) {
    if (r.follower_id === viewerId && r.followee_id === targetId) iFollow = true;
    if (r.follower_id === targetId && r.followee_id === viewerId) theyFollow = true;
  }
  return { iFollow, theyFollow, mutual: iFollow && theyFollow };
}

syzoj.utils.getFollowRelation = getFollowRelation;

// ============ 通用工具:计数 ============
async function countFollowing(userId) {
  return await UserFollow.count({ follower_id: userId });
}
async function countFollowers(userId) {
  return await UserFollow.count({ followee_id: userId });
}
syzoj.utils.countFollowing = countFollowing;
syzoj.utils.countFollowers = countFollowers;

// ============ POST /user/:id/follow:关注 ============

// ============ POST /user/:id/unfollow:取关 ============

app.post('/api/v2/users/:id/follow', async (req, res) => {
  const user = res.locals.user;
  if (!user) return syzoj.utils.apiV2.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  try {
    return syzoj.utils.apiV2.send(res, await setFollow(Number(user.id), Number(req.params.id), true), 201);
  } catch (error) {
    return syzoj.utils.apiV2.fail(res, error.statusCode || 409, error.code || 'FOLLOW_FAILED', error.message);
  }
});

app.delete('/api/v2/users/:id/follow', async (req, res) => {
  const user = res.locals.user;
  if (!user) return syzoj.utils.apiV2.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  try {
    return syzoj.utils.apiV2.send(res, await setFollow(Number(user.id), Number(req.params.id), false));
  } catch (error) {
    return syzoj.utils.apiV2.fail(res, error.statusCode || 409, error.code || 'UNFOLLOW_FAILED', error.message);
  }
});

// ============ GET /user/:id/following:某用户关注的人列表 ============
app.get('/user/:id/following', async (req, res) => {
  try {
    let uid = parseInt(req.params.id);
    let target = await User.findById(uid);
    if (!target) throw new ErrorMessage('用户不存在。');

    let pageSize = 30;
    let total = await UserFollow.count({ follower_id: uid });
    let paginate = syzoj.utils.paginate(total, req.query.page, pageSize);
    let rows = await UserFollow.queryPage(paginate, { follower_id: uid }, { created_at: 'DESC' });
    let users = [];
    for (let r of rows) {
      let u = await User.findById(r.followee_id);
      if (u) {
        u.followedAt = r.created_at;
        users.push(u);
      }
    }
    res.render('user_following', {
      show_user: target,
      users: users,
      total: total,
      paginate: paginate,
      listType: 'following'
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ GET /user/:id/followers:某用户的粉丝列表 ============
app.get('/user/:id/followers', async (req, res) => {
  try {
    let uid = parseInt(req.params.id);
    let target = await User.findById(uid);
    if (!target) throw new ErrorMessage('用户不存在。');

    let pageSize = 30;
    let total = await UserFollow.count({ followee_id: uid });
    let paginate = syzoj.utils.paginate(total, req.query.page, pageSize);
    let rows = await UserFollow.queryPage(paginate, { followee_id: uid }, { created_at: 'DESC' });
    let users = [];
    for (let r of rows) {
      let u = await User.findById(r.follower_id);
      if (u) {
        u.followedAt = r.created_at;
        users.push(u);
      }
    }
    res.render('user_following', {
      show_user: target,
      users: users,
      total: total,
      paginate: paginate,
      listType: 'followers'
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});
