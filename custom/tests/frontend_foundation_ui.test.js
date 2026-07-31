'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const readAppCss = require('./helpers/read-app-css');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const icons = require(path.join(root, 'custom/lucide-1.27.0.min.js'));

test('application CSS has explicit shell, shared, and feature ownership', () => {
  const header = read('custom/views/app_header.ejs');
  const shell = read('custom/app-shell.css');
  const shared = read('custom/app-shared.css');
  const features = read('custom/app-features.css');

  assert.match(header, /app-shell\.css[\s\S]*app-shared\.css[\s\S]*app-features\.css/);
  assert.match(shell, /:root\s*\{[\s\S]*\.app-shell\s*\{/);
  assert.match(shared, /\.app-page\s*\{[\s\S]*\.app-button\s*\{[\s\S]*\.app-markdown\s*\{/);
  assert.match(features, /^\/\* Content and workflows \*\/[\s\S]*\.app-dashboard-grid\s*\{/);
});

test('Markdown and username presentation each have one canonical source', () => {
  const customRoot = path.join(root, 'custom');
  const cssSources = fs.readdirSync(customRoot)
    .filter(name => name.endsWith('.css'))
    .map(name => [name, fs.readFileSync(path.join(customRoot, name), 'utf8')]);
  const markdownOwners = cssSources.filter(([, source]) => /^\.app-markdown\s*\{/m.test(source));
  const usernameOwners = cssSources.filter(([, source]) => /^\.username-tier-(?:default|admin)\b/m.test(source));
  const views = fs.readdirSync(path.join(customRoot, 'views'))
    .filter(name => name.endsWith('.ejs'))
    .map(name => fs.readFileSync(path.join(customRoot, 'views', name), 'utf8'))
    .join('\n');

  assert.deepEqual(markdownOwners.map(([name]) => name), ['app-shared.css']);
  assert.deepEqual(usernameOwners.map(([name]) => name), ['username_tiers.css']);
  assert.doesNotMatch(views, /\b(?:font-content|markdown-body)\b/);
});

test('white-first shell exposes shared visual and motion tokens in both themes', () => {
  const css = readAppCss();

  assert.match(css, /:root\s*\{[\s\S]*--app-surface:\s*#ffffff;[\s\S]*--app-control-height:[\s\S]*--app-space-6:[\s\S]*--app-motion-base:/);
  assert.match(css, /:root\[data-theme="dark"\]\s*\{[\s\S]*--app-surface:[\s\S]*--app-text:/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('foundation includes reusable table, drawer, command, steps, status, and empty-state components', () => {
  const css = readAppCss();
  const header = read('custom/views/app_header.ejs');
  const problems = read('custom/views/problems.ejs');
  const contestEditor = read('custom/views/contest_edit.ejs');

  for (const selector of ['app-table-region', 'app-drawer', 'app-command-dialog', 'app-status', 'app-empty']) {
    assert.match(css, new RegExp('\\.' + selector.replace(/-/g, '\\-') + '\\b'));
  }
  assert.match(header, /id="app-command-dialog"/);
  assert.match(problems, /<dialog class="app-dialog app-drawer" id="problem-filter-drawer"/);
  assert.match(problems, /data-dialog-open="problem-filter-drawer"[^>]*aria-haspopup="dialog"/);
  assert.match(contestEditor, /app-contest-step-nav/);
});

test('shared page state covers the complete design state catalog', () => {
  const state = read('custom/views/app_page_state.ejs');
  const error = read('custom/views/error.ejs');
  const success = read('custom/views/success.ejs');

  for (const name of ['initial', 'loading', 'empty', 'partial', 'unauthorized', 'missing', 'success', 'recoverable-error', 'unrecoverable-error', 'offline']) {
    assert.match(state, new RegExp("(?:^|\\s|')" + name.replace(/-/g, '\\-') + "(?:'|:)"));
  }
  assert.match(state, /data-page-state="<%= appStateType %>"/);
  assert.match(error, /<% include app_page_state %>/);
  assert.match(error, /appErrorStatus === 401 \|\| appErrorStatus === 403/);
  assert.match(error, /appErrorStatus === 404/);
  assert.match(error, /\^\(无此\|找不到\)\|不存在\|not found/);
  assert.match(error, /res\.statusCode = appErrorStatus/);
  assert.match(error, /label: '前往登录'/);
  assert.match(success, /type: 'success'/);
  assert.match(success, /<% include app_page_state %>/);
});

test('global loading and offline recovery preserve content and expose retry', () => {
  const header = read('custom/views/app_header.ejs');
  const script = read('custom/app-v2.js');

  assert.match(header, /data-page-progress role="progressbar"/);
  assert.match(header, /data-connectivity-state role="status" aria-live="polite" hidden/);
  assert.match(script, /function setupPageProgress\(\)/);
  assert.match(script, /function setupConnectivityState\(\)/);
  assert.match(script, /window\.addEventListener\('offline'/);
  assert.match(script, /window\.addEventListener\('online'/);
  assert.match(script, /当前页面内容已保留/);
  assert.match(script, /data-connectivity-retry/);
  assert.match(script, /nwpuoj:network-error/);
});

test('modal foundation locks background scroll and restores opener focus', () => {
  const script = read('custom/app-v2.js');
  const css = readAppCss();

  assert.match(script, /document\.body\.classList\.toggle\('is-dialog-open'/);
  assert.match(script, /dialog\.__appOpener = opener/);
  assert.match(script, /opener\.focus\(\)/);
  assert.match(css, /body\.app-v2\.is-dialog-open\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.app-drawer\[open\]\s*\{[^}]*grid-template-rows:/s);
});

test('shared state icons exist in the bundled Lucide build', () => {
  for (const icon of ['LoaderCircle', 'Inbox', 'CircleAlert', 'ShieldAlert', 'SearchX', 'CircleCheckBig', 'CircleX', 'WifiOff', 'RefreshCw']) {
    assert.equal(typeof icons[icon], 'object', icon + ' must exist in the local icon bundle');
  }
});

test('login uses only the enabled v2 identity contract', () => {
  const login = read('custom/views/login.ejs');
  assert.match(login, /fetch\('\/api\/v2\/auth\/login'/);
  assert.match(login, /authenticated/);
  assert.match(login, /ACCOUNT_DISABLED/);
  assert.match(login, /AUTHENTICATION_UNAVAILABLE/);
  assert.doesNotMatch(login, /API_DOMAIN_DISABLED|fetch\('\/api\/login'/);
});

test('shared logout actions submit to the v2 identity endpoint', () => {
  const legacyHeader = read('custom/header.ejs');
  const appHeader = read('custom/views/app_header.ejs');
  const identity = read('custom/modules/_api_v2_identity.js');
  assert.match(legacyHeader, /include app_header/);
  assert.match(appHeader, /href-post="<%= syzoj\.utils\.makeUrl\(\['api', 'v2', 'auth', 'logout'\]\) %>"/);
  assert.doesNotMatch(legacyHeader + appHeader, /href-post="<%= syzoj\.utils\.makeUrl\(\['logout']/);
  assert.match(identity, /app\.post\('\/api\/v2\/auth\/logout'/);
  assert.match(identity, /req\.accepts\('html'\)[\s\S]*res\.redirect\(303/);
});

test('registration uses only the v2 identity contract', () => {
  const signUp = read('custom/views/sign_up.ejs');
  const registrationRoute = read('custom/modules/_api_v2_registration.js');
  const identity = read('custom/modules/_registration_identity.js');
  assert.match(signUp, /data-sign-up-v2/);
  assert.match(signUp, /fetch\('\/api\/v2\/auth\/register'/);
  assert.doesNotMatch(signUp, /API_DOMAIN_DISABLED|legacySubmit|HTMLFormElement\.prototype\.submit/);
  assert.match(registrationRoute, /app\.post\('\/api\/v2\/auth\/register'/);
  assert.match(registrationRoute, /registrationIdentityV2/);
  assert.match(registrationRoute, /establishAuthenticatedSession/);
  assert.match(identity, /syzoj\.utils\.registrationIdentityV2/);
});
