'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('site notifications have an independent admin workflow from public announcements', () => {
  const moduleSource = read('custom/modules/_admin_notifications.js');
  const header = read('custom/views/admin_header.ejs');
  const announcements = read('custom/views/admin_announcements.ejs');
  const editor = read('custom/views/admin_notification_edit.ejs');

  assert.match(moduleSource, /site_notification/);
  assert.match(moduleSource, /site_notification.*published/s);
  assert.match(moduleSource, /Only site administrators can manage notifications/);
  assert.match(header, /notifications: \['通知管理', 'bell'\]/);
  assert.match(header, /key === 'notifications' && !appIsFullAdmin/);
  assert.match(announcements, /新建公告/);
  assert.doesNotMatch(announcements, /发布通知/);
  assert.match(editor, /发布通知/);
  assert.match(editor, /If-Match/);
});

test('site notifications render Markdown and user mentions only in the notification center', () => {
  const route = read('custom/modules/notification.js');
  const view = read('custom/views/notifications.ejs');
  assert.match(route, /n\.type === 'site_notification'/);
  assert.match(route, /linkUserMentions/);
  assert.match(view, /notification\.contentRendered/);
  assert.match(view, /app-markdown/);
});
