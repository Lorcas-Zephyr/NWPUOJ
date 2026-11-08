'use strict';

const TypeORM = require('typeorm');
const { listLogins } = require('../libs/login-ip');
const authorization = () => syzoj.utils.authorizationV2;

app.get('/admin/ip', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    if (!res.locals.user || !await authorization().authorize(res.locals.user, 'admin:audit.read', null, { req })) {
      return res.status(res.locals.user ? 403 : 401).render('error', { err: new Error('需要登录并具备登录审计查看权限。') });
    }
    return res.render('admin_ip');
  } catch (error) { syzoj.log(error); return res.status(500).render('error', { err: new Error('暂时无法读取 IP 管理页面。') }); }
});

app.get('/api/v2/admin/login-ips', async (req, res) => {
  const api = syzoj.utils.apiV2;
  res.set('Cache-Control', 'private, no-store');
  try {
    if (!res.locals.user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', '请先登录。');
    if (!await authorization().authorize(res.locals.user, 'admin:audit.read', null, { req })) return api.fail(res, 403, 'CAPABILITY_REQUIRED', '没有登录审计查看权限。');
    await authorization().ensureSchema();
    return api.send(res, await listLogins(TypeORM.getConnection(), req.query));
  } catch (error) {
    if (!error.statusCode) syzoj.log('[login-ip] ' + (error.stack || error.message));
    return api.fail(res, error.statusCode || 500, error.code || 'LOGIN_IP_UNAVAILABLE', error.statusCode ? error.message : '暂时无法读取登录记录。');
  }
});
