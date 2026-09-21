'use strict';

// Contest notices are immutable, plain-text broadcasts, not site announcements
// or inbox messages. Read cursors belong to a user and persist across sessions.
const TypeORM = require('typeorm');
const { appendEvent } = require('../libs/content-domain');
const { ReadCache } = require('../libs/read-cache');
const { ContestNoticeStream } = require('../libs/contest-notice-stream');
const historyCache = new ReadCache();
const noticeStream = new ContestNoticeStream();
const Contest = syzoj.model('contest');
const db = () => TypeORM.getConnection();
const api = () => syzoj.utils.apiV2;
let schemaPromise;

function ensureSchema() {
  if (!schemaPromise) schemaPromise = (async () => {
    await db().query(`CREATE TABLE IF NOT EXISTS contest_notice (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      contest_id INT NOT NULL,
      author_id INT NULL,
      content TEXT NOT NULL,
      publish_token VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      published_at INT NOT NULL,
      UNIQUE KEY uq_contest_notice_token (contest_id,publish_token),
      KEY idx_contest_notice_history (contest_id,id),
      CONSTRAINT fk_contest_notice_contest FOREIGN KEY (contest_id) REFERENCES contest(id) ON DELETE CASCADE,
      CONSTRAINT fk_contest_notice_author FOREIGN KEY (author_id) REFERENCES user(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await db().query(`CREATE TABLE IF NOT EXISTS contest_notice_read (
      contest_id INT NOT NULL,
      user_id INT NOT NULL,
      last_notice_id INT NOT NULL DEFAULT 0,
      PRIMARY KEY (contest_id,user_id),
      CONSTRAINT fk_contest_notice_read_contest FOREIGN KEY (contest_id) REFERENCES contest(id) ON DELETE CASCADE,
      CONSTRAINT fk_contest_notice_read_user FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  })().catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}

function noticeError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function positiveId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw noticeError(422, 'VALIDATION_FAILED', '编号无效。');
  return id;
}

async function canManage(contest, user) {
  if (!user) return false;
  const scope = `contest:${contest.id}`;
  return !!await syzoj.utils.authorizationV2.authorize(user, 'contest:edit', {
    id: Number(contest.id), ownerId: Number(contest.holder_id), scope
  }, { scope });
}

async function access(req, res, managerOnly) {
  const contest = await Contest.findById(positiveId(req.params.id));
  if (!contest) throw noticeError(404, 'CONTEST_NOT_FOUND', '无此比赛。');
  const manager = managerOnly || !contest.is_public ? await canManage(contest, res.locals.user) : false;
  if ((managerOnly || !contest.is_public) && !manager) {
    throw noticeError(res.locals.user ? 403 : 401, res.locals.user ? 'CAPABILITY_REQUIRED' : 'AUTHENTICATION_REQUIRED', '您没有权限管理或查看该比赛通知。');
  }
  await ensureSchema();
  return { contest, manager };
}

function resource(row) {
  return { id: Number(row.id), content: row.content, published_at: Number(row.published_at) };
}

function handleError(res, error) {
  if (!error.statusCode) syzoj.log(error);
  return api().fail(res, error.statusCode || 500, error.statusCode ? error.code : 'REQUEST_FAILED',
    error.statusCode ? error.message : '暂时无法处理比赛通知，请稍后重试。');
}

app.get('/contest/:id/notices', async (req, res) => {
  try {
    const { contest } = await access(req, res, true);
    res.set('Cache-Control', 'private, no-store');
    return res.render('contest_notices', { contest });
  } catch (error) {
    if (!error.statusCode) syzoj.log(error);
    return res.status(error.statusCode || 500).render('error', { err: error });
  }
});

app.get('/api/v2/contests/:id/notices', async (req, res) => {
  try {
    const { contest } = await access(req, res, false);
    const before = req.query.before_id ? positiveId(req.query.before_id) : null;
    const rows = await historyCache.get(`${contest.id}:${before || 'latest'}`, 3000, () => db().query(
      `SELECT id,content,published_at FROM contest_notice WHERE contest_id=?${before ? ' AND id<?' : ''} ORDER BY id DESC LIMIT 51`,
      before ? [contest.id, before] : [contest.id]
    ));
    return api().send(res, {
      items: rows.slice(0, 50).map(resource),
      next_before_id: rows.length > 50 ? Number(rows[49].id) : null
    });
  } catch (error) { return handleError(res, error); }
});

app.get('/api/v2/contests/:id/notices/events', async (req, res) => {
  try {
    const { contest } = await access(req, res, false);
    return noticeStream.attach(req, res, contest.id);
  } catch (error) { return handleError(res, error); }
});

app.get('/api/v2/contests/:id/notices/unread', async (req, res) => {
  try {
    if (!res.locals.user) throw noticeError(401, 'AUTHENTICATION_REQUIRED', '请先登录。');
    const { contest } = await access(req, res, false);
    const manager = await canManage(contest, res.locals.user);
    const now = Math.floor(Date.now() / 1000);
    // Read the live registration, not a cached page state (removals take effect immediately).
    const registered = await db().query('SELECT id FROM contest_player WHERE contest_id=? AND user_id=? LIMIT 1', [contest.id, res.locals.user.id]);
    const eligible = !!registered.length && !manager;
    const active = eligible && now >= contest.start_time && now < contest.end_time;
    const cursors = await db().query('SELECT last_notice_id FROM contest_notice_read WHERE contest_id=? AND user_id=?', [contest.id, res.locals.user.id]);
    const readThrough = cursors.length ? Number(cursors[0].last_notice_id) : 0;
    const rows = active ? await db().query(
      'SELECT id,content,published_at FROM contest_notice WHERE contest_id=? AND id>? ORDER BY id ASC LIMIT 50',
      [contest.id, readThrough]
    ) : [];
    return api().send(res, { items: rows.map(resource), active, eligible, read_through: readThrough,
      server_time: now, start_time: Number(contest.start_time), end_time: Number(contest.end_time) });
  } catch (error) { return handleError(res, error); }
});

app.post('/api/v2/contests/:id/notices', async (req, res) => {
  try {
    const { contest } = await access(req, res, true);
    const body = req.body || {};
    if (typeof body.content !== 'string' || !body.content.trim() || body.content.trim().length > 4000) {
      throw noticeError(422, 'VALIDATION_FAILED', '通知内容不能为空，且不能超过 4000 个字符。');
    }
    const content = body.content.trim();
    // A body token survives school gateways that strip custom request headers.
    // It also makes retries safe beyond the foundation operation's lifetime.
    const token = String(body.publish_token || '');
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(token)) throw noticeError(422, 'VALIDATION_FAILED', '发布标识无效，请刷新后重试。');
    await api().ensureFoundationSchema();
    const result = await db().transaction(async manager => {
      const locked = await manager.query('SELECT id,holder_id FROM contest WHERE id=? FOR UPDATE', [contest.id]);
      if (!locked.length) throw noticeError(404, 'CONTEST_NOT_FOUND', '无此比赛。');
      if (!await canManage(locked[0], res.locals.user)) throw noticeError(403, 'CAPABILITY_REQUIRED', '您没有权限发布该比赛通知。');
      const previous = await manager.query('SELECT * FROM contest_notice WHERE contest_id=? AND publish_token=?', [contest.id, token]);
      if (previous.length) {
        if (previous[0].content !== content || Number(previous[0].author_id) !== Number(res.locals.user.id)) {
          throw noticeError(409, 'IDEMPOTENCY_CONFLICT', '发布内容已改变，请重新发起发布。');
        }
        return { row: previous[0], replay: true };
      }
      const at = Math.floor(Date.now() / 1000);
      const inserted = await manager.query('INSERT INTO contest_notice (contest_id,author_id,content,publish_token,published_at) VALUES (?,?,?,?,?)',
        [contest.id, res.locals.user.id, content, token, at]);
      const id = Number(inserted.insertId);
      const auditId = await syzoj.utils.authorizationV2.recordAudit(req, {
        action: 'contest:notice.publish', resourceType: 'contest', resourceId: Number(contest.id),
        scope: `contest:${contest.id}`, details: { notice_id: id }
      }, manager);
      await appendEvent(manager, { stream: `contest:${contest.id}`, type: 'contest.notice.published',
        aggregateId: contest.id, actorId: res.locals.user.id, payload: { notice_id: id } });
      return { row: { id, content, published_at: at }, auditId };
    });
    if (!result.replay) {
      historyCache.invalidate(`${contest.id}:`);
      noticeStream.publish(contest.id);
    }
    res.locals.apiMeta.audit_event_id = result.auditId || null;
    return api().send(res, resource(result.row), result.replay ? 200 : 201);
  } catch (error) { return handleError(res, error); }
});

app.post('/api/v2/contests/:id/notices/:noticeId/read', async (req, res) => {
  try {
    if (!res.locals.user) throw noticeError(401, 'AUTHENTICATION_REQUIRED', '请先登录。');
    const { contest } = await access(req, res, false);
    const noticeId = positiveId(req.params.noticeId);
    const registered = await db().query('SELECT id FROM contest_player WHERE contest_id=? AND user_id=? LIMIT 1', [contest.id, res.locals.user.id]);
    if (!registered.length) throw noticeError(403, 'CAPABILITY_REQUIRED', '您未报名该比赛。');
    const notice = await db().query('SELECT id FROM contest_notice WHERE contest_id=? AND id=?', [contest.id, noticeId]);
    if (!notice.length) throw noticeError(404, 'NOTIFICATION_NOT_FOUND', '该比赛通知不存在。');
    await db().query(`INSERT INTO contest_notice_read (contest_id,user_id,last_notice_id) VALUES (?,?,?)
      ON DUPLICATE KEY UPDATE last_notice_id=GREATEST(last_notice_id,VALUES(last_notice_id))`, [contest.id, res.locals.user.id, noticeId]);
    return api().send(res, { id: noticeId, read: true });
  } catch (error) { return handleError(res, error); }
});

ensureSchema().catch(error => syzoj.log(`[contest-notices] schema initialization failed: ${error.message}`));
