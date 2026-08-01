'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const readAppCss = require('./helpers/read-app-css');

const root = path.resolve(__dirname, '../..');
const viewsDir = path.join(root, 'custom/views');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('problem pages share one accessible context navigation', () => {
  const context = read('custom/views/problem_context.ejs');
  const requiredViews = [
    'problem.ejs',
    'problem_submit.ejs',
    'statistics.ejs',
    'problem_data.ejs',
    'solutions.ejs',
    'discussion.ejs',
    'submissions.ejs'
  ];

  for (const view of requiredViews) {
    const source = fs.readFileSync(path.join(viewsDir, view), 'utf8');
    assert.match(source, /include problem_context/, view + ' must use the shared context');
  }

  assert.match(context, /class="app-tabs app-problem-context-tabs"/);
  assert.match(context, /aria-label="题目导航"/);
  assert.match(context, /aria-current=\"page\"/);
  assert.match(context, /data-problem-contest-clock/);
  assert.match(context, /data-problem-contest-clock-text/);
  assert.doesNotMatch(context, /class="[^"]*\bui\b/);
  assert.doesNotMatch(context, /\sstyle=/);
  assert.doesNotMatch(context, /\$\s*\(/);
});

test('problem statement and submission history do not render duplicate context UI', () => {
  const problem = read('custom/views/problem.ejs');
  const submissions = read('custom/views/submissions.ejs');

  assert.doesNotMatch(problem, /app-problem-layout/);
  assert.doesNotMatch(problem, /include contest_context/);
  assert.match(problem, /app-problem-content app-problem-content-wide/);
  assert.match(problem, /typeof discussionCount !== 'undefined' \? discussionCount : 0/);

  const problemContextIndex = submissions.indexOf('typeof problemContext');
  const contestContextIndex = submissions.indexOf('typeof contestHeader');
  assert.ok(problemContextIndex >= 0 && contestContextIndex > problemContextIndex);
  assert.match(submissions, /else if \(typeof contestHeader/);
});

test('problem statement remains one unbroken Markdown flow with a separate submit workspace', () => {
  const problem = read('custom/views/problem.ejs');
  const submit = read('custom/views/problem_submit.ejs');

  assert.equal((problem.match(/<article class="app-problem-content app-problem-content-wide">/g) || []).length, 1);
  assert.equal((problem.match(/<div class="app-markdown">/g) || []).length, 1);
  assert.ok(problem.indexOf('problem.description') < problem.indexOf('problem.input_format'));
  assert.ok(problem.indexOf('problem.input_format') < problem.indexOf('problem.output_format'));
  assert.ok(problem.indexOf('problem.output_format') < problem.indexOf('problem.example'));
  assert.doesNotMatch(problem, /app-problem-card|app-statement-card/);
  assert.match(submit, /class="app-page app-submit-page"/);
  assert.match(submit, /include problem_submit_form/);
  assert.doesNotMatch(problem, /include problem_submit_form/);
});

test('problem creation uses one canonical Markdown field while retaining legacy compatibility inputs', () => {
  const editor = read('custom/views/problem_edit.ejs');
  const problem = read('custom/views/problem.ejs');

  assert.equal((editor.match(/class="[^"]*app-problem-markdown-field/g) || []).length, 1);
  assert.match(editor, /name="description" data-preview-source="statement"/);
  for (const field of ['input_format', 'output_format', 'example', 'limit_and_hint']) {
    assert.match(editor, new RegExp('type="hidden" name="' + field + '" value=""'));
  }
  assert.equal((editor.match(/data-preview-output="statement"/g) || []).length, 2);
  assert.doesNotMatch(editor, /data-preview-source="(?:input_format|output_format|example|limit_and_hint)"/);
  assert.match(problem, /const appSplitStatement = !!\(problem\.input_format/);
  assert.match(problem, /if \(!appSplitStatement\)/);
});

test('problem editing loads the current version and only redirects after an effective save', () => {
  const editor = read('custom/views/problem_edit.ejs');
  const lifecycle = read('custom/modules/_problem_lifecycle_guard.js');

  assert.match(editor, /data-can-publish=/);
  assert.match(editor, /current\.current_version_id/);
  assert.match(editor, /\/versions\/.*current\.current_version_id/);
  assert.match(editor, /form\.elements\.description\.value = content\.description/);
  assert.match(editor, /wasPublic && versionId && canPublish/);
  assert.match(editor, /\/publish'/);
  assert.match(editor, /\/review-request'/);
  assert.match(editor, /destination \+= '\?version=' \+ encodeURIComponent\(versionId\)/);
  assert.match(editor, /window\.location\.replace\(destination\)/);
  assert.ok(editor.indexOf("'/publish'") < editor.indexOf('window.location.replace(destination)'));
  assert.match(lifecycle, /app\.use\('\/problem\/:id'/);
  assert.match(lifecycle, /private, no-store, must-revalidate/);
});

test('problem detail reads the effective v2 version instead of a stale legacy model', () => {
  const lifecycle = read('custom/modules/_problem_lifecycle_guard.js');
  const problem = read('custom/views/problem.ejs');

  assert.match(lifecycle, /state\.current_version_id/);
  assert.match(lifecycle, /version\.content_json/);
  assert.match(lifecycle, /problemDomain\.parseStoredContent\(row\.content_json\)/);
  assert.match(lifecycle, /res\.locals\.problemV2View/);
  assert.match(problem, /Object\.assign\(problem, problemV2View\.content\)/);
  assert.match(problem, /data-problem-version=/);
  assert.match(problem, /当前显示刚保存的题面草稿/);
});

test('problem context has stable desktop and mobile layout rules', () => {
  const css = readAppCss();

  assert.match(css, /\.app-problem-context-main\s*\{/);
  assert.match(css, /\.app-problem-context-facts\s*\{/);
  assert.match(css, /\.app-problem-context-tabs\s*\{/);
  assert.match(css, /\.app-problem-contest-clock dd\s*\{[^}]*min-width:\s*132px/s);
  assert.match(css, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.app-problem-content-wide\s*\{/);
});
