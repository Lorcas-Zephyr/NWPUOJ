'use strict';

const QUEUE_STATES = new Set(['queued', 'compiling', 'judging']);

function normalizeQueueState(projectedStatus, legacyStatus) {
  const projected = String(projectedStatus || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (QUEUE_STATES.has(projected)) return projected;
  const legacy = String(legacyStatus || '').trim().toLowerCase();
  if (legacy === 'compiling') return 'compiling';
  if (legacy === 'judging' || legacy === 'running') return 'judging';
  return 'queued';
}

function normalizeQueueRows(rows, nowSeconds = Math.floor(Date.now() / 1000)) {
  const now = Number.isFinite(Number(nowSeconds)) ? Math.floor(Number(nowSeconds)) : Math.floor(Date.now() / 1000);
  return (Array.isArray(rows) ? rows : []).map(row => {
    const submittedAt = Math.max(0, Math.floor(Number(row.submit_time) || 0));
    const ageSeconds = Math.max(0, now - submittedAt);
    const type = Number(row.type) || 0;
    return {
      id: Number(row.id),
      problem_id: Number(row.problem_id),
      problem_title: row.problem_title || null,
      user_id: Number(row.user_id),
      username: row.username || null,
      contest_id: type === 1 ? Number(row.type_info) || null : null,
      language: row.language || null,
      state: normalizeQueueState(row.projected_status, row.status),
      submitted_at: new Date(submittedAt * 1000).toISOString(),
      age_seconds: ageSeconds,
      is_stale: ageSeconds >= 900,
      dispatch_attempts: Math.max(0, Number(row.dispatch_attempts) || 0),
      has_dispatch_error: !!row.last_error
    };
  }).sort((left, right) => {
    const timeOrder = Date.parse(left.submitted_at) - Date.parse(right.submitted_at);
    return timeOrder || left.id - right.id;
  });
}

module.exports = { QUEUE_STATES, normalizeQueueState, normalizeQueueRows };
