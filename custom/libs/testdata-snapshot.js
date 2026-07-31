'use strict';

const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');

function snapshotError(message) {
  const error = new Error(message);
  error.code = 'TESTDATA_SNAPSHOT_INVALID';
  error.statusCode = 422;
  return error;
}

function safeSnapshotId(value) {
  const id = String(value || '');
  if (!/^ps_[A-Za-z0-9_-]{8,100}$/.test(id)) throw snapshotError('Invalid testdata snapshot identifier.');
  return id;
}

function safeProblemId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw snapshotError('Invalid problem identifier.');
  return id;
}

function snapshotRelativePath(snapshotId) {
  return `snapshots/${safeSnapshotId(snapshotId)}`;
}

function currentTestdataPath(uploadDirectory, problemId) {
  return path.resolve(String(uploadDirectory), 'testdata', String(safeProblemId(problemId)));
}

function snapshotDirectory(uploadDirectory, snapshotId) {
  return path.resolve(String(uploadDirectory), 'testdata', ...snapshotRelativePath(snapshotId).split('/'));
}

function compareName(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function updateFileHash(hash, filename) {
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filename);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
}

async function manifest(directory, options = {}) {
  const root = path.resolve(directory);
  if (!await fs.pathExists(root)) {
    if (options.allowMissing) return { hash: crypto.createHash('sha256').digest('hex'), files: [] };
    throw snapshotError('Testdata directory does not exist.');
  }
  const hash = crypto.createHash('sha256');
  const files = [];

  async function visit(relative = '') {
    const location = path.join(root, relative);
    const entries = await fs.readdir(location, { withFileTypes: true });
    entries.sort((left, right) => compareName(left.name, right.name));
    for (const entry of entries) {
      const child = relative ? path.join(relative, entry.name) : entry.name;
      const normalized = child.split(path.sep).join('/');
      const absolute = path.join(root, child);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw snapshotError(`Testdata snapshot does not allow symbolic links: ${normalized}`);
      if (stat.isDirectory()) {
        await visit(child);
        continue;
      }
      if (!stat.isFile()) throw snapshotError(`Testdata snapshot contains an unsupported entry: ${normalized}`);
      hash.update(normalized);
      hash.update('\0');
      hash.update(String(stat.size));
      hash.update('\0');
      await updateFileHash(hash, absolute);
      files.push({ path: normalized, size: Number(stat.size) });
    }
  }

  await visit();
  return { hash: hash.digest('hex'), files };
}

async function capture(uploadDirectory, problemId, snapshotId) {
  const source = currentTestdataPath(uploadDirectory, problemId);
  const destination = snapshotDirectory(uploadDirectory, snapshotId);
  const expected = await manifest(source, { allowMissing: true });
  if (await fs.pathExists(destination)) {
    const current = await manifest(destination);
    if (current.hash !== expected.hash) throw snapshotError('Testdata snapshot identifier already refers to different data.');
    return { id: safeSnapshotId(snapshotId), path: snapshotRelativePath(snapshotId), hash: expected.hash, files: expected.files, created: false };
  }

  const temporary = `${destination}.staging-${crypto.randomUUID()}`;
  try {
    await fs.ensureDir(path.dirname(destination));
    if (await fs.pathExists(source)) await fs.copy(source, temporary, { overwrite: false, errorOnExist: true, dereference: false });
    else await fs.ensureDir(temporary);
    const copied = await manifest(temporary);
    if (copied.hash !== expected.hash) throw snapshotError('Testdata changed while creating its snapshot. Retry the publication.');
    await fs.move(temporary, destination, { overwrite: false });
    return { id: safeSnapshotId(snapshotId), path: snapshotRelativePath(snapshotId), hash: expected.hash, files: expected.files, created: true };
  } catch (error) {
    await fs.remove(temporary).catch(() => {});
    throw error;
  }
}

async function remove(uploadDirectory, snapshotId) {
  const directory = snapshotDirectory(uploadDirectory, snapshotId);
  await fs.remove(directory);
}

module.exports = {
  capture,
  currentTestdataPath,
  manifest,
  remove,
  safeSnapshotId,
  snapshotDirectory,
  snapshotRelativePath
};
