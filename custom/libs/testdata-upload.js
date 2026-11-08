'use strict';

const fs = require('fs-extra');
const path = require('path');
const { pipeline, Transform } = require('stream');
const { promisify } = require('util');
const crypto = require('crypto');
const yauzl = require('yauzl');
const yaml = require('js-yaml');

const pipe = promisify(pipeline);
const DEFAULT_LIMITS = Object.freeze({ maxEntries: 100000, maxTotalSize: 8 * 1024 * 1024 * 1024, maxFileSize: 2 * 1024 * 1024 * 1024 });

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

const TESTDATA_WRAPPER_NAMES = new Set(['data', 'testdata', 'tests', 'testcases', 'cases']);

function rewriteDataYamlPaths(root, prefix) {
  const filename = path.join(root, 'data.yml');
  if (!fs.pathExistsSync(filename)) return;
  const text = fs.readFileSync(filename, 'utf8');
  let config;
  try { config = yaml.load(text); } catch (_) { return; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return;
  const stripPrefix = value => {
    if (typeof value !== 'string') return value;
    const normalized = value.replace(/\\/g, '/');
    const marker = `${prefix}/`;
    return normalized.startsWith(marker) ? normalized.slice(marker.length) : value;
  };
  for (const field of ['inputFile', 'outputFile', 'userOutput']) config[field] = stripPrefix(config[field]);
  for (const field of ['interactor', 'specialJudge', 'communication']) {
    if (config[field] && typeof config[field] === 'object') config[field].fileName = stripPrefix(config[field].fileName);
  }
  fs.writeFileSync(filename, yaml.dump(config, { noRefs: true }));
}

async function flattenTestdataDirectory(root, name) {
  const nested = path.join(root, name);
  const children = await fs.readdir(nested);
  for (const child of children) await fs.move(path.join(nested, child), path.join(root, child), { overwrite: false });
  await fs.remove(nested);
  rewriteDataYamlPaths(root, name);
}

// Archives made by selecting a containing folder often have extra levels
// (for example `problem/testdata/1.in`). Flatten only a short chain of sole
// top-level directories, plus one conventional data directory alongside
// metadata such as `data.yml`, so arbitrary nested paths remain rejected.
async function normalizeTestdataDirectory(root) {
  let flattened = false;
  // Unwrap a short chain such as `problem/testdata/1.in`, but never guess
  // through mixed top-level files or an arbitrary deep directory tree.
  for (let depth = 0; depth < 3; depth++) {
    const entries = await fs.readdir(root);
    const directories = [];
    for (const name of entries) {
      const stat = await fs.lstat(path.join(root, name));
      if (stat.isDirectory()) directories.push(name);
      else break;
    }
    if (directories.length !== 1 || directories.length !== entries.length) break;
    await flattenTestdataDirectory(root, directories[0]);
    flattened = true;
  }
  // A data.yml/interactor at the root with files under `data/` is also a
  // supported layout. Only unwrap one known directory and leave unrelated
  // nested trees untouched.
  const entries = await fs.readdir(root);
  const wrappers = [];
  for (const name of entries) {
    const stat = await fs.lstat(path.join(root, name));
    if (stat.isDirectory() && TESTDATA_WRAPPER_NAMES.has(name.toLowerCase())) wrappers.push(name);
    else if (stat.isDirectory()) wrappers.push(null);
  }
  const known = wrappers.filter(Boolean);
  if (known.length === 1 && wrappers.every(name => name === known[0] || name === null)) {
    const nonWrapperDirectories = wrappers.filter(name => name === null).length;
    if (!nonWrapperDirectories) {
      await flattenTestdataDirectory(root, known[0]);
      flattened = true;
    }
  }
  return flattened;
}

// Inspect the whole file before changing any bytes: a binary marker may occur
// long after a text-looking prefix. Work in bounded chunks and keep legacy
// encodings byte-for-byte; only CRLF pairs and an initial UTF-8 BOM are removed.
async function normalizeTestdataTextFile(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw uploadError('Testdata normalization requires a regular file.');
  let first = true, bom = false, previousCR = false, crlf = 0;
  for await (const chunk of fs.createReadStream(filename)) {
    if (first) {
      bom = chunk.length >= 3 && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf;
      // UTF-16/32 need an explicit encoding conversion, not byte deletion.
      if (chunk.length >= 2 && (chunk[0] === 0xff && chunk[1] === 0xfe || chunk[0] === 0xfe && chunk[1] === 0xff)) {
        return { changed: false, skipped_binary: true, crlf: 0, bom: false, size: stat.size };
      }
      first = false;
    }
    const bytes = chunk.toString('latin1');
    if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(bytes)) return { changed: false, skipped_binary: true, crlf: 0, bom: false, size: stat.size };
    if (previousCR && chunk[0] === 10) crlf++;
    let index = -1;
    while ((index = bytes.indexOf('\r\n', index + 1)) !== -1) crlf++;
    previousCR = chunk[chunk.length - 1] === 13;
  }
  if (!crlf && !bom) return { changed: false, skipped_binary: false, crlf: 0, bom: false, size: stat.size };
  const temporary = path.join(path.dirname(filename), '.newline-' + crypto.randomUUID());
  let carry = '';
  const normalizer = new Transform({
    transform(chunk, _encoding, callback) {
      let bytes = carry + chunk.toString('latin1');
      carry = bytes.endsWith('\r') ? '\r' : '';
      if (carry) bytes = bytes.slice(0, -1);
      callback(null, Buffer.from(bytes.replace(/\r\n/g, '\n'), 'latin1'));
    },
    flush(callback) { callback(null, Buffer.from(carry, 'latin1')); }
  });
  try {
    await pipe(fs.createReadStream(filename, { start: bom ? 3 : 0 }), normalizer,
      fs.createWriteStream(temporary, { flags: 'wx', mode: stat.mode & 0o777 }));
    await fs.rename(temporary, filename);
  } finally { await fs.remove(temporary); }
  return { changed: true, skipped_binary: false, crlf, bom, size: stat.size - crlf - (bom ? 3 : 0) };
}

async function normalizeTestdataTextDirectory(root) {
  const summary = { normalized_files: 0, crlf: 0, bom_files: 0, skipped_binary_files: 0 };
  async function visit(directory) {
    for (const name of await fs.readdir(directory)) {
      const filename = path.join(directory, name), stat = await fs.lstat(filename);
      if (stat.isSymbolicLink()) throw uploadError('Testdata normalization does not allow symbolic links.');
      if (stat.isDirectory()) { await visit(filename); continue; }
      const result = await normalizeTestdataTextFile(filename);
      summary.normalized_files += Number(result.changed);
      summary.crlf += result.crlf;
      summary.bom_files += Number(result.bom);
      summary.skipped_binary_files += Number(result.skipped_binary);
    }
  }
  await visit(root);
  return summary;
}

async function replaceDirectory(current, staging, backup, options = {}) {
  const currentExists = await fs.pathExists(current);
  await fs.remove(backup);
  try {
    if (currentExists) await fs.move(current, backup, { overwrite: false });
    await fs.move(staging, current, { overwrite: false });
    if (!options.keepBackup) await fs.remove(backup);
    return { currentExists };
  } catch (error) {
    if (!await fs.pathExists(current) && await fs.pathExists(backup)) await fs.move(backup, current, { overwrite: false });
    throw error;
  }
}

async function validateCommunicationTestdata(root, type, languages) {
  if (type !== 'communication') return;
  let config;
  try { config = yaml.load(await fs.readFile(path.join(root, 'data.yml'), 'utf8')); }
  catch (error) { throw uploadError('通信题需要有效的 data.yml 和 communication 转换程序配置。'); }
  const transformer = config && config.communication;
  if (!transformer || typeof transformer !== 'object' || typeof transformer.fileName !== 'string' ||
      !transformer.fileName || /[\\/\x00]/.test(transformer.fileName) || ['.', '..'].includes(transformer.fileName)) {
    throw uploadError('communication.fileName 必须是数据包根目录中的转换程序文件名。');
  }
  if (typeof transformer.language !== 'string' || !Object.prototype.hasOwnProperty.call(languages || {}, transformer.language)) {
    throw uploadError('communication.language 必须是受支持的评测语言，例如 cpp17。');
  }
  const stat = await fs.lstat(path.join(root, transformer.fileName)).catch(() => null);
  if (!stat || !stat.isFile()) throw uploadError('找不到通信转换程序文件：' + transformer.fileName);
}

module.exports = { DEFAULT_LIMITS, extractTestdataArchive, normalizeTestdataDirectory, normalizeTestdataTextFile, normalizeTestdataTextDirectory, validateCommunicationTestdata, replaceDirectory, uploadError };
