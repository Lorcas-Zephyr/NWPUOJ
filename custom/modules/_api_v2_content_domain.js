const TypeORM = require('typeorm');
const crypto = require('crypto');
const contentDomain = require('../libs/content-domain');
function api() { return syzoj.utils.apiV2; }
async function can(user, capability, resource, context) { return !!(user && await syzoj.utils.authorizationV2.authorize(user, capability, resource, context || {})); }
function time(value) { return value == null ? null : new Date(Number(value) * 1000).toISOString(); }
async function contentTransaction(work) { await api().ensureFoundationSchema(); return TypeORM.getConnection().transaction(work); }
function auditRecorder(req) { return (event, manager) => syzoj.utils.authorizationV2.recordAudit(req, event, manager); }
function contentFailure(res, error) { const expected = Number.isInteger(error.statusCode); return api().fail(res, expected ? error.statusCode : 500, expected ? error.code : 'CONTENT_WRITE_FAILED', expected ? error.message : 'The content operation could not be completed.', expected ? error.fields || {} : {}); }
function generateClipboardToken() { return crypto.randomBytes(18).toString('base64url'); }
function serializeClipboard(row) { return { id: Number(row.id), title: row.title, content: row.content, visibility: row.visibility, share_url: row.visibility === 'link' && row.share_token ? `/clipboard/share/${row.share_token}` : null, expires_at: time(row.share_expires), created_at: time(row.public_time), updated_at: time(row.update_time) }; }
function messageSettingsResource(row) { return { disable_messages: !!(row && row.disable_messages), updated_at: row && row.update_time != null ? time(row.update_time) : null }; }
function ticketResource(row) { const id = Number(row.id); return { id, ownerId: Number(row.creator_id), scope: `ticket:${id}` }; }
function serializeUserTag(row) { return { id: Number(row.user_id), user: { id: Number(row.user_id), username: row.username || null, is_site_admin: !!row.is_admin }, tag_text: row.tag_text || '', is_visible: !!row.is_visible, is_disabled: !!row.is_disabled, granted_by: row.granted_by == null ? null : { id: Number(row.granted_by), username: row.granter_username || null }, granted_at: time(row.granted_at), disabled_by: row.disabled_by == null ? null : { id: Number(row.disabled_by), username: row.disabler_username || null }, disabled_at: time(row.disabled_at) }; }
function userTagSettingResource(row) { return { enabled: !!row.enabled, updated_by: row.updated_by == null ? null : Number(row.updated_by), updated_at: api().databaseIso(row.updated_at) }; }
async function ticketManagerAccess(user, row) { const resource = ticketResource(row); return can(user, 'ticket:manage', resource, { scope: resource.scope }); }
async function messageSendAccess(user, res) {
  const bypassRecipientPolicy = await can(user, 'admin:user.manage');
  if (!bypassRecipientPolicy && !await syzoj.utils.isEmailVerified(user.id)) {
    api().fail(res, 409, 'VERIFIED_EMAIL_REQUIRED', 'Verify your email address before sending messages.');
    return null;
  }
  return { bypassRecipientPolicy };
}
async function discussionVisibility(user) { if (!user) return { unrestricted: false, userId: 0, problemIds: [] }; const [moderator, problemManager, problemIds] = await Promise.all([can(user, 'discussion:moderate'), can(user, 'problem:edit'), syzoj.utils.authorizationV2.authorizedScopeIds(user, 'problem', 'problem:read')]); return { unrestricted: moderator || problemManager, userId: Number(user.id), problemIds: problemIds.map(Number).filter(Number.isSafeInteger) }; }
function discussionVisibilityFilter(access) { if (access.unrestricted) return { sql: '', params: [] }; const clauses = ['article.problem_id IS NULL', 'problem.is_public=1']; const params = []; if (access.userId) { clauses.push('article.user_id=?', 'problem.user_id=?'); params.push(access.userId, access.userId); } if (access.problemIds.length) { clauses.push(`problem.id IN (${access.problemIds.map(() => '?').join(',')})`); params.push(...access.problemIds); } return { sql: `AND (${clauses.join(' OR ')})`, params }; }

app.get('/api/v2/announcements', async (req, res) => { const now = Math.floor(Date.now() / 1000); const limit = api().parseLimit(req, 30, 100); const offset = Math.max(0, Number(api().decodeCursor(req.query.cursor) || 0)); const rows = await TypeORM.getConnection().query("SELECT id,title,content,level,public_time,start_time,end_time,is_active FROM announcement WHERE is_active=1 AND (start_time IS NULL OR start_time<=?) AND (end_time IS NULL OR end_time>=?) ORDER BY CASE level WHEN 'important' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END ASC,COALESCE(start_time,public_time) DESC,id DESC LIMIT ? OFFSET ?", [now, now, limit + 1, offset]); const more = rows.length > limit; const page = rows.slice(0, limit); res.locals.apiMeta.limit = limit; res.locals.apiMeta.next_cursor = more ? api().encodeCursor(offset + limit) : null; const resources = await Promise.all(page.map(async row => ({ id: Number(row.id), title: row.title, content: row.content, content_rendered: await syzoj.utils.markdown(row.content || ''), level: row.level || 'info', published_at: time(row.public_time || row.start_time), expires_at: time(row.end_time) }))); return api().send(res, resources);
});
app.get(['/api/v2/banners', '/api/v2/banners/active'], async (req, res) => { const now = Math.floor(Date.now() / 1000); const rows = await TypeORM.getConnection().query('SELECT id,title,image_path,link_url,sort_order,start_time,end_time FROM homepage_banner WHERE is_active=1 AND (start_time IS NULL OR start_time<=?) AND (end_time IS NULL OR end_time>=?) ORDER BY sort_order DESC,id DESC', [now, now]); return api().send(res, rows.map(row => ({ id: Number(row.id), title: row.title || null, image_url: row.image_path || null, link_url: row.link_url || null, starts_at: time(row.start_time), ends_at: time(row.end_time) })));
});

app.get(['/api/v2/notifications', '/api/v2/me/notifications'], async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user, 'notification:read')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: notification:read.'); const limit = api().parseLimit(req, 30, 100); const cursor = Number(api().decodeCursor(req.query.cursor) || 0); const rows = await TypeORM.getConnection().query('SELECT id,type,title,content,source_url,is_read,created_at,read_at FROM notification WHERE recipient_id=? AND id>? ORDER BY id ASC LIMIT ?', [user.id, cursor, limit + 1]); const more = rows.length > limit; res.locals.apiMeta.limit = limit; res.locals.apiMeta.next_cursor = more ? api().encodeCursor(rows[limit - 1].id) : null; return api().send(res, rows.slice(0, limit).map(row => ({ id: Number(row.id), type: row.type, title: row.title, content: row.content, source_url: row.source_url, is_read: !!row.is_read, created_at: time(row.created_at), read_at: time(row.read_at) })));
});
app.post('/api/v2/notifications/read-all', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user, 'notification:read')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: notification:read.'); try { const result = await contentTransaction(manager => contentDomain.markAllNotificationsRead(manager, { userId: user.id, now: Math.floor(Date.now() / 1000) })); return api().send(res, { updated: result.updated, event_id: result.eventId }); } catch (error) { return contentFailure(res, error); } });
app.post('/api/v2/notifications/:id/read', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user, 'notification:read')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: notification:read.'); try { const result = await contentTransaction(manager => contentDomain.markNotificationRead(manager, { notificationId: req.params.id, userId: user.id, now: Math.floor(Date.now() / 1000) })); return api().send(res, { id: result.id, is_read: true, read_at: time(result.readAt), source_url: result.sourceUrl, updated: result.updated, event_id: result.eventId }); } catch (error) { return contentFailure(res, error); } });
app.delete('/api/v2/notifications/:id', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user, 'notification:read')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: notification:read.'); try { const result = await contentTransaction(manager => contentDomain.deleteNotification(manager, { notificationId: req.params.id, userId: user.id })); return api().send(res, { id: result.id, deleted: true, event_id: result.eventId }); } catch (error) { return contentFailure(res, error); } });

app.get('/api/v2/users/:id/hit-history', async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isSafeInteger(userId) || userId < 1) return api().fail(res, 404, 'USER_NOT_FOUND', 'The user was not found.');
  if (syzoj.userHitHidden && syzoj.userHitHidden.has(userId) && (!res.locals.user || Number(res.locals.user.id) !== userId)) {
    return api().fail(res, 403, 'HIT_HISTORY_PRIVATE', 'This user has hidden their HIT history.');
  }
  const days = Math.min(90, Math.max(1, Number.parseInt(req.query.days, 10) || 30));
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = await TypeORM.getConnection().query(`SELECT recorded_at,basic_score,contribution_score,contest_score,practice_score
    FROM user_hit_score_history WHERE user_id=? AND recorded_at>=? ORDER BY recorded_at ASC`, [userId, cutoff]);
  res.set('Cache-Control', 'no-store');
  return api().send(res, { user_id: userId, days, points: rows.map(row => ({
    t: Number(row.recorded_at), basic: Number(row.basic_score), contribution: Number(row.contribution_score),
    contest: Number(row.contest_score), practice: Number(row.practice_score)
  })) });
});

app.patch('/api/v2/me/user-tag', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (syzoj.userTagsEnabled === false) return api().fail(res, 404, 'USER_TAGS_DISABLED', 'The user-tag feature is disabled.');
  const state = syzoj.utils.getUserTagState ? await syzoj.utils.getUserTagState(user) : null;
  if (!state || !state.hasPermission) return api().fail(res, 403, 'USER_TAG_FORBIDDEN', 'You do not have permission to use a user tag.');
  const tagText = String(req.body && req.body.tag_text || '').trim();
  if (tagText.length > 12) return api().fail(res, 422, 'VALIDATION_FAILED', 'The user tag must not exceed 12 characters.', { tag_text: 'maximum 12 characters' });
  const visible = !!(req.body && (req.body.is_visible === true || req.body.is_visible === 'true' || req.body.is_visible === 'on'));
  const result = await contentTransaction(async manager => {
    const rows = await manager.query('SELECT user_id,is_disabled FROM user_tag WHERE user_id=? LIMIT 1 FOR UPDATE', [user.id]);
    if (rows.length && rows[0].is_disabled) throw contentDomain.contentError('USER_TAG_FORBIDDEN', 'You do not have permission to use a user tag.', 403);
    const now = Math.floor(Date.now() / 1000);
    if (rows.length) await manager.query('UPDATE user_tag SET tag_text=?,is_visible=?,updated_at=? WHERE user_id=?', [tagText, visible ? 1 : 0, now, user.id]);
    else await manager.query('INSERT INTO user_tag (user_id,tag_text,is_visible,is_disabled,granted_by,granted_at,updated_at) VALUES (?,?,?,0,NULL,?,?)', [user.id, tagText, visible ? 1 : 0, now, now]);
    const eventId = await contentDomain.appendEvent(manager, { stream: `user-tag:${user.id}`, type: 'user-tag.updated', aggregateId: user.id, actorId: user.id, payload: { tag_text: tagText, is_visible: visible } });
    return { eventId };
  });
  if (syzoj.utils.refreshUserTagsCache) await syzoj.utils.refreshUserTagsCache();
  return api().send(res, { tag_text: tagText, is_visible: visible, event_id: result.eventId });
});

app.get('/api/v2/admin/user-tags', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!await can(user, 'admin:user.manage')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: admin:user.manage.');
  const limit = api().parseLimit(req, 50, 100);
  const cursor = Number(api().decodeCursor(req.query.cursor) || 0);
  const rows = await TypeORM.getConnection().query(`SELECT tag.*,target.username,target.is_admin,
      granter.username AS granter_username,disabler.username AS disabler_username
    FROM user_tag tag LEFT JOIN user target ON target.id=tag.user_id
    LEFT JOIN user granter ON granter.id=tag.granted_by
    LEFT JOIN user disabler ON disabler.id=tag.disabled_by
    WHERE tag.user_id>? ORDER BY tag.user_id ASC LIMIT ?`, [cursor, limit + 1]);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  res.locals.apiMeta.limit = limit;
  res.locals.apiMeta.next_cursor = more ? api().encodeCursor(Number(page[page.length - 1].user_id)) : null;
  return api().send(res, page.map(serializeUserTag));
});

app.get('/api/v2/admin/user-tags/settings', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!await can(user, 'admin:user.manage')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: admin:user.manage.');
  if (!syzoj.utils.userTagSettings) return api().fail(res, 503, 'DEPENDENCY_UNAVAILABLE', 'The user-tag settings service is unavailable.');
  const resource = userTagSettingResource(await syzoj.utils.userTagSettings.read());
  api().setResourceEtag(res, resource);
  return api().send(res, resource);
});

app.patch('/api/v2/admin/user-tags/settings', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!await can(user, 'admin:config.write')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: admin:config.write.');
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Sign in again before changing the global user-tag setting.');
  if (!syzoj.utils.userTagSettings) return api().fail(res, 503, 'DEPENDENCY_UNAVAILABLE', 'The user-tag settings service is unavailable.');
  try {
    await syzoj.utils.userTagSettings.ensureSchema();
    const result = await contentTransaction(manager => contentDomain.updateUserTagGlobalSetting(manager, {
      actorId: user.id,
      enabled: req.body && req.body.enabled,
      ifMatch: current => api().ifMatch(req, userTagSettingResource(current)),
      recordAudit: auditRecorder(req)
    }));
    await syzoj.utils.refreshUserTagsCache();
    const resource = userTagSettingResource(await syzoj.utils.userTagSettings.read());
    api().setResourceEtag(res, resource);
    return api().send(res, { ...resource, changed: result.changed, audit_event_id: result.auditEventId, event_id: result.eventId });
  } catch (error) { return contentFailure(res, error); }
});

app.post('/api/v2/admin/user-tags/grants', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!await can(user, 'admin:user.manage')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: admin:user.manage.');
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Sign in again before granting user-tag access.');
  const body = req.body || {};
  let targetUserId = Number(body.user_id);
  if (!Number.isSafeInteger(targetUserId) || targetUserId < 1) {
    const username = String(body.username || '').trim();
    if (!username) return api().fail(res, 422, 'VALIDATION_FAILED', 'A user ID or username is required.', { user_id: 'user ID or username required' });
    const users = await TypeORM.getConnection().query('SELECT id FROM user WHERE username=? LIMIT 1', [username]);
    if (!users.length) return api().fail(res, 404, 'USER_NOT_FOUND', 'User was not found.');
    targetUserId = Number(users[0].id);
  }
  try {
    const result = await contentTransaction(manager => contentDomain.grantUserTag(manager, { targetUserId, actorId: user.id, now: Math.floor(Date.now() / 1000), recordAudit: auditRecorder(req) }));
    if (syzoj.utils.refreshUserTagsCache) await syzoj.utils.refreshUserTagsCache();
    return api().send(res, { user: { id: Number(result.user.id), username: result.user.username }, restored: result.restored, audit_event_id: result.auditEventId, event_id: result.eventId }, result.restored ? 200 : 201);
  } catch (error) { return contentFailure(res, error); }
});

app.post('/api/v2/admin/user-tags/:id/disable', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!await can(user, 'admin:user.manage')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: admin:user.manage.');
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Sign in again before disabling user-tag access.');
  try {
    const result = await contentTransaction(manager => contentDomain.disableUserTag(manager, { targetUserId: req.params.id, actorId: user.id, reason: req.body && req.body.reason, now: Math.floor(Date.now() / 1000), recordAudit: auditRecorder(req) }));
    if (syzoj.utils.refreshUserTagsCache) await syzoj.utils.refreshUserTagsCache();
    return api().send(res, { user: { id: Number(result.user.id), username: result.user.username }, is_disabled: true, changed: result.changed, audit_event_id: result.auditEventId, event_id: result.eventId });
  } catch (error) { return contentFailure(res, error); }
});

app.get('/api/v2/discussions', async (req, res) => { const limit = api().parseLimit(req, 30, 100); const cursor = Number(api().decodeCursor(req.query.cursor) || 0); const hasProblemFilter = req.query.problem_id != null && req.query.problem_id !== ''; const problemId = hasProblemFilter ? Number(req.query.problem_id) : null; if (hasProblemFilter && (!Number.isSafeInteger(problemId) || problemId < 1)) return api().fail(res, 422, 'VALIDATION_FAILED', 'Problem ID must be a positive integer.', { problem_id: 'positive integer required' }); const access = await discussionVisibility(res.locals.user); const visibility = discussionVisibilityFilter(access); const params = [cursor, ...visibility.params]; const problemFilter = problemId ? 'AND article.problem_id=?' : ''; if (problemId) params.push(problemId); params.push(limit + 1); const rows = await TypeORM.getConnection().query(`SELECT article.id,article.title,article.content,article.user_id,article.problem_id,article.public_time,article.update_time,article.comments_num,article.allow_comment,u.username FROM article INNER JOIN user u ON u.id=article.user_id LEFT JOIN problem ON problem.id=article.problem_id WHERE article.id>? ${visibility.sql} ${problemFilter} ORDER BY article.id ASC LIMIT ?`, params); const more = rows.length > limit; res.locals.apiMeta.limit = limit; res.locals.apiMeta.next_cursor = more ? api().encodeCursor(rows[limit - 1].id) : null; return api().send(res, rows.slice(0, limit).map(row => ({ id: Number(row.id), title: row.title, content: row.content, problem_id: row.problem_id == null ? null : Number(row.problem_id), author: { id: Number(row.user_id), username: row.username }, replies: Number(row.comments_num || 0), locked: !row.allow_comment, created_at: time(row.public_time), updated_at: time(row.update_time) }))); });
app.post('/api/v2/discussions', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user, 'discussion:create')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: discussion:create.'); const access = await discussionVisibility(user); const isModerator = await can(user, 'discussion:moderate'); try { const result = await contentTransaction(manager => contentDomain.createDiscussion(manager, { actorId: user.id, title: req.body && req.body.title, content: req.body && req.body.content, problemId: req.body && req.body.problem_id, isNotice: req.body && req.body.is_notice, canSetNotice: isModerator, canUseHiddenProblem: access.unrestricted, allowedProblemIds: access.problemIds, now: Math.floor(Date.now() / 1000) })); return api().send(res, { id: result.id, title: result.title, content: result.content, problem_id: result.problemId, is_notice: isModerator && !!(req.body && req.body.is_notice), author: { id: Number(user.id), username: user.username }, replies: 0, locked: false, created_at: time(result.now), event_id: result.eventId }, 201); } catch (error) { return contentFailure(res, error); } });
app.get('/api/v2/discussions/:id/revision', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  const discussionId = Number(req.params.id);
  if (!Number.isSafeInteger(discussionId) || discussionId < 1) return api().fail(res, 404, 'DISCUSSION_NOT_FOUND', 'Discussion was not found.');
  const rows = await TypeORM.getConnection().query(
    'SELECT id,title,content,user_id,problem_id,is_notice,update_time FROM article WHERE id=? LIMIT 1',
    [discussionId]
  );
  if (!rows.length) return api().fail(res, 404, 'DISCUSSION_NOT_FOUND', 'Discussion was not found.');
  const isModerator = await can(user, 'discussion:moderate');
  if (!isModerator && Number(rows[0].user_id) !== Number(user.id)) return api().fail(res, 403, 'DISCUSSION_FORBIDDEN', 'You cannot edit this discussion.');
  return api().send(res, rows[0]);
});
app.patch('/api/v2/discussions/:id', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  const isModerator = await can(user, 'discussion:moderate');
  try {
    const result = await contentTransaction(manager => contentDomain.updateDiscussion(manager, {
      discussionId: req.params.id,
      actorId: user.id,
      title: req.body && req.body.title,
      content: req.body && req.body.content,
      isNotice: req.body && req.body.is_notice,
      isModerator,
      now: Math.floor(Date.now() / 1000),
      ifMatch: current => api().ifMatch(req, current)
    }));
    return api().send(res, { id: result.id, title: result.title, content: result.content, problem_id: result.problemId, is_notice: result.isNotice, updated_at: time(result.now), event_id: result.eventId });
  } catch (error) { return contentFailure(res, error); }
});
app.get('/api/v2/discussions/:id', async (req, res) => { const discussionId = Number(req.params.id); if (!Number.isSafeInteger(discussionId) || discussionId < 1) return api().fail(res, 404, 'DISCUSSION_NOT_FOUND', 'Discussion was not found.'); const access = await discussionVisibility(res.locals.user); const visibility = discussionVisibilityFilter(access); const rows = await TypeORM.getConnection().query(`SELECT article.*,u.username FROM article INNER JOIN user u ON u.id=article.user_id LEFT JOIN problem ON problem.id=article.problem_id WHERE article.id=? ${visibility.sql} LIMIT 1`, [discussionId, ...visibility.params]); if (!rows.length) return api().fail(res, 404, 'DISCUSSION_NOT_FOUND', 'Discussion was not found.'); const limit = api().parseLimit(req, 50, 100); const cursor = Number(api().decodeCursor(req.query.cursor) || 0); const replies = await TypeORM.getConnection().query('SELECT reply.id,reply.content,reply.user_id,reply.public_time,u.username FROM article_comment reply INNER JOIN user u ON u.id=reply.user_id WHERE reply.article_id=? AND reply.id>? ORDER BY reply.id ASC LIMIT ?', [discussionId, cursor, limit + 1]); const more = replies.length > limit; const page = replies.slice(0, limit); res.locals.apiMeta.limit = limit; res.locals.apiMeta.next_cursor = more ? api().encodeCursor(Number(page[page.length - 1].id)) : null; const row = rows[0]; return api().send(res, { id: Number(row.id), title: row.title, content: row.content, problem_id: row.problem_id == null ? null : Number(row.problem_id), author: { id: Number(row.user_id), username: row.username }, locked: !row.allow_comment, created_at: time(row.public_time), updated_at: time(row.update_time), replies: page.map(reply => ({ id: Number(reply.id), content: reply.content, author: { id: Number(reply.user_id), username: reply.username }, created_at: time(reply.public_time) })) }); });
app.post('/api/v2/discussions/:id/replies', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const isModerator = await can(user, 'discussion:moderate'); if (!isModerator && !await can(user, 'discussion:create')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: discussion:create.'); const access = await discussionVisibility(user); try { const result = await contentTransaction(manager => contentDomain.replyToDiscussion(manager, { discussionId: req.params.id, actorId: user.id, content: req.body && req.body.content, isModerator, canViewHiddenProblem: access.unrestricted, allowedProblemIds: access.problemIds, now: Math.floor(Date.now() / 1000) })); return api().send(res, { id: result.id, discussion_id: result.discussionId, content: result.content, author: { id: Number(user.id), username: user.username }, created_at: time(result.now), event_id: result.eventId }, 201); } catch (error) { return contentFailure(res, error); } });
app.delete('/api/v2/discussions/:id', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const isModerator = await can(user, 'discussion:moderate'); try { const result = await contentTransaction(manager => contentDomain.deleteDiscussion(manager, { discussionId: req.params.id, actorId: user.id, isModerator, recordAudit: auditRecorder(req) })); return api().send(res, { id: result.id, problem_id: result.problemId, deleted: true, audit_event_id: result.auditEventId, event_id: result.eventId }); } catch (error) { return contentFailure(res, error); } });
app.delete('/api/v2/discussions/:id/replies/:replyId', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const isModerator = await can(user, 'discussion:moderate'); try { const result = await contentTransaction(manager => contentDomain.deleteDiscussionReply(manager, { discussionId: req.params.id, replyId: req.params.replyId, actorId: user.id, isModerator, recordAudit: auditRecorder(req) })); return api().send(res, { id: result.id, discussion_id: result.discussionId, deleted: true, audit_event_id: result.auditEventId, event_id: result.eventId }); } catch (error) { return contentFailure(res, error); } });
app.post('/api/v2/discussions/:id/lock', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const isModerator = await can(user, 'discussion:moderate'); if (!isModerator) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: discussion:moderate.'); const locked = !req.body || req.body.locked == null ? true : !!req.body.locked; try { const result = await contentTransaction(manager => contentDomain.setDiscussionLock(manager, { discussionId: req.params.id, actorId: user.id, isModerator, locked, now: Math.floor(Date.now() / 1000), reason: syzoj.utils.operationReason(req, locked ? '锁定讨论' : '解除讨论锁定'), recordAudit: auditRecorder(req) })); return api().send(res, { id: result.id, locked: result.locked, changed: result.changed, audit_event_id: result.auditEventId, event_id: result.eventId }); } catch (error) { return contentFailure(res, error); } });

app.get(['/api/v2/messages/conversations', '/api/v2/messages'], async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user, 'message:own')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: message:own.'); const limit = api().parseLimit(req, 30, 100); try { const result = await contentDomain.listConversations(TypeORM.getConnection(), { userId: user.id, limit, cursor: api().decodeCursor(req.query.cursor) }); res.locals.apiMeta.limit = limit; res.locals.apiMeta.next_cursor = result.nextCursor ? api().encodeCursor(result.nextCursor) : null; return api().send(res, result.rows.map(row => ({ user: { id: Number(row.user_id), username: row.username }, unread: Number(row.unread || 0), last_message_at: time(row.last_time) }))); } catch (error) { return contentFailure(res, error); } });
app.get('/api/v2/messages/with/:id', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user, 'message:own')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: message:own.'); const limit = api().parseLimit(req, 50, 200); try { const result = await contentTransaction(manager => contentDomain.readConversation(manager, { userId: user.id, peerId: req.params.id, limit, beforeId: api().decodeCursor(req.query.cursor) })); res.locals.apiMeta.limit = limit; res.locals.apiMeta.next_cursor = result.nextCursor ? api().encodeCursor(result.nextCursor) : null; return api().send(res, result.rows.map(row => ({ id: Number(row.id), sender_id: Number(row.sender_id), receiver_id: Number(row.receiver_id), content: row.content, is_read: !!row.is_read, created_at: time(row.public_time) }))); } catch (error) { return contentFailure(res, error); } });
app.post(['/api/v2/messages/with/:id', '/api/v2/messages/conversations/:id/messages'], async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user, 'message:own')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: message:own.'); const access = await messageSendAccess(user, res); if (!access) return; const now = Math.floor(Date.now() / 1000); try { const result = await contentTransaction(manager => contentDomain.sendMessage(manager, { senderId: user.id, receiverId: req.params.id, content: req.body && req.body.content, bypassRecipientPolicy: access.bypassRecipientPolicy, now })); return api().send(res, { id: result.id, sender_id: result.senderId, receiver_id: result.receiverId, content: result.content, is_read: false, created_at: time(now), event_id: result.eventId }, 201); } catch (error) { return contentFailure(res, error); } });
app.delete('/api/v2/messages/:id', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user, 'message:own')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: message:own.'); try { const result = await contentTransaction(manager => contentDomain.deleteMessageForUser(manager, { messageId: req.params.id, userId: user.id })); return api().send(res, { id: result.id, peer_id: result.peerId, deleted: true, permanently_deleted: result.permanentlyDeleted, event_id: result.eventId }); } catch (error) { return contentFailure(res, error); } });
app.delete('/api/v2/messages/conversations/:id', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user, 'message:own')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: message:own.'); try { const result = await contentTransaction(manager => contentDomain.deleteConversationForUser(manager, { peerId: req.params.id, userId: user.id })); return api().send(res, { peer_id: result.peerId, deleted: result.deleted, event_id: result.eventId }); } catch (error) { return contentFailure(res, error); } });
app.get('/api/v2/messages/settings', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user, 'message:own')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: message:own.'); const rows = await TypeORM.getConnection().query('SELECT disable_messages,update_time FROM user_message_setting WHERE user_id=? LIMIT 1', [user.id]); return api().send(res, messageSettingsResource(rows[0])); });
app.patch('/api/v2/messages/settings', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user, 'message:own')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: message:own.'); try { const result = await contentTransaction(manager => contentDomain.updateMessageSettings(manager, { userId: user.id, disabled: req.body && req.body.disable_messages, now: Math.floor(Date.now() / 1000), ifMatch: current => api().ifMatch(req, messageSettingsResource(current)) })); return api().send(res, { disable_messages: result.disabled, updated_at: time(result.now), event_id: result.eventId }); } catch (error) { return contentFailure(res, error); } });

app.get('/api/v2/clipboard', async (req, res) => {
  const user = res.locals.user;
  if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!await can(user, 'clipboard:own')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: clipboard:own.');
  const limit = api().parseLimit(req, 30, 100);
  const cursor = api().decodeCursor(req.query.cursor) || {};
  const clauses = ['user_id=?'];
  const params = [user.id];
  if (Number(cursor.updated_at) > 0) {
    const updatedAt = Number(cursor.updated_at);
    clauses.push('(update_time<? OR (update_time=? AND id<?))');
    params.push(updatedAt, updatedAt, Number(cursor.id || 0));
  }
  params.push(limit + 1);
  const rows = await TypeORM.getConnection().query(`SELECT * FROM clipboard_item WHERE ${clauses.join(' AND ')} ORDER BY update_time DESC,id DESC LIMIT ?`, params);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  res.locals.apiMeta.limit = limit;
  res.locals.apiMeta.next_cursor = more && last ? api().encodeCursor({ updated_at: Number(last.update_time), id: Number(last.id) }) : null;
  return api().send(res, page.map(serializeClipboard));
});
app.get('/api/v2/clipboard/:id', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user, 'clipboard:own')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: clipboard:own.'); const rows = await TypeORM.getConnection().query('SELECT * FROM clipboard_item WHERE id=? AND user_id=? LIMIT 1', [Number(req.params.id), user.id]); if (!rows.length) return api().fail(res, 404, 'CLIPBOARD_NOT_FOUND', 'Clipboard item was not found.'); return api().send(res, serializeClipboard(rows[0])); });
app.post('/api/v2/clipboard', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user, 'clipboard:own')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: clipboard:own.'); try { const item = await contentTransaction(manager => contentDomain.createClipboard(manager, { actorId: user.id, title: req.body && req.body.title, content: req.body && req.body.content, visibility: req.body && req.body.visibility, shareExpires: req.body && req.body.share_expires, now: Math.floor(Date.now() / 1000), generateToken: generateClipboardToken, recordAudit: auditRecorder(req) })); return api().send(res, Object.assign(serializeClipboard(item), { audit_event_id: item.auditEventId, event_id: item.eventId }), 201); } catch (error) { return contentFailure(res, error); } });
app.patch('/api/v2/clipboard/:id', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user, 'clipboard:own')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: clipboard:own.'); try { const item = await contentTransaction(manager => contentDomain.updateClipboard(manager, { clipboardId: req.params.id, actorId: user.id, patch: req.body || {}, now: Math.floor(Date.now() / 1000), generateToken: generateClipboardToken, ifMatch: current => api().ifMatch(req, serializeClipboard(current)), recordAudit: auditRecorder(req) })); return api().send(res, Object.assign(serializeClipboard(item), { audit_event_id: item.auditEventId, event_id: item.eventId })); } catch (error) { return contentFailure(res, error); } });
app.post('/api/v2/clipboard/:id/share', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user, 'clipboard:own')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: clipboard:own.'); try { const item = await contentTransaction(manager => contentDomain.shareClipboard(manager, { clipboardId: req.params.id, actorId: user.id, expiresInDays: req.body && req.body.expires_in_days, now: Math.floor(Date.now() / 1000), generateToken: generateClipboardToken, ifMatch: current => api().ifMatch(req, serializeClipboard(current)), recordAudit: auditRecorder(req) })); return api().send(res, Object.assign(serializeClipboard(item), { audit_event_id: item.auditEventId, event_id: item.eventId })); } catch (error) { return contentFailure(res, error); } });
app.get('/api/v2/clipboard/shared/:token', async (req, res) => { try { const item = await contentDomain.readSharedClipboard(TypeORM.getConnection(), { token: req.params.token, now: Math.floor(Date.now() / 1000) }); return api().send(res, serializeClipboard(item)); } catch (error) { return contentFailure(res, error); } });
app.delete('/api/v2/clipboard/:id', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user, 'clipboard:own')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: clipboard:own.'); try { const result = await contentTransaction(manager => contentDomain.deleteClipboard(manager, { clipboardId: req.params.id, actorId: user.id, ifMatch: current => api().ifMatch(req, serializeClipboard(current)), recordAudit: auditRecorder(req) })); return api().send(res, { id: result.id, deleted: true, audit_event_id: result.auditEventId, event_id: result.eventId }); } catch (error) { return contentFailure(res, error); } });

async function listTickets(req, res, requireManager = false) { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const admin = await can(user, 'ticket:manage'); if (requireManager && !admin) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: ticket:manage.'); const limit = api().parseLimit(req, 30, 100); const cursor = api().decodeCursor(req.query.cursor); const clauses = []; const params = []; if (!admin) { clauses.push('creator_id=?'); params.push(user.id); } if (cursor && Number(cursor.updated_at) > 0) { clauses.push('(updated_at<? OR (updated_at=? AND id<?))'); const before = Number(cursor.updated_at); params.push(before, before, Number(cursor.id || 0)); } params.push(limit + 1); const rows = await TypeORM.getConnection().query(`SELECT id,title,category,status,creator_id,assignee_id,created_at,updated_at FROM ticket ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY updated_at DESC,id DESC LIMIT ?`, params); const more = rows.length > limit; const page = rows.slice(0, limit); const last = page[page.length - 1]; res.locals.apiMeta.limit = limit; res.locals.apiMeta.next_cursor = more && last ? api().encodeCursor({ updated_at: Number(last.updated_at), id: Number(last.id) }) : null; return api().send(res, page.map(row => ({ id: Number(row.id), title: row.title, category: row.category, status: row.status, creator_id: Number(row.creator_id), assignee_id: row.assignee_id == null ? null : Number(row.assignee_id), created_at: time(row.created_at), updated_at: time(row.updated_at) }))); }
app.get('/api/v2/tickets', (req, res) => listTickets(req, res));
app.get('/api/v2/admin/tickets', (req, res) => listTickets(req, res, true));
app.get('/api/v2/tickets/relation-search', async (req, res) => {
  if (!res.locals.user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  const type = String(req.query.type || '');
  const query = String(req.query.q || '').trim().slice(0, 120);
  if (!query) return api().send(res, []);
  const sources = {
    problem: { table: 'problem', label: "CONCAT('#',id,'. ',title)", visible: 'is_public=1' },
    contest: { table: 'contest', label: 'title', visible: '1=1' },
    article: { table: 'article', label: 'title', visible: '1=1' },
    user: { table: 'user', label: "CONCAT(username,' (UID ',id,')')", visible: '1=1', search: 'username' }
  };
  const source = sources[type];
  if (!source) return api().fail(res, 422, 'VALIDATION_FAILED', 'The relation type is invalid.', { type: 'problem, contest, article, or user required' });
  const numericId = Number(query);
  let rows = [];
  if (Number.isSafeInteger(numericId) && numericId > 0) {
    rows = await TypeORM.getConnection().query(`SELECT id,${source.label} AS name FROM ${source.table} WHERE id=? AND ${source.visible} LIMIT 1`, [numericId]);
  }
  if (!rows.length && (type === 'user' || query.length >= 2)) {
    rows = await TypeORM.getConnection().query(`SELECT id,${source.label} AS name FROM ${source.table} WHERE ${source.visible} AND ${source.search || 'title'} LIKE ? ORDER BY id ASC LIMIT 10`, [`%${query}%`]);
  }
  res.set('Cache-Control', 'no-store');
  return api().send(res, rows.map(row => ({ id: Number(row.id), name: row.name })));
});
app.get('/api/v2/tickets/:id', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const rows = await TypeORM.getConnection().query(`SELECT ticket.*,creator.username AS creator_username,assignee.username AS assignee_username FROM ticket INNER JOIN user creator ON creator.id=ticket.creator_id LEFT JOIN user assignee ON assignee.id=ticket.assignee_id WHERE ticket.id=? LIMIT 1`, [Number(req.params.id)]); if (!rows.length) return api().fail(res, 404, 'TICKET_NOT_FOUND', 'Ticket was not found.'); const row = rows[0]; const isManager = await ticketManagerAccess(user, row); if (Number(row.creator_id) !== Number(user.id) && !isManager) return api().fail(res, 403, 'TICKET_FORBIDDEN', 'You cannot view this ticket.'); const limit = api().parseLimit(req, 50, 100); const cursor = Number(api().decodeCursor(req.query.cursor) || 0); const replies = await TypeORM.getConnection().query(`SELECT reply.id,reply.user_id,reply.content,reply.is_internal,reply.created_at,u.username FROM ticket_reply reply INNER JOIN user u ON u.id=reply.user_id WHERE reply.ticket_id=? AND reply.id>? ${isManager ? '' : 'AND reply.is_internal=0'} ORDER BY reply.id ASC LIMIT ?`, [row.id, cursor, limit + 1]); const more = replies.length > limit; const page = replies.slice(0, limit); res.locals.apiMeta.limit = limit; res.locals.apiMeta.next_cursor = more ? api().encodeCursor(Number(page[page.length - 1].id)) : null; return api().send(res, { id: Number(row.id), title: row.title, description: row.description, category: row.category, subtype: row.subtype, status: row.status, creator: { id: Number(row.creator_id), username: row.creator_username }, assignee: row.assignee_id == null ? null : { id: Number(row.assignee_id), username: row.assignee_username }, created_at: time(row.created_at), updated_at: time(row.updated_at), replies: page.map(reply => ({ id: Number(reply.id), content: reply.content, is_internal: !!reply.is_internal, author: { id: Number(reply.user_id), username: reply.username }, created_at: time(reply.created_at) })) }); });
app.post('/api/v2/tickets', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); if (!await can(user, 'ticket:create')) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: ticket:create.'); const isManager = await can(user, 'ticket:manage'); try { const body = req.body || {}; const result = await contentTransaction(manager => contentDomain.createTicket(manager, { creatorId: user.id, isManager, title: body.title, description: body.description, category: body.category, subtype: body.subtype, relationId: body.relation_id, reportReason: body.report_reason, now: Math.floor(Date.now() / 1000), recordAudit: auditRecorder(req) })); return api().send(res, { id: result.id, title: result.title, status: result.status, category: result.category, subtype: result.subtype, relation_type: result.relationType, relation_id: result.relationId, created_at: time(result.now), audit_event_id: result.auditEventId, event_id: result.eventId }, 201); } catch (error) { return contentFailure(res, error); } });
app.post('/api/v2/tickets/:id/replies', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const accessRows = await TypeORM.getConnection().query('SELECT id,creator_id FROM ticket WHERE id=? LIMIT 1', [Number(req.params.id)]); const isManager = accessRows.length ? await ticketManagerAccess(user, accessRows[0]) : false; try { const result = await contentTransaction(manager => contentDomain.replyToTicket(manager, { ticketId: req.params.id, actorId: user.id, actorName: user.username, isManager, isInternal: !!(req.body && req.body.is_internal === true), content: req.body && req.body.content, now: Math.floor(Date.now() / 1000) })); return api().send(res, { id: result.id, ticket_id: result.ticketId, content: result.content, is_internal: result.isInternal, status: result.status, created_at: time(result.now), notification_id: result.notificationId, event_id: result.eventId }, 201); } catch (error) { return contentFailure(res, error); } });
app.post('/api/v2/tickets/:id/assign', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const accessRows = await TypeORM.getConnection().query('SELECT id,creator_id FROM ticket WHERE id=? LIMIT 1', [Number(req.params.id)]); if (!accessRows.length) return api().fail(res, 404, 'TICKET_NOT_FOUND', 'Ticket was not found.'); const isManager = await ticketManagerAccess(user, accessRows[0]); if (!isManager) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: ticket:manage.'); const assigneeId = !req.body || req.body.assignee_id == null ? Number(user.id) : Number(req.body.assignee_id); const assignee = Number.isSafeInteger(assigneeId) && assigneeId > 0 ? await syzoj.model('user').findById(assigneeId) : null; if (!assignee || !await ticketManagerAccess(assignee, accessRows[0])) return api().fail(res, 422, 'TICKET_ASSIGNEE_INELIGIBLE', 'The assignee must be a ticket manager.', { assignee_id: 'ticket manager required' }); try { const result = await contentTransaction(manager => contentDomain.assignTicket(manager, { ticketId: req.params.id, actorId: user.id, assigneeId, assigneeName: assignee.username, isManager, now: Math.floor(Date.now() / 1000), reason: syzoj.utils.operationReason(req, '认领或转交工单'), recordAudit: auditRecorder(req) })); return api().send(res, { id: result.id, assignee_id: result.assigneeId, status: result.status, audit_event_id: result.auditEventId, event_id: result.eventId }); } catch (error) { return contentFailure(res, error); } });
app.post('/api/v2/admin/tickets/:id/status', async (req, res) => { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const accessRows = await TypeORM.getConnection().query('SELECT id,creator_id FROM ticket WHERE id=? LIMIT 1', [Number(req.params.id)]); if (!accessRows.length) return api().fail(res, 404, 'TICKET_NOT_FOUND', 'Ticket was not found.'); const isManager = await ticketManagerAccess(user, accessRows[0]); if (!isManager) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: ticket:manage.'); try { const result = await contentTransaction(manager => contentDomain.setTicketStatus(manager, { ticketId: req.params.id, actorId: user.id, actorName: user.username, isManager, status: req.body && req.body.status, now: Math.floor(Date.now() / 1000), reason: syzoj.utils.operationReason(req, '更新工单状态'), recordAudit: auditRecorder(req) })); return api().send(res, { id: result.id, status: result.status, changed: result.changed, notification_id: result.notificationId, audit_event_id: result.auditEventId, event_id: result.eventId }); } catch (error) { return contentFailure(res, error); } });
async function closeTicket(req, res, requireManager = false) { const user = res.locals.user; if (!user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.'); const accessRows = await TypeORM.getConnection().query('SELECT id,creator_id FROM ticket WHERE id=? LIMIT 1', [Number(req.params.id)]); if (!accessRows.length) return api().fail(res, 404, 'TICKET_NOT_FOUND', 'Ticket was not found.'); const isManager = await ticketManagerAccess(user, accessRows[0]); if (requireManager && !isManager) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: ticket:manage.'); if (requireManager && !syzoj.utils.authorizationV2.recentLoginSatisfied(req)) return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Sign in again before closing a ticket as an administrator.'); try { const result = await contentTransaction(manager => contentDomain.closeTicket(manager, { ticketId: req.params.id, actorId: user.id, isManager, requireManager, now: Math.floor(Date.now() / 1000), reason: syzoj.utils.operationReason(req, requireManager ? '管理员关闭工单' : '用户关闭工单'), recordAudit: auditRecorder(req) })); return api().send(res, { id: result.id, status: result.status, audit_event_id: result.auditEventId, event_id: result.eventId }); } catch (error) { return contentFailure(res, error); } }
app.post('/api/v2/tickets/:id/close', (req, res) => closeTicket(req, res));
app.post('/api/v2/admin/tickets/:id/close', (req, res) => closeTicket(req, res, true));
