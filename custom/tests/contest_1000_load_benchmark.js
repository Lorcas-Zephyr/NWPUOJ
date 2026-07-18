'use strict';

const fs = require('fs');
const { performance } = require('perf_hooks');

const baseUrl = String(process.env.CONTEST_LOAD_URL || 'http://127.0.0.1').replace(/\/$/, '');
const contestId = Number(process.env.CONTEST_LOAD_CONTEST_ID || 0);
const problemId = Number(process.env.CONTEST_LOAD_PROBLEM_ID || 0);
const count = Number(process.env.CONTEST_LOAD_COUNT || 1000);
const timeoutMs = Number(process.env.CONTEST_LOAD_TIMEOUT_MS || 30000);
const password = String(process.env.CONTEST_LOAD_PASSWORD || '');
const prefix = String(process.env.CONTEST_LOAD_PREFIX || 'perf_contest_');
const skipSubmissions = process.env.CONTEST_LOAD_SKIP_SUBMISSIONS === 'true';
const extendedPages = process.env.CONTEST_LOAD_EXTENDED_PAGES === 'true';
const pollMs = Number(process.env.CONTEST_LOAD_POLL_MS || 3000);
const code = `#include <bits/stdc++.h>
using namespace std;
int main() {
  long long a, b;
  if (cin >> a >> b) cout << a + b << "\\n";
  return 0;
}`;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function readBody(response) {
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (error) {}
  return { text, json };
}

async function login(username) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(baseUrl + '/api/login', {
      method: 'POST',
      headers: { Origin: baseUrl, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password }),
      signal: controller.signal
    });
    const body = await readBody(response);
    const cookies = response.headers.get('set-cookie') || '';
    const match = /(?:^|,\s*)connect\.sid=([^;,]+)/.exec(cookies);
    return {
      username,
      cookie: match ? 'connect.sid=' + match[1] : null,
      ok: response.status === 200 && body.json && body.json.error_code === 1 && !!match,
      status: response.status,
      ms: performance.now() - started,
      error: body.json && body.json.error_code !== 1 ? body.text.slice(0, 200) : (!match ? 'missing session cookie' : null)
    };
  } catch (error) {
    return { username, cookie: null, ok: false, status: 0, ms: performance.now() - started, error: error.name + ': ' + error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function getPage(session, path) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(baseUrl + path, {
      headers: { Cookie: session.cookie, Accept: 'text/html' }, signal: controller.signal
    });
    await response.arrayBuffer();
    return { username: session.username, path, status: response.status, ok: response.status >= 200 && response.status < 400, ms: performance.now() - started };
  } catch (error) {
    return { username: session.username, path, status: 0, ok: false, ms: performance.now() - started, error: error.name + ': ' + error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function submit(session) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const form = new FormData();
    form.set('language', 'cpp17');
    form.set('code', code);
    const response = await fetch(baseUrl + '/problem/' + problemId + '/submit?contest_id=' + contestId, {
      method: 'POST',
      headers: { Origin: baseUrl, Cookie: session.cookie },
      body: form, redirect: 'manual', signal: controller.signal
    });
    const location = response.headers.get('location') || '';
    const match = /\/submission\/(\d+)/.exec(location);
    const headerId = Number(response.headers.get('x-submission-id') || 0);
    const submissionId = headerId || (match && Number(match[1]));
    if (response.status !== 302 || !submissionId) {
      const body = await readBody(response);
      return { username: session.username, id: null, status: response.status, ok: false, ms: performance.now() - started, error: body.text.slice(0, 300) };
    }
    return { username: session.username, id: submissionId, status: response.status, ok: true, ms: performance.now() - started };
  } catch (error) {
    return { username: session.username, id: null, status: 0, ok: false, ms: performance.now() - started, error: error.name + ': ' + error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function poll(session, submission) {
  const started = performance.now();
  const deadline = Date.now() + 15 * 60 * 1000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl + '/api/submission/' + submission.id + '/status', {
        headers: { Cookie: session.cookie, Accept: 'application/json' }, cache: 'no-store'
      });
      const body = await readBody(response);
      last = body.json;
      if (response.ok && body.json && body.json.pending === false) {
        return { id: submission.id, username: session.username, ok: true, status: body.json.result && body.json.result.result, ms: performance.now() - started };
      }
    } catch (error) {
      last = { error: error.message };
    }
    await sleep(pollMs);
  }
  return { id: submission.id, username: session.username, ok: false, status: 'Poll Timeout', ms: performance.now() - started, error: JSON.stringify(last) };
}

function summarize(results) {
  const latencies = results.map(item => item.ms);
  const percentile = fraction => {
    const sorted = latencies.slice().sort((a, b) => a - b);
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] : null;
  };
  return {
    requests: results.length,
    success: results.filter(item => item.ok).length,
    errors: results.filter(item => !item.ok).length,
    statuses: results.reduce((counts, item) => {
      const key = item.status == null ? 'unknown' : String(item.status);
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {}),
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
    maxMs: latencies.length ? Math.max(...latencies) : null
  };
}

async function main() {
  if (!contestId || !problemId || !password) throw new Error('CONTEST_LOAD_CONTEST_ID, CONTEST_LOAD_PROBLEM_ID and CONTEST_LOAD_PASSWORD are required');
  const users = Array.from({ length: count }, (_, index) => prefix + String(index + 1).padStart(4, '0'));
  const startedAt = new Date().toISOString();
  const loginStarted = performance.now();
  const sessions = await Promise.all(users.map(username => login(username)));
  const validSessions = sessions.filter(session => session.ok);
  const loginFinished = performance.now();

  const pagePaths = [
    '/contest/' + contestId,
    '/contest/' + contestId + '/problem/1'
  ];
  if (extendedPages) {
    pagePaths.push('/contest/' + contestId + '/ranklist');
    pagePaths.push('/contest/' + contestId + '/submissions');
  }
  const visitStarted = performance.now();
  const visits = [];
  for (const path of pagePaths) {
    visits.push(...await Promise.all(validSessions.map(session => getPage(session, path))));
  }
  const visitFinished = performance.now();
  const submitStarted = performance.now();
  const submissions = skipSubmissions ? [] : await Promise.all(validSessions.map(session => submit(session)));
  const submitFinished = performance.now();
  const acceptedSubmissions = submissions.filter(submission => submission.ok).map(submission => ({
    session: validSessions.find(session => session.username === submission.username), submission
  }));
  const pollStarted = performance.now();
  const results = await Promise.all(acceptedSubmissions.map(item => poll(item.session, item.submission)));
  const pollFinished = performance.now();

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    contestId,
    problemId,
    count,
    login: { wallMs: loginFinished - loginStarted, summary: summarize(sessions), raw: sessions },
    visits: { wallMs: visitFinished - visitStarted, summary: summarize(visits), raw: visits },
    submissions: { wallMs: submitFinished - submitStarted, summary: summarize(submissions), raw: submissions },
    results: { wallMs: pollFinished - pollStarted, summary: summarize(results), raw: results }
  };
  if (process.env.CONTEST_LOAD_OUTPUT) fs.writeFileSync(process.env.CONTEST_LOAD_OUTPUT, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({
    login: report.login.summary,
    visits: report.visits.summary,
    submissions: report.submissions.summary,
    results: report.results.summary,
    phaseWallMs: { login: report.login.wallMs, visits: report.visits.wallMs, submissions: report.submissions.wallMs, results: report.results.wallMs }
  }, null, 2) + '\n');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
