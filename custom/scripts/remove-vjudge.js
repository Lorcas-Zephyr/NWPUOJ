'use strict';

// Run with the Web stopped and a verified full database backup. Dry-run by default.
const crypto = require('crypto');

async function removeVJudge(db, execute = false) {
  const query = async (sql, params = []) => (await db.query(sql, params))[0];
  const columns = await query('SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()');
  const schema = new Map();
  for (const row of columns) {
    if (!schema.has(row.TABLE_NAME)) schema.set(row.TABLE_NAME, new Set());
    schema.get(row.TABLE_NAME).add(row.COLUMN_NAME);
  }
  const has = (table, column) => schema.has(table) && (!column || schema.get(table).has(column));
  const count = async sql => Number((await query(sql))[0].count);
  const localDigest = async () => crypto.createHash('sha256').update(JSON.stringify(await query("SELECT * FROM problem WHERE COALESCE(type,'') NOT LIKE 'vjudge:%' ORDER BY id"))).digest('hex');
  const before = {
    local_problems: await count("SELECT COUNT(*) count FROM problem WHERE COALESCE(type,'') NOT LIKE 'vjudge:%'"),
    remote_problems: await count("SELECT COUNT(*) count FROM problem WHERE type LIKE 'vjudge:%'"),
    remote_submissions: await count("SELECT COUNT(*) count FROM judge_state j JOIN problem p ON p.id=j.problem_id WHERE p.type LIKE 'vjudge:%'"),
    all_submissions: await count('SELECT COUNT(*) count FROM judge_state'),
    pending_submissions: await count('SELECT COUNT(*) count FROM judge_state WHERE pending=1'),
    contest_references: await count("SELECT COUNT(*) count FROM contest c JOIN problem p ON CONCAT('|',COALESCE(c.problems,''),'|') LIKE CONCAT('%|',p.id,'|%') WHERE p.type LIKE 'vjudge:%'"),
    problem_set_references: has('problem_set_item') ? await count("SELECT COUNT(*) count FROM problem_set_item i JOIN problem p ON p.id=i.problem_id WHERE p.type LIKE 'vjudge:%'") : 0,
    remote_attachments: await count("SELECT COUNT(*) count FROM problem WHERE type LIKE 'vjudge:%' AND additional_file_id IS NOT NULL"),
    remote_snapshots_with_data: has('problem_v2_snapshot') ? await count("SELECT COUNT(*) count FROM problem_v2_snapshot s JOIN problem p ON p.id=s.problem_id WHERE p.type LIKE 'vjudge:%' AND s.testdata_path IS NOT NULL") : 0
  };
  if (!execute) return { dry_run: true, before };
  if (before.pending_submissions || before.contest_references || before.problem_set_references || before.remote_attachments || before.remote_snapshots_with_data) {
    throw new Error('Preflight changed: pending work, references, or stored files require inspection. ' + JSON.stringify(before));
  }
  const localHash = await localDigest();
  const removed = {};
  const mutate = async (key, sql, params = []) => {
    const result = await query(sql, params);
    removed[key] = (removed[key] || 0) + Number(result.affectedRows || 0);
  };
  await db.beginTransaction();
  try {
    await query("SELECT id FROM problem WHERE type LIKE 'vjudge:%' FOR UPDATE");
    await query('CREATE TEMPORARY TABLE retired_problem_ids (id INT PRIMARY KEY) ENGINE=InnoDB');
    await query("INSERT INTO retired_problem_ids SELECT id FROM problem WHERE type LIKE 'vjudge:%'");
    await query('CREATE TEMPORARY TABLE retired_submission_ids (id INT PRIMARY KEY) ENGINE=InnoDB');
    await query('INSERT INTO retired_submission_ids SELECT id FROM judge_state WHERE problem_id IN (SELECT id FROM retired_problem_ids)');
    await query('CREATE TEMPORARY TABLE affected_user_ids (id INT PRIMARY KEY) ENGINE=InnoDB');
    await query('INSERT IGNORE INTO affected_user_ids SELECT user_id FROM judge_state WHERE id IN (SELECT id FROM retired_submission_ids)');
    if (has('article_comment')) await mutate('article_comment', 'DELETE FROM article_comment WHERE article_id IN (SELECT id FROM article WHERE problem_id IN (SELECT id FROM retired_problem_ids))');
    if (has('problem_solution_comment')) await mutate('problem_solution_comment', 'DELETE FROM problem_solution_comment WHERE solution_id IN (SELECT id FROM problem_solution WHERE problem_id IN (SELECT id FROM retired_problem_ids))');
    const problemTables = ['problem_tag_map', 'problem_solution_setting', 'problem_solution', 'article', 'submission_statistics', 'problem_v2_state', 'problem_v2_version', 'problem_v2_snapshot', 'problem_v2_upload', 'problem_v2_job', 'contest_v2_problem_snapshot', 'submission_v2_projection', 'problem_set_submission', 'base_workspace_problem', 'ai_contest_attempt'];
    for (const table of problemTables) {
      if (has(table, 'problem_id')) await mutate(table, `DELETE FROM \`${table}\` WHERE problem_id IN (SELECT id FROM retired_problem_ids)`);
    }
    for (const table of ['base_workspace_problem_migration', 'base_workspace_problem_sync']) {
      for (const column of ['source_problem_id', 'target_problem_id']) {
        if (has(table, column)) await mutate(table, `DELETE FROM \`${table}\` WHERE \`${column}\` IN (SELECT id FROM retired_problem_ids)`);
      }
    }
    for (const table of ['submission_statistics', 'submission_v2_attempt', 'submission_v2_job', 'submission_v2_code_version', 'submission_v2_projection', 'submission_v2_result_revision', 'admin_v2_rejudge_item', 'problem_set_submission', 'ai_contest_attempt']) {
      if (has(table, 'submission_id')) await mutate(table, `DELETE FROM \`${table}\` WHERE submission_id IN (SELECT id FROM retired_submission_ids)`);
    }
    if (has('judge_state_admin_action')) {
      await mutate('judge_state_admin_action', 'DELETE FROM judge_state_admin_action WHERE judge_id IN (SELECT id FROM retired_submission_ids)');
      await mutate('judge_state_admin_action', 'DELETE FROM judge_state_admin_action WHERE affected_problem_id IN (SELECT id FROM retired_problem_ids)');
    }
    for (const [table, column, target] of [['admin_v2_rejudge_job', 'current_submission_id', 'retired_submission_ids'], ['contest_v2_standings_version', 'source_submission_id', 'retired_submission_ids'], ['ai_contest_run', 'current_problem_id', 'retired_problem_ids']]) {
      if (has(table, column)) await mutate(table, `UPDATE \`${table}\` SET \`${column}\`=NULL WHERE \`${column}\` IN (SELECT id FROM ${target})`);
    }
    if (has('ticket')) {
      await mutate('ticket', "UPDATE ticket SET relation_id=NULL WHERE relation_type='problem' AND relation_id IN (SELECT id FROM retired_problem_ids)");
      await mutate('ticket', "UPDATE ticket SET relation_id=NULL WHERE relation_type='submission' AND relation_id IN (SELECT id FROM retired_submission_ids)");
    }
    for (const table of ['auth_grant', 'auth_policy']) {
      if (has(table)) await mutate(table, `DELETE FROM \`${table}\` WHERE scope_type='problem' AND scope_id IN (SELECT id FROM retired_problem_ids)`);
    }
    if (has('auth_grant')) await mutate('auth_grant', "DELETE FROM auth_grant WHERE role_id IN (SELECT id FROM auth_role WHERE name='vjudge_manager')");
    if (has('auth_role_capability')) {
      await mutate('auth_role_capability', "DELETE FROM auth_role_capability WHERE role_id IN (SELECT id FROM auth_role WHERE name='vjudge_manager') OR capability LIKE 'vjudge:%'");
    }
    if (has('auth_policy')) await mutate('auth_policy', "DELETE FROM auth_policy WHERE capability LIKE 'vjudge:%'");
    if (has('auth_role')) await mutate('auth_role', "DELETE FROM auth_role WHERE name='vjudge_manager'");
    for (const table of ['rating_notification_delivery', 'rating_v2_contest_override', 'rating_v2_current', 'rating_v2_event', 'rating_v2_job', 'rating_v2_preview']) {
      if (has(table, 'profile_id')) await mutate(table, `DELETE FROM \`${table}\` WHERE profile_id='vjudge'`);
    }
    if (has('rating_v2_profile')) await mutate('rating_v2_profile', "DELETE FROM rating_v2_profile WHERE id='vjudge'");
    for (const table of ['api_v2_rollout', 'api_v2_migration_lock', 'api_v2_migration_run']) {
      if (has(table, 'domain')) await mutate(table, `DELETE FROM \`${table}\` WHERE domain='vjudge'`);
    }
    if (has('site_config_v2_override')) await mutate('site_config_v2_override', "DELETE FROM site_config_v2_override WHERE field_name='provider_credentials'");
    await mutate('judge_state', 'DELETE FROM judge_state WHERE id IN (SELECT id FROM retired_submission_ids)');
    await mutate('problem', 'DELETE FROM problem WHERE id IN (SELECT id FROM retired_problem_ids)');
    await mutate('orphan_source_tag_map', "DELETE m FROM problem_tag_map m JOIN problem_tag t ON t.id=m.tag_id LEFT JOIN problem p ON p.id=m.problem_id WHERE p.id IS NULL AND UPPER(t.name) IN ('UOJ','HDU','POJ','VJUDGE')");
    await mutate('problem_tag', "DELETE FROM problem_tag WHERE UPPER(name) IN ('UOJ','HDU','POJ','VJUDGE') AND id NOT IN (SELECT tag_id FROM problem_tag_map)");
    await mutate('user_statistics', `UPDATE user u JOIN affected_user_ids affected ON affected.id=u.id SET
      u.submit_num=(SELECT COUNT(*) FROM judge_state j WHERE j.user_id=u.id AND j.type!=1),
      u.ac_num=(SELECT COUNT(DISTINCT j.problem_id) FROM judge_state j
        LEFT JOIN judge_state_admin_action action ON action.judge_id=j.id
        WHERE j.user_id=u.id AND j.type!=1 AND j.status='Accepted' AND action.judge_id IS NULL)`);
    if (await localDigest() !== localHash) throw new Error('Local problems changed; rolling back.');
    const after = { problems: await count('SELECT COUNT(*) count FROM problem'), submissions: await count('SELECT COUNT(*) count FROM judge_state'), remote_problems: await count("SELECT COUNT(*) count FROM problem WHERE type LIKE 'vjudge:%'") };
    if (after.problems !== before.local_problems || after.remote_problems || after.submissions !== before.all_submissions - before.remote_submissions) throw new Error('Count verification failed; rolling back.');
    await db.commit();
    // DDL follows the verified data transaction; no executable provider code remains.
    const retiredTables = ['vjudge_v2_submission_sync', 'vjudge_v2_import_item', 'vjudge_v2_import_job', 'vjudge_v2_remote_problem', 'vjudge_v2_credential', 'vjudge_import_task'];
    for (const table of retiredTables) if (has(table)) await query(`DROP TABLE \`${table}\``);
    return { dry_run: false, before, after, removed, dropped_tables: retiredTables.filter(table => has(table)), local_problem_hash_unchanged: true };
  } catch (error) {
    await db.rollback();
    throw error;
  }
}

if (require.main === module || !module.parent) {
  (async () => {
    const db = await require('mysql2/promise').createConnection({ host: process.env.SYZOJ_WEB_DB_HOST, user: process.env.SYZOJ_WEB_DB_USERNAME, password: process.env.SYZOJ_WEB_DB_PASSWORD, database: process.env.SYZOJ_WEB_DB_DATABASE });
    try { console.log(JSON.stringify(await removeVJudge(db, process.argv.includes('--execute')), null, 2)); }
    finally { await db.end(); }
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { removeVJudge };
