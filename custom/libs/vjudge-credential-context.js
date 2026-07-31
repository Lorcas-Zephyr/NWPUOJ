'use strict';

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();
const PROVIDER_PATTERN = /^[a-z0-9_-]{1,32}$/;
const ENV_REFERENCE_PATTERN = /^env:([A-Z0-9_]+)$/;

function credentialError(message, code = 'UPSTREAM_AUTH_FAILED') {
  const error = new Error(message);
  error.publicCode = code;
  return error;
}

function normalizeProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  if (!PROVIDER_PATTERN.test(value)) throw credentialError('The VJudge provider is invalid.', 'VJUDGE_PROVIDER_NOT_FOUND');
  return value;
}

function normalizeCredentials(provider, value, fingerprint) {
  const username = String(value && value.username || '').trim();
  const password = String(value && value.password || '');
  if (!username || !password) throw credentialError('The provider credential reference is unavailable or incomplete.');
  return Object.freeze({ provider, username, password, fingerprint });
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

async function resolveReference(provider, reference, options = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedReference = String(reference || '').trim();
  const environmentMatch = ENV_REFERENCE_PATTERN.exec(normalizedReference);
  let resolved;
  if (environmentMatch) {
    const environment = options.environment || process.env;
    resolved = {
      username: environment[environmentMatch[1] + '_USERNAME'],
      password: environment[environmentMatch[1] + '_PASSWORD']
    };
  } else if (/^(?:vault|secret):\/\/[A-Za-z0-9._\/-]+$/.test(normalizedReference) && typeof options.secretResolver === 'function') {
    resolved = await options.secretResolver(normalizedReference, { provider: normalizedProvider });
  } else {
    throw credentialError('The provider credential reference cannot be resolved by this deployment.');
  }
  return normalizeCredentials(normalizedProvider, resolved, fingerprint(normalizedReference));
}

async function run(provider, reference, operation, options = {}) {
  if (typeof operation !== 'function') throw new TypeError('A credential-scoped operation is required.');
  const credentials = await resolveReference(provider, reference, options);
  return storage.run(credentials, operation);
}

function current(provider, environment = process.env) {
  const normalizedProvider = normalizeProvider(provider);
  const scoped = storage.getStore();
  if (scoped) {
    if (scoped.provider !== normalizedProvider) throw credentialError('A credential was used with the wrong VJudge provider.');
    return scoped;
  }
  const prefix = 'SYZOJ_WEB_' + normalizedProvider.toUpperCase();
  return normalizeCredentials(normalizedProvider, {
    username: environment[prefix + '_USERNAME'],
    password: environment[prefix + '_PASSWORD']
  }, fingerprint('legacy:' + normalizedProvider));
}

module.exports = { current, resolveReference, run };
