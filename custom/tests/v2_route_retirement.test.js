'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { discover } = require('../scripts/compatibility-inventory');

const root = path.resolve(__dirname, '../..');
const modules = path.join(root, 'custom/modules');
const readModule = file => fs.readFileSync(path.join(modules, file), 'utf8');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('administrative and contest writes authorize through v2 capabilities', () => {
  const admin = readModule('_api_v2_admin_domain.js');
  const identity = readModule('_registration_identity.js');
  const contests = readModule('_api_v2_contest_domain.js');
  const tags = readModule('_user_tag.js');
  const hit = readModule('__hit_score_engine.js');
  const messages = readModule('message.js');

  assert.match(admin, /app\.patch\('\/api\/v2\/admin\/users\/:id', requireCapability\('admin:user\.manage'\)/);
  assert.match(admin, /authorize\(actor, 'admin:permission\.grant'/);
  assert.match(identity, /actorCanManage[\s\S]*?'admin:user\.manage'/);
  assert.match(identity, /actorCanGrant[\s\S]*?'admin:permission\.grant'/);
  assert.doesNotMatch(identity, /if \(res\.locals\.user\.is_admin\)\s*\{\s*requestedPrivileges/);

  assert.match(contests, /authorizationV2\.authorize\(user, 'contest:create'/);
  assert.match(contests, /requireManager\(existing, user, 'contest:edit', res\)/);
  assert.match(contests, /requireManager\(contest, res\.locals\.user, 'contest:standings\.rebuild', res\)/);
  for (const source of [tags, hit, messages]) assert.match(source, /authorizationV2\.authorize\(/);
});

test('community dynamic publishing and reading surfaces are fully removed', () => {
  const home = read('custom/views/index.ejs');
  const compose = read('docker-compose.yml');
  for (const relativePath of [
    'custom/modules/benben.js', 'custom/views/benben_feed.ejs', 'custom/views/benben_detail.ejs',
    'custom/models/benben-post.ts', 'custom/models/benben-image.ts',
    'custom/models-built/benben-post.js', 'custom/models-built/benben-image.js'
  ]) assert.equal(fs.existsSync(path.join(root, relativePath)), false, relativePath + ' must stay removed');
  assert.doesNotMatch(home, /benben|关注动态|发布动态/);
  assert.doesNotMatch(compose, /benben/);
});

test('site administrator flags are restricted to protection and presentation boundaries', () => {
  const identity = readModule('_registration_identity.js');
  const admin = readModule('_api_v2_admin_domain.js');
  const tags = readModule('_user_tag.js');
  assert.match(identity, /editedUser\.is_admin[\s\S]*actorIsOwner/);
  assert.match(admin, /hasAdminStatus[\s\S]*OWNER_CAPABILITY_REQUIRED/);
  assert.match(tags, /if \(user\.is_admin\) return true/);
  assert.match(tags, /calcUserTier\(userId, isAdminFlag\)/);
});

test('v1 routes are physically retired and the runtime guard remains defense in depth', () => {
  const inventory = discover();
  assert.equal(inventory.summary.v1_api_reads, 0);
  assert.equal(inventory.summary.v1_write_routes, 0);
  assert.equal(inventory.summary.v1_write_forms, 0);
  assert.equal(inventory.summary.v1_client_calls, 0);
  assert.equal(inventory.summary.compatibility_adapters, 0);

  const dockerfile = read('Dockerfile.web');
  const retirement = read('custom/scripts/retire-v1-routes.js');
  const guard = read('custom/libs/v2-route-enforcement.js');
  const security = readModule('_request_security.js');
  assert.match(dockerfile, /retire-v1-routes\.js --write --modules-root=\/app\/modules/);
  assert.match(dockerfile, /retire-v1-routes\.js --modules-root=\/app\/modules/);
  assert.match(retirement, /const approvedCallbacks = new Set\(\['\/judge'\]\)/);
  assert.match(guard, /SYZOJ_V2_ONLY/);
  assert.match(guard, /V2_ROUTE_REQUIRED/);
  assert.doesNotMatch(guard, /SYZOJ_LEGACY_WRITES_DISABLED|LEGACY_WRITES_RETIRED/);
  assert.match(security, /v2RouteEnforcement\.shouldBlock\(req\)/);
});
