'use strict';

const bcrypt = require('bcryptjs');
const fs = require('fs-extra');
const mysql = require('mysql2/promise');
const path = require('path');

const action = process.argv[2] || process.env.CONTEST_FIXTURE_ACTION || 'status';
const count = Number(process.env.CONTEST_FIXTURE_COUNT || 1000);
const password = String(process.env.CONTEST_FIXTURE_PASSWORD || 'PerfTest#2026');
const prefix = String(process.env.CONTEST_FIXTURE_PREFIX || 'perf_extreme_');
const marker = '[PERF-TEST] contest-load-extreme';
const contestTitle = marker + ' contest';
const problemTitle = marker + ' 3000ms 50-cases';
const emailDomain = 'perf-test.invalid';
const uploadDir = process.env.SYZOJ_WEB_UPLOAD_DIR || '/app/uploads';
const sessionDir = '/app/sessions';

function placeholders(values) {
  return values.map(() => '?').join(',');
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function fixtureUsername(index) {
  return prefix + String(index + 1).padStart(4, '0');
}

function fixtureStudentId(index) {
  return String(9899000001 + index);
}

async function openDatabase() {
  return mysql.createConnection({
    host: process.env.SYZOJ_WEB_DB_HOST || 'mariadb',
    user: process.env.SYZOJ_WEB_DB_USERNAME || 'syzoj',
    password: process.env.SYZOJ_WEB_DB_PASSWORD || 'syzoj',
    database: process.env.SYZOJ_WEB_DB_DATABASE || 'syzoj',
    charset: 'utf8mb4'
  });
}

async function findFixture(db) {
  const [contests] = await db.execute(
    'SELECT id,ranklist_id FROM contest WHERE title=? AND information=?',
    [contestTitle, marker]
  );
  const [problems] = await db.execute(
    'SELECT id FROM problem WHERE title=? AND description LIKE ?',
    [problemTitle, marker + '%']
  );
  const [users] = await db.execute(
    `SELECT id,username FROM user
     WHERE username LIKE ? AND email LIKE ? AND information=? ORDER BY id`,
    [prefix + '%', '%@' + emailDomain, marker]
  );
  return { contests, problems, users };
}

async function removeSessions(userIds) {
  if (!userIds.length || !await fs.pathExists(sessionDir)) return 0;
  const fixtureIds = new Set(userIds.map(Number));
  let removed = 0;
  for (const filename of await fs.readdir(sessionDir)) {
    const filePath = path.join(sessionDir, filename);
    let content;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      continue;
    }
    const match = /"user_id"\s*:\s*(\d+)/.exec(content);
    if (match && fixtureIds.has(Number(match[1]))) {
      await fs.remove(filePath);
      removed++;
    }
  }
  return removed;
}

async function deleteByIds(db, table, column, ids) {
  if (!ids.length) return;
  await db.query(`DELETE FROM \`${table}\` WHERE \`${column}\` IN (${placeholders(ids)})`, ids);
}

async function cleanup(db) {
  const fixture = await findFixture(db);
  const contestIds = fixture.contests.map(row => Number(row.id));
  const ranklistIds = fixture.contests.map(row => Number(row.ranklist_id));
  const problemIds = fixture.problems.map(row => Number(row.id));
  const userIds = fixture.users.map(row => Number(row.id));

  let pending = 0;
  if (contestIds.length || problemIds.length) {
    const conditions = [];
    const params = [];
    if (contestIds.length) {
      conditions.push(`(type=1 AND type_info IN (${placeholders(contestIds)}))`);
      params.push(...contestIds);
    }
    if (problemIds.length) {
      conditions.push(`problem_id IN (${placeholders(problemIds)})`);
      params.push(...problemIds);
    }
    const [rows] = await db.query(
      `SELECT COUNT(*) AS count FROM judge_state WHERE pending=1 AND (${conditions.join(' OR ')})`,
      params
    );
    pending = Number(rows[0].count);
  }
  if (pending) throw new Error(`Refusing cleanup while ${pending} fixture submissions are pending`);

  let judgeIds = [];
  if (contestIds.length || problemIds.length) {
    const conditions = [];
    const params = [];
    if (contestIds.length) {
      conditions.push(`(type=1 AND type_info IN (${placeholders(contestIds)}))`);
      params.push(...contestIds);
    }
    if (problemIds.length) {
      conditions.push(`problem_id IN (${placeholders(problemIds)})`);
      params.push(...problemIds);
    }
    const [judges] = await db.query(
      `SELECT id FROM judge_state WHERE ${conditions.join(' OR ')}`,
      params
    );
    judgeIds = judges.map(row => Number(row.id));
  }

  const sessionsRemoved = await removeSessions(userIds);
  await db.beginTransaction();
  try {
    await deleteByIds(db, 'judge_state_admin_action', 'judge_id', judgeIds);
    await deleteByIds(db, 'judge_state', 'id', judgeIds);
    await deleteByIds(db, 'submission_statistics', 'problem_id', problemIds);

    let ratingCalculationIds = [];
    if (contestIds.length) {
      const [calculations] = await db.query(
        `SELECT id FROM rating_calculation WHERE contest_id IN (${placeholders(contestIds)})`,
        contestIds
      );
      ratingCalculationIds = calculations.map(row => Number(row.id));
    }
    await deleteByIds(db, 'contest_rating_finalization', 'contest_id', contestIds);
    await deleteByIds(db, 'rating_calculation', 'id', ratingCalculationIds);
    await deleteByIds(db, 'contest_registration_removal', 'contest_id', contestIds);
    await deleteByIds(db, 'contest_registration_setting', 'contest_id', contestIds);
    await deleteByIds(db, 'contest_rating_config', 'contest_id', contestIds);
    await deleteByIds(db, 'contest_player', 'contest_id', contestIds);
    await deleteByIds(db, 'contest', 'id', contestIds);
    await deleteByIds(db, 'contest_ranklist', 'id', ranklistIds);

    await deleteByIds(db, 'problem_tag_map', 'problem_id', problemIds);
    await deleteByIds(db, 'problem_solution_setting', 'problem_id', problemIds);
    await deleteByIds(db, 'problem_solution', 'problem_id', problemIds);
    await deleteByIds(db, 'article', 'problem_id', problemIds);
    await deleteByIds(db, 'problem', 'id', problemIds);

    const userTables = [
      'account_password_reset', 'clipboard_item', 'content_form_token', 'email_verification_token',
      'rating_history', 'submission_statistics', 'user_avatar', 'user_email_status', 'user_hit_score',
      'user_hit_score_history', 'user_hit_setting', 'user_message_setting', 'user_privilege',
      'user_registration_profile', 'user_tag'
    ];
    for (const table of userTables) await deleteByIds(db, table, 'user_id', userIds);
    if (userIds.length) {
      const userPlaceholders = placeholders(userIds);
      await db.query(
        `DELETE FROM private_message WHERE sender_id IN (${userPlaceholders}) OR receiver_id IN (${userPlaceholders})`,
        userIds.concat(userIds)
      );
      await db.query(
        `DELETE FROM user_follow WHERE follower_id IN (${userPlaceholders}) OR followee_id IN (${userPlaceholders})`,
        userIds.concat(userIds)
      );
      await db.query(
        `DELETE FROM notification WHERE recipient_id IN (${userPlaceholders}) OR actor_id IN (${userPlaceholders})`,
        userIds.concat(userIds)
      );
    }
    await deleteByIds(db, 'user', 'id', userIds);
    await db.commit();
  } catch (error) {
    await db.rollback();
    throw error;
  }

  for (const problemId of problemIds) {
    await fs.remove(path.join(uploadDir, 'testdata', String(problemId)));
    await fs.remove(path.join(uploadDir, 'testdata-archive', String(problemId) + '.zip'));
  }
  return {
    contestsRemoved: contestIds.length,
    problemsRemoved: problemIds.length,
    usersRemoved: userIds.length,
    submissionsRemoved: judgeIds.length,
    sessionsRemoved
  };
}

async function setup(db) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) {
    throw new Error('CONTEST_FIXTURE_COUNT must be an integer from 1 to 1000');
  }
  if (password.length < 10 || password.length > 128) {
    throw new Error('CONTEST_FIXTURE_PASSWORD must contain 10 to 128 characters');
  }

  const cleanupResult = await cleanup(db);
  const [conflictingUsers] = await db.execute(
    'SELECT id,username,email,information FROM user WHERE username LIKE ? OR email LIKE ?',
    [prefix + '%', '%@' + emailDomain]
  );
  if (conflictingUsers.length) throw new Error('Fixture username or email namespace is already in use');
  const studentIds = Array.from({ length: count }, (_, index) => fixtureStudentId(index));
  const [conflictingProfiles] = await db.query(
    `SELECT student_id FROM user_registration_profile WHERE student_id IN (${placeholders(studentIds)}) LIMIT 1`,
    studentIds
  );
  if (conflictingProfiles.length) throw new Error('Fixture student ID namespace is already in use');

  const now = Math.floor(Date.now() / 1000);
  const passwordHash = 'bcrypt$' + await bcrypt.hash(password, 11);
  let problemId = null;
  let contestId = null;
  let ranklistId = null;
  let testdataPath = null;

  await db.beginTransaction();
  try {
    const users = Array.from({ length: count }, (_, index) => ({
      username: fixtureUsername(index),
      email: fixtureUsername(index) + '@' + emailDomain,
      studentId: studentIds[index]
    }));
    for (const group of chunk(users, 200)) {
      const values = [];
      const rows = group.map(user => {
        values.push(
          user.username, user.email, passwordHash, user.username, '', marker,
          0, 0, 0, 1, 0, 1, 0, 1500, now
        );
        return '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
      });
      await db.query(
        `INSERT INTO user
          (username,email,password,nickname,nameplate,information,ac_num,submit_num,is_admin,is_show,
           public_email,prefer_formatted_code,sex,rating,register_time)
         VALUES ${rows.join(',')}`,
        values
      );
    }
    const [createdUsers] = await db.execute(
      'SELECT id,username FROM user WHERE username LIKE ? AND information=? ORDER BY username',
      [prefix + '%', marker]
    );
    if (createdUsers.length !== count) throw new Error(`Created ${createdUsers.length} users, expected ${count}`);

    for (const group of chunk(createdUsers, 200)) {
      const values = [];
      const rows = group.map(user => {
        const index = Number(user.username.slice(prefix.length)) - 1;
        values.push(Number(user.id), studentIds[index], 'Perf User ' + (index + 1), 'Performance College', now, now);
        return '(?,?,?,?,?,?)';
      });
      await db.query(
        `INSERT INTO user_registration_profile
          (user_id,student_id,real_name,college,created_at,updated_at) VALUES ${rows.join(',')}`,
        values
      );
    }

    const [problemResult] = await db.execute(
      `INSERT INTO problem
        (title,user_id,publicizer_id,is_anonymous,description,input_format,output_format,example,
         limit_and_hint,time_limit,memory_limit,ac_num,submit_num,is_public,file_io,publicize_time,type)
       VALUES (?,1,1,0,?,?,?,?,?,?,256,0,0,1,0,NOW(),'traditional')`,
      [
        problemTitle,
        marker + '\n\nRead two signed 64-bit integers and print their sum.',
        'Two signed 64-bit integers.',
        'Their sum.',
        '1 2\n\n3',
        'Time limit: 3000 ms. Test cases: 50.',
        3000
      ]
    );
    problemId = Number(problemResult.insertId);
    testdataPath = path.join(uploadDir, 'testdata', String(problemId));
    await fs.ensureDir(testdataPath);
    for (let index = 1; index <= 50; index++) {
      const left = index * 1000003 - 25000000;
      const right = index * -999983 + 17000000;
      const name = String(index).padStart(2, '0');
      await fs.writeFile(path.join(testdataPath, name + '.in'), `${left} ${right}\n`);
      await fs.writeFile(path.join(testdataPath, name + '.out'), `${left + right}\n`);
    }

    const [ranklistResult] = await db.execute(
      'INSERT INTO contest_ranklist (ranking_params,ranklist) VALUES (?,?)',
      ['{}', JSON.stringify({ player_num: 0 })]
    );
    ranklistId = Number(ranklistResult.insertId);
    const [contestResult] = await db.execute(
      `INSERT INTO contest
        (title,subtitle,start_time,end_time,holder_id,type,information,problems,admins,ranklist_id,is_public,hide_statistics)
       VALUES (?,?,?,?,1,'acm',?,?,?, ?,1,0)`,
      [contestTitle, marker, now - 60, now + 7200, marker, String(problemId), '', ranklistId]
    );
    contestId = Number(contestResult.insertId);
    await db.execute(
      `INSERT INTO contest_rating_config (contest_id,is_rated,updated_at,updated_by)
       VALUES (?,0,?,1)`,
      [contestId, now]
    );
    await db.execute(
      `INSERT INTO contest_registration_setting (contest_id,allow_late_registration,revision,updated_at)
       VALUES (?,1,1,?)`,
      [contestId, now]
    );

    for (const group of chunk(createdUsers, 200)) {
      const values = [];
      const rows = group.map(user => {
        values.push(contestId, Number(user.id), 0, '{}', 0);
        return '(?,?,?,?,?)';
      });
      await db.query(
        `INSERT INTO contest_player (contest_id,user_id,score,score_details,time_spent) VALUES ${rows.join(',')}`,
        values
      );
    }
    const [players] = await db.execute(
      'SELECT id FROM contest_player WHERE contest_id=? ORDER BY id',
      [contestId]
    );
    const ranklist = { player_num: players.length };
    players.forEach((player, index) => { ranklist[index + 1] = Number(player.id); });
    await db.execute(
      'UPDATE contest_ranklist SET ranklist=? WHERE id=?',
      [JSON.stringify(ranklist), ranklistId]
    );
    await db.commit();
  } catch (error) {
    await db.rollback();
    if (testdataPath) await fs.remove(testdataPath);
    throw error;
  }

  return {
    cleanupBeforeSetup: cleanupResult,
    contestId,
    problemId,
    ranklistId,
    users: count,
    testCases: 50,
    prefix,
    password,
    contestEndsAt: now + 7200
  };
}

async function status(db) {
  const fixture = await findFixture(db);
  const contestIds = fixture.contests.map(row => Number(row.id));
  const problemIds = fixture.problems.map(row => Number(row.id));
  let submissions = [];
  let players = 0;
  if (contestIds.length) {
    const [rows] = await db.query(
      `SELECT status,pending,COUNT(*) AS count FROM judge_state
       WHERE type=1 AND type_info IN (${placeholders(contestIds)}) GROUP BY status,pending`,
      contestIds
    );
    submissions = rows.map(row => ({ status: row.status, pending: !!row.pending, count: Number(row.count) }));
    const [playerRows] = await db.query(
      `SELECT COUNT(*) AS count FROM contest_player WHERE contest_id IN (${placeholders(contestIds)})`,
      contestIds
    );
    players = Number(playerRows[0].count);
  }
  const testCases = problemIds.length
    ? (await fs.readdir(path.join(uploadDir, 'testdata', String(problemIds[0])))).filter(name => name.endsWith('.in')).length
    : 0;
  return {
    contestIds,
    problemIds,
    users: fixture.users.length,
    players,
    testCases,
    submissions
  };
}

async function main() {
  const db = await openDatabase();
  try {
    let result;
    if (action === 'setup') result = await setup(db);
    else if (action === 'cleanup') result = await cleanup(db);
    else if (action === 'status') result = await status(db);
    else throw new Error('Action must be setup, status or cleanup');
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally {
    await db.end();
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
