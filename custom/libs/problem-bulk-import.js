'use strict';

const fs = require('fs-extra');
const path = require('path');
const { pipeline } = require('stream');
const { promisify, TextDecoder } = require('util');
const yauzl = require('yauzl');

const pipe = promisify(pipeline);
const decoder = new TextDecoder('utf-8', { fatal: true });
const FIXED_FILES = new Set([
  'problem.json',
  'description.md',
  'input.md',
  'output.md',
  'example.md',
  'hint.md'
]);
const REQUIRED_FILES = ['problem.json', 'description.md', 'input.md', 'output.md'];
const METADATA_KEYS = new Set(['title', 'time_limit', 'memory_limit', 'tags', 'is_anonymous']);
const DEFAULT_LIMITS = {
  maxProblems: 50,
  maxEntries: 2000,
  maxTotalSize: 200 * 1024 * 1024,
  maxProblemSize: 50 * 1024 * 1024,
  maxTestdataFileSize: 20 * 1024 * 1024,
  maxMetadataSize: 64 * 1024,
  maxMarkdownSize: 512 * 1024
};

function archiveError(message) {
  const error = new Error(message);
  error.code = 'INVALID_PROBLEM_ARCHIVE';
  return error;
}

function openArchive(filename) {
  return new Promise((resolve, reject) => {
    yauzl.open(filename, { lazyEntries: true, validateEntrySizes: true }, (error, archive) => {
      if (error) reject(archiveError('无法打开 ZIP 文件：' + error.message));
      else resolve(archive);
    });
  });
}

function normalizedEntry(entry) {
  const rawName = String(entry.fileName || '');
  if (!rawName || rawName.includes('\0') || rawName.includes('\\')) {
    throw archiveError('ZIP 内含非法路径。');
  }
  if (rawName !== rawName.normalize('NFC')) throw archiveError('ZIP 路径必须使用 Unicode NFC 格式：' + rawName);
  if (rawName.startsWith('/') || /^[A-Za-z]:/.test(rawName)) throw archiveError('ZIP 内不允许绝对路径：' + rawName);
  const directory = rawName.endsWith('/');
  const name = directory ? rawName.slice(0, -1) : rawName;
  const segments = name.split('/');
  if (!segments.length || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw archiveError('ZIP 内含路径穿越或空路径段：' + rawName);
  }
  if (segments.some(segment => Buffer.byteLength(segment, 'utf8') > 160)) {
    throw archiveError('ZIP 路径名称过长：' + rawName);
  }
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const unixType = unixMode & 0xf000;
  if (unixType === 0xa000) throw archiveError('ZIP 内不允许符号链接：' + rawName);
  if (unixType && unixType !== 0x4000 && unixType !== 0x8000) {
    throw archiveError('ZIP 内只允许普通文件和目录：' + rawName);
  }
  if (entry.generalPurposeBitFlag & 0x1) throw archiveError('ZIP 内不允许加密文件：' + rawName);
  return { rawName, name, directory, segments };
}

function validateFolderName(name) {
  if (!name || name.startsWith('.') || /[<>:"|?*\x00-\x1f]/.test(name)) {
    throw archiveError('题目子文件夹名称不合法：' + name);
  }
  if (Array.from(name).length > 80) throw archiveError('题目子文件夹名称不能超过 80 个字符：' + name);
}

function validateArchivePath(info) {
  const segments = info.segments;
  validateFolderName(segments[0]);
  if (info.directory) {
    if (segments.length === 1) return;
    if (segments.length === 2 && segments[1] === 'testdata') return;
    throw archiveError('ZIP 中只允许题目一级目录和 testdata 目录：' + info.rawName);
  }
  if (segments.length === 2 && FIXED_FILES.has(segments[1])) return;
  if (segments.length === 3 && segments[1] === 'testdata' &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}\.(?:in|out|ans)$/.test(segments[2])) return;
  throw archiveError('ZIP 中存在规范外文件：' + info.rawName);
}

function entrySizeLimit(info, limits) {
  if (info.directory) return 0;
  const filename = info.segments[info.segments.length - 1];
  if (filename === 'problem.json') return limits.maxMetadataSize;
  if (filename.endsWith('.md')) return limits.maxMarkdownSize;
  return limits.maxTestdataFileSize;
}

function extractEntry(archive, entry, target) {
  return new Promise((resolve, reject) => {
    archive.openReadStream(entry, async (error, stream) => {
      if (error) return reject(archiveError('无法读取 ZIP 文件项：' + error.message));
      try {
        await fs.ensureDir(path.dirname(target));
        await pipe(stream, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
        resolve();
      } catch (writeError) {
        reject(archiveError('解压文件失败：' + writeError.message));
      }
    });
  });
}

async function extractArchive(filename, stagingDirectory, customLimits) {
  const limits = Object.assign({}, DEFAULT_LIMITS, customLimits || {});
  const archive = await openArchive(filename);
  const folders = new Map();
  const seenPaths = new Set();
  let entryCount = 0;
  let totalSize = 0;

  await fs.ensureDir(stagingDirectory);
  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      try { archive.close(); } catch (closeError) {}
      reject(error.code === 'INVALID_PROBLEM_ARCHIVE' ? error : archiveError(error.message || String(error)));
    };
    archive.on('error', fail);
    archive.on('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    archive.on('entry', entry => {
      Promise.resolve().then(async () => {
        const info = normalizedEntry(entry);
        validateArchivePath(info);
        entryCount++;
        if (entryCount > limits.maxEntries) throw archiveError('ZIP 文件项超过 ' + limits.maxEntries + ' 个。');
        const pathKey = info.name.toLocaleLowerCase('en-US');
        if (seenPaths.has(pathKey)) throw archiveError('ZIP 内含重复或大小写冲突路径：' + info.rawName);
        seenPaths.add(pathKey);

        let folder = folders.get(info.segments[0]);
        if (!folder) {
          if (folders.size >= limits.maxProblems) throw archiveError('ZIP 最多包含 ' + limits.maxProblems + ' 道题目。');
          folder = { name: info.segments[0], size: 0, files: new Set(), testdataFiles: [] };
          folders.set(folder.name, folder);
        }
        if (info.directory) return;

        const size = Number(entry.uncompressedSize || 0);
        if (!Number.isSafeInteger(size) || size < 0 || size > entrySizeLimit(info, limits)) {
          throw archiveError('ZIP 文件项过大：' + info.rawName);
        }
        totalSize += size;
        folder.size += size;
        if (totalSize > limits.maxTotalSize) throw archiveError('ZIP 解压后总大小不能超过 ' + limits.maxTotalSize + ' 字节。');
        if (folder.size > limits.maxProblemSize) throw archiveError('单题解压后大小不能超过 ' + limits.maxProblemSize + ' 字节：' + folder.name);

        const relativeName = info.segments.slice(1).join('/');
        folder.files.add(relativeName);
        if (info.segments[1] === 'testdata') folder.testdataFiles.push(info.segments[2]);
        const target = path.join(stagingDirectory, ...info.segments);
        const resolvedTarget = path.resolve(target);
        const resolvedRoot = path.resolve(stagingDirectory) + path.sep;
        if (!resolvedTarget.startsWith(resolvedRoot)) throw archiveError('ZIP 路径超出暂存目录：' + info.rawName);
        await extractEntry(archive, entry, target);
      }).then(() => archive.readEntry(), fail);
    });
    archive.readEntry();
  });

  if (!folders.size) throw archiveError('ZIP 中没有题目子文件夹。');
  return buildProblemSpecs(stagingDirectory, Array.from(folders.values()));
}

async function readUtf8(filename, maximumSize) {
  const buffer = await fs.readFile(filename);
  if (buffer.length > maximumSize) throw archiveError('文本文件超过大小限制：' + path.basename(filename));
  try {
    return decoder.decode(buffer).replace(/^\uFEFF/, '');
  } catch (error) {
    throw archiveError('文本文件必须是严格 UTF-8 编码：' + path.basename(filename));
  }
}

function parseMetadata(text, folderName) {
  let metadata;
  try { metadata = JSON.parse(text); } catch (error) { throw archiveError(folderName + '/problem.json 不是有效 JSON。'); }
  if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') {
    throw archiveError(folderName + '/problem.json 必须是 JSON 对象。');
  }
  const unknownKeys = Object.keys(metadata).filter(key => !METADATA_KEYS.has(key));
  if (unknownKeys.length) throw archiveError(folderName + '/problem.json 含未知字段：' + unknownKeys.join(', '));
  if (typeof metadata.title !== 'string' || !metadata.title.trim() || metadata.title !== metadata.title.trim() || metadata.title.length > 80) {
    throw archiveError(folderName + '/problem.json 的 title 必须是 1 至 80 字符且首尾无空白。');
  }
  for (const key of ['time_limit', 'memory_limit']) {
    if (!Number.isSafeInteger(metadata[key]) || metadata[key] <= 0) {
      throw archiveError(folderName + '/problem.json 的 ' + key + ' 必须是正整数。');
    }
  }
  if (metadata.is_anonymous != null && typeof metadata.is_anonymous !== 'boolean') {
    throw archiveError(folderName + '/problem.json 的 is_anonymous 必须是布尔值。');
  }
  if (metadata.tags != null && (!Array.isArray(metadata.tags) || metadata.tags.length > 20)) {
    throw archiveError(folderName + '/problem.json 的 tags 必须是最多 20 项的数组。');
  }
  const tags = [];
  const tagKeys = new Set();
  for (const tag of metadata.tags || []) {
    if (typeof tag !== 'string' || !tag.trim() || tag !== tag.trim() || tag.length > 40) {
      throw archiveError(folderName + '/problem.json 的标签必须是 1 至 40 字符且首尾无空白。');
    }
    const key = tag.toLocaleLowerCase('en-US');
    if (tagKeys.has(key)) throw archiveError(folderName + '/problem.json 含重复标签：' + tag);
    tagKeys.add(key);
    tags.push(tag);
  }
  return {
    title: metadata.title,
    timeLimit: metadata.time_limit,
    memoryLimit: metadata.memory_limit,
    isAnonymous: metadata.is_anonymous === true,
    tags
  };
}

function validateTestdata(folder) {
  const pairs = new Map();
  for (const filename of folder.testdataFiles) {
    const match = /^(.*)\.(in|out|ans)$/.exec(filename);
    const base = match[1];
    const extension = match[2];
    const pair = pairs.get(base) || {};
    pair[extension] = filename;
    pairs.set(base, pair);
  }
  if (!pairs.size) throw archiveError(folder.name + '/testdata 必须至少包含一组输入输出。');
  for (const [base, pair] of pairs) {
    if (!pair.in) throw archiveError(folder.name + '/testdata/' + base + ' 缺少 .in 文件。');
    if ((!pair.out && !pair.ans) || (pair.out && pair.ans)) {
      throw archiveError(folder.name + '/testdata/' + base + ' 必须且只能有一个 .out 或 .ans 文件。');
    }
  }
}

async function buildProblemSpecs(stagingDirectory, folders) {
  const result = [];
  for (const folder of folders.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))) {
    for (const required of REQUIRED_FILES) {
      if (!folder.files.has(required)) throw archiveError(folder.name + ' 缺少必需文件 ' + required + '。');
    }
    validateTestdata(folder);
    const base = path.join(stagingDirectory, folder.name);
    const metadata = parseMetadata(
      await readUtf8(path.join(base, 'problem.json'), DEFAULT_LIMITS.maxMetadataSize),
      folder.name
    );
    const description = await readUtf8(path.join(base, 'description.md'), DEFAULT_LIMITS.maxMarkdownSize);
    if (!description.trim()) throw archiveError(folder.name + '/description.md 不能为空。');
    result.push(Object.assign(metadata, {
      folderName: folder.name,
      description,
      inputFormat: await readUtf8(path.join(base, 'input.md'), DEFAULT_LIMITS.maxMarkdownSize),
      outputFormat: await readUtf8(path.join(base, 'output.md'), DEFAULT_LIMITS.maxMarkdownSize),
      example: folder.files.has('example.md')
        ? await readUtf8(path.join(base, 'example.md'), DEFAULT_LIMITS.maxMarkdownSize)
        : '',
      hint: folder.files.has('hint.md')
        ? await readUtf8(path.join(base, 'hint.md'), DEFAULT_LIMITS.maxMarkdownSize)
        : '',
      testdataDirectory: path.join(base, 'testdata'),
      testdataFiles: folder.testdataFiles.slice().sort()
    }));
  }
  return result;
}

module.exports = {
  DEFAULT_LIMITS,
  extractArchive,
  normalizedEntry,
  parseMetadata,
  validateArchivePath,
  validateTestdata
};
