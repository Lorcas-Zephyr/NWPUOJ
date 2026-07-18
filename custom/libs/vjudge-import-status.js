'use strict';

const TypeORM = require('typeorm');

module.exports = function createVjudgeImportStatus(provider, status) {
  async function write() {
    await TypeORM.getConnection().query(
      `INSERT INTO vjudge_import_task (provider, status_json, updated_at)
       VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE status_json = VALUES(status_json), updated_at = VALUES(updated_at)`,
      [provider, JSON.stringify(status)]
    );
  }

  let initialization = null;
  function initialize() {
    if (!initialization) {
      initialization = (async () => {
        await TypeORM.getConnection().query(`
          CREATE TABLE IF NOT EXISTS vjudge_import_task (
            provider VARCHAR(16) NOT NULL PRIMARY KEY,
            status_json LONGTEXT NOT NULL,
            updated_at DATETIME NOT NULL
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        const rows = await TypeORM.getConnection().query(
          'SELECT status_json FROM vjudge_import_task WHERE provider = ? LIMIT 1',
          [provider]
        );
        if (rows.length) {
          try {
            const saved = JSON.parse(rows[0].status_json);
            if (saved && typeof saved === 'object') Object.assign(status, saved);
          } catch (error) {
            syzoj.log(`[${provider}-import-status] Ignoring invalid saved status: ${error.message}`);
          }
        }
        if (status.state === 'running') {
          status.state = 'failed';
          status.phase = null;
          status.currentRemoteId = null;
          status.finishedAt = new Date().toISOString();
          status.error = '服务重启导致批量导入中断，请重新发起任务。';
          await write();
        }
      })().catch(error => {
        initialization = null;
        throw error;
      });
    }
    return initialization;
  }

  function initializeAfterStartup(attempt) {
    setTimeout(() => {
      initialize().catch(error => {
        if (attempt < 5) return initializeAfterStartup(attempt + 1);
        syzoj.log(`[${provider}-import-status] ${error.stack || error.message || error}`);
      });
    }, attempt * 1000);
  }
  initializeAfterStartup(1);

  return {
    async ready() {
      await initialize();
    },
    async save() {
      await initialize();
      await write();
    }
  };
};
