'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

function fixture(publicUrl = '') {
  const routes = new Map(), matched = [];
  const row = { id: 5, user_id: 7, title: '分享测试', content: 'test', visibility: 'link', share_token: 'a'.repeat(36), share_expires: null, public_time: 1, update_time: 1 };
  const req = { params: { id: 5 }, query: {}, body: {}, protocol: 'http', get: name => ({ host: 'noj.nwpu.edu.cn', 'x-forwarded-proto': 'https' })[name.toLowerCase()] };
  const api = { ensureFoundationSchema: async () => {}, parseLimit: () => 30, decodeCursor: () => null,
    ifMatch: (request, resource) => { assert.equal(request, req); matched.push(resource.share_url); return true; },
    send: (res, data) => { res.data = data; }, fail: (_res, _status, code) => { throw Error(code); } };
  const db = { query: async () => [row], transaction: async fn => fn(db) };
  const contentDomain = {
    createClipboard: async () => ({ ...row }),
    updateClipboard: async (_db, input) => { assert.equal(input.ifMatch(row), true); return { ...row }; },
    shareClipboard: async (_db, input) => { assert.equal(input.ifMatch(row), true); return { ...row, share_token: 'b'.repeat(36) }; },
    deleteClipboard: async (_db, input) => { assert.equal(input.ifMatch(row), true); return { id: row.id }; },
    readSharedClipboard: async () => row
  };
  const context = { process: { env: { SYZOJ_PUBLIC_URL: publicUrl } }, ErrorMessage: Error, app: {}, syzoj: { log() {},
    model: name => name === 'clipboard-item' ? { findById: async () => row } : { findById: async () => ({ id: 7, username: 'fixture' }) },
    utils: { apiV2: api, authorizationV2: { authorize: async () => true }, makeUrl: parts => '/' + parts.join('/'), markdown: async text => text,
      getCurrentLocation: request => (request.get('X-Forwarded-Proto') || request.protocol) + '://' + request.get('host') }
  }, require(name) {
    if (name === 'typeorm') return { getConnection: () => db };
    if (name === '../libs/content-domain') return contentDomain;
    if (name === '../libs/user-mentions') return {};
    return require(name);
  } };
  for (const method of ['get', 'post', 'patch', 'delete', 'put', 'use']) context.app[method] = (route, callback) => routes.set(method + ' ' + route, callback);
  const helper = read('modules/_request_security.js').match(/syzoj\.utils\.getPublicBaseUrl = function getPublicBaseUrl\(req\) \{[\s\S]*?\n\};/)[0];
  vm.runInNewContext(helper, context);
  vm.runInNewContext(read('modules/clipboard.js'), context);
  vm.runInNewContext(read('modules/_api_v2_content_domain.js'), context);
  return { row, req, matched, async call(route) {
    const res = { locals: { user: { id: 7 }, apiMeta: {} }, render: (view, data) => { res.view = view; res.data = data; } };
    await routes.get(route)(req, res);
    return res;
  } };
}

test('clipboard page and all API representations expose complete HTTPS sharing URLs behind the proxy', async () => {
  const f = fixture(), expected = 'https://noj.nwpu.edu.cn/clipboard/share/' + f.row.share_token;
  assert.equal((await f.call('get /clipboard/:id')).data.shareUrl, expected);
  assert.equal((await f.call('get /api/v2/clipboard')).data[0].share_url, expected);
  for (const route of ['get /api/v2/clipboard/:id', 'post /api/v2/clipboard', 'patch /api/v2/clipboard/:id', 'get /api/v2/clipboard/shared/:token']) {
    assert.equal((await f.call(route)).data.share_url, expected, route);
  }
  assert.equal((await f.call('post /api/v2/clipboard/:id/share')).data.share_url, 'https://noj.nwpu.edu.cn/clipboard/share/' + 'b'.repeat(36));
  await f.call('delete /api/v2/clipboard/:id');
  assert.deepEqual(f.matched, [expected, expected, expected], 'ETag checks use the same absolute URL as GET');
});

test('configured public origin takes precedence over LAN access and non-shared items do not expose a token', async () => {
  const f = fixture('https://noj.nwpu.edu.cn/');
  f.req.get = () => '10.12.13.230';
  assert.equal((await f.call('get /clipboard/:id')).data.shareUrl, 'https://noj.nwpu.edu.cn/clipboard/share/' + f.row.share_token);
  for (const visibility of ['private', 'public']) {
    f.row.visibility = visibility;
    assert.equal((await f.call('get /clipboard/:id')).data.shareUrl, null);
    assert.equal((await f.call('get /api/v2/clipboard/:id')).data.share_url, null);
  }
});

let chromium;
try { ({ chromium } = require('playwright')); } catch (_) {}
test('real clipboard view displays and copies the full sharing URL', { skip: !chromium }, async () => {
  const f = fixture(), data = (await f.call('get /clipboard/:id')).data;
  const template = read('views/clipboard_view.ejs').replace('<% include app_header %>', '').replace('<% include app_footer %>', '').replace('<% include clipboard_v2_script %>', '');
  const rendered = spawnSync('docker', ['exec', '-i', 'nwpuoj-web-1', 'node', '-e', `const fs=require('fs'),ejs=require('/app/node_modules/ejs');const x=JSON.parse(fs.readFileSync(0,'utf8'));x.data.syzoj={utils:{makeUrl:p=>'/'+p.join('/'),renderUsername:u=>u.username,formatDate:()=>''}};process.stdout.write(ejs.render(x.template,x.data));`], { input: JSON.stringify({ template, data }), encoding: 'utf8', timeout: 20000 });
  assert.equal(rendered.status, 0, rendered.stderr);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.markdownit = () => ({ render: text => text });
      document.execCommand = command => { if (command !== 'copy') return false; window.copiedText = document.activeElement.value; return true; };
    });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/clipboard/5') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>' + rendered.stdout + '<script src="/self/app-v2.js"></script></body></html>' });
      if (url.pathname === '/self/app-v2.js') return route.fulfill({ contentType: 'application/javascript', body: read('app-v2.js') });
      return route.fulfill({ contentType: 'application/javascript', body: '' });
    });
    await page.goto('https://noj.nwpu.edu.cn/clipboard/5');
    assert.equal(await page.locator('#share-url-input').inputValue(), data.shareUrl);
    await page.locator('[data-copy="#share-url-input"]').click();
    assert.equal(await page.evaluate(() => window.copiedText), data.shareUrl);
  } finally { await browser.close(); }
});
