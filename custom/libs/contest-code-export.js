'use strict';

const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const ZIP_BINARY = fs.existsSync('/usr/bin/7z') ? '/usr/bin/7z' : '/usr/bin/zip';
const ZIP_UTF8_ENV = Object.assign({}, process.env, { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });

function safePart(value, fallback) {
  const normalized = String(value == null ? '' : value)
    .replace(/[\\/\0]/g, '_')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^\.+$/, '')
    .slice(0, 120);
  return normalized || fallback;
}

function languageExtension(language, languages) {
  const value = String(language || '').trim().toLowerCase();
  const configured = languages && languages[language];
  const configuredFormat = configured && String(configured.fileExtension || configured.format || '').trim().toLowerCase();
  const configuredExtensions = {
    c: 'c', cpp: 'cpp', cxx: 'cpp', java: 'java', pas: 'pas', pascal: 'pas',
    py: 'py', python: 'py', js: 'js', javascript: 'js', ts: 'ts', typescript: 'ts',
    rb: 'rb', ruby: 'rb', hs: 'hs', haskell: 'hs', cs: 'cs', csharp: 'cs',
    lua: 'lua', go: 'go', rs: 'rs', rust: 'rs', kt: 'kt', kotlin: 'kt'
  };
  if (configuredExtensions[configuredFormat]) {
    return configuredExtensions[configuredFormat];
  }
  if (/^java(?:[0-9._-].*)?$/.test(value)) return 'java';
  if (/^(?:python|pypy)(?:[0-9._-].*)?$/.test(value)) return 'py';
  if (/^(?:cpp|c\+\+|gnu\+\+|g\+\+|clang\+\+)(?:[0-9._-].*)?$/.test(value)) return 'cpp';
  if (/^(?:c|gnu-c|clang-c)(?:[0-9._-].*)?$/.test(value)) return 'c';
  if (/^(?:javascript|node|nodejs|typescript|js|ts)(?:[0-9._-].*)?$/.test(value)) return /^(?:ts|typescript)/.test(value) ? 'ts' : 'js';
  if (/^(?:go|golang)(?:[0-9._-].*)?$/.test(value)) return 'go';
  if (/^(?:rust|rs)(?:[0-9._-].*)?$/.test(value)) return 'rs';
  if (/^(?:kotlin|kt)(?:[0-9._-].*)?$/.test(value)) return 'kt';
  if (/^(?:csharp|cs)(?:[0-9._-].*)?$/.test(value)) return 'cs';
  if (/^(?:pascal|pas)(?:[0-9._-].*)?$/.test(value)) return 'pas';
  if (/^(?:ruby|rb)(?:[0-9._-].*)?$/.test(value)) return 'rb';
  if (/^(?:haskell|hs)(?:[0-9._-].*)?$/.test(value)) return 'hs';
  if (/^(?:lua)(?:[0-9._-].*)?$/.test(value)) return 'lua';
  return 'txt';
}

function uniquePath(directory, basename, extension) {
  const suffix = extension ? `.${extension}` : '';
  let candidate = path.join(directory, basename + suffix);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${basename}-${index++}${suffix}`);
  }
  return candidate;
}

async function loadSubmissions(connection, contestId) {
  const rows = await connection.query(
    `SELECT js.id,js.user_id,js.problem_id,js.language,js.code,js.submit_time,
            u.username,p.type
       FROM judge_state js
       JOIN user u ON u.id=js.user_id
       LEFT JOIN problem p ON p.id=js.problem_id
      WHERE js.type=1 AND js.type_info=?
      ORDER BY js.user_id ASC,js.id ASC`,
    [Number(contestId)]
  );
  if (!rows.length) return rows;
  try {
    const versions = await connection.query(
      'SELECT submission_id,source_code FROM submission_v2_code_version WHERE submission_id IN (?)',
      [rows.map(row => Number(row.id))]
    );
    const sources = new Map(versions.map(row => [Number(row.submission_id), row.source_code]));
    rows.forEach(row => { if (sources.has(Number(row.id))) row.version_source = sources.get(Number(row.id)); });
  } catch (_) {
    // Older installations may not have the v2 source table. The legacy code
    // column remains a complete fallback for those submissions.
  }
  return rows;
}

async function buildContestCodeArchive({ connection, contestId, languages, fileModel }) {
  const rows = await loadSubmissions(connection, contestId);
  const token = crypto.randomBytes(8).toString('hex');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `noj-contest-${Number(contestId)}-${token}-`));
  const archive = path.join(os.tmpdir(), `noj-contest-${Number(contestId)}-${token}.zip`);
  try {
    if (!rows.length) {
      // PKZIP's fixed end-of-central-directory record is a valid empty ZIP.
      await fs.writeFile(archive, Buffer.from('504b0506000000000000000000000000000000000000', 'hex'));
      return { archive, root, count: 0 };
    }
    const userDirectories = new Map();
    for (const row of rows) {
      const userId = Number(row.user_id);
      let directoryName = userDirectories.get(userId);
      if (!directoryName) {
        directoryName = safePart(row.username, `user-${userId}`);
        userDirectories.set(userId, directoryName);
      }
      const directory = path.join(root, directoryName);
      await fs.ensureDir(directory);
      const basename = `${safePart(row.problem_id, 'problem')}-${Number(row.id)}`;
      const extension = languageExtension(row.language, languages);
      const answerArchive = row.type === 'submit-answer' && row.code && fileModel && typeof fileModel.resolvePath === 'function'
        ? fileModel.resolvePath('answer', row.code)
        : null;
      const target = uniquePath(directory, basename, answerArchive ? 'zip' : extension);
      if (answerArchive && await fs.pathExists(answerArchive)) {
        await fs.copy(answerArchive, target);
      } else {
        const source = row.version_source == null ? String(row.code == null ? '' : row.code) : String(row.version_source);
        await fs.writeFile(target, source, 'utf8');
      }
    }
    const zipArguments = ZIP_BINARY.endsWith('/7z')
      ? ['a', '-tzip', '-bd', archive, '.']
      : ['-q', '-r', archive, '.'];
    await execFileAsync(ZIP_BINARY, zipArguments, { cwd: root, env: ZIP_UTF8_ENV, maxBuffer: 1024 * 1024 });
    return { archive, root, count: rows.length };
  } catch (error) {
    await fs.remove(root).catch(() => {});
    await fs.remove(archive).catch(() => {});
    throw error;
  }
}

async function cleanupContestCodeArchive(result) {
  if (!result) return;
  await Promise.all([
    result.root ? fs.remove(result.root).catch(() => {}) : null,
    result.archive ? fs.remove(result.archive).catch(() => {}) : null
  ]);
}

module.exports = { buildContestCodeArchive, cleanupContestCodeArchive, languageExtension, safePart };
