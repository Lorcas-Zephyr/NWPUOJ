'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const api = require('../libs/api-v2');

test('cursor encoding round trips structured values', () => {
  const value = { id: 42, updatedAt: '2026-07-29T00:00:00.000Z' };
  assert.deepEqual(api.decodeCursor(api.encodeCursor(value)), value);
  assert.equal(api.decodeCursor('not-a-cursor'), null);
});

test('limit parser clamps unsafe and oversized values', () => {
  assert.equal(api.parseLimit('20'), 20);
  assert.equal(api.parseLimit('9999'), api.MAX_LIMIT);
  assert.equal(api.parseLimit('nope'), api.DEFAULT_LIMIT);
});

test('etag and if-match use strong validators', () => {
  const etag = api.etagFor({ revision: 3 });
  assert.match(etag, /^"[a-f0-9]{32}"$/);
  assert.equal(api.ifMatchSatisfied({ headers: { 'if-match': etag } }, etag), true);
  assert.equal(api.ifMatchSatisfied({ headers: { 'if-match': '"stale"' } }, etag), false);
  assert.equal(api.ifMatchSatisfied({ headers: {} }, etag), true);
  assert.equal(api.ifMatchSatisfied({ headers: {} }, etag, { required: true }), false);
  assert.equal(api.ifMatchSatisfied({ headers: { 'if-match': '*' } }, etag, { required: true }), true);
});

test('catalog errors carry stable codes and field details', () => {
  const error = api.catalogError('VALIDATION_FAILED', null, { title: 'required' });
  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.equal(error.fields.title, 'required');
  assert.equal(api.ERROR_CATALOG.PRECONDITION_REQUIRED.status, 428);
  assert.equal(api.ERROR_CATALOG.IDEMPOTENCY_CONFLICT.status, 409);
  assert.equal(api.ERROR_CATALOG.API_ROUTE_NOT_FOUND.status, 404);
  assert.equal(api.ERROR_CATALOG.INTERNAL_ERROR.status, 500);
  assert.equal(api.ERROR_CATALOG.REGISTRATION_FAILED.status, 409);
});

test('large v2 collections expose bounded keyset pagination metadata', () => {
  const contentSource = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_content_domain.js'), 'utf8');
  const workflowSource = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_problem_workflows.js'), 'utf8');
  const ratingSource = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_rating_domain.js'), 'utf8');
  const contestSource = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_contest_domain.js'), 'utf8');
  const submissionSource = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_submission_domain.js'), 'utf8');
  const authorizationSource = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_authorization.js'), 'utf8');
  const adminSource = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_admin_domain.js'), 'utf8');
  const vjudgeSource = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_vjudge_domain.js'), 'utf8');
  assert.match(contentSource, /app\.get\('\/api\/v2\/clipboard'[\s\S]*api\(\)\.parseLimit\(req, 30, 100\)[\s\S]*LIMIT \?[\s\S]*api\(\)\.encodeCursor\(\{ updated_at:/);
  assert.match(workflowSource, /app\.get\('\/api\/v2\/tags'[\s\S]*api\(\)\.parseLimit\(req, 50, 100\)[\s\S]*ORDER BY tag\.name ASC,tag\.id ASC LIMIT \?[\s\S]*api\(\)\.encodeCursor\(\{ name:/);
  assert.match(workflowSource, /app\.get\('\/api\/v2\/problems\/:id\/solutions'[\s\S]*api\(\)\.parseLimit\(req, 30, 100\)[\s\S]*ORDER BY solution\.id DESC LIMIT \?[\s\S]*api\(\)\.encodeCursor\(Number\(last\.id\)\)/);
  assert.match(workflowSource, /app\.get\(\['\/api\/v2\/admin\/solutions\/pending', '\/api\/v2\/admin\/solutions\/review-queue'\][\s\S]*api\(\)\.parseLimit\(req, 30, 100\)[\s\S]*ORDER BY solution\.id ASC LIMIT \?[\s\S]*api\(\)\.encodeCursor\(Number\(last\.id\)\)/);
  assert.match(contentSource, /app\.get\('\/api\/v2\/discussions\/:id'[\s\S]*reply\.id>\?[\s\S]*ORDER BY reply\.id ASC LIMIT \?[\s\S]*next_cursor/);
  assert.match(contentSource, /app\.get\('\/api\/v2\/tickets\/:id'[\s\S]*reply\.id>\?[\s\S]*ORDER BY reply\.id ASC LIMIT \?[\s\S]*next_cursor/);
  assert.doesNotMatch(contentSource, /ticket_reply[\s\S]{0,300}LIMIT 1000/);
  assert.match(ratingSource, /app\.get\(\['\/api\/v2\/ratings\/users\/:id\/history'[\s\S]*api\(\)\.parseLimit\(req, 50, 100\)[\s\S]*event\.id>\?[\s\S]*next_cursor/);
  assert.match(ratingSource, /app\.get\('\/api\/v2\/contests\/:id\/rating\/overrides'[\s\S]*user_id>\?[\s\S]*ORDER BY user_id ASC LIMIT \?[\s\S]*next_cursor/);
  for (const source of [contentSource, workflowSource, ratingSource, contestSource, submissionSource, authorizationSource, adminSource, vjudgeSource]) {
    const boundedLists = Array.from(source.matchAll(/parseLimit\(req/g)).length;
    const exposedLimits = Array.from(source.matchAll(/apiMeta\.limit/g)).length;
    assert.ok(exposedLimits >= boundedLists, 'every bounded list must expose its effective limit');
  }
  assert.match(contestSource, /problem-snapshots'[\s\S]*apiMeta\.next_cursor\s*=\s*hasMore[\s\S]*:\s*null/);
  assert.match(contestSource, /standings\/versions'[\s\S]*apiMeta\.next_cursor\s*=\s*rows\.length > limit[\s\S]*:\s*null/);
  assert.match(submissionSource, /result-revisions'[\s\S]*apiMeta\.next_cursor[\s\S]*apiMeta\.limit = limit/);
  assert.match(vjudgeSource, /vjudge\/imports'[\s\S]*apiMeta\.limit = limit[\s\S]*apiMeta\.next_cursor/);
  assert.match(adminSource, /admin\/users'[\s\S]*apiMeta\.limit = limit[\s\S]*apiMeta\.next_cursor/);
});

test('editable v2 resources require and compare If-Match before replacement', () => {
  const rolloutSource = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_rollout.js'), 'utf8');
  const adminSource = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_admin_domain.js'), 'utf8');
  const workflowSource = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_problem_workflows.js'), 'utf8');
  assert.match(rolloutSource, /app\.patch\('\/api\/v2\/admin\/rollout\/:domain'[\s\S]*If-Match[\s\S]*api\.ifMatch\(req, current\)/);
  assert.match(adminSource, /app\.patch\('\/api\/v2\/admin\/config'[\s\S]*If-Match[\s\S]*SELECT field_name,value_json FROM site_config_v2_override ORDER BY field_name FOR UPDATE[\s\S]*configMetadataResource\(overrides\)[\s\S]*api\(\)\.ifMatch\(req, current\)/);
  assert.match(workflowSource, /app\.get\('\/api\/v2\/problems\/:id\/tags'[\s\S]*problem_id:[\s\S]*tag_ids:/);
  assert.match(workflowSource, /app\.put\('\/api\/v2\/problems\/:id\/tags'[\s\S]*If-Match[\s\S]*SELECT tag_id FROM problem_tag_map[\s\S]*api\(\)\.ifMatch\(req, current\)/);
});

test('rollout configuration maps API paths to domains and gates requests', () => {
  const rolloutSource = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_rollout.js'), 'utf8');
  assert.match(rolloutSource, /function routeDomain\(pathname\)/);
  assert.ok(rolloutSource.includes("['rating', /^\\/?ratings?"));
  assert.match(rolloutSource, /app\.use\('\/api\/v2', async \(req, res, next\)/);
  assert.match(rolloutSource, /API_DOMAIN_DISABLED/);
  assert.match(rolloutSource, /path === '\/meta\/rollout'/);
});

test('idempotency decisions distinguish reserve, conflict, pending, and replay', () => {
  assert.deepEqual(api.classifyIdempotency(null, 'request-a'), { kind: 'reserve' });
  const started = { id: 'op_1', requestHash: 'request-a', status: 'started', response: null };
  assert.deepEqual(api.classifyIdempotency(started, 'request-b'), { kind: 'conflict', operation: started });
  assert.deepEqual(api.classifyIdempotency(started, 'request-a'), { kind: 'pending', operation: started });
  const completed = { id: 'op_1', requestHash: 'request-a', status: 'completed', response: { data: { id: 7 } } };
  assert.deepEqual(api.classifyIdempotency(completed, 'request-a'), {
    kind: 'replay', operation: completed, response: completed.response
  });
});

test('request body sizing and fixed-window limits are deterministic', () => {
  assert.equal(api.bodySize({ source: 'abc' }), 16);
  const mib = 1024 * 1024;
  const limits = {
    defaultBytes: mib,
    multipartOverheadBytes: mib,
    testdataArchiveBytes: 200 * mib,
    testdataFilesBytes: 20 * mib,
    additionalFileBytes: 30 * mib
  };
  assert.equal(api.requestBodyLimit('/api/v2/problems/7/judge-configuration', 'application/json', limits), mib);
  assert.equal(api.requestBodyLimit('/api/v2/unknown/upload', 'multipart/form-data; boundary=x', limits), mib);
  assert.equal(api.requestBodyLimit('/api/v2/problems/7/testdata/upload', 'multipart/form-data; boundary=x', limits), 201 * mib);
  assert.equal(api.requestBodyLimit('/api/v2/problems/7/testdata/files?replace=1', 'multipart/form-data; boundary=x', limits), 21 * mib);
  assert.equal(api.requestBodyLimit('/api/v2/problems/7/additional-file', 'multipart/form-data; boundary=x', limits), 31 * mib);
  const buckets = new Map();
  assert.deepEqual(api.consumeFixedWindow(buckets, 'member:write', 1000, 60000, 2), { allowed: true, remaining: 1, resetAt: 61000 });
  assert.equal(api.consumeFixedWindow(buckets, 'member:write', 1001, 60000, 2).allowed, true);
  assert.equal(api.consumeFixedWindow(buckets, 'member:write', 1002, 60000, 2).allowed, false);
  assert.equal(api.consumeFixedWindow(buckets, 'member:write', 61000, 60000, 2).allowed, true);
});

test('gateway keeps the JSON limit while delegating known multipart uploads to route limits', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_foundation.js'), 'utf8');
  assert.match(source, /apiHelpers\.requestBodyLimit\(req\.originalUrl, req\.get\('content-type'\)/);
  assert.match(source, /testdataArchiveBytes: 200 \* 1024 \* 1024/);
  assert.match(source, /testdataFilesBytes: Number\(syzoj\.config\.limit/);
  assert.match(source, /additionalFileBytes: Number\(syzoj\.config\.limit/);
  assert.match(source, /contentLength > bodyLimit \|\| bodyBytes > bodyLimit/);
  assert.match(source, /maximum_bytes: bodyLimit/);
});

test('anonymous write allowlist contains only public identity and markdown operations', () => {
  assert.equal(api.isPublicV2WritePath('/api/v2/auth/login'), true);
  assert.equal(api.isPublicV2WritePath('/api/v2/auth/password/reset/'), true);
  assert.equal(api.isPublicV2WritePath('/api/v2/markdown'), true);
  assert.equal(api.isPublicV2WritePath('/api/v2/rating/adjustments'), false);
  assert.equal(api.isPublicV2WritePath('/api/v2/admin/jobs/1/retry'), false);
});

test('database datetimes are serialized as UTC fields rather than shifted local instants', () => {
  const databaseDate = new Date(2026, 6, 29, 17, 7, 24, 36);
  assert.equal(api.databaseIso(databaseDate), '2026-07-29T17:07:24.036Z');
  assert.equal(api.databaseIso('2026-07-29T17:07:24.036Z'), '2026-07-29T17:07:24.036Z');
  assert.equal(api.databaseIso(null), null);
});

test('foundation isolates anonymous idempotency keys and preserves the original operation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_foundation.js'), 'utf8');
  assert.match(source, /principal_key VARCHAR\(80\) NOT NULL/);
  assert.match(source, /UNIQUE KEY uq_api_v2_operation_principal_key \(principal_key, idempotency_key\)/);
  assert.match(source, /return id == null \? 'anonymous' : `user:\$\{id\}`/);
  assert.match(source, /WHERE principal_key=\? AND idempotency_key=\? AND expires_at > UTC_TIMESTAMP\(3\)/);
  assert.match(source, /DELETE FROM api_v2_operation WHERE principal_key=\? AND idempotency_key=\? AND expires_at<=UTC_TIMESTAMP\(3\)/);
  assert.match(source, /req\.apiV2SkipOperationCompletion = true;[\s\S]*IDEMPOTENCY_CONFLICT/);
  assert.match(source, /!res\.req\.apiV2SkipOperationCompletion\) completeOperation/);
});

test('operation status and SSE streams share owner-or-job-manager authorization', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_foundation.js'), 'utf8');
  assert.match(source, /async function loadReadableOperation\(req, res\)[\s\S]*SELECT id,actor_id,status,response_status,response_json,created_at,updated_at,expires_at FROM api_v2_operation WHERE id=\? LIMIT 1/);
  assert.match(source, /const isJobManager = await authorizeCurrent\(res\.locals\.user, 'admin:job\.manage', null, \{ req, scope: 'global' \}\);/);
  assert.match(source, /!isJobManager && Number\(operation\.actor_id\) !== Number\(res\.locals\.user\.id\)[\s\S]*OPERATION_FORBIDDEN/);
  assert.match(source, /app\.get\('\/api\/v2\/operations\/:id'[^]*?const operation = await loadReadableOperation\(req, res\);/);
  assert.match(source, /app\.get\('\/api\/v2\/operations\/:id\/events'[^]*?const operation = await loadReadableOperation\(req, res\);/);
});

test('the foundation exports one replayable SSE helper for domain task streams', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_foundation.js'), 'utf8');
  assert.match(source, /async function sse\(req, res, stream, options = \{\}\)[\s\S]*const serialize = typeof options\.serialize === 'function'[\s\S]*recentEvents\(stream, req\.get\('Last-Event-ID'\)\)[\s\S]*subscribeEvents\(stream, writeEvent\)/);
  assert.match(source, /sse,\n\s*ensureFoundationSchema/);
  assert.match(source, /app\.get\('\/api\/v2\/operations\/:id\/events'[^]*?return sse\(req, res, stream\)/);
});

test('the API contract handler is loaded last and always returns an error envelope', () => {
  const contract = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_contract.js'), 'utf8');
  const moduleOrder = fs.readFileSync(path.join(__dirname, '../module-order.js'), 'utf8');
  assert.match(contract, /app\.use\('\/api\/v2',[\s\S]*API_ROUTE_NOT_FOUND/);
  assert.match(contract, /status >= 500[\s\S]*INTERNAL_ERROR/);
  assert.match(contract, /const stableCode = status >= 500[\s\S]*\? 'INTERNAL_ERROR'/);
  assert.match(contract, /error && error\.fields \|\| \{\}/);
  assert.match(moduleOrder, /leftName === '_api_v2_contract\.js'/);
  assert.match(moduleOrder, /rightName === '_api_v2_contract\.js'/);
});

test('every literal v2 and domain error code is registered in the shared catalog', () => {
  const moduleDirectory = path.join(__dirname, '../modules');
  const libraryDirectory = path.join(__dirname, '../libs');
  const files = fs.readdirSync(moduleDirectory)
    .filter(file => file.endsWith('.js'))
    .map(file => path.join(moduleDirectory, file))
    .filter(file => fs.readFileSync(file, 'utf8').includes('/api/v2'))
    .concat(fs.readdirSync(libraryDirectory)
      .filter(file => file.endsWith('-domain.js'))
      .map(file => path.join(libraryDirectory, file)));
  const codes = new Set();
  const patterns = [
    /\.fail\(\s*res\s*,\s*[^,\n]+\s*,\s*['"]([A-Z][A-Z0-9_]{2,79})['"]/g,
    /apiFail\(\s*res\s*,\s*[^,\n]+\s*,\s*['"]([A-Z][A-Z0-9_]{2,79})['"]/g,
    /domainError\(\s*['"]([A-Z][A-Z0-9_]{2,79})['"]/g,
    /authorizationError\(\s*['"]([A-Z][A-Z0-9_]{2,79})['"]/g,
    /error\.code\s*=\s*['"]([A-Z][A-Z0-9_]{2,79})['"]/g,
    /error:\s*\{\s*code:\s*['"]([A-Z][A-Z0-9_]{2,79})['"]/g
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) codes.add(match[1]);
    }
  }
  ['AUTHORIZATION_WRITE_FAILED', 'CONTENT_WRITE_FAILED', 'INTERNAL_ERROR', 'REQUEST_FAILED'].forEach(code => codes.add(code));
  const missing = Array.from(codes).filter(code => !api.ERROR_CATALOG[code]).sort();
  assert.deepEqual(missing, [], `Missing shared API error definitions: ${missing.join(', ')}`);
});
