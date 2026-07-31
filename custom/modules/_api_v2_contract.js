'use strict';

function api() {
  return syzoj.utils.apiV2;
}

app.use('/api/v2', (req, res) => api().fail(
  res,
  404,
  'API_ROUTE_NOT_FOUND',
  'The requested API route was not found.',
  { path: req.originalUrl }
));

app.use('/api/v2', (error, req, res, next) => {
  if (res.headersSent) return next(error);
  const requestedStatus = Number(error && (error.statusCode || error.status));
  const status = Number.isSafeInteger(requestedStatus) && requestedStatus >= 400 && requestedStatus <= 599
    ? requestedStatus
    : 500;
  const stableCode = status >= 500
    ? 'INTERNAL_ERROR'
    : error && /^[A-Z][A-Z0-9_]{2,79}$/.test(String(error.code || ''))
      ? String(error.code)
      : 'REQUEST_FAILED';
  const message = status >= 500
    ? 'The request could not be completed because of an internal error.'
    : String(error && error.message || 'The request could not be completed.');
  if (status >= 500) syzoj.log(`[api-v2] ${req.id || 'unknown request'} failed: ${error && (error.stack || error.message) || 'unknown error'}`);
  return api().fail(res, status, stableCode, message, error && error.fields || {});
});
