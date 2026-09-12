'use strict';

const TypeORM = require('typeorm');
const orchestrator = require('../libs/ai-contest-orchestrator');

function api() { return syzoj.utils.apiV2; }
function isSiteAdmin(res) { return !!(res && res.locals && res.locals.user && (res.locals.user.is_admin || res.locals.isSiteOwner)); }
async function canManageContest(contest, user) {
  if (!contest || !user) return false;
  return syzoj.utils.authorizationV2.authorize(user, 'contest:edit', { id: Number(contest.id), ownerId: Number(contest.holder_id), scope: `contest:${contest.id}` }, { scope: `contest:${contest.id}` });
}
function errorResponse(res, error) { return api().fail(res, error.statusCode || 500, error.code || 'AI_CONTEST_FAILED', error.message || 'AI 比赛操作失败。'); }

app.get('/admin/ai', async (req, res) => {
  if (!isSiteAdmin(res)) {
    return res.status(403).render('error', { err: new ErrorMessage('只有全站管理员可以管理 AI 参赛。') });
  }
  try {
    await orchestrator.ensureAgentAccounts();
    const rows = await TypeORM.getConnection().query('SELECT id,title,start_time,end_time,holder_id,type FROM contest ORDER BY start_time DESC LIMIT 100');
    return res.render('admin_ai', { agents: await orchestrator.listAgents(), contests: rows });
  } catch (error) {
    syzoj.log('[ai-contest-admin] ' + (error.stack || error));
    return res.status(500).render('error', { err: error });
  }
});

orchestrator.ensureAgentAccounts().then(() => orchestrator.resumeRuns()).catch(error => syzoj.log('[ai-contest] startup failed: ' + (error.stack || error)));

app.get('/api/v2/admin/ai/agents', async (req, res) => {
  if (!res.locals.user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!isSiteAdmin(res)) return api().fail(res, 403, 'CAPABILITY_REQUIRED', '只有全站管理员可以管理 AI 参赛。');
  try { return api().send(res, await orchestrator.listAgents()); } catch (error) { return errorResponse(res, error); }
});

app.get('/api/v2/admin/ai/runs', async (req, res) => {
  if (!res.locals.user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!isSiteAdmin(res)) return api().fail(res, 403, 'CAPABILITY_REQUIRED', '只有全站管理员可以管理 AI 参赛。');
  try { return api().send(res, await orchestrator.getRunHistory()); } catch (error) { return errorResponse(res, error); }
});

app.get('/api/v2/contests/:id/ai-runs', async (req, res) => {
  if (!res.locals.user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!isSiteAdmin(res)) return api().fail(res, 403, 'CAPABILITY_REQUIRED', '只有全站管理员可以管理 AI 参赛。');
  const contest = await syzoj.model('contest').findById(Number(req.params.id));
  if (!contest) return api().fail(res, 404, 'CONTEST_NOT_FOUND', '比赛不存在。');
  if (!await canManageContest(contest, res.locals.user)) return api().fail(res, res.locals.user ? 403 : 401, 'CAPABILITY_REQUIRED', '需要比赛管理权限。');
  try { return api().send(res, await orchestrator.getRuns(contest.id)); } catch (error) { return errorResponse(res, error); }
});

app.post('/api/v2/contests/:id/ai-runs', async (req, res) => {
  if (!res.locals.user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!isSiteAdmin(res)) return api().fail(res, 403, 'CAPABILITY_REQUIRED', '只有全站管理员可以管理 AI 参赛。');
  const contest = await syzoj.model('contest').findById(Number(req.params.id));
  if (!contest) return api().fail(res, 404, 'CONTEST_NOT_FOUND', '比赛不存在。');
  if (!await canManageContest(contest, res.locals.user)) return api().fail(res, res.locals.user ? 403 : 401, 'CAPABILITY_REQUIRED', '需要比赛管理权限。');
  try {
    const body = req.body || {};
    const runs = await orchestrator.createRuns(contest.id, body.providers || body.agents, { max_attempts: body.max_attempts, actor: res.locals.user, req });
    const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'ai:run.start', resourceType: 'contest', resourceId: contest.id, scope: `contest:${contest.id}`, reason: syzoj.utils.operationReason(req, '启动 AI 参赛'), details: { providers: body.providers || body.agents || ['deepseek', 'gpt'], run_count: runs.length } });
    return api().send(res, { runs, audit_event_id: auditEventId }, 202);
  } catch (error) { return errorResponse(res, error); }
});

app.post('/api/v2/contests/:id/ai-runs/:runId/cancel', async (req, res) => {
  if (!res.locals.user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  if (!isSiteAdmin(res)) return api().fail(res, 403, 'CAPABILITY_REQUIRED', '只有全站管理员可以管理 AI 参赛。');
  const contest = await syzoj.model('contest').findById(Number(req.params.id));
  if (!contest) return api().fail(res, 404, 'CONTEST_NOT_FOUND', '比赛不存在。');
  if (!await canManageContest(contest, res.locals.user)) return api().fail(res, res.locals.user ? 403 : 401, 'CAPABILITY_REQUIRED', '需要比赛管理权限。');
  try {
    const run = await orchestrator.cancelRun(req.params.runId, contest.id);
    const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'ai:run.cancel', resourceType: 'contest', resourceId: contest.id, scope: `contest:${contest.id}`, reason: syzoj.utils.operationReason(req, '停止 AI 参赛'), details: { run_id: String(req.params.runId) } });
    return api().send(res, { run, audit_event_id: auditEventId });
  } catch (error) { return errorResponse(res, error); }
});

module.exports = { orchestrator };
