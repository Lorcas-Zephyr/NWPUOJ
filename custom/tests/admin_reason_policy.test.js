'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const viewsDir = path.join(root, 'custom/views');

test('only author-facing review rejection asks administrators for a reason', () => {
  const reasonFields = fs.readdirSync(viewsDir)
    .filter(file => file.endsWith('.ejs'))
    .flatMap(file => {
      const source = fs.readFileSync(path.join(viewsDir, file), 'utf8');
      return Array.from(source.matchAll(/name=["']reason["']/g), () => file);
    });

  assert.deepStrictEqual(reasonFields, ['solution.ejs']);

  const solutionView = fs.readFileSync(path.join(viewsDir, 'solution.ejs'), 'utf8');
  assert.match(solutionView, /name="reason"[^>]*required/);

  const requestSecurity = fs.readFileSync(path.join(root, 'custom/modules/_request_security.js'), 'utf8');
  assert.doesNotMatch(requestSecurity, /req\.body\.reason\s*=/);
  assert.match(requestSecurity, /return String\(fallback \|\| `校内管理员操作：/);

  const solutionModule = fs.readFileSync(path.join(root, 'custom/modules/solution.js'), 'utf8');
  assert.doesNotMatch(solutionModule, /app\.post\('\/solution\/:id\/reject'/);

  const solutionApi = fs.readFileSync(path.join(root, 'custom/modules/_api_v2_problem_workflows.js'), 'utf8');
  assert.match(solutionApi, /app\.post\(\['\/api\/v2\/admin\/solutions\/:id\/review', '\/api\/v2\/solutions\/:id\/review'\]/);
  assert.match(solutionApi, /decision === 'rejected' \? req\.body && req\.body\.reason : '题解审核通过'/);

  const contentDomain = fs.readFileSync(path.join(root, 'custom/libs/content-domain.js'), 'utf8');
  assert.match(contentDomain, /decision === 'rejected'\s*\? requiredText\(input\.reason, 'reason', 255\)/);

  for (const file of ['_help_page.js', '_contest_rating.js', '_api_v2_rating_domain.js']) {
    const source = fs.readFileSync(path.join(root, 'custom/modules', file), 'utf8');
    assert.doesNotMatch(source, /req\.body(?:\s*&&\s*req\.body)?\.reason/);
    assert.doesNotMatch(source, /reason[^\n]{0,80}(?:required|不能为空|必填)/i);
  }

  const design = fs.readFileSync(path.join(root, 'DESIGN.md'), 'utf8');
  assert.match(design, /系统操作不要求人工填写原因/);
  assert.match(design, /审核拒绝.*仍必须填写/);
});
