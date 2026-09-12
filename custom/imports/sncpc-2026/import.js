'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

let mysql;
try {
  mysql = require('mysql2/promise');
} catch (_) {
  mysql = require('/app/node_modules/mysql2/promise');
}

const sourceRoot = path.resolve(process.argv[2] || '/tmp/nwpuoj-sncpc-prepared');
const uploadRoot = process.env.SYZOJ_WEB_UPLOAD_DIR || '/app/uploads';
const publicAssetRoot = '/app/static/self/image-assets/sncpc-2026';
const actorId = 1;
const editableFields = [
  'title', 'description', 'input_format', 'output_format', 'example', 'limit_and_hint',
  'time_limit', 'python_time_limit_multiplier', 'memory_limit', 'file_io',
  'file_io_input_name', 'file_io_output_name', 'type', 'vjudge_config'
];

function orderedContent(source) {
  return Object.fromEntries(editableFields.map(field => [field, source[field] == null
    ? (field === 'python_time_limit_multiplier' ? 2 : null)
    : source[field]]));
}

function contentHash(content) {
  return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

async function listFiles(root, prefix = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(root, relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}

function imageMime(filename) {
  const extension = path.extname(filename).toLowerCase();
  return { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' }[extension] || 'application/octet-stream';
}

async function registerImageAssets(db) {
  const source = path.join(sourceRoot, '.assets');
  const files = await listFiles(source);
  await db.execute(`CREATE TABLE IF NOT EXISTS image_host_asset (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, uploader_id INT NOT NULL,
    storage_name VARCHAR(255) NOT NULL UNIQUE, original_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(64) NOT NULL, file_size INT UNSIGNED NOT NULL, created_at DATETIME(3) NOT NULL,
    KEY idx_image_host_uploader_created (uploader_id, created_at, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  for (const relative of files) {
    const storageName = `sncpc-2026/${relative.split(path.sep).join('/')}`;
    const stat = await fs.stat(path.join(source, relative));
    await db.execute(
      `INSERT INTO image_host_asset (uploader_id,storage_name,original_name,mime_type,file_size,created_at)
       VALUES (?,?,?,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE original_name=VALUES(original_name),mime_type=VALUES(mime_type),file_size=VALUES(file_size)`,
      [actorId, storageName, path.basename(relative).slice(0, 255), imageMime(relative), stat.size]
    );
  }
  return files.length;
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(sourceRoot, 'manifest.json'), 'utf8'));
  const db = await mysql.createConnection({
    host: process.env.SYZOJ_WEB_DB_HOST || 'mariadb',
    user: process.env.SYZOJ_WEB_DB_USERNAME || 'syzoj',
    password: process.env.SYZOJ_WEB_DB_PASSWORD || 'syzoj',
    database: process.env.SYZOJ_WEB_DB_DATABASE || 'syzoj',
    charset: 'utf8mb4'
  });
  const created = [];
  let imageAssetCount = 0;
  let assetsPrepared = false;
  await db.beginTransaction();
  try {
    const titles = manifest.problems.map(problem => problem.title);
    const placeholders = titles.map(() => '?').join(',');
    const [duplicates] = await db.execute(`SELECT id,title FROM problem WHERE title IN (${placeholders})`, titles);
    if (duplicates.length) throw new Error(`Refusing to overwrite existing problems: ${duplicates.map(row => `#${row.id} ${row.title}`).join(', ')}`);

    await db.execute(
      `INSERT INTO problem_tag (name,color,category) VALUES (?,?,'source')
       ON DUPLICATE KEY UPDATE color=VALUES(color),category=VALUES(category)`,
      [manifest.tag, 'pink']
    );
    const [[tag]] = await db.execute('SELECT id FROM problem_tag WHERE name=?', [manifest.tag]);

    await fs.rm(publicAssetRoot, { recursive: true, force: true });
    await fs.mkdir(path.dirname(publicAssetRoot), { recursive: true });
    await fs.cp(path.join(sourceRoot, '.assets'), publicAssetRoot, { recursive: true });
    assetsPrepared = true;
    imageAssetCount = await registerImageAssets(db);

    for (const item of manifest.problems) {
      const metadata = JSON.parse(await fs.readFile(path.join(sourceRoot, item.slug, 'problem.json'), 'utf8'));
      const content = orderedContent(metadata);
      const [result] = await db.execute(
        `INSERT INTO problem
          (title,user_id,publicizer_id,is_anonymous,description,input_format,output_format,example,limit_and_hint,
           time_limit,python_time_limit_multiplier,memory_limit,ac_num,submit_num,is_public,file_io,
           file_io_input_name,file_io_output_name,publicize_time,type,vjudge_config)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, NULL, ?, ?)`,
        [content.title, actorId, metadata.is_anonymous ? 1 : 0, content.description, content.input_format,
          content.output_format, content.example, content.limit_and_hint, content.time_limit,
          content.python_time_limit_multiplier, content.memory_limit, content.file_io ? 1 : 0,
          content.file_io_input_name, content.file_io_output_name, content.type, content.vjudge_config]
      );
      const problemId = Number(result.insertId);
      const serialized = JSON.stringify(content);
      const [version] = await db.execute(
        `INSERT INTO problem_v2_version
          (problem_id,version_number,parent_version_id,status,content_json,content_hash,created_by,created_at)
         VALUES (?,1,NULL,'draft',?,?,?,UTC_TIMESTAMP(3))`,
        [problemId, serialized, contentHash(content), actorId]
      );
      await db.execute(
        `INSERT INTO problem_v2_state
          (problem_id,lifecycle_status,current_version_id,current_snapshot_id,archived_at,updated_at)
         VALUES (?,'draft',?,NULL,NULL,UTC_TIMESTAMP(3))`,
        [problemId, version.insertId]
      );
      await db.execute('INSERT INTO problem_tag_map (problem_id,tag_id) VALUES (?,?)', [problemId, tag.id]);

      const destination = path.join(uploadRoot, 'testdata', String(problemId));
      await fs.rm(destination, { recursive: true, force: true });
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.cp(path.join(sourceRoot, item.slug, 'testdata'), destination, { recursive: true });
      await fs.rm(path.join(uploadRoot, 'testdata-archive', `${problemId}.zip`), { force: true });
      created.push({ id: problemId, ...item });
    }
    await db.commit();
  } catch (error) {
    await db.rollback();
    for (const problem of created) await fs.rm(path.join(uploadRoot, 'testdata', String(problem.id)), { recursive: true, force: true });
    if (assetsPrepared) await fs.rm(publicAssetRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await db.end();
  }
    console.log(JSON.stringify({ tag: manifest.tag, image_assets: imageAssetCount, created }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
