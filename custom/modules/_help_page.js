'use strict';

const crypto = require('crypto');
const fs = require('fs');
const TypeORM = require('typeorm');

const DEFAULT_HELP = fs.readFileSync('/app/default-help.md', 'utf8');
const MAX_HELP_SIZE = 200 * 1024;
let helpSchemaPromise = null;

function ensureHelpSchema() {
  if (!helpSchemaPromise) {
    helpSchemaPromise = (async () => {
      const connection = TypeORM.getConnection();
      await connection.query(`
        CREATE TABLE IF NOT EXISTS site_help_page (
          id TINYINT NOT NULL,
          content MEDIUMTEXT NOT NULL,
          revision INT NOT NULL DEFAULT 1,
          updated_by INT NULL,
          updated_at INT NOT NULL,
          PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await connection.query(`
        CREATE TABLE IF NOT EXISTS site_help_page_history (
          id BIGINT NOT NULL AUTO_INCREMENT,
          revision INT NOT NULL,
          content MEDIUMTEXT NOT NULL,
          updated_by INT NULL,
          updated_at INT NOT NULL,
          archived_at INT NOT NULL,
          PRIMARY KEY (id),
          KEY idx_site_help_history_revision (revision)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await connection.query(
        `INSERT IGNORE INTO site_help_page (id,content,revision,updated_by,updated_at)
         VALUES (1,?,1,NULL,?)`,
        [DEFAULT_HELP, Math.floor(Date.now() / 1000)]
      );
    })().catch(error => {
      helpSchemaPromise = null;
      throw error;
    });
  }
  return helpSchemaPromise;
}

function requireHelpAdmin(res) {
  if (!res.locals.user || !res.locals.user.is_admin) {
    const error = new ErrorMessage('只有全站管理员可以修改帮助页。');
    error.statusCode = 403;
    throw error;
  }
}

function validAdminCsrf(req) {
  const expected = req.session && req.session.adminCsrfToken;
  const actual = req.body && req.body.csrf_token;
  return typeof expected === 'string' && typeof actual === 'string' && expected.length === actual.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

async function loadHelpPage() {
  await ensureHelpSchema();
  const rows = await TypeORM.getConnection().query(
    `SELECT page.content,page.revision,page.updated_by,page.updated_at,user.username AS updater_name
     FROM site_help_page page LEFT JOIN user ON user.id=page.updated_by WHERE page.id=1 LIMIT 1`
  );
  if (!rows.length) throw new Error('帮助页数据不存在。');
  return rows[0];
}

app.get('/help', async (req, res) => {
  try {
    const helpPage = await loadHelpPage();
    res.render('help', {
      helpPage,
      helpContentRendered: await syzoj.utils.markdown(helpPage.content || '')
    });
  } catch (error) {
    syzoj.log('[help-page] ' + (error.stack || error));
    res.status(500).render('error', { err: error });
  }
});

app.get('/admin/help', async (req, res) => {
  try {
    requireHelpAdmin(res);
    res.render('admin_help_edit', { helpPage: await loadHelpPage() });
  } catch (error) {
    if (!error.statusCode || error.statusCode >= 500) syzoj.log('[help-page] ' + (error.stack || error));
    res.status(error.statusCode || 500).render('error', { err: error });
  }
});

app.post('/admin/help', async (req, res) => {
  try {
    requireHelpAdmin(res);
    if (!validAdminCsrf(req)) {
      const error = new ErrorMessage('页面已失效，请刷新后重试。');
      error.statusCode = 403;
      throw error;
    }
    const content = String(req.body.content || '').trim();
    const revision = Number(req.body.revision);
    if (!content) throw new ErrorMessage('帮助页内容不能为空。');
    if (Buffer.byteLength(content, 'utf8') > MAX_HELP_SIZE) throw new ErrorMessage('帮助页内容不能超过 200 KiB。');
    if (!Number.isSafeInteger(revision) || revision <= 0) throw new ErrorMessage('帮助页修订号无效。');
    const now = Math.floor(Date.now() / 1000);

    await ensureHelpSchema();
    await TypeORM.getConnection().transaction(async manager => {
      const rows = await manager.query('SELECT * FROM site_help_page WHERE id=1 FOR UPDATE');
      const current = rows[0];
      if (!current) throw new ErrorMessage('帮助页数据不存在。');
      if (Number(current.revision) !== revision) {
        const error = new ErrorMessage('帮助页已被其他管理员修改，请刷新后重新编辑。');
        error.statusCode = 409;
        throw error;
      }
      await manager.query(
        `INSERT INTO site_help_page_history
          (revision,content,updated_by,updated_at,archived_at) VALUES (?,?,?,?,?)`,
        [current.revision, current.content, current.updated_by, current.updated_at, now]
      );
      await manager.query(
        'UPDATE site_help_page SET content=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=1',
        [content, res.locals.user.id, now]
      );
    });
    res.redirect(303, syzoj.utils.makeUrl(['help']));
  } catch (error) {
    syzoj.log('[help-page] save failed: ' + (error.stack || error));
    res.status(error.statusCode || 400).render('error', { err: error });
  }
});

ensureHelpSchema().catch(error => {
  syzoj.log('[help-page] schema initialization failed: ' + (error.stack || error));
  process.exit(1);
});
