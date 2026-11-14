'use strict';
// Opt-in real multipart regression using the deployed Express/Multer versions.
// Runs a separate local fixture server; temporary files are deleted, and no
// production account, avatar directory or database is read or changed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('avatar HTTP uploads honor the two MiB file boundary through the gateway and multipart parser', { timeout: 60000 }, () => {
  const run = async function () {
    const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
    const http = require('http'), express = require('express'), multer = require('multer'), assert = require('assert').strict;
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-upload-test-'));
    const helperModule = { exports: {} };
    vm.runInNewContext(input.helpers, { module: helperModule, exports: helperModule.exports, require, Buffer });
    const api = {
      send: (res, data, status = 200) => res.status(status).json({ data }),
      fail: (res, status, code, message, fields) => res.status(status).json({ error: { code, message, fields } })
    };
    const sandbox = { apiHelpers: helperModule.exports, apiFail: api.fail, syzoj: { config: {}, utils: { apiV2: api } },
      multer, os: { tmpdir: () => directory }, MAX_AVATAR_SIZE: 2 * 1024 * 1024, ALLOWED_MIME: new Set(['image/jpeg', 'image/png', 'image/webp']) };
    vm.runInNewContext(input.gateway, sandbox);
    vm.runInNewContext(input.receiver, sandbox);
    const app = express(), stored = [];
    const cleanupFile = file => { if (file && fs.existsSync(file)) fs.unlinkSync(file); };
    sandbox.syzoj.model = () => ({ findById: async id => ({ id }) });
    sandbox.syzoj.utils.userAvatarV2 = {
      canManageAvatar: async (user, id) => !!user && user.id === id,
      receiveAvatarApi: sandbox.receiveAvatarApi,
      cleanupFile,
      updateAvatar: async (userId, file) => {
        stored.push({ userId, size: file.size });
        cleanupFile(file.path);
        return { imagePath: '/fixture-avatar.png', eventId: 'fixture' };
      }
    };
    app.use((req, res, next) => { res.locals.user = req.get('x-fixture-user') ? { id: Number(req.get('x-fixture-user')) } : null; next(); });
    app.use('/api/v2', (req, res, next) => { if (sandbox.gatewayLimits(req, res)) next(); });
    sandbox.app = app;
    vm.runInNewContext(input.route, sandbox);
    let server;
    try {
      server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
      const upload = (size, chunked = false, user = 7, mime = 'image/png') => new Promise((resolve, reject) => {
        const boundary = 'avatar-fixture-boundary';
        const body = Buffer.concat([
          Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="avatar"; filename="fixture.png"\r\nContent-Type: ' + mime + '\r\n\r\n'),
          Buffer.alloc(size, 65), Buffer.from('\r\n--' + boundary + '--\r\n')
        ]);
        const headers = { 'Content-Type': 'multipart/form-data; boundary=' + boundary };
        if (user) headers['X-Fixture-User'] = String(user);
        if (!chunked) headers['Content-Length'] = String(body.length);
        const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/v2/users/7/avatar', method: 'POST', headers }, response => {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
        });
        request.on('error', reject);
        if (chunked) { request.write(body.subarray(0, 500)); request.end(body.subarray(500)); }
        else request.end(body);
      });
      for (const size of [1.5 * 1024 * 1024, 2 * 1024 * 1024]) {
        const result = await upload(size);
        assert.equal(result.status, 201, JSON.stringify(result));
        assert.equal(stored[stored.length - 1].size, size);
      }
      for (const chunked of [false, true]) {
        const result = await upload(2 * 1024 * 1024 + 1, chunked);
        assert.equal(result.status, 413);
        assert.equal(result.body.error.code, 'AVATAR_TOO_LARGE');
      }
      const oversized = await upload(3 * 1024 * 1024);
      assert.equal(oversized.status, 413);
      assert.equal(oversized.body.error.code, 'REQUEST_BODY_TOO_LARGE');
      assert.equal((await upload(1.5 * 1024 * 1024, false, null)).status, 401);
      assert.equal((await upload(1.5 * 1024 * 1024, false, 8)).status, 403);
      assert.equal((await upload(100, false, 7, 'image/svg+xml')).status, 422);
      assert.equal(stored.length, 2);
      assert.deepEqual(fs.readdirSync(directory), []);
      process.stdout.write('Multipart size limits, streaming limits, authorization and temporary-file cleanup passed.\n');
    } finally {
      if (server) await new Promise(resolve => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
  const root = path.resolve(__dirname, '../..');
  const read = name => fs.readFileSync(path.join(root, 'custom', name), 'utf8');
  const foundation = read('modules/_api_v2_foundation.js'), avatar = read('modules/_user_avatar.js');
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', '(' + run.toString() + ')().catch(error=>{console.error(error);process.exitCode=1;})'], {
    cwd: root, encoding: 'utf8', timeout: 55000,
    input: JSON.stringify({ helpers: read('libs/api-v2.js'), route: read('modules/_api_v2_avatar.js'),
      gateway: foundation.slice(foundation.indexOf('const rateBuckets ='), foundation.indexOf('function requireCapability(')),
      receiver: avatar.slice(avatar.indexOf('const avatarUpload ='), avatar.indexOf('function ensureAvatarCsrfToken(')) })
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /temporary-file cleanup passed/);
});
