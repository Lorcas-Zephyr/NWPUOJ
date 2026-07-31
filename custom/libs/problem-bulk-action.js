'use strict';

const MAX_PROBLEMS = 200;

function validationError(message, fields) {
  const error = new Error(message);
  error.code = 'VALIDATION_FAILED';
  error.statusCode = 422;
  error.fields = fields || {};
  return error;
}

function normalize(input) {
  const source = input && typeof input === 'object' ? input : {};
  const action = String(source.action || '').trim().toLowerCase();
  if (action !== 'archive') {
    throw validationError('The bulk problem action is not supported.', { action: 'must be archive' });
  }
  if (!Array.isArray(source.problem_ids)) {
    throw validationError('Problem IDs are required.', { problem_ids: `array with 1-${MAX_PROBLEMS} items required` });
  }
  const ids = source.problem_ids.map(Number);
  if (!ids.length || ids.length > MAX_PROBLEMS || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw validationError('Problem IDs are invalid.', { problem_ids: `1-${MAX_PROBLEMS} unique positive integers required` });
  }
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length !== ids.length) {
    throw validationError('Problem IDs must be unique.', { problem_ids: 'duplicate values are not allowed' });
  }
  return { action, problem_ids: uniqueIds };
}

function progress(total, processed) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.floor(processed * 100 / total)));
}

module.exports = { MAX_PROBLEMS, normalize, progress };
