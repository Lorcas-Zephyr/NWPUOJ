'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { validSignature, installPlainTextSignature } = require('../libs/user-signature');

test('signature rendering preserves Markdown and HTML as literal text, including repeated renders', async () => {
  class User { async renderInformation() { throw Error('Markdown renderer must not run'); } }
  installPlainTextSignature(User);
  for (const information of ['**你好** <b>世界</b>', '[链接](https://example.test)', '😀'.repeat(50), '', null]) {
    const user = Object.assign(new User(), { information });
    await user.renderInformation();
    await user.renderInformation();
    assert.equal(user.information, information == null ? '' : information);
    assert.equal(validSignature(user.information), true);
  }
});

test('self profile endpoint saves fifty characters unchanged and rejects fifty-one without a write', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_identity.js'), 'utf8');
  for (const information of ['', '中'.repeat(50), '😀'.repeat(50), '**纯文本** <b>签名</b>', 'a'.repeat(51), '中'.repeat(51), '😀'.repeat(51)]) {
    const user = { id: 20, username: 'fixture', email: 'fixture@example.test', information: '', sex: '0' };
    const writes = [];
    let handler;
    const db = { async transaction(callback) { return callback(db); }, async query(sql, values) {
      if (sql.startsWith('SELECT * FROM user')) return [{ ...user }];
      if (sql.startsWith('SELECT user_id,student_id')) return [];
      if (sql.startsWith('UPDATE user SET username=')) { writes.push(values); user.information = values[2]; return {}; }
      throw Error('Unexpected SQL: ' + sql);
    } };
    const context = vm.createContext({
      app: { patch: (url, callback) => { assert.equal(url, '/api/v2/me'); handler = callback; } },
      validSignature, TypeORM: { getConnection: () => db },
      User: { deleteFromCache() {}, findById: async () => user },
      api: () => ({ ifMatch: () => true, send: (_res, data) => ({ status: 200, data }),
        fail: (_res, status, code, message, fields) => ({ status, code, message, fields }) }),
      contentDomain: { appendEvent: async () => 'event' },
      syzoj: { utils: {
        isValidUsername: () => true,
        authorizationV2: { authorize: async () => true, recordAudit: async () => 'audit' },
        registrationIdentityV2: { ensureRegistrationSchema: async () => {}, findProfile: async () => null, profileResource: () => null }
      } }
    });
    vm.runInContext(source.slice(source.indexOf('function publicMe('), source.indexOf('function destroySession(')), context);
    vm.runInContext(source.slice(source.indexOf("app.patch('/api/v2/me',"), source.indexOf('\nensureIdentitySchema().catch')), context);
    const result = await handler({ body: { information, if_match: 'fixture' }, get: () => '' }, { locals: { user } });
    if (Array.from(information).length > 50) {
      assert.equal(result.status, 422);
      assert.equal(result.fields.information, 'maximum length is 50');
      assert.equal(writes.length, 0);
    } else {
      assert.equal(result.status, 200);
      assert.equal(result.data.information, information);
      assert.equal(writes.length, 1);
    }
  }
});
