'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('avatar v2 writes validate access before bounded upload and persist evented changes', () => {
  const route = read('custom/modules/_api_v2_avatar.js');
  const service = read('custom/modules/_user_avatar.js');
  assert.match(route, /authorizeAvatar/);
  assert.match(route, /avatar\.receiveAvatarApi/);
  assert.match(route, /app\.post\('\/api\/v2\/users\/:id\/avatar'/);
  assert.match(route, /app\.delete\('\/api\/v2\/users\/:id\/avatar'/);
  assert.match(service, /MAX_AVATAR_SIZE = 2 \* 1024 \* 1024/);
  assert.match(service, /detectSafeRasterImage/);
  assert.match(service, /fs\.constants\.COPYFILE_EXCL/);
  assert.match(service, /contentDomain\.appendEvent\(manager/);
});

test('avatar controls use only v2 writes', () => {
  const view = read('custom/views/user_edit.ejs');
  assert.match(view, /data-avatar-v2/);
  assert.match(view, /data-avatar-delete-v2/);
  assert.match(view, /\/api\/v2\/users\/.*\/avatar/);
  assert.match(view, /method: 'POST'/);
  assert.match(view, /method: 'DELETE'/);
  assert.match(view, /Idempotency-Key/);
  assert.doesNotMatch(view, /API_DOMAIN_DISABLED|legacySubmit|HTMLFormElement\.prototype\.submit/);
});
