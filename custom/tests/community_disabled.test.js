'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('solution and discussion routes are centrally disabled before feature modules', () => {
  const security = read('custom/modules/_request_security.js');
  assert.match(security, /const communityDisabledRoute =/);
  assert.match(security, /discussion\|article\|solution/);
  assert.match(security, /api\\\/v2\\\/\(\?:discussions\?\|solutions\?/);
  assert.match(security, /COMMUNITY_DISABLED/);
  assert.match(security, /res\.status\(410\)/);
});

test('closed modules keep their data but remove visible home and profile notices', () => {
  const home = read('custom/views/index.ejs');
  const profile = read('custom/views/user.ejs');
  const admin = read('custom/views/admin_info.ejs');
  const maintenance = read('custom/views/admin_other.ejs');

  assert.doesNotMatch(home, /pendingSolutionsCount|admin', 'solutions|题解/);
  assert.doesNotMatch(profile, /DISCUSSIONS|最近帖子|article\.id/);
  assert.doesNotMatch(admin, /pending_solutions|admin', 'solutions|待审核题解/);
  assert.doesNotMatch(maintenance, /reset_discussion|重新计算讨论/);
});
