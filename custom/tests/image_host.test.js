'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'modules/_image_host.js'), 'utf8');
const view = fs.readFileSync(path.join(root, 'views/image_host.ejs'), 'utf8');
const compose = fs.readFileSync(path.join(root, '..', 'docker-compose.yml'), 'utf8');

test('image host protects uploads with problem edit capability and raster validation', () => {
  assert.match(source, /authorize\(user, 'problem:edit'/);
  assert.match(source, /baseWorkspace\.isMember\(user\)/);
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

test('image resources provide origin-independent Markdown while preserving external share links', () => {
  const context = { IMAGE_HOST_URL_PREFIX: '/self/image-assets/',
    syzoj: { utils: { getPublicBaseUrl: () => 'https://noj.nwpu.edu.cn' } },
    api: () => ({ databaseIso: value => value }) };
  vm.runInNewContext(source.slice(source.indexOf('function relativeUrl('), source.indexOf('async function recordAudit(')), context);
  for (const storageName of ['fixture.png', 'archive/图 示#1.png']) {
    const asset = context.resource({ id: 1, storage_name: storageName, original_name: '示意图.png',
      mime_type: 'image/png', file_size: 123, created_at: '2026-11-13T00:00:00Z', uploader_id: 2 }, {});
    const relative = '/self/image-assets/' + storageName.split('/').map(encodeURIComponent).join('/');
    assert.equal(asset.relative_url, relative);
    assert.equal(asset.markdown, `![示意图.png](${relative})`);
    assert.equal(asset.url, 'https://noj.nwpu.edu.cn' + relative);
    for (const origin of ['http://10.0.0.8:8080', 'https://noj.nwpu.edu.cn']) {
      assert.equal(new URL(asset.relative_url, origin + '/problem/7/edit').href, origin + relative);
    }
  }
});

test('base members can reach the image host from problem editors and shared navigation', () => {
  const problemEditor = fs.readFileSync(path.join(root, 'views/problem_edit.ejs'), 'utf8');
  const header = fs.readFileSync(path.join(root, 'views/app_header.ejs'), 'utf8');
  assert.match(problemEditor, /appProblemCanUseImageHost/);
  assert.match(problemEditor, /href="\/image-host"/);
  assert.match(header, /appCanUseImageHost/);
  assert.match(header, /baseMember/);
});

test('editor image addresses stay portable without changing unrelated external URLs', () => {
  const editor = fs.readFileSync(path.join(root, 'static-libs/noj-markdown.js'), 'utf8');
  const context = { URL, location: { origin: 'http://10.0.0.8:8080' } };
  vm.runInNewContext(editor.slice(editor.indexOf('  function imageAddress('), editor.indexOf('  function insertImage(')), context);
  const relative = '/self/image-assets/diagram%20one.png?version=2#preview';
  for (const address of [relative, 'https://noj.nwpu.edu.cn' + relative, 'http://10.0.0.8:8080' + relative]) {
    assert.equal(context.imageAddress(address), relative);
  }
  assert.equal(context.imageAddress('https://example.test/figure.png'), 'https://example.test/figure.png');
  for (const address of ['', undefined, 'javascript:alert(1)', 'data:text/html,test']) {
    assert.throws(() => context.imageAddress(address), /图片地址无效/);
  }
});
