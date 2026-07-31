'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const readAppCss = require('./helpers/read-app-css');

const root = path.resolve(__dirname, '../..');
const view = fs.readFileSync(path.join(root, 'custom/views/problems.ejs'), 'utf8');
const tagEditor = fs.readFileSync(path.join(root, 'custom/views/problem_tag_edit.ejs'), 'utf8');
const tagWorkflow = fs.readFileSync(path.join(root, 'custom/modules/_api_v2_problem_workflows.js'), 'utf8');
const tagPageModule = fs.readFileSync(path.join(root, 'custom/modules/problem_tag.js'), 'utf8');
const css = readAppCss();

test('problem library retains repository, progress, tag, search, sort and bulk controls', () => {
  assert.match(view, /aria-label="题库来源"/);
  assert.match(view, /aria-label="做题状态"/);
  assert.match(view, /data-problem-tags-toggle/);
  assert.match(view, /class="app-problem-search"/);
  assert.match(view, /problemSortUrl\('title'\)/);
  assert.match(view, /id="problem-bulk-delete-form"/);
  assert.match(view, /data-problem-bulk-job/);
  assert.match(view, /\/api\/v2\/problem-jobs\//);
  assert.match(view, /bulk_job/);
});

test('problem tag visibility uses a labeled switch without inheriting native switch dimensions', () => {
  assert.match(view, /class="app-switch-control"[^>]*><input[^>]*data-problem-tags-toggle/);
  assert.match(css, /\.app-switch-control\s*\{[^}]*display: inline-flex[^}]*white-space: nowrap/s);
  assert.match(css, /\.app-switch\s*\{[^}]*appearance: none/s);
  assert.doesNotMatch(view, /<label class="app-switch"><input[^>]*data-problem-tags-toggle/);
});

test('problem library removes saved-view UI, storage, and styling', () => {
  for (const removed of [
    '保存视图',
    'problem-views-dialog',
    'nwpuoj_problem_views_v1_',
    'currentProblemViewUrl',
    'renderProblemViews',
    'problemViewDelete'
  ]) assert.doesNotMatch(view, new RegExp(removed));
  assert.doesNotMatch(css, /\.app-problem-view(?:s|-)/);
});

test('add problem navigates directly to the editor without exposing ZIP import', () => {
  assert.match(view, /class="app-button app-button-primary" href="<%= syzoj\.utils\.makeUrl\(\['problem', 0, 'edit'\]\) %>"/);
  assert.doesNotMatch(view, /problem', 0, 'import'/);
  assert.doesNotMatch(view, /ZIP 批量导入/);
  assert.doesNotMatch(view, /<details class="app-action-menu">/);
});

test('problem tags use an explicit type and derive a consistent color', () => {
  for (const type of ['source', 'category', 'algorithm', 'problem_type', 'difficulty']) {
    assert.match(tagEditor, new RegExp("\\['" + type + "'"));
    assert.match(tagWorkflow, new RegExp(type + ": '[a-z]+'"));
  }
  assert.match(tagEditor, /<select class="app-select" name="category" required>/);
  assert.match(tagEditor, /JSON\.stringify\(\{ name: form\.elements\.name\.value, category: form\.elements\.category\.value \}\)/);
  assert.doesNotMatch(tagEditor, /name="color"/);
  assert.match(tagWorkflow, /color: TAG_TYPE_COLORS\[category\]/);
  assert.match(tagWorkflow, /INSERT INTO problem_tag \(name,color,category\)/);
  assert.match(tagWorkflow, /UPDATE problem_tag SET name=\?,color=\?,category=\?/);
  assert.match(view, /tag\.category === 'problem_type'/);
  assert.doesNotMatch(tagPageModule, /app\.post\(/);
});
