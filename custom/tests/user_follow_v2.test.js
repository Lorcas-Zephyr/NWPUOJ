'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('follow mutations are transaction-backed, evented, and exposed through v2', () => {
  const route = read('custom/modules/user_follow.js');
  assert.match(route, /async function setFollow\(actorId, targetId, following\)/);
  assert.match(route, /transaction\('READ COMMITTED'/);
  assert.match(route, /SELECT id FROM user WHERE id=\? FOR UPDATE/);
  assert.match(route, /contentDomain\.appendEvent\(manager/);
  assert.match(route, /type: following \? 'user\.followed' : 'user\.unfollowed'/);
  assert.match(route, /app\.post\('\/api\/v2\/users\/:id\/follow'/);
  assert.match(route, /app\.delete\('\/api\/v2\/users\/:id\/follow'/);
});

test('profile follow controls use only v2 writes', () => {
  const view = read('custom/views/user.ejs');
  assert.match(view, /data-user-follow-v2="follow"/);
  assert.match(view, /data-user-follow-v2="unfollow"/);
  assert.match(view, /\/api\/v2\/users\/.*\/follow/);
  assert.match(view, /method: action === 'unfollow' \? 'DELETE' : 'POST'/);
  assert.match(view, /Idempotency-Key/);
  assert.doesNotMatch(view, /API_DOMAIN_DISABLED|legacySubmit|HTMLFormElement\.prototype\.submit/);
});
