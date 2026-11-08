'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');

test('production Markdown worker matches preview tables and line breaks, retaining XSS filtering, code and math', { timeout: 30000 }, () => {
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
        '$1+1=2$\\n\\n'+String.fromCharCode(96).repeat(3)+'cpp\\nint main() { return 0; }\\n'+String.fromCharCode(96).repeat(3),
        '## 题目背景\\n> 第一行\\n> 第二行\\n> 第三行\\n> 第四行\\n\\n正文 a > b',
        '> 外层  \\n> 换行\\n>\\n>> 内层第一行\\n>> 内层第二行\\n\\n正文第一行\\n正文第二行',
        String.fromCharCode(96).repeat(3)+'text\\n> 保留原始字符\\na > b\\n'+String.fromCharCode(96).repeat(3)+'\\n\\n\\\\> 文字中的大于号'
      ];
      for(let id=0;id<cases.length;id++) await handlers.message({id,type:'markdown',source:cases[id]});
      await handlers.message({id:7,type:'markdown',source:cases[0]});
      await handlers.message({id:8,type:'markdown',source:cases[4]});
      console.log(JSON.stringify(results));
    })().catch(error=>{console.error(error.message);process.exitCode=1;});
  `;
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', script], { cwd: root, input: source, encoding: 'utf8', timeout: 25000 });
  assert.equal(result.status, 0, result.stderr);
  const results = JSON.parse(result.stdout);
  assert.equal(results.length, 9);
  for (const index of [0, 1, 7]) assert.doesNotMatch(results[index].result, /\b(?:rowspan|colspan)=/);
  assert.equal((results[0].result.match(/<td\b/g) || []).length, 4);
  assert.equal((results[0].result.match(/<th\b/g) || []).length, 2);
  assert.equal((results[1].result.match(/<table\b/g) || []).length, 2);
  assert.doesNotMatch(results[2].result, /<script|onerror=|href="javascript:/i);
  assert.match(results[3].result, /<svg|katex|MathJax/);
  assert.match(results[3].result, /main/);
  assert.equal(results[0].result, results[7].result, 'the non-merging result is cached');
  assert.match(results[4].result, /<blockquote>[\s\S]*第一行<br\s*\/?>(?:\n)?第二行/);
  assert.equal((results[4].result.match(/<br\s*\/?>/g) || []).length, 3, 'each quoted source line stays on its own line');
  assert.match(results[4].result, /正文 a &gt; b/);
  assert.equal((results[5].result.match(/<blockquote>/g) || []).length, 2, 'nested quotes remain nested');
  assert.equal((results[5].result.match(/<br\s*\/?>/g) || []).length, 3, 'hard breaks must not become duplicate breaks');
  assert.match(results[5].result, /正文第一行<br\s*\/?>(?:\n)?正文第二行/);
  assert.doesNotMatch(results[6].result, /<blockquote>|<br\s*\/?>/);
  assert.match(results[6].result, /&gt; 保留原始字符/);
  assert.match(results[6].result, /&gt; 文字中的大于号/);
  assert.equal(results[4].result, results[8].result, 'the quote result is cached with preserved breaks');
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
