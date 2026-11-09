'use strict';

const TypeORM = require('typeorm');
const { createService, deliverNotification, exportCsv } = require('../libs/activities');
const { ensureRegistrationProfileSchema } = require('../libs/registration-profile-schema');
const { appendEvent } = require('../libs/content-domain');
const service = createService({
  connection: () => TypeORM.getConnection(),
  authorize: user => syzoj.utils.authorizationV2.authorize(user, 'activity:manage', null, { scope: 'global' }),
  notify: (db, input) => deliverNotification(db, input, appendEvent),
  audit: async (db, event, req) => {
    await syzoj.utils.authorizationV2.recordAudit(req, { action: event.action, resourceType: 'activity', resourceId: event.activityId, scope: 'global', details: { registration_id: event.registrationId || null, status: event.status || null } }, db);
    await appendEvent(db, { stream: 'activities', type: event.action, aggregateId: String(event.activityId), actorId: event.actorId, payload: { registration_id: event.registrationId || null } });
  }
});

async function prepare() {
  await ensureRegistrationProfileSchema();
  await syzoj.utils.ensureTemporaryContestAccountSchema();
  await syzoj.utils.apiV2.ensureFoundationSchema();
  await service.ensureSchema();
}
function endpoint(fn) {
  return async (req, res, next) => {
    try {
      await prepare();
      const data = await fn(req, res, res.locals.user);
      if (!res.headersSent) syzoj.utils.apiV2.send(res, data);
    } catch (error) {
      if (!error.statusCode) return next(error);
      return syzoj.utils.apiV2.fail(res, error.statusCode, error.statusCode === 409 ? 'ACTIVITY_CONFLICT' : 'ACTIVITY_REQUEST_FAILED', error.message);
    }
  };
}
function activityId(req) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) throw Object.assign(new Error('活动不存在。'), { statusCode: 404 });
  return id;
}
async function page(req, res, mode) {
  res.set('Cache-Control', 'private, no-store');
  try {
    await prepare();
    if (mode === 'new' && !await service.canManage(res.locals.user)) throw Object.assign(new Error('您没有活动管理权限。'), { statusCode: res.locals.user ? 403 : 401 });
    if (mode === 'detail') await service.detail(activityId(req), res.locals.user);
    return res.render('activities', { activityPage: mode, activityId: mode === 'detail' ? activityId(req) : 0, activityManager: await service.canManage(res.locals.user) });
  } catch (error) { res.status(error.statusCode || 500).render('error', { err: error }); }
}
app.get('/activities', (req, res) => page(req, res, 'list'));
app.get('/activities/new', (req, res) => page(req, res, 'new'));
app.get('/activities/:id', (req, res) => page(req, res, 'detail'));
app.get('/api/v2/activities', endpoint((req, res, user) => service.list(user, req.query.page || 1, req.query)));
app.post('/api/v2/activities', endpoint((req, res, user) => service.create(user, req.body, req)));
app.get('/api/v2/activities/:id', endpoint(async (req, res, user) => {
  const data = await service.detail(activityId(req), user);
  data.description_html = await syzoj.utils.markdown(data.activity.description);
  return data;
}));
app.patch('/api/v2/activities/:id', endpoint((req, res, user) => service.update(activityId(req), user, req.body, req)));
app.delete('/api/v2/activities/:id', endpoint((req, res, user) => service.remove(activityId(req), user, req.body, req)));
app.post('/api/v2/activities/:id/copy', endpoint((req, res, user) => service.copy(activityId(req), user, req)));
app.post('/api/v2/activities/:id/registrations', endpoint((req, res, user) => service.start(activityId(req), user, req.body, req)));
app.post('/api/v2/activities/:id/registration/action', endpoint((req, res, user) => service.change(activityId(req), user, req.body, req)));
app.post('/api/v2/activities/:id/invitations/:invitationId', endpoint((req, res, user) => service.invitation(activityId(req), Number(req.params.invitationId), user, req.body, req)));
app.get('/api/v2/activities/:id/registrations', endpoint((req, res, user) => service.roster(activityId(req), user, req.query)));
app.get('/api/v2/activities/:id/registrations/export', endpoint(async (req, res, user) => {
  const data = await service.roster(activityId(req), user, { ...req.query, export: true });
  await syzoj.utils.authorizationV2.recordAudit(req, { action: 'activity:registration.export', resourceType: 'activity', resourceId: activityId(req), details: { count: data.total } });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="activity-${activityId(req)}.csv"`);
  res.send(exportCsv(data.activity, data.items));
}));
app.post('/api/v2/activities/:id/registrations/:registrationId/review', endpoint((req, res, user) => service.review(activityId(req), Number(req.params.registrationId), user, req.body, req)));
