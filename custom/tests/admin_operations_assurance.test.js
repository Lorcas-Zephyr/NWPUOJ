'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('admin configuration metadata redacts credential references and sensitive diff responses', () => {
  const admin = read('custom/modules/_api_v2_admin_domain.js');
  assert.match(admin, /provider_credentials: \{ type: 'secret_reference', mutable: false, sensitive: true \}/);
  assert.match(admin, /value: definition\.sensitive \? '\[redacted\]'/);
  assert.match(admin, /secrets_redacted: true/);
  assert.match(admin, /changed: result\.diff, audit_event_id: result\.auditEventId, event_id: result\.eventId, secrets_redacted: true/);
  assert.match(admin, /config\/metadata'[\s\S]*setResourceEtag\(res, resource\)/);
  assert.doesNotMatch(admin, /provider_credentials[^\n]*process\.env/);
});

test('admin content workflows cover deletion, locked replacement, and atomic help publishing', () => {
  const admin = read('custom/modules/_api_v2_admin_domain.js');
  const help = read('custom/modules/_help_page.js');
  const announcements = read('custom/modules/announcement.js');
  const banners = read('custom/modules/banner.js');

  assert.match(admin, /app\.delete\('\/api\/v2\/admin\/announcements\/:id'/);
  assert.match(admin, /app\.delete\('\/api\/v2\/admin\/banners\/:id'/);
  assert.match(admin, /contentDomain\.deleteAnnouncement/);
  assert.match(admin, /contentDomain\.deleteBanner/);
  assert.match(admin, /loadLinksResource\(manager, true\)/);
  assert.match(admin, /type: 'site_links\.replaced'[\s\S]*contentDomain\.appendEvent/);
  assert.match(admin, /type: 'site_config\.updated'/);
  assert.match(help, /ensureFoundationSchema\(\)/);
  assert.match(help, /recordAudit\(req,[\s\S]*}, manager\)/);
  assert.match(help, /contentDomain\.appendEvent\(manager, \{ stream: 'content:help:main'/);
  assert.match(admin, /contentDomain\.createAnnouncement/);
  assert.match(admin, /contentDomain\.updateAnnouncement/);
  assert.match(admin, /contentDomain\.deleteAnnouncement/);
  assert.match(admin, /contentDomain\.createBanner/);
  assert.match(admin, /contentDomain\.updateBanner/);
  assert.match(admin, /contentDomain\.deleteBanner/);
  assert.doesNotMatch(announcements, /app\.(?:post|put|patch|delete)\(/);
  assert.doesNotMatch(banners, /app\.(?:post|put|patch|delete)\(/);
});

test('default help documents testdata ZIP layouts for every local problem type', () => {
  const help = read('custom/content/default-help.md');
  const view = read('custom/views/help.ejs');
  assert.match(help, /## 评测数据 ZIP 格式/);
  assert.match(help, /### 传统题[\s\S]*traditional\.zip/);
  assert.match(help, /### 交互题[\s\S]*interaction\.zip[\s\S]*interactor:/);
  assert.match(help, /interactor:[\s\S]*language: cpp17[\s\S]*`cpp` 使用 C\+\+03/);
  assert.match(help, /### 提交答案题[\s\S]*submit-answer\.zip[\s\S]*userOutput:/);
  assert.match(help, /inputFile: "#\.in"/);
  assert.match(help, /outputFile: "#\.ans"/);
  assert.match(help, /score\.txt/);
  assert.doesNotMatch(help, /ZIP 根目录下的\*\*每个一级子文件夹生成一道传统题/);
  assert.match(view, /评测数据 ZIP 格式' \? 'testdata-zip-format'/);
});

test('announcement and banner workspaces use v2-first writes with safe image upload', () => {
  const admin = read('custom/modules/_api_v2_admin_domain.js');
  const announcements = read('custom/views/admin_announcements.ejs');
  const editor = read('custom/views/admin_announcement_edit.ejs');
  const banners = read('custom/views/admin_banners.ejs');
  const publicContent = read('custom/modules/_api_v2_content_domain.js');

  assert.match(admin, /app\.post\('\/api\/v2\/admin\/banners\/upload'/);
  assert.match(admin, /MAX_BANNER_SIZE = 5 \* 1024 \* 1024/);
  assert.match(admin, /detectSafeRasterImage\(req\.file\.path\)/);
  assert.match(admin, /copyFileSync\(req\.file\.path, storedPath, fs\.constants\.COPYFILE_EXCL\)/);
  assert.match(admin, /removeStoredBanner\(removed\.row\.image_path\)/);
  assert.match(announcements, /data-announcement-v2="toggle"/);
  assert.match(announcements, /data-announcement-v2="delete"/);
  assert.match(editor, /data-announcement-v2-edit/);
  assert.match(editor, /\/api\/v2\/admin\/announcements/);
  assert.match(banners, /data-banner-v2="upload"/);
  assert.match(banners, /data-banner-v2="edit"/);
  assert.match(banners, /data-banner-v2="delete"/);
  for (const view of [announcements, editor, banners]) {
    assert.match(view, /Idempotency-Key/);
    assert.doesNotMatch(view, /API_DOMAIN_DISABLED/);
    assert.doesNotMatch(view, /HTMLFormElement\.prototype\.submit\.call/);
  }
  assert.match(announcements, /'If-Match': current\.etag/);
  assert.match(banners, /'If-Match': current\.etag/);
  assert.match(publicContent, /ORDER BY sort_order DESC,id DESC/);
});

test('unified job cancellation and retry attach an audit event identifier', () => {
  const admin = read('custom/modules/_api_v2_admin_domain.js');
  assert.match(admin, /action: 'admin:job\.cancel'[\s\S]*auditEventId/);
  assert.match(admin, /action: 'admin:job\.retry'[\s\S]*auditEventId/);
  assert.match(admin, /kind: job\.kind, state: nextState, audit_event_id: auditEventId/);
  assert.match(admin, /kind: job\.kind, state: 'queued', audit_event_id: auditEventId/);
});

test('bulk problem actions share unified task serialization, SSE, cancellation, and retry', () => {
  const admin = read('custom/modules/_api_v2_admin_domain.js');
  const problem = read('custom/modules/_api_v2_problem_workflows.js');
  assert.match(admin, /kind: 'problem_bulk_action'/);
  assert.match(admin, /problem_bulk_action: 'problem:archive'/);
  assert.match(admin, /job\.kind === 'problem_testdata' \|\| job\.kind === 'problem_bulk_action'/);
  assert.match(problem, /app\.post\('\/api\/v2\/problems\/bulk-actions'/);
  assert.match(problem, /app\.get\('\/api\/v2\/problem-jobs\/:id\/events'/);
  assert.match(problem, /cancel_requested=0/);
});

test('unified admin jobs use capability-gated SSE streams for every supported job kind', () => {
  const admin = read('custom/modules/_api_v2_admin_domain.js');
  const foundation = read('custom/modules/_api_v2_foundation.js');
  assert.match(admin, /function jobEventStream\(job\)[\s\S]*vjudge-import:\$\{job\.id\}[\s\S]*problem-job:\$\{job\.id\}[\s\S]*submission-job:\$\{job\.id\}[\s\S]*rating-job:\$\{job\.id\}[\s\S]*standings-job:\$\{job\.id\}[\s\S]*migration:\$\{job\.id\}/);
  assert.match(admin, /app\.get\('\/api\/v2\/admin\/jobs\/:id\/events', requireCapability\('admin:job\.manage'\), async \(req, res\) =>[\s\S]*return api\(\)\.sse\(req, res, stream\)/);
  assert.match(admin, /appendJobEvent\(job, 'job\.cancel\.requested'/);
  assert.match(admin, /appendJobEvent\(job, 'job\.retry\.queued'/);
  assert.match(foundation, /async function sse\(req, res, stream, options = \{\}\)/);
});

test('standings, migration, and Rating jobs emit queue and terminal lifecycle events', () => {
  const contest = read('custom/modules/_api_v2_contest_domain.js');
  const migration = read('custom/modules/_api_v2_migration.js');
  const rating = read('custom/modules/_api_v2_rating_domain.js');
  assert.match(contest, /stream: `standings-job:\$\{jobId\}`, type: 'standings\.rebuild\.queued'/);
  assert.match(contest, /stream: `standings-job:\$\{jobId\}`, type: 'standings\.rebuild\.running'/);
  assert.match(contest, /stream: `standings-job:\$\{jobId\}`, type: 'standings\.rebuild\.completed'/);
  assert.match(migration, /stream: `migration:\$\{result\.run\.id\}`, type: 'migration\.queued'/);
  assert.match(migration, /stream: `migration:\$\{id\}`, type: 'migration\.running'/);
  assert.match(migration, /const terminalState = result\.failures\.length \? 'failed' : 'completed'/);
  assert.match(migration, /stream: `migration:\$\{id\}`, type: terminalState === 'completed' \? 'migration\.completed' : 'migration\.failed'/);
  assert.match(rating, /stream: `rating-job:\$\{id\}`, type: 'rating\.recalculation\.queued'/);
});

test('submission job recovery safely requeues only idempotent projection rebuilding', () => {
  const submission = read('custom/modules/_api_v2_submission_domain.js');
  assert.match(submission, /async function recoverSubmissionJobs\(\)/);
  assert.match(submission, /submissionDomain\.recoveryDisposition\(job\.kind, job\.state/);
  assert.match(submission, /REJUDGE_INTERRUPTED/);
  assert.match(submission, /setImmediate\(\(\) => recoverSubmissionJobs\(\)\)/);
});

test('bulk rejudge has one unified parent task with hidden traceable child jobs', () => {
  const admin = read('custom/modules/_api_v2_admin_domain.js');
  assert.match(admin, /CREATE TABLE IF NOT EXISTS admin_v2_rejudge_job/);
  assert.match(admin, /CREATE TABLE IF NOT EXISTS admin_v2_rejudge_item/);
  assert.match(admin, /app\.post\('\/api\/v2\/admin\/rejudge\/jobs'/);
  assert.match(admin, /app\.get\('\/api\/v2\/admin\/rejudge\/jobs\/:id'/);
  assert.match(admin, /kind: 'submission_bulk_rejudge'/);
  assert.match(admin, /NOT EXISTS \(SELECT 1 FROM admin_v2_rejudge_item item WHERE item\.child_job_id=submission\.id\)/);
  assert.match(admin, /parent_job_id: jobId/);
});

test('bulk rejudge parent supports cancellation, failed-item retry, progress, and safe recovery', () => {
  const admin = read('custom/modules/_api_v2_admin_domain.js');
  assert.match(admin, /job\.kind === 'submission_bulk_rejudge'[\s\S]*cancel_requested=1/);
  assert.match(admin, /state IN \('failed','cancelled'\)/);
  assert.match(admin, /async function runRejudgeBatchJob\(jobId\)/);
  assert.match(admin, /submission\.bulk-rejudge\.progress/);
  assert.match(admin, /async function recoverRejudgeBatchJobs\(\)/);
  assert.match(admin, /code: 'BATCH_INTERRUPTED'/);
  assert.match(admin, /recoverRejudgeBatchJobs\(\)/);
});
