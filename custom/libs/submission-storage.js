'use strict';

const TERMINAL_JUDGE_STATUSES = new Set([
  'Accepted', 'Wrong Answer', 'Compile Error', 'Runtime Error', 'Time Limit Exceeded', 'Memory Limit Exceeded'
]);

function storageError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode || 409;
  return error;
}

function submissionFields(input) {
  const value = input || {};
  return {
    submit_time: Number(value.submit_time), status: value.status || 'Unknown', task_id: String(value.task_id || ''),
    code: String(value.code || ''), code_length: Number(value.code_length || 0), language: value.language || null,
    user_id: Number(value.user_id), problem_id: Number(value.problem_id), is_public: !!value.is_public,
    type: Number(value.type || 0), type_info: value.type_info == null ? null : Number(value.type_info),
    pending: !!value.pending
  };
}

async function insertSubmission(manager, input) {
  const row = submissionFields(input);
  const inserted = await manager.query(`INSERT INTO judge_state
    (code,language,status,task_id,score,total_time,code_length,pending,max_memory,compilation,result,user_id,problem_id,submit_time,type,type_info,is_public)
    VALUES (?,?,?,?,0,0,?, ?,0,NULL,NULL,?,?,?,?,?,?)`, [
    row.code, row.language, row.status, row.task_id, row.code_length, row.pending ? 1 : 0,
    row.user_id, row.problem_id, row.submit_time, row.type, row.type_info, row.is_public ? 1 : 0
  ]);
  const id = Number(inserted && inserted.insertId);
  if (!Number.isSafeInteger(id) || id < 1) throw storageError('SUBMISSION_STORAGE_WRITE_FAILED', 'Submission creation did not return an identifier.', 500);
  return { id, ...row, score: 0, total_time: 0, max_memory: 0, compilation: null, result: null };
}

async function cancelSubmission(manager, input) {
  const submissionId = Number(input && input.submission_id);
  if (!Number.isSafeInteger(submissionId) || submissionId < 1) throw storageError('SUBMISSION_NOT_FOUND', 'Submission was not found.', 404);
  const rows = await manager.query('SELECT id,status,pending,problem_id,user_id FROM judge_state WHERE id=? LIMIT 1 FOR UPDATE', [submissionId]);
  if (!rows.length) throw storageError('SUBMISSION_NOT_FOUND', 'Submission was not found.', 404);
  const current = rows[0];
  if (!Number(current.pending) && TERMINAL_JUDGE_STATUSES.has(String(current.status))) {
    throw storageError('SUBMISSION_TERMINAL', 'The submission has already finished.');
  }
  const reason = String(input.reason || '').trim() || 'Cancelled by submitter';
  await manager.query(`INSERT INTO judge_state_admin_action
    (judge_id,action_type,operator_id,operator_time,reason,was_accepted,affected_problem_id,affected_user_id)
    VALUES (?,'cancelled',?,?,?,?,?,?)`, [
    submissionId, Number(input.actor_id), Number(input.operator_time), reason, 0,
    Number(current.problem_id), Number(current.user_id)
  ]);
  await manager.query("UPDATE judge_state SET status='Cancelled',pending=0,score=0,result=NULL WHERE id=?", [submissionId]);
  return {
    action_id: String(submissionId), reason,
    judge: { ...current, status: 'Cancelled', pending: false, score: 0, result: null }
  };
}

module.exports = { TERMINAL_JUDGE_STATUSES, insertSubmission, cancelSubmission, submissionFields };
