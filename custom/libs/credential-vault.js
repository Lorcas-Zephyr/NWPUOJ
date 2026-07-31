'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function parseKey(value) {
  const text = String(value || '').trim();
  if (/^[a-f0-9]{64}$/i.test(text)) return Buffer.from(text, 'hex');
  try {
    const decoded = Buffer.from(text, 'base64');
    return decoded.length === 32 ? decoded : null;
  } catch (error) {
    return null;
  }
}

function loadOrCreateKey(filePath, environmentValue) {
  const configured = parseKey(environmentValue);
  if (configured) return configured;
  try {
    const stored = parseKey(fs.readFileSync(filePath, 'utf8'));
    if (!stored) throw new Error('Credential vault key is invalid.');
    return stored;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const generated = crypto.randomBytes(32);
  try {
    fs.writeFileSync(filePath, generated.toString('hex'), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return generated;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stored = parseKey(fs.readFileSync(filePath, 'utf8'));
    if (!stored) throw new Error('Credential vault key is invalid.');
    return stored;
  }
}

function encrypt(value, key, context = '') {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('A 256-bit credential vault key is required.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(context), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64')
  };
}

function decrypt(record, key, context = '') {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('A 256-bit credential vault key is required.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
  decipher.setAAD(Buffer.from(String(context), 'utf8'));
  decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

function referenceFingerprint(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

module.exports = { decrypt, encrypt, loadOrCreateKey, parseKey, referenceFingerprint };
