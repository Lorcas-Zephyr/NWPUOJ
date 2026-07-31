'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const readAppCss = require('./helpers/read-app-css');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('markdown editors discard a rejected local draft instead of prompting forever', () => {
  const script = read('custom/views/markdown_editor_script.ejs');

  assert.match(script, /function clearDraft\(\)\s*\{[^}]*localStorage\.removeItem\(draftKey\)/s);
  assert.match(script, /if \(savedDraft && sameDraft\(savedDraft, serverDraft\)\) clearDraft\(\)/);
  assert.match(script, /var shouldRestore = window\.confirm\('检测到未提交的本地草稿，是否恢复？'\)/);
  assert.match(script, /if \(shouldRestore\)\s*\{[\s\S]*?status\('已恢复本地草稿'\);\s*\} else \{\s*clearDraft\(\);\s*\}/);
  assert.match(script, /form\.addEventListener\('submit', function \(\) \{[^}]*clearDraft\(\); status\('正在提交\.\.\.'\); submitted = true/s);
  assert.doesNotMatch(script, /form\.addEventListener\('submit', function \(\) \{[^}]*saveDraft\(\)/s);
});

test('admin help draft storage stays isolated per administrator', () => {
  const view = read('custom/views/admin_help_edit.ejs');

  assert.match(view, /data-markdown-editor/);
  assert.match(view, /data-draft-key="content-draft:admin-help:<%= user\.id %>"/);
  assert.match(view, /data-save-draft/);
});

test('Markdown editors use a live split workspace on wide screens and tabs on narrow screens', () => {
  const script = read('custom/views/markdown_editor_script.ejs');
  const css = readAppCss();

  for (const view of ['custom/views/article_edit.ejs', 'custom/views/solution_edit.ejs', 'custom/views/admin_help_edit.ejs']) {
    const source = read(view);
    assert.match(source, /class="app-editor-workspace"/, view + ' must use one shared workspace');
    assert.match(source, /data-editor-panel="preview"[^>]*aria-live="polite"/, view + ' preview must announce updates');
  }
  assert.match(script, /window\.matchMedia \? window\.matchMedia\('\(min-width: 961px\)'\)/);
  assert.match(script, /function isSplitEditor\(\)/);
  assert.match(script, /function schedulePreview\(\)/);
  assert.match(script, /previewTimer = window\.setTimeout\(renderPreview, 500\)/);
  assert.match(script, /if \(splitViewport\.addEventListener\)/);
  assert.match(script, /function syncEditorScroll\(source, target\)/);
  assert.match(script, /content\.addEventListener\('scroll'[^\n]*syncEditorScroll\(content, previewPanel\)/);
  assert.match(script, /previewPanel\.addEventListener\('scroll'[^\n]*syncEditorScroll\(previewPanel, editorScrollTarget\(\)\)/);
  assert.doesNotMatch(script, /editPanel\.addEventListener\('scroll'/);
  assert.match(css, /@media \(min-width: 961px\)\s*\{[\s\S]*?\[data-markdown-editor\]\.is-split-editor \.app-editor-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  assert.match(css, /\[data-markdown-editor\]\.is-split-editor \.app-editor-workspace\s*\{[^}]*height:\s*clamp\(540px, 64vh, 760px\)/s);
  assert.match(css, /\.app-editor-workspace > \[data-editor-panel\]\s*\{[^}]*height:\s*100%[^}]*max-height:\s*100%/s);
  assert.match(css, /\[data-markdown-editor\]\.is-split-editor \.app-editor-workspace > \[data-editor-panel="edit"\]\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\[data-markdown-editor\]\.is-split-editor \.app-editor-content-field > textarea\s*\{[^}]*overflow-y:\s*auto[^}]*resize:\s*none/s);
  for (const view of ['custom/views/article_edit.ejs', 'custom/views/solution_edit.ejs', 'custom/views/admin_help_edit.ejs']) {
    assert.match(read(view), /app-editor-content-field/, view + ' must identify its single source scroll owner');
  }
  assert.match(css, /@media \(max-width: 960px\)/);
});

test('clipboard Markdown panes keep equal geometry and synchronize in both directions', () => {
  const view = read('custom/views/clipboard_edit.ejs');
  const css = readAppCss();

  assert.match(view, /function syncScroll\(source, target\)/);
  assert.match(view, /textarea\.addEventListener\('scroll'[^\n]*syncScroll\(textarea, preview\)/);
  assert.match(view, /preview\.addEventListener\('scroll'[^\n]*syncScroll\(preview, textarea\)/);
  assert.match(css, /\.app-clipboard-editor\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
});
