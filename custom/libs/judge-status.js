'use strict';

const JUDGE_STATUS_MAP = Object.freeze({
  Accepted: 'accepted',
  'Wrong Answer': 'wrong_answer',
  'Compile Error': 'compile_error',
  'Runtime Error': 'runtime_error',
  'Time Limit Exceeded': 'time_limit',
  'Memory Limit Exceeded': 'memory_limit',
  'Output Limit Exceeded': 'output_limit',
  'File Error': 'file_error',
  'Invalid Interaction': 'invalid_interaction',
  'Partially Correct': 'partially_correct',
  'No Testdata': 'system_error',
  'System Error': 'system_error',
  'Judgement Failed': 'system_error',
  Cancelled: 'cancelled'
});

function isPending(value) {
  return value === true || Number(value) === 1;
}

function statusForJudge(judge, projectedStatus) {
  const source = judge || {};
  if (projectedStatus === 'cancelled') return 'cancelled';
  if (source.status === 'Waiting') return 'queued';
  if (source.status === 'Compiling') return 'compiling';
  if (source.status === 'Judging') return 'judging';
  return JUDGE_STATUS_MAP[source.status] || (isPending(source.pending) ? 'judging' : 'queued');
}

function sqlStatusCase(statusColumn, pendingColumn) {
  return `CASE ${statusColumn}
    WHEN 'Waiting' THEN 'queued'
    WHEN 'Compiling' THEN 'compiling'
    WHEN 'Judging' THEN 'judging'
    WHEN 'Accepted' THEN 'accepted'
    WHEN 'Wrong Answer' THEN 'wrong_answer'
    WHEN 'Compile Error' THEN 'compile_error'
    WHEN 'Runtime Error' THEN 'runtime_error'
    WHEN 'Time Limit Exceeded' THEN 'time_limit'
    WHEN 'Memory Limit Exceeded' THEN 'memory_limit'
    WHEN 'Output Limit Exceeded' THEN 'output_limit'
    WHEN 'File Error' THEN 'file_error'
    WHEN 'Invalid Interaction' THEN 'invalid_interaction'
    WHEN 'Partially Correct' THEN 'partially_correct'
    WHEN 'No Testdata' THEN 'system_error'
    WHEN 'System Error' THEN 'system_error'
    WHEN 'Judgement Failed' THEN 'system_error'
    WHEN 'Cancelled' THEN 'cancelled'
    ELSE CASE WHEN ${pendingColumn}=1 THEN 'judging' ELSE 'queued' END
  END`;
}

module.exports = { JUDGE_STATUS_MAP, isPending, statusForJudge, sqlStatusCase };
