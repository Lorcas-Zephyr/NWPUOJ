'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const storage = require('../libs/submission-storage');

function manager(handler) {
  const calls = [];
  return { calls, async query(sql, params = []) {
    const compact = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: compact, params });
    return handler(compact, params, calls);
  } };
}

test('submission creation is a transaction-manager storage operation with a stable inserted ID', async () => {
  const current = manager(sql => {
    assert.match(sql, /^INSERT INTO judge_state/);
    return { insertId: 77 };
  });
  const created = await storage.insertSubmission(current, {
    submit_time: 1, task_id: 'task', code: 'int main() {}', code_length: 13, language: 'cpp',
    user_id: 3, problem_id: 8, is_public: true, type: 0
  });
  assert.equal(created.id, 77);
  assert.equal(created.status, 'Unknown');
  assert.equal(created.pending, false);
  assert.equal(current.calls.length, 1);
});

test('submission cancellation locks the submission before its action and state update', async () => {
  const current = manager(sql => {
    if (sql.startsWith('SELECT id,status,pending')) return [{ id: 77, status: 'Waiting', pending: 1, problem_id: 8, user_id: 3 }];
    if (sql.startsWith('INSERT INTO judge_state_admin_action')) return { affectedRows: 1 };
    if (sql.startsWith("UPDATE judge_state SET status='Cancelled'")) return { affectedRows: 1 };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const cancelled = await storage.cancelSubmission(current, {
    submission_id: 77, actor_id: 9, operator_time: 100, reason: 'Cancelled by owner'
  });
  assert.equal(cancelled.action_id, '77');
  assert.equal(cancelled.judge.status, 'Cancelled');
  assert.deepEqual(current.calls.map(call => call.sql.split(' ')[0]), ['SELECT', 'INSERT', 'UPDATE']);
  assert.match(current.calls[0].sql, /FOR UPDATE$/);
});

test('terminal submissions reject before an action can be inserted', async () => {
  const current = manager(sql => {
    if (sql.startsWith('SELECT id,status,pending')) return [{ id: 77, status: 'Accepted', pending: 0, problem_id: 8, user_id: 3 }];
    throw new Error(`Unexpected write: ${sql}`);
  });
  await assert.rejects(() => storage.cancelSubmission(current, { submission_id: 77, actor_id: 9, operator_time: 100 }), error => error.code === 'SUBMISSION_TERMINAL');
  assert.equal(current.calls.length, 1);
});
