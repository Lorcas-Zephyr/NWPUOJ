'use strict';

const crypto = require('crypto');

const EDITABLE_FIELDS = Object.freeze([
  'title', 'description', 'input_format', 'output_format', 'example', 'limit_and_hint',
  'time_limit', 'memory_limit', 'file_io', 'file_io_input_name', 'file_io_output_name', 'type',
  'vjudge_config'
]);
const PROBLEM_TYPES = new Set([
  'traditional', 'submit-answer', 'interaction',
  'vjudge:luogu', 'vjudge:uoj', 'vjudge:hdu', 'vjudge:poj'
]);
const JUDGE_CONFIGURATION_FIELDS = Object.freeze([
  'type', 'time_limit', 'memory_limit', 'file_io', 'file_io_input_name', 'file_io_output_name'
]);
const REVIEW_REQUEST_STATUSES = new Set(['draft', 'rejected']);

function orderedContent(source = {}) {
  const content = {};
  EDITABLE_FIELDS.forEach(field => {
    content[field] = source[field] == null ? null : source[field];
  });
  return content;
}

function problemContent(problem) {
  return orderedContent(problem || {});
}

function contentFromInput(input = {}, base = {}) {
  const content = orderedContent(base);
  EDITABLE_FIELDS.forEach(field => {
    if (Object.prototype.hasOwnProperty.call(input, field)) content[field] = input[field];
  });
  return orderedContent(content);
}

function serializeContent(content) {
  return JSON.stringify(orderedContent(content));
}

function contentHash(content) {
  return crypto.createHash('sha256').update(serializeContent(content)).digest('hex');
}

function diffContent(previous, current) {
  const before = orderedContent(previous || {});
  const after = orderedContent(current || {});
  const fields = {};
  for (const field of EDITABLE_FIELDS) {
    if (JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
    fields[field] = { before: before[field], after: after[field] };
  }
  return { changed_fields: Object.keys(fields), fields };
}

function reviewRequestAllowed(status) {
  return REVIEW_REQUEST_STATUSES.has(String(status || ''));
}

function reviewDecisionAllowed(status) {
  return String(status || '') === 'in_review';
}

function validateContent(content) {
  const fields = {};
  if (!String(content.title || '').trim()) fields.title = 'required';
  if (String(content.title || '').length > 80) fields.title = 'maximum length is 80';
  if (content.time_limit != null && (!Number.isSafeInteger(Number(content.time_limit)) || Number(content.time_limit) < 1)) fields.time_limit = 'positive integer required';
  if (content.memory_limit != null && (!Number.isSafeInteger(Number(content.memory_limit)) || Number(content.memory_limit) < 1)) fields.memory_limit = 'positive integer required';
  if (content.type != null && !PROBLEM_TYPES.has(String(content.type))) fields.type = 'unsupported problem type';
  const remote = content.vjudge_config == null ? '' : String(content.vjudge_config);
  if (String(content.type || '').startsWith('vjudge:') && (!remote || remote !== remote.trim())) fields.vjudge_config = 'remote identifier required without surrounding whitespace';
  else if (remote.length > 80) fields.vjudge_config = 'maximum length is 80';
  return fields;
}

function statementMarkdown(problem) {
  if (!problem.input_format && !problem.output_format && !problem.example && !problem.limit_and_hint) {
    return problem.description == null ? '' : String(problem.description).trim();
  }
  return [
    ['题目描述', problem.description],
    ['输入格式', problem.input_format],
    ['输出格式', problem.output_format],
    ['样例', problem.example],
    ['数据范围与提示', problem.limit_and_hint]
  ].filter(item => item[1]).map(item => `## ${item[0]}\n\n${item[1]}`).join('\n\n');
}

function sourceMetadata(problem) {
  const type = String(problem && problem.type || 'traditional');
  const match = /^vjudge:([a-z0-9_-]+)$/.exec(type);
  if (!match) return { kind: 'local', provider: null, remote_id: null };
  return {
    kind: 'vjudge',
    provider: match[1],
    remote_id: problem && problem.vjudge_config == null ? null : String(problem.vjudge_config)
  };
}

async function syncSourceProjection(manager, problem) {
  const source = sourceMetadata(problem);
  const problemId = Number(problem && problem.id);
  if (!Number.isSafeInteger(problemId) || problemId <= 0) throw Object.assign(new Error('A persisted problem is required for source projection.'), { code: 'VJUDGE_SOURCE_INVALID', statusCode: 422 });
  if (source.kind !== 'vjudge') {
    const current = await manager.query('SELECT provider,remote_id,local_problem_id FROM vjudge_v2_remote_problem WHERE local_problem_id=? FOR UPDATE', [problemId]);
    if (current.length) await manager.query('DELETE FROM vjudge_v2_remote_problem WHERE local_problem_id=?', [problemId]);
    return { source, changed: current.length > 0 };
  }
  if (!source.provider || !source.remote_id || source.remote_id.length > 80) throw Object.assign(new Error('The VJudge source is incomplete.'), { code: 'VJUDGE_SOURCE_INVALID', statusCode: 422 });
  const rows = await manager.query(`SELECT provider,remote_id,local_problem_id FROM vjudge_v2_remote_problem
    WHERE (provider=? AND remote_id=?) OR local_problem_id=? FOR UPDATE`, [source.provider, source.remote_id, problemId]);
  const exact = rows.find(row => row.provider === source.provider && String(row.remote_id) === source.remote_id && Number(row.local_problem_id) === problemId);
  if (exact) return { source, changed: false };
  if (rows.some(row => Number(row.local_problem_id) !== problemId)) throw Object.assign(new Error('The VJudge source is already linked to another problem.'), { code: 'VJUDGE_SOURCE_CONFLICT', statusCode: 409 });
  if (rows.length) await manager.query('DELETE FROM vjudge_v2_remote_problem WHERE local_problem_id=?', [problemId]);
  await manager.query('INSERT INTO vjudge_v2_remote_problem (provider,remote_id,local_problem_id,imported_at,updated_at) VALUES (?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [source.provider, source.remote_id, problemId]);
  return { source, changed: true };
}

function problemResource(problem) {
  return { id: Number(problem.id), ownerId: Number(problem.user_id), scope: `problem:${problem.id}` };
}

function serializeProblem(problem, state, databaseIso = value => value == null ? null : new Date(value).toISOString()) {
  return {
    id: Number(problem.id),
    display_id: typeof problem.getDisplayId === 'function' ? problem.getDisplayId() : String(problem.id),
    title: problem.title,
    owner_id: problem.user_id == null ? null : Number(problem.user_id),
    publicizer_id: problem.publicizer_id == null ? null : Number(problem.publicizer_id),
    visibility: problem.is_public ? 'public' : 'private',
    lifecycle_status: state && state.lifecycle_status || (problem.is_public ? 'published' : 'draft'),
    current_version_id: state && state.current_version_id ? String(state.current_version_id) : null,
    current_snapshot_id: state && state.current_snapshot_id || null,
    type: problem.type,
    source: sourceMetadata(problem),
    limits: { time_ms: problem.time_limit, memory_mib: problem.memory_limit },
    statement: {
      description: problem.description,
      input: problem.input_format,
      output: problem.output_format,
      examples: problem.example,
      limits_and_hints: problem.limit_and_hint
    },
    statement_markdown: statementMarkdown(problem),
    file_io: problem.file_io ? { input: problem.file_io_input_name, output: problem.file_io_output_name } : null,
    statistics: { accepted: Number(problem.ac_num || 0), submissions: Number(problem.submit_num || 0) },
    published_at: databaseIso(problem.publicize_time)
  };
}

async function insertVersion(manager, problemId, content, actorId, status = 'draft', parentVersionId = null) {
  const numberRows = await manager.query(
    'SELECT COALESCE(MAX(version_number),0)+1 AS next_version FROM problem_v2_version WHERE problem_id=? FOR UPDATE',
    [problemId]
  );
  const versionNumber = Number(numberRows[0].next_version);
  const serialized = serializeContent(content);
  const hash = contentHash(content);
  const result = await manager.query(
    `INSERT INTO problem_v2_version (problem_id,version_number,parent_version_id,status,content_json,content_hash,created_by,created_at,published_at)
     VALUES (?,?,?,?,?,?,?,UTC_TIMESTAMP(3),NULL)`,
    [problemId, versionNumber, parentVersionId, status, serialized, hash, actorId]
  );
  await manager.query(
    `INSERT INTO problem_v2_state (problem_id,lifecycle_status,current_version_id,current_snapshot_id,archived_at,updated_at)
     VALUES (?,?,?,NULL,NULL,UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE current_version_id=VALUES(current_version_id),updated_at=UTC_TIMESTAMP(3)`,
    [problemId, status === 'published' ? 'published' : 'draft', result.insertId]
  );
  return { id: String(result.insertId), version_number: versionNumber, status, content_hash: hash };
}

async function createProblemAggregate(manager, Problem, content, actorId, options = {}) {
  const problem = Problem.create({ type: content.type || 'traditional' });
  if (options.id != null) problem.id = options.id;
  Object.assign(problem, orderedContent(content), {
    user_id: actorId,
    is_public: false,
    is_anonymous: options.isAnonymous === true,
    ac_num: 0,
    submit_num: 0
  });
  await manager.save(problem);
  const version = await insertVersion(manager, problem.id, problemContent(problem), actorId);
  return { problem, version };
}

async function updateProblemAggregate(manager, problem, content, actorId) {
  const states = await manager.query('SELECT * FROM problem_v2_state WHERE problem_id=? FOR UPDATE', [problem.id]);
  const state = states[0] || null;
  // Visibility is the public-projection boundary. A pending draft must never
  // write through merely because lifecycle state was moved back to draft.
  const published = !!problem.is_public;
  if (!published) {
    const assignments = EDITABLE_FIELDS.map(field => `${field}=?`).join(',');
    await manager.query(
      `UPDATE problem SET ${assignments} WHERE id=?`,
      EDITABLE_FIELDS.map(field => content[field]).concat([problem.id])
    );
  }
  const version = await insertVersion(
    manager,
    problem.id,
    content,
    actorId,
    'draft',
    state && state.current_version_id || null
  );
  return { version, legacy_projection_updated: !published };
}

function withJudgeConfiguration(content, configuration) {
  const next = orderedContent(content || {});
  JUDGE_CONFIGURATION_FIELDS.forEach(field => {
    if (Object.prototype.hasOwnProperty.call(configuration, field)) next[field] = configuration[field];
  });
  return next;
}

async function insertJudgeConfigurationSnapshot(manager, problemId, version, content, currentSnapshot, actorId, snapshotIdFactory) {
  const serialized = serializeContent(content);
  const hash = contentHash(content);
  if (currentSnapshot && String(currentSnapshot.content_hash) === hash) {
    return { snapshot_id: String(currentSnapshot.id), created: false };
  }

  const testdataHash = currentSnapshot && currentSnapshot.testdata_hash || null;
  const testdataPath = currentSnapshot && currentSnapshot.testdata_path || null;
  const providerConfig = content.vjudge_config == null ? null : content.vjudge_config;
  const requestedId = (snapshotIdFactory || (() => `ps_${crypto.randomUUID().replace(/-/g, '')}`))();
  let snapshotId = requestedId;
  try {
    await manager.query(
      'INSERT INTO problem_v2_snapshot (id,problem_id,version_id,content_hash,content_json,provider_config,testdata_hash,testdata_path,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))',
      [requestedId, problemId, version.id, hash, serialized, providerConfig, testdataHash, testdataPath, actorId]
    );
  } catch (insertError) {
    const snapshots = await manager.query(
      'SELECT id FROM problem_v2_snapshot WHERE problem_id=? AND content_hash=? AND testdata_hash <=> ? LIMIT 1',
      [problemId, hash, testdataHash]
    );
    if (!snapshots.length) throw insertError;
    snapshotId = snapshots[0].id;
  }
  return { snapshot_id: String(snapshotId), created: snapshotId === requestedId };
}

async function updateJudgeConfigurationAggregate(manager, problem, configuration, actorId, snapshotIdFactory = null) {
  const problemId = Number(problem && problem.id);
  const states = await manager.query('SELECT * FROM problem_v2_state WHERE problem_id=? FOR UPDATE', [problemId]);
  const state = states[0] || null;
  const versionRows = state && state.current_version_id
    ? await manager.query('SELECT * FROM problem_v2_version WHERE id=? AND problem_id=? LIMIT 1', [state.current_version_id, problemId])
    : [];
  const snapshotRows = state && state.current_snapshot_id
    ? await manager.query('SELECT * FROM problem_v2_snapshot WHERE id=? AND problem_id=? LIMIT 1', [state.current_snapshot_id, problemId])
    : [];
  const currentVersion = versionRows[0] || null;
  const currentSnapshot = snapshotRows[0] || null;
  const currentVersionContent = currentVersion ? parseStoredContent(currentVersion.content_json) : problemContent(problem);
  const desiredVersionContent = withJudgeConfiguration(currentVersionContent, configuration);
  const publicProblem = !!problem.is_public;
  const hasPendingDraft = publicProblem && currentSnapshot && currentVersion && String(currentSnapshot.version_id) !== String(currentVersion.id);

  await manager.query(
    'UPDATE problem SET type=?,time_limit=?,memory_limit=?,file_io=?,file_io_input_name=?,file_io_output_name=? WHERE id=?',
    JUDGE_CONFIGURATION_FIELDS.map(field => configuration[field]).concat([problemId])
  );

  let publicVersion = null;
  let publicContent = null;
  let nextSnapshot = currentSnapshot ? { snapshot_id: String(currentSnapshot.id), created: false } : null;
  if (currentSnapshot) {
    publicContent = publicProblem
      ? withJudgeConfiguration(parseStoredContent(currentSnapshot.content_json), configuration)
      : desiredVersionContent;
    if (contentHash(publicContent) !== String(currentSnapshot.content_hash)) {
      if (!publicProblem && currentVersion && contentHash(desiredVersionContent) === String(currentVersion.content_hash)) {
        publicVersion = currentVersion;
      } else {
        publicVersion = await insertVersion(
          manager,
          problemId,
          publicContent,
          actorId,
          publicProblem ? 'published' : 'draft',
          publicProblem ? currentSnapshot.version_id : currentVersion && currentVersion.id
        );
        if (publicProblem) {
          await manager.query(
            "UPDATE problem_v2_version SET reviewed_by=?,reviewed_at=UTC_TIMESTAMP(3),review_feedback='Judge configuration update',published_at=UTC_TIMESTAMP(3) WHERE id=? AND problem_id=?",
            [actorId, publicVersion.id, problemId]
          );
        }
      }
      nextSnapshot = await insertJudgeConfigurationSnapshot(
        manager, problemId, publicVersion, publicContent, currentSnapshot, actorId, snapshotIdFactory
      );
    }
  }

  let nextVersion = currentVersion;
  if (!currentVersion || contentHash(desiredVersionContent) !== String(currentVersion.content_hash)) {
    const snapshotVersionMatches = publicVersion && publicContent && contentHash(desiredVersionContent) === contentHash(publicContent);
    nextVersion = snapshotVersionMatches && !hasPendingDraft
      ? publicVersion
      : await insertVersion(manager, problemId, desiredVersionContent, actorId, publicProblem && !hasPendingDraft ? 'published' : 'draft', currentVersion && currentVersion.id);
    if (publicProblem && !hasPendingDraft && nextVersion !== publicVersion) {
      await manager.query(
        "UPDATE problem_v2_version SET reviewed_by=?,reviewed_at=UTC_TIMESTAMP(3),review_feedback='Judge configuration update',published_at=UTC_TIMESTAMP(3) WHERE id=? AND problem_id=?",
        [actorId, nextVersion.id, problemId]
      );
    }
  }

  if (nextVersion || nextSnapshot) {
    await manager.query(
      'UPDATE problem_v2_state SET current_version_id=COALESCE(?,current_version_id),current_snapshot_id=COALESCE(?,current_snapshot_id),updated_at=UTC_TIMESTAMP(3) WHERE problem_id=?',
      [nextVersion && nextVersion.id || null, nextSnapshot && nextSnapshot.snapshot_id || null, problemId]
    );
  }
  return {
    version_id: nextVersion && String(nextVersion.id) || null,
    snapshot_id: nextSnapshot && nextSnapshot.snapshot_id || null
  };
}

function parseStoredContent(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  const content = orderedContent(parsed || {});
  const fields = validateContent(content);
  if (Object.keys(fields).length) {
    const error = new Error('Stored problem version is invalid.');
    error.code = 'PROBLEM_VERSION_INVALID';
    error.fields = fields;
    throw error;
  }
  return content;
}

async function publishProblemAggregate(manager, problem, versionId, actorId, snapshotIdFactory = null, testdataSnapshot = null) {
  const versionRows = versionId
    ? await manager.query('SELECT * FROM problem_v2_version WHERE id=? AND problem_id=? FOR UPDATE', [versionId, problem.id])
    : await manager.query('SELECT * FROM problem_v2_version WHERE problem_id=? ORDER BY version_number DESC LIMIT 1 FOR UPDATE', [problem.id]);
  if (!versionRows.length) return null;

  const version = versionRows[0];
  const content = parseStoredContent(version.content_json);
  const providerConfig = content.vjudge_config == null ? problem.vjudge_config || null : content.vjudge_config;
  content.vjudge_config = providerConfig;
  const createSnapshotId = snapshotIdFactory || (() => `ps_${crypto.randomUUID().replace(/-/g, '')}`);
  const testdataHash = testdataSnapshot && testdataSnapshot.hash || null;
  const testdataPath = testdataSnapshot && testdataSnapshot.path || null;
  let finalSnapshotId = createSnapshotId();
  try {
    await manager.query(
      'INSERT INTO problem_v2_snapshot (id,problem_id,version_id,content_hash,content_json,provider_config,testdata_hash,testdata_path,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))',
      [finalSnapshotId, problem.id, version.id, version.content_hash, serializeContent(content), providerConfig, testdataHash, testdataPath, actorId]
    );
  } catch (insertError) {
    const snapshots = await manager.query(
      'SELECT id FROM problem_v2_snapshot WHERE problem_id=? AND content_hash=? AND testdata_hash <=> ? LIMIT 1',
      [problem.id, version.content_hash, testdataHash]
    );
    if (!snapshots.length) throw insertError;
    finalSnapshotId = snapshots[0].id;
  }

  await manager.query(`UPDATE problem_v2_version
    SET status='published',reviewed_by=COALESCE(reviewed_by,?),reviewed_at=COALESCE(reviewed_at,UTC_TIMESTAMP(3)),
        review_feedback=COALESCE(review_feedback,'Approved at publication'),published_at=UTC_TIMESTAMP(3)
    WHERE id=?`, [actorId, version.id]);
  await manager.query(
    `INSERT INTO problem_v2_state (problem_id,lifecycle_status,current_version_id,current_snapshot_id,archived_at,updated_at)
     VALUES (?,'published',?,?,NULL,UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE lifecycle_status='published',current_version_id=VALUES(current_version_id),current_snapshot_id=VALUES(current_snapshot_id),archived_at=NULL,updated_at=UTC_TIMESTAMP(3)`,
    [problem.id, version.id, finalSnapshotId]
  );
  const assignments = EDITABLE_FIELDS.map(field => `${field}=?`).join(',');
  await manager.query(
    `UPDATE problem SET ${assignments},is_public=1,publicizer_id=?,publicize_time=UTC_TIMESTAMP() WHERE id=?`,
    EDITABLE_FIELDS.map(field => content[field]).concat([actorId, problem.id])
  );
  return { version, snapshot_id: finalSnapshotId, content };
}

async function refreshTestdataSnapshotAggregate(manager, problem, actorId, requestedSnapshotId, testdataSnapshot) {
  if (!testdataSnapshot || !testdataSnapshot.hash || !testdataSnapshot.path) {
    const error = new Error('A complete testdata snapshot is required.');
    error.code = 'TESTDATA_SNAPSHOT_INVALID';
    throw error;
  }

  const states = await manager.query('SELECT * FROM problem_v2_state WHERE problem_id=? FOR UPDATE', [problem.id]);
  const state = states[0] || null;
  if (!state || !state.current_snapshot_id) {
    const error = new Error('The problem does not have a current snapshot.');
    error.code = 'PROBLEM_SNAPSHOT_REQUIRED';
    throw error;
  }

  const currentRows = await manager.query('SELECT * FROM problem_v2_snapshot WHERE id=? AND problem_id=? LIMIT 1', [state.current_snapshot_id, problem.id]);
  if (!currentRows.length) {
    const error = new Error('The current problem snapshot is missing.');
    error.code = 'PROBLEM_SNAPSHOT_REQUIRED';
    throw error;
  }

  const current = currentRows[0];
  let base = current;
  // A public problem may have a newer statement draft. Testdata activation must
  // retain the published statement until that draft is explicitly published.
  if (!problem.is_public && state.current_version_id && String(state.current_version_id) !== String(current.version_id)) {
    const versions = await manager.query('SELECT * FROM problem_v2_version WHERE id=? AND problem_id=? LIMIT 1', [state.current_version_id, problem.id]);
    if (!versions.length) {
      const error = new Error('The current problem version is missing.');
      error.code = 'PROBLEM_VERSION_REQUIRED';
      throw error;
    }
    const version = versions[0];
    const content = parseStoredContent(version.content_json);
    const providerConfig = content.vjudge_config == null ? problem.vjudge_config || null : content.vjudge_config;
    content.vjudge_config = providerConfig;
    base = {
      version_id: version.id,
      content_hash: version.content_hash,
      content_json: serializeContent(content),
      provider_config: providerConfig
    };
  }

  if (
    String(current.content_hash) === String(base.content_hash) &&
    String(current.testdata_hash || '') === String(testdataSnapshot.hash)
  ) {
    return { snapshot_id: String(current.id), created: false, changed: false };
  }

  let snapshots = await manager.query(
    'SELECT id FROM problem_v2_snapshot WHERE problem_id=? AND content_hash=? AND testdata_hash <=> ? LIMIT 1',
    [problem.id, base.content_hash, testdataSnapshot.hash]
  );
  let created = false;
  if (!snapshots.length) {
    try {
      await manager.query(
        'INSERT INTO problem_v2_snapshot (id,problem_id,version_id,content_hash,content_json,provider_config,testdata_hash,testdata_path,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))',
        [requestedSnapshotId, problem.id, base.version_id, base.content_hash, base.content_json, base.provider_config || null, testdataSnapshot.hash, testdataSnapshot.path, actorId]
      );
      snapshots = [{ id: requestedSnapshotId }];
      created = true;
    } catch (insertError) {
      snapshots = await manager.query(
        'SELECT id FROM problem_v2_snapshot WHERE problem_id=? AND content_hash=? AND testdata_hash <=> ? LIMIT 1',
        [problem.id, base.content_hash, testdataSnapshot.hash]
      );
      if (!snapshots.length) throw insertError;
    }
  }

  const snapshotId = String(snapshots[0].id);
  await manager.query(
    'UPDATE problem_v2_state SET current_snapshot_id=?,updated_at=UTC_TIMESTAMP(3) WHERE problem_id=?',
    [snapshotId, problem.id]
  );
  return { snapshot_id: snapshotId, created, changed: snapshotId !== String(current.id) };
}

async function materializeCurrentVersionSnapshotAggregate(manager, problem, actorId, requestedSnapshotId, options = {}) {
  const states = await manager.query('SELECT * FROM problem_v2_state WHERE problem_id=? FOR UPDATE', [problem.id]);
  const state = states[0] || null;
  if (!state || !state.current_snapshot_id || !state.current_version_id) {
    const error = new Error('The problem does not have a current version and snapshot.');
    error.code = 'PROBLEM_SNAPSHOT_REQUIRED';
    throw error;
  }

  const [snapshotRows, versionRows] = await Promise.all([
    manager.query('SELECT * FROM problem_v2_snapshot WHERE id=? AND problem_id=? LIMIT 1', [state.current_snapshot_id, problem.id]),
    manager.query('SELECT * FROM problem_v2_version WHERE id=? AND problem_id=? LIMIT 1', [state.current_version_id, problem.id])
  ]);
  if (!snapshotRows.length || !versionRows.length) {
    const error = new Error('The current problem version or snapshot is missing.');
    error.code = 'PROBLEM_SNAPSHOT_REQUIRED';
    throw error;
  }

  const current = snapshotRows[0];
  const version = versionRows[0];
  const includeDraft = options.includeDraft === true || !problem.is_public;
  if (!includeDraft || String(current.content_hash) === String(version.content_hash)) {
    return { snapshot_id: String(current.id), created: false, changed: false };
  }

  const content = parseStoredContent(version.content_json);
  const providerConfig = content.vjudge_config == null ? problem.vjudge_config || null : content.vjudge_config;
  let snapshots = await manager.query(
    'SELECT id FROM problem_v2_snapshot WHERE problem_id=? AND content_hash=? AND testdata_hash <=> ? LIMIT 1',
    [problem.id, version.content_hash, current.testdata_hash]
  );
  let created = false;
  if (!snapshots.length) {
    try {
      await manager.query(
        'INSERT INTO problem_v2_snapshot (id,problem_id,version_id,content_hash,content_json,provider_config,testdata_hash,testdata_path,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))',
        [requestedSnapshotId, problem.id, version.id, version.content_hash, serializeContent(content), providerConfig, current.testdata_hash || null, current.testdata_path || null, actorId]
      );
      snapshots = [{ id: requestedSnapshotId }];
      created = true;
    } catch (insertError) {
      snapshots = await manager.query(
        'SELECT id FROM problem_v2_snapshot WHERE problem_id=? AND content_hash=? AND testdata_hash <=> ? LIMIT 1',
        [problem.id, version.content_hash, current.testdata_hash]
      );
      if (!snapshots.length) throw insertError;
    }
  }

  const snapshotId = String(snapshots[0].id);
  if (options.activate !== false) {
    await manager.query(
      'UPDATE problem_v2_state SET current_snapshot_id=?,updated_at=UTC_TIMESTAMP(3) WHERE problem_id=?',
      [snapshotId, problem.id]
    );
  }
  return { snapshot_id: snapshotId, created, changed: snapshotId !== String(current.id) };
}

async function archiveProblemAggregate(manager, problemId) {
  await manager.query(
    `INSERT INTO problem_v2_state (problem_id,lifecycle_status,current_version_id,current_snapshot_id,archived_at,updated_at)
     VALUES (?,'archived',NULL,NULL,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE lifecycle_status='archived',archived_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3)`,
    [problemId]
  );
  await manager.query('UPDATE problem SET is_public=0 WHERE id=?', [problemId]);
}

async function unpublishProblemAggregate(manager, problemId) {
  await manager.query(
    `INSERT INTO problem_v2_state (problem_id,lifecycle_status,current_version_id,current_snapshot_id,archived_at,updated_at)
     VALUES (?,'draft',NULL,NULL,NULL,UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE lifecycle_status='draft',archived_at=NULL,updated_at=UTC_TIMESTAMP(3)`,
    [problemId]
  );
  await manager.query('UPDATE problem SET is_public=0 WHERE id=?', [problemId]);
}

module.exports = {
  EDITABLE_FIELDS,
  PROBLEM_TYPES,
  archiveProblemAggregate,
  contentFromInput,
  contentHash,
  createProblemAggregate,
  diffContent,
  insertVersion,
  orderedContent,
  parseStoredContent,
  problemContent,
  problemResource,
  publishProblemAggregate,
  materializeCurrentVersionSnapshotAggregate,
  refreshTestdataSnapshotAggregate,
  reviewDecisionAllowed,
  reviewRequestAllowed,
  serializeContent,
  serializeProblem,
  sourceMetadata,
  syncSourceProjection,
  statementMarkdown,
  unpublishProblemAggregate,
  updateJudgeConfigurationAggregate,
  updateProblemAggregate,
  validateContent
};
