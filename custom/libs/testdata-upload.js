'use strict';

const fs = require('fs-extra');
const path = require('path');
const { pipeline } = require('stream');
const { promisify } = require('util');
const yauzl = require('yauzl');

const pipe = promisify(pipeline);
const DEFAULT_LIMITS = Object.freeze({ maxEntries: 2000, maxTotalSize: 200 * 1024 * 1024, maxFileSize: 50 * 1024 * 1024 });

function uploadError(message) {
  const error = new Error(message);
  error.code = 'TESTDATA_UPLOAD_INVALID';
  error.statusCode = 422;
  return error;
}

function normalizedEntry(entry) {
  const raw = String(entry.fileName || '');
  if (!raw || raw.includes('\0') || raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw uploadError('ZIP contains an invalid path.');
  const directory = raw.endsWith('/');
  const name = directory ? raw.slice(0, -1) : raw;
  const segments = name.split('/');
  if (!segments.length || segments.some(segment => !segment || segment === '.' || segment === '..' || Buffer.byteLength(segment, 'utf8') > 160)) throw uploadError('ZIP contains an unsafe path.');
  const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
  if (mode === 0xa000 || mode && mode !== 0x4000 && mode !== 0x8000 || entry.generalPurposeBitFlag & 0x1) throw uploadError('ZIP contains an unsupported entry.');
  return { directory, name, segments };
}

function openArchive(filename) {
  return new Promise((resolve, reject) => yauzl.open(filename, { lazyEntries: true, validateEntrySizes: true }, (error, archive) => error ? reject(uploadError('Unable to open ZIP archive.')) : resolve(archive)));
}

async function extractTestdataArchive(filename, destination, customLimits) {
  const limits = Object.assign({}, DEFAULT_LIMITS, customLimits || {});
  const archive = await openArchive(filename);
  const root = path.resolve(destination);
  const seen = new Set();
  let entries = 0;
  let totalSize = 0;
  await fs.ensureDir(root);
  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => { if (!settled) { settled = true; try { archive.close(); } catch (_) {} reject(error.statusCode ? error : uploadError(error.message || 'Unable to extract ZIP archive.')); } };
    archive.on('error', fail);
    archive.on('end', () => { if (!settled) { settled = true; resolve(); } });
    archive.on('entry', entry => Promise.resolve().then(async () => {
      const info = normalizedEntry(entry);
      entries += 1;
      if (entries > limits.maxEntries) throw uploadError('ZIP contains too many entries.');
      const key = info.name.toLocaleLowerCase('en-US');
      if (seen.has(key)) throw uploadError('ZIP contains duplicate paths.');
      seen.add(key);
      if (info.directory) return;
      const size = Number(entry.uncompressedSize || 0);
      if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileSize || (totalSize += size) > limits.maxTotalSize) throw uploadError('ZIP exceeds the allowed extracted size.');
      const target = path.resolve(root, ...info.segments);
      if (!target.startsWith(root + path.sep)) throw uploadError('ZIP path escapes the staging directory.');
      await new Promise((resolveStream, rejectStream) => archive.openReadStream(entry, async (error, stream) => {
        if (error) return rejectStream(uploadError('Unable to read ZIP entry.'));
        try { await fs.ensureDir(path.dirname(target)); await pipe(stream, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 })); resolveStream(); } catch (writeError) { rejectStream(uploadError(writeError.message)); }
      }));
    }).then(() => archive.readEntry(), fail));
    archive.readEntry();
  });
  return { entries, total_size: totalSize };
}

async function replaceDirectory(current, staging, backup) {
  const currentExists = await fs.pathExists(current);
  await fs.remove(backup);
  try {
    if (currentExists) await fs.move(current, backup, { overwrite: false });
    await fs.move(staging, current, { overwrite: false });
    await fs.remove(backup);
  } catch (error) {
    if (!await fs.pathExists(current) && await fs.pathExists(backup)) await fs.move(backup, current, { overwrite: false });
    throw error;
  }
}

module.exports = { DEFAULT_LIMITS, extractTestdataArchive, replaceDirectory, uploadError };
