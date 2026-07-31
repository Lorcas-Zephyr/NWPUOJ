const crypto = require('crypto');

function operationError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode || 400;
  error.expected = true;
  return error;
}

function parseProblemIds(value) {
  const values = Array.isArray(value) ? value : [value];
  const ids = values.map(item => Number(item));
  if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw operationError('请选择需要归档的题目。');
  }
  return Array.from(new Set(ids));
}

function isValidCsrfToken(req) {
  const expected = req.session && req.session.problemBulkDeleteCsrfToken;
  const actual = req.body && req.body.csrf_token;
  if (typeof expected !== 'string' || typeof actual !== 'string' || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}
