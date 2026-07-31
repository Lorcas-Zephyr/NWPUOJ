'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { discover } = require('../scripts/compatibility-inventory');

const root = path.resolve(__dirname, '../..');

function stable(value) {
  const copy = JSON.parse(JSON.stringify(value));
  delete copy.generated_at;
  return copy;
}

test('checked-in compatibility inventory matches the runtime route and template scan', () => {
  const current = discover();
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'COMPATIBILITY-INVENTORY.json'), 'utf8'));
  assert.deepEqual(stable(stored), stable(current));
  assert.equal(current.frontend_page_routes.some(item => item.source.includes('/tests/')), false);
  assert.equal(current.v1_write_forms.some(item => item.source.includes('/tests/')), false);
  assert.equal(current.v1_client_calls.some(item => item.source.includes('/tests/')), false);
  assert.equal(current.summary.v1_api_reads, 0);
  assert.equal(current.summary.v1_write_routes, 0);
  assert.equal(current.summary.v1_write_forms, 0);
  assert.equal(current.summary.v1_client_calls, 0);
  assert.equal(current.summary.compatibility_adapters, 0);
});

test('contest registration and participant administration prefer scoped v2 contracts', () => {
  const list = fs.readFileSync(path.join(root, 'custom/views/contests.ejs'), 'utf8');
  const context = fs.readFileSync(path.join(root, 'custom/views/contest_context.ejs'), 'utf8');
  const registrationScript = fs.readFileSync(path.join(root, 'custom/views/contest_registration_v2_script.ejs'), 'utf8');
  const management = fs.readFileSync(path.join(root, 'custom/views/contest_registrations.ejs'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'custom/modules/_api_v2_contest_domain.js'), 'utf8');
  assert.match(list, /data-contest-registration-v2="register"/);
  assert.match(context, /data-contest-registration-v2="unregister"/);
  assert.match(registrationScript, /\/api\/v2\/contests\/.*\/registration/);
  assert.doesNotMatch(registrationScript, /API_DOMAIN_DISABLED|href-post|form\.submit\(\)/);
  assert.match(management, /\/participants\/bulk-action/);
  assert.match(management, /\/standings\/rebuild/);
  assert.match(route, /app\.post\(\['\/api\/v2\/contests\/:id\/registration'/);
  assert.match(route, /app\.delete\(\['\/api\/v2\/contests\/:id\/registration'/);
  assert.match(route, /app\.post\('\/api\/v2\/contests\/:id\/participants\/bulk-action'/);
  assert.match(route, /app\.post\('\/api\/v2\/contests\/:id\/standings\/rebuild'/);
});

test('contest editor and deletion prefer validated shared v2 contracts', () => {
  const view = fs.readFileSync(path.join(root, 'custom/views/contest_edit.ejs'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'custom/modules/_api_v2_contest_domain.js'), 'utf8');
  const deletion = fs.readFileSync(path.join(root, 'custom/libs/contest-deletion.js'), 'utf8');
  assert.match(view, /data-contest-editor-v2/);
  assert.match(view, /data-contest-delete-v2/);
  assert.doesNotMatch(view, /API_DOMAIN_DISABLED|href-post/);
  assert.match(api, /app\.patch\('\/api\/v2\/contests\/:id'/);
  assert.match(api, /app\.delete\('\/api\/v2\/contests\/:id'/);
  assert.match(api, /CONTEST_RANKING_INVALID/);
  assert.match(api, /contestDeletion\.deleteContest/);
  assert.match(deletion, /contestRating\.deleteContestAndRecalculate/);
});

test('v2-migrated browser calls cannot regress to their legacy JSON endpoints', () => {
  const current = discover();
  const routes = new Set(current.v1_client_calls.map(item => item.route.split('?')[0]));
  for (const route of [
    '/api/login', '/api/active-announcements', '/api/active-banners', '/api/markdown', '/api/forget',
    '/api/reset_password', '/api/hit-history/<%= show_user.id %>', '/api/my-tag',
    '/api/ticket-relation-search', '/submission/:param/rejudge', '/api/submissions/events',
    '/messages/with/:param/delete-all', '/messages/:param/delete',
    '/article/:param/delete', '/article/:param/comment/:param/delete',
    '/solution/:param/withdraw', '/solution/:param/delete',
    '/solution/:param/comment/:param/delete', '/admin/restart',
    '/problem/:param/delete', '/problem/:param/:param',
    '/problem/:param/testdata/delete/:param'
  ]) assert.equal(routes.has(route), false, `${route} must stay migrated to v2`);
  assert.equal(current.v1_client_calls.length, 0);
});

test('problem lifecycle and testdata controls use scoped v2 endpoints', () => {
  const problem = fs.readFileSync(path.join(root, 'custom/views/problem.ejs'), 'utf8');
  const context = fs.readFileSync(path.join(root, 'custom/views/problem_context.ejs'), 'utf8');
  const data = fs.readFileSync(path.join(root, 'custom/views/problem_data.ejs'), 'utf8');
  const domain = fs.readFileSync(path.join(root, 'custom/modules/_api_v2_problem_domain.js'), 'utf8');
  const workflow = fs.readFileSync(path.join(root, 'custom/modules/_api_v2_problem_workflows.js'), 'utf8');
  assert.match(problem, /data-problem-v2-archive/);
  assert.match(context, /data-problem-v2-visibility/);
  assert.match(context, /\/api\/v2\/problems\//);
  assert.match(data, /data-testdata-v2-delete/);
  assert.match(data, /\/api\/v2\/problems\/<%= problem\.id %>\/testdata\/files\//);
  assert.doesNotMatch(problem, /\['problem', problem\.id, 'delete'\]/);
  assert.doesNotMatch(context, /dis_public|href-post/);
  assert.doesNotMatch(data, /testdata', 'delete'|href-post/);
  assert.match(domain, /app\.post\('\/api\/v2\/problems\/:id\/unpublish'/);
  assert.match(domain, /app\.post\('\/api\/v2\/problems\/:id\/archive'/);
  assert.match(workflow, /app\.delete\('\/api\/v2\/problems\/:id\/testdata\/files\/:filename'/);
});

test('Web restart exists only through the audited v2 service endpoint', () => {
  const wrapper = fs.readFileSync(path.join(root, 'custom/header.ejs'), 'utf8');
  const shell = fs.readFileSync(path.join(root, 'custom/views/app_header.ejs'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'custom/modules/_api_v2_admin_domain.js'), 'utf8');
  assert.match(wrapper, /include app_header/);
  assert.doesNotMatch(wrapper + shell, /["']\/admin\/restart["']/);
  assert.match(route, /app\.post\('\/api\/v2\/admin\/services\/web\/restart'/);
  assert.match(route, /action: 'admin:web\.restart\.request'/);
  assert.match(route, /res\.once\('finish'/);
});

test('solution destructive controls use the transactionally evented v2 endpoints', () => {
  const view = fs.readFileSync(path.join(root, 'custom/views/solution.ejs'), 'utf8');
  const editor = fs.readFileSync(path.join(root, 'custom/views/solution_edit.ejs'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'custom/modules/_api_v2_problem_workflows.js'), 'utf8');
  assert.match(view, /data-solution-v2-action="withdraw"/);
  assert.match(view, /data-solution-v2-action="delete"/);
  assert.match(view, /data-solution-v2-action="delete-comment"/);
  assert.match(view, /method = 'POST'/);
  assert.match(view, /method = 'DELETE'/);
  assert.doesNotMatch(view, /\['solution', solution\.id, 'withdraw'\]/);
  assert.doesNotMatch(view, /\['solution', solution\.id, 'delete'\]/);
  assert.doesNotMatch(view, /\['solution', solution\.id, 'comment', comment\.id, 'delete'\]/);
  assert.match(route, /app\.post\('\/api\/v2\/solutions\/:id\/withdraw'/);
  assert.match(route, /app\.delete\('\/api\/v2\/solutions\/:id'/);
  assert.match(route, /app\.delete\('\/api\/v2\/solutions\/:id\/comments\/:commentId'/);
  assert.match(view, /data-solution-v2-form="review"/);
  assert.match(view, /data-solution-v2-form="comment"/);
  assert.match(view, /\/api\/v2\/solutions\/' \+ encodeURIComponent\(solutionId\) \+ '\/review'/);
  assert.match(view, /\/api\/v2\/solutions\/' \+ encodeURIComponent\(solutionId\) \+ '\/comments'/);
  assert.match(editor, /data-solution-v2-edit/);
  assert.match(editor, /method = 'PATCH'/);
  assert.match(editor, /\/api\/v2\/problems\/.*\/solutions/);
  assert.match(route, /app\.get\('\/api\/v2\/solutions\/:id'/);
  assert.match(route, /app\.patch\('\/api\/v2\/solutions\/:id'/);
  assert.match(route, /app\.post\('\/api\/v2\/solutions\/:id\/comments'/);
  assert.match(route, /contentDomain\.updateSolution/);
  assert.match(route, /contentDomain\.createSolutionComment/);
});

test('discussion deletion controls use audited v2 content endpoints', () => {
  const view = fs.readFileSync(path.join(root, 'custom/views/article.ejs'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'custom/modules/_api_v2_content_domain.js'), 'utf8');
  assert.match(view, /data-discussion-v2-delete="<%= article\.id %>"/);
  assert.match(view, /data-discussion-v2-delete-reply="<%= comment\.id %>"/);
  assert.match(view, /method: 'DELETE'/);
  assert.match(view, /\/api\/v2\/discussions\//);
  assert.doesNotMatch(view, /\['article', article\.id, 'delete'\]/);
  assert.doesNotMatch(view, /\['article', article\.id, 'comment', comment\.id, 'delete'\]/);
  assert.match(route, /app\.delete\('\/api\/v2\/discussions\/:id'/);
  assert.match(route, /app\.delete\('\/api\/v2\/discussions\/:id\/replies\/:replyId'/);
});

test('message deletion controls use user-scoped v2 content endpoints', () => {
  const view = fs.readFileSync(path.join(root, 'custom/views/messages_conversation.ejs'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'custom/views/messages_v2_script.ejs'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'custom/modules/_api_v2_content_domain.js'), 'utf8');
  assert.match(view, /data-message-v2-delete-conversation="<%= partner\.id %>"/);
  assert.match(view, /data-message-v2-delete="<%= message\.id %>"/);
  assert.doesNotMatch(view, /delete-all'\]\)|\['messages', message\.id, 'delete'\]/);
  assert.match(script, /method: 'DELETE'/);
  assert.match(script, /\/api\/v2\/messages\/conversations\//);
  assert.match(route, /app\.delete\('\/api\/v2\/messages\/:id'/);
  assert.match(route, /app\.delete\('\/api\/v2\/messages\/conversations\/:id'/);
});

test('submission detail rejudge uses the audited v2 job endpoint', () => {
  const view = fs.readFileSync(path.join(root, 'custom/views/submission.ejs'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'custom/modules/_api_v2_submission_domain.js'), 'utf8');
  assert.match(view, /data-submission-v2-rejudge="\/api\/v2\/submissions\/<%= info\.submissionId %>\/rejudge"/);
  assert.match(view, /fetch\(rejudge\.dataset\.submissionV2Rejudge, \{ method: 'POST'/);
  assert.doesNotMatch(view, /href-post="<%= syzoj\.utils\.makeUrl\(\['submission', info\.submissionId, 'rejudge'\]\)/);
  assert.match(route, /app\.post\('\/api\/v2\/submissions\/:id\/rejudge'/);
  assert.match(route, /action: 'submission:rejudge'/);
});

test('submission lists stream status updates through the v2 batch event endpoint', () => {
  const view = fs.readFileSync(path.join(root, 'custom/views/submissions.ejs'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'custom/modules/_submission_routes.js'), 'utf8');
  assert.match(view, /fetch\('\/api\/v2\/submissions\/events'/);
  assert.doesNotMatch(view, /fetch\('\/api\/submissions\/events'/);
  assert.match(route, /app\.post\(["']\/api\/v2\/submissions\/events["']/);
  assert.doesNotMatch(route, /["']\/api\/submissions\/events["']/);
  assert.match(route, /SUBMISSION_FORBIDDEN/);
});

test('new content clients and contracts use their registered v2 replacements', () => {
  const contentRoute = fs.readFileSync(path.join(root, 'custom/modules/_api_v2_content_domain.js'), 'utf8');
  const views = ['index.ejs', 'markdown_editor_script.ejs', 'problem_edit.ejs', 'forget.ejs', 'forget_confirm.ejs', 'user.ejs', 'user_edit.ejs', 'ticket_new.ejs']
    .map(name => fs.readFileSync(path.join(root, 'custom/views', name), 'utf8')).join('\n');
  for (const route of [
    '/api/v2/announcements', '/api/v2/banners/active', '/api/v2/users/:id/hit-history',
    '/api/v2/me/user-tag', '/api/v2/tickets/relation-search'
  ]) assert.match(contentRoute, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(':id', ':id')));
  for (const route of [
    '/api/v2/announcements', '/api/v2/banners/active', '/api/v2/markdown',
    '/api/v2/auth/password/reset', '/api/v2/users/', '/api/v2/me/user-tag',
    '/api/v2/tickets/relation-search'
  ]) assert.ok(views.includes(route), `${route} must be used by a rendered client`);
});
