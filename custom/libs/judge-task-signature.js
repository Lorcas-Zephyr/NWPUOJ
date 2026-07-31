'use strict';

const crypto = require('crypto');

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function normalizedKey(value) {
  const key = Buffer.from(String(value || ''), 'utf8');
  if (key.length < 16) throw new Error('Judge task signing key must contain at least 16 bytes.');
  return key;
}

function extraDataHash(extraData) {
  return crypto.createHash('sha256').update(extraData == null ? Buffer.alloc(0) : Buffer.from(extraData)).digest('hex');
}

function unsignedContent(content) {
  const copy = Object.assign({}, content);
  delete copy.taskSignature;
  return copy;
}

function signingPayload(content, extraData) {
  return `${stableStringify(unsignedContent(content))}\n${extraDataHash(extraData)}`;
}

function sign(content, extraData, key) {
  return crypto.createHmac('sha256', normalizedKey(key)).update(signingPayload(content, extraData)).digest('hex');
}

function attach(content, extraData, key) {
  const value = sign(content, extraData, key);
  content.taskSignature = { version: 'hmac-sha256-v1', value };
  return content;
}

function verify(content, extraData, key) {
  const signature = content && content.taskSignature;
  if (!signature || signature.version !== 'hmac-sha256-v1' || !/^[a-f0-9]{64}$/i.test(String(signature.value || ''))) return false;
  const expected = Buffer.from(sign(content, extraData, key)); const supplied = Buffer.from(String(signature.value));
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

module.exports = { stableStringify, extraDataHash, signingPayload, sign, attach, verify };
