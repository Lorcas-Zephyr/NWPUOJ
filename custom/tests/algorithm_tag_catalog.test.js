'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildCatalog, planCatalog, cleanName, nameKey } = require('../imports/algorithm-tags/seed');
const snapshot = require('../imports/algorithm-tags/luogu-2026-09-30.json');

test('all 262 official algorithm tags map to the existing two categories', () => {
  const tags = buildCatalog();
  assert.equal(tags.length, 262);
  assert.equal(tags.filter(tag => tag.category === 'category').length, 22);
  assert.equal(tags.filter(tag => tag.category === 'algorithm').length, 240);
  for (const tag of tags) {
    assert.equal(tag.color, tag.category === 'category' ? 'teal' : 'violet');
    assert.ok(!/[\u200B-\u200D\uFEFF]|\s{2,}/.test(tag.name));
  }
  for (const name of ['基础算法', '动态规划 DP', '图论', '数论', '计算几何', '线段树', 'KMP 算法', '广度优先搜索 BFS', '快速数论变换 NTT']) {
    assert.ok(tags.some(tag => tag.name === name), name);
  }
  assert.ok(!tags.some(tag => ['source', 'difficulty'].includes(tag.category)));
});

test('import is additive, preserves original rows and is idempotent', () => {
  const existing = [{ id: 1, name: 'CCSP 2024', color: 'blue', category: 'source' }, { id: 2, name: '入门', color: 'orange', category: 'difficulty' }];
  const before = JSON.stringify(existing);
  const first = planCatalog(existing);
  assert.equal(first.added.length, 262);
  assert.equal(first.conflicts.length, 0);
  assert.equal(JSON.stringify(existing), before);
  const after = existing.concat(first.added.map((tag, index) => ({ ...tag, id: index + 3 })));
  const again = planCatalog(after);
  assert.equal(again.added.length, 0);
  assert.equal(again.reused.length, 262);
  assert.deepEqual(again.conflicts, []);
});

test('name normalization reuses existing IDs without renaming or recoloring them', () => {
  const existing = [{ id: 42, name: '\uFEFF树形DP ', color: 'custom', category: 'algorithm' }];
  const plan = planCatalog(existing);
  assert.equal(plan.reused[0].id, 42);
  assert.equal(plan.reused[0].name, '树形 DP');
  assert.equal(existing[0].color, 'custom');
  assert.equal(cleanName('\uFEFF基础算法\u200B  '), '基础算法');
  assert.equal(nameKey(' Pólya 定理 '), nameKey('Polya定理'));
});

test('ambiguous names or nonalgorithm collisions are never overwritten', () => {
  const wrongType = planCatalog([{ id: 3, name: '线段树', category: 'source' }]);
  assert.equal(wrongType.conflicts.length, 1);
  assert.ok(!wrongType.added.some(tag => tag.name === '线段树'));
  const duplicate = planCatalog([{ id: 3, name: '树形DP', category: 'algorithm' }, { id: 4, name: '树形 DP', category: 'algorithm' }]);
  assert.equal(duplicate.conflicts.length, 1);
});

test('invalid source graphs and duplicate IDs or names fail before writing', () => {
  const one = { id: 1, name: '测试', parent: null };
  for (const tags of [[one, one], [one, { ...one, id: 2 }], [{ ...one, parent: 2 }], [{ ...one, parent: 2 }, { id: 2, name: '循环', parent: 1 }]]) {
    assert.throws(() => buildCatalog({ source_type: 2, tags }));
  }
  assert.throws(() => buildCatalog({ ...snapshot, source_type: 3 }));
});

test('tag directory uses a single aggregate query and includes unused tags', async () => {
  let handler, queries = 0, schemaCalls = 0;
  const context = {
    app: { get: (route, fn) => { assert.equal(route, '/tags'); handler = fn; } },
    syzoj: { utils: { problemWorkflowV2: { ensureSchema: async () => { schemaCalls++; } } }, log: error => { throw error; } },
    require: () => ({ getConnection: () => ({ query: async sql => {
      queries++;
      assert.match(sql, /LEFT JOIN problem_tag_map/);
      assert.match(sql, /GROUP BY/);
      return [{ id: '7', name: '线段树', color: 'violet', category: 'algorithm', problem_count: '0' }, { id: 1, name: 'CCSP 2024', color: 'blue', category: 'source', problem_count: '5' }];
    } }) })
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../modules/tags.js'), 'utf8'), context);
  let rendered;
  await handler({}, { render: (view, model) => { assert.equal(view, 'tags'); rendered = model; } });
  assert.equal(queries, 1);
  assert.equal(schemaCalls, 1);
  assert.equal(rendered.tags.length, 2);
  assert.equal(rendered.tags.find(tag => tag.id === 7).problemCount, 0);
  assert.equal(rendered.tags.find(tag => tag.id === 1).problemCount, 5);
});
