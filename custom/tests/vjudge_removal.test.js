'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const domain = require('../libs/problem-domain');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('retired provider types cannot be created or imported as problems', () => {
  for (const provider of ['uoj', 'hdu', 'poj', 'luogu']) {
    const content = domain.contentFromInput({ title: 'Remote', type: `vjudge:${provider}`, time_limit: 1000, memory_limit: 256 });
    assert.equal(domain.validateContent(content).type, 'unsupported problem type');
    assert.equal('vjudge_config' in content, false);
  }
});

test('upstream provider modules are excluded by the production module loader', async () => {
  const names = ['problem.js', '_api_v2_problem_domain.js', 'uoj_vjudge.js', 'hdu_vjudge.js', 'poj_vjudge.js', 'luogu_vjudge.js', '_api_v2_vjudge_domain.js'];
  const fakeFs = { readdir: (_directory, callback) => callback(null, names.slice()) };
  vm.runInNewContext(read('custom/module-order.js'), { require: name => name === 'fs' ? fakeFs : require(name) });
  const files = await new Promise((resolve, reject) => fakeFs.readdir('/app/modules', (error, result) => error ? reject(error) : resolve(result)));
  assert.deepEqual(files, ['_api_v2_problem_domain.js', 'problem.js']);
});

test('remote services, routes, and credentials are absent from runtime integrations', () => {
  for (const file of ['custom/libs-built/vjudge.js', 'custom/modules/_api_v2_vjudge_domain.js', 'custom/modules/hdu_vjudge.js', 'custom/modules/poj_vjudge.js', 'custom/modules/uoj_vjudge.js']) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
  for (const file of ['custom/libs-built/judger.js', 'custom/modules/_submission_routes.js', 'custom/modules/_api_v2_problem_domain.js', 'custom/modules/_api_v2_problem_workflows.js', 'custom/modules/_api_v2_submission_domain.js', 'custom/libs/authorization-v2.js', 'custom/views/submissions.ejs', 'docker-compose.yml']) {
    assert.doesNotMatch(read(file), /vjudge|SYZOJ_WEB_(?:UOJ|HDU|POJ)_/i, file);
  }
  assert.match(read('Dockerfile.web'), /rm -f \/app\/libs\/vjudge\.js/);
  assert.match(read('Dockerfile.web'), /rm -rf \/app\/libs\/vjudge/);
});

test('local problem keyword search matches numeric ids and titles before pagination', () => {
  const source = read('custom/libs-built/problem_repositories.js');
  const fakeOrm = { Brackets: function (callback) { this.callback = callback; } };
  const context = { require: name => name === 'typeorm' ? fakeOrm : require(name), module: { exports: {} } };
  vm.runInNewContext(source + '\nmodule.exports.testKeyword = applyKeyword;', context);
  for (const [keyword, numeric] of [['911105', 911105], ['A+B', null], ['99999999999999999999', null]]) {
    const clauses = [];
    const query = { andWhere(brackets) { const qb = { where(sql, params) { clauses.push({ sql, params }); return qb; }, orWhere(sql, params) { clauses.push({ sql, params }); return qb; } }; brackets.callback(qb); } };
    const priority = context.module.exports.testKeyword(query, 'all', keyword);
    assert.equal(clauses[0].sql, 'title LIKE :title');
    assert.equal(clauses[0].params.title, '%' + keyword + '%');
    assert.equal(clauses.length, numeric === null ? 1 : 2);
    if (numeric !== null) assert.equal(clauses[1].params.problemId, numeric);
    assert.equal(priority === null, numeric === null);
  }
});
