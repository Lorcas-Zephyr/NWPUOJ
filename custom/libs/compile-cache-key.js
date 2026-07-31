'use strict';

const crypto = require('crypto');

function canonical(value) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object') return undefined;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = canonical(value[key]);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex');
}

function compilerMetadata(input = {}) {
  const language = String(input.language || 'unknown');
  const compilerImage = String(input.compilerImage || 'runner-configured');
  const config = canonical(input.languageConfig || {});
  const compilerVersion = String(input.compilerVersion || config.compiler_version || config.version || compilerImage);
  const sourceHash = sha256(input.source);
  const languageConfigHash = sha256(JSON.stringify(config));
  const compileCacheKey = sha256(JSON.stringify({
    source_hash: sourceHash,
    language,
    language_config_hash: languageConfigHash,
    compiler_image: compilerImage,
    compiler_version: compilerVersion
  }));
  return {
    compileCacheKey,
    sourceHash,
    language,
    languageConfigHash,
    compilerImage,
    compilerVersion
  };
}

module.exports = { canonical, compilerMetadata, sha256 };
