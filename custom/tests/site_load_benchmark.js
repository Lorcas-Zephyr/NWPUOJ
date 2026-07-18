'use strict';

const fs = require('fs');
const { performance } = require('perf_hooks');

const baseUrl = String(process.env.LOAD_BASE_URL || 'http://127.0.0.1').replace(/\/$/, '');
const concurrency = Number(process.env.LOAD_CONCURRENCY || 100);
const durationSeconds = Number(process.env.LOAD_DURATION_SECONDS || 20);
const cookie = String(process.env.LOAD_COOKIE || '');
const mode = process.env.LOAD_MODE || 'public';
const endpoints = mode === 'authenticated'
  ? [
      ['/problem/1', 20], ['/problem/2', 10], ['/problems?repository=main', 20],
      ['/submissions', 15], ['/ranklist', 10], ['/help', 10], ['/contests', 10], ['/api/v2/search/problems/A%2BB', 5]
    ]
  : [
      ['/', 15], ['/help', 15], ['/problems?repository=main', 25], ['/contests', 15],
      ['/ranklist', 10], ['/problem/1', 10], ['/api/v2/search/problems/A%2BB', 10]
    ];

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function chooseEndpoint() {
  const target = Math.random() * 100;
  let cursor = 0;
  for (const [endpoint, weight] of endpoints) {
    cursor += weight;
    if (target < cursor) return endpoint;
  }
  return endpoints[endpoints.length - 1][0];
}

async function request(endpoint) {
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(baseUrl + endpoint, {
      headers: Object.assign({ Accept: 'text/html,application/json' }, cookie ? { Cookie: cookie } : {}),
      signal: controller.signal,
      cache: 'no-store'
    });
    await response.arrayBuffer();
    return {
      endpoint,
      status: response.status,
      ok: response.status >= 200 && response.status < 400,
      ms: performance.now() - started
    };
  } catch (error) {
    return { endpoint, status: 0, ok: false, ms: performance.now() - started, error: error.name + ': ' + error.message };
  } finally {
    clearTimeout(timeout);
  }
}

function summarize(results) {
  const byEndpoint = {};
  for (const result of results) {
    const group = byEndpoint[result.endpoint] || (byEndpoint[result.endpoint] = []);
    group.push(result);
  }
  const summarizeGroup = group => {
    const latencies = group.map(result => result.ms);
    return {
      requests: group.length,
      success: group.filter(result => result.ok).length,
      errors: group.filter(result => !result.ok).length,
      statuses: group.reduce((counts, result) => {
        counts[result.status] = (counts[result.status] || 0) + 1;
        return counts;
      }, {}),
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      p99Ms: percentile(latencies, 0.99),
      maxMs: latencies.length ? Math.max(...latencies) : null
    };
  };
  const overall = summarizeGroup(results);
  return { overall, byEndpoint: Object.fromEntries(Object.entries(byEndpoint).map(([key, value]) => [key, summarizeGroup(value)])) };
}

async function main() {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 2000) throw new Error('Invalid LOAD_CONCURRENCY');
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + durationSeconds * 1000;
  const results = [];
  async function worker() {
    while (Date.now() < deadline) results.push(await request(chooseEndpoint()));
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const finishedAt = new Date().toISOString();
  const report = {
    startedAt,
    finishedAt,
    mode,
    baseUrl,
    concurrency,
    durationSeconds,
    endpoints,
    summary: summarize(results),
    rawResults: results
  };
  const output = process.env.LOAD_OUTPUT;
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report.summary, null, 2) + '\n');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
