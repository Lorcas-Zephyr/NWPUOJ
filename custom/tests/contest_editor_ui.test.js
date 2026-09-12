'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const readAppCss = require('./helpers/read-app-css');

const root = path.resolve(__dirname, '../..');
const view = fs.readFileSync(path.join(root, 'custom/views/contest_edit.ejs'), 'utf8');
const css = readAppCss();

test('contest editor keeps one server form and adds a four-step workflow', () => {
  assert.match(view, /id="contest-editor-form"/);
  assert.match(view, /data-contest-editor-v2/);
  assert.match(view, /var stepLabels = \['基本信息', '题目与管理员', '赛程与赛制'/);
  assert.match(view, /dataset\.contestStepTarget/);
  assert.match(view, /function validateStep\(index\)/);
  assert.match(view, /function moveToStep\(target\)/);
  assert.match(view, /currentStep !== editorSections\.length - 1/);
});

test('contest save and deletion prefer validated idempotent v2 contracts', () => {
  assert.match(view, /var endpoint = '\/api\/v2\/contests'/);
  assert.match(view, /fetch\(endpoint,/);
  assert.match(view, /endpoint \+= '\/' \+ encodeURIComponent\(contestId\) \+ '\/update'/);
  assert.match(view, /method = 'POST'/);
  assert.match(view, /headers\['If-Match'\] = etag/);
  assert.match(view, /problem_ids: pickerValues\('problems'\)/);
  assert.match(view, /ranking_params: rankingValue\(\)/);
  assert.match(view, /data-contest-delete-v2/);
  assert.match(view, /encodeURIComponent\(deleteForm\.dataset\.contestId\) \+ '\/delete'/);
  assert.match(view, /method: 'POST'/);
  assert.doesNotMatch(view, /API_DOMAIN_DISABLED|legacySubmit|HTMLFormElement\.prototype\.submit/);
  assert.match(view, /Idempotency-Key/);
});

test('contest editor provides a live save or publish review without duplicating fields', () => {
  assert.match(view, /review\.className = 'app-contest-review'/);
  assert.match(view, /data-review-problems/);
  assert.match(view, /data-review-schedule/);
  assert.match(view, /data-review-visibility/);
  assert.match(view, /selectedLabels\('problems'\)/);
  assert.match(view, /editorForm\.addEventListener\('formdata'/);
  assert.match(view, /beforeunload/);
});

test('contest entity picker continues to submit normalized IDs', () => {
  assert.match(view, /function normalizeValue\(value\)/);
  assert.match(view, /hidden\.name = fieldName/);
  assert.match(view, /event\.formData\.append\(fieldName, value\)/);
  assert.match(view, /items\.forEach\(function \(item\)/);
  assert.doesNotMatch(view, /items\.slice\(0, 10\)/);
  assert.match(css, /\.app-entity-results\s*\{[^}]*grid-auto-rows:\s*34px;[^}]*max-height:\s*352px;[^}]*overflow-y:\s*auto;/s);
  assert.doesNotMatch(view, /Problem is not defined/);
});

test('a contest draft may submit an explicitly empty problem list', () => {
  assert.match(view, /data-empty-contest-problems/);
  assert.match(view, /可以先保存空题目草稿/);
  assert.match(view, /data-review-problems/);
});

test('contest schedule uses minute-precision native pickers and saves zero seconds', () => {
  assert.equal((view.match(/type="datetime-local"/g) || []).length, 2);
  assert.equal((view.match(/step="60"/g) || []).length, 2);
  assert.equal((view.match(/data-app-datetime-picker/g) || []).length, 2);
  assert.match(view, /name="start_time" value="<%= syzoj\.utils\.formatDate\(contest\.start_time \|\| syzoj\.utils\.getCurrentDate\(\), 'YYYY-MM-DDTHH:mm'\) %>"/);
  assert.match(view, /name="end_time" value="<%= syzoj\.utils\.formatDate\(contest\.end_time \|\| syzoj\.utils\.getCurrentDate\(\), 'YYYY-MM-DDTHH:mm'\) %>"/);
  assert.match(view, /date\.setSeconds\(0, 0\)/);
});

test('contest editor can restrict participation to generated contest accounts', () => {
  assert.match(view, /name="allow_registration"/);
  assert.match(view, /关闭后仅可通过管理员生成的比赛账号参赛/);
  assert.match(view, /allow_registration: !!editorForm\.querySelector/);
  assert.match(view, /仅限比赛账号/);
});

test('contest steps are stable on desktop and remain one horizontal rail on mobile', () => {
  assert.match(css, /\.app-contest-step-nav ol\s*\{[^}]*grid-template-columns: repeat\(4,/s);
  assert.match(css, /\.app-contest-editor-form\.is-wizard-ready > \.app-settings-section:not\(\[hidden\]\)/);
  assert.match(css, /\.app-contest-review dl\s*\{[^}]*grid-template-columns: repeat\(2,/s);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.app-contest-step-nav ol\s*\{[^}]*min-width: 520px/s);
});

test('every contest step is connected from its marker to the next marker', () => {
  assert.match(css, /\.app-contest-step-nav li:not\(:last-child\)::after\s*\{[^}]*left: 16px;[^}]*width: 100%;[^}]*height: 2px;/s);
});
