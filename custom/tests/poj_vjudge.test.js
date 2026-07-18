const assert = require('assert');
const poj = require(process.env.POJ_VJUDGE_MODULE || '../libs-built/vjudge/poj');

async function main() {
  const problemHtml = '<html><body>' +
    '<div class="ptt">A+B Problem</div>' +
    '<div class="plm"><b>Time Limit:</b> 1000MS <b>Memory Limit:</b> 10000K</div>' +
    '<p class="pst">Description</p><div class="ptx"><p>Calculate A+B.</p></div>' +
    '<p class="pst">Input</p><div class="ptx">Two integers.</div>' +
    '<p class="pst">Output</p><div class="ptx">The sum.</div>' +
    '<p class="pst">Sample Input</p><pre class="sio">1 2</pre>' +
    '<p class="pst">Sample Output</p><pre class="sio">3</pre>' +
    '<p class="pst">Source</p><div class="ptx">POJ</div>' +
    '</body></html>';
  const problem = poj._test.parseProblemHtml(problemHtml, 1000);
  assert.strictEqual(problem.title, 'A+B Problem');
  assert.strictEqual(problem.timeLimit, 1000);
  assert.strictEqual(problem.memoryLimit, 10);
  assert.match(problem.description, /Calculate A\+B/);
  assert.match(problem.example, /```plain/);
  assert.match(problem.hint, /POJ/);
  assert.doesNotMatch(
    [problem.description, problem.inputFormat, problem.outputFormat, problem.example, problem.hint].join('\n'),
    /<\/?(?:p|pre|div)\b/i
  );

  const list = poj._test.parseProblemListHtml(
    '<a href="problemlist?volume=31">31</a><a href="problem?id=1000">A</a><a href="problem?id=3979">B</a>'
  );
  assert.deepStrictEqual(list.problemIds, [1000, 3979]);
  assert.strictEqual(list.volumeCount, 31);

  const statusHtml = '<table class="a">' +
    '<tr><td>25188881</td><td>tester</td><td>1000</td><td>Accepted</td>' +
    '<td>256K</td><td>7MS</td><td>G++</td><td>128B</td><td>2026-07-17 17:00:55</td></tr>' +
    '<tr><td>25188880</td><td>tester</td><td>1000</td><td>Compile Error</td>' +
    '<td></td><td></td><td>GCC</td><td>99B</td><td>2026-07-17 16:00:55</td></tr></table>';
  const rows = poj._test.parseStatusRows(statusHtml);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].submissionId, 25188881);
  assert.strictEqual(rows[0].time, 7);
  assert.strictEqual(rows[0].memory, 256);
  assert.strictEqual(rows[0].codeLength, 128);
  assert.strictEqual(poj._test.verdictType('Accepted'), 1);
  assert.strictEqual(poj._test.verdictType('Time Limit Exceeded'), 5);
  assert.ok(poj.languages['poj.G++']);
  assert.ok(poj.languages['poj.Fortran']);

  const reports = [];
  poj(
    { task_id: 'probe', language: 'poj.G++', code: 'int main() {}', type: 0 },
    { vjudge_config: '1000' },
    report => { reports.push(report); return true; }
  );
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.match(reports[0].progress.systemMessage, /未配置 POJ VJudge 账号/);

  const contestReports = [];
  poj(
    { task_id: 'contest-probe', language: 'poj.G++', code: 'int main() {}', type: 1 },
    { vjudge_config: '1000' },
    report => { contestReports.push(report); return true; }
  );
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.match(contestReports[0].progress.systemMessage, /默认禁止用于比赛/);
  console.log('POJ VJudge tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
