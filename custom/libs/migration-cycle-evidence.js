'use strict';

const crypto = require('node:crypto');
const TypeORM = require('typeorm');

let schemaPromise = null;

async function ensureSchema(connection = TypeORM.getConnection()) {
  if (!schemaPromise) {
    schemaPromise = connection.query(`CREATE TABLE IF NOT EXISTS api_v2_migration_contest_cycle_evidence (
      contest_id INT NOT NULL PRIMARY KEY,
      title VARCHAR(80) NOT NULL,
      start_time INT NOT NULL,
      end_time INT NOT NULL,
      participant_count INT NOT NULL,
      submission_count INT NOT NULL,
      compatibility_started_at DATETIME(3) NOT NULL,
      evidence_json LONGTEXT NOT NULL,
      evidence_hash CHAR(64) NOT NULL,
      archived_by INT NULL,
      verified_at DATETIME(3) NOT NULL,
      KEY idx_migration_cycle_window(compatibility_started_at,end_time)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(error => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function archiveCompletedCycle(manager, contestId, actorId) {
  const compatibilityRows = await manager.query(
    "SELECT compatibility_started_at FROM api_v2_migration_compatibility WHERE scope='global' FOR UPDATE"
  );
  if (!compatibilityRows.length || !compatibilityRows[0].compatibility_started_at) return null;
  const compatibilityStartedAt = compatibilityRows[0].compatibility_started_at;
  const contests = await manager.query(
    `SELECT id,title,start_time,end_time
       FROM contest
      WHERE id=? AND start_time>=UNIX_TIMESTAMP(?) AND end_time<=UNIX_TIMESTAMP()
      LIMIT 1`,
    [contestId, compatibilityStartedAt]
  );
  if (!contests.length) return null;
  const submissions = await manager.query(
    `SELECT participant.user_id,submission.id AS submission_id,submission.status,submission.score
       FROM contest_player participant
       INNER JOIN judge_state submission
         ON submission.type=1 AND submission.type_info=participant.contest_id
        AND submission.user_id=participant.user_id
       LEFT JOIN contest_registration_removal removal
         ON removal.contest_id=participant.contest_id AND removal.user_id=participant.user_id
      WHERE participant.contest_id=? AND removal.user_id IS NULL
      ORDER BY participant.user_id ASC,submission.id ASC`,
    [contestId]
  );
  if (!submissions.length) return null;
  const contest = contests[0];
  const payload = {
    version: 1,
    contest_id: Number(contest.id),
    title: contest.title,
    start_time: Number(contest.start_time),
    end_time: Number(contest.end_time),
    participants: Array.from(new Set(submissions.map(row => Number(row.user_id)))),
    submissions: submissions.map(row => ({
      id: Number(row.submission_id),
      user_id: Number(row.user_id),
      status: row.status,
      score: row.score == null ? null : Number(row.score)
    }))
  };
  const evidenceJson = JSON.stringify(payload);
  const evidenceHash = crypto.createHash('sha256').update(evidenceJson).digest('hex');
  await manager.query(
    `INSERT INTO api_v2_migration_contest_cycle_evidence
       (contest_id,title,start_time,end_time,participant_count,submission_count,
        compatibility_started_at,evidence_json,evidence_hash,archived_by,verified_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE contest_id=contest_id`,
    [contest.id, contest.title, contest.start_time, contest.end_time, payload.participants.length,
      payload.submissions.length, compatibilityStartedAt, evidenceJson, evidenceHash, actorId || null]
  );
  return {
    contest_id: Number(contest.id),
    participant_count: payload.participants.length,
    submission_count: payload.submissions.length,
    evidence_hash: evidenceHash
  };
}

async function completedCycleSummary(connection, compatibilityStartedAt) {
  await ensureSchema(connection);
  if (!compatibilityStartedAt) return { total: 0, archived: 0 };
  const rows = await connection.query(
    `SELECT COUNT(DISTINCT cycle.contest_id) AS total,
            COUNT(DISTINCT CASE WHEN cycle.source='archived' THEN cycle.contest_id END) AS archived
       FROM (
         SELECT contest.id AS contest_id,'live' AS source
           FROM contest
          WHERE contest.start_time>=UNIX_TIMESTAMP(?) AND contest.end_time<=UNIX_TIMESTAMP()
            AND EXISTS (
              SELECT 1 FROM contest_player participant
              INNER JOIN judge_state submission
                ON submission.type=1 AND submission.type_info=contest.id
               AND submission.user_id=participant.user_id
              LEFT JOIN contest_registration_removal removal
                ON removal.contest_id=participant.contest_id AND removal.user_id=participant.user_id
              WHERE participant.contest_id=contest.id AND removal.user_id IS NULL
            )
         UNION ALL
         SELECT evidence.contest_id,'archived' AS source
           FROM api_v2_migration_contest_cycle_evidence evidence
          WHERE evidence.compatibility_started_at>=?
       ) cycle`,
    [compatibilityStartedAt, compatibilityStartedAt]
  );
  return {
    total: Number(rows[0] && rows[0].total || 0),
    archived: Number(rows[0] && rows[0].archived || 0)
  };
}

module.exports = { archiveCompletedCycle, completedCycleSummary, ensureSchema };
