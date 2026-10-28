'use strict';

const { DOCUMENTS, createLegalService } = require('../libs/legal-documents');
const legal = createLegalService({ editable: true });
syzoj.utils.legalDocuments = legal;

// Load before identity-completion gates. Reading the rules must not require
// registration, email activation, or a complete student profile.
app.get('/legal/:slug', async (req, res, next) => {
  if (!DOCUMENTS.some(item => item.slug === req.params.slug)) return next();
  try {
    const bundle = await legal.getBundle(req.query.version);
    if (!bundle) return res.status(404).render('error', { err: new ErrorMessage('没有找到该协议版本。请从页脚重新打开。') });
    const document = bundle.documents.find(item => item.slug === req.params.slug);
    let headingIndex = 0;
    const headings = document.markdown.split('\n').filter(line => /^## /.test(line))
      .map((line, index) => ({ id: 'legal-section-' + (index + 1), title: line.slice(3) }));
    const html = String(await syzoj.utils.markdown(document.markdown))
      .replace(/href="\/legal\/(terms|privacy|competition|copyright)(#[^"]*)?"/g,
        (match, slug, anchor) => 'href="/legal/' + slug + '?version=' + bundle.revision + (anchor || '') + '"')
      .replace(/<h2(?:\s[^>]*)?>/g, () => '<h2 id="legal-section-' + (++headingIndex) + '">')
      .replace(/<table\b/g, '<div class="app-legal-table" role="region" aria-label="信息清单，可横向滚动" tabindex="0"><table')
      .replace(/<\/table>/g, '</table></div>');
    res.setHeader('Cache-Control', 'private, no-store');
    if (bundle.manifest.status === 'draft') res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.render('legal', {
      legalDocument: document,
      legalManifest: bundle.manifest,
      legalRevision: bundle.revision,
      legalDocuments: DOCUMENTS,
      legalCanEdit: !!(res.locals && res.locals.user && (res.locals.user.is_admin || res.locals.isSiteOwner)),
      legalHeadings: headings,
      legalHtml: html
    });
  } catch (error) {
    syzoj.log('[legal-documents] ' + (error.stack || error));
    return res.status(500).render('error', { err: new ErrorMessage('协议暂时无法读取，请稍后重试。') });
  }
});
