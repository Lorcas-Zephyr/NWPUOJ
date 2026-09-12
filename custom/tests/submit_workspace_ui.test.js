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
const problemSets = fs.readFileSync(path.join(root, 'custom/modules/_problem_sets.js'), 'utf8');
const submissionProcess = fs.readFileSync(path.join(root, 'custom/libs-built/submissions_process.js'), 'utf8');
const submissionRoutes = fs.readFileSync(path.join(root, 'custom/modules/_submission_routes.js'), 'utf8');
const submissionVisibility = fs.readFileSync(path.join(root, 'custom/modules/_submission_visibility.js'), 'utf8');
const compilerMessage = require(path.join(root, 'custom/libs/compiler-message.js'));
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

test('contest submissions redirect to the contest list filtered to the current user', () => {
  assert.match(form, /const contestSubmissionListUrl = contest && user/);
  assert.match(form, /\['contest', contest\.id, 'submissions'\], \{ submitter: user\.username \}/);
  assert.match(form, /const submissionDetailBase = contest \? '\/contest\/submission\/' : '\/submission\/';/);
  assert.match(form, /window\.location\.assign\(<%- serializejs\(contestSubmissionListUrl\) %> \|\| \(<%- serializejs\(submissionDetailBase\) %> \+ encodeURIComponent\(payload\.data\.submission\.id\)\)\);/);
  assert.doesNotMatch(form, /window\.location\.assign\('\/submission\/' \+/);
});

test('submit workspace avoids excessive empty editor space on desktop and mobile', () => {
  assert.match(css, /\.app-submit-workspace\s*\{[^}]*min-height:\s*clamp\(300px, 38vh, 380px\)/s);
  assert.match(css, /\.app-submit-editor-stack\s*\{[^}]*min-height:\s*clamp\(300px, 38vh, 380px\)/s);
  assert.match(css, /@media \(max-width: 760px\)\s*\{[\s\S]*?\.app-submit-workspace\s*\{[^}]*min-height:\s*380px/s);
  assert.match(css, /@media \(max-width: 760px\)\s*\{[\s\S]*?\.app-submit-editor-stack\s*\{[^}]*min-height:\s*280px/s);
});

test('language choices preserve the full language name and truncate only compiler details', () => {
  assert.match(form, /class="app-submit-language-name"><%= languageMap\[lang\]\.show %><\/span>/);
  assert.match(form, /class="app-submit-language-version" title="<%= languageMap\[lang\]\.version %>"/);
  assert.match(css, /\.app-submit-language\[data-language\]\s*\{[^}]*grid-template-columns:\s*17px max-content minmax\(28px, 1fr\)/s);
  assert.match(css, /\.app-submit-language \.app-submit-language-name\s*\{[^}]*overflow:\s*visible[^}]*text-overflow:\s*clip/s);
  assert.match(css, /\.app-submit-language-version\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
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

test('submission lists and details show stable live judge progress', () => {
  assert.ok(submissionProcess.indexOf('if (x.pending)') < submissionProcess.indexOf('if (displayConfig.showResult)'));
  assert.match(submissionProcess, /const runningMatch = \/\^Running/);
  assert.match(submissionProcess, /score: displayConfig\.showScore \? 0 : null/);
  assert.match(submissionRoutes, /view: view \|\| 'list'/);
  assert.match(submissionRoutes, /if \(options\.submissionPending\) options\.detailResult = null/);
  assert.match(submission, /fetch\('\/api\/v2\/submissions\/events'/);
  assert.doesNotMatch(submission, /new EventSource\(/);
  assert.match(submission, /data-detail-status/);
  assert.match(submission, /if \(!update\.pending\) return window\.location\.reload\(\)/);
  assert.match(submissions, /if \(update\.pending\) return;\s+item\.result = update\.result/);
  assert.match(submissions, /value\.startsWith\('running'\)/);
  assert.match(submission, /Math\.min\(retryDelay \* 2, 30000\)/);
  assert.doesNotMatch(submission, /\/api\/submission\//);
});

test('problem-set submissions reuse the complete submission list and accepted-source policy', () => {
  assert.match(problemSets, /syzoj\.utils\.renderSubmissionList\(req, res, null/);
  assert.match(submissionRoutes, /'problem_set_submission'/);
  assert.match(submissionRoutes, /problem_set_link\.submission_id = js\.id/);
  assert.match(submissionRoutes, /inProblemSet/);
  assert.match(submissionRoutes, /problemSetProblemIndex/);
  assert.match(submissionRoutes, /inProblemSet && canManageDetails/);
  assert.match(submissionProcess, /s\.problemSetProblemIndex \|\| s\.contestProblemIndex/);
  assert.match(submissions, /displayConfig\.inProblemSet/);
  assert.match(submissions, /\['problem-set', problemSet\.id, 'submissions'\]/);
  assert.match(submissions, /\['problem-set', problemSet\.id, 'problem', item\.info\.problemId\]/);
  assert.match(submission, /appInProblemSet/);
  assert.match(submissionVisibility, /hasValidAcceptedSubmission\(user\.id, this\.problem_id\)/);
  assert.match(submissionVisibility, /hasAccessiblePublishedProblemSet\(user\.id, this\.problem_id\)/);
  assert.match(submissionVisibility, /problemSetSubmissionContext/);
});

test('compiler diagnostics render their safe formatting without exposing HTML source', () => {
  const message = [
    '<b>/sandbox/1/a.cpp:</b> ',
    '<b><span style="color:#A00">error: </span></b>',
    '&apos;<b>stdin</b>&apos;',
    '<script>alert(1)</script>',
    '<span style="color:red" onclick="alert(2)">unsafe</span>'
  ].join('');
  const rendered = compilerMessage.sanitizeCompilerMessage(message);
  assert.match(rendered, /<b>\/sandbox\/1\/a\.cpp:<\/b>/);
  assert.match(rendered, /<span style="color:#A00">error: <\/span>/);
  assert.match(rendered, /&apos;<b>stdin<\/b>&apos;/);
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(rendered, /&lt;span style="color:red" onclick="alert\(2\)"&gt;/);
  assert.doesNotMatch(rendered, /<script|<span style="color:red"/);
  assert.match(submissionRoutes, /sanitizeCompilerMessage\(compile\.message\)/);
  assert.match(submission, /<%- compileMessageHtml %>/);
});

test('pending result projection hides provisional verdicts and usage values', () => {
  let cachedState = { result: 'Running 2/5', score: 40, time: 123, memory: 456 };
  const loadSubmissionProcess = new Function(
    'require',
    'module',
    'exports',
    'syzoj',
    submissionProcess + '\nreturn module.exports;'
  );
  const moduleState = { exports: {} };
  const projected = loadSubmissionProcess(request => {
    assert.equal(request, './judger');
    return {
      getCachedJudgeState: () => cachedState,
      getCachedJudgeDetail: () => null
    };
  }, moduleState, moduleState.exports, {});
  const displayConfig = { showResult: true, showUsage: true, showScore: true };

  let result = projected.getRoughResult({ pending: true, task_id: 'task-1' }, displayConfig, false);
  assert.equal(result.result, 'Running 2/5');
  assert.deepEqual({ score: result.score, time: result.time, memory: result.memory }, { score: 0, time: 0, memory: 0 });

  cachedState = { result: 'Wrong Answer', score: 0, time: 124, memory: 457 };
  result = projected.getRoughResult({ pending: true, task_id: 'task-1' }, displayConfig, false);
  assert.equal(result.result, 'Waiting');

  result = projected.getRoughResult({ pending: false, status: 'Accepted', score: 100, total_time: 12, max_memory: 34 }, displayConfig, false);
  assert.deepEqual({ result: result.result, score: result.score, time: result.time, memory: result.memory }, { result: 'Accepted', score: 100, time: 12, memory: 34 });
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
