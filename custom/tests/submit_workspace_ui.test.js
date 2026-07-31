'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const readAppCss = require('./helpers/read-app-css');

const root = path.resolve(__dirname, '../..');
const form = fs.readFileSync(path.join(root, 'custom/views/problem_submit_form.ejs'), 'utf8');
const page = fs.readFileSync(path.join(root, 'custom/views/problem_submit.ejs'), 'utf8');
const context = fs.readFileSync(path.join(root, 'custom/views/problem_context.ejs'), 'utf8');
const css = readAppCss();
const header = fs.readFileSync(path.join(root, 'custom/views/app_header.ejs'), 'utf8');
const footer = fs.readFileSync(path.join(root, 'custom/views/app_footer.ejs'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'custom/app-v2.js'), 'utf8');
const editorJs = fs.readFileSync(path.join(root, 'custom/modern-editor.js'), 'utf8');
const submission = fs.readFileSync(path.join(root, 'custom/views/submission.ejs'), 'utf8');
const submissions = fs.readFileSync(path.join(root, 'custom/views/submissions.ejs'), 'utf8');
const user = fs.readFileSync(path.join(root, 'custom/views/user.ejs'), 'utf8');
const icons = require(path.join(root, 'custom/lucide-1.27.0.min.js'));

test('submit uploads keep their icon inside the styled file-field surface', () => {
  assert.match(form, /<label class="app-file-field"><input[^>]*id="answer"[^>]*><span><%- submitIcons\.archive %>/);
  assert.match(form, /<label class="app-file-field"><input[^>]*id="answer"[^>]*><span><%- submitIcons\.upload %>/);
  assert.match(css, /\.app-file-field > span\s*\{[^}]*grid-template-columns: 28px minmax\(0, 1fr\)/s);
});

test('submit button keeps a visible loading icon after locking', () => {
  assert.match(form, /submitIcons\.loading/);
  assert.match(form, /button\.innerHTML = <%- serializejs\(submitIcons\.loading/);
  assert.match(css, /\.app-submit-bottom \.app-button\.is-loading svg\s*\{[^}]*animation: app-spin/s);
});

test('submit workspace avoids excessive empty editor space on desktop and mobile', () => {
  assert.match(css, /\.app-submit-workspace\s*\{[^}]*min-height:\s*clamp\(300px, 38vh, 380px\)/s);
  assert.match(css, /\.app-submit-editor-stack\s*\{[^}]*min-height:\s*clamp\(300px, 38vh, 380px\)/s);
  assert.match(css, /@media \(max-width: 760px\)\s*\{[\s\S]*?\.app-submit-workspace\s*\{[^}]*min-height:\s*380px/s);
  assert.match(css, /@media \(max-width: 760px\)\s*\{[\s\S]*?\.app-submit-editor-stack\s*\{[^}]*min-height:\s*280px/s);
});

test('submit editor is white, minimap-free, and falls back to an accessible textarea', () => {
  assert.match(editorJs, /setTheme\('vs'\)/);
  assert.match(editorJs, /minimap: \{ enabled: false \}/);
  assert.match(editorJs, /function createFallbackEditor\(element, language, content\)/);
  assert.match(editorJs, /textarea\.className = 'app-code-fallback'/);
  assert.match(editorJs, /textarea\.setAttribute\('aria-label', '代码编辑器'\)/);
  assert.match(editorJs, /fallbackTimer = window\.setTimeout\(activateFallback, 5000\)/);
  assert.match(css, /\.app-submit-editor,[\s\S]*background: #ffffff/);
  assert.match(css, /\.app-code-fallback\s*\{[^}]*background: #ffffff/s);
  assert.match(css, /\.app-submit-editor \.minimap,[\s\S]*display: none !important/);
});

test('submission detail streams live status with bounded reconnect fallback', () => {
  assert.match(submission, /new EventSource\('\/api\/v2\/submissions\/<%= info\.submissionId %>\/events'\)/);
  assert.match(submission, /data-detail-status/);
  assert.match(submission, /!\['created', 'queued', 'compiling', 'judging'\]\.includes\(projected\)/);
  assert.match(submission, /Math\.min\(retryDelay \* 2, 30000\)/);
  assert.doesNotMatch(submission, /\/api\/submission\//);
});

test('submission code copy falls back when the Clipboard API is unavailable', () => {
  assert.match(submission, /data-copy="#submission-source"/);
  assert.match(appJs, /function legacyCopy\(value\)/);
  assert.match(appJs, /document\.execCommand\('copy'\)/);
  assert.match(appJs, /navigator\.clipboard && typeof navigator\.clipboard\.writeText === 'function'/);
  assert.match(appJs, /legacyCopy\(value\);/);
  assert.match(appJs, /async function copyText\(value\)\s*\{\s*try \{\s*legacyCopy\(value\);\s*return;/s);
});

test('submission verdicts share profile colors and linked results never turn blue', () => {
  for (const variant of ['accepted', 'wrong', 'runtime', 'time', 'memory', 'compile']) {
    assert.match(user, new RegExp(`app-verdict-${variant}`));
    assert.match(submissions, new RegExp(`app-verdict-${variant}`));
    assert.match(submission, new RegExp(`app-verdict-${variant}`));
    assert.match(css, new RegExp(`\\.app-verdict-${variant}`));
  }
  assert.match(css, /\.app-v2 a\.app-status\.app-verdict:hover\s*\{[^}]*color:\s*var\(--app-verdict-color\)/s);
});

test('submission source, logs, and testpoint diagnostics share Markdown theme surfaces', () => {
  assert.match(css, /\.app-code-panel\s*\{[^}]*background:\s*var\(--app-markdown-code-bg\)/s);
  assert.match(css, /\.app-code-panel > header\s*\{[^}]*background:\s*var\(--app-markdown-code-bg\)[^}]*color:\s*var\(--app-markdown-code-text\)/s);
  assert.match(css, /\.app-code-panel > pre,[\s\S]*?\.app-testcase-detail pre\s*\{[^}]*background:\s*var\(--app-markdown-code-bg\)[^}]*color:\s*var\(--app-markdown-code-text\)/s);
  assert.doesNotMatch(css, /\.app-code-panel > header\s*\{[^}]*(?:#171a20|#f5f7fb|rgba\(255, 255, 255)/s);
  assert.match(css, /\.app-testcase-detail pre\s*\{[^}]*font-size:\s*12px/s);
  for (const label of ['输入文件', '答案文件', '用户输出', '标准错误流', 'Special Judge 信息', '系统信息', '错误信息']) {
    assert.match(submission, new RegExp(label));
  }
});

test('all submit workspace icons exist in the bundled Lucide build', () => {
  for (const icon of ['CircleAlert', 'FileArchive', 'FileUp', 'Send', 'LoaderCircle']) {
    assert.equal(typeof icons[icon], 'object', icon + ' must exist in the local icon bundle');
  }
});

test('submit controls render Lucide SVG markup without waiting for JavaScript replacement', () => {
  assert.match(form, /const submitIcons = \{/);
  assert.match(form, /class="app-static-icon app-static-icon-file-up"/);
  assert.match(form, /class="app-static-icon app-static-icon-send"/);
  assert.doesNotMatch(form, /<i data-lucide=/);
  assert.match(header, /lucide-1\.27\.0\.min\.js\?v=1\.27\.0-20260730-3/);
  assert.match(header, /window\.__NWPUOJ_RENDER_ICONS = function/);
  assert.match(footer, /window\.__NWPUOJ_RENDER_ICONS\(document\)/);
  assert.match(appJs, /window\.__NWPUOJ_RENDER_ICONS\(scope \|\| document\)/);
  assert.match(css, /\.app-submit-page \.app-static-icon\s*\{[^}]*display: inline-block/s);
});

test('Lucide loads before the submission editor installs the Monaco AMD loader', () => {
  assert.match(header, /Load before Monaco installs its AMD loader/);
  assert.doesNotMatch(footer, /<script src="\/self\/lucide-/);
  assert.ok(page.indexOf('include app_header') < page.indexOf('include monaco-editor'));
  assert.ok(page.indexOf('include problem_context') < page.indexOf('include monaco-editor'));
  assert.ok(page.indexOf('__NWPUOJ_RENDER_ICONS') < page.indexOf('include monaco-editor'));
});

test('submit navigation icons are server-rendered and do not depend on Monaco-time replacement', () => {
  assert.match(header, /const appNavIconMarkup = \{/);
  assert.match(header, /<%- appNavIcon\('house'\) %><span>首页<\/span>/);
  assert.match(header, /<%- appNavIcon\('list-tree'\) %><span>题库<\/span>/);
  assert.doesNotMatch(header, /class="app-nav-item[^>]*>\s*<i data-lucide=/);
  assert.doesNotMatch(header, /<i data-lucide=/);
  assert.match(context, /const contextNavIconMarkup = \{/);
  assert.match(context, /<%- contextNavIcon\('file-text'\) %>题目/);
  assert.match(context, /<%- contextNavIcon\('send'\) %>提交/);
  assert.match(context, /<%- contextNavIcon\('send'\) %>提交答案/);
  assert.doesNotMatch(context, /<i data-lucide=/);
  assert.match(header, /class="app-static-icon app-static-icon-/);
  assert.match(context, /class="app-static-icon app-static-icon-/);
  assert.match(css, /\.app-nav-item > \.app-static-icon\s*\{/);
  assert.match(css, /\.app-problem-context-tabs \.app-static-icon\s*\{/);
});
