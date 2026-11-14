'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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

function uploadClient(fileSize, succeeds = true) {
  let submit;
  const messages = [], requests = [], redirects = [];
  const button = { disabled: false };
  const input = { files: fileSize == null ? [] : [{ size: fileSize, name: 'avatar.png' }] };
  const form = {
    dataset: { avatarUserId: '7' },
    querySelector: selector => selector === 'input[name="avatar"]' ? input : button,
    addEventListener: (_event, handler) => { submit = handler; }
  };
  const script = Array.from(read('custom/views/user_edit.ejs').matchAll(/<script>([\s\S]*?)<\/script>/g))
    .map(match => match[1]).find(source => source.includes('form[data-avatar-v2]'));
  vm.runInNewContext(script, {
    document: { querySelectorAll: selector => selector === 'form[data-avatar-v2]' ? [form] : [] },
    window: { NWPUOJApp: { showToast: message => messages.push(message) }, location: { pathname: '/user/7/edit', assign: url => redirects.push(url) } },
    FormData: class { constructor(value) { assert.equal(value, form); } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: succeeds, json: async () => succeeds ? { data: { image_url: '/self/avatar/fixture.png' } } : { error: { message: '上传失败，请重试。' } } };
    }
  });
  return { messages, requests, redirects, button, input, submit: () => submit({ preventDefault() {} }) };
}

test('oversized or missing avatar selections show a clear message without sending a request', async () => {
  for (const [size, message] of [[null, '请选择头像图片。'], [2 * 1024 * 1024 + 1, '头像不能超过 2 MB。']]) {
    const client = uploadClient(size);
    await client.submit();
    assert.deepEqual(client.messages, [message]);
    assert.equal(client.requests.length, 0);
    assert.equal(client.button.disabled, false);
  }
});

test('valid avatars above one MiB and at two MiB are submitted and open the success state', async () => {
  for (const size of [1.5 * 1024 * 1024, 2 * 1024 * 1024]) {
    const client = uploadClient(size);
    await client.submit();
    assert.equal(client.requests.length, 1);
    assert.equal(client.requests[0].url, '/api/v2/users/7/avatar');
    assert.equal(client.requests[0].options.method, 'POST');
    assert.deepEqual(client.redirects, ['/user/7/edit?avatar=uploaded#avatar']);
    assert.deepEqual(client.messages, []);
  }
});

test('failed avatar upload preserves the selection and permits retry', async () => {
  const client = uploadClient(1.5 * 1024 * 1024, false);
  await client.submit();
  assert.equal(client.button.disabled, false);
  assert.equal(client.input.files[0].name, 'avatar.png');
  assert.deepEqual(client.messages, ['上传失败，请重试。']);
  assert.deepEqual(client.redirects, []);
});
