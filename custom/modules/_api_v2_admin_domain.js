const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const TypeORM = require('typeorm');
const contentDomain = require('../libs/content-domain');
const User = syzoj.model('user');
const Problem = syzoj.model('problem');
const JudgeState = syzoj.model('judge_state');
const Article = syzoj.model('article');

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const JOB_STATES = new Set(['queued', 'running', 'paused', 'cancelling', 'completed', 'failed', 'cancelled']);
const CONFIG_FIELDS = Object.freeze({
  site_title: { type: 'string', mutable: true, minimum: 1, maximum: 80 },
  default_user_rating: { type: 'integer', mutable: true, minimum: 1, maximum: 10000 },
  enabled_languages: { type: 'string_array', mutable: false, sensitive: false },
  provider_credentials: { type: 'secret_reference', mutable: false, sensitive: true }
});
let configSchemaPromise = null;
let contentSchemaPromise = null;
let rejudgeBatchSchemaPromise = null;
let maintenanceSchemaPromise = null;

const MAX_BULK_REJUDGE = 500;
const BANNER_UPLOAD_DIR = '/app/static/self/banner';
const MAX_BANNER_SIZE = 5 * 1024 * 1024;
const BANNER_IMAGE_EXTENSIONS = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
});
const bannerUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_BANNER_SIZE, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (BANNER_IMAGE_EXTENSIONS[file.mimetype]) return callback(null, true);
    const error = new Error('Only JPG, PNG, WebP, and GIF images are accepted.');
    error.code = 'BANNER_UPLOAD_INVALID';
    callback(error);
  }
}).single('image');
const LEGACY_MANAGED_PRIVILEGES = Object.freeze([
  'manage_problem', 'manage_problem_tag', 'manage_contest', 'manage_user'
]);
const LEGACY_MANAGED_PRIVILEGE_SET = new Set(LEGACY_MANAGED_PRIVILEGES);
const LEGACY_CONFIG_ITEMS = Object.freeze({
  title: { name: '站点标题', type: String },
  google_analytics: { name: 'Google Analytics', type: String },
  '默认参数': null,
  'default.problem.time_limit': { name: '时间限制（单位：ms）', type: Number, min: 1, max: 86400000 },
  'default.problem.memory_limit': { name: '空间限制（单位：MiB）', type: Number, min: 1, max: 1048576 },
  '限制': null,
  'limit.time_limit': { name: '最大时间限制（单位：ms）', type: Number, min: 1, max: 86400000 },
  'limit.memory_limit': { name: '最大空间限制（单位：MiB）', type: Number, min: 1, max: 1048576 },
  'limit.data_size': { name: '所有数据包大小（单位：byte）', type: Number, min: 1, max: 10737418240 },
  'limit.testdata': { name: '测试数据大小（单位：byte）', type: Number, min: 1, max: 10737418240 },
  'limit.submit_code': { name: '代码长度（单位：byte）', type: Number, min: 1, max: 104857600 },
  'limit.submit_answer': { name: '提交答案题目答案大小（单位：byte）', type: Number, min: 1, max: 10737418240 },
  'limit.custom_test_input': { name: '自定义测试输入文件大小（单位：byte）', type: Number, min: 1, max: 1073741824 },
  'limit.testdata_filecount': { name: '测试数据文件数量', type: Number, min: 1, max: 100000 },
  '每页显示数量': null,
  'page.problem': { name: '题库', type: Number, min: 1, max: 200 },
  'page.judge_state': { name: '提交记录', type: Number, min: 1, max: 200 },
  'page.problem_statistics': { name: '题目统计', type: Number, min: 1, max: 200 },
  'page.ranklist': { name: '排行榜', type: Number, min: 1, max: 200 },
  'page.discussion': { name: '讨论', type: Number, min: 1, max: 200 },
  'page.article_comment': { name: '评论', type: Number, min: 1, max: 200 },
  'page.contest': { name: '比赛', type: Number, min: 1, max: 200 }
});

function api() { return syzoj.utils.apiV2; }
function safeJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch (error) { return fallback; } }
function iso(value) { return api().databaseIso(value); }
function inputBoolean(value, fallback) {
  if (value == null) return fallback;
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}
async function can(user, capability) { return !!(user && await syzoj.utils.authorizationV2.authorize(user, capability, null, {})); }
async function contentTransaction(work) { await api().ensureFoundationSchema(); return TypeORM.getConnection().transaction(work); }
function contentFailure(res, error) { const expected = Number.isInteger(error.statusCode); return api().fail(res, expected ? error.statusCode : 500, expected ? error.code : 'CONTENT_WRITE_FAILED', expected ? error.message : 'The content operation could not be completed.', expected ? error.fields || {} : {}); }
function auditRecorder(req) { return (event, manager) => syzoj.utils.authorizationV2.recordAudit(req, event, manager); }

function receiveBannerUpload(req, res, next) {
  bannerUpload(req, res, error => {
    if (!error) return next();
    const tooLarge = error.code === 'LIMIT_FILE_SIZE';
    return api().fail(
      res,
      tooLarge ? 413 : 422,
      'BANNER_UPLOAD_INVALID',
      tooLarge ? 'Banner images cannot exceed 5 MiB.' : error.message
    );
  });
}

function removeTemporaryBanner(file) {
  if (!file || !file.path) return;
  try { fs.unlinkSync(file.path); } catch (error) {
    if (error.code !== 'ENOENT') syzoj.log(`[banner-v2] temporary file cleanup failed: ${error.message}`);
  }
}

function removeStoredBanner(imageUrl) {
  const prefix = '/self/banner/';
  if (typeof imageUrl !== 'string' || !imageUrl.startsWith(prefix)) return;
  const filename = imageUrl.slice(prefix.length);
  if (!filename || path.basename(filename) !== filename) return;
  try { fs.unlinkSync(path.join(BANNER_UPLOAD_DIR, filename)); } catch (error) {
    if (error.code !== 'ENOENT') syzoj.log(`[banner-v2] stored file cleanup failed: ${error.message}`);
  }
}

async function ensureRejudgeBatchSchema() {
  if (rejudgeBatchSchemaPromise) return rejudgeBatchSchemaPromise;
  rejudgeBatchSchemaPromise = (async () => {
    const connection = TypeORM.getConnection();
    await connection.query(`CREATE TABLE IF NOT EXISTS admin_v2_rejudge_job (
      id CHAR(36) NOT NULL PRIMARY KEY,state VARCHAR(24) NOT NULL,stage VARCHAR(40) NOT NULL,
      actor_id INT NOT NULL,filters_json LONGTEXT NOT NULL,total INT NOT NULL DEFAULT 0,
      processed INT NOT NULL DEFAULT 0,failed INT NOT NULL DEFAULT 0,current_submission_id INT NULL,
      audit_event_id VARCHAR(80) NULL,cancel_requested TINYINT(1) NOT NULL DEFAULT 0,
      failures_json LONGTEXT NULL,error_json LONGTEXT NULL,
      created_at DATETIME(3) NOT NULL,updated_at DATETIME(3) NOT NULL,completed_at DATETIME(3) NULL,
      KEY idx_admin_rejudge_state (state,updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS admin_v2_rejudge_item (
      job_id CHAR(36) NOT NULL,seq INT NOT NULL,submission_id INT NOT NULL,
      child_job_id CHAR(36) NULL,state VARCHAR(24) NOT NULL,error_json LONGTEXT NULL,
      updated_at DATETIME(3) NOT NULL,
      PRIMARY KEY (job_id,submission_id),
      UNIQUE KEY uq_admin_rejudge_child (child_job_id),
      KEY idx_admin_rejudge_item_state (job_id,state,seq)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  })().catch(error => {
    rejudgeBatchSchemaPromise = null;
    throw error;
  });
  return rejudgeBatchSchemaPromise;
}

async function ensureMaintenanceSchema() {
  if (maintenanceSchemaPromise) return maintenanceSchemaPromise;
  maintenanceSchemaPromise = TypeORM.getConnection().query(`CREATE TABLE IF NOT EXISTS admin_v2_maintenance_job (
    id CHAR(36) NOT NULL PRIMARY KEY,kind VARCHAR(40) NOT NULL,state VARCHAR(24) NOT NULL,
    actor_id INT NOT NULL,total INT NOT NULL DEFAULT 0,processed INT NOT NULL DEFAULT 0,
    current_object VARCHAR(120) NULL,cancel_requested TINYINT(1) NOT NULL DEFAULT 0,
    audit_event_id VARCHAR(80) NULL,error_json LONGTEXT NULL,
    created_at DATETIME(3) NOT NULL,updated_at DATETIME(3) NOT NULL,completed_at DATETIME(3) NULL,
    KEY idx_admin_maintenance_state (state,updated_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(error => {
    maintenanceSchemaPromise = null;
    throw error;
  });
  return maintenanceSchemaPromise;
}

async function ensureConfigOverrideSchema() {
  if (configSchemaPromise) return configSchemaPromise;
  configSchemaPromise = TypeORM.getConnection().query(`CREATE TABLE IF NOT EXISTS site_config_v2_override (
    field_name VARCHAR(80) NOT NULL PRIMARY KEY,value_json LONGTEXT NOT NULL,
    updated_by INT NOT NULL,updated_at DATETIME(3) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(error => { configSchemaPromise = null; throw error; });
  return configSchemaPromise;
}
function applyConfigOverride(name, value) {
  if (name === 'site_title') syzoj.config.title = String(value);
  if (name === 'default_user_rating') { if (!syzoj.config.default) syzoj.config.default = {}; if (!syzoj.config.default.user) syzoj.config.default.user = {}; syzoj.config.default.user.rating = Number(value); }
}
async function loadConfigOverrides() {
  await ensureConfigOverrideSchema(); const rows = await TypeORM.getConnection().query('SELECT field_name,value_json FROM site_config_v2_override');
  rows.forEach(row => { if (!CONFIG_FIELDS[row.field_name] || !CONFIG_FIELDS[row.field_name].mutable) return; try { applyConfigOverride(row.field_name, JSON.parse(row.value_json)); } catch (error) {} });
}
function configValue(name) {
  if (name === 'site_title') return String(syzoj.config.title || 'NWPUOJ');
  if (name === 'default_user_rating') return Number(syzoj.config.default && syzoj.config.default.user && syzoj.config.default.user.rating || 1500);
  if (name === 'enabled_languages') return Array.isArray(syzoj.config.enabled_languages) ? syzoj.config.enabled_languages.slice() : [];
  return '[redacted]';
}
function configMetadataResource(overrides) {
  const values = overrides || {};
  return {
    version: syzoj.config.nwpuoj_version || null,
    fields: Object.entries(CONFIG_FIELDS).map(([name, definition]) => ({ name, ...definition, value: definition.sensitive ? '[redacted]' : Object.prototype.hasOwnProperty.call(values, name) ? values[name] : configValue(name) })),
    providers: ['uoj', 'hdu', 'poj'],
    secrets_redacted: true
  };
}
function validateConfigChange(name, value) {
  const definition = CONFIG_FIELDS[name]; if (!definition || !definition.mutable) return { error: 'field is read-only or unknown' };
  if (definition.type === 'string') { const normalized = String(value || '').trim(); if (normalized.length < definition.minimum || normalized.length > definition.maximum) return { error: `length must be ${definition.minimum}-${definition.maximum}` }; return { value: normalized }; }
  const normalized = Number(value); if (!Number.isSafeInteger(normalized) || normalized < definition.minimum || normalized > definition.maximum) return { error: `integer must be ${definition.minimum}-${definition.maximum}` }; return { value: normalized };
}

async function ensureContentAdminSchema() {
  if (contentSchemaPromise) return contentSchemaPromise;
  contentSchemaPromise = TypeORM.getConnection().query(`CREATE TABLE IF NOT EXISTS site_links_v2 (
    singleton_id TINYINT NOT NULL PRIMARY KEY,revision INT NOT NULL DEFAULT 1,
    links_json LONGTEXT NOT NULL,updated_by INT NULL,updated_at DATETIME(3) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).then(async () => {
    const initialLinks = Array.isArray(syzoj.config.links) ? syzoj.config.links : [];
    await TypeORM.getConnection().query(
      'INSERT IGNORE INTO site_links_v2 (singleton_id,revision,links_json,updated_by,updated_at) VALUES (1,1,?,NULL,UTC_TIMESTAMP(3))',
      [JSON.stringify(initialLinks)]
    );
  }).catch(error => { contentSchemaPromise = null; throw error; });
  return contentSchemaPromise;
}

function unixSeconds(value, field, errors, nullable = false) {
  if (value == null || value === '') {
    if (nullable) return null;
    errors[field] = 'required';
    return null;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    errors[field] = 'invalid ISO 8601 timestamp';
    return null;
  }
  return Math.floor(date.getTime() / 1000);
}

function safeLinkUrl(value, field, errors, nullable = true) {
  const url = String(value == null ? '' : value).trim();
  if (!url && nullable) return null;
  if (!url || url.length > 500 || (!/^https?:\/\//i.test(url) && !/^\/(?!\/)/.test(url))) {
    errors[field] = 'must be an http(s) URL or an absolute site path';
    return null;
  }
  return url;
}

function announcementResource(row) {
  return {
    id: Number(row.id), title: row.title || '', content: row.content || '',
    level: row.level || 'info', active: !!row.is_active,
    starts_at: row.start_time == null ? null : new Date(Number(row.start_time) * 1000).toISOString(),
    ends_at: row.end_time == null ? null : new Date(Number(row.end_time) * 1000).toISOString(),
    published_at: row.public_time == null ? null : new Date(Number(row.public_time) * 1000).toISOString(),
    updated_at: row.update_time == null ? null : new Date(Number(row.update_time) * 1000).toISOString()
  };
}

function bannerResource(row) {
  return {
    id: Number(row.id), title: row.title || '', image_url: row.image_path,
    link_url: row.link_url || null, sort_order: Number(row.sort_order || 0), active: !!row.is_active,
    starts_at: row.start_time == null ? null : new Date(Number(row.start_time) * 1000).toISOString(),
    ends_at: row.end_time == null ? null : new Date(Number(row.end_time) * 1000).toISOString(),
    created_by: row.created_by == null ? null : Number(row.created_by),
    created_at: new Date(Number(row.created_at) * 1000).toISOString()
  };
}

function validateAnnouncement(body, existing) {
  const errors = {}; const source = body || {};
  const title = source.title == null && existing ? existing.title : String(source.title || '').trim();
  const content = source.content == null && existing ? existing.content : String(source.content || '').trim();
  const level = source.level == null && existing ? existing.level : String(source.level || 'info');
  const startsAt = unixSeconds(source.starts_at == null && existing ? (existing.start_time == null ? null : Number(existing.start_time) * 1000) : source.starts_at, 'starts_at', errors);
  const endsAt = unixSeconds(source.ends_at == null && existing ? (existing.end_time == null ? null : Number(existing.end_time) * 1000) : source.ends_at, 'ends_at', errors);
  if (!title) errors.title = 'required'; else if (title.length > 120) errors.title = 'maximum length is 120';
  if (!content) errors.content = 'required'; else if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) errors.content = 'maximum size is 1 MiB';
  if (!['info', 'warning', 'important'].includes(level)) errors.level = 'must be info, warning, or important';
  if (startsAt != null && endsAt != null && endsAt <= startsAt) errors.ends_at = 'must be later than starts_at';
  return { errors, value: { title, content, level, start_time: startsAt, end_time: endsAt, is_active: source.active == null && existing ? !!existing.is_active : source.active !== false } };
}

function validateBanner(body, existing) {
  const errors = {}; const source = body || {};
  const title = source.title == null && existing ? existing.title : String(source.title || '').trim();
  const imageUrl = safeLinkUrl(source.image_url == null && existing ? existing.image_path : source.image_url, 'image_url', errors, false);
  const linkUrl = safeLinkUrl(source.link_url == null && existing ? existing.link_url : source.link_url, 'link_url', errors, true);
  const sortOrder = Number(source.sort_order == null && existing ? existing.sort_order : source.sort_order || 0);
  const startsAt = unixSeconds(source.starts_at == null && existing && existing.start_time != null ? Number(existing.start_time) * 1000 : source.starts_at, 'starts_at', errors, true);
  const endsAt = unixSeconds(source.ends_at == null && existing && existing.end_time != null ? Number(existing.end_time) * 1000 : source.ends_at, 'ends_at', errors, true);
  if (!title) errors.title = 'required'; else if (title.length > 100) errors.title = 'maximum length is 100';
  if (!Number.isSafeInteger(sortOrder) || sortOrder < -100000 || sortOrder > 100000) errors.sort_order = 'integer from -100000 to 100000';
  if (startsAt != null && endsAt != null && endsAt <= startsAt) errors.ends_at = 'must be later than starts_at';
  return { errors, value: { title, image_path: imageUrl, link_url: linkUrl, sort_order: sortOrder, start_time: startsAt, end_time: endsAt, is_active: source.active == null && existing ? !!existing.is_active : source.active !== false } };
}

function validateLinks(value) {
  const errors = {}; if (!Array.isArray(value)) return { errors: { links: 'must be an array' }, links: [] };
  if (value.length > 100) errors.links = 'maximum 100 links';
  const links = value.slice(0, 100).map((item, index) => {
    const title = String(item && item.title || '').trim(); const itemErrors = {};
    const url = safeLinkUrl(item && item.url, `links.${index}.url`, itemErrors, false);
    if (!title || title.length > 100) itemErrors[`links.${index}.title`] = 'required, maximum length 100';
    Object.assign(errors, itemErrors); return { title, url };
  });
  return { errors, links };
}

function linksResource(row) {
  const links = safeJson(row.links_json, []).filter(item => item && item.title && item.url);
  return { links, revision: Number(row.revision), updated_by: row.updated_by == null ? null : Number(row.updated_by), updated_at: iso(row.updated_at) };
}

async function loadLinksResource(queryable = TypeORM.getConnection(), lock = false) {
  await ensureContentAdminSchema();
  const rows = await queryable.query('SELECT revision,links_json,updated_by,updated_at FROM site_links_v2 WHERE singleton_id=1 LIMIT 1' + (lock ? ' FOR UPDATE' : ''));
  const resource = linksResource(rows[0]);
  if (!lock) syzoj.config.links = resource.links;
  return resource;
}

function requireCapability(capability, options = {}) {
  return async (req, res, next) => {
    if (!res.locals.user) return api().fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
    if (!await can(res.locals.user, capability)) return api().fail(res, 403, 'CAPABILITY_REQUIRED', `Capability required: ${capability}.`);
    if (options.recent && !syzoj.utils.authorizationV2.recentLoginSatisfied(req)) {
      return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Please sign in again or complete MFA before performing this action.');
    }
    return next();
  };
}

function operationReason(req) {
  return syzoj.utils.operationReason(req, '后台管理操作');
}

async function ensureJobSchemas() {
  const schemas = [syzoj.utils.vjudgeV2, syzoj.utils.problemWorkflowV2, syzoj.utils.submissionV2, syzoj.utils.ratingV2, syzoj.utils.contestStandingsV2, syzoj.utils.migrationV2];
  await Promise.all(schemas.filter(Boolean).map(value => value.ensureSchema()).concat([ensureRejudgeBatchSchema(), ensureMaintenanceSchema()]));
}

function serializeVjudge(row) {
  return {
    id: row.id, kind: 'vjudge_import', subtype: row.provider, state: row.state, stage: row.stage,
    actor_id: Number(row.actor_id), approved_by: null, impact: { provider: row.provider, requested: Number(row.total || 0) },
    progress: { processed: Number(row.processed || 0), total: Number(row.total || 0), failed: Number(row.failed || 0), imported: Number(row.imported || 0), skipped: Number(row.skipped || 0) },
    current_object: row.current_remote_id ? { type: 'remote_problem', id: row.current_remote_id } : null,
    failures: safeJson(row.failures_json, []), error: safeJson(row.error_json, null),
    created_at: iso(row.created_at), updated_at: iso(row.updated_at)
  };
}

function serializeProblem(row) {
  const input = safeJson(row.input_json, {});
  const result = safeJson(row.result_json, {});
  if (row.kind === 'bulk_archive') {
    const failures = Array.isArray(result.failures) ? result.failures : row.error_json ? [safeJson(row.error_json, {})] : [];
    return {
      id: row.id, kind: 'problem_bulk_action', subtype: 'archive', state: row.state, stage: row.kind,
      actor_id: Number(row.actor_id), approved_by: null,
      impact: { action: 'archive', problem_ids: Array.isArray(input.problem_ids) ? input.problem_ids.map(Number) : [], requested: Number(result.total || (input.problem_ids || []).length) },
      progress: { processed: Number(result.processed || 0), total: Number(result.total || (input.problem_ids || []).length), failed: Number(result.failed || failures.length), archived: Number(result.archived || 0), skipped: Number(result.skipped || 0) },
      current_object: result.current_problem_id == null ? null : { type: 'problem', id: String(result.current_problem_id) }, failures, error: safeJson(row.error_json, null),
      created_at: iso(row.created_at), updated_at: iso(row.updated_at)
    };
  }
  return {
    id: row.id, kind: 'problem_testdata', subtype: row.kind, state: row.state, stage: row.kind,
    actor_id: Number(row.actor_id), approved_by: null, impact: { problem_id: Number(row.problem_id) },
    progress: { processed: Number(row.progress || 0), total: 100, failed: row.state === 'failed' ? 1 : 0 },
    current_object: { type: 'problem', id: String(row.problem_id) }, failures: row.error_json ? [safeJson(row.error_json, {})] : [],
    error: safeJson(row.error_json, null), created_at: iso(row.created_at), updated_at: iso(row.updated_at)
  };
}

function serializeMigration(row) {
  return {
    id: row.id, kind: 'migration', subtype: row.domain, state: row.state, stage: row.domain,
    actor_id: Number(row.actor_id), approved_by: null, impact: { domain: row.domain, total: Number(row.total || 0) },
    progress: { processed: Number(row.processed || 0), total: Number(row.total || 0), failed: Number(row.failure_count || 0) },
    current_object: row.current_object ? { type: 'legacy_record', id: row.current_object } : null,
    failures: safeJson(row.failures_json, []), error: null, created_at: iso(row.created_at), updated_at: iso(row.updated_at)
  };
}

function serializeSubmission(row) {
  const publicKind = row.kind === 'projection_rebuild' ? 'submission_projection_rebuild' : 'submission_rejudge';
  return {
    id: row.id, kind: publicKind, subtype: row.kind, state: row.state, stage: row.kind,
    actor_id: Number(row.actor_id), approved_by: null, impact: { submission_id: Number(row.submission_id) },
    progress: { processed: Number(row.progress || 0), total: 100, failed: row.state === 'failed' ? 1 : 0 },
    current_object: { type: 'submission', id: String(row.submission_id) },
    failures: row.error_json ? [safeJson(row.error_json, {})] : [], error: safeJson(row.error_json, null),
    created_at: iso(row.created_at), updated_at: iso(row.updated_at)
  };
}

function serializeRejudgeBatch(row) {
  return {
    id: row.id, kind: 'submission_bulk_rejudge', subtype: 'rejudge',
    state: row.state, stage: row.stage, actor_id: Number(row.actor_id), approved_by: null,
    impact: { requested: Number(row.total || 0), filters: safeJson(row.filters_json, {}) },
    progress: {
      processed: Number(row.processed || 0), total: Number(row.total || 0),
      failed: Number(row.failed || 0), completed: Math.max(0, Number(row.processed || 0) - Number(row.failed || 0))
    },
    current_object: row.current_submission_id == null ? null : { type: 'submission', id: String(row.current_submission_id) },
    failures: safeJson(row.failures_json, []), error: safeJson(row.error_json, null),
    created_at: iso(row.created_at), updated_at: iso(row.updated_at)
  };
}

function serializeMaintenance(row) {
  return {
    id: row.id, kind: 'maintenance', subtype: row.kind, state: row.state, stage: row.kind,
    actor_id: Number(row.actor_id), approved_by: null,
    impact: { operation: row.kind, requested: Number(row.total || 0) },
    progress: { processed: Number(row.processed || 0), total: Number(row.total || 0), failed: row.state === 'failed' ? 1 : 0 },
    current_object: row.current_object ? { type: 'record', id: row.current_object } : null,
    failures: row.error_json ? [safeJson(row.error_json, {})] : [], error: safeJson(row.error_json, null),
    created_at: iso(row.created_at), updated_at: iso(row.updated_at)
  };
}

function serializeRating(row) {
  const diff = safeJson(row.diff_json, null);
  return {
    id: row.id, kind: 'rating_recalculation', subtype: row.profile_id, state: row.state, stage: row.stage,
    actor_id: Number(row.actor_id), approved_by: row.approved_by == null ? null : Number(row.approved_by),
    impact: { profile_id: row.profile_id, from_contest_id: row.from_contest_id == null ? null : Number(row.from_contest_id), changed_users: diff ? Number(diff.changed_users || 0) : null },
    progress: { processed: Number(row.processed || 0), total: Number(row.total || 0), failed: row.state === 'failed' ? 1 : 0 },
    current_object: row.current_user_id == null ? null : { type: 'user', id: String(row.current_user_id) },
    failures: row.error_json ? [safeJson(row.error_json, {})] : [], error: safeJson(row.error_json, null),
    created_at: iso(row.created_at), updated_at: iso(row.updated_at)
  };
}

function serializeStandings(row) {
  return {
    id: row.id, kind: 'standings_rebuild', subtype: String(row.contest_id), state: row.state, stage: row.stage,
    actor_id: Number(row.actor_id), approved_by: null,
    impact: { contest_id: Number(row.contest_id), result_version_id: row.result_version_id == null ? null : Number(row.result_version_id) },
    progress: { processed: Number(row.processed || 0), total: Number(row.total || 0), failed: row.state === 'failed' ? 1 : 0 },
    current_object: row.current_user_id == null ? null : { type: 'user', id: String(row.current_user_id) },
    failures: row.error_json ? [safeJson(row.error_json, {})] : [], error: safeJson(row.error_json, null),
    created_at: iso(row.created_at), updated_at: iso(row.updated_at)
  };
}

async function loadJobs(cursor, filters = {}) {
  await ensureJobSchemas();
  const connection = TypeORM.getConnection();
  const before = cursor && cursor.updated_at ? new Date(cursor.updated_at) : null;
  const state = String(filters.state || ''); const kind = String(filters.kind || ''); const params = [before, before, state, state, 151];
  const problemKinds = new Set(['problem_testdata', 'problem_bulk_action']);
  const [vjudgeRows, problemRows, submissionRows, rejudgeBatchRows, ratingRows, standingsRows, migrationRows, maintenanceRows] = await Promise.all([
    kind && kind !== 'vjudge_import' ? [] : connection.query("SELECT * FROM vjudge_v2_import_job WHERE (? IS NULL OR updated_at<=?) AND (?='' OR state=?) ORDER BY updated_at DESC,id DESC LIMIT ?", params),
    kind && !problemKinds.has(kind) ? [] : connection.query("SELECT * FROM problem_v2_job WHERE (? IS NULL OR updated_at<=?) AND (?='' OR state=?) ORDER BY updated_at DESC,id DESC LIMIT ?", params),
    kind && !['submission_rejudge', 'submission_projection_rebuild'].includes(kind) ? [] : connection.query("SELECT submission.* FROM submission_v2_job submission WHERE (? IS NULL OR submission.updated_at<=?) AND (?='' OR submission.state=?) AND NOT EXISTS (SELECT 1 FROM admin_v2_rejudge_item item WHERE item.child_job_id=submission.id) ORDER BY submission.updated_at DESC,submission.id DESC LIMIT ?", params),
    kind && kind !== 'submission_bulk_rejudge' ? [] : connection.query("SELECT * FROM admin_v2_rejudge_job WHERE (? IS NULL OR updated_at<=?) AND (?='' OR state=?) ORDER BY updated_at DESC,id DESC LIMIT ?", params),
    kind && kind !== 'rating_recalculation' ? [] : connection.query("SELECT * FROM rating_v2_job WHERE (? IS NULL OR updated_at<=?) AND (?='' OR state=?) ORDER BY updated_at DESC,id DESC LIMIT ?", params),
    kind && kind !== 'standings_rebuild' ? [] : connection.query("SELECT * FROM contest_v2_standings_job WHERE (? IS NULL OR updated_at<=?) AND (?='' OR state=?) ORDER BY updated_at DESC,id DESC LIMIT ?", params),
    kind && kind !== 'migration' ? [] : connection.query("SELECT * FROM api_v2_migration_run WHERE (? IS NULL OR updated_at<=?) AND (?='' OR state=?) ORDER BY updated_at DESC,id DESC LIMIT ?", params),
    kind && kind !== 'maintenance' ? [] : connection.query("SELECT * FROM admin_v2_maintenance_job WHERE (? IS NULL OR updated_at<=?) AND (?='' OR state=?) ORDER BY updated_at DESC,id DESC LIMIT ?", params)
  ]);
  return vjudgeRows.map(serializeVjudge)
    .concat(problemRows.map(serializeProblem), submissionRows.map(serializeSubmission), rejudgeBatchRows.map(serializeRejudgeBatch), ratingRows.map(serializeRating), standingsRows.map(serializeStandings), migrationRows.map(serializeMigration), maintenanceRows.map(serializeMaintenance))
    .filter(job => !kind || job.kind === kind);
}

function compareJobs(left, right) {
  return new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime() || right.id.localeCompare(left.id) || right.kind.localeCompare(left.kind);
}

function isBeforeCursor(job, cursor) {
  if (!cursor || !cursor.updated_at) return true;
  const delta = new Date(job.updated_at).getTime() - new Date(cursor.updated_at).getTime();
  if (delta !== 0) return delta < 0;
  if (job.id !== cursor.id) return job.id.localeCompare(String(cursor.id || '')) < 0;
  return job.kind.localeCompare(String(cursor.kind || '')) < 0;
}

async function findJob(id, expectedKind) {
  await ensureJobSchemas(); const connection = TypeORM.getConnection(); const jobs = [];
  if (!expectedKind || expectedKind === 'vjudge_import') { const rows = await connection.query('SELECT * FROM vjudge_v2_import_job WHERE id=? LIMIT 1', [id]); if (rows.length) jobs.push(serializeVjudge(rows[0])); }
  if (!expectedKind || ['problem_testdata', 'problem_bulk_action'].includes(expectedKind)) { const rows = await connection.query('SELECT * FROM problem_v2_job WHERE id=? LIMIT 1', [id]); if (rows.length) { const serialized = serializeProblem(rows[0]); if (!expectedKind || serialized.kind === expectedKind) jobs.push(serialized); } }
  if (!expectedKind || ['submission_rejudge', 'submission_projection_rebuild'].includes(expectedKind)) {
    const rows = await connection.query('SELECT * FROM submission_v2_job WHERE id=? LIMIT 1', [id]);
    if (rows.length) {
      const serialized = serializeSubmission(rows[0]);
      if (!expectedKind || serialized.kind === expectedKind) jobs.push(serialized);
    }
  }
  if (!expectedKind || expectedKind === 'submission_bulk_rejudge') {
    const rows = await connection.query('SELECT * FROM admin_v2_rejudge_job WHERE id=? LIMIT 1', [id]);
    if (rows.length) jobs.push(serializeRejudgeBatch(rows[0]));
  }
  if (!expectedKind || expectedKind === 'rating_recalculation') { const rows = await connection.query('SELECT * FROM rating_v2_job WHERE id=? LIMIT 1', [id]); if (rows.length) jobs.push(serializeRating(rows[0])); }
  if (!expectedKind || expectedKind === 'standings_rebuild') { const rows = await connection.query('SELECT * FROM contest_v2_standings_job WHERE id=? LIMIT 1', [id]); if (rows.length) jobs.push(serializeStandings(rows[0])); }
  if (!expectedKind || expectedKind === 'migration') { const rows = await connection.query('SELECT * FROM api_v2_migration_run WHERE id=? LIMIT 1', [id]); if (rows.length) jobs.push(serializeMigration(rows[0])); }
  if (!expectedKind || expectedKind === 'maintenance') { const rows = await connection.query('SELECT * FROM admin_v2_maintenance_job WHERE id=? LIMIT 1', [id]); if (rows.length) jobs.push(serializeMaintenance(rows[0])); }
  return jobs[0] || null;
}

const JOB_CAPABILITIES = Object.freeze({
  vjudge_import: 'vjudge:import.create', problem_testdata: 'problem:testdata.write', problem_bulk_action: 'problem:archive',
  submission_rejudge: 'submission:rejudge', submission_projection_rebuild: 'submission:rejudge',
  submission_bulk_rejudge: 'submission:rejudge',
  rating_recalculation: 'rating:recalculate',
  standings_rebuild: 'contest:standings.rebuild', migration: 'admin:job.manage', maintenance: 'admin:job.manage'
});
async function requireJobCapability(req, res, job) {
  const capability = JOB_CAPABILITIES[job.kind] || 'admin:job.manage';
  if (!await can(res.locals.user, capability)) { api().fail(res, 403, 'CAPABILITY_REQUIRED', `Capability required: ${capability}.`); return false; }
  return true;
}

function jobEventStream(job) {
  if (job.kind === 'vjudge_import') return `vjudge-import:${job.id}`;
  if (job.kind === 'problem_testdata' || job.kind === 'problem_bulk_action') return `problem-job:${job.id}`;
  if (job.kind === 'submission_rejudge' || job.kind === 'submission_projection_rebuild') return `submission-job:${job.id}`;
  if (job.kind === 'submission_bulk_rejudge') return `submission-rejudge-job:${job.id}`;
  if (job.kind === 'rating_recalculation') return `rating-job:${job.id}`;
  if (job.kind === 'standings_rebuild') return `standings-job:${job.id}`;
  if (job.kind === 'migration') return `migration:${job.id}`;
  if (job.kind === 'maintenance') return 'maintenance-job:' + job.id;
  return null;
}

async function appendJobEvent(job, type, actor, payload = {}) {
  const stream = jobEventStream(job);
  if (!stream) return null;
  return api().appendEvent({ stream, type, aggregateId: job.id, actor, payload: { kind: job.kind, ...payload } });
}

app.get('/api/v2/admin/overview', requireCapability('admin:health.read'), async (req, res) => {
  try {
    const rows = await TypeORM.getConnection().query(`SELECT
      (SELECT COUNT(*) FROM judge_state WHERE pending=1) AS pending_judgements,
      (SELECT COUNT(*) FROM judge_state WHERE pending=1 AND submit_time<UNIX_TIMESTAMP()-900) AS stale_judgements,
      (SELECT COUNT(*) FROM problem_solution WHERE status='pending') AS pending_solutions,
      (SELECT COUNT(*) FROM ticket WHERE status IN ('pending','in_progress')) AS open_tickets,
      (SELECT COUNT(*) FROM user) AS users,(SELECT COUNT(*) FROM problem) AS problems,
      (SELECT COUNT(*) FROM contest) AS contests,
      (SELECT COUNT(*) FROM auth_user_state WHERE status='disabled') AS disabled_users,
      (SELECT COUNT(*) FROM judge_state WHERE pending=0 AND submit_time>=UNIX_TIMESTAMP()-86400 AND status IN ('System Error','Judgement Failed','Unknown')) AS judge_failures`);
    const row = rows[0] || {};
    return api().send(res, { status: 'ok', counts: { users: Number(row.users || 0), disabled_users: Number(row.disabled_users || 0), problems: Number(row.problems || 0), contests: Number(row.contests || 0), open_tickets: Number(row.open_tickets || 0), pending_solutions: Number(row.pending_solutions || 0) }, queue: { pending_judgements: Number(row.pending_judgements || 0), stale_judgements: Number(row.stale_judgements || 0) }, risks: { judge_failures_24h: Number(row.judge_failures || 0) } });
  } catch (error) { return api().fail(res, 503, 'DEPENDENCY_UNAVAILABLE', 'Admin overview is temporarily unavailable.'); }
});

app.get('/api/v2/admin/health', requireCapability('admin:health.read'), async (req, res) => {
  try {
    await TypeORM.getConnection().query('SELECT 1');
    const workers = await syzoj.utils.loadJudgeWorkerStatusV2();
    return api().send(res, { status: 'healthy', dependencies: { database: 'healthy', judge_control: 'healthy' }, judge: workers.summary });
  } catch (error) { return api().send(res, { status: 'degraded', dependencies: { database: 'unknown', judge_control: 'unavailable' } }, 200); }
});

app.get('/api/v2/admin/risk-signals', requireCapability('admin:health.read'), async (req, res) => {
  const rows = await TypeORM.getConnection().query(`SELECT id,problem_id,user_id,status,submit_time FROM judge_state WHERE pending=1 AND submit_time<UNIX_TIMESTAMP()-900 ORDER BY submit_time ASC LIMIT 100`);
  const failures = await TypeORM.getConnection().query(`SELECT id,problem_id,user_id,status,submit_time FROM judge_state WHERE pending=0 AND submit_time>=UNIX_TIMESTAMP()-86400 AND status IN ('System Error','Judgement Failed','Unknown') ORDER BY submit_time DESC LIMIT 100`);
  return api().send(res, { stale_submissions: rows.map(row => ({ id: Number(row.id), problem_id: Number(row.problem_id), user_id: Number(row.user_id), status: row.status, submitted_at: new Date(Number(row.submit_time) * 1000).toISOString() })), judge_failures: failures.map(row => ({ id: Number(row.id), problem_id: Number(row.problem_id), user_id: Number(row.user_id), status: row.status, submitted_at: new Date(Number(row.submit_time) * 1000).toISOString() })) });
});

app.get('/api/v2/admin/jobs', requireCapability('admin:job.manage'), async (req, res) => {
  const limit = api().parseLimit(req, 50, 100); const cursor = api().decodeCursor(req.query.cursor); const state = String(req.query.state || ''); const kind = String(req.query.kind || '');
  if (state && !JOB_STATES.has(state)) return api().fail(res, 422, 'VALIDATION_FAILED', 'Job state is invalid.', { state: 'invalid' });
  let jobs = (await loadJobs(cursor, { state, kind })).filter(job => isBeforeCursor(job, cursor));
  jobs.sort(compareJobs); const more = jobs.length > limit; const page = jobs.slice(0, limit); const last = page[page.length - 1];
  res.locals.apiMeta.next_cursor = more && last ? api().encodeCursor({ updated_at: last.updated_at, id: last.id, kind: last.kind }) : null;
  res.locals.apiMeta.limit = limit; return api().send(res, page);
});

app.get('/api/v2/admin/jobs/:id', requireCapability('admin:job.manage'), async (req, res) => {
  const job = await findJob(req.params.id, req.query.kind ? String(req.query.kind) : null);
  if (!job) return api().fail(res, 404, 'JOB_NOT_FOUND', 'Job was not found.');
  return api().send(res, job);
});

app.get('/api/v2/admin/jobs/:id/events', requireCapability('admin:job.manage'), async (req, res) => {
  const job = await findJob(req.params.id, req.query.kind ? String(req.query.kind) : null);
  if (!job) return api().fail(res, 404, 'JOB_NOT_FOUND', 'Job was not found.');
  const stream = jobEventStream(job);
  if (!stream) return api().fail(res, 409, 'JOB_EVENTS_UNAVAILABLE', 'This job does not expose an event stream.');
  return api().sse(req, res, stream);
});

async function cancelJob(req, res, expectedKind) {
  const reason = operationReason(req);
  const job = await findJob(req.params.id, expectedKind); if (!job) return api().fail(res, 404, 'JOB_NOT_FOUND', 'Job was not found.');
  if (!await requireJobCapability(req, res, job)) return;
  if (TERMINAL_STATES.has(job.state)) return api().fail(res, 409, 'JOB_TERMINAL', 'The job has already finished.');
  const nextState = job.state === 'running' ? 'cancelling' : 'cancelled'; const connection = TypeORM.getConnection();
  if (job.kind === 'vjudge_import') await connection.query('UPDATE vjudge_v2_import_job SET cancel_requested=1,state=?,stage=?,cancelled_at=CASE WHEN ?=\'cancelled\' THEN UTC_TIMESTAMP(3) ELSE cancelled_at END,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [nextState, nextState, nextState, job.id]);
  if (job.kind === 'problem_testdata' || job.kind === 'problem_bulk_action') await connection.query('UPDATE problem_v2_job SET cancel_requested=1,state=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [nextState, job.id]);
  if (['submission_rejudge', 'submission_projection_rebuild'].includes(job.kind)) await connection.query('UPDATE submission_v2_job SET cancel_requested=1,state=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [nextState, job.id]);
  if (job.kind === 'submission_bulk_rejudge') {
    await connection.query('UPDATE admin_v2_rejudge_job SET cancel_requested=1,state=?,stage=?,updated_at=UTC_TIMESTAMP(3),completed_at=CASE WHEN ?=\'cancelled\' THEN UTC_TIMESTAMP(3) ELSE completed_at END WHERE id=?', [nextState, nextState, nextState, job.id]);
    if (nextState === 'cancelled') {
      await connection.query("UPDATE admin_v2_rejudge_item SET state='cancelled',updated_at=UTC_TIMESTAMP(3) WHERE job_id=? AND state='pending'", [job.id]);
    } else {
      await connection.query("UPDATE submission_v2_job submission JOIN admin_v2_rejudge_item item ON item.child_job_id=submission.id SET submission.cancel_requested=1,submission.state=CASE WHEN submission.state='running' THEN 'cancelling' ELSE 'cancelled' END,submission.updated_at=UTC_TIMESTAMP(3) WHERE item.job_id=? AND item.state='running'", [job.id]);
    }
  }
  if (job.kind === 'rating_recalculation') await connection.query('UPDATE rating_v2_job SET cancel_requested=1,state=?,stage=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [nextState, nextState, job.id]);
  if (job.kind === 'standings_rebuild') await connection.query('UPDATE contest_v2_standings_job SET cancel_requested=1,state=?,stage=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [nextState, nextState, job.id]);
  if (job.kind === 'migration') await connection.query('UPDATE api_v2_migration_run SET cancel_requested=1,state=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [nextState, job.id]);
  if (job.kind === 'maintenance') await connection.query("UPDATE admin_v2_maintenance_job SET cancel_requested=1,state=?,completed_at=CASE WHEN ?='cancelled' THEN UTC_TIMESTAMP(3) ELSE completed_at END,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [nextState, nextState, job.id]);
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'admin:job.cancel', resourceType: 'job', resourceId: job.id, reason, details: { kind: job.kind, previous_state: job.state } });
  await appendJobEvent(job, 'job.cancel.requested', res.locals.user, { previous_state: job.state, state: nextState, audit_event_id: auditEventId });
  return api().send(res, { id: job.id, kind: job.kind, state: nextState, audit_event_id: auditEventId }, nextState === 'cancelling' ? 202 : 200);
}

app.post('/api/v2/admin/jobs/:id/cancel', requireCapability('admin:job.manage', { recent: true }), (req, res) => cancelJob(req, res));
app.post('/api/v2/admin/jobs/:kind/:id/cancel', requireCapability('admin:job.manage', { recent: true }), (req, res) => cancelJob(req, res, req.params.kind));

app.post('/api/v2/admin/jobs/:id/retry', requireCapability('admin:job.manage', { recent: true }), async (req, res) => {
  const reason = operationReason(req); const job = await findJob(req.params.id);
  if (!job) return api().fail(res, 404, 'JOB_NOT_FOUND', 'Job was not found.');
  if (!await requireJobCapability(req, res, job)) return;
  if (!['failed', 'cancelled', 'completed'].includes(job.state)) return api().fail(res, 409, 'JOB_NOT_RETRYABLE', 'Only failed, cancelled, or partially completed jobs can be retried.');
  if (job.kind === 'rating_recalculation' && job.state === 'completed' && job.stage === 'completed') return api().fail(res, 409, 'JOB_NOT_RETRYABLE', 'An applied Rating recalculation must be rolled back before it can be run again.');
  if (job.kind === 'submission_bulk_rejudge' && job.state === 'completed' && Number(job.progress.failed || 0) === 0) return api().fail(res, 409, 'JOB_NOT_RETRYABLE', 'A completed bulk rejudge without failures cannot be retried.');
  const connection = TypeORM.getConnection();
  if (job.kind === 'vjudge_import') {
    await connection.query("UPDATE vjudge_v2_import_item SET state='retrying',error_code=NULL,error_message=NULL,updated_at=UTC_TIMESTAMP(3) WHERE job_id=? AND state='failed' AND attempts<3", [job.id]);
    await connection.query("UPDATE vjudge_v2_import_job SET state='queued',stage='retrying',cancel_requested=0,error_json=NULL,failures_json=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [job.id]);
    setImmediate(() => syzoj.utils.vjudgeV2.runImportJob(job.id));
  } else if (job.kind === 'problem_testdata' || job.kind === 'problem_bulk_action') {
    await connection.query("UPDATE problem_v2_job SET state='queued',progress=0,cancel_requested=0,result_json=NULL,error_json=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [job.id]);
    setImmediate(() => syzoj.utils.problemWorkflowV2.run(job.id));
  } else if (['submission_rejudge', 'submission_projection_rebuild'].includes(job.kind)) {
    await connection.query("UPDATE submission_v2_job SET state='queued',progress=0,cancel_requested=0,error_json=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [job.id]);
    setImmediate(() => syzoj.utils.submissionV2.runSubmissionJob(job.id));
  } else if (job.kind === 'submission_bulk_rejudge') {
    await connection.query("UPDATE admin_v2_rejudge_item SET state='pending',error_json=NULL,updated_at=UTC_TIMESTAMP(3) WHERE job_id=? AND state IN ('failed','cancelled')", [job.id]);
    const counts = await connection.query("SELECT SUM(state='completed') AS completed FROM admin_v2_rejudge_item WHERE job_id=?", [job.id]);
    await connection.query("UPDATE admin_v2_rejudge_job SET state='queued',stage='queued',processed=?,failed=0,current_submission_id=NULL,cancel_requested=0,failures_json=NULL,error_json=NULL,completed_at=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [Number(counts[0] && counts[0].completed || 0), job.id]);
    setImmediate(() => runRejudgeBatchJob(job.id));
  } else if (job.kind === 'rating_recalculation') {
    await connection.query("UPDATE rating_v2_job SET state='queued',stage='preview',processed=0,total=0,current_user_id=NULL,cancel_requested=0,diff_json=NULL,rollback_json=NULL,error_json=NULL,approved_by=NULL,completed_at=NULL,rolled_back_at=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [job.id]);
    setImmediate(() => syzoj.utils.ratingV2.run(job.id));
  } else if (job.kind === 'standings_rebuild') {
    await connection.query("UPDATE contest_v2_standings_job SET state='queued',stage='retrying',processed=0,total=0,current_user_id=NULL,cancel_requested=0,result_version_id=NULL,error_json=NULL,completed_at=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [job.id]);
    setImmediate(() => syzoj.utils.contestStandingsV2.runRebuildJob(job.id));
  } else if (job.kind === 'migration') {
    await connection.query("UPDATE api_v2_migration_run SET state='queued',processed=0,failure_count=0,failures_json=NULL,cancel_requested=0,current_object=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [job.id]);
    setImmediate(() => syzoj.utils.migrationV2.run(job.id, job.subtype));
  } else if (job.kind === 'maintenance') {
    await connection.query("UPDATE admin_v2_maintenance_job SET state='queued',processed=0,total=0,current_object=NULL,cancel_requested=0,error_json=NULL,completed_at=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [job.id]);
    setImmediate(() => runMaintenanceJob(job.id));
  }
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'admin:job.retry', resourceType: 'job', resourceId: job.id, reason, details: { kind: job.kind, previous_state: job.state } });
  await appendJobEvent(job, 'job.retry.queued', res.locals.user, { previous_state: job.state, state: 'queued', audit_event_id: auditEventId });
  return api().send(res, { id: job.id, kind: job.kind, state: 'queued', audit_event_id: auditEventId }, 202);
});

app.get('/api/v2/admin/users', requireCapability('admin:user.manage'), async (req, res) => {
  await syzoj.utils.ensureAccountStateSchema(); const limit = api().parseLimit(req, 50, 100); const cursor = Number(api().decodeCursor(req.query.cursor) || 0); const keyword = String(req.query.q || '').trim();
  const rows = await TypeORM.getConnection().query(`SELECT u.id,u.username,u.email,u.is_admin,u.is_show,u.rating,u.register_time,COALESCE(state.status,'active') AS account_status,state.reason AS disabled_reason,state.changed_at AS status_changed_at FROM user u LEFT JOIN auth_user_state state ON state.user_id=u.id WHERE u.id>? AND (?='' OR u.username LIKE CONCAT('%',?,'%') OR u.email LIKE CONCAT('%',?,'%')) ORDER BY u.id ASC LIMIT ?`, [cursor, keyword, keyword, keyword, limit + 1]);
  const more = rows.length > limit; res.locals.apiMeta.limit = limit; res.locals.apiMeta.next_cursor = more ? api().encodeCursor(rows[limit - 1].id) : null;
  return api().send(res, rows.slice(0, limit).map(row => ({ id: Number(row.id), username: row.username, email: row.email ? '[redacted]' : null, is_admin: !!row.is_admin, visible_in_rankings: !!row.is_show, account_status: row.account_status, disabled_reason: row.account_status === 'disabled' ? row.disabled_reason : null, status_changed_at: iso(row.status_changed_at), rating: Number(row.rating || 1500), registered_at: row.register_time ? new Date(Number(row.register_time) * 1000).toISOString() : null })));
});

function managedUserError(code, message, statusCode, fields) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.fields = fields || {};
  return error;
}

function assertManagedUserAccess(target, actor) {
  if (!target) throw managedUserError('USER_NOT_FOUND', 'User was not found.', 404);
  const targetId = Number(target.id);
  const actorId = Number(actor.id);
  const ownerId = Number(syzoj.siteOwnerUserId || 0);
  const actorIsOwner = actorId === ownerId;
  if (targetId === Number(syzoj.deletedAccountUserId || 0)) throw managedUserError('USER_NOT_FOUND', 'User was not found.', 404);
  if (targetId === ownerId && !actorIsOwner) throw managedUserError('OWNER_ACCOUNT_PROTECTED', 'Only the site owner can edit the site owner account.', 403);
  if (target.is_admin && targetId !== actorId && !actorIsOwner) throw managedUserError('OWNER_CAPABILITY_REQUIRED', 'Only the site owner can edit another site administrator.', 403);
  return { actorIsOwner, ownerId, targetId };
}

function managedUserResource(target, profile, privileges) {
  return {
    id: Number(target.id),
    username: target.username,
    email: target.email || '',
    information: target.information || '',
    sex: String(target.sex == null ? 0 : target.sex),
    public_email: !!target.public_email,
    prefer_formatted_code: !!target.prefer_formatted_code,
    is_admin: !!target.is_admin,
    is_site_owner: Number(target.id) === Number(syzoj.siteOwnerUserId || 0),
    identity: syzoj.utils.registrationIdentityV2.profileResource(profile),
    privileges: Array.from(new Set(privileges || [])).sort()
  };
}

async function managedUserRead(targetId) {
  await syzoj.utils.registrationIdentityV2.ensureRegistrationSchema();
  const [users, profiles, privileges] = await Promise.all([
    TypeORM.getConnection().query('SELECT id,username,email,password,information,sex,public_email,prefer_formatted_code,is_admin FROM user WHERE id=? LIMIT 1', [targetId]),
    TypeORM.getConnection().query('SELECT student_id,real_name,college FROM user_registration_profile WHERE user_id=? LIMIT 1', [targetId]),
    TypeORM.getConnection().query('SELECT privilege FROM user_privilege WHERE user_id=? ORDER BY privilege', [targetId])
  ]);
  return { target: users[0] || null, profile: profiles[0] || null, privileges: privileges.map(row => row.privilege) };
}

function managedUserFailure(res, error) {
  const registrationCode = Number(error && error.registrationCode);
  if (registrationCode === 2011) return api().fail(res, 422, 'VALIDATION_FAILED', error.message, { student_id: 'invalid' });
  if (registrationCode === 2012) return api().fail(res, 422, 'VALIDATION_FAILED', error.message, { real_name: 'invalid' });
  if (registrationCode === 2013) return api().fail(res, 422, 'VALIDATION_FAILED', error.message, { college: 'invalid' });
  if (registrationCode === 2014) return api().fail(res, 409, 'STUDENT_ID_ALREADY_USED', error.message, { student_id: 'already used' });
  if (error && error.code === 'ER_DUP_ENTRY') {
    const message = String(error.message || '');
    const field = /student/i.test(message) ? 'student_id' : /username/i.test(message) ? 'username' : 'email';
    const code = field === 'student_id' ? 'STUDENT_ID_ALREADY_USED' : field === 'username' ? 'USERNAME_ALREADY_USED' : 'EMAIL_ALREADY_USED';
    return api().fail(res, 409, code, `${field} is already in use.`, { [field]: 'already used' });
  }
  if (error && Number.isInteger(error.statusCode)) return api().fail(res, error.statusCode, error.code || 'USER_UPDATE_FAILED', error.message, error.fields);
  syzoj.log('[admin-user-v2] ' + (error && (error.stack || error.message) || error));
  return api().fail(res, 500, 'USER_UPDATE_FAILED', 'The user profile could not be updated.');
}

app.get('/api/v2/admin/users/:id', requireCapability('admin:user.manage'), async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isSafeInteger(targetId) || targetId < 1) return api().fail(res, 422, 'VALIDATION_FAILED', 'User ID is invalid.', { id: 'invalid' });
  try {
    const loaded = await managedUserRead(targetId);
    assertManagedUserAccess(loaded.target, res.locals.user);
    const resource = managedUserResource(loaded.target, loaded.profile, loaded.privileges);
    if (api().apiNotModified(req, res, resource)) return;
    return api().send(res, resource);
  } catch (error) {
    return managedUserFailure(res, error);
  }
});

app.patch('/api/v2/admin/users/:id', requireCapability('admin:user.manage'), async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isSafeInteger(targetId) || targetId < 1) return api().fail(res, 422, 'VALIDATION_FAILED', 'User ID is invalid.', { id: 'invalid' });
  if (!req.get('If-Match')) return api().fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when editing a user.', { if_match: 'required' });
  const body = req.body || {};
  const actor = res.locals.user;
  const actorIsOwner = Number(actor.id) === Number(syzoj.siteOwnerUserId || 0);
  const hasPrivileges = Object.prototype.hasOwnProperty.call(body, 'privileges');
  const hasAdminStatus = Object.prototype.hasOwnProperty.call(body, 'is_admin');
  if ((body.new_password || hasPrivileges || hasAdminStatus) && !syzoj.utils.authorizationV2.recentLoginSatisfied(req)) {
    return api().fail(res, 403, 'RECENT_LOGIN_REQUIRED', 'Sign in again or complete MFA before changing a password or permissions.');
  }
  const canGrant = !hasPrivileges || await syzoj.utils.authorizationV2.authorize(actor, 'admin:permission.grant', null, { scope: 'global' });
  if (!canGrant) return api().fail(res, 403, 'CAPABILITY_REQUIRED', 'Capability required: admin:permission.grant.');
  if (hasAdminStatus && !actorIsOwner) return api().fail(res, 403, 'OWNER_CAPABILITY_REQUIRED', 'Only the site owner can change site administrator status.');
  const requestedPrivileges = hasPrivileges
    ? Array.from(new Set((Array.isArray(body.privileges) ? body.privileges : [body.privileges]).map(String))).filter(value => LEGACY_MANAGED_PRIVILEGE_SET.has(value)).sort()
    : null;
  if (hasPrivileges && requestedPrivileges.length !== (Array.isArray(body.privileges) ? body.privileges : [body.privileges]).length) {
    return api().fail(res, 422, 'VALIDATION_FAILED', 'One or more privileges are invalid.', { privileges: 'unsupported privilege' });
  }
  let passwordHash = null;
  try {
    if (body.new_password) passwordHash = await syzoj.utils.hashPassword(body.new_password);
  } catch (error) {
    return api().fail(res, 422, 'VALIDATION_FAILED', error.message, { new_password: 'invalid' });
  }
  try {
    await Promise.all([api().ensureFoundationSchema(), syzoj.utils.registrationIdentityV2.ensureRegistrationSchema()]);
    const saved = await TypeORM.getConnection().transaction(async manager => {
      const userRows = await manager.query('SELECT id,username,email,password,information,sex,public_email,prefer_formatted_code,is_admin FROM user WHERE id=? FOR UPDATE', [targetId]);
      const target = userRows[0] || null;
      const access = assertManagedUserAccess(target, actor);
      const profileRows = await manager.query('SELECT student_id,real_name,college FROM user_registration_profile WHERE user_id=? FOR UPDATE', [targetId]);
      const privilegeRows = await manager.query('SELECT privilege FROM user_privilege WHERE user_id=? FOR UPDATE', [targetId]);
      const currentPrivileges = privilegeRows.map(row => row.privilege);
      const current = managedUserResource(target, profileRows[0], currentPrivileges);
      if (!api().ifMatch(req, current)) throw managedUserError('ETAG_MISMATCH', 'The user profile changed. Refresh it and try again.', 412);

      const username = body.username == null ? target.username : String(body.username).trim();
      const email = body.email == null ? String(target.email || '') : String(body.email).trim().toLowerCase();
      if (!syzoj.utils.isValidUsername(username)) throw managedUserError('VALIDATION_FAILED', 'Username is invalid.', 422, { username: 'invalid' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw managedUserError('VALIDATION_FAILED', 'Email is invalid.', 422, { email: 'invalid' });
      if (access.targetId === access.ownerId && username !== target.username) throw managedUserError('OWNER_ACCOUNT_PROTECTED', 'The site owner username cannot be changed.', 403);
      const isAdmin = hasAdminStatus ? inputBoolean(body.is_admin, !!target.is_admin) : !!target.is_admin;
      if (access.targetId === access.ownerId && !isAdmin) throw managedUserError('OWNER_ACCOUNT_PROTECTED', 'The site owner administrator status cannot be removed.', 403);
      const emailChanged = email !== String(target.email || '').trim().toLowerCase();
      const passwordChanged = !!passwordHash;
      if (access.targetId === Number(actor.id) && (emailChanged || passwordChanged) && !await syzoj.utils.verifyPassword(body.current_password, target.password)) {
        throw managedUserError('CURRENT_PASSWORD_REQUIRED', 'The current password is required to change email or password.', 403, { current_password: 'incorrect' });
      }
      const duplicateUsers = await manager.query('SELECT id,username,email FROM user WHERE id<>? AND (username=? OR email=?) LIMIT 1 FOR UPDATE', [targetId, username, email]);
      if (duplicateUsers.length) {
        const conflict = new Error(duplicateUsers[0].username === username ? 'Duplicate username' : 'Duplicate email');
        conflict.code = 'ER_DUP_ENTRY';
        throw conflict;
      }
      const identitySubmitted = ['student_id', 'real_name', 'college'].some(field => Object.prototype.hasOwnProperty.call(body, field));
      const identity = identitySubmitted
        ? await syzoj.utils.registrationIdentityV2.saveProfileFields(manager, targetId, body, true)
        : syzoj.utils.registrationIdentityV2.profileResource(profileRows[0]);
      const information = body.information == null ? String(target.information || '') : String(body.information).slice(0, 10000);
      const sex = body.sex == null ? String(target.sex == null ? 0 : target.sex) : String(body.sex).slice(0, 20);
      const publicEmail = inputBoolean(body.public_email, !!target.public_email);
      const formattedCode = inputBoolean(body.prefer_formatted_code, !!target.prefer_formatted_code);
      await manager.query('UPDATE user SET username=?,email=?,information=?,sex=?,public_email=?,prefer_formatted_code=?,is_admin=?' + (passwordHash ? ',password=?' : '') + ' WHERE id=?', passwordHash
        ? [username, email, information, sex, publicEmail ? 1 : 0, formattedCode ? 1 : 0, isAdmin ? 1 : 0, passwordHash, targetId]
        : [username, email, information, sex, publicEmail ? 1 : 0, formattedCode ? 1 : 0, isAdmin ? 1 : 0, targetId]);
      if (emailChanged) {
        await manager.query('UPDATE user_email_status SET is_email_verified=0,verified_email=NULL,verified_at=NULL,last_send_at=NULL WHERE user_id=?', [targetId]);
        await manager.query("UPDATE email_verification_token SET used=1 WHERE user_id=? AND purpose='verify_email' AND used=0", [targetId]);
      }
      const nextPrivileges = requestedPrivileges || currentPrivileges;
      if (requestedPrivileges) {
        await manager.query('DELETE FROM user_privilege WHERE user_id=?', [targetId]);
        for (const privilege of requestedPrivileges) {
          await manager.query('INSERT INTO user_privilege (user_id,privilege) VALUES (?,?)', [targetId, privilege]);
        }
      }
      const changedFields = ['username', 'email', 'information', 'sex', 'public_email', 'prefer_formatted_code', 'is_admin', 'privileges', 'student_id', 'real_name', 'college', 'new_password']
        .filter(field => Object.prototype.hasOwnProperty.call(body, field));
      const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
        action: 'admin:user.update', resourceType: 'user', resourceId: targetId,
        details: { changed_fields: changedFields, email_changed: emailChanged, password_changed: passwordChanged }
      }, manager);
      const eventId = await contentDomain.appendEvent(manager, {
        stream: `identity:user:${targetId}`, type: 'user.profile.updated', aggregateId: targetId,
        actorId: actor.id, payload: { changed_fields: changedFields, audit_event_id: auditEventId }
      });
      return {
        resource: managedUserResource({ ...target, username, email, information, sex, public_email: publicEmail, prefer_formatted_code: formattedCode, is_admin: isAdmin }, identity, nextPrivileges),
        emailChanged, passwordChanged, auditEventId, eventId
      };
    });
    if (saved.passwordChanged) {
      await syzoj.utils.revokeUserSessions(req, targetId);
      if (targetId === Number(actor.id)) await syzoj.utils.establishAuthenticatedSession(req, targetId);
    }
    if (saved.emailChanged && syzoj.utils.refreshVerifiedCache) await syzoj.utils.refreshVerifiedCache();
    User.deleteFromCache(targetId);
    if (syzoj.utils.invalidateUserRequestStateCache) syzoj.utils.invalidateUserRequestStateCache(targetId);
    if (typeof syzoj.refreshAdminUserIds === 'function') await syzoj.refreshAdminUserIds();
    if (syzoj.utils.refreshUserTagsCache) await syzoj.utils.refreshUserTagsCache();
    if (syzoj.utils.refreshAvatarCache) await syzoj.utils.refreshAvatarCache();
    return api().send(res, { ...saved.resource, audit_event_id: saved.auditEventId, event_id: saved.eventId });
  } catch (error) {
    return managedUserFailure(res, error);
  }
});

async function changeUserStatus(req, res, status) {
  const reason = operationReason(req); const targetId = Number(req.params.id); const actor = res.locals.user;
  if (!Number.isSafeInteger(targetId) || targetId < 1) return api().fail(res, 422, 'VALIDATION_FAILED', 'User ID is invalid.', { id: 'invalid' });
  if (targetId === Number(actor.id)) return api().fail(res, 409, 'SELF_ACCOUNT_STATUS_FORBIDDEN', 'You cannot change your own account status.');
  const rows = await TypeORM.getConnection().query('SELECT id,username,is_admin FROM user WHERE id=? LIMIT 1', [targetId]);
  if (!rows.length) return api().fail(res, 404, 'USER_NOT_FOUND', 'User was not found.'); const target = rows[0];
  const actorIsOwner = Number(actor.id) === Number(syzoj.siteOwnerUserId || 0);
  if (targetId === Number(syzoj.siteOwnerUserId || 0)) return api().fail(res, 403, 'OWNER_ACCOUNT_PROTECTED', 'The site owner account cannot be disabled.');
  if (target.is_admin && !actorIsOwner) return api().fail(res, 403, 'OWNER_CAPABILITY_REQUIRED', 'Only the site owner can change a site administrator account.');
  await syzoj.utils.ensureAccountStateSchema(); await TypeORM.getConnection().query(`INSERT INTO auth_user_state (user_id,status,reason,changed_by,changed_at) VALUES (?,?,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE status=VALUES(status),reason=VALUES(reason),changed_by=VALUES(changed_by),changed_at=UTC_TIMESTAMP(3)`, [targetId, status, reason, actor.id]);
  if (status === 'disabled') await syzoj.utils.revokeUserSessions(req, targetId); User.deleteFromCache(targetId);
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: `admin:user.${status === 'disabled' ? 'disable' : 'enable'}`, resourceType: 'user', resourceId: targetId, reason, details: { username: target.username } });
  await api().appendEvent({ stream: `identity:user:${targetId}`, type: `user.${status}`, aggregateId: targetId, actor, payload: { audit_event_id: auditEventId } });
  return api().send(res, { id: targetId, account_status: status, audit_event_id: auditEventId });
}

app.post('/api/v2/admin/users/:id/disable', requireCapability('admin:user.manage', { recent: true }), (req, res) => changeUserStatus(req, res, 'disabled'));
app.post('/api/v2/admin/users/:id/enable', requireCapability('admin:user.manage', { recent: true }), (req, res) => changeUserStatus(req, res, 'active'));
app.delete('/api/v2/admin/users/:id', requireCapability('admin:user.manage', { recent: true }), async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isSafeInteger(targetId) || targetId < 1) {
    return api().fail(res, 422, 'VALIDATION_FAILED', 'User ID is invalid.', { id: 'invalid' });
  }
  try {
    const result = await syzoj.utils.adminUserManagementV2.deleteUserAccount(req, res.locals.user, targetId);
    res.set('X-Audit-Event-ID', String(result.auditEventId));
    return api().send(res, {
      id: targetId,
      username: result.username,
      deleted: true,
      audit_event_id: String(result.auditEventId)
    });
  } catch (error) {
    syzoj.log('[admin-users-v2] delete failed: ' + (error.stack || error.message || error));
    const status = Number(error.statusCode || 500);
    const code = error.code || (status === 409 ? 'USER_DELETE_CONFLICT' : 'USER_DELETE_FAILED');
    return api().fail(res, status, code, error.message || 'The user could not be deleted.');
  }
});

async function workersResponse(req, res) {
  try { const data = await syzoj.utils.loadJudgeWorkerStatusV2(); return api().send(res, { project: data.project, summary: data.summary, queue: data.queue || [], workers: (data.containers || []).map(worker => ({ id: worker.id || worker.Id, name: worker.name || worker.Name, service: worker.service || null, state: worker.status || worker.State || worker.state, health: worker.health || null, running: !!worker.running, oom_killed: !!worker.oomKilled, restart_count: Number(worker.restartCount || 0), cpu_percent: Number(worker.cpuPercent || 0), memory_mib: Number(worker.memoryMiB || 0), pids: Number(worker.pids || 0), started_at: Number(worker.startedAt || 0) || null })) }); }
  catch (error) { return api().fail(res, 503, 'DEPENDENCY_UNAVAILABLE', 'Judge worker status is unavailable.'); }
}
app.get('/api/v2/admin/judge-workers', requireCapability('judge:read'), workersResponse);
app.get('/api/v2/admin/workers', requireCapability('judge:read'), workersResponse);

app.post('/api/v2/admin/services/web/restart', requireCapability('admin:config.write', { recent: true }), async (req, res) => {
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
    action: 'admin:web.restart.request',
    resourceType: 'service',
    resourceId: 'web',
    reason: syzoj.utils.operationReason(req, '重启 Web 服务')
  });
  const event = await api().appendEvent({
    stream: 'admin:service:web',
    type: 'service.restart.requested',
    aggregateId: 'web',
    actor: res.locals.user,
    payload: { audit_event_id: auditEventId }
  });
  res.once('finish', () => {
    syzoj.utils.restartWebServiceV2().catch(error => {
      syzoj.log('[web-restart-v2] ' + (error.stack || error));
    });
  });
  return api().send(res, {
    service: 'web',
    state: 'restart_requested',
    audit_event_id: auditEventId,
    event_id: String(event.id)
  }, 202);
});

app.post('/api/v2/admin/judge-workers/:id/restart', requireCapability('judge:worker.restart', { recent: true }), async (req, res) => {
  const reason = operationReason(req);
  try {
    const result = await syzoj.utils.restartJudgeWorkerV2(String(req.params.id || ''));
    const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'judge:worker.restart', resourceType: 'judge_worker', resourceId: result.id, reason, details: { name: result.name } });
    return api().send(res, { id: result.id, name: result.name, state: 'restarted', audit_event_id: auditEventId });
  } catch (error) { return api().fail(res, error.statusCode || 503, error.statusCode === 404 ? 'JUDGE_WORKER_NOT_FOUND' : error.statusCode === 409 ? 'JUDGE_WORKER_RESTARTING' : error.statusCode === 422 ? 'VALIDATION_FAILED' : 'JUDGE_CONTROL_UNAVAILABLE', error.message || 'Judge worker restart failed.'); }
});

app.get('/api/v2/admin/announcements', requireCapability('announcement:manage'), async (req, res) => {
  const limit = api().parseLimit(req, 30, 100); const cursor = Number(api().decodeCursor(req.query.cursor) || 0);
  const rows = await TypeORM.getConnection().query('SELECT * FROM announcement WHERE id>? ORDER BY id ASC LIMIT ?', [cursor, limit + 1]);
  const more = rows.length > limit; const page = rows.slice(0, limit).map(announcementResource);
  res.locals.apiMeta.limit = limit; res.locals.apiMeta.next_cursor = more ? api().encodeCursor(rows[limit - 1].id) : null; api().setResourceEtag(res, page);
  return api().send(res, page);
});

app.get('/api/v2/admin/announcements/:id', requireCapability('announcement:manage'), async (req, res) => {
  const rows = await TypeORM.getConnection().query('SELECT * FROM announcement WHERE id=? LIMIT 1', [Number(req.params.id)]);
  if (!rows.length) return api().fail(res, 404, 'ANNOUNCEMENT_NOT_FOUND', 'Announcement was not found.');
  const resource = announcementResource(rows[0]); api().setResourceEtag(res, resource); return api().send(res, resource);
});

app.post('/api/v2/admin/announcements', requireCapability('announcement:manage', { recent: true }), async (req, res) => {
  const reason = operationReason(req);
  const result = validateAnnouncement(req.body); if (Object.keys(result.errors).length) return api().fail(res, 422, 'VALIDATION_FAILED', 'Announcement fields are invalid.', result.errors);
  try {
    const saved = await contentTransaction(manager => contentDomain.createAnnouncement(manager, { actorId: res.locals.user.id, value: result.value, now: Math.floor(Date.now() / 1000), reason, recordAudit: auditRecorder(req) }));
    const resource = announcementResource(saved.row); api().setResourceEtag(res, resource);
    return api().send(res, { ...resource, audit_event_id: saved.auditEventId, event_id: saved.eventId }, 201);
  } catch (error) { return contentFailure(res, error); }
});

app.patch('/api/v2/admin/announcements/:id', requireCapability('announcement:manage', { recent: true }), async (req, res) => {
  const reason = operationReason(req); const id = Number(req.params.id);
  if (!req.get('If-Match')) return api().fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when updating an announcement.');
  try {
    const saved = await contentTransaction(manager => contentDomain.updateAnnouncement(manager, { announcementId: id, actorId: res.locals.user.id, now: Math.floor(Date.now() / 1000), reason, validate: current => validateAnnouncement(req.body, current), ifMatch: current => api().ifMatch(req, announcementResource(current)), recordAudit: auditRecorder(req) }));
    const resource = announcementResource(saved.row); api().setResourceEtag(res, resource);
    return api().send(res, { ...resource, audit_event_id: saved.auditEventId, event_id: saved.eventId });
  } catch (error) { return contentFailure(res, error); }
});

app.delete('/api/v2/admin/announcements/:id', requireCapability('announcement:manage', { recent: true }), async (req, res) => {
  const reason = operationReason(req); const id = Number(req.params.id);
  if (!req.get('If-Match')) return api().fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when deleting an announcement.');
  try {
    const removed = await contentTransaction(manager => contentDomain.deleteAnnouncement(manager, {
      announcementId: id, actorId: res.locals.user.id, reason,
      ifMatch: current => api().ifMatch(req, announcementResource(current)), recordAudit: auditRecorder(req)
    }));
    return api().send(res, { id: removed.id, deleted: true, audit_event_id: removed.auditEventId, event_id: removed.eventId });
  } catch (error) { return contentFailure(res, error); }
});

app.get('/api/v2/admin/banners', requireCapability('announcement:manage'), async (req, res) => {
  const limit = api().parseLimit(req, 30, 100); const cursor = Number(api().decodeCursor(req.query.cursor) || 0);
  const rows = await TypeORM.getConnection().query('SELECT * FROM homepage_banner WHERE id>? ORDER BY id ASC LIMIT ?', [cursor, limit + 1]);
  const more = rows.length > limit; const page = rows.slice(0, limit).map(bannerResource);
  res.locals.apiMeta.limit = limit; res.locals.apiMeta.next_cursor = more ? api().encodeCursor(rows[limit - 1].id) : null; api().setResourceEtag(res, page);
  return api().send(res, page);
});

app.get('/api/v2/admin/banners/:id', requireCapability('announcement:manage'), async (req, res) => {
  const rows = await TypeORM.getConnection().query('SELECT * FROM homepage_banner WHERE id=? LIMIT 1', [Number(req.params.id)]);
  if (!rows.length) return api().fail(res, 404, 'BANNER_NOT_FOUND', 'Banner was not found.');
  const resource = bannerResource(rows[0]); api().setResourceEtag(res, resource); return api().send(res, resource);
});

app.post('/api/v2/admin/banners/upload', requireCapability('announcement:manage', { recent: true }), receiveBannerUpload, async (req, res) => {
  if (!req.file) return api().fail(res, 422, 'BANNER_UPLOAD_INVALID', 'An image file is required.', { image: 'required' });
  let storedPath = null;
  try {
    const detectedMime = syzoj.utils.detectSafeRasterImage(req.file.path);
    const extension = BANNER_IMAGE_EXTENSIONS[detectedMime];
    if (!extension) return api().fail(res, 422, 'BANNER_UPLOAD_INVALID', 'The uploaded file is not a valid JPG, PNG, WebP, or GIF image.', { image: 'invalid image content' });
    fs.mkdirSync(BANNER_UPLOAD_DIR, { recursive: true });
    const filename = crypto.randomBytes(16).toString('hex') + extension;
    storedPath = path.join(BANNER_UPLOAD_DIR, filename);
    fs.copyFileSync(req.file.path, storedPath, fs.constants.COPYFILE_EXCL);
    const result = validateBanner({
      title: req.body && req.body.title,
      image_url: `/self/banner/${filename}`,
      link_url: req.body && req.body.link_url,
      sort_order: req.body && req.body.sort_order,
      active: true
    });
    if (Object.keys(result.errors).length) {
      removeStoredBanner(`/self/banner/${filename}`); storedPath = null;
      return api().fail(res, 422, 'VALIDATION_FAILED', 'Banner fields are invalid.', result.errors);
    }
    const reason = operationReason(req);
    const saved = await contentTransaction(manager => contentDomain.createBanner(manager, {
      actorId: res.locals.user.id,
      value: result.value,
      now: Math.floor(Date.now() / 1000),
      reason,
      recordAudit: auditRecorder(req)
    }));
    storedPath = null;
    const resource = bannerResource(saved.row); api().setResourceEtag(res, resource);
    return api().send(res, { ...resource, audit_event_id: saved.auditEventId, event_id: saved.eventId }, 201);
  } catch (error) {
    if (storedPath) removeStoredBanner('/self/banner/' + path.basename(storedPath));
    return contentFailure(res, error);
  } finally {
    removeTemporaryBanner(req.file);
  }
});

app.post('/api/v2/admin/banners', requireCapability('announcement:manage', { recent: true }), async (req, res) => {
  const reason = operationReason(req);
  const result = validateBanner(req.body); if (Object.keys(result.errors).length) return api().fail(res, 422, 'VALIDATION_FAILED', 'Banner fields are invalid.', result.errors);
  try {
    const saved = await contentTransaction(manager => contentDomain.createBanner(manager, { actorId: res.locals.user.id, value: result.value, now: Math.floor(Date.now() / 1000), reason, recordAudit: auditRecorder(req) }));
    const resource = bannerResource(saved.row); api().setResourceEtag(res, resource);
    return api().send(res, { ...resource, audit_event_id: saved.auditEventId, event_id: saved.eventId }, 201);
  } catch (error) { return contentFailure(res, error); }
});

app.patch('/api/v2/admin/banners/:id', requireCapability('announcement:manage', { recent: true }), async (req, res) => {
  const reason = operationReason(req); const id = Number(req.params.id);
  if (!req.get('If-Match')) return api().fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when updating a banner.');
  try {
    const saved = await contentTransaction(manager => contentDomain.updateBanner(manager, { bannerId: id, actorId: res.locals.user.id, reason, validate: current => validateBanner(req.body, current), ifMatch: current => api().ifMatch(req, bannerResource(current)), recordAudit: auditRecorder(req) }));
    const resource = bannerResource(saved.row); api().setResourceEtag(res, resource);
    return api().send(res, { ...resource, audit_event_id: saved.auditEventId, event_id: saved.eventId });
  } catch (error) { return contentFailure(res, error); }
});

app.delete('/api/v2/admin/banners/:id', requireCapability('announcement:manage', { recent: true }), async (req, res) => {
  const reason = operationReason(req); const id = Number(req.params.id);
  if (!req.get('If-Match')) return api().fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when deleting a banner.');
  try {
    const removed = await contentTransaction(manager => contentDomain.deleteBanner(manager, {
      bannerId: id, actorId: res.locals.user.id, reason,
      ifMatch: current => api().ifMatch(req, bannerResource(current)), recordAudit: auditRecorder(req)
    }));
    removeStoredBanner(removed.row.image_path);
    return api().send(res, { id: removed.id, deleted: true, audit_event_id: removed.auditEventId, event_id: removed.eventId });
  } catch (error) { return contentFailure(res, error); }
});

app.get('/api/v2/admin/links', requireCapability('admin:content.manage'), async (req, res) => {
  const resource = await loadLinksResource(); api().setResourceEtag(res, resource); return api().send(res, resource);
});

app.put('/api/v2/admin/links', requireCapability('admin:content.manage', { recent: true }), async (req, res) => {
  const reason = operationReason(req);
  if (!req.get('If-Match')) return api().fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when replacing site links.');
  const result = validateLinks(req.body && req.body.links); if (Object.keys(result.errors).length) return api().fail(res, 422, 'VALIDATION_FAILED', 'One or more links are invalid.', result.errors);
  try {
    const saved = await contentTransaction(async manager => {
      const current = await loadLinksResource(manager, true);
      if (!api().ifMatch(req, current)) { const error = new Error('Site links changed. Reload them before saving.'); error.code = 'ETAG_MISMATCH'; error.statusCode = 412; throw error; }
      await manager.query('UPDATE site_links_v2 SET links_json=?,revision=revision+1,updated_by=?,updated_at=UTC_TIMESTAMP(3) WHERE singleton_id=1', [JSON.stringify(result.links), res.locals.user.id]);
      const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'admin:links.replace', resourceType: 'site_links', resourceId: 'global', reason, details: { before: current.links, after: result.links } }, manager);
      const eventId = await contentDomain.appendEvent(manager, { stream: 'content:site_links', type: 'site_links.replaced', aggregateId: 'global', actorId: res.locals.user.id, payload: { audit_event_id: auditEventId, revision: current.revision + 1 } });
      const resource = await loadLinksResource(manager, true);
      return { resource, auditEventId, eventId };
    });
    syzoj.config.links = saved.resource.links; api().setResourceEtag(res, saved.resource);
    return api().send(res, { ...saved.resource, audit_event_id: saved.auditEventId, event_id: saved.eventId });
  } catch (error) { return contentFailure(res, error); }
});

// Keep the server-rendered admin page compatible while routing its writes through
// the same persistent resource, capability check, validation, and audit trail.
app.get('/admin/links', async (req, res) => {
  try {
    if (!await can(res.locals.user, 'admin:content.manage')) throw new ErrorMessage('您没有权限进行此操作。');
    const resource = await loadLinksResource(); return res.render('admin_links', { links: resource.links });
  } catch (error) { syzoj.log(error); return res.status(error.statusCode || 403).render('error', { err: error }); }
});


app.get(['/api/v2/admin/config-metadata', '/api/v2/admin/config/metadata'], requireCapability('admin:config.read'), async (req, res) => { await loadConfigOverrides(); const resource = configMetadataResource(); api().setResourceEtag(res, resource); return api().send(res, resource); });

app.patch('/api/v2/admin/config', requireCapability('admin:config.write', { recent: true }), async (req, res) => {
  const reason = operationReason(req); if (!req.get('If-Match')) return api().fail(res, 428, 'PRECONDITION_REQUIRED', 'If-Match is required when updating site configuration.', { if_match: 'required' }); const changes = req.body && req.body.changes; if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return api().fail(res, 422, 'VALIDATION_FAILED', 'A changes object is required.', { changes: 'object required' });
  const normalized = {}; const errors = {}; for (const [name, value] of Object.entries(changes)) { const result = validateConfigChange(name, value); if (result.error) errors[name] = result.error; else normalized[name] = result.value; }
  if (Object.keys(errors).length) return api().fail(res, 422, 'VALIDATION_FAILED', 'One or more configuration fields are invalid.', errors); if (!Object.keys(normalized).length) return api().fail(res, 422, 'VALIDATION_FAILED', 'At least one mutable configuration field is required.', { changes: 'empty' });
  await ensureConfigOverrideSchema();
  try {
    const result = await TypeORM.getConnection().transaction(async manager => {
      const rows = await manager.query('SELECT field_name,value_json FROM site_config_v2_override ORDER BY field_name FOR UPDATE');
      const overrides = {};
      rows.forEach(row => { if (!CONFIG_FIELDS[row.field_name] || !CONFIG_FIELDS[row.field_name].mutable) return; try { overrides[row.field_name] = JSON.parse(row.value_json); } catch (error) {} });
      const current = configMetadataResource(overrides);
      if (!api().ifMatch(req, current)) { const error = new Error('Site configuration changed. Refresh it and try again.'); error.code = 'ETAG_MISMATCH'; error.statusCode = 412; throw error; }
      const before = {}; Object.keys(normalized).forEach(name => { before[name] = Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : configValue(name); });
      for (const [name, value] of Object.entries(normalized)) await manager.query('INSERT INTO site_config_v2_override (field_name,value_json,updated_by,updated_at) VALUES (?,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE value_json=VALUES(value_json),updated_by=VALUES(updated_by),updated_at=UTC_TIMESTAMP(3)', [name, JSON.stringify(value), res.locals.user.id]);
      const diff = Object.keys(normalized).map(name => ({ field: name, before: before[name], after: normalized[name] }));
      const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, { action: 'admin:config.update', resourceType: 'site_config', resourceId: 'runtime', reason, details: { diff } }, manager);
      const eventId = await contentDomain.appendEvent(manager, { stream: 'admin:site_config:runtime', type: 'site_config.updated', aggregateId: 'runtime', actorId: res.locals.user.id, payload: { changed_fields: diff.map(change => change.field), audit_event_id: auditEventId } });
      return { diff, auditEventId, eventId };
    });
    Object.entries(normalized).forEach(([name, value]) => applyConfigOverride(name, value));
    return api().send(res, { changed: result.diff, audit_event_id: result.auditEventId, event_id: result.eventId, secrets_redacted: true });
  } catch (error) { return contentFailure(res, error); }
});

function legacyAdminError(message, statusCode = 400) {
  const error = new ErrorMessage(message);
  error.statusCode = statusCode;
  return error;
}

function renderLegacyAdminError(res, error) {
  syzoj.log('[admin-audit] ' + (error.stack || error));
  return res.status(error.statusCode || 500).render('error', { err: error });
}

async function requireLegacyAdmin(req, res, capability, options = {}) {
  if (!res.locals.user || !await can(res.locals.user, capability)) {
    throw legacyAdminError('您没有权限进行此操作。', 403);
  }
  if (options.recent && !syzoj.utils.authorizationV2.recentLoginSatisfied(req)) {
    throw legacyAdminError('此高风险操作需要重新登录或完成二次验证。', 403);
  }
}

function validLegacyAdminCsrf(req) {
  const expected = req.session && req.session.adminCsrfToken;
  const actual = req.body && req.body.csrf_token;
  if (typeof expected !== 'string' || typeof actual !== 'string' || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function requireLegacyAdminCsrf(req) {
  if (!validLegacyAdminCsrf(req)) throw legacyAdminError('页面已失效，请刷新后重试。', 403);
}

async function recordLegacyAdminWrite(req, res, event) {
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, event);
  res.set('X-Audit-Event-ID', String(auditEventId));
  await api().appendEvent({
    stream: 'admin:' + (event.resourceType || 'operation') + ':' + (event.resourceId || 'global'),
    type: event.eventType || event.action,
    aggregateId: event.resourceId || 'global',
    actor: res.locals.user,
    payload: Object.assign({ audit_event_id: auditEventId }, event.eventPayload || {})
  });
  return auditEventId;
}

function legacyGetPath(source, path) {
  return path.split('.').reduce((value, key) => value == null ? undefined : value[key], source);
}

function legacySetPath(target, path, value) {
  const parts = path.split('.');
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

function legacyConfigViewItems() {
  const items = {};
  for (const [key, definition] of Object.entries(LEGACY_CONFIG_ITEMS)) {
    items[key] = definition === null ? null : Object.assign({}, definition, { val: legacyGetPath(syzoj.config, key) });
  }
  return items;
}

function normalizeLegacyConfigValue(key, definition, raw) {
  if (definition.type === Number) {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < definition.min || value > definition.max) {
      throw legacyAdminError(definition.name + '必须是 ' + definition.min + ' 到 ' + definition.max + ' 之间的整数。', 422);
    }
    return value;
  }
  const value = String(raw == null ? '' : raw).trim();
  if (value.length > 500) throw legacyAdminError(definition.name + '过长。', 422);
  if (key === 'title' && !value) throw legacyAdminError('站点标题不能为空。', 422);
  return value;
}

app.get('/admin/config', async (req, res) => {
  try {
    await requireLegacyAdmin(req, res, 'admin:config.read');
    return res.render('admin_config', {
      items: legacyConfigViewItems(),
      v2Config: {
        site_title: String(syzoj.config.title || 'NWPUOJ'),
        default_user_rating: Number(syzoj.config.default && syzoj.config.default.user && syzoj.config.default.user.rating || 1500)
      }
    });
  } catch (error) { return renderLegacyAdminError(res, error); }
});


async function loadLegacyPrivilegeRows() {
  const rows = await TypeORM.getConnection().query(
    `SELECT privilege.user_id,privilege.privilege,user.username
       FROM user_privilege privilege
       JOIN user ON user.id=privilege.user_id
      ORDER BY privilege.user_id ASC,privilege.privilege ASC`
  );
  const users = new Map();
  for (const row of rows) {
    const userId = Number(row.user_id);
    if (!users.has(userId)) users.set(userId, { user: { id: userId, username: row.username }, privileges: [] });
    users.get(userId).privileges.push(row.privilege);
  }
  return Array.from(users.values());
}

function normalizeLegacyPrivilegePayload(raw) {
  let parsed;
  try { parsed = JSON.parse(String(raw || '')); } catch (error) { throw legacyAdminError('权限数据格式无效。', 422); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw legacyAdminError('权限数据格式无效。', 422);
  const entries = Object.entries(parsed);
  if (entries.length > 1000) throw legacyAdminError('单次最多修改 1000 个用户的权限。', 422);
  return entries.map(([rawId, rawPrivileges]) => {
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id < 1 || !Array.isArray(rawPrivileges)) throw legacyAdminError('权限数据格式无效。', 422);
    const privileges = Array.from(new Set(rawPrivileges.map(String)));
    if (privileges.some(privilege => !LEGACY_MANAGED_PRIVILEGE_SET.has(privilege))) {
      throw legacyAdminError('包含不可在此页修改的权限。', 422);
    }
    return { id, privileges };
  });
}

app.get('/admin/privilege', async (req, res) => {
  try {
    await requireLegacyAdmin(req, res, 'admin:permission.grant');
    return res.render('admin_privilege', { users: await loadLegacyPrivilegeRows() });
  } catch (error) { return renderLegacyAdminError(res, error); }
});


const LEGACY_MAINTENANCE_ACTIONS = Object.freeze({
  reset_count: { capability: 'admin:job.manage', action: 'admin:maintenance.problem-counts.rebuild' },
  reset_discussion: { capability: 'admin:job.manage', action: 'admin:maintenance.discussion-counts.rebuild' },
  reset_codelen: { capability: 'admin:job.manage', action: 'admin:maintenance.code-lengths.rebuild' }
});

async function maintenanceItems(kind) {
  if (kind === 'reset_count') return Problem.find();
  if (kind === 'reset_discussion') return Article.find();
  if (kind === 'reset_codelen') return JudgeState.find();
  throw legacyAdminError('操作类型不正确。', 422);
}

async function runMaintenanceJob(jobId) {
  await ensureMaintenanceSchema();
  const connection = TypeORM.getConnection();
  const claimed = await connection.query("UPDATE admin_v2_maintenance_job SET state='running',updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state='queued'", [jobId]);
  if (!Number(claimed.affectedRows || 0)) return;
  const rows = await connection.query('SELECT * FROM admin_v2_maintenance_job WHERE id=? LIMIT 1', [jobId]);
  if (!rows.length) return;
  const job = rows[0];
  try {
    await api().appendEvent({ stream: 'maintenance-job:' + jobId, type: 'maintenance.running', aggregateId: jobId, payload: { operation: job.kind } });
    const items = await maintenanceItems(job.kind);
    await connection.query('UPDATE admin_v2_maintenance_job SET total=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [items.length, jobId]);
    let processed = 0;
    for (const item of items) {
      const cancellation = await connection.query('SELECT cancel_requested FROM admin_v2_maintenance_job WHERE id=? LIMIT 1', [jobId]);
      if (cancellation[0] && cancellation[0].cancel_requested) {
        await connection.query("UPDATE admin_v2_maintenance_job SET state='cancelled',processed=?,current_object=NULL,completed_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3) WHERE id=?", [processed, jobId]);
        await api().appendEvent({ stream: 'maintenance-job:' + jobId, type: 'maintenance.cancelled', aggregateId: jobId, payload: { operation: job.kind, processed } });
        return;
      }
      if (job.kind === 'reset_count') await item.resetSubmissionCount();
      if (job.kind === 'reset_discussion') await item.resetReplyCountAndTime();
      if (job.kind === 'reset_codelen' && item.type !== 'submit-answer') {
        item.code_length = Buffer.byteLength(item.code || '');
        await item.save();
      }
      processed += 1;
      if (processed % 20 === 0 || processed === items.length) {
        await connection.query('UPDATE admin_v2_maintenance_job SET processed=?,current_object=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [processed, String(item.id), jobId]);
      }
    }
    await connection.query("UPDATE admin_v2_maintenance_job SET state='completed',processed=total,current_object=NULL,completed_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]);
    await api().appendEvent({ stream: 'maintenance-job:' + jobId, type: 'maintenance.completed', aggregateId: jobId, payload: { operation: job.kind, processed } });
  } catch (error) {
    const failure = JSON.stringify({ code: 'MAINTENANCE_FAILED', message: error.message || String(error) });
    await connection.query("UPDATE admin_v2_maintenance_job SET state='failed',error_json=?,current_object=NULL,completed_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3) WHERE id=?", [failure, jobId]);
    await api().appendEvent({ stream: 'maintenance-job:' + jobId, type: 'maintenance.failed', aggregateId: jobId, payload: { operation: job.kind, code: 'MAINTENANCE_FAILED' } }).catch(() => {});
  }
}

app.post('/api/v2/admin/maintenance/jobs', requireCapability('admin:job.manage', { recent: true }), async (req, res) => {
  const kind = String(req.body && req.body.kind || '');
  const definition = LEGACY_MAINTENANCE_ACTIONS[kind];
  if (!definition) return api().fail(res, 422, 'VALIDATION_FAILED', 'Maintenance operation is invalid.', { kind: 'unsupported operation' });
  await ensureMaintenanceSchema();
  const id = crypto.randomUUID();
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
    action: definition.action,
    resourceType: 'maintenance_job',
    resourceId: id,
    details: { operation: kind }
  });
  await TypeORM.getConnection().query(
    "INSERT INTO admin_v2_maintenance_job (id,kind,state,actor_id,audit_event_id,created_at,updated_at) VALUES (?,?,'queued',?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
    [id, kind, res.locals.user.id, auditEventId]
  );
  await api().appendEvent({ stream: 'maintenance-job:' + id, type: 'maintenance.queued', aggregateId: id, actor: res.locals.user, payload: { operation: kind, audit_event_id: auditEventId } });
  setImmediate(() => runMaintenanceJob(id));
  return api().send(res, { id, kind: 'maintenance', subtype: kind, state: 'queued', audit_event_id: auditEventId }, 202);
});


async function buildLegacyRejudgeQuery(body) {
  const query = JudgeState.createQueryBuilder();
  const submitter = String(body.submitter || '').trim();
  const user = await User.fromName(submitter);
  if (user) query.andWhere('user_id = :user_id', { user_id: user.id });
  else if (submitter) query.andWhere('user_id = :user_id', { user_id: 0 });
  const integerFilters = [
    ['min_id', 'id >= :minID', 'minID'], ['max_id', 'id <= :maxID', 'maxID'],
    ['min_score', 'score >= :minScore', 'minScore'], ['max_score', 'score <= :maxScore', 'maxScore']
  ];
  for (const [field, expression, parameter] of integerFilters) {
    const value = Number.parseInt(body[field], 10);
    if (Number.isSafeInteger(value)) query.andWhere(expression, { [parameter]: value });
  }
  const minTime = syzoj.utils.parseDate(body.min_time);
  const maxTime = syzoj.utils.parseDate(body.max_time);
  if (!Number.isNaN(minTime)) query.andWhere('submit_time >= :minTime', { minTime: Number.parseInt(minTime, 10) });
  if (!Number.isNaN(maxTime)) query.andWhere('submit_time <= :maxTime', { maxTime: Number.parseInt(maxTime, 10) });
  if (body.language === 'submit-answer') {
    query.andWhere(new TypeORM.Brackets(builder => builder.orWhere("language = ''").orWhere('language IS NULL')));
  } else if (body.language === 'non-submit-answer') {
    query.andWhere("language != ''").andWhere('language IS NOT NULL');
  } else if (body.language) {
    query.andWhere('language = :language', { language: body.language });
  }
  if (body.status) query.andWhere('status = :status', { status: body.status });
  if (body.problem_id) query.andWhere('problem_id = :problem_id', { problem_id: Number.parseInt(body.problem_id, 10) || 0 });
  return query;
}

function normalizedRejudgeFilters(body) {
  return {
    problem_id: body.problem_id || null, submitter: body.submitter || null,
    language: body.language || null, status: body.status || null,
    min_id: body.min_id || null, max_id: body.max_id || null,
    min_score: body.min_score || null, max_score: body.max_score || null,
    min_time: body.min_time || null, max_time: body.max_time || null
  };
}

async function createRejudgeBatch(req, actor, query, count) {
  if (count < 1) throw legacyAdminError('没有符合条件的提交。', 422);
  if (count > MAX_BULK_REJUDGE) {
    throw legacyAdminError('单次最多重测 ' + MAX_BULK_REJUDGE + ' 条提交，请继续缩小筛选范围。', 422);
  }
  const submissions = await JudgeState.queryAll(query);
  await Promise.all([
    syzoj.utils.authorizationV2.ensureSchema(),
    syzoj.utils.submissionV2.ensureSchema(),
    api().ensureFoundationSchema(),
    ensureRejudgeBatchSchema()
  ]);
  const jobId = crypto.randomUUID();
  const filters = normalizedRejudgeFilters(req.body || {});
  const queued = await TypeORM.getConnection().transaction(async manager => {
    const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
      action: 'submission:bulk-rejudge', resourceType: 'submission_batch', resourceId: jobId,
      reason: '后台批量重测', details: { count, filters }
    }, manager);
    await manager.query(
      `INSERT INTO admin_v2_rejudge_job
        (id,state,stage,actor_id,filters_json,total,processed,failed,current_submission_id,
         audit_event_id,cancel_requested,created_at,updated_at)
       VALUES (?,'queued','queued',?,?,?,0,0,NULL,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
      [jobId, actor.id, JSON.stringify(filters), submissions.length, auditEventId]
    );
    for (let offset = 0; offset < submissions.length; offset += 100) {
      const slice = submissions.slice(offset, offset + 100);
      const values = slice.map(() => "(?,?,?,NULL,'pending',NULL,UTC_TIMESTAMP(3))").join(',');
      const parameters = slice.flatMap((submission, index) => [jobId, offset + index + 1, submission.id]);
      await manager.query(
        'INSERT INTO admin_v2_rejudge_item (job_id,seq,submission_id,child_job_id,state,error_json,updated_at) VALUES ' + values,
        parameters
      );
    }
    return { auditEventId };
  });
  await api().appendEvent({
    stream: 'submission-rejudge-job:' + jobId, type: 'submission.bulk-rejudge.queued',
    aggregateId: jobId, actor,
    payload: { audit_event_id: queued.auditEventId, count: submissions.length }
  });
  setImmediate(() => runRejudgeBatchJob(jobId));
  return { id: jobId, count: submissions.length, auditEventId: queued.auditEventId };
}

async function finishCancelledRejudgeBatch(connection, jobId) {
  await connection.query("UPDATE admin_v2_rejudge_item SET state='cancelled',updated_at=UTC_TIMESTAMP(3) WHERE job_id=? AND state IN ('pending','running')", [jobId]);
  const counts = await connection.query("SELECT SUM(state IN ('completed','failed','cancelled')) AS processed,SUM(state='failed') AS failed FROM admin_v2_rejudge_item WHERE job_id=?", [jobId]);
  await connection.query(
    "UPDATE admin_v2_rejudge_job SET state='cancelled',stage='cancelled',processed=?,failed=?,current_submission_id=NULL,completed_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3) WHERE id=?",
    [Number(counts[0] && counts[0].processed || 0), Number(counts[0] && counts[0].failed || 0), jobId]
  );
}

async function runRejudgeBatchJob(jobId) {
  await ensureRejudgeBatchSchema();
  const connection = TypeORM.getConnection();
  try {
    const claimed = await connection.query(
      "UPDATE admin_v2_rejudge_job SET state='running',stage='rejudging',updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state='queued'",
      [jobId]
    );
    if (!claimed.affectedRows) return;
    while (true) {
      const jobs = await connection.query('SELECT * FROM admin_v2_rejudge_job WHERE id=? LIMIT 1', [jobId]);
      const job = jobs[0];
      if (!job) return;
      if (job.cancel_requested || job.state === 'cancelling') {
        await finishCancelledRejudgeBatch(connection, jobId);
        await api().appendEvent({
          stream: 'submission-rejudge-job:' + jobId, type: 'submission.bulk-rejudge.cancelled',
          aggregateId: jobId, actor: { id: job.actor_id },
          payload: { processed: Number(job.processed || 0), total: Number(job.total || 0) }
        });
        return;
      }
      const items = await connection.query(
        "SELECT * FROM admin_v2_rejudge_item WHERE job_id=? AND state='pending' ORDER BY seq ASC LIMIT 1",
        [jobId]
      );
      if (!items.length) {
        const failures = await connection.query(
          "SELECT submission_id,error_json FROM admin_v2_rejudge_item WHERE job_id=? AND state='failed' ORDER BY seq ASC",
          [jobId]
        );
        const failureList = failures.map(item => ({
          submission_id: Number(item.submission_id),
          error: safeJson(item.error_json, { code: 'REJUDGE_FAILED', message: 'Rejudge failed.' })
        }));
        const counts = await connection.query(
          "SELECT SUM(state IN ('completed','failed')) AS processed,SUM(state='failed') AS failed FROM admin_v2_rejudge_item WHERE job_id=?",
          [jobId]
        );
        await connection.query(
          "UPDATE admin_v2_rejudge_job SET state='completed',stage='completed',processed=?,failed=?,current_submission_id=NULL,failures_json=?,completed_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3) WHERE id=?",
          [Number(counts[0] && counts[0].processed || 0), Number(counts[0] && counts[0].failed || 0), JSON.stringify(failureList), jobId]
        );
        await api().appendEvent({
          stream: 'submission-rejudge-job:' + jobId, type: 'submission.bulk-rejudge.completed',
          aggregateId: jobId, actor: { id: job.actor_id },
          payload: { processed: Number(counts[0] && counts[0].processed || 0), total: Number(job.total || 0), failed: failureList.length }
        });
        return;
      }
      const item = items[0];
      const childJobId = item.child_job_id || crypto.randomUUID();
      await connection.transaction(async manager => {
        const updated = await manager.query(
          "UPDATE admin_v2_rejudge_item SET state='running',child_job_id=?,updated_at=UTC_TIMESTAMP(3) WHERE job_id=? AND submission_id=? AND state='pending'",
          [childJobId, jobId, item.submission_id]
        );
        if (!updated.affectedRows) return;
        if (item.child_job_id) {
          await manager.query(
            "UPDATE submission_v2_job SET state='queued',progress=0,cancel_requested=0,error_json=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?",
            [childJobId]
          );
        } else {
          await manager.query(
            "INSERT INTO submission_v2_job (id,submission_id,kind,state,progress,actor_id,reason,audit_event_id,created_at,updated_at) VALUES (?,?,'rejudge','queued',0,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
            [childJobId, item.submission_id, job.actor_id, '后台批量重测', job.audit_event_id]
          );
        }
        await manager.query(
          "UPDATE admin_v2_rejudge_job SET current_submission_id=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?",
          [item.submission_id, jobId]
        );
      });
      await api().appendEvent({
        stream: 'submission-job:' + childJobId, type: 'submission.rejudge.queued',
        aggregateId: childJobId, actor: { id: job.actor_id },
        payload: { submission_id: Number(item.submission_id), audit_event_id: job.audit_event_id, parent_job_id: jobId }
      });
      await syzoj.utils.submissionV2.runSubmissionJob(childJobId);
      const childRows = await connection.query('SELECT state,error_json FROM submission_v2_job WHERE id=? LIMIT 1', [childJobId]);
      const child = childRows[0] || { state: 'failed', error_json: JSON.stringify({ code: 'REJUDGE_JOB_MISSING', message: 'Child rejudge job was not found.' }) };
      const itemState = child.state === 'completed' ? 'completed' : child.state === 'cancelled' ? 'cancelled' : 'failed';
      await connection.query(
        'UPDATE admin_v2_rejudge_item SET state=?,error_json=?,updated_at=UTC_TIMESTAMP(3) WHERE job_id=? AND submission_id=?',
        [itemState, child.error_json || null, jobId, item.submission_id]
      );
      await connection.query(
        "UPDATE admin_v2_rejudge_job SET processed=processed+1,failed=failed+?,updated_at=UTC_TIMESTAMP(3) WHERE id=?",
        [itemState === 'failed' ? 1 : 0, jobId]
      );
      await api().appendEvent({
        stream: 'submission-rejudge-job:' + jobId, type: 'submission.bulk-rejudge.progress',
        aggregateId: jobId, actor: { id: job.actor_id },
        payload: { submission_id: Number(item.submission_id), item_state: itemState }
      });
    }
  } catch (error) {
    const failure = JSON.stringify({ code: 'BULK_REJUDGE_FAILED', message: String(error.message || error).slice(0, 500) });
    await connection.query(
      "UPDATE admin_v2_rejudge_item SET state='failed',error_json=?,updated_at=UTC_TIMESTAMP(3) WHERE job_id=? AND state='running'",
      [failure, jobId]
    );
    const counts = await connection.query(
      "SELECT SUM(state IN ('completed','failed')) AS processed,SUM(state='failed') AS failed FROM admin_v2_rejudge_item WHERE job_id=?",
      [jobId]
    );
    await connection.query(
      "UPDATE admin_v2_rejudge_job SET state='failed',stage='failed',processed=?,failed=?,current_submission_id=NULL,error_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?",
      [Number(counts[0] && counts[0].processed || 0), Number(counts[0] && counts[0].failed || 0), failure, jobId]
    );
    await api().appendEvent({
      stream: 'submission-rejudge-job:' + jobId, type: 'submission.bulk-rejudge.failed',
      aggregateId: jobId, payload: { code: 'BULK_REJUDGE_FAILED' }
    }).catch(() => {});
  }
}

app.post('/api/v2/admin/rejudge/jobs', requireCapability('submission:rejudge', { recent: true }), async (req, res) => {
  try {
    const query = await buildLegacyRejudgeQuery(req.body || {});
    const count = await JudgeState.countQuery(query);
    const result = await createRejudgeBatch(req, res.locals.user, query, count);
    res.set('X-Audit-Event-ID', String(result.auditEventId));
    return api().send(res, {
      id: result.id, kind: 'submission_bulk_rejudge', state: 'queued',
      progress: { processed: 0, total: result.count, failed: 0 },
      audit_event_id: result.auditEventId
    }, 202);
  } catch (error) {
    return api().fail(res, error.statusCode || 500, error.statusCode === 422 ? 'VALIDATION_FAILED' : 'BULK_REJUDGE_FAILED', error.message);
  }
});

app.get('/api/v2/admin/rejudge/jobs/:id', requireCapability('submission:rejudge'), async (req, res) => {
  await ensureRejudgeBatchSchema();
  const rows = await TypeORM.getConnection().query('SELECT * FROM admin_v2_rejudge_job WHERE id=? LIMIT 1', [req.params.id]);
  if (!rows.length) return api().fail(res, 404, 'JOB_NOT_FOUND', 'Job was not found.');
  const items = await TypeORM.getConnection().query(
    'SELECT seq,submission_id,child_job_id,state,error_json,updated_at FROM admin_v2_rejudge_item WHERE job_id=? ORDER BY seq ASC',
    [req.params.id]
  );
  return api().send(res, Object.assign(serializeRejudgeBatch(rows[0]), {
    audit_event_id: rows[0].audit_event_id,
    items: items.map(item => ({
      sequence: Number(item.seq), submission_id: Number(item.submission_id),
      child_job_id: item.child_job_id || null, state: item.state,
      error: safeJson(item.error_json, null), updated_at: iso(item.updated_at)
    }))
  }));
});

app.get('/admin/rejudge', async (req, res) => {
  try {
    await requireLegacyAdmin(req, res, 'submission:rejudge');
    return res.render('admin_rejudge', { form: {}, count: null, rejudgeLimit: MAX_BULK_REJUDGE });
  } catch (error) { return renderLegacyAdminError(res, error); }
});


app.get('/admin/raw', async (req, res) => {
  try {
    await requireLegacyAdmin(req, res, 'admin:config.read');
    return res.redirect(syzoj.utils.makeUrl(['admin', 'config']));
  } catch (error) { return renderLegacyAdminError(res, error); }
});


async function recoverRejudgeBatchJobs() {
  try {
    await ensureRejudgeBatchSchema();
    const connection = TypeORM.getConnection();
    const jobs = await connection.query(
      "SELECT id,state,actor_id FROM admin_v2_rejudge_job WHERE state IN ('queued','running','cancelling') ORDER BY created_at ASC"
    );
    for (const job of jobs) {
      if (job.state === 'queued') {
        setImmediate(() => runRejudgeBatchJob(job.id));
        continue;
      }
      if (job.state === 'cancelling') {
        await finishCancelledRejudgeBatch(connection, job.id);
        await api().appendEvent({
          stream: 'submission-rejudge-job:' + job.id, type: 'submission.bulk-rejudge.cancelled',
          aggregateId: job.id, actor: { id: job.actor_id }, payload: { recovered: true }
        });
        continue;
      }
      const interrupted = { code: 'BATCH_INTERRUPTED', message: 'The bulk rejudge worker restarted. Retry the task to continue unfinished submissions.' };
      await connection.query(
        "UPDATE admin_v2_rejudge_item SET state='failed',error_json=?,updated_at=UTC_TIMESTAMP(3) WHERE job_id=? AND state='running'",
        [JSON.stringify(interrupted), job.id]
      );
      const counts = await connection.query(
        "SELECT SUM(state IN ('completed','failed')) AS processed,SUM(state='failed') AS failed FROM admin_v2_rejudge_item WHERE job_id=?",
        [job.id]
      );
      await connection.query(
        "UPDATE admin_v2_rejudge_job SET state='failed',stage='interrupted',processed=?,failed=?,current_submission_id=NULL,error_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=? AND state='running'",
        [Number(counts[0] && counts[0].processed || 0), Number(counts[0] && counts[0].failed || 0), JSON.stringify(interrupted), job.id]
      );
      await api().appendEvent({
        stream: 'submission-rejudge-job:' + job.id, type: 'submission.bulk-rejudge.interrupted',
        aggregateId: job.id, actor: { id: job.actor_id }, payload: { code: 'BATCH_INTERRUPTED' }
      });
    }
  } catch (error) {
    syzoj.log('[bulk-rejudge] recovery failed: ' + (error.stack || error));
  }
}

async function recoverMaintenanceJobs() {
  try {
    await ensureMaintenanceSchema();
    const connection = TypeORM.getConnection();
    await connection.query("UPDATE admin_v2_maintenance_job SET state='cancelled',completed_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3) WHERE state='cancelling'");
    await connection.query("UPDATE admin_v2_maintenance_job SET state='queued',processed=0,total=0,current_object=NULL,cancel_requested=0,updated_at=UTC_TIMESTAMP(3) WHERE state='running'");
    const jobs = await connection.query("SELECT id FROM admin_v2_maintenance_job WHERE state='queued' ORDER BY created_at ASC");
    for (const job of jobs) setImmediate(() => runMaintenanceJob(job.id));
  } catch (error) {
    syzoj.log('[maintenance] recovery failed: ' + (error.stack || error));
  }
}

loadConfigOverrides().catch(error => syzoj.log(`[config-v2] override initialization failed: ${error.stack || error.message}`));
loadLinksResource().catch(error => syzoj.log(`[content-v2] site links initialization failed: ${error.stack || error.message}`));
recoverRejudgeBatchJobs();
recoverMaintenanceJobs();
