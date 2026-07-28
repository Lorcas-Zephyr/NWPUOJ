const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const TypeORM = require('typeorm');

const controlUrl = new URL(process.env.JUDGE_CONTROL_URL || 'http://judge-control:3000');
const controlToken = fs.readFileSync(process.env.JUDGE_CONTROL_TOKEN_FILE || '/run/judge-control/token', 'utf8').trim();
const restartingContainers = new Set();

function requireAdmin(res) {
  if (!res.locals.user || !res.locals.user.is_admin) {
    const error = new ErrorMessage('您没有权限进行此操作。');
    error.statusCode = 403;
    throw error;
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
    const request = http.request({
      hostname: controlUrl.hostname,
      port: controlUrl.port || 80,
      method,
      path: requestPath,
      headers: {
        Authorization: `Bearer ${controlToken}`,
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
  const [controlStatus, pendingRows] = await Promise.all([
    controlRequest('GET', '/status'),
    TypeORM.getConnection().query(
      `SELECT COUNT(*) AS pending,
              SUM(submit_time < UNIX_TIMESTAMP() - 900) AS stale
       FROM judge_state WHERE pending=1`
    )
  ]);
  return {
    project: controlStatus.project,
    containers: controlStatus.containers,
    summary: {
      pending: Number(pendingRows[0] && pendingRows[0].pending || 0),
      stale: Number(pendingRows[0] && pendingRows[0].stale || 0)
    }
  };
}

app.post('/admin/restart', (req, res, next) => {
  try {
    requireAdmin(res);
    res.render('admin_restart', (error, html) => {
      if (error) return next(error);
      res.once('finish', () => {
        controlRequest('POST', '/restart-web').catch(restartError => {
          syzoj.log('[web-restart] ' + (restartError.stack || restartError));
        });
      });
      res.send(html);
    });
  } catch (error) {
    next(error);
  }
});

app.get('/admin/judge-workers', async (req, res) => {
  try {
    requireAdmin(res);
    const { project, containers, summary } = await loadJudgeWorkerStatus();
    res.render('admin_judge_workers', { project, containers, summary });
  } catch (error) {
    if (!error.statusCode || error.statusCode >= 500) syzoj.log('[judge-workers] ' + (error.stack || error));
    res.status(error.statusCode || 500).render('error', { err: error });
  }
});

app.get('/api/admin/judge-workers/status', async (req, res) => {
  try {
    requireAdmin(res);
    res.set('Cache-Control', 'no-store');
    res.json(await loadJudgeWorkerStatus());
  } catch (error) {
    if (!error.statusCode || error.statusCode >= 500) syzoj.log('[judge-workers] status failed: ' + (error.stack || error));
    res.status(error.statusCode || 500).json({ error: error.message || '读取评测服务状态失败。' });
  }
});

app.post('/admin/judge-workers/:id/restart', async (req, res) => {
  const containerId = String(req.params.id || '');
  try {
    requireAdmin(res);
    if (!validAdminCsrf(req)) {
      const error = new ErrorMessage('页面已失效，请刷新后重试。');
      error.statusCode = 403;
      throw error;
    }
    if (!/^[a-f0-9]{64}$/i.test(containerId)) throw new ErrorMessage('容器 ID 不正确。');
    if (restartingContainers.has(containerId)) throw new ErrorMessage('该评测实例正在重启。');
    restartingContainers.add(containerId);
    let result;
    try { result = await controlRequest('POST', '/restart', { id: containerId }); }
    finally { restartingContainers.delete(containerId); }
    syzoj.log(`[judge-workers] admin #${res.locals.user.id} restarted ${result.name} (${result.id.slice(0, 12)})`);
    res.redirect(303, syzoj.utils.makeUrl(['admin', 'judge-workers'], { restarted: result.name }));
  } catch (error) {
    restartingContainers.delete(containerId);
    syzoj.log('[judge-workers] restart failed: ' + (error.stack || error));
    res.status(error.statusCode || 400).render('error', { err: error });
  }
});
