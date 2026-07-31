'use strict';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const INTERNAL_WRITE_PATHS = Object.freeze([
  /^\/judge(?:\/|$)/,
  /^\/socket\.io(?:\/|$)/
]);

function enabled() {
  return process.env.SYZOJ_V2_ONLY === '1' || process.env.SYZOJ_V2_ONLY === 'true';
}

function isV2Path(pathname) {
  return /^\/api\/v2(?:\/|$)/.test(String(pathname || ''));
}

function isInternalWritePath(pathname) {
  const path = String(pathname || '');
  return INTERNAL_WRITE_PATHS.some(pattern => pattern.test(path));
}

function shouldBlock(req) {
  if (!enabled() || !req || SAFE_METHODS.has(req.method)) return false;
  return !isV2Path(req.path || req.originalUrl) && !isInternalWritePath(req.path || req.originalUrl);
}

function response(req) {
  const requestId = String(req && req.id || '');
  return {
    data: null,
    meta: { request_id: requestId || null, api_version: '2', timestamp: new Date().toISOString() },
    error: {
      code: 'V2_ROUTE_REQUIRED',
      message: 'Write operations require an /api/v2 resource route.',
      fields: { path: String(req && req.path || '') }
    }
  };
}

module.exports = Object.freeze({
  SAFE_METHODS,
  INTERNAL_WRITE_PATHS,
  enabled,
  isV2Path,
  isInternalWritePath,
  shouldBlock,
  response
});
