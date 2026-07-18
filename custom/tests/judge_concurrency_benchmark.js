'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const { performance } = require('perf_hooks');
const execFileAsync = promisify(execFile);

const BASE_URL = String(process.env.BENCHMARK_URL || 'http://127.0.0.1').replace(/\/$/, '');
const PROBLEM_ID = Number(process.env.BENCHMARK_PROBLEM_ID || 0);
const CONTEST_ID = Number(process.env.BENCHMARK_CONTEST_ID || 0);
const JOBS_PER_LEVEL = Number(process.env.BENCHMARK_JOBS_PER_LEVEL || 16);
const LEVELS = String(process.env.BENCHMARK_LEVELS || '1,2,4,8,16')
  .split(',').map(value => Number(value)).filter(value => Number.isSafeInteger(value) && value > 0);
const POLL_MS = Number(process.env.BENCHMARK_POLL_MS || 150);
const LOGIN_CONCURRENCY = Number(process.env.BENCHMARK_LOGIN_CONCURRENCY || 32);
const SOURCE = process.env.BENCHMARK_SOURCE || (process.env.BENCHMARK_TIMEOUT === 'true'
  ? `#include <bits/stdc++.h>
using namespace std;
int main() {
  for (volatile unsigned long long i = 0;; ++i) {}
}`
  : `#include <bits/stdc++.h>
using namespace std;
int main() {
  long long a, b;
  if (cin >> a >> b) cout << a + b << "\\n";
  return 0;
}`);

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function readResponse(response) {
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch (error) {}
  return { response, text, body };
}

async function login(account) {
  const response = await fetch(BASE_URL + '/api/login', {
    method: 'POST',
    headers: {
      Origin: BASE_URL,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ username: account.username, password: account.password })
  });
  const result = await readResponse(response);
  if (result.body && result.body.error_code !== 1) throw new Error(account.username + ' login failed: ' + result.text);
  const setCookie = response.headers.get('set-cookie') || '';
  const match = /(?:^|,\s*)connect\.sid=([^;,]+)/.exec(setCookie);
  if (!match) throw new Error(account.username + ' login did not return connect.sid');
  return { username: account.username, cookie: 'connect.sid=' + match[1] };
}

async function submit(session) {
  const started = performance.now();
  const form = new FormData();
  form.set('language', 'cpp17');
  form.set('code', SOURCE);
  const submitUrl = BASE_URL + '/problem/' + PROBLEM_ID + '/submit' +
    (CONTEST_ID ? '?contest_id=' + CONTEST_ID : '');
  const response = await fetch(submitUrl, {
    method: 'POST',
    headers: { Origin: BASE_URL, Cookie: session.cookie },
    body: form,
    redirect: 'manual'
  });
  const submittedAt = performance.now();
  const location = response.headers.get('location') || '';
  const match = /\/submission\/(\d+)/.exec(location);
  if (response.status !== 302 || !match) {
    const result = await readResponse(response);
    throw new Error(session.username + ' submit failed: HTTP ' + response.status + ' ' + result.text.slice(0, 300));
  }
  const id = Number(match[1]);
  const deadline = Date.now() + 5 * 60 * 1000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    const statusResponse = await fetch(BASE_URL + '/api/submission/' + id + '/status', {
      headers: { Cookie: session.cookie, Accept: 'application/json' },
      cache: 'no-store'
    });
    const result = await readResponse(statusResponse);
    if (statusResponse.ok && result.body) {
      lastStatus = result.body;
      if (!result.body.pending) {
        const completedAt = performance.now();
        return {
          id,
          username: session.username,
          requestMs: submittedAt - started,
          endToEndMs: completedAt - started,
          pollAfterSubmitMs: completedAt - submittedAt,
          status: result.body.result && result.body.result.result,
          score: result.body.result && result.body.result.score,
          executionTime: result.body.result && result.body.result.time,
          memory: result.body.result && result.body.result.memory
        };
      }
    }
    await sleep(POLL_MS);
  }
  throw new Error('submission #' + id + ' timed out: ' + JSON.stringify(lastStatus));
}

async function dockerSnapshot() {
  try {
    const [queueResult, containerResult] = await Promise.all([
      execFileAsync('docker', [
        'compose', 'exec', '-T', 'rabbitmq', 'rabbitmqctl', 'list_queues',
        'name', 'messages', 'messages_ready', 'messages_unacknowledged', 'consumers'
      ], { timeout: 10000 }),
      execFileAsync('docker', [
        'compose', 'ps', '-q', 'judge-daemon', 'judge-runner-1'
      ], { timeout: 10000 })
    ]);
    const containers = containerResult.stdout.trim().split(/\r?\n/).filter(Boolean);
    const statsResult = containers.length ? await execFileAsync('docker', [
      'stats', '--no-stream', '--format', '{{json .}}', ...containers
    ], { timeout: 10000 }) : { stdout: '' };
    return {
      at: new Date().toISOString(),
      queues: queueResult.stdout.trim(),
      stats: statsResult.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch (error) { return { raw: line }; }
      })
    };
  } catch (error) {
    return { at: new Date().toISOString(), error: error.message };
  }
}

function summarize(level, samples, started, finished) {
  const endToEnd = samples.map(sample => sample.endToEndMs);
  const request = samples.map(sample => sample.requestMs);
  const queue = samples.map(sample => sample.pollAfterSubmitMs);
  return {
    concurrency: level,
    submissions: samples.length,
    wallMs: finished - started,
    throughputPerMinute: samples.length / ((finished - started) / 60000),
    requestMs: {
      p50: percentile(request, 0.5),
      p95: percentile(request, 0.95),
      p99: percentile(request, 0.99),
      max: Math.max(...request)
    },
    endToEndMs: {
      p50: percentile(endToEnd, 0.5),
      p95: percentile(endToEnd, 0.95),
      p99: percentile(endToEnd, 0.99),
      max: Math.max(...endToEnd)
    },
    afterSubmitMs: {
      p50: percentile(queue, 0.5),
      p95: percentile(queue, 0.95),
      p99: percentile(queue, 0.99),
      max: Math.max(...queue)
    },
    statuses: samples.reduce((counts, sample) => {
      counts[sample.status || 'unknown'] = (counts[sample.status || 'unknown'] || 0) + 1;
      return counts;
    }, {})
  };
}

async function runLevel(level, sessions, monitor) {
  const started = performance.now();
  const samples = [];
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= JOBS_PER_LEVEL) return;
      samples[index] = await submit(sessions[index % sessions.length]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(level, JOBS_PER_LEVEL) }, worker));
  const finished = performance.now();
  const summary = summarize(level, samples, started, finished);
  monitor.levels.push({ summary, samples });
  return summary;
}

async function main() {
  if (!PROBLEM_ID) throw new Error('BENCHMARK_PROBLEM_ID is required');
  const accounts = process.env.BENCHMARK_USERS_JSON
    ? JSON.parse(process.env.BENCHMARK_USERS_JSON)
    : Array.from({ length: Number(process.env.BENCHMARK_USER_COUNT || 0) }, (_, index) => ({
      username: String(process.env.BENCHMARK_USER_PREFIX || 'perf_') + String(index + 1).padStart(4, '0'),
      password: String(process.env.BENCHMARK_USER_PASSWORD || '')
    }));
  const allowSessionReuse = process.env.BENCHMARK_ALLOW_SESSION_REUSE === 'true';
  if (!Array.isArray(accounts) || accounts.length < (allowSessionReuse ? 1 : JOBS_PER_LEVEL)) {
    throw new Error('BENCHMARK_USERS_JSON must contain at least JOBS_PER_LEVEL accounts');
  }
  const sessions = [];
  let nextAccount = 0;
  async function loginWorker() {
    while (true) {
      const index = nextAccount++;
      if (index >= accounts.length) return;
      sessions[index] = await login(accounts[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(LOGIN_CONCURRENCY, accounts.length) }, loginWorker));
  const monitor = { startedAt: new Date().toISOString(), samples: [], levels: [] };
  let sampling = false;
  const timer = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    monitor.samples.push(await dockerSnapshot());
    sampling = false;
  }, 500);
  monitor.samples.push(await dockerSnapshot());
  const summaries = [];
  try {
    for (const level of LEVELS) {
      summaries.push(await runLevel(level, sessions, monitor));
      await sleep(1000);
    }
  } finally {
    clearInterval(timer);
    monitor.samples.push(await dockerSnapshot());
  }
  const result = {
    startedAt: monitor.startedAt,
    finishedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    problemId: PROBLEM_ID,
    jobsPerLevel: JOBS_PER_LEVEL,
    levels: summaries,
    samples: monitor.samples,
    raw: monitor.levels
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
