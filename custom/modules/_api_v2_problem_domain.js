const crypto = require('crypto');
const TypeORM = require('typeorm');
const problemDomain = require('../libs/problem-domain');
const testdataSnapshots = require('../libs/testdata-snapshot');
const {
  archiveProblemAggregate,
  contentFromInput,
  createProblemAggregate,
  diffContent,
  insertVersion,
  parseStoredContent,
  problemContent,
  problemResource,
  publishProblemAggregate,
  reviewDecisionAllowed,
  reviewRequestAllowed,
  syncSourceProjection,
  unpublishProblemAggregate,
  updateProblemAggregate,
  validateContent
} = problemDomain;
let schemaPromise = null;

async function ensureProblemSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const connection = TypeORM.getConnection();
    await connection.query(`
      CREATE TABLE IF NOT EXISTS problem_v2_version (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        problem_id INT NOT NULL,
        version_number INT NOT NULL,
        parent_version_id BIGINT UNSIGNED NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'draft',
        content_json LONGTEXT NOT NULL,
        content_hash CHAR(64) NOT NULL,
        created_by INT NULL,
        reviewed_by INT NULL,
        reviewed_at DATETIME(3) NULL,
        review_feedback TEXT NULL,
        created_at DATETIME(3) NOT NULL,
        published_at DATETIME(3) NULL,
        UNIQUE KEY uq_problem_v2_version_number (problem_id,version_number),
        KEY idx_problem_v2_version_status (problem_id,status,id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const versionColumns = await connection.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='problem_v2_version'");
    if (!versionColumns.some(row => row.COLUMN_NAME === 'reviewed_by')) {
      await connection.query('ALTER TABLE problem_v2_version ADD COLUMN reviewed_by INT NULL AFTER created_by');
    }
    if (!versionColumns.some(row => row.COLUMN_NAME === 'reviewed_at')) {
      await connection.query('ALTER TABLE problem_v2_version ADD COLUMN reviewed_at DATETIME(3) NULL AFTER reviewed_by');
    }
    if (!versionColumns.some(row => row.COLUMN_NAME === 'review_feedback')) {
      await connection.query('ALTER TABLE problem_v2_version ADD COLUMN review_feedback TEXT NULL AFTER reviewed_at');
    }
    await connection.query(`
      CREATE TABLE IF NOT EXISTS problem_v2_snapshot (
        id VARCHAR(80) NOT NULL PRIMARY KEY,
        problem_id INT NOT NULL,
        version_id BIGINT UNSIGNED NOT NULL,
        content_hash CHAR(64) NOT NULL,
        content_json LONGTEXT NOT NULL,
        provider_config VARCHAR(80) NULL,
        testdata_hash CHAR(64) NULL,
        testdata_path VARCHAR(160) NULL,
        created_by INT NULL,
        created_at DATETIME(3) NOT NULL,
        UNIQUE KEY uq_problem_v2_snapshot_hash (problem_id,content_hash,testdata_hash),
        KEY idx_problem_v2_snapshot_version (version_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const snapshotColumns = await connection.query("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='problem_v2_snapshot'");
    if (!snapshotColumns.some(row => row.COLUMN_NAME === 'provider_config')) {
      await connection.query('ALTER TABLE problem_v2_snapshot ADD COLUMN provider_config VARCHAR(80) NULL AFTER content_json');
    }
    if (!snapshotColumns.some(row => row.COLUMN_NAME === 'testdata_hash')) {
      await connection.query('ALTER TABLE problem_v2_snapshot ADD COLUMN testdata_hash CHAR(64) NULL AFTER provider_config');
    }
    if (!snapshotColumns.some(row => row.COLUMN_NAME === 'testdata_path')) {
      await connection.query('ALTER TABLE problem_v2_snapshot ADD COLUMN testdata_path VARCHAR(160) NULL AFTER testdata_hash');
    }
    const snapshotIndexes = await connection.query("SELECT INDEX_NAME,COLUMN_NAME,SEQ_IN_INDEX FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='problem_v2_snapshot' AND INDEX_NAME='uq_problem_v2_snapshot_hash' ORDER BY SEQ_IN_INDEX");
    if (snapshotIndexes.map(row => row.COLUMN_NAME).join(',') !== 'problem_id,content_hash,testdata_hash') {
      if (snapshotIndexes.length) await connection.query('ALTER TABLE problem_v2_snapshot DROP INDEX uq_problem_v2_snapshot_hash');
      await connection.query('ALTER TABLE problem_v2_snapshot ADD UNIQUE KEY uq_problem_v2_snapshot_hash (problem_id,content_hash,testdata_hash)');
    }
    await connection.query(`UPDATE problem_v2_snapshot snapshot
      JOIN problem legacy_problem ON legacy_problem.id=snapshot.problem_id
      SET snapshot.provider_config=legacy_problem.vjudge_config
      WHERE snapshot.provider_config IS NULL AND legacy_problem.vjudge_config IS NOT NULL`);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS problem_v2_state (
        problem_id INT NOT NULL PRIMARY KEY,
        lifecycle_status VARCHAR(32) NOT NULL DEFAULT 'draft',
        current_version_id BIGINT UNSIGNED NULL,
        current_snapshot_id VARCHAR(80) NULL,
        archived_at DATETIME(3) NULL,
        updated_at DATETIME(3) NOT NULL,
        KEY idx_problem_v2_state_status (lifecycle_status,problem_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  })().catch(error => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

function serializeProblem(problem, state) {
  return problemDomain.serializeProblem(problem, state, syzoj.utils.apiV2.databaseIso);
}

async function loadState(problemId) {
  await ensureProblemSchema();
  const rows = await TypeORM.getConnection().query('SELECT * FROM problem_v2_state WHERE problem_id=? LIMIT 1', [problemId]);
  return rows[0] || null;
}

function versionRevision(row) {
  return {
    id: String(row.id),
    status: row.status,
    content_hash: row.content_hash,
    reviewed_by: row.reviewed_by == null ? null : Number(row.reviewed_by),
    reviewed_at: syzoj.utils.apiV2.databaseIso(row.reviewed_at),
    published_at: syzoj.utils.apiV2.databaseIso(row.published_at)
  };
}

function versionSummary(row) {
  const api = syzoj.utils.apiV2;
  return {
    id: String(row.id),
    problem_id: Number(row.problem_id),
    version_number: Number(row.version_number),
    parent_version_id: row.parent_version_id == null ? null : String(row.parent_version_id),
    status: row.status,
    content_hash: row.content_hash,
    author: row.created_by == null ? null : { id: Number(row.created_by), username: row.author_username || undefined },
    reviewer: row.reviewed_by == null ? null : { id: Number(row.reviewed_by), username: row.reviewer_username || undefined },
    review_feedback: row.review_feedback || null,
    created_at: api.databaseIso(row.created_at),
    reviewed_at: api.databaseIso(row.reviewed_at),
    published_at: api.databaseIso(row.published_at)
  };
}

async function loadVersionRow(manager, problemId, versionId, lock = false) {
  const rows = await manager.query(
    `SELECT * FROM problem_v2_version WHERE id=? AND problem_id=? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [versionId, problemId]
  );
  return rows[0] || null;
}

async function loadVersionResource(manager, problemId, versionId) {
  const rows = await manager.query(`SELECT problem_version.*,author.username AS author_username,reviewer.username AS reviewer_username
    FROM problem_v2_version problem_version
    LEFT JOIN user author ON author.id=problem_version.created_by
    LEFT JOIN user reviewer ON reviewer.id=problem_version.reviewed_by
    WHERE problem_version.id=? AND problem_version.problem_id=? LIMIT 1`, [versionId, problemId]);
  if (!rows.length) return null;
  const row = rows[0];
  const parentRows = row.parent_version_id == null ? [] : await manager.query(
    'SELECT content_json FROM problem_v2_version WHERE id=? AND problem_id=? LIMIT 1',
    [row.parent_version_id, problemId]
  );
  const content = parseStoredContent(row.content_json);
  const parentContent = parentRows.length ? parseStoredContent(parentRows[0].content_json) : {};
  return { ...versionSummary(row), content, diff: diffContent(parentContent, content), revision: versionRevision(row) };
}

async function canReadDraftVersions(problem, user) {
  if (!user) return false;
  const resource = problemResource(problem);
  return await syzoj.utils.authorizationV2.authorize(user, 'problem:edit', resource, { scope: `problem:${problem.id}` }) ||
    await syzoj.utils.authorizationV2.authorize(user, 'problem:publish', resource, { scope: `problem:${problem.id}` });
}

function needsLocalTestdata(problem) {
  return !String(problem && problem.type || '').startsWith('vjudge:');
}

async function captureTestdataSnapshot(problem, snapshotId) {
  if (!needsLocalTestdata(problem)) return { id: String(snapshotId), path: null, hash: null, files: [], created: false };
  return testdataSnapshots.capture(syzoj.config.upload_dir, problem.id, snapshotId);
}

async function ensureSnapshotTestdata(problem, snapshotId) {
  await ensureProblemSchema();
  const connection = TypeORM.getConnection();
  const rows = await connection.query('SELECT testdata_hash,testdata_path FROM problem_v2_snapshot WHERE id=? AND problem_id=? LIMIT 1', [snapshotId, problem.id]);
  if (!rows.length) return null;
  if (!needsLocalTestdata(problem) || rows[0].testdata_hash && rows[0].testdata_path) return rows[0];
  const testdata = await captureTestdataSnapshot(problem, snapshotId);
  await connection.query('UPDATE problem_v2_snapshot SET testdata_hash=?,testdata_path=? WHERE id=? AND problem_id=?', [testdata.hash, testdata.path, snapshotId, problem.id]);
  return { testdata_hash: testdata.hash, testdata_path: testdata.path };
}

function problemVersionError(code, message, statusCode, fields = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.fields = fields;
  return error;
}

function sendProblemVersionError(api, res, error) {
  if (!error || !error.code || !error.statusCode) return false;
  api.fail(res, error.statusCode, error.code, error.message, error.fields);
  return true;
}

async function loadProblem(req, res, requireRead = true) {
  const Problem = syzoj.model('problem');
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const problem = await Problem.findById(id);
  if (!problem) return null;
  if (requireRead && !await canReadProblem(problem, res.locals.user)) return false;
  return problem;
}

async function canReadProblem(problem, user) {
  if (problem.is_public) return true;
  if (!user) return false;
  return syzoj.utils.authorizationV2.authorize(
    user,
    'problem:read',
    problemResource(problem),
    { scope: `problem:${problem.id}` }
  );
}

async function ensureCurrentSnapshot(problem, actorId) {
  await ensureProblemSchema();
  const existing = await loadState(problem.id);
  if (existing && existing.current_snapshot_id) {
    await ensureSnapshotTestdata(problem, existing.current_snapshot_id);
    return existing.current_snapshot_id;
  }
  return TypeORM.getConnection().transaction(async manager => {
    const lockedStates = await manager.query('SELECT * FROM problem_v2_state WHERE problem_id=? FOR UPDATE', [problem.id]);
    if (lockedStates[0] && lockedStates[0].current_snapshot_id) return lockedStates[0].current_snapshot_id;
    let versionRows = lockedStates[0] && lockedStates[0].current_version_id
      ? await manager.query('SELECT * FROM problem_v2_version WHERE id=? LIMIT 1', [lockedStates[0].current_version_id])
      : [];
    if (!versionRows.length) {
      const created = await insertVersion(manager, problem.id, problemContent(problem), actorId, problem.is_public ? 'published' : 'draft');
      if (problem.is_public) {
        await manager.query(
          `UPDATE problem_v2_version
              SET published_at=COALESCE(?,UTC_TIMESTAMP(3)),reviewed_by=?,
                  reviewed_at=COALESCE(?,UTC_TIMESTAMP(3)),review_feedback='Imported from legacy published problem'
            WHERE id=? AND problem_id=?`,
          [problem.publicize_time || null, problem.publicizer_id || null, problem.publicize_time || null, created.id, problem.id]
        );
      }
      versionRows = await manager.query('SELECT * FROM problem_v2_version WHERE id=? LIMIT 1', [created.id]);
    }
    const version = versionRows[0];
    const currentTestdata = needsLocalTestdata(problem)
      ? await testdataSnapshots.manifest(testdataSnapshots.currentTestdataPath(syzoj.config.upload_dir, problem.id), { allowMissing: true })
      : { hash: null };
    let snapshotRows = await manager.query(
      'SELECT id FROM problem_v2_snapshot WHERE problem_id=? AND content_hash=? AND testdata_hash <=> ? LIMIT 1',
      [problem.id, version.content_hash, currentTestdata.hash]
    );
    if (!snapshotRows.length) {
      const snapshotId = `ps_${crypto.randomUUID().replace(/-/g, '')}`;
      const testdata = await captureTestdataSnapshot(problem, snapshotId);
      await manager.query(
        'INSERT INTO problem_v2_snapshot (id,problem_id,version_id,content_hash,content_json,provider_config,testdata_hash,testdata_path,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))',
        [snapshotId, problem.id, version.id, version.content_hash, version.content_json, problem.vjudge_config || null, testdata.hash, testdata.path, actorId]
      );
      snapshotRows = [{ id: snapshotId }];
    }
    await manager.query(
      `INSERT INTO problem_v2_state (problem_id,lifecycle_status,current_version_id,current_snapshot_id,archived_at,updated_at)
       VALUES (?,?,?,?,NULL,UTC_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE current_version_id=VALUES(current_version_id),current_snapshot_id=VALUES(current_snapshot_id),updated_at=UTC_TIMESTAMP(3)`,
      [problem.id, problem.is_public ? 'published' : 'draft', version.id, snapshotRows[0].id]
    );
    return snapshotRows[0].id;
  });
}

syzoj.utils.problemV2 = {
  ensureSchema: ensureProblemSchema,
  ensureCurrentSnapshot,
  ensureSnapshotTestdata,
  loadState,
  serializeProblem,
  problemResource
};

const requireCapability = (capability, loader) => syzoj.utils.authorizationV2.requireScopedCapability(capability, loader);

app.get('/api/v2/problems', async (req, res) => {
  const api = syzoj.utils.apiV2;
  const user = res.locals.user;
  const limit = api.parseLimit(req, 50, 100);
  let scanCursor = Number(api.decodeCursor(req.query.cursor) || 0);
  const keyword = String(req.query.query || '').trim().slice(0, 80);
  if (!Number.isSafeInteger(scanCursor) || scanCursor < 0) scanCursor = 0;
  await ensureProblemSchema();
  const visible = [];
  const batchSize = Math.max(limit + 1, 100);
  let exhausted = false;

  while (visible.length <= limit && !exhausted) {
    const params = [scanCursor];
    if (keyword) params.push(`%${keyword}%`, Number(keyword) || -1);
    params.push(batchSize);
    const rows = await TypeORM.getConnection().query(
      `SELECT problem.*,state.lifecycle_status,state.current_version_id,state.current_snapshot_id
         FROM problem LEFT JOIN problem_v2_state state ON state.problem_id=problem.id
        WHERE problem.id>? ${keyword ? 'AND (problem.title LIKE ? OR problem.id=?)' : ''}
          AND COALESCE(state.lifecycle_status,'draft')<>'archived'
        ORDER BY problem.id ASC LIMIT ?`,
      params
    );
    if (!rows.length) break;
    scanCursor = Number(rows[rows.length - 1].id);
    exhausted = rows.length < batchSize;
    for (const row of rows) {
      if (await canReadProblem(row, user)) visible.push(row);
      if (visible.length > limit) break;
    }
  }

  const hasMore = visible.length > limit;
  const pageRows = visible.slice(0, limit);
  const page = pageRows.map(row => serializeProblem(row, row));
  res.locals.apiMeta.next_cursor = hasMore ? api.encodeCursor(pageRows[pageRows.length - 1].id) : null;
  res.locals.apiMeta.limit = limit;
  return api.send(res, page);
});

app.post('/api/v2/problems', requireCapability('problem:create'), async (req, res) => {
  const api = syzoj.utils.apiV2;
  const Problem = syzoj.model('problem');
  const content = contentFromInput(req.body || {}, { type: 'traditional', time_limit: 1000, memory_limit: 256 });
  const fields = validateContent(content);
  const requestedId = req.body && req.body.id !== '' && req.body.id != null ? Number(req.body.id) : null;
  const tagIds = Array.isArray(req.body && req.body.tag_ids) ? req.body.tag_ids.map(Number) : [];
  if (requestedId != null && (!Number.isSafeInteger(requestedId) || requestedId < 1)) fields.id = 'positive integer required';
  if (tagIds.length > 20 || tagIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(tagIds).size !== tagIds.length) fields.tag_ids = 'up to 20 unique positive integers required';
  if (Object.keys(fields).length) return api.fail(res, 422, 'VALIDATION_FAILED', 'Problem data is invalid.', fields);
  await ensureProblemSchema();
  await syzoj.utils.vjudgeV2.ensureSchema();
  const created = await TypeORM.getConnection().transaction(async manager => {
    if (requestedId != null) {
      const existing = await manager.query('SELECT id FROM problem WHERE id=? LIMIT 1 FOR UPDATE', [requestedId]);
      if (existing.length) throw Object.assign(new Error('The requested problem ID is already in use.'), { code: 'PROBLEM_ID_CONFLICT', statusCode: 409 });
    }
    if (tagIds.length) {
      const placeholders = tagIds.map(() => '?').join(',');
      const tags = await manager.query(`SELECT id FROM problem_tag WHERE id IN (${placeholders}) FOR UPDATE`, tagIds);
      if (tags.length !== tagIds.length) throw Object.assign(new Error('One or more tags were not found.'), { code: 'TAG_NOT_FOUND', statusCode: 404 });
    }
    const value = await createProblemAggregate(manager, Problem, content, res.locals.user.id, { id: requestedId, isAnonymous: req.body && req.body.is_anonymous === true });
    for (const tagId of tagIds) await manager.query('INSERT INTO problem_tag_map (problem_id,tag_id) VALUES (?,?)', [value.problem.id, tagId]);
    await syncSourceProjection(manager, value.problem);
    return value;
  }).catch(error => {
    if (error && error.statusCode) throw error;
    if (error && (error.code === 'ER_DUP_ENTRY' || error.errno === 1062)) throw Object.assign(new Error('The requested problem ID is already in use.'), { code: 'PROBLEM_ID_CONFLICT', statusCode: 409 });
    throw error;
  });
  const { problem, version } = created;
  const state = await loadState(problem.id);
  await syzoj.utils.apiV2.appendEvent({ stream: `problem:${problem.id}`, type: 'problem.created', aggregateId: problem.id, actor: res.locals.user, payload: { version_id: version.id } });
  return api.send(res, { problem: serializeProblem(problem, state), version }, 201);
});

app.get('/api/v2/problems/:id', async (req, res) => {
  const api = syzoj.utils.apiV2;
  const problem = await loadProblem(req, res, true);
  if (problem === false) return api.fail(res, 403, 'PROBLEM_FORBIDDEN', 'You cannot view this problem.');
  if (!problem) return api.fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
  const payload = serializeProblem(problem, await loadState(problem.id));
  if (api.apiNotModified(req, res, payload)) return;
  return api.send(res, payload);
});

app.patch('/api/v2/problems/:id', async (req, res, next) => {
  const api = syzoj.utils.apiV2;
  const problem = await loadProblem(req, res, false);
  if (!problem) return api.fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
  return requireCapability('problem:edit', () => problemResource(problem))(req, res, async error => {
    if (error) return next(error);
    const current = serializeProblem(problem, await loadState(problem.id));
    if (!req.get('If-Match')) return api.fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when editing a problem.', { if_match: 'required' });
    if (!api.ifMatch(req, current)) return api.fail(res, 412, 'ETAG_MISMATCH', 'The problem changed. Refresh it and try again.');
    const content = contentFromInput(req.body || {}, problemContent(problem));
    const fields = validateContent(content);
    const tagIds = Array.isArray(req.body && req.body.tag_ids) ? req.body.tag_ids.map(Number) : null;
    if (tagIds && (tagIds.length > 20 || tagIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(tagIds).size !== tagIds.length)) fields.tag_ids = 'up to 20 unique positive integers required';
    if (Object.keys(fields).length) return api.fail(res, 422, 'VALIDATION_FAILED', 'Problem data is invalid.', fields);
    await ensureProblemSchema();
    const mutation = await TypeORM.getConnection().transaction(async manager => {
      if (tagIds && tagIds.length) {
        const placeholders = tagIds.map(() => '?').join(',');
        const tags = await manager.query(`SELECT id FROM problem_tag WHERE id IN (${placeholders}) FOR UPDATE`, tagIds);
        if (tags.length !== tagIds.length) throw Object.assign(new Error('One or more tags were not found.'), { code: 'TAG_NOT_FOUND', statusCode: 404 });
      }
      const value = await updateProblemAggregate(manager, problem, content, res.locals.user.id);
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'is_anonymous')) {
        await manager.query('UPDATE problem SET is_anonymous=? WHERE id=?', [req.body.is_anonymous === true ? 1 : 0, problem.id]);
      }
      if (tagIds) {
        await manager.query('DELETE FROM problem_tag_map WHERE problem_id=?', [problem.id]);
        for (const tagId of tagIds) await manager.query('INSERT INTO problem_tag_map (problem_id,tag_id) VALUES (?,?)', [problem.id, tagId]);
      }
      return value;
    });
    const version = mutation.version;
    const updated = mutation.legacy_projection_updated
      ? await syzoj.model('problem').findById(problem.id)
      : Object.assign({}, problem, content);
    await api.appendEvent({ stream: `problem:${problem.id}`, type: 'problem.version.created', aggregateId: problem.id, actor: res.locals.user, payload: { version_id: version.id } });
    return api.send(res, { problem: serializeProblem(updated, await loadState(problem.id)), version });
  });
});

app.get('/api/v2/problems/:id/versions', async (req, res) => {
  const api = syzoj.utils.apiV2;
  const limit = api.parseLimit(req, 30, 100);
  let cursor = Number(api.decodeCursor(req.query.cursor) || Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(cursor) || cursor < 1) cursor = Number.MAX_SAFE_INTEGER;
  const problem = await loadProblem(req, res, true);
  if (problem === false) return api.fail(res, 403, 'PROBLEM_FORBIDDEN', 'You cannot view this problem.');
  if (!problem) return api.fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
  await ensureProblemSchema();
  await ensureCurrentSnapshot(problem, problem.publicizer_id || problem.user_id || null);
  const includeDrafts = await canReadDraftVersions(problem, res.locals.user);
  const rows = await TypeORM.getConnection().query(
    `SELECT problem_version.*,author.username AS author_username,reviewer.username AS reviewer_username
       FROM problem_v2_version problem_version
       LEFT JOIN user author ON author.id=problem_version.created_by
       LEFT JOIN user reviewer ON reviewer.id=problem_version.reviewed_by
      WHERE problem_version.problem_id=? AND problem_version.version_number<?
        AND (?=1 OR problem_version.status='published')
      ORDER BY problem_version.version_number DESC LIMIT ?`,
    [problem.id, cursor, includeDrafts ? 1 : 0, limit + 1]
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  res.locals.apiMeta.next_cursor = hasMore ? api.encodeCursor(page[page.length - 1].version_number) : null;
  res.locals.apiMeta.limit = limit;
  return api.send(res, page.map(versionSummary));
});

app.get('/api/v2/problems/:id/versions/:versionId', async (req, res) => {
  const api = syzoj.utils.apiV2;
  const problem = await loadProblem(req, res, true);
  if (problem === false) return api.fail(res, 403, 'PROBLEM_FORBIDDEN', 'You cannot view this problem.');
  if (!problem) return api.fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
  await ensureProblemSchema();
  await ensureCurrentSnapshot(problem, problem.publicizer_id || problem.user_id || null);
  const resource = await loadVersionResource(TypeORM.getConnection(), problem.id, req.params.versionId);
  if (!resource) return api.fail(res, 404, 'PROBLEM_VERSION_NOT_FOUND', 'Problem version was not found.');
  if (resource.status !== 'published' && !await canReadDraftVersions(problem, res.locals.user)) {
    return api.fail(res, 404, 'PROBLEM_VERSION_NOT_FOUND', 'Problem version was not found.');
  }
  if (api.apiNotModified(req, res, resource.revision)) return;
  const { revision, ...payload } = resource;
  return api.send(res, payload);
});

app.post('/api/v2/problems/:id/versions', async (req, res, next) => {
  const api = syzoj.utils.apiV2;
  const problem = await loadProblem(req, res, false);
  if (!problem) return api.fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
  return requireCapability('problem:edit', () => problemResource(problem))(req, res, async error => {
    if (error) return next(error);
    const content = contentFromInput(req.body.content || req.body || {}, problemContent(problem));
    const fields = validateContent(content);
    if (Object.keys(fields).length) return api.fail(res, 422, 'VALIDATION_FAILED', 'Problem version is invalid.', fields);
    await ensureProblemSchema();
    const state = await loadState(problem.id);
    const version = await TypeORM.getConnection().transaction(manager => insertVersion(manager, problem.id, content, res.locals.user.id, 'draft', state && state.current_version_id));
    await api.appendEvent({ stream: `problem:${problem.id}`, type: 'problem.version.created', aggregateId: problem.id, actor: res.locals.user, payload: { version_id: version.id } });
    return api.send(res, version, 201);
  });
});

app.post('/api/v2/problems/:id/versions/:versionId/review-request', async (req, res, next) => {
  const api = syzoj.utils.apiV2;
  const problem = await loadProblem(req, res, false);
  if (!problem) return api.fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
  return requireCapability('problem:edit', () => problemResource(problem))(req, res, async error => {
    if (error) return next(error);
    await ensureProblemSchema();
    try {
      await TypeORM.getConnection().transaction(async manager => {
        const version = await loadVersionRow(manager, problem.id, req.params.versionId, true);
        if (!version) throw problemVersionError('PROBLEM_VERSION_NOT_FOUND', 'Problem version was not found.', 404);
        if (!req.get('If-Match')) throw problemVersionError('PRECONDITION_REQUIRED', 'If-Match is required when requesting review.', 428, { if_match: 'required' });
        if (!api.ifMatch(req, versionRevision(version))) throw problemVersionError('ETAG_MISMATCH', 'The problem version changed. Refresh it and try again.', 412);
        if (!reviewRequestAllowed(version.status)) {
          throw problemVersionError('PROBLEM_VERSION_NOT_REVIEWABLE', 'Only draft or rejected versions can be submitted for review.', 409, { status: version.status });
        }
        await manager.query(
          "UPDATE problem_v2_version SET status='in_review',reviewed_by=NULL,reviewed_at=NULL,review_feedback=NULL WHERE id=? AND problem_id=?",
          [version.id, problem.id]
        );
      });
    } catch (transactionError) {
      if (sendProblemVersionError(api, res, transactionError)) return;
      return next(transactionError);
    }
    const resource = await loadVersionResource(TypeORM.getConnection(), problem.id, req.params.versionId);
    const event = await api.appendEvent({
      stream: `problem:${problem.id}`,
      type: 'problem.version.review_requested',
      aggregateId: problem.id,
      actor: res.locals.user,
      payload: { version_id: String(req.params.versionId) }
    });
    const { revision, ...payload } = resource;
    return api.send(res, { version: payload, event_id: String(event.id) });
  });
});

app.post('/api/v2/problems/:id/versions/:versionId/review', async (req, res, next) => {
  const api = syzoj.utils.apiV2;
  const problem = await loadProblem(req, res, false);
  if (!problem) return api.fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
  return requireCapability('problem:publish', () => problemResource(problem))(req, res, async error => {
    if (error) return next(error);
    const decision = String(req.body && req.body.decision || '').trim().toLowerCase();
    const suppliedReason = String(req.body && req.body.reason || '').trim();
    const fields = {};
    if (!['approved', 'rejected'].includes(decision)) fields.decision = 'approved or rejected is required';
    if (decision === 'rejected' && !suppliedReason) fields.reason = 'required when rejecting a version';
    if (suppliedReason.length > 2000) fields.reason = 'maximum length is 2000';
    if (Object.keys(fields).length) return api.fail(res, 422, 'VALIDATION_FAILED', 'Problem version review is invalid.', fields);
    const reason = decision === 'approved' ? '题目版本审核通过' : suppliedReason;
    await ensureProblemSchema();
    let auditEventId;
    try {
      auditEventId = await TypeORM.getConnection().transaction(async manager => {
        const version = await loadVersionRow(manager, problem.id, req.params.versionId, true);
        if (!version) throw problemVersionError('PROBLEM_VERSION_NOT_FOUND', 'Problem version was not found.', 404);
        if (!req.get('If-Match')) throw problemVersionError('PRECONDITION_REQUIRED', 'If-Match is required when reviewing a version.', 428, { if_match: 'required' });
        if (!api.ifMatch(req, versionRevision(version))) throw problemVersionError('ETAG_MISMATCH', 'The problem version changed. Refresh it and try again.', 412);
        if (!reviewDecisionAllowed(version.status)) {
          throw problemVersionError('PROBLEM_VERSION_NOT_REVIEWABLE', 'Only a version awaiting review can be reviewed.', 409, { status: version.status });
        }
        await manager.query(
          'UPDATE problem_v2_version SET status=?,reviewed_by=?,reviewed_at=UTC_TIMESTAMP(3),review_feedback=? WHERE id=? AND problem_id=?',
          [decision, res.locals.user.id, reason, version.id, problem.id]
        );
        return syzoj.utils.authorizationV2.recordAudit(req, {
          action: 'problem:version.review',
          resourceType: 'problem_version',
          resourceId: version.id,
          scope: `problem:${problem.id}`,
          reason,
          details: { problem_id: Number(problem.id), version_id: String(version.id), decision }
        }, manager);
      });
    } catch (transactionError) {
      if (sendProblemVersionError(api, res, transactionError)) return;
      return next(transactionError);
    }
    const resource = await loadVersionResource(TypeORM.getConnection(), problem.id, req.params.versionId);
    const event = await api.appendEvent({
      stream: `problem:${problem.id}`,
      type: `problem.version.${decision}`,
      aggregateId: problem.id,
      actor: res.locals.user,
      payload: { version_id: String(req.params.versionId), audit_event_id: auditEventId }
    });
    const { revision, ...payload } = resource;
    return api.send(res, { version: payload, audit_event_id: auditEventId, event_id: String(event.id) });
  });
});

app.post('/api/v2/problems/:id/publish', async (req, res, next) => {
  const api = syzoj.utils.apiV2;
  const problem = await loadProblem(req, res, false);
  if (!problem) return api.fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
  return requireCapability('problem:publish', () => problemResource(problem))(req, res, async error => {
    if (error) return next(error);
    const reason = syzoj.utils.operationReason(req, '发布题目');
    await ensureProblemSchema();
    await syzoj.utils.vjudgeV2.ensureSchema();
    const requestedSnapshotId = `ps_${crypto.randomUUID().replace(/-/g, '')}`;
    let testdata;
    let published;
    try {
      testdata = await captureTestdataSnapshot(problem, requestedSnapshotId);
      published = await TypeORM.getConnection().transaction(async manager => {
        const value = await publishProblemAggregate(manager, problem, req.body && req.body.version_id, res.locals.user.id, () => requestedSnapshotId, testdata);
        if (value) await syncSourceProjection(manager, { ...problem, ...value.content });
        return value;
      });
      if (published && published.snapshot_id !== requestedSnapshotId && testdata.created) {
        await testdataSnapshots.remove(syzoj.config.upload_dir, requestedSnapshotId);
      }
    } catch (publishError) {
      if (testdata && testdata.created) await testdataSnapshots.remove(syzoj.config.upload_dir, requestedSnapshotId).catch(() => {});
      if (publishError.statusCode) return api.fail(res, publishError.statusCode, publishError.code, publishError.message, publishError.fields || {});
      return next(publishError);
    }
    if (!published) return api.fail(res, 409, 'PROBLEM_VERSION_REQUIRED', 'Create a problem version before publishing.');
    const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'problem:publish', resourceType: 'problem', resourceId: problem.id, scope: `problem:${problem.id}`, reason, details: { version_id: String(published.version.id), snapshot_id: published.snapshot_id } });
    await api.appendEvent({ stream: `problem:${problem.id}`, type: 'problem.published', aggregateId: problem.id, actor: res.locals.user, payload: { version_id: String(published.version.id), snapshot_id: published.snapshot_id, reason, audit_event_id: auditEventId } });
    return api.send(res, { problem_id: problem.id, version_id: String(published.version.id), snapshot_id: published.snapshot_id, audit_event_id: auditEventId });
  });
});

app.post('/api/v2/problems/:id/unpublish', async (req, res, next) => {
  const api = syzoj.utils.apiV2;
  const problem = await loadProblem(req, res, false);
  if (!problem) return api.fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
  return requireCapability('problem:publish', () => problemResource(problem))(req, res, async error => {
    if (error) return next(error);
    const reason = syzoj.utils.operationReason(req, '取消公开题目');
    await ensureProblemSchema();
    await TypeORM.getConnection().transaction(manager => unpublishProblemAggregate(manager, problem.id));
    const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
      action: 'problem:unpublish',
      resourceType: 'problem',
      resourceId: problem.id,
      scope: `problem:${problem.id}`,
      reason
    });
    const event = await api.appendEvent({
      stream: `problem:${problem.id}`,
      type: 'problem.unpublished',
      aggregateId: problem.id,
      actor: res.locals.user,
      payload: { reason, audit_event_id: auditEventId }
    });
    return api.send(res, {
      problem_id: problem.id,
      status: 'draft',
      audit_event_id: auditEventId,
      event_id: String(event.id)
    });
  });
});

app.post('/api/v2/problems/:id/archive', async (req, res, next) => {
  const api = syzoj.utils.apiV2;
  const problem = await loadProblem(req, res, false);
  if (!problem) return api.fail(res, 404, 'PROBLEM_NOT_FOUND', 'Problem was not found.');
  return requireCapability('problem:archive', () => problemResource(problem))(req, res, async error => {
    if (error) return next(error);
    const reason = syzoj.utils.operationReason(req, '归档题目');
    await ensureProblemSchema();
    await TypeORM.getConnection().transaction(manager => archiveProblemAggregate(manager, problem.id));
    const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'problem:archive', resourceType: 'problem', resourceId: problem.id, scope: `problem:${problem.id}`, reason });
    await api.appendEvent({ stream: `problem:${problem.id}`, type: 'problem.archived', aggregateId: problem.id, actor: res.locals.user, payload: { reason, audit_event_id: auditEventId } });
    return api.send(res, { problem_id: problem.id, status: 'archived', audit_event_id: auditEventId });
  });
});

ensureProblemSchema().catch(error => syzoj.log(`[problem-v2] schema initialization failed: ${error.stack || error.message}`));
