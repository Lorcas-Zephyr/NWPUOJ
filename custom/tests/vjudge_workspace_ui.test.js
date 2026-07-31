'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const readAppCss = require('./helpers/read-app-css');

const view = fs.readFileSync(path.join(__dirname, '../views/admin_other.ejs'), 'utf8');
const css = readAppCss();

test('VJudge workspace exposes provider tabs, resolvable connection references, and connection lifecycle controls', () => {
  for (const provider of ['uoj', 'hdu', 'poj']) assert.match(view, new RegExp('data-provider="' + provider + '"'));
  assert.match(view, /'env:SYZOJ_WEB_' \+ currentProvider\.toUpperCase\(\)/);
  assert.doesNotMatch(view, /secret:\/\/environment\/SYZOJ_WEB_/);
  assert.match(view, /data-vjudge-disconnect/);
  assert.match(view, /method: 'DELETE'/);
  assert.match(view, /importButton\.disabled = !source\.credential_configured/);
});

test('VJudge workspace renders progress, failure details, recovery actions, and offline states', () => {
  assert.match(view, /app-progress-track/);
  assert.match(view, /查看失败项/);
  assert.match(view, /重试失败项/);
  assert.match(view, /批准导入/);
  assert.match(view, /取消导入/);
  assert.match(view, /当前处于离线状态/);
  assert.match(view, /window\.setInterval[\s\S]*loadJobs/);
});

test('VJudge batch import uses deliberate scope and segmented policy controls', () => {
  assert.match(view, /name="import_scope" value="selected" checked/);
  assert.match(view, /name="import_scope" value="all"/);
  assert.match(view, /data-vjudge-id-count/);
  assert.match(view, /name="visibility" value="private" checked/);
  assert.match(view, /name="visibility" value="public"/);
  assert.match(view, /name="conflict_policy" value="skip" checked/);
  assert.match(view, /name="conflict_policy" value="overwrite"/);
  assert.match(view, /function selectedRemoteIds\(\)/);
  assert.match(view, /var ids = all \? \[\] : selectedRemoteIds\(\)/);
  assert.match(view, /remote_ids: ids/);
  assert.match(view, /\/api\/v2\/vjudge\/sources\/' \+ currentProvider \+ '\/imports'/);
  assert.match(css, /\.app-option-segment\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(css, /\.app-option-segment input:checked \+ span/);
});
