'use strict';

// Preview by default. Run in the web container with NWPUOJ_APP_ROOT=/app.
// Apply the exact inspected input with --apply=<hash> --actor=<account id>.
const crypto = require('crypto');
const path = require('path');
const appRoot = process.env.NWPUOJ_APP_ROOT || path.resolve(__dirname, '..');
const { cascadeRatingPeriods } = require(path.join(appRoot, 'libs/rating-recalculation'));
const { ALGORITHM_VERSION } = require(path.join(appRoot, 'libs/rating'));
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function replay(input) {
  const users = new Map(input.users.map(user => [Number(user.id), { rating: 0, ratedContests: 0 }]));
  const periods = input.contests.map(contest => ({ contestId: contest.id, standings: contest.standings }));
  const result = cascadeRatingPeriods(periods, users, { initialRating: 0 });
  const ratings = Array.from(result.finalStates, ([id, state]) => ({ id, rating: state.rating })).sort((a, b) => a.id - b.id);
  return { periods: result.periods, ratings };
}

async function readInput(manager, canonicalStandings) {
  const jobs = await manager.query("SELECT id FROM rating_v2_job WHERE state IN ('queued','running','paused','cancelling') FOR UPDATE");
  if (jobs.length) throw new Error('Resolve active Rating jobs before resetting Rating.');
  for (const table of ['rating_v2_event', 'rating_v2_current', 'rating_v2_contest_override']) {
    if ((await manager.query(`SELECT * FROM ${table} LIMIT 1 FOR UPDATE`)).length) throw new Error(`Independent Rating state exists in ${table}; review it before resetting.`);
  }
  const users = await manager.query('SELECT id,rating FROM user ORDER BY id FOR UPDATE');
  const rows = await manager.query(`SELECT c.* FROM contest c JOIN contest_rating_config cfg ON cfg.contest_id=c.id
    WHERE cfg.is_rated=1 AND c.end_time<=UNIX_TIMESTAMP() ORDER BY c.end_time,c.id FOR UPDATE`);
  const contests = [];
  for (const contest of rows) {
    const standing = await canonicalStandings(manager, contest);
    if (standing.deferred) throw new Error(`Contest #${contest.id} has pending submissions.`);
    contests.push({ id: Number(contest.id), title: contest.title, start_time: Number(contest.start_time), end_time: Number(contest.end_time),
      standings: standing.contestants.map(item => ({ userId: item.userId, rank: item.rank, score: item.score, tie: item.tie })) });
  }
  const history = await manager.query('SELECT rating_calculation_id,user_id,rating_after,rank FROM rating_history ORDER BY rating_calculation_id,user_id');
  const calculations = await manager.query('SELECT id,contest_id FROM rating_calculation ORDER BY id FOR UPDATE');
  const finalizations = await manager.query('SELECT * FROM contest_rating_finalization ORDER BY contest_id FOR UPDATE');
  const setting = await manager.query("SELECT value_json FROM site_config_v2_override WHERE field_name='default_user_rating' FOR UPDATE");
  return { algorithm_version: ALGORITHM_VERSION, initial_rating: 0, users, contests, history, calculations, finalizations, setting };
}

function summary(input, result) {
  const participants = new Set(result.periods.flatMap(period => period.changes.map(change => change.userId)));
  return { input_hash: digest(input), result_hash: digest(result), users: result.ratings.length, participants: participants.size,
    history_rows: result.periods.reduce((sum, period) => sum + period.changes.length, 0),
    changed_users: result.ratings.filter(user => input.users.find(before => Number(before.id) === user.id).rating !== user.rating).length,
    zero_rating_users: result.ratings.filter(user => user.rating === 0).length,
    minimum_rating: Math.min(...result.ratings.map(user => user.rating)), maximum_rating: Math.max(...result.ratings.map(user => user.rating)),
    contests: result.periods.map(period => ({ id: period.contestId, participants: input.contests.find(contest => contest.id === period.contestId).standings.length, status: period.changes.length ? 'completed' : 'skipped' })) };
}

async function writeReplay(manager, input, result, actorId) {
  const actors = await manager.query('SELECT id FROM user WHERE id=? FOR UPDATE', [actorId]);
  if (!actors.length) throw new Error('Audit actor does not exist.');
  await manager.query('DELETE FROM rating_history');
  await manager.query('DELETE FROM contest_rating_finalization');
  await manager.query('DELETE FROM rating_calculation');
  await manager.query('UPDATE user SET rating=0');
  for (const period of result.periods) {
    const source = input.contests.find(contest => contest.id === period.contestId);
    let calculationId = null;
    if (period.changes.length) {
      const inserted = await manager.query('INSERT INTO rating_calculation (contest_id) VALUES (?)', [period.contestId]);
      calculationId = Number(inserted.insertId);
      for (const change of period.changes) await manager.query('INSERT INTO rating_history (rating_calculation_id,user_id,rating_after,rank) VALUES (?,?,?,?)', [calculationId, change.userId, change.ratingAfter, change.rank]);
    }
    await manager.query(`INSERT INTO contest_rating_finalization
      (contest_id,rating_calculation_id,status,participant_count,algorithm_version,completed_at,skip_reason) VALUES (?,?,?,?,?,UNIX_TIMESTAMP(),?)`,
    [period.contestId, calculationId, period.changes.length ? 'completed' : 'skipped', source.standings.length, ALGORITHM_VERSION, period.changes.length ? null : 'fewer_than_two_eligible_participants']);
  }
  for (const user of result.ratings) if (user.rating !== 0) await manager.query('UPDATE user SET rating=? WHERE id=?', [user.rating, user.id]);
  await manager.query(`INSERT INTO site_config_v2_override (field_name,value_json,updated_by,updated_at) VALUES ('default_user_rating','0',?,UTC_TIMESTAMP(3))
    ON DUPLICATE KEY UPDATE value_json=VALUES(value_json),updated_by=VALUES(updated_by),updated_at=VALUES(updated_at)`, [actorId]);
  await manager.query("UPDATE rating_v2_profile SET algorithm='codeforces',algorithm_version=?,config_json=?,updated_at=UTC_TIMESTAMP(3)", [ALGORITHM_VERSION, JSON.stringify({ rating: 0 })]);
  await manager.query("UPDATE rating_v2_preview SET status='expired' WHERE status='pending'");
  // Remove obsolete Rating notices without delivering thousands of migration notifications.
  await manager.query("DELETE FROM notification WHERE type='contest_rating'");
  await manager.query("DELETE FROM rating_notification_delivery WHERE profile_id='icpc'");
  const details = summary(input, result);
  const audit = await manager.query(`INSERT INTO auth_audit_event
    (actor_id,action,resource_type,resource_id,scope_type,scope_id,reason,request_id,ip_address,details_json,created_at)
    VALUES (?,'rating:reset-codeforces','rating','icpc','global',NULL,?,NULL,NULL,?,UTC_TIMESTAMP(3))`,
  [actorId, '按用户要求取消 Hit、从初始 0 分按 Codeforces 规则重算所有 Rated 比赛', JSON.stringify(details)]);
  const stored = await manager.query('SELECT id,rating FROM user ORDER BY id');
  if (digest(stored.map(user => ({ id: Number(user.id), rating: Number(user.rating) }))) !== digest(result.ratings)) throw new Error('Stored ratings do not match the replay.');
  return { ...details, audit_event_id: String(audit.insertId) };
}

async function main() {
  const orm = require(path.join(appRoot, 'node_modules/typeorm'));
  const cfg = require(path.join(appRoot, 'config/web.json')).db;
  const host = process.env.SYZOJ_WEB_DB_HOST || cfg.host;
  const connection = await orm.createConnection({ type: 'mysql', host: host.split(':')[0], port: Number(host.split(':')[1] || 3306),
    username: process.env.SYZOJ_WEB_DB_USERNAME || cfg.username, password: process.env.SYZOJ_WEB_DB_PASSWORD || cfg.password,
    database: process.env.SYZOJ_WEB_DB_DATABASE || cfg.database });
  const runner = connection.createQueryRunner();
  await runner.connect();
  const locks = [];
  const manager = runner.manager;
  global.syzoj = { utils: { baseWorkspace: { contains: async (_kind, id) => (await manager.query('SELECT contest_id FROM base_workspace_contest WHERE contest_id=?', [id])).length > 0 } } };
  const { canonicalStandings } = require(path.join(appRoot, 'libs/contest-rating'));
  try {
    async function lock(name) {
      const rows = await runner.query('SELECT GET_LOCK(?,10) AS acquired', [name]);
      if (Number(rows[0].acquired) !== 1) throw new Error(`Rating operation busy: ${name}`);
      locks.push(name);
    }
    await lock('nwpuoj:contest:rating-finalizer');
    const contests = await manager.query('SELECT c.id FROM contest c JOIN contest_rating_config cfg ON cfg.contest_id=c.id WHERE cfg.is_rated=1 AND c.end_time<=UNIX_TIMESTAMP() ORDER BY c.end_time,c.id');
    for (const contest of contests) await lock(`nwpuoj:contest:${contest.id}`);
    await runner.startTransaction('SERIALIZABLE');
    const input = await readInput(manager, canonicalStandings);
    const result = replay(input);
    const hash = process.argv.find(arg => arg.startsWith('--apply='));
    if (!hash) {
      console.log(JSON.stringify({ dry_run: true, ...summary(input, result) }, null, 2));
      await runner.rollbackTransaction();
    } else {
      if (hash.slice('--apply='.length) !== digest(input)) throw new Error('Input changed since preview. Inspect a new preview.');
      const actorArg = process.argv.find(arg => arg.startsWith('--actor='));
      const actorId = Number(actorArg && actorArg.slice('--actor='.length));
      if (!Number.isSafeInteger(actorId) || actorId < 1) throw new Error('--actor is required.');
      const applied = await writeReplay(manager, input, result, actorId);
      await runner.commitTransaction();
      console.log(JSON.stringify({ applied: true, ...applied }, null, 2));
    }
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    while (locks.length) await runner.query('SELECT RELEASE_LOCK(?)', [locks.pop()]);
    await runner.release();
    await connection.close();
  }
}

module.exports = { digest, replay, readInput, summary, writeReplay };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
