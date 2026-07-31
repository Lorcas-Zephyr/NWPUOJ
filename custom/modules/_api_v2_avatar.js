'use strict';

const User = syzoj.model('user');
const avatar = syzoj.utils.userAvatarV2;

async function authorizeAvatar(req, res, next) {
  const targetId = Number(req.params.id);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) return syzoj.utils.apiV2.fail(res, 422, 'VALIDATION_FAILED', 'A positive user ID is required.', { id: 'positive integer required' });
  if (!await avatar.canManageAvatar(res.locals.user, targetId)) return syzoj.utils.apiV2.fail(res, res.locals.user ? 403 : 401, res.locals.user ? 'CAPABILITY_REQUIRED' : 'AUTHENTICATION_REQUIRED', res.locals.user ? 'Capability required: profile:edit or admin:user.manage.' : 'Authentication is required.');
  const target = await User.findById(targetId);
  if (!target) return syzoj.utils.apiV2.fail(res, 404, 'USER_NOT_FOUND', 'User was not found.');
  req.avatarTarget = target;
  next();
}

app.post('/api/v2/users/:id/avatar', authorizeAvatar, avatar.receiveAvatarApi, async (req, res) => {
  if (!req.file) return syzoj.utils.apiV2.fail(res, 422, 'AVATAR_UPLOAD_INVALID', 'Choose an avatar image.');
  try {
    const result = await avatar.updateAvatar(Number(req.avatarTarget.id), req.file, req);
    if (result.auditEventId) res.set('X-Audit-Event-ID', String(result.auditEventId));
    return syzoj.utils.apiV2.send(res, {
      user_id: Number(req.avatarTarget.id),
      image_url: result.imagePath,
      audit_event_id: result.auditEventId,
      event_id: result.eventId
    }, 201);
  } catch (error) {
    avatar.cleanupFile(req.file && req.file.path);
    return syzoj.utils.apiV2.fail(res, error.statusCode || 422, error.code || 'AVATAR_UPLOAD_INVALID', error.message || 'Avatar upload failed.');
  }
});

app.delete('/api/v2/users/:id/avatar', authorizeAvatar, async (req, res) => {
  try {
    const result = await avatar.removeAvatar(Number(req.avatarTarget.id), req);
    if (result.auditEventId) res.set('X-Audit-Event-ID', String(result.auditEventId));
    return syzoj.utils.apiV2.send(res, {
      user_id: Number(req.avatarTarget.id),
      image_url: syzoj.utils.avatar(req.avatarTarget),
      audit_event_id: result.auditEventId,
      event_id: result.eventId
    });
  } catch (error) {
    return syzoj.utils.apiV2.fail(res, error.statusCode || 409, error.code || 'AVATAR_DELETE_FAILED', error.message || 'Avatar deletion failed.');
  }
});
