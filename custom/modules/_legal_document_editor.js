'use strict';

// Loaded after the v2 foundation: editing must not bypass its CSRF,
// idempotency, request-limit or authentication middleware.
const { DOCUMENTS } = require('../libs/legal-documents');
const legal = () => syzoj.utils.legalDocuments;
const api = () => syzoj.utils.apiV2;
const canEdit = res => !!(res.locals.user && (res.locals.user.is_admin || res.locals.isSiteOwner));
function resource(bundle, slug) {
  const document = bundle.documents.find(item => item.slug === slug);
  return { slug, title: document.title, content: document.markdown, revision: bundle.revision,
    version: bundle.manifest.version, effective_date: bundle.manifest.effective_date };
}
function knownSlug(slug) { return DOCUMENTS.some(item => item.slug === slug); }
function requireEditor(res) {
  if (!res.locals.user) { api().fail(res, 401, 'AUTHENTICATION_REQUIRED', '请先登录。'); return false; }
  if (!canEdit(res)) { api().fail(res, 403, 'CAPABILITY_REQUIRED', '仅站长和全站管理员可以编辑协议。'); return false; }
  return true;
}
function failure(res, error) {
  if (!error.statusCode || error.statusCode >= 500) syzoj.log('[legal-editor] ' + (error.stack || error));
  return api().fail(res, error.statusCode || 500, error.code || 'LEGAL_UPDATE_FAILED', error.statusCode ? error.message : '协议操作失败，请稍后重试。');
}

app.get('/legal/:slug/edit', async (req, res) => {
  if (!knownSlug(req.params.slug)) return res.status(404).render('error', { err: new ErrorMessage('没有找到该协议。') });
  if (!canEdit(res)) return res.status(res.locals.user ? 403 : 401).render('error', { err: new ErrorMessage('仅站长和全站管理员可以编辑协议。') });
  try {
    const page = resource(await legal().refresh(), req.params.slug);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.render('legal_edit', { legalPage: page, legalEtag: api().etagFor(page) });
  } catch (error) {
    syzoj.log('[legal-editor] ' + error.message);
    return res.status(503).render('error', { err: new ErrorMessage('协议编辑页暂时无法读取。') });
  }
});

app.get('/api/v2/admin/legal/:slug', async (req, res) => {
  if (!requireEditor(res)) return;
  if (!knownSlug(req.params.slug)) return api().fail(res, 404, 'LEGAL_NOT_FOUND', '没有找到该协议。');
  try {
    const page = resource(await legal().refresh(), req.params.slug);
    res.setHeader('Cache-Control', 'private, no-store');
    api().setResourceEtag(res, page);
    return api().send(res, page);
  } catch (error) { return failure(res, error); }
});

app.patch('/api/v2/admin/legal/:slug', async (req, res) => {
  if (!requireEditor(res)) return;
  if (!knownSlug(req.params.slug)) return api().fail(res, 404, 'LEGAL_NOT_FOUND', '没有找到该协议。');
  const body = req.body || {};
  const ifMatch = req.get('If-Match') || body.if_match;
  if (!ifMatch) return api().fail(res, 428, 'PRECONDITION_REQUIRED', '缺少协议版本，请重新打开编辑页面。');
  try {
    const current = resource(await legal().refresh(), req.params.slug);
    if (ifMatch !== api().etagFor(current)) return api().fail(res, 412, 'ETAG_MISMATCH', '协议已被更新，请保留编辑内容并重新加载页面。');
    await api().ensureFoundationSchema();
    await syzoj.utils.authorizationV2.ensureSchema();
    const saved = await legal().publishDocument(req.params.slug, body.content, current.revision, Number(res.locals.user.id),
      (manager, details) => syzoj.utils.authorizationV2.recordAudit(req, {
        action: 'admin:legal.update', resourceType: 'legal_document', resourceId: req.params.slug,
        reason: syzoj.utils.operationReason(req, '更新' + current.title), details
      }, manager));
    const page = resource(saved.bundle, req.params.slug);
    // Keep the response representation identical to GET so meta.etag can be
    // reused on the next edit, including when a gateway strips ETag headers.
    res.locals.apiMeta = { ...res.locals.apiMeta, changed: saved.changed, audit_event_id: saved.auditEventId };
    return api().send(res, page);
  } catch (error) { return failure(res, error); }
});
