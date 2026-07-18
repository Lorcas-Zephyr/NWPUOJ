const assert = require('assert');
const uoj = require(process.env.UOJ_VJUDGE_MODULE || '../libs-built/vjudge/uoj');

function summaryRow(result, time, memory) {
  return '<table><tbody><tr>' +
    '<td><a href="/submission/7">#7</a></td><td>P</td><td>U</td>' +
    '<td>' + result + '</td><td>' + (time || '12ms') + '</td><td>' + (memory || '34kb') + '</td>' +
    '</tr></tbody></table>';
}

function detailCard(title, score, info, time, memory, details) {
  const body = details ? '<div class="card-body">' +
    '<h4>input:</h4><pre>\n' + details.input + '\n</pre>' +
    '<h4>output:</h4><pre>\n' + details.output + '\n</pre>' +
    '<h4>result:</h4><pre>\n' + details.result + '\n</pre>' +
    '</div>' : '';
  return '<div class="card ' + (info === 'Accepted' ? 'card-uoj-accepted' : 'card-uoj-wrong') + '">' +
    '<div class="card-header"><div class="row">' +
    '<div><h4 class="card-title">' + title + '</h4></div>' +
    '<div>score: ' + score + '</div><div>' + info + '</div>' +
    '<div>time: ' + time + 'ms</div><div>memory: ' + memory + 'kb</div>' +
    '</div></div>' + body + '</div>';
}

function detailedResultHtml() {
  return '<div class="card"><h4 class="card-title">详细</h4><div class="card-body">' +
    '<div id="details_details_accordion">' +
    '<div class="card card-uoj-wrong"><div class="card-header"><div class="row">' +
    '<div><h3 class="card-title">Subtask #1:</h3></div><div>score: 40</div><div>Wrong Answer</div>' +
    '</div></div><div id="details_details_accordion_collapse_subtask_1"><div class="card-body">' +
    '<div id="details_details_accordion_collapse_subtask_1_accordion">' +
    detailCard('Test #1:', 40, 'Accepted', 12, 34) +
    detailCard('Test #2:', 0, 'Wrong Answer', 20, 40) +
    '</div></div></div></div>' +
    '<div class="card card-uoj-accepted"><div class="card-header"><div class="row">' +
    '<div><h3 class="card-title">Subtask #2:</h3></div><div>score: 35</div><div>Accepted</div>' +
    '</div></div><div id="details_details_accordion_collapse_subtask_2"><div class="card-body">' +
    '<div id="details_details_accordion_collapse_subtask_2_accordion">' +
    detailCard('Test #3:', 35, 'Accepted', 8, 30) +
    detailCard('Test #4:', 0, 'Skipped', 0, 0) +
    '</div></div></div></div>' +
    '</div></div></div>';
}

async function main() {
  const parseResult = uoj._test.parseFinalResult;
  const accepted = parseResult(
    summaryRow('<a class="uoj-score">100</a>') +
    '<pre>// Compile Error\n// Time Limit Exceeded</pre>',
    7
  );
  assert.strictEqual(accepted.compileError, false);
  assert.strictEqual(accepted.type, 1);

  const compileError = parseResult(
    summaryRow('<a class="small">Compile Error</a>') +
    '<div class="card"><h4 class="card-title">详细</h4><div class="card-body"><pre>compiler output</pre></div></div>',
    7
  );
  assert.strictEqual(compileError.compileError, true);
  assert.strictEqual(compileError.message, 'compiler output');

  const timeLimit = parseResult(
    summaryRow('<a class="uoj-score">0</a>') +
    '<div class="card"><h4 class="card-title">详细</h4><div class="card-body">' +
    '<div id="details_details_accordion">' +
    detailCard('Test #1:', 0, 'Time Limit Exceeded', 12, 34) +
    '</div></div></div>',
    7
  );
  assert.strictEqual(timeLimit.type, 5);

  const detailed = parseResult(
    summaryRow('<a class="uoj-score">75</a>', '20ms', '40kb') + detailedResultHtml(),
    7
  );
  assert.strictEqual(detailed.score, 75);
  assert.strictEqual(detailed.subtasks.length, 2);
  assert.deepStrictEqual(detailed.subtasks.map(subtask => subtask.score), [40, 35]);
  assert.strictEqual(detailed.subtasks[0].cases.length, 2);
  assert.strictEqual(detailed.subtasks[0].cases[0].result.type, 1);
  assert.strictEqual(detailed.subtasks[0].cases[0].result.time, 12);
  assert.strictEqual(detailed.subtasks[0].cases[0].result.memory, 34);
  assert.strictEqual(detailed.subtasks[0].cases[0].result.scoringRate, 0.4);
  assert.strictEqual(detailed.subtasks[0].cases[1].result.type, 2);
  assert.strictEqual(detailed.subtasks[1].cases[1].status, 4);
  assert.match(detailed.subtasks[1].cases[1].result.systemMessage, /Test #4: Skipped/);
  const detailedProgress = uoj._test.buildFinishedProgress(detailed);
  assert.deepStrictEqual(detailedProgress.vjudgeSummary, {
    type: 3,
    score: 75,
    time: 20,
    memory: 40
  });

  const ordinaryDetails = uoj._test.parseJudgementDetails(
    '<div id="details_details_accordion">' +
    detailCard('Test #1:', 50, 'Accepted', 5, 10) +
    detailCard('Test #2:', 0, 'Wrong Answer', 6, 11) +
    '</div>',
    50
  );
  assert.strictEqual(ordinaryDetails.length, 1);
  assert.strictEqual(ordinaryDetails[0].score, 50);
  assert.strictEqual(ordinaryDetails[0].cases.length, 2);

  const rollbackDetails = uoj._test.parseJudgementDetails(
    '<div id="details_details_accordion">' +
    detailCard('Test #1:', 40, 'Accepted', 5, 10) +
    detailCard('Test #2:', -40, 'Wrong Answer', 6, 11) +
    '</div>',
    0
  );
  assert.strictEqual(rollbackDetails[0].cases[0].result.scoringRate, 0.4);
  assert.strictEqual(rollbackDetails[0].cases[1].result.scoringRate, -0.4);

  const skippedSubtask = uoj._test.parseJudgementDetails(
    '<div id="details_details_accordion"><div class="card"><div class="card-header"><div class="row">' +
    '<div><h3 class="card-title">Subtask #1:</h3></div><div>score: 0</div><div>Skipped</div>' +
    '</div></div></div></div>',
    0
  );
  assert.strictEqual(skippedSubtask.length, 1);
  assert.strictEqual(skippedSubtask[0].resultStatus, 'Skipped');
  assert.strictEqual(skippedSubtask[0].cases[0].status, 4);
  assert.strictEqual(skippedSubtask[0].cases[0].result, undefined);

  const bodyNoise = parseResult(
    summaryRow('<a class="uoj-score">0</a>') +
    '<div class="card"><h4 class="card-title">详细</h4><div class="card-body">' +
    '<div id="details_details_accordion">' + detailCard('Test #1:', 0, 'Wrong Answer', 1, 2) +
    '<pre>Time Limit Exceeded</pre></div></div></div>',
    7
  );
  assert.strictEqual(bodyNoise.type, 2);

  const visiblePointDetails = uoj._test.parseJudgementDetails(
    '<div id="details_details_accordion">' +
    detailCard('Test #1:', 0, 'Wrong Answer', 1, 2, {
      input: '23 24',
      output: '48',
      result: "wrong answer 1st numbers differ - expected: '47', found: '48'"
    }) + '</div>',
    0
  );
  const visiblePointResult = visiblePointDetails[0].cases[0].result;
  assert.deepStrictEqual(visiblePointResult.input, {
    name: 'UOJ Test #1 input',
    content: '23 24',
    remote: true
  });
  assert.strictEqual(visiblePointResult.userOutput, '48');
  assert.match(visiblePointResult.spjMessage, /expected: '47', found: '48'/);
  assert.strictEqual(visiblePointResult.output, undefined);

  const judgmentFailed = parseResult(
    summaryRow('<a class="uoj-score">0</a>') +
    '<div id="details_details_accordion">' +
    detailCard('Test #1:', 0, 'Checker Judgment Failed', 1, 2) + '</div>',
    7
  );
  assert.strictEqual(judgmentFailed.type, 9);

  const judgementFailed = parseResult(summaryRow('<a class="small">Judgement Failed</a>'), 7);
  assert.strictEqual(judgementFailed.type, 9);

  const supportedProblem = '<html><body><h1 class="page-header text-center">#1. A + B</h1>' +
    '<article><p>description $a_i + b_i$</p><h3>输入格式</h3><p>input</p>' +
    '<h3>输出格式</h3><p>output</p><h3>样例一</h3><h4>input</h4><pre>1 2</pre>' +
    '<table><tr><th>N</th><th>Value</th></tr><tr><td>1</td><td>2</td></tr></table></article>' +
    '<script>$("#x").source_code_form_group("answer_answer", "code", "");</script>' +
    '<p>时间限制：1s 空间限制：256MB</p></body></html>';
  const problem = uoj._test.parseProblemHtml(supportedProblem, 1);
  assert.strictEqual(problem.title, 'A + B');
  assert.strictEqual(problem.timeLimit, 1000);
  assert.strictEqual(problem.memoryLimit, 256);
  assert.match(problem.description, /\$a_i \+ b_i\$/);
  assert.match(problem.example, /```/);
  assert.match(problem.example, /\| N \| Value \|/);
  assert.doesNotMatch(
    [problem.description, problem.inputFormat, problem.outputFormat, problem.example, problem.hint].join('\n'),
    /<\/?(?:p|h[1-6]|pre|table|tr|td|th)\b/i
  );

  const unsupportedProblem = supportedProblem.replace(
    'source_code_form_group("answer_answer"',
    'text_file_form_group("answer_output"'
  );
  assert.throws(() => uoj._test.parseProblemHtml(unsupportedProblem, 1), /不是受支持的单源文件提交题/);

  const problemList = uoj._test.parseProblemListHtml(
    '<table><tbody><tr><td><a href="https://uoj.ac/problem/1">A + B</a></td></tr>' +
    '<tr><td><a href="/problem/1030">Problem</a></td></tr></tbody></table>' +
    '<ul class="pagination"><li><a href="/problems?page=2">2</a></li>' +
    '<li><a href="/problems?page=11">11</a></li></ul>'
  );
  assert.deepStrictEqual(problemList.problemIds, [1, 1030]);
  assert.strictEqual(problemList.pageCount, 11);

  const reports = [];
  const returned = uoj(
    { task_id: 'probe', language: 'uoj.C++14', code: 'int main() {}', type: 0 },
    { vjudge_config: '1' },
    report => { reports.push(report); return true; }
  );
  assert.strictEqual(returned, undefined);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.strictEqual(reports[0].type, 4);
  assert.match(reports[0].progress.systemMessage, /未配置 UOJ VJudge 账号/);

  const contestReports = [];
  uoj(
    { task_id: 'contest-probe', language: 'uoj.C++14', code: 'int main() {}', type: 1 },
    { vjudge_config: '1' },
    report => { contestReports.push(report); return true; }
  );
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.match(contestReports[0].progress.systemMessage, /默认禁止用于比赛/);

  console.log('UOJ VJudge tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
