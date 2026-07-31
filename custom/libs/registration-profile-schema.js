'use strict';

const ORDINARY_STUDENT_ID_SCOPE = 'ordinary';

function defaultConnection() {
  return require('typeorm').getConnection();
}

function temporaryStudentIdScope(contestId) {
  const id = Number(contestId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError('contestId must be a positive integer');
  return `contest:${id}`;
}

async function indexExists(connection, indexName) {
  const rows = await connection.query(
    `SELECT 1
     FROM information_schema.statistics
     WHERE table_schema=DATABASE() AND table_name='user_registration_profile' AND index_name=?
     LIMIT 1`,
    [indexName]
  );
  return rows.length > 0;
}

async function tableExists(connection, tableName) {
  const rows = await connection.query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema=DATABASE() AND table_name=?
     LIMIT 1`,
    [tableName]
  );
  return rows.length > 0;
}

async function synchronizeTemporaryStudentIdScopes(connection = defaultConnection()) {
  if (!await tableExists(connection, 'temporary_contest_account')) return;
  await connection.query(
    `UPDATE user_registration_profile profile
     INNER JOIN temporary_contest_account account ON account.user_id=profile.user_id
     SET profile.student_id_scope=CONCAT('contest:', account.contest_id)
     WHERE profile.student_id_scope<>CONCAT('contest:', account.contest_id)`
  );
}

let schemaPromise = null;
function ensureRegistrationProfileSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const connection = defaultConnection();
      await connection.query(`
        CREATE TABLE IF NOT EXISTS user_registration_profile (
          user_id INT NOT NULL,
          student_id_scope VARCHAR(32) NOT NULL DEFAULT '${ORDINARY_STUDENT_ID_SCOPE}',
          student_id VARCHAR(10) NULL,
          real_name VARCHAR(64) NULL,
          college VARCHAR(100) NULL,
          created_at INT NOT NULL,
          updated_at INT NOT NULL,
          PRIMARY KEY (user_id),
          UNIQUE KEY uq_user_registration_profile_student_scope (student_id_scope,student_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await connection.query(
        `ALTER TABLE user_registration_profile
         ADD COLUMN IF NOT EXISTS student_id_scope VARCHAR(32) NOT NULL DEFAULT '${ORDINARY_STUDENT_ID_SCOPE}' AFTER user_id`
      );
      await synchronizeTemporaryStudentIdScopes(connection);
      if (await indexExists(connection, 'uq_user_registration_profile_student_id')) {
        await connection.query('ALTER TABLE user_registration_profile DROP INDEX uq_user_registration_profile_student_id');
      }
      if (!await indexExists(connection, 'uq_user_registration_profile_student_scope')) {
        await connection.query(
          'ALTER TABLE user_registration_profile ADD UNIQUE KEY uq_user_registration_profile_student_scope (student_id_scope,student_id)'
        );
      }
    })().catch(error => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

module.exports = {
  ORDINARY_STUDENT_ID_SCOPE,
  ensureRegistrationProfileSchema,
  synchronizeTemporaryStudentIdScopes,
  temporaryStudentIdScope
};
