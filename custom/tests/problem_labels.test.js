'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { problemAlias } = require('../libs/contest-ranklist-export');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const util = read('views/util.ejs');
const boundaries = [[1, 'A'], [26, 'Z'], [27, 'AA'], [28, 'AB'], [52, 'AZ'], [53, 'BA'], [702, 'ZZ'], [703, 'AAA']];

test('shared template labels continue beyond Z and agree with exported labels', () => {
  const context = vm.createContext({});
  vm.runInContext(util.replace(/^<%/, '').replace(/%>\s*$/, ''), context);
  for (const [ordinal, expected] of boundaries) {
    assert.equal(context.alpha(ordinal), expected);
    assert.equal(context.alpha(String(ordinal)), expected);
  }
  for (let ordinal = 1; ordinal <= 2000; ordinal++) {
    assert.equal(context.alpha(ordinal), problemAlias(ordinal - 1));
  }
  for (const invalid of [undefined, null, '', 0, -1, 1.5, 'AB', '28x', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(context.alpha(invalid), undefined);
  }
});

test('real statement and submit navigation render extended labels without changing numeric URLs', () => {
  const contextTemplate = read('views/problem_context.ejs').replace(/<% include \w+ %>/g, '');
  const statementTemplate = read('views/problem.ejs')
    .replace('<% include app_header %>', '<title><%= this.title %></title>')
    .replace('<% include problem_context %>', contextTemplate)
    .replace(/<% include \w+ %>/g, '');
  const script = `
    const fs = require('fs'), ejs = require('/app/node_modules/ejs');
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const results = [];
    for (const mode of ['problem-set', 'contest', 'base-contest']) {
      for (const [ordinal] of input.boundaries) {
        const context = {};
        const options = { context };
        ejs.render(input.util, {}, options);
        const problem = {id: 911110, title: 'Boundary fixture', type: 'traditional', is_public: true,
          time_limit: 1000, memory_limit: 256, description: '<p>题面</p>', getDisplayId: () => '911110'};
        const contest = mode === 'problem-set' ? null : {id: 21, title: mode, start_time: 100, end_time: 400, isRunning: () => true, isEnded: () => false};
        const problemSet = mode === 'problem-set' ? {id: 12, title: '题单', deadline_at: null} : null;
        const locals = {problem, contest, problemSet, pid: ordinal, user: {id: 7}, testcases: {spj: false},
          baseContext: mode === 'base-contest', baseAdmin: false, problemSetCanParticipate: true,
          syzoj: {utils: {removeTitleTag: value => value, getCurrentDate: () => 200, formatDate: String, contestSubmissionEnabled: () => true,
            makeUrl: (parts, query) => '/' + parts.join('/') + (query ? '?' + new URLSearchParams(query) : '')}}};
        const statement = ejs.render(input.statementTemplate, locals, options);
        const submit = ejs.render(input.contextTemplate, {...locals, problemContext: {problem, contest, problemSet,
          section: 'submit', testcases: {spj: false}, contestProblemId: ordinal, problemSetProblemId: ordinal, problemSetCanParticipate: true}}, options);
        results.push({mode, ordinal, statement, submit});
      }
    }
    process.stdout.write(JSON.stringify(results));
  `;
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], {
    cwd: path.join(root, '..'), input: JSON.stringify({ util, statementTemplate, contextTemplate, boundaries }),
    encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024
  });
  assert.equal(result.status, 0, result.stderr);
  const rendered = JSON.parse(result.stdout);
  assert.equal(rendered.length, boundaries.length * 3);
  for (const { mode, ordinal, statement, submit } of rendered) {
    const label = new Map(boundaries).get(ordinal);
    const prefix = mode === 'problem-set' ? '/problem-set/12' : '/contest/21';
    assert.ok(statement.includes('<title>' + label + '. Boundary fixture'));
    for (const html of [statement, submit]) {
      assert.ok(html.includes('<h1 id="problem-context-title">' + label + '. Boundary fixture</h1>'));
      assert.ok(html.includes('<span>题目 ' + label + '</span>'));
      assert.ok(html.includes('href="' + prefix + '/problem/' + ordinal + '"'));
      assert.ok(html.includes('href="' + prefix + '/submissions?problem_id=' + ordinal + '"'));
    }
  }
});

test('template helper is deployed and contest alias defaults use the multi-letter converter', () => {
  assert.match(read('../docker-compose.yml'), /custom\/views\/util\.ejs:\/app\/views\/util\.ejs:ro/);
  assert.match(read('views/app_header.ejs'), /<% include util %>/);
  for (const file of ['libs/contest-mutation.js', 'modules/_api_v2_contest_domain.js']) {
    assert.doesNotMatch(read(file), /String\.fromCharCode\(65 \+ index\)/);
    assert.match(read(file), /problemAlias\(index\)/);
  }
});
