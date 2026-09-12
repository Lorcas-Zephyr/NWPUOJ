'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('problem-set participant management sends protected write requests and reports removal state', () => {
  const participants = read('custom/views/problem_set_participants.ejs');
  const app = read('custom/app-v2.js');
  const footer = read('custom/views/app_footer.ejs');
  const module = read('custom/modules/_problem_sets.js');

  assert.match(participants, /data-set-participant-remove/);
  assert.ok(app.includes("headers.set('X-CSRF-Token', app.csrfToken)"));
  assert.ok(app.includes("headers.set('Idempotency-Key'"));
  assert.ok(footer.includes("headers.set('X-CSRF-Token', csrfToken)"));
  assert.ok(footer.includes("headers.set('Idempotency-Key'"));
  assert.ok(module.includes('const userId = Number(req.params.userId)'));
  assert.ok(module.includes('removed: Number(result.affectedRows || 0) > 0'));
});

test('write method tunnel keeps PATCH, PUT, and DELETE available behind restrictive gateways', () => {
  const api = read('custom/modules/api_v2.js');
  const app = read('custom/app-v2.js');
  const footer = read('custom/views/app_footer.ejs');

  assert.match(api, /x-http-method-override/);
  assert.match(api, /new Set\(\['PATCH', 'PUT', 'DELETE'\]\)/);
  for (const source of [app, footer]) {
    assert.match(source, /methodTunnel = \/\^\(PATCH\|PUT\|DELETE\)\$\//);
    assert.match(source, /(?:headers|tunnelHeaders)\.set\('X-HTTP-Method-Override', method\)/);
    assert.match(source, /(?:next|requestOptions)\.method = 'POST'/);
  }
});

test('problem-set editor sends its current revision when saving', () => {
  const editor = read('custom/views/problem_set_edit.ejs');
  const module = read('custom/modules/_problem_sets.js');

  assert.match(editor, /data-set-etag=/);
  assert.ok(editor.includes("headers['If-Match']=etag"));
  assert.ok(editor.includes('payload.if_match=etag'));
  assert.ok(module.includes('problemSetEditResource(problemSet)'));
  assert.ok(module.includes("'ETAG_MISMATCH'"));
  assert.ok(module.includes("error.statusCode || 422, error.code || 'VALIDATION_FAILED'"));
});
