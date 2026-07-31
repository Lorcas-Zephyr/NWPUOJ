'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const readAppCss = require('./helpers/read-app-css');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('shared shell keeps keyboard entry points and a visible focus treatment', () => {
  const header = read('custom/views/app_header.ejs');
  const script = read('custom/app-v2.js');
  const css = readAppCss();

  assert.match(header, /class="app-skip-link" href="#app-main"/);
  assert.match(header, /<main class="app-main" id="app-main" tabindex="-1" aria-busy="true">/);
  assert.match(header, /<dialog class="app-dialog app-command-dialog"[^>]*aria-modal="true"/);
  assert.match(script, /event\.key === 'Escape'/);
  assert.match(css, /\.app-v2 :focus-visible\s*\{[^}]*outline:\s*0;[^}]*box-shadow:\s*var\(--app-focus\)/s);
  assert.match(css, /--app-focus:\s*0 0 0 3px/);
});

test('submission editors expose selection and loading state to assistive technology', () => {
  const form = read('custom/views/problem_submit_form.ejs');

  assert.match(form, /data-case-index="<%= caseIndex %>" aria-pressed="/);
  assert.match(form, /data-language="<%= lang %>"[\s\S]*?aria-pressed="/);
  assert.match(form, /role="region" aria-label="代码编辑器" aria-busy="true"/);
  assert.match(form, /role="status" aria-live="polite">编辑器加载中/);
  assert.match(form, /setAttribute\('aria-busy', 'false'\)/);
  assert.match(form, /setAttribute\('aria-pressed', item === button \? 'true' : 'false'\)/);
});

test('shell CSS covers required responsive, dark-mode, and reduced-motion contracts', () => {
  const css = readAppCss();

  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\[data-theme="dark"\]/);
  assert.match(css, /\.app-submit-workspace\s*\{[^}]*min-height:\s*clamp\(300px, 38vh, 380px\)/s);
  assert.match(css, /\.app-submit-editor,\s*\.app-submit-editor-stack\s*\{[^}]*min-height:\s*clamp\(300px, 38vh, 380px\)/s);
  assert.match(css, /\.app-table-region\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.app-admin-nav\s*\{[^}]*overflow-x:\s*auto/s);
});

test('shared accessibility pass names dialogs and makes all table regions keyboard reachable', () => {
  const header = read('custom/views/app_header.ejs');
  const script = read('custom/app-v2.js');
  const css = readAppCss();

  assert.match(header, /<main class="app-main" id="app-main" tabindex="-1" aria-busy="true">/);
  assert.match(script, /function setupAccessibleRegions\(\)/);
  assert.match(script, /region\.setAttribute\('role', 'region'\)/);
  assert.match(script, /region\.setAttribute\('tabindex', '0'\)/);
  assert.match(script, /dialog\.setAttribute\('aria-modal', 'true'\)/);
  assert.match(script, /dialog\.setAttribute\('aria-labelledby', heading\.id\)/);
  assert.match(script, /main\.setAttribute\('aria-busy', 'false'\)/);
  assert.match(css, /\.app-button\s*\{[^}]*max-width:\s*100%;[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal/s);
});

test('active application styles keep interface text at a readable minimum', () => {
  const activeStylesheets = [
    'custom/app-shell.css',
    'custom/app-shared.css',
    'custom/app-features.css',
    'custom/username_tiers.css'
  ];
  const undersized = [];

  for (const stylesheet of activeStylesheets) {
    const source = read(stylesheet);
    for (const match of source.matchAll(/font-size:\s*([0-9.]+)px/g)) {
      const size = Number(match[1]);
      if (size > 0 && size < 12) undersized.push(`${stylesheet}:${match[0]}`);
    }
  }

  assert.deepEqual(undersized, []);
  assert.match(read('custom/app-shell.css'), /--app-font-xs:\s*12px/);
  assert.match(read('custom/app-features.css'), /\.app-testcase-detail h3\s*\{[^}]*font-size:\s*var\(--app-font-xs\)/s);
});
