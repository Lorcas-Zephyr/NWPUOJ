'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');

const socketPath = '/var/run/docker.sock';
const port = Number(process.env.JUDGE_CONTROL_PORT || 3000);
const tokenPath = process.env.JUDGE_CONTROL_TOKEN_FILE || '/run/judge-control/token';
const allowedServices = new Set(['judge-daemon', 'judge-runner-1']);
const restarting = new Set();
const usedNonces = new Map();

function loadToken() {
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (error) {}
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, generated, { mode: 0o600 });
  return generated;
}

const token = loadToken();

function dockerRequest(method, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method, path: requestPath, headers: { 'Content-Length': 0 } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 200 && response.statusCode < 300) {
          if (!text) return resolve(null);
          try { return resolve(JSON.parse(text)); } catch (error) { return reject(new Error('Docker returned invalid JSON')); }
        }
        let message = text;
        try { message = JSON.parse(text).message || text; } catch (error) {}
        const dockerError = new Error(`Docker API ${response.statusCode}: ${message || 'request failed'}`);
        dockerError.statusCode = response.statusCode;
        reject(dockerError);
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error('Docker API request timed out')));
    request.on('error', reject);
    request.end();
  });
}

function authorized(req) {
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  if (!(token.length >= 16 && expectedBuffer.length === suppliedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, suppliedBuffer))) return false;
  const timestamp = String(req.headers['x-control-timestamp'] || '');
  const nonce = String(req.headers['x-control-nonce'] || '');
  const contentHash = String(req.headers['x-content-sha256'] || '');
  const suppliedSignature = String(req.headers['x-control-signature'] || '');
  if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 60000 ||
      !/^[a-f0-9]{32}$/i.test(nonce) || !/^[a-f0-9]{64}$/i.test(contentHash) ||
      !/^[a-f0-9]{64}$/i.test(suppliedSignature) || usedNonces.has(nonce)) return false;
  const expectedSignature = crypto.createHmac('sha256', token)
    .update(`${req.method}\n${req.url}\n${timestamp}\n${nonce}\n${contentHash}`)
    .digest('hex');
  const signatureBuffer = Buffer.from(suppliedSignature);
  const calculatedBuffer = Buffer.from(expectedSignature);
  if (signatureBuffer.length !== calculatedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, calculatedBuffer)) return false;
  usedNonces.set(nonce, Date.now());
  for (const [value, createdAt] of usedNonces) if (Date.now() - createdAt > 120000) usedNonces.delete(value);
  return true;
}

function bodyHashMatches(req, raw) {
  const expected = String(req.headers['x-content-sha256'] || '');
  const actual = crypto.createHash('sha256').update(raw).digest('hex');
  return expected.length === actual.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function labelsOf(inspect) {
  return inspect && inspect.Config && inspect.Config.Labels || {};
}

async function composeProject() {
  const self = await dockerRequest('GET', `/containers/${encodeURIComponent(process.env.HOSTNAME)}/json`);
  const project = labelsOf(self)['com.docker.compose.project'];
  if (!project) throw new Error('Cannot identify the Compose project');
  return project;
}

function allowedContainer(inspect, project) {
  const labels = labelsOf(inspect);
  return labels['com.docker.compose.project'] === project && allowedServices.has(labels['com.docker.compose.service']);
}

function projectServiceContainer(inspect, project, service) {
  const labels = labelsOf(inspect);
  return labels['com.docker.compose.project'] === project && labels['com.docker.compose.service'] === service;
}

function cpuPercent(stats) {
  if (!stats || !stats.cpu_stats || !stats.precpu_stats) return 0;
  const cpuDelta = Number(stats.cpu_stats.cpu_usage && stats.cpu_stats.cpu_usage.total_usage || 0) -
    Number(stats.precpu_stats.cpu_usage && stats.precpu_stats.cpu_usage.total_usage || 0);
  const systemDelta = Number(stats.cpu_stats.system_cpu_usage || 0) - Number(stats.precpu_stats.system_cpu_usage || 0);
  const cpus = Number(stats.cpu_stats.online_cpus ||
    stats.cpu_stats.cpu_usage && stats.cpu_stats.cpu_usage.percpu_usage && stats.cpu_stats.cpu_usage.percpu_usage.length || 1);
  return cpuDelta > 0 && systemDelta > 0 ? cpuDelta / systemDelta * cpus * 100 : 0;
}

function memoryMiB(stats) {
  if (!stats || !stats.memory_stats) return 0;
  const memoryStats = stats.memory_stats.stats || {};
  const cache = Number(memoryStats.inactive_file || memoryStats.total_inactive_file || 0);
  return Math.max(0, Number(stats.memory_stats.usage || 0) - cache) / 1024 / 1024;
}

async function loadContainer(row, project) {
  const inspect = await dockerRequest('GET', `/containers/${encodeURIComponent(row.Id)}/json`);
  if (!allowedContainer(inspect, project)) return null;
  let stats = null;
  if (inspect.State && inspect.State.Running) {
    try { stats = await dockerRequest('GET', `/containers/${encodeURIComponent(row.Id)}/stats?stream=false`); } catch (error) {}
  }
  const labels = labelsOf(inspect);
  return {
    id: inspect.Id,
    shortId: String(inspect.Id).slice(0, 12),
    name: String(inspect.Name || '').replace(/^\//, ''),
    service: labels['com.docker.compose.service'],
    number: Number(labels['com.docker.compose.container-number'] || 0),
    status: inspect.State && inspect.State.Status || 'unknown',
    running: !!(inspect.State && inspect.State.Running),
    health: inspect.State && inspect.State.Health && inspect.State.Health.Status || null,
    oomKilled: !!(inspect.State && inspect.State.OOMKilled),
    restartCount: Number(inspect.RestartCount || 0),
    startedAt: Math.floor(new Date(inspect.State && inspect.State.StartedAt || 0).getTime() / 1000),
    cpuPercent: cpuPercent(stats),
    memoryMiB: memoryMiB(stats),
    pids: Number(stats && stats.pids_stats && stats.pids_stats.current || 0)
  };
}

async function status() {
  const project = await composeProject();
  const rows = await dockerRequest('GET', '/containers/json?all=1');
  const candidates = rows.filter(row => {
    const labels = row.Labels || {};
    return labels['com.docker.compose.project'] === project && allowedServices.has(labels['com.docker.compose.service']);
  });
  const containers = (await Promise.all(candidates.map(row => loadContainer(row, project)))).filter(Boolean);
  containers.sort((left, right) => left.service.localeCompare(right.service) || left.number - right.number || left.name.localeCompare(right.name));
  return { project, containers };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 4096) return req.destroy(new Error('Request body too large'));
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (!bodyHashMatches(req, raw)) return reject(Object.assign(new Error('Request body signature mismatch'), { statusCode: 403 }));
      try { resolve(JSON.parse(raw.toString('utf8') || '{}')); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function send(res, statusCode, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': payload.length, 'Cache-Control': 'no-store' });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    if (!authorized(req)) return send(res, 403, { error: 'Forbidden' });
    if (req.method === 'GET' && req.url === '/status') return send(res, 200, await status());
    if (req.method === 'POST' && req.url === '/restart-web') {
      const project = await composeProject();
      const rows = await dockerRequest('GET', '/containers/json?all=1');
      const candidates = rows.filter(row => {
        const labels = row.Labels || {};
        return labels['com.docker.compose.project'] === project && labels['com.docker.compose.service'] === 'web';
      });
      if (candidates.length !== 1) throw new Error(`Expected one web container, found ${candidates.length}`);
      const inspect = await dockerRequest('GET', `/containers/${encodeURIComponent(candidates[0].Id)}/json`);
      if (!projectServiceContainer(inspect, project, 'web')) return send(res, 403, { error: 'Container is outside the allowed scope' });
      const canonicalId = inspect.Id;
      if (restarting.has(canonicalId)) return send(res, 409, { error: 'Web service is already restarting' });
      restarting.add(canonicalId);
      send(res, 202, { id: canonicalId, name: String(inspect.Name || '').replace(/^\//, '') });
      setTimeout(async () => {
        try {
          await dockerRequest('POST', `/containers/${encodeURIComponent(canonicalId)}/restart?t=10`);
          console.log(`[judge-control] restarted web (${canonicalId.slice(0, 12)})`);
        } catch (error) {
          console.error('[judge-control] web restart failed: ' + (error.stack || error));
        } finally {
          restarting.delete(canonicalId);
        }
      }, 250);
      return;
    }
    if (req.method === 'POST' && req.url === '/restart') {
      const body = await readJson(req);
      const containerId = String(body.id || '');
      if (!/^[a-f0-9]{64}$/i.test(containerId)) return send(res, 400, { error: 'Invalid container ID' });
      const project = await composeProject();
      const inspect = await dockerRequest('GET', `/containers/${encodeURIComponent(containerId)}/json`);
      if (!allowedContainer(inspect, project)) return send(res, 403, { error: 'Container is outside the allowed scope' });
      const canonicalId = inspect.Id;
      if (restarting.has(canonicalId)) return send(res, 409, { error: 'Container is already restarting' });
      restarting.add(canonicalId);
      try { await dockerRequest('POST', `/containers/${encodeURIComponent(canonicalId)}/restart?t=10`); }
      finally { restarting.delete(canonicalId); }
      const name = String(inspect.Name || '').replace(/^\//, '');
      console.log(`[judge-control] restarted ${name} (${canonicalId.slice(0, 12)})`);
      return send(res, 200, { id: canonicalId, name });
    }
    send(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error('[judge-control] ' + (error.stack || error));
    send(res, error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500, { error: error.message || 'Internal error' });
  }
});

server.listen(port, '0.0.0.0', () => console.log(`[judge-control] listening on ${port}`));
