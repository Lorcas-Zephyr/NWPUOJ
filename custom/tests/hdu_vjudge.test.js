const assert = require('assert');
const iconv = require('iconv-lite');
const hdu = require(process.env.HDU_VJUDGE_MODULE || '../libs-built/vjudge/hdu');

async function main() {
  assert.strictEqual(hdu._test.decodeBody(iconv.encode('中文题面', 'gb18030')), '中文题面');

  const problemHtml = '<html><body>' +
    '<h1 style="color:#1A5CC8">A + B Problem</h1>' +
    '<span>Time Limit: 2000/1000 MS (Java/Others) Memory Limit: 65536/32768 K (Java/Others)</span>' +
    '<div class="panel_title">Problem Description</div><div class="panel_content"><p>Calculate $A+B$.</p></div>' +
    '<div class="panel_title">Input</div><div class="panel_content">Two integers.</div>' +
    '<div class="panel_title">Output</div><div class="panel_content">The sum.</div>' +
    '<div class="panel_title">Sample Input</div><div class="panel_content"><pre>1 1</pre></div>' +
    '<div class="panel_title">Sample Output</div><div class="panel_content"><pre>2</pre></div>' +
    '<div class="panel_title">Author</div><div class="panel_content">HDOJ</div>' +
    '</body></html>';
  const problem = hdu._test.parseProblemHtml(problemHtml, 1000);
  assert.strictEqual(problem.title, 'A + B Problem');
  assert.strictEqual(problem.timeLimit, 2000);
  assert.strictEqual(problem.memoryLimit, 64);
  assert.match(problem.description, /\$A\+B\$/);
  assert.match(problem.example, /```plain/);
  assert.match(problem.hint, /HDOJ/);
  assert.doesNotMatch(
    [problem.description, problem.inputFormat, problem.outputFormat, problem.example, problem.hint].join('\n'),
    /<\/?(?:p|pre|div)\b/i
  );

  const list = hdu._test.parseProblemListHtml(
    '<a href="listproblem.php?vol=73">73</a><script>p(0,1000,-1,"A",1,2);p(1,8210,-1,"B",1,2);</script>'
  );
  assert.deepStrictEqual(list.problemIds, [1000, 8210]);
  assert.strictEqual(list.volumeCount, 73);

  const statusHtml = '<table class="table_text">' +
    '<tr><td>40927821</td><td>2026-07-16</td><td>Accepted</td><td>1000</td>' +
    '<td>15MS</td><td>1796K</td><td>131B</td><td>G++</td><td>tester</td></tr>' +
    '<tr><td>40927820</td><td>2026-07-16</td><td>Compilation Error</td><td>1000</td>' +
    '<td>0MS</td><td>0K</td><td>126B</td><td>C++</td><td>tester</td></tr></table>';
  const rows = hdu._test.parseStatusRows(statusHtml);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].submissionId, 40927821);
  assert.strictEqual(rows[0].time, 15);
  assert.strictEqual(rows[0].memory, 1796);
  assert.strictEqual(rows[0].codeLength, 131);
  assert.strictEqual(hdu._test.verdictType('Accepted'), 1);
  assert.strictEqual(hdu._test.verdictType('Time Limit Exceeded'), 5);
  assert.strictEqual(hdu._test.closestCaptchaCandidate(['166', '1669'], ['1669', '5258']), '1669');
  assert.strictEqual(hdu._test.closestCaptchaCandidate(['1668'], ['1669', '5258']), '1669');
  assert.strictEqual(hdu._test.closestCaptchaCandidate(['1234'], ['1669', '5258']), null);

  const reports = [];
  hdu(
    { task_id: 'probe', language: 'hdu.G++', code: 'int main() {}', type: 0 },
    { vjudge_config: '1000' },
    report => { reports.push(report); return true; }
  );
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.match(reports[0].progress.systemMessage, /未配置 HDU VJudge 账号/);

  const contestReports = [];
  hdu(
    { task_id: 'contest-probe', language: 'hdu.G++', code: 'int main() {}', type: 1 },
    { vjudge_config: '1000' },
    report => { contestReports.push(report); return true; }
  );
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.match(contestReports[0].progress.systemMessage, /默认禁止用于比赛/);

  console.log('HDU VJudge tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
