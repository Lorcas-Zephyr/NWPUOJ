'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, 'views', name + '.ejs'), 'utf8');
const template = read('statistics')
  .replace('<% include problem_context %>', read('problem_context'))
  .replace('<% include app_pagination %>', read('app_pagination'))
  .replace(/<% include \w+ %>/g, '');

function render(cases) {
  const script = `
    const fs = require('fs'), ejs = require('/app/node_modules/ejs');
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const results = input.cases.map(options => {
      const problem = { id: 911331, title: '统计回归测试', is_public: options.isPublic,
        type: options.type || 'traditional', time_limit: 1000, memory_limit: 256,
        getDisplayId: () => '911331' };
      const judge = { id: 26534, problem_id: problem.id, problem,
        user: { username: 'fixture' }, status: 'Accepted', score: 10,
        language: options.language || 'cpp', code: 'int main() {}',
        total_time: 5, max_memory: 1024, submit_time: 1793059200 };
      const points = [{score: 10, count: 1}];
      return ejs.render(input.template, {
        problem, problemContext: {problem, section: 'statistics', testcases: {spj: false}},
        user: {id: 7}, req: {query: {}}, baseContext: false,
        paginate: {currPage: 1, pageCnt: 2}, serializejs: JSON.stringify,
        statistics: {type: options.type === 'submit-answer' ? 'shortest' : 'fastest',
          judge_state: options.empty ? [] : [judge],
          scoreDistribution: points, prefixSum: points, suffixSum: points},
        syzoj: {languages: {cpp: {show: 'C++20'}}, utils: {
          makeUrl: (parts, query) => (Array.isArray(parts) ? '/' + parts.join('/')
            : '/problem/911331/statistics/fastest') + (query ? '?' + new URLSearchParams(query) : ''),
          removeTitleTag: String, formatSize: value => value + ' B',
          renderUsername: user => user.username, formatDate: String
        }}
      });
    });
    process.stdout.write(JSON.stringify(results));
  `;
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], {
    cwd: path.join(root, '..'), input: JSON.stringify({template, cases}),
    encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('private and public problem statistics render AC records using the site language configuration', () => {
  const cases = [false, true].flatMap(isPublic =>
    ['traditional', 'interaction', 'submit-answer'].map(type => ({isPublic, type})));
  const pages = render(cases);
  pages.forEach((html, index) => {
    assert.match(html, /app-statistics-table/);
    assert.match(html, /href="\/submission\/26534"/);
    assert.match(html, /app-status-accepted/);
    assert.match(html, /fixture/);
    assert.match(html, /page_next/);
    assert.match(html, cases[index].type === 'submit-answer' ? /答案文件/ : /C\+\+20/);
  });
});

test('statistics retain empty states and the fallback label for older submission languages', () => {
  const [empty, unknown] = render([{isPublic: false, empty: true}, {isPublic: false, language: 'legacy-cpp'}]);
  assert.match(empty, /暂无满分提交/);
  assert.doesNotMatch(empty, /app-statistics-table/);
  assert.match(unknown, /legacy-cpp/);
});
