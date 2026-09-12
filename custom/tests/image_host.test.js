'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'modules/_image_host.js'), 'utf8');
const view = fs.readFileSync(path.join(root, 'views/image_host.ejs'), 'utf8');
const compose = fs.readFileSync(path.join(root, '..', 'docker-compose.yml'), 'utf8');

test('image host protects uploads with problem edit capability and raster validation', () => {
  assert.match(source, /authorize\(user, 'problem:edit'/);
  assert.match(source, /detectSafeRasterImage/);
  assert.match(source, /MAX_IMAGE_SIZE = 10 \* 1024 \* 1024/);
  assert.match(source, /app\.post\('\/api\/v2\/image-host'/);
  assert.match(source, /app\.delete\('\/api\/v2\/image-host\/:id'/);
});

test('image host uses a persistent volume and exposes external links in the UI', () => {
  assert.match(compose, /image-assets:\/app\/static\/self\/image-assets/);
  assert.match(compose, /nwpuoj_image_assets/);
  assert.match(view, /data-image-host-copy/);
  assert.match(view, /外网链接/);
});
