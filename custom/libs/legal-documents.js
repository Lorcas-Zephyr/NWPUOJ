'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DOCUMENTS = Object.freeze([
  { slug: 'terms', title: '用户协议' },
  { slug: 'privacy', title: '隐私政策' },
  { slug: 'competition', title: '比赛规则' },
  { slug: 'copyright', title: '版权与投诉' }
]);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const publishedDay = now => new Date(Number(now) + 8 * 3600000).toISOString().slice(0, 10);

function validationError(message, field) {
  const error = new Error(message);
  error.statusCode = 422;
  error.fields = { [field]: message };
  return error;
}

function readBundle(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (!['draft', 'approved'].includes(manifest.status)) throw new Error('Invalid legal publication status.');
  if (typeof manifest.allow_under_14 !== 'boolean' || !['pending', 'ready'].includes(manifest.guardian_consent_status) ||
      !manifest.operator || !manifest.contact_email || !manifest.version || !Array.isArray(manifest.review_pending)) {
    throw new Error('Incomplete legal publication manifest.');
  }
  // Approval publishes the operator-reviewed notice; it is not evidence that
  // outstanding data-handling or guardian-consent work has been completed.
  const currentStatePublication = manifest.publication_basis === 'operator_approved_current_state' &&
    manifest.publication_approved_on === manifest.effective_date &&
    Array.isArray(manifest.implementation_pending) && manifest.implementation_pending.includes('guardian_consent');
  if (manifest.status === 'approved' && (manifest.review_pending.length ||
      (manifest.allow_under_14 && manifest.guardian_consent_status !== 'ready' && !currentStatePublication) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(manifest.effective_date || '') ||
      !Number.isFinite(Date.parse(manifest.effective_date)) ||
      new Date(manifest.effective_date).toISOString().slice(0, 10) !== manifest.effective_date)) {
    throw new Error('Legal documents require completed review and a valid effective date before approval.');
  }
  const documents = DOCUMENTS.map(item => {
    const markdown = fs.readFileSync(path.join(directory, item.slug + '.md'), 'utf8');
    if (!markdown.trim()) throw new Error('Empty legal document: ' + item.slug);
    return { ...item, markdown, sha256: sha256(markdown) };
  });
  const snapshot = JSON.stringify({ manifest, documents });
  return { manifest, documents, snapshot, revision: sha256(snapshot) };
}

function registrationPolicy(bundle, now = Date.now()) {
  const enabled = bundle.manifest.status === 'approved' && bundle.manifest.effective_date <= publishedDay(now);
  return {
    enabled,
    preview: false,
    version: bundle.revision,
    label: bundle.manifest.version,
    termsUrl: '/legal/terms?version=' + bundle.revision,
    privacyUrl: '/legal/privacy?version=' + bundle.revision
  };
}

function validateRegistrationAcknowledgement(body, policy) {
  if (!policy.enabled) return null;
  const values = body || {};
  if (values.terms_accepted !== true || values.privacy_acknowledged !== true) {
    throw validationError('请阅读并同意用户协议，并确认已阅读隐私政策。', 'terms_accepted');
  }
  if (values.legal_version !== policy.version) {
    throw validationError('协议版本已更新，请重新打开注册页，阅读后再次确认。', 'legal_version');
  }
  // A notice acknowledgement is not a blanket processing consent. Never copy
  // arbitrary client fields (e.g. marketing/sharing/AI consent) into the record.
  return Object.freeze({
    legal_version: policy.version,
    terms_accepted: true,
    privacy_acknowledged: true
  });
}

function createLegalService(options = {}) {
  let bundle = readBundle(options.directory || path.join(__dirname, '../content/legal'));
  const seedBundle = bundle;
  const editable = options.editable === true;
  const connection = options.connection || (() => require('typeorm').getConnection());
  let schemaPromise;
  function ensureSchema() {
    if (!schemaPromise) schemaPromise = (async () => {
      const db = connection();
      await db.query(`CREATE TABLE IF NOT EXISTS site_legal_revision (
        revision CHAR(64) NOT NULL PRIMARY KEY,
        version_label VARCHAR(100) NOT NULL,
        effective_date DATE NOT NULL,
        snapshot_json MEDIUMTEXT NOT NULL,
        archived_at INT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      await db.query(`CREATE TABLE IF NOT EXISTS user_legal_acknowledgement (
        user_id INT NOT NULL,
        revision CHAR(64) NOT NULL,
        terms_accepted TINYINT NOT NULL,
        privacy_acknowledged TINYINT NOT NULL,
        accepted_at INT NOT NULL,
        PRIMARY KEY (user_id,revision)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      if (editable && seedBundle.manifest.status === 'approved') {
        await db.query(`CREATE TABLE IF NOT EXISTS site_legal_publication (
          id TINYINT NOT NULL PRIMARY KEY,
          revision CHAR(64) NOT NULL,
          sequence INT NOT NULL,
          updated_by INT NULL,
          updated_at INT NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
        const now = Math.floor(Date.now() / 1000);
        await db.query('INSERT IGNORE INTO site_legal_revision (revision,version_label,effective_date,snapshot_json,archived_at) VALUES (?,?,?,?,?)',
          [seedBundle.revision, seedBundle.manifest.version, seedBundle.manifest.effective_date, seedBundle.snapshot, now]);
        await db.query('INSERT IGNORE INTO site_legal_publication (id,revision,sequence,updated_by,updated_at) VALUES (1,?,?,NULL,?)',
          [seedBundle.revision, Number((seedBundle.manifest.version.match(/\.(\d+)$/) || [])[1]) || 1, now]);
      }
    })().catch(error => { schemaPromise = null; throw error; });
    return schemaPromise;
  }
  function decode(row) {
    if (!row || sha256(row.snapshot_json) !== row.revision) throw new Error('Legal snapshot integrity check failed.');
    return { ...JSON.parse(row.snapshot_json), snapshot: row.snapshot_json, revision: row.revision };
  }
  async function head(manager, lock) {
    const rows = await manager.query(`SELECT publication.revision,publication.sequence,revision.snapshot_json
      FROM site_legal_publication publication
      INNER JOIN site_legal_revision revision ON revision.revision=publication.revision
      WHERE publication.id=1${lock ? ' FOR UPDATE' : ''}`);
    if (!rows.length) throw new Error('Published legal version is unavailable.');
    return { bundle: decode(rows[0]), sequence: Number(rows[0].sequence) };
  }
  async function refresh() {
    if (!editable || seedBundle.manifest.status !== 'approved') return bundle;
    await ensureSchema();
    bundle = (await head(connection(), false)).bundle;
    return bundle;
  }
  function editError(statusCode, code, message) {
    return Object.assign(new Error(message), { statusCode, code });
  }
  async function publishDocument(slug, content, expectedRevision, actorId, recordAudit) {
    if (!editable || seedBundle.manifest.status !== 'approved') throw editError(409, 'LEGAL_NOT_PUBLISHED', '仅可编辑已发布的协议。');
    if (!DOCUMENTS.some(item => item.slug === slug)) throw editError(404, 'LEGAL_NOT_FOUND', '没有找到该协议。');
    if (typeof content !== 'string' || !content.trim()) throw editError(422, 'VALIDATION_FAILED', '正文不能为空。');
    content = content.trim();
    if (Buffer.byteLength(content, 'utf8') > 200 * 1024) throw editError(413, 'REQUEST_BODY_TOO_LARGE', '正文不能超过 200 KiB。');
    if (!Number.isSafeInteger(actorId) || actorId <= 0 || typeof recordAudit !== 'function') throw new Error('Legal publication requires an administrator and audit recorder.');
    await ensureSchema();
    const result = await connection().transaction(async manager => {
      const current = await head(manager, true);
      if (expectedRevision !== current.bundle.revision) throw editError(412, 'ETAG_MISMATCH', '协议已被其他管理员更新，请保留编辑内容并重新加载页面。');
      const document = current.bundle.documents.find(item => item.slug === slug);
      if (document.markdown.trim() === content) return { bundle: current.bundle, changed: false, auditEventId: null };
      const now = Date.now(), day = publishedDay(now), sequence = current.sequence + 1;
      const manifest = { ...current.bundle.manifest, version: day + '.' + sequence, updated_at: day, effective_date: day };
      if (manifest.publication_basis === 'operator_approved_current_state') manifest.publication_approved_on = day;
      const documents = current.bundle.documents.map(item => item.slug === slug ? { ...item, markdown: content, sha256: sha256(content) } : item);
      const snapshot = JSON.stringify({ manifest, documents });
      const next = { manifest, documents, snapshot, revision: sha256(snapshot) };
      await manager.query('INSERT INTO site_legal_revision (revision,version_label,effective_date,snapshot_json,archived_at) VALUES (?,?,?,?,?)',
        [next.revision, manifest.version, day, snapshot, Math.floor(now / 1000)]);
      const auditEventId = await recordAudit(manager, { slug, from_revision: current.bundle.revision, to_revision: next.revision, content_bytes: Buffer.byteLength(content, 'utf8') });
      await manager.query('UPDATE site_legal_publication SET revision=?,sequence=?,updated_by=?,updated_at=? WHERE id=1',
        [next.revision, sequence, actorId, Math.floor(now / 1000)]);
      return { bundle: next, changed: true, auditEventId };
    });
    bundle = result.bundle;
    return result;
  }
  async function persistAcknowledgement(manager, userId, values) {
    const receiptBundle = editable && seedBundle.manifest.status === 'approved' ? (await head(manager, true)).bundle : bundle;
    const policy = registrationPolicy(receiptBundle);
    const receipt = validateRegistrationAcknowledgement(values, policy);
    if (!receipt) return;
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('Invalid acknowledgement user.');
    const now = Math.floor(Date.now() / 1000);
    // Called with the same transaction manager that creates the user. A failed
    // acknowledgement must roll back account creation, not leave a partial user.
    await manager.query(
      `INSERT IGNORE INTO site_legal_revision (revision,version_label,effective_date,snapshot_json,archived_at)
       VALUES (?,?,?,?,?)`,
      [receiptBundle.revision, receiptBundle.manifest.version, receiptBundle.manifest.effective_date, receiptBundle.snapshot, now]
    );
    await manager.query(
      `INSERT INTO user_legal_acknowledgement
       (user_id,revision,terms_accepted,privacy_acknowledged,accepted_at) VALUES (?,?,1,1,?)`,
      [userId, receiptBundle.revision, now]
    );
  }
  async function getBundle(revision) {
    if (revision != null && (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))) return null;
    await refresh();
    if (revision == null || revision === bundle.revision) return bundle;
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) return null;
    // Draft installations never need a database to serve documents.
    if (bundle.manifest.status !== 'approved') return null;
    await ensureSchema();
    const rows = await connection().query('SELECT snapshot_json FROM site_legal_revision WHERE revision=? LIMIT 1', [revision]);
    if (!rows.length) return null;
    const snapshot = rows[0].snapshot_json;
    if (sha256(snapshot) !== revision) throw new Error('Legal snapshot integrity check failed.');
    return { ...JSON.parse(snapshot), snapshot, revision };
  }
  return Object.freeze({
    get bundle() { return bundle; }, ensureSchema, persistAcknowledgement, getBundle, refresh, publishDocument,
    registrationPolicy: () => registrationPolicy(bundle),
    validateRegistration: body => validateRegistrationAcknowledgement(body, registrationPolicy(bundle))
  });
}

module.exports = { DOCUMENTS, readBundle, registrationPolicy, validateRegistrationAcknowledgement, createLegalService };
