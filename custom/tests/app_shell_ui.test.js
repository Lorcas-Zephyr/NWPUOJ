'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const readAppCss = require('./helpers/read-app-css');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('application shell exposes a dialog command panel without restoring topbar search', () => {
  const header = read('custom/views/app_header.ejs');
  const topbar = header.slice(header.indexOf('<header class="app-topbar">'), header.indexOf('</header>'));

  assert.match(header, /data-command-open/);
  assert.match(header, /id="app-command-dialog"/);
  assert.match(header, /data-command-input/);
  assert.match(header, /data-command-item/);
  assert.doesNotMatch(topbar, /<input\b/);
});

test('command panel supports filtering and keyboard navigation', () => {
  const script = read('custom/app-v2.js');
  const css = readAppCss();

  assert.match(script, /function setupCommandPanel\(\)/);
  assert.match(script, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(script, /event\.key\.toLowerCase\(\) !== 'k'/);
  assert.match(script, /event\.key !== 'ArrowDown' && event\.key !== 'ArrowUp'/);
  assert.match(css, /\.app-command-dialog\s*\{/);
  assert.match(css, /\.app-command-group a:focus-visible/);
});

test('shared datetime controls open from the whole minute-precision field', () => {
  const script = read('custom/app-v2.js');
  const css = readAppCss();

  assert.match(script, /function setupDateTimePickers\(\)/);
  assert.match(script, /typeof input\.showPicker !== 'function'/);
  assert.match(script, /input\.addEventListener\('focus', openPicker\)/);
  assert.match(script, /input\.addEventListener\('click', openPicker\)/);
  assert.match(css, /\.app-datetime-input\s*\{[^}]*letter-spacing:\s*0;[^}]*word-spacing:\s*0;[^}]*font-variant-numeric:\s*tabular-nums;/s);
});

test('theme toggle renders exactly one icon for each theme', () => {
  const header = read('custom/views/app_header.ejs');
  const css = readAppCss();

  assert.equal((header.match(/appNavIcon\('sun', 'app-theme-light'\)/g) || []).length, 1);
  assert.equal((header.match(/appNavIcon\('moon', 'app-theme-dark'\)/g) || []).length, 1);
  assert.match(css, /\.app-v2 \[data-theme-toggle\] \.app-theme-dark\s*\{[^}]*display:\s*none/s);
  assert.match(css, /:root\[data-theme="dark"\] \.app-v2 \[data-theme-toggle\] \.app-theme-light\s*\{[^}]*display:\s*none/s);
  assert.match(css, /:root\[data-theme="dark"\] \.app-v2 \[data-theme-toggle\] \.app-theme-dark\s*\{[^}]*display:\s*block/s);
  assert.match(css, /@keyframes app-page-in\s*\{[^}]*from\s*\{\s*transform:/s);
  assert.doesNotMatch(css, /@keyframes app-page-in\s*\{[^}]*opacity:\s*0/s);
});

test('sidebar and Markdown code surfaces follow the light and dark themes', () => {
  const css = readAppCss();

  assert.match(css, /:root\s*\{[^}]*--app-sidebar:\s*#ffffff[^}]*--app-markdown-code-bg:\s*#f2f4f7/s);
  assert.match(css, /:root\[data-theme="dark"\]\s*\{[^}]*--app-sidebar:\s*#1a1d22[^}]*--app-markdown-code-bg:\s*#20242b/s);
  assert.match(css, /\.app-sidebar\s*\{[^}]*background:\s*var\(--app-sidebar\)/s);
  assert.match(css, /\.app-markdown pre\s*\{[^}]*background:\s*var\(--app-markdown-code-bg\)[^}]*color:\s*var\(--app-markdown-code-text\)/s);
  assert.match(css, /\.app-banner\s*\{[^}]*background:\s*var\(--app-banner-bg\)/s);
});

test('centered pages keep one horizontal position across short and long subpages', () => {
  const css = read('custom/app-shell.css');
  assert.match(css, /html\s*\{[^}]*overflow-y:\s*scroll[^}]*scrollbar-gutter:\s*stable/s);
});

test('desktop sidebar uses the compact width while the mobile drawer stays touch-friendly', () => {
  const shell = read('custom/app-shell.css');
  const features = read('custom/app-features.css');
  assert.match(shell, /--app-sidebar-width:\s*186px/);
  assert.doesNotMatch(features, /--app-sidebar-width:\s*220px/);
  assert.match(features, /@media \(max-width: 860px\)[\s\S]*?\.app-sidebar\s*\{[^}]*width:\s*min\(280px, calc\(100vw - 54px\)\)/);
});

test('account menu uses the same canonical avatar source as the profile page', () => {
  const header = read('custom/views/app_header.ejs');
  const profile = read('custom/views/user.ejs');
  const css = readAppCss();

  assert.match(header, /<img class="app-avatar" src="<%= syzoj\.utils\.avatar\(user, 64\) %>" alt="">/);
  assert.match(profile, /class="app-profile-avatar" src="<%= syzoj\.utils\.avatar\(show_user, 240\) %>"/);
  assert.doesNotMatch(header, /\(user\.username \|\| '\?'\)\.charAt/);
  assert.match(css, /\.app-avatar\s*\{[^}]*width:\s*32px[^}]*height:\s*32px[^}]*object-fit:\s*cover/s);
});

test('mobile guests see login instead of registration in the topbar', () => {
  const header = read('custom/views/app_header.ejs');

  assert.match(header, /class="app-button app-button-quiet" href="<%= syzoj\.utils\.makeUrl\(\['login'\]/);
  assert.match(header, /class="app-button app-button-primary app-hide-phone" href="<%= syzoj\.utils\.makeUrl\(\['sign_up'\]/);
});

test('disabled solution and discussion modules have no shell entry points', () => {
  const header = read('custom/views/app_header.ejs');
  const adminHeader = read('custom/views/admin_header.ejs');
  const problemContext = read('custom/views/problem_context.ejs');

  assert.doesNotMatch(header, /href="\/discussion\/global"/);
  assert.doesNotMatch(header, />讨论</);
  assert.doesNotMatch(header, /data-command-terms="讨论 社区"/);
  assert.doesNotMatch(adminHeader, /solutions|题解审核/);
  assert.doesNotMatch(problemContext, /discussion|solutions|讨论|题解/);
});

test('shared footer includes linked ICP record, copyright and email on desktop and mobile', () => {
  const footer = read('custom/views/app_footer.ejs');
  const features = read('custom/app-features.css');
  assert.match(footer, /href="https:\/\/beian\.miit\.gov\.cn\/"[^>]*rel="noopener noreferrer"[^>]*>陕ICP备05010979号<\/a>/);
  assert.match(footer, /版权所有 © 西北工业大学程序设计创新实践基地/);
  assert.match(footer, /联系邮箱：<a href="mailto:npuicpc@163\.com">npuicpc@163\.com<\/a>/);
  assert.match(read('custom/views/footer.ejs'), /include app_footer/);
  assert.match(read('custom/views/admin_footer.ejs'), /include app_footer/);
  assert.doesNotMatch(features, /\.app-footer\s*\{[^}]*display:\s*none/);
  assert.match(features, /\.app-footer\s*\{[^}]*padding: 16px 15px calc\(78px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(read('custom/app-shell.css'), /\.app-footer\s*\{[^}]*overflow-x:\s*auto;[^}]*white-space:\s*nowrap;/s);
  assert.doesNotMatch(footer, /app-footer-info|程序设计训练平台/);
  const header = read('custom/views/app_header.ejs');
  assert.ok(header.indexOf('<nav class="app-mobile-nav') < header.indexOf('<main class="app-main"'), 'fixed mobile navigation is outside the animated main container');
});
