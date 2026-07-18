'use strict';

const fs = require('fs');
const { performance } = require('perf_hooks');

const baseUrl = String(process.env.LOGIN_BENCHMARK_URL || 'http://127.0.0.1').replace(/\/$/, '');
const count = Number(process.env.LOGIN_BENCHMARK_COUNT || 500);
const concurrency = Number(process.env.LOGIN_BENCHMARK_CONCURRENCY || count);
const prefix = String(process.env.LOGIN_BENCHMARK_PREFIX || 'perf_login_');
const password = String(process.env.LOGIN_BENCHMARK_PASSWORD || '');
const timeoutMs = Number(process.env.LOGIN_BENCHMARK_TIMEOUT_MS || 15000);

async function login(username) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(baseUrl + '/api/login', {
      method: 'POST',
      headers: {
        Origin: baseUrl,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ username, password }),
      signal: controller.signal
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch (error) {}
    return {
      username,
      status: response.status,
      errorCode: body && body.error_code,
      success: response.status === 200 && body && body.error_code === 1,
      ms: performance.now() - started
    };
  } catch (error) {
    return { username, status: 0, success: false, ms: performance.now() - started, error: error.name + ': ' + error.message };
  } finally {
    clearTimeout(timer);
  }
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(results) {
  const latencies = results.map(result => result.ms);
  return {
    requests: results.length,
    success: results.filter(result => result.success).length,
    errors: results.filter(result => !result.success).length,
    statuses: results.reduce((counts, result) => {
      counts[result.status] = (counts[result.status] || 0) + 1;
      return counts;
    }, {}),
    errorCodes: results.reduce((counts, result) => {
      if (result.errorCode != null) counts[result.errorCode] = (counts[result.errorCode] || 0) + 1;
      return counts;
    }, {}),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    maxMs: Math.max(...latencies)
  };
}

async function main() {
  if (!Number.isSafeInteger(count) || count < 1 || count > 5000) throw new Error('Invalid LOGIN_BENCHMARK_COUNT');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > count) throw new Error('Invalid LOGIN_BENCHMARK_CONCURRENCY');
  if (!password) throw new Error('LOGIN_BENCHMARK_PASSWORD is required');
  const users = Array.from({ length: count }, (_, index) => prefix + String(index + 1).padStart(4, '0'));
  const results = [];
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= users.length) return;
      results[index] = await login(users[index]);
    }
  }
  const startedAt = new Date().toISOString();
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const finishedAt = new Date().toISOString();
  const report = {
    startedAt,
    finishedAt,
    baseUrl,
    count,
    concurrency,
    wallMs: performance.now() - started,
    summary: summarize(results),
    rawResults: results
  };
  if (process.env.LOGIN_BENCHMARK_OUTPUT) {
    fs.writeFileSync(process.env.LOGIN_BENCHMARK_OUTPUT, JSON.stringify(report, null, 2));
  }
  process.stdout.write(JSON.stringify(report.summary, null, 2) + '\n');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
