'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');

test('production Markdown worker keeps duplicate cells separate and retains XSS filtering, code and math', { timeout: 30000 }, () => {
  const source = fs.readFileSync(path.join(root, 'custom/libs-built/rendererd.js'), 'utf8');
  const script = `
    const fs=require('fs'),vm=require('vm');
    const handlers={},results=[];
    vm.runInNewContext(fs.readFileSync(0,'utf8'),{require,process:{argv:['node','rendererd',20],on:(name,callback)=>handlers[name]=callback,send:message=>results.push(message),exit:()=>{}}});
    (async()=>{
      const cases=[
        '| H | H |\\n| --- | --- |\\n| 10 | 10 |\\n| 10 | 10 |',
        '| A | B |\\n| --- | --- |\\n| 0 | 0 |\\n\\n| C | D |\\n| --- | --- |\\n| 0 | 0 |',
        '<img src="x" onerror="window.pwned=1"><script>window.pwned=2</script>\\n\\n[x](javascript:alert(1))',
        '$1+1=2$\\n\\n'+String.fromCharCode(96).repeat(3)+'cpp\\nint main() { return 0; }\\n'+String.fromCharCode(96).repeat(3)
      ];
      for(let id=0;id<cases.length;id++) await handlers.message({id,type:'markdown',source:cases[id]});
      await handlers.message({id:4,type:'markdown',source:cases[0]});
      console.log(JSON.stringify(results));
    })().catch(error=>{console.error(error.message);process.exitCode=1;});
  `;
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], { cwd: root, input: source, encoding: 'utf8', timeout: 25000 });
  assert.equal(result.status, 0, result.stderr);
  const results = JSON.parse(result.stdout);
  assert.equal(results.length, 5);
  for (const index of [0, 1, 4]) assert.doesNotMatch(results[index].result, /\b(?:rowspan|colspan)=/);
  assert.equal((results[0].result.match(/<td\b/g) || []).length, 4);
  assert.equal((results[0].result.match(/<th\b/g) || []).length, 2);
  assert.equal((results[1].result.match(/<table\b/g) || []).length, 2);
  assert.doesNotMatch(results[2].result, /<script|onerror=|href="javascript:/i);
  assert.match(results[3].result, /<svg|katex|MathJax/);
  assert.match(results[3].result, /main/);
  assert.equal(results[0].result, results[4].result, 'the new non-merging result is cached');
});

test('all app/admin layouts load the local Markdown integration and the worker is mounted', () => {
  const read = name => fs.readFileSync(path.join(root, name), 'utf8');
  assert.match(read('custom/views/app_footer.ejs'), /\/self\/lib\/noj-markdown\.js/);
  assert.match(read('custom/views/admin_footer.ejs'), /include app_footer/);
  assert.match(read('docker-compose.yml'), /custom\/libs-built\/rendererd\.js:\/app\/libs\/rendererd\.js:ro/);
  assert.match(read('custom/libs-built/rendererd.js'), /markdownItMergeCells: false/);
  assert.match(read('custom/static-libs/noj-markdown.js'), /sanitize: true/);
  assert.match(read('custom/static-libs/noj-markdown.js'), /cache: \{ enable: false \}/);
});
