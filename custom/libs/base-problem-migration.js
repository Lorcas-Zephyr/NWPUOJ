'use strict';

const crypto = require('crypto');
const fs = require('fs-extra');
const TypeORM = require('typeorm');
const base = require('./base-workspace');
const domain = require('./problem-domain');
const snapshots = require('./testdata-snapshot');
const path = require('path');
const { replaceDirectory } = require('./testdata-upload');

function failure(message, code = 'BASE_MIGRATION_FAILED', statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}

// One independent copy per source. The source row lock serializes retries and
// concurrent administrators, regardless of their HTTP idempotency keys.
async function migrate(problemId, actor, req) {
  if (!base.isAdmin(actor)) throw failure('只有站长或全站管理员可以迁移题目。', 'BASE_ADMIN_REQUIRED', 403);
  if (!Number.isSafeInteger(Number(problemId)) || Number(problemId) < 1) throw failure('无效的题目编号。', 'VALIDATION_FAILED', 422);
  await base.ensureSchema();
  await syzoj.utils.problemV2.ensureSchema();
  await syzoj.utils.apiV2.ensureFoundationSchema();
  // Initialize audits outside the copy transaction, so DDL can never commit it.
  if (syzoj.utils.authorizationV2.ensureSchema) await syzoj.utils.authorizationV2.ensureSchema();
  const Problem = syzoj.model('problem');
  const uploadDirectory = syzoj.config.upload_dir;
  const snapshotId = `ps_${crypto.randomUUID().replace(/-/g, '')}`;
  let testdata, copiedDirectory;
  try {
    const result = await TypeORM.getConnection().transaction(async manager => {
      const scopes = await manager.query('SELECT problem_id FROM base_workspace_problem WHERE problem_id=? FOR UPDATE', [Number(problemId)]);
      if (!scopes.length) throw failure('只能迁移基地内的题目。', 'BASE_PROBLEM_REQUIRED', 422);
      const existing = (await base.migrationStates([Number(problemId)], manager)).get(Number(problemId));
      if (existing) return { source_problem_id: Number(problemId), problem_id: existing.problem_id, skipped: true };
      const states = await manager.query('SELECT * FROM problem_v2_state WHERE problem_id=? FOR UPDATE', [Number(problemId)]);
      const state = states[0];
      const rows = await manager.query('SELECT * FROM problem WHERE id=? FOR UPDATE', [Number(problemId)]);
      const source = rows[0];
      if (!source || state && state.lifecycle_status === 'archived') throw failure('基地题目不存在或已归档。', 'PROBLEM_NOT_FOUND', 404);
      const owners = await manager.query('SELECT id FROM user WHERE id=? LIMIT 1', [source.user_id]);
      if (!owners.length) throw failure('原上传者账户已删除，不能将题目署名给操作管理员。');
      const versions = state && state.current_version_id
        ? await manager.query('SELECT content_json FROM problem_v2_version WHERE id=? AND problem_id=?', [state.current_version_id, source.id]) : [];
      const content = versions.length ? domain.parseStoredContent(versions[0].content_json) : domain.problemContent(source);
      const errors = domain.validateContent(content);
      if (Object.keys(errors).length) throw failure('题目内容或评测设置无效，请先修正后迁移。', 'VALIDATION_FAILED', 422);
      const currentSnapshots = state && state.current_snapshot_id ? await manager.query('SELECT testdata_path,testdata_hash FROM problem_v2_snapshot WHERE id=? AND problem_id=?', [state.current_snapshot_id, source.id]) : [];
      const currentData = currentSnapshots[0];
      if (currentData && currentData.testdata_path) {
        const match = /^snapshots\/(ps_[A-Za-z0-9_-]{8,100})$/.exec(String(currentData.testdata_path));
        if (!match) throw failure('原题评测数据快照路径无效。');
        const directory = snapshots.snapshotDirectory(uploadDirectory, match[1]);
        const manifest = await snapshots.manifest(directory);
        if (manifest.hash !== currentData.testdata_hash) throw failure('原题评测数据快照校验失败。');
        testdata = await snapshots.captureFromDirectory(uploadDirectory, directory, snapshotId);
      } else testdata = await snapshots.capture(uploadDirectory, source.id, snapshotId);
      const created = await domain.createProblemAggregate(manager, Problem, content, Number(source.user_id), { isAnonymous: false });
      const destination = snapshots.currentTestdataPath(uploadDirectory, created.problem.id);
      if (await fs.pathExists(destination)) throw failure('新题目的数据目录已存在，未覆盖，请联系管理员。');
      copiedDirectory = destination;
      // Copy from an immutable, verified snapshot rather than sharing mutable
      // testdata directories with the base source problem.
      await fs.copy(snapshots.snapshotDirectory(uploadDirectory, snapshotId), copiedDirectory, { overwrite: false, errorOnExist: true, dereference: false });
      const copied = await snapshots.manifest(copiedDirectory);
      if (copied.hash !== testdata.hash) throw failure('复制的数据校验失败，请重试。');
      if (source.additional_file_id) {
        const file = await syzoj.model('file').findById(source.additional_file_id);
        if (!file || !await fs.pathExists(file.getPath())) throw failure('原题附加文件缺失，请修复后重试。');
        // File storage is content-addressed and immutable; retain the reference.
        await manager.query('UPDATE problem SET additional_file_id=? WHERE id=?', [source.additional_file_id, created.problem.id]);
      }
      await manager.query('INSERT INTO problem_tag_map (problem_id,tag_id) SELECT ?,tag_id FROM problem_tag_map WHERE problem_id=?', [created.problem.id, source.id]);
      await domain.syncSourceProjection(manager, created.problem);
      // Base visibility never implies publication in the official catalog.
      // Keep the newly created private draft and attach its complete judge
      // snapshot so an administrator can review and publish it separately.
      await manager.query(`INSERT INTO problem_v2_snapshot
        (id,problem_id,version_id,content_hash,content_json,provider_config,testdata_hash,testdata_path,created_by,created_at)
        VALUES (?,?,?,?,?,NULL,?,?,?,UTC_TIMESTAMP(3))`, [snapshotId, created.problem.id, created.version.id, domain.contentHash(content), domain.serializeContent(content), testdata.hash, testdata.path, actor.id]);
      await manager.query('UPDATE problem_v2_state SET current_snapshot_id=? WHERE problem_id=?', [snapshotId, created.problem.id]);
      await manager.query(`INSERT INTO base_workspace_problem_migration (source_problem_id,target_problem_id,target_version_id,migrated_by,migrated_at)
        VALUES (?,?,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE target_problem_id=VALUES(target_problem_id),target_version_id=VALUES(target_version_id),migrated_by=VALUES(migrated_by),migrated_at=VALUES(migrated_at)`, [source.id, created.problem.id, created.version.id, actor.id]);
      const value = { source_problem_id: Number(source.id), problem_id: Number(created.problem.id), owner_id: Number(source.user_id), visibility: 'private', skipped: false };
      await syzoj.utils.authorizationV2.recordAudit(req, { action: 'base:problem.migrate', resourceType: 'problem', resourceId: source.id, details: value }, manager);
      await manager.query('INSERT INTO api_v2_event (stream,type,aggregate_id,actor_id,payload_json,created_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))', [`problem:${created.problem.id}`, 'problem.created', String(created.problem.id), actor.id, JSON.stringify({ problem_id: created.problem.id, migrated: true })]);
      return value;
    });
    return result;
  } catch (error) {
    // Remove only this attempt's newly allocated artifacts, never source data.
    if (copiedDirectory) await fs.remove(copiedDirectory).catch(() => {});
    if (testdata && testdata.created) await snapshots.remove(uploadDirectory, snapshotId).catch(() => {});
    throw error;
  }
}

function sourceFingerprint(source, content, snapshot, tags) {
  return crypto.createHash('sha256').update(JSON.stringify([
    domain.contentHash(content), snapshot && snapshot.testdata_hash || null,
    source.additional_file_id || null, tags.map(tag => Number(tag.tag_id)).sort((a, b) => a - b)
  ])).digest('hex');
}

function dataDirectory(uploadDirectory, snapshot) {
  const match = /^snapshots\/(ps_[A-Za-z0-9_-]{8,100})$/.exec(String(snapshot && snapshot.testdata_path || ''));
  if (!match) throw failure('原题评测数据快照路径无效。');
  return snapshots.snapshotDirectory(uploadDirectory, match[1]);
}

// Reconcile only a server-owned migration relationship. No caller may choose a
// destination. This is deliberately one-way; publishing/hiding/archiving and
// the official problem's identity, attribution and submission history stay put.
async function synchronize(problemId) {
  const sourceId = Number(problemId);
  if (!Number.isSafeInteger(sourceId) || sourceId < 1) throw failure('无效的题目编号。');
  const db = TypeORM.getConnection();
  const uploadDirectory = syzoj.config.upload_dir;
  let captured, staging, backup, destination, archive, archiveBackup, switched = false, committed = false;
  try {
    const result = await db.transaction(async manager => {
      const scopes = await manager.query('SELECT problem_id FROM base_workspace_problem WHERE problem_id=? FOR UPDATE', [sourceId]);
      if (!scopes.length) return { skipped: true };
      const mappings = await manager.query('SELECT * FROM base_workspace_problem_migration WHERE source_problem_id=? FOR UPDATE', [sourceId]);
      const mapping = mappings[0];
      if (!mapping || Number(mapping.target_problem_id) === sourceId) return { skipped: true };
      const targetId = Number(mapping.target_problem_id);
      const active = (await base.migrationStates([sourceId], manager)).get(sourceId);
      if (!active || active.problem_id !== targetId) return { skipped: true };
      // An upload activates its immutable snapshot before swapping the live
      // directory. Never propagate a snapshot from a still-running upload.
      const jobs = await manager.query("SELECT id FROM problem_v2_job WHERE problem_id IN (?) AND kind='upload' AND state IN ('queued','running','cancelling') LIMIT 1", [[sourceId, targetId]]);
      if (jobs.length) return { skipped: true, pending_upload: true };
      const states = await manager.query('SELECT * FROM problem_v2_state WHERE problem_id IN (?) ORDER BY problem_id FOR UPDATE', [[sourceId, targetId]]);
      const sourceState = states.find(row => Number(row.problem_id) === sourceId);
      const targetState = states.find(row => Number(row.problem_id) === targetId);
      if (!sourceState || !targetState || [sourceState, targetState].some(row => row.lifecycle_status === 'archived')) return { skipped: true };
      const problems = await manager.query('SELECT * FROM problem WHERE id IN (?) ORDER BY id FOR UPDATE', [[sourceId, targetId]]);
      const source = problems.find(row => Number(row.id) === sourceId), target = problems.find(row => Number(row.id) === targetId);
      if (!source || !target) return { skipped: true };
      const versions = await manager.query('SELECT * FROM problem_v2_version WHERE id=? AND problem_id=?', [sourceState.current_version_id, sourceId]);
      const content = versions.length ? domain.parseStoredContent(versions[0].content_json) : domain.problemContent(source);
      if (Object.keys(domain.validateContent(content)).length) throw failure('基地原题的内容或评测配置不支持同步。');
      const sourceSnapshots = await manager.query('SELECT * FROM problem_v2_snapshot WHERE id=? AND problem_id=?', [sourceState.current_snapshot_id, sourceId]);
      let sourceSnapshot = sourceSnapshots[0];
      let sourceDirectory;
      if (sourceSnapshot) {
        sourceDirectory = dataDirectory(uploadDirectory, sourceSnapshot);
      } else {
        // Unpublished legacy base drafts may have been migrated before their
        // first snapshot. Validate any live data before using this fallback.
        sourceDirectory = snapshots.currentTestdataPath(uploadDirectory, sourceId);
        const manifest = await snapshots.manifest(sourceDirectory, { allowMissing: true });
        if (manifest.files.length) {
          const parsed = await syzoj.utils.parseTestdata(sourceDirectory, content.type === 'submit-answer');
          const subtasks = Array.isArray(parsed) ? parsed : parsed && parsed.testcases;
          if (!parsed || parsed.error || !Array.isArray(subtasks) || !subtasks.some(task => task.cases && task.cases.length)) throw failure('基地原题的测试数据无效，请重新上传。');
        }
        sourceSnapshot = { testdata_hash: manifest.hash };
      }
      const tags = await manager.query('SELECT tag_id FROM problem_tag_map WHERE problem_id=? ORDER BY tag_id FOR UPDATE', [sourceId]);
      const fingerprint = sourceFingerprint(source, content, sourceSnapshot, tags);
      const markers = await manager.query('SELECT * FROM base_workspace_problem_sync WHERE source_problem_id=? FOR UPDATE', [sourceId]);
      const marker = markers[0];
      if (marker && Number(marker.target_problem_id) === targetId && marker.source_fingerprint === fingerprint) {
        return { skipped: true, problem_id: targetId, retry_effects: !!marker.last_error };
      }
      if ((await snapshots.manifest(sourceDirectory, { allowMissing: !sourceSnapshots.length })).hash !== sourceSnapshot.testdata_hash) throw failure('基地原题的评测数据快照校验失败。');
      if (source.additional_file_id) {
        const file = await syzoj.model('file').findById(source.additional_file_id);
        if (!file || !await fs.pathExists(file.getPath())) throw failure('基地原题的附加文件缺失。');
      }
      const hash = domain.contentHash(content);
      const currentSnapshots = await manager.query('SELECT * FROM problem_v2_snapshot WHERE id=? AND problem_id=?', [targetState.current_snapshot_id, targetId]);
      const currentSnapshot = currentSnapshots[0];
      const dataChanged = !currentSnapshot || currentSnapshot.testdata_hash !== sourceSnapshot.testdata_hash;
      const existing = await manager.query('SELECT * FROM problem_v2_snapshot WHERE problem_id=? AND content_hash=? AND testdata_hash <=> ? LIMIT 1', [targetId, hash, sourceSnapshot.testdata_hash]);
      const snapshotId = existing.length ? existing[0].id : `ps_${crypto.randomUUID().replace(/-/g, '')}`;
      let snapshot = existing[0];
      if (!snapshot) {
        if (!dataChanged && currentSnapshot.testdata_path) {
          // Statement/tag/config edits reuse the target's own immutable data;
          // do not copy multi-gigabyte archives just to change a title.
          snapshot = { id: snapshotId, testdata_path: currentSnapshot.testdata_path, testdata_hash: currentSnapshot.testdata_hash };
        } else {
          captured = await snapshots.captureFromDirectory(uploadDirectory, sourceDirectory, snapshotId);
          if (captured.hash !== sourceSnapshot.testdata_hash) throw failure('复制的数据校验失败。');
          snapshot = { id: snapshotId, testdata_path: captured.path, testdata_hash: captured.hash };
        }
      }
      const targetDirectory = dataDirectory(uploadDirectory, snapshot);
      if ((await snapshots.manifest(targetDirectory)).hash !== sourceSnapshot.testdata_hash) throw failure('正式题目的评测快照校验失败。');
      const actorId = Number(versions[0] && versions[0].created_by || source.user_id);
      const version = await domain.insertVersion(manager, targetId, content, actorId, target.is_public ? 'published' : 'draft', targetState.current_version_id);
      if (!existing.length) await manager.query(`INSERT INTO problem_v2_snapshot
        (id,problem_id,version_id,content_hash,content_json,provider_config,testdata_hash,testdata_path,created_by,created_at)
        VALUES (?,?,?,?,?,NULL,?,?,?,UTC_TIMESTAMP(3))`, [snapshotId, targetId, version.id, hash, domain.serializeContent(content), snapshot.testdata_hash, snapshot.testdata_path, actorId]);
      if (target.is_public) await manager.query("UPDATE problem_v2_version SET published_at=UTC_TIMESTAMP(3),review_feedback='Synchronized from base problem' WHERE id=?", [version.id]);
      // Do not call publishProblemAggregate: it would publish private targets
      // and rewrite publication attribution/time on already public targets.
      await manager.query(`UPDATE problem SET ${domain.EDITABLE_FIELDS.map(field => `${field}=?`).join(',')},additional_file_id=? WHERE id=?`,
        domain.EDITABLE_FIELDS.map(field => content[field]).concat([source.additional_file_id || null, targetId]));
      await manager.query('UPDATE problem_v2_state SET current_version_id=?,current_snapshot_id=?,updated_at=UTC_TIMESTAMP(3) WHERE problem_id=?', [version.id, snapshotId, targetId]);
      await manager.query('DELETE FROM problem_tag_map WHERE problem_id=?', [targetId]);
      await manager.query('INSERT INTO problem_tag_map (problem_id,tag_id) SELECT ?,tag_id FROM problem_tag_map WHERE problem_id=?', [targetId, sourceId]);
      destination = snapshots.currentTestdataPath(uploadDirectory, targetId);
      if (dataChanged || !await fs.pathExists(destination)) {
        const suffix = crypto.randomUUID();
        staging = `${destination}.base-sync-${suffix}`;
        backup = `${destination}.base-backup-${suffix}`;
        // Independent data, including data.yml, checker and interactor. Historical
        // snapshots referenced by prior submissions are never rewritten/removed.
        await fs.copy(targetDirectory, staging, { overwrite: false, errorOnExist: true, dereference: false });
        if ((await snapshots.manifest(staging)).hash !== snapshot.testdata_hash) throw failure('同步数据目录校验失败。');
        await replaceDirectory(destination, staging, backup, { keepBackup: true });
        switched = true;
        archive = path.join(uploadDirectory, 'testdata-archive', `${targetId}.zip`);
        archiveBackup = `${archive}.base-backup-${suffix}`;
        if (await fs.pathExists(archive)) await fs.move(archive, archiveBackup, { overwrite: false });
        // Removing the stale derived ZIP lets the normal download path rebuild it.
      }
      await manager.query(`INSERT INTO base_workspace_problem_sync
        (source_problem_id,target_problem_id,source_fingerprint,synced_at,last_error,attempted_at)
        VALUES (?,?,?,UTC_TIMESTAMP(3),'同步已提交，等待刷新缓存。',UTC_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE target_problem_id=VALUES(target_problem_id),source_fingerprint=VALUES(source_fingerprint),synced_at=UTC_TIMESTAMP(3),last_error=VALUES(last_error),attempted_at=UTC_TIMESTAMP(3)`, [sourceId, targetId, fingerprint]);
      await manager.query('INSERT INTO api_v2_event (stream,type,aggregate_id,actor_id,payload_json,created_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))',
        [`problem:${targetId}`, 'problem.base-synchronized', String(targetId), actorId, JSON.stringify({ source_problem_id: sourceId, version_id: version.id, snapshot_id: snapshotId })]);
      return { source_problem_id: sourceId, problem_id: targetId, snapshot_id: snapshotId, skipped: false };
    });
    committed = true;
    if (result.problem_id && (!result.skipped || result.retry_effects)) {
      await syzoj.model('problem').deleteFromCache(result.problem_id);
      if (syzoj.utils.contestV2) await syzoj.utils.contestV2.syncProblemSnapshotsForProblem(result.problem_id);
      await db.query('UPDATE base_workspace_problem_sync SET last_error=NULL WHERE source_problem_id=?', [sourceId]);
    }
    return result;
  } catch (error) {
    if (!committed) {
      if (switched) {
        await fs.remove(destination);
        if (await fs.pathExists(backup)) await fs.move(backup, destination, { overwrite: false });
      }
      if (archiveBackup && await fs.pathExists(archiveBackup)) await fs.move(archiveBackup, archive, { overwrite: true });
      if (captured && captured.created) await snapshots.remove(uploadDirectory, captured.id);
    }
    throw error;
  } finally {
    if (staging) await fs.remove(staging).catch(() => {});
    // On failed rollback keep the backup for recovery rather than deleting it.
    if (committed && backup) await fs.remove(backup).catch(() => {});
    if (committed && archiveBackup) await fs.remove(archiveBackup).catch(() => {});
  }
}

let syncRunning = false, syncTimer;
const observedSources = new Map();
const reportedErrors = new Map();
async function synchronizeAll() {
  if (syncRunning) return;
  syncRunning = true;
  try {
    await base.ensureSchema();
    await syzoj.utils.problemV2.ensureSchema();
    await syzoj.utils.problemWorkflowV2.ensureSchema();
    await syzoj.utils.apiV2.ensureFoundationSchema();
    const db = TypeORM.getConnection();
    // One small metadata read per tick. Stable sources do not acquire row locks
    // or hash/copy files. Durable fingerprints remain the authority on restart.
    const mappings = await db.query(`SELECT m.source_problem_id,m.target_problem_id,
        s.current_version_id,s.current_snapshot_id,s.lifecycle_status,source.additional_file_id,
        target.lifecycle_status AS target_lifecycle_status,q.last_error,
        (SELECT GROUP_CONCAT(tag_id ORDER BY tag_id) FROM problem_tag_map tags WHERE tags.problem_id=source.id) AS tags
      FROM base_workspace_problem_migration m
      JOIN base_workspace_problem b ON b.problem_id=m.source_problem_id
      JOIN problem source ON source.id=m.source_problem_id
      LEFT JOIN problem_v2_state s ON s.problem_id=source.id
      LEFT JOIN problem_v2_state target ON target.problem_id=m.target_problem_id
      LEFT JOIN base_workspace_problem_sync q ON q.source_problem_id=m.source_problem_id
      JOIN problem p ON p.id=m.target_problem_id ORDER BY m.source_problem_id`);
    const results = [];
    for (const mapping of mappings) {
      const signature = JSON.stringify(mapping);
      if (!mapping.last_error && observedSources.get(mapping.source_problem_id) === signature) continue;
      try {
        const result = await synchronize(mapping.source_problem_id);
        results.push(result);
        if (!result.pending_upload) observedSources.set(mapping.source_problem_id, signature);
        reportedErrors.delete(mapping.source_problem_id);
      }
      catch (error) {
        observedSources.delete(mapping.source_problem_id);
        const message = String(error.message || error).slice(0, 2000);
        await db.query(`INSERT INTO base_workspace_problem_sync (source_problem_id,target_problem_id,last_error,attempted_at)
          VALUES (?,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE last_error=VALUES(last_error),attempted_at=UTC_TIMESTAMP(3)`,
          [mapping.source_problem_id, mapping.target_problem_id, message]);
        if (reportedErrors.get(mapping.source_problem_id) !== message) syzoj.log(`[base-sync] problem ${mapping.source_problem_id} -> ${mapping.target_problem_id}: ${message}`);
        reportedErrors.set(mapping.source_problem_id, message);
        results.push({ source_problem_id: Number(mapping.source_problem_id), failed: true });
      }
    }
    return results;
  } finally { syncRunning = false; }
}

function startSyncWorker() {
  if (syncTimer) return;
  // Persistent fingerprints make this restart-safe and cover all edit routes,
  // including tag-only changes, legacy adapters and background ZIP jobs.
  const tick = async () => {
    try { await synchronizeAll(); }
    catch (error) { syzoj.log(`[base-sync] ${error.message || error}`); }
    syncTimer = setTimeout(tick, 5000);
    syncTimer.unref();
  };
  syncTimer = setTimeout(tick, 5000);
  syncTimer.unref();
}

module.exports = { migrate, synchronize, synchronizeAll, startSyncWorker, sourceFingerprint };
