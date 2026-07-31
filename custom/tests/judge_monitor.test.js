'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const readAppCss = require('./helpers/read-app-css');
const { normalizeQueueRows, normalizeQueueState } = require('../libs/judge-monitor');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('judge queue states follow the submission runtime projection', () => {
  assert.equal(normalizeQueueState('queued', 'Waiting'), 'queued');
  assert.equal(normalizeQueueState('compiling', 'Waiting'), 'compiling');
  assert.equal(normalizeQueueState('judging', 'Waiting'), 'judging');
  assert.equal(normalizeQueueState(null, 'Compiling'), 'compiling');
  assert.equal(normalizeQueueState(null, 'Judging'), 'judging');
  assert.equal(normalizeQueueState('accepted', 'Waiting'), 'queued');
});

test('judge queue resources are ordered, scoped, timed and secret-redacted', () => {
  const rows = normalizeQueueRows([
    { id: 12, problem_id: 3, user_id: 8, type: 1, type_info: 9, language: 'cpp', status: 'Waiting', projected_status: 'judging', submit_time: 1900, username: 'alice', problem_title: 'B', dispatch_attempts: 2, last_error: 'internal endpoint secret' },
    { id: 11, problem_id: 2, user_id: 7, type: 0, language: 'cpp', status: 'Waiting', projected_status: 'queued', submit_time: 1000, username: 'bob', problem_title: 'A' }
  ], 2000);

  assert.deepEqual(rows.map(item => item.id), [11, 12]);
  assert.equal(rows[0].is_stale, true);
  assert.equal(rows[0].age_seconds, 1000);
  assert.equal(rows[0].contest_id, null);
  assert.equal(rows[1].contest_id, 9);
  assert.equal(rows[1].has_dispatch_error, true);
  assert.equal(rows[1].dispatch_attempts, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(rows[1], 'last_error'), false);
  assert.equal(rows[1].submitted_at, '1970-01-01T00:31:40.000Z');
});

test('worker monitor API is capability-gated and projects runtime transitions', () => {
  const monitor = read('custom/modules/_judge_workers_admin.js');
  const adminApi = read('custom/modules/_api_v2_admin_domain.js');
  const submission = read('custom/modules/_api_v2_submission_domain.js');
  const judger = read('custom/libs-built/judger.js');

  assert.match(monitor, /WHERE judge\.pending=1/);
  assert.match(monitor, /ORDER BY judge\.submit_time ASC,judge\.id ASC/);
  assert.match(monitor, /normalizeQueueRows\(queueRows\)/);
  assert.match(adminApi, /app\.get\('\/api\/v2\/admin\/judge-workers', requireCapability\('judge:read'\), workersResponse\)/);
  assert.match(adminApi, /queue: data\.queue \|\| \[\]/);
  assert.match(submission, /function projectRuntimeState\(taskId, nextStatus\)/);
  assert.match(submission, /status IN \('created','queued','compiling','judging'\)/);
  assert.match(judger, /projectJudgeRuntimeState\(progress\.taskId, 'compiling'\)/);
  assert.match(judger, /projectJudgeRuntimeState\(progress\.taskId, 'judging'\)/);
  assert.match(judger, /projectJudgeFinalState\(judge_state\)/);
});

test('worker workspace renders live queue, offline recovery and mobile priorities', () => {
  const view = read('custom/views/admin_judge_workers.ejs');
  const css = readAppCss();

  assert.match(view, /data-judge-queue-rows/);
  assert.match(view, /data-judge-queue-offline/);
  assert.match(view, /fetch\('\/api\/v2\/admin\/judge-workers'/);
  assert.match(view, /renderQueue\(payload\.queue \|\| \[\], payload\.summary\.pending\)/);
  assert.match(view, /window\.setInterval\(refresh, 3000\)/);
  assert.match(css, /\.app-judge-queue-table\s*\{[^}]*table-layout: fixed/s);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?\.app-judge-queue-table th:nth-child\(5\)/s);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*?\.app-judge-queue-table th:nth-child\(1\)/s);
});
