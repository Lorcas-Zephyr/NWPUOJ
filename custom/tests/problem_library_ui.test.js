'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const readAppCss = require('./helpers/read-app-css');

const root = path.resolve(__dirname, '../..');
const view = fs.readFileSync(path.join(root, 'custom/views/problems.ejs'), 'utf8');
const bulkImportView = fs.readFileSync(path.join(root, 'custom/views/problem_bulk_import.ejs'), 'utf8');
const problemDomain = fs.readFileSync(path.join(root, 'custom/modules/_api_v2_problem_domain.js'), 'utf8');
const problemLifecycleGuard = fs.readFileSync(path.join(root, 'custom/modules/_problem_lifecycle_guard.js'), 'utf8');
const tagEditor = fs.readFileSync(path.join(root, 'custom/views/problem_tag_edit.ejs'), 'utf8');
const tagManagementView = fs.readFileSync(path.join(root, 'custom/views/problem_tags_manage.ejs'), 'utf8');
const tagWorkflow = fs.readFileSync(path.join(root, 'custom/modules/_api_v2_problem_workflows.js'), 'utf8');
const tagPageModule = fs.readFileSync(path.join(root, 'custom/modules/problem_tag.js'), 'utf8');
const tagModel = fs.readFileSync(path.join(root, 'custom/models-built/problem_tag.js'), 'utf8');
const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
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
  assert.match(view, /data-problem-bulk-action/);
  assert.match(view, /data-bulk-action="publish"/);
  assert.match(view, /data-bulk-action="unpublish"/);
  assert.match(view, /data-bulk-action="archive"/);
  assert.match(view, /data-bulk-action="add-tag"/);
  assert.match(view, /data-bulk-tag-select/);
  assert.match(view, /\/api\/v2\/problems\/bulk-tags/);
  assert.match(view, /problem\.allowedTag/);
  assert.match(view, /canBulkPublish/);
  assert.match(view, /problem\.allowedPublish \|\| problem\.allowedArchive/);
  assert.match(view, /class="app-problem-select-cell"/);
  assert.match(css, /\.app-problem-table \.app-problem-select-cell\s*\{[^}]*width:\s*52px;[^}]*min-width:\s*52px;[^}]*max-width:\s*52px;[^}]*text-align:\s*center/s);
  assert.match(view, /<th class="app-problem-select-cell"><input type="checkbox" data-select-all/);
  assert.match(view, /function syncBulkSelection\(\)/);
  assert.match(view, /button\.disabled = selected === 0/);
  assert.match(view, /if \(!actionLabels\[bulkAction\]\) return/);
  assert.doesNotMatch(view, /if \(!bulkActionLabels\[bulkAction\]\) return/);
  const repositories = fs.readFileSync(path.join(root, 'custom/libs-built/problem_repositories.js'), 'utf8');
  assert.match(repositories, /problem\.allowedArchive[\s\S]*'problem:archive'/);
  assert.match(repositories, /problem\.allowedPublish[\s\S]*'problem:publish'/);
  assert.match(repositories, /problems\.some\(problem => problem\.allowedArchive\)/);
  assert.match(repositories, /problems\.some\(problem => problem\.allowedPublish\)/);
});

test('problem progress links use the submission verdict palette without turning link blue', () => {
  for (const variant of ['accepted', 'wrong', 'runtime', 'time', 'memory', 'compile']) {
    assert.match(view, new RegExp(`app-verdict app-verdict-` + variant));
    assert.match(css, new RegExp(`\\.app-verdict-` + variant));
  }
  assert.match(view, /<a href="<%= syzoj\.utils\.makeUrl\(\['submission', problem\.judge_state\.id\]\) %>" class="app-status/);
  assert.match(css, /\.app-v2 a\.app-status,\s*\.app-v2 a\.app-status:hover\s*\{[^}]*color:\s*var\(--app-status-color\)/s);
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

test('add problem menu exposes batch import while the template stays on the import page', () => {
  assert.match(view, /app-add-problem-menu/);
  assert.match(view, /批量导入题目/);
  assert.doesNotMatch(view, /下载导入示例/);
  assert.match(problemDomain, /app\.get\('\/problems\/import\/template'/);
  assert.match(problemDomain, /BULK_PROBLEM_TEMPLATE/);
  assert.match(problemDomain, /type: 'traditional'/);
  assert.match(problemDomain, /time_limit: 1000/);
  assert.match(problemDomain, /python_time_limit_multiplier: 2/);
  assert.match(problemDomain, /memory_limit: 256/);
  assert.match(problemDomain, /app\.post\('\/api\/v2\/problems\/import', requireCapability\('problem:create'\)/);
  assert.match(problemDomain, /directoryContainsFiles/);
  assert.match(problemDomain, /description: ''[\s\S]*input_format: ''[\s\S]*limit_and_hint: ''/);
  assert.match(problemLifecycleGuard, /__normalizesFieldValues/);
  assert.match(problemLifecycleGuard, /value\[field\] = value\[field\] == null \? '' : String\(value\[field\]\)/);
  assert.match(problemLifecycleGuard, /rendered\[field\] = rendered\[field\] == null \? '' : String\(rendered\[field\]\)/);
  assert.match(bulkImportView, /data-problem-bulk-import/);
  assert.match(bulkImportView, /\['api', 'v2', 'problems', 'import'\]/);
  assert.match(bulkImportView, /failureMessage/);
  assert.match(bulkImportView, /name="problems_zip"/);
  assert.match(bulkImportView, /testdata\.zip/);
  assert.match(bulkImportView, /statement\.md/);
});

test('problem tags use an explicit type and derive a consistent color', () => {
  for (const type of ['source', 'category', 'algorithm', 'problem_type', 'difficulty']) {
    assert.match(tagEditor, new RegExp("\\['" + type + "'"));
    assert.match(tagWorkflow, new RegExp(type + ": '[a-z]+'"));
  }
  assert.match(tagEditor, /<select class="app-select" name="category" required>/);
  assert.match(tagEditor, /JSON\.stringify\(requestBody\)/);
  assert.doesNotMatch(tagEditor, /name="color"/);
  assert.match(tagWorkflow, /color: TAG_TYPE_COLORS\[category\]/);
  assert.match(tagWorkflow, /INSERT INTO problem_tag \(name,color,category\)/);
  assert.match(tagWorkflow, /UPDATE problem_tag SET name=\?,color=\?,category=\?/);
  assert.match(tagWorkflow, /app\.post\('\/api\/v2\/problems\/bulk-tags'/);
  assert.match(tagWorkflow, /normalizeBulkTagInput/);
  assert.match(view, /tag\.category === 'problem_type'/);
  assert.match(tagPageModule, /problems\/tags\/manage/);
  assert.match(tagManagementView, /data-tag-management-form/);
  assert.match(tagManagementView, /data-tag-create/);
  assert.match(tagManagementView, /data-tag-edit/);
  assert.match(tagManagementView, /data-tag-delete/);
  assert.match(tagManagementView, /If-Match/);
  assert.match(tagManagementView, /requestBody\.if_match = editingEtag/);
  assert.match(tagManagementView, /\/api\/v2\/tags/);
  assert.match(tagEditor, /currentBody && currentBody\.meta && currentBody\.meta\.etag/);
  assert.match(tagEditor, /requestBody\.if_match = headers\['If-Match'\]/);
  assert.match(tagWorkflow, /req\.body && req\.body\.if_match/);
  assert.doesNotMatch(tagPageModule, /app\.post\(/);
  assert.match(tagModel, /ProblemTag\.prototype, "category"/);
  assert.match(tagModel, /length: 32/);
  assert.match(compose, /custom\/models-built\/problem_tag\.js:\/app\/models-built\/problem_tag\.js:ro/);
  assert.match(compose, /custom\/views\/problem_tags_manage\.ejs:\/app\/views\/problem_tags_manage\.ejs:ro/);
});
