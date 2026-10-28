'use strict';

// Explicit maintenance command, never executed during application startup.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const snapshot = require('./luogu-2026-09-30.json');
const COLORS = Object.freeze({ category: 'teal', algorithm: 'violet' });

function cleanName(name) {
  return String(name || '').normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
}

function nameKey(name) {
  return cleanName(name).normalize('NFKD').replace(/\p{M}/gu, '').replace(/\s+/g, '').toLowerCase();
}

function buildCatalog(data = snapshot) {
  if (data.source_type !== 2 || !Array.isArray(data.tags) || !data.tags.length) throw new Error('Invalid algorithm snapshot');
  const ids = new Map(), names = new Set();
  for (const tag of data.tags) {
    const name = cleanName(tag.name), key = nameKey(name);
    if (!Number.isSafeInteger(tag.id) || !name || name.length > 255 || names.has(key) || ids.has(tag.id)) {
      throw new Error('Duplicate or invalid algorithm tag: ' + name);
    }
    ids.set(tag.id, tag); names.add(key);
  }
  for (const tag of data.tags) {
    const ancestors = new Set([tag.id]);
    let parent = tag.parent;
    while (parent !== null) {
      if (!ids.has(parent) || ancestors.has(parent)) throw new Error('Invalid algorithm parent: ' + tag.name);
      ancestors.add(parent); parent = ids.get(parent).parent;
    }
  }
  return data.tags.map(tag => {
    const category = tag.parent === null ? 'category' : 'algorithm';
    return { name: cleanName(tag.name), category, color: COLORS[category], source_id: tag.id, source_parent_id: tag.parent };
  });
}

function planCatalog(existing, catalog = buildCatalog()) {
  const byName = new Map();
  for (const tag of existing) {
    const key = nameKey(tag.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(tag);
  }
  const added = [], reused = [], conflicts = [];
  for (const tag of catalog) {
    const matches = byName.get(nameKey(tag.name)) || [];
    if (!matches.length) added.push(tag);
    else if (matches.length !== 1 || !Object.hasOwn(COLORS, matches[0].category)) conflicts.push({ name: tag.name, existing: matches });
    else reused.push({ ...tag, id: Number(matches[0].id), existing_name: matches[0].name });
  }
  return { added, reused, conflicts };
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function main(args = process.argv.slice(2)) {
  const apply = args.includes('--apply');
  const actorArgument = args.find(arg => arg.startsWith('--actor-id='));
  const backupArgument = args.find(arg => arg.startsWith('--backup-dir='));
  const known = arg => arg === '--apply' || arg === '--dry-run' || arg.startsWith('--actor-id=') || arg.startsWith('--backup-dir=');
  if (args.some(arg => !known(arg)) || (apply && args.includes('--dry-run'))) throw new Error('Unsupported arguments');
  const actorId = actorArgument ? Number(actorArgument.slice('--actor-id='.length)) : null;
  if (apply && (!Number.isSafeInteger(actorId) || actorId < 1 || !backupArgument)) {
    throw new Error('--apply requires --actor-id=<administrator ID> and --backup-dir=<directory>');
  }
  const catalog = buildCatalog();
  const mysql = require(require.resolve('mysql2/promise', { paths: [process.cwd(), '/app', __dirname] }));
  const connection = await mysql.createConnection({
    host: process.env.SYZOJ_WEB_DB_HOST,
    user: process.env.SYZOJ_WEB_DB_USERNAME,
    password: process.env.SYZOJ_WEB_DB_PASSWORD,
    database: process.env.SYZOJ_WEB_DB_DATABASE,
    charset: 'utf8mb4'
  });
  let locked = false, transaction = false;
  try {
    const [lock] = await connection.query("SELECT GET_LOCK('nwpuoj:algorithm-tag-seed',10) AS acquired");
    if (Number(lock[0].acquired) !== 1) throw new Error('Another algorithm tag import is running');
    locked = true;
    await connection.beginTransaction(); transaction = true;
    const [before] = await connection.query('SELECT id,name,color,category FROM problem_tag ORDER BY id' + (apply ? ' FOR UPDATE' : ''));
    const plan = planCatalog(before, catalog);
    if (plan.conflicts.length) throw new Error('Conflicting existing tag names; nothing changed: ' + JSON.stringify(plan.conflicts));
    const summary = {
      mode: apply ? 'apply' : 'dry-run', source: snapshot.source, retrieved_at: snapshot.retrieved_at,
      source_sha256: digest(snapshot), before_count: before.length, added_count: plan.added.length,
      reused_count: plan.reused.length, category_count: catalog.filter(tag => tag.category === 'category').length,
      algorithm_count: catalog.filter(tag => tag.category === 'algorithm').length
    };
    if (!apply || !plan.added.length) {
      await connection.rollback(); transaction = false;
      console.log(JSON.stringify(summary, null, 2)); return summary;
    }
    const [actors] = await connection.query('SELECT id,is_admin FROM `user` WHERE id=?', [actorId]);
    if (!actors.length || !actors[0].is_admin) throw new Error('The audit actor must be an existing site administrator');
    const [mappings] = await connection.query('SELECT problem_id,tag_id FROM problem_tag_map ORDER BY problem_id,tag_id');
    const backupDir = path.resolve(backupArgument.slice('--backup-dir='.length));
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backupFile = path.join(backupDir, 'before-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
    const backup = { ...summary, actor_id: actorId, mappings_sha256: digest(mappings), tags: before, mappings };
    const fd = fs.openSync(backupFile, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(backup, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const inserted = [];
    for (const tag of plan.added) {
      const [result] = await connection.execute('INSERT INTO problem_tag (name,color,category) VALUES (?,?,?)', [tag.name, tag.color, tag.category]);
      const payload = { id: Number(result.insertId), ...tag, problem_count: 0, source: snapshot.source, source_date: snapshot.retrieved_at };
      inserted.push(payload);
      await connection.execute('INSERT INTO api_v2_event (stream,type,aggregate_id,actor_id,payload_json,created_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))',
        ['problem-tag:' + payload.id, 'problem.tag.created', String(payload.id), actorId, JSON.stringify(payload)]);
    }
    const [after] = await connection.query('SELECT id,name,color,category FROM problem_tag ORDER BY id');
    const existingIds = new Set(before.map(tag => tag.id));
    if (digest(after.filter(tag => existingIds.has(tag.id))) !== digest(before)) throw new Error('Existing tags changed; rolling back');
    const [afterMappings] = await connection.query('SELECT problem_id,tag_id FROM problem_tag_map ORDER BY problem_id,tag_id');
    if (digest(afterMappings) !== digest(mappings)) throw new Error('Existing problem tag mappings changed; rolling back');
    const verify = planCatalog(after, catalog);
    if (verify.added.length || verify.conflicts.length || after.length !== before.length + inserted.length) throw new Error('Catalog verification failed; rolling back');
    await connection.commit(); transaction = false;
    const result = { ...summary, after_count: after.length, existing_tags_unchanged: true, mappings_unchanged: true,
      mapping_count: mappings.length, backup_file: backupFile, inserted_ids: inserted.map(tag => tag.id) };
    // Database audit events retain the exact IDs even if a report cannot be written.
    try { fs.writeFileSync(backupFile.replace(/\.json$/, '-result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { result.report_warning = error.code || 'Unable to write the result file'; }
    console.log(JSON.stringify(result, null, 2)); return result;
  } finally {
    try {
      if (transaction) await connection.rollback();
      if (locked) await connection.query("SELECT RELEASE_LOCK('nwpuoj:algorithm-tag-seed')");
    } finally { await connection.end(); }
  }
}

module.exports = { cleanName, nameKey, buildCatalog, planCatalog, digest, main };
if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
