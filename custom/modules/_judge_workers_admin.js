const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const TypeORM = require('typeorm');
const { normalizeQueueRows } = require('../libs/judge-monitor');

const controlUrl = new URL(process.env.JUDGE_CONTROL_URL || 'http://judge-control:3000');
const controlToken = fs.readFileSync(process.env.JUDGE_CONTROL_TOKEN_FILE || '/run/judge-control/token', 'utf8').trim();
const restartingContainers = new Set();

async function requireAdmin(res, capability) {
  const required = capability || 'judge:read';
  if (!res.locals.user || !await syzoj.utils.authorizationV2.authorize(res.locals.user, required, null, { scope: 'global' })) {
    const error = new ErrorMessage('您没有权限进行此操作。');
    error.statusCode = 403;
    throw error;
  }
}

async function requireRecentAdminAction(req, res) {
  await requireAdmin(res, 'judge:worker.restart');
  if (!syzoj.utils.authorizationV2 || !syzoj.utils.authorizationV2.recentLoginSatisfied(req)) {
    const error = new ErrorMessage('高风险评测运维操作需要近期登录或 MFA 验证。'); error.statusCode = 403; throw error;
  }
}

function validAdminCsrf(req) {
  const expected = req.session && req.session.adminCsrfToken;
  const actual = req.body && req.body.csrf_token;
  if (typeof expected !== 'string' || typeof actual !== 'string' || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function controlRequest(method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const timestamp = String(Date.now());
    const nonce = crypto.randomBytes(16).toString('hex');
    const contentHash = crypto.createHash('sha256').update(payload || Buffer.alloc(0)).digest('hex');
    const signature = crypto.createHmac('sha256', controlToken)
      .update(`${method}\n${requestPath}\n${timestamp}\n${nonce}\n${contentHash}`)
      .digest('hex');
    const request = http.request({
      hostname: controlUrl.hostname,
      port: controlUrl.port || 80,
      method,
      path: requestPath,
      headers: {
        Authorization: `Bearer ${controlToken}`,
        'X-Control-Timestamp': timestamp,
        'X-Control-Nonce': nonce,
        'X-Content-SHA256': contentHash,
        'X-Control-Signature': signature,
        'Content-Type': 'application/json',
        'Content-Length': payload ? payload.length : 0
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (error) {}
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(parsed);
        const controlError = new Error(parsed && parsed.error || `评测控制服务返回 ${response.statusCode}。`);
        controlError.statusCode = response.statusCode;
        reject(controlError);
      });
    });
    request.setTimeout(35000, () => request.destroy(new Error('评测控制服务请求超时。')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function loadJudgeWorkerStatus() {
  if (syzoj.utils.submissionV2 && typeof syzoj.utils.submissionV2.ensureSchema === 'function') {
    await syzoj.utils.submissionV2.ensureSchema();
  }
  const [controlStatus, pendingRows, queueRows] = await Promise.all([
    controlRequest('GET', '/status'),
    TypeORM.getConnection().query(
      `SELECT COUNT(*) AS pending,
              SUM(submit_time < UNIX_TIMESTAMP() - 900) AS stale
       FROM judge_state WHERE pending=1`
    ),
    TypeORM.getConnection().query(
      `SELECT judge.id,judge.problem_id,judge.user_id,judge.type,judge.type_info,
              judge.language,judge.status,judge.submit_time,problem.title AS problem_title,
              user.username,projection.status AS projected_status,
              projection.dispatch_attempts,projection.last_error
         FROM judge_state judge
         LEFT JOIN problem ON problem.id=judge.problem_id
         LEFT JOIN user ON user.id=judge.user_id
         LEFT JOIN submission_v2_projection projection ON projection.submission_id=judge.id
        WHERE judge.pending=1
        ORDER BY judge.submit_time ASC,judge.id ASC
        LIMIT 50`
    )
  ]);
  return {
    project: controlStatus.project,
    containers: controlStatus.containers,
    queue: normalizeQueueRows(queueRows),
    summary: {
      pending: Number(pendingRows[0] && pendingRows[0].pending || 0),
      stale: Number(pendingRows[0] && pendingRows[0].stale || 0)
    }
  };
}

syzoj.utils.loadJudgeWorkerStatusV2 = loadJudgeWorkerStatus;

async function restartJudgeWorker(containerId) {
  const requestedId = String(containerId || '');
  if (!/^[a-f0-9]{64}$/i.test(requestedId)) {
    const error = new Error('Judge worker ID is invalid.');
    error.statusCode = 422;
    throw error;
  }
  if (restartingContainers.has(requestedId)) {
    const error = new Error('The judge worker is already restarting.');
    error.statusCode = 409;
    throw error;
  }
  const status = await loadJudgeWorkerStatus();
  const worker = (status.containers || []).find(item => String(item.id || item.Id || '') === requestedId);
  if (!worker) {
    const error = new Error('Judge worker was not found.');
    error.statusCode = 404;
    throw error;
  }
  restartingContainers.add(requestedId);
  try { return await controlRequest('POST', '/restart', { id: requestedId }); }
  finally { restartingContainers.delete(requestedId); }
}

syzoj.utils.restartJudgeWorkerV2 = restartJudgeWorker;
syzoj.utils.restartWebServiceV2 = () => controlRequest('POST', '/restart-web');


app.get('/admin/judge-workers', async (req, res) => {
  try {
    await requireAdmin(res);
    const { project, containers, queue, summary } = await loadJudgeWorkerStatus();
    res.render('admin_judge_workers', { project, containers, queue, summary, unavailable: false });
  } catch (error) {
    if (!error.statusCode || error.statusCode >= 500) syzoj.log('[judge-workers] ' + (error.stack || error));
    if (error.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).render('error', { err: error });
    }
    res.render('admin_judge_workers', {
      project: '评测控制服务暂不可用',
      containers: [],
      queue: [],
      summary: { pending: 0, stale: 0 },
      unavailable: true
    });
  }
});
