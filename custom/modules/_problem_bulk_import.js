'use strict';

const crypto = require('crypto');
const fs = require('fs-extra');
const nativeFs = require('fs');
const multer = require('multer');
const os = require('os');
const path = require('path');
const { extractArchive } = require('../libs/problem-bulk-import');

const Problem = syzoj.model('problem');
const ProblemTag = syzoj.model('problem_tag');
const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024;
const STAGING_ROOT = '/app/uploads/problem-imports';
const ALLOWED_MIME_TYPES = new Set(['application/zip', 'application/x-zip-compressed', 'application/octet-stream']);

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_ARCHIVE_SIZE, files: 1 },
  fileFilter: (req, file, callback) => {
    const extensionAllowed = path.extname(file.originalname || '').toLowerCase() === '.zip';
    if (extensionAllowed && ALLOWED_MIME_TYPES.has(file.mimetype)) return callback(null, true);
    const error = new Error('仅支持扩展名为 .zip 的 ZIP 文件。');
    error.code = 'INVALID_ZIP_TYPE';
    callback(error);
  }
}).single('archive');

function importError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode || 400;
  return error;
}

async function canManageProblems(user) {
  return !!(user && (user.is_admin || await user.hasPrivilege('manage_problem')));
}

function requireProblemManager(req, res, next) {
  Promise.resolve(canManageProblems(res.locals.user)).then(allowed => {
    if (!allowed) return res.status(403).render('error', { err: new ErrorMessage('您没有添加题目的权限。') });
    next();
  }).catch(next);
}

function receiveArchive(req, res, next) {
  upload(req, res, error => {
    if (!error) return next();
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'ZIP 文件不能超过 50 MiB。'
      : (error.message || 'ZIP 文件上传失败。');
    res.status(400).render('error', { err: new ErrorMessage(message) });
  });
}

function ensureImportCsrfToken(req) {
  if (!req.session.problemImportCsrfToken) {
    req.session.problemImportCsrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.problemImportCsrfToken;
}

function validImportCsrfToken(req) {
  const expected = req.session && req.session.problemImportCsrfToken;
  const actual = req.body && req.body.csrf_token;
  return typeof expected === 'string' && typeof actual === 'string' && expected.length === actual.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

async function verifyZipSignature(filename) {
  const file = await nativeFs.promises.open(filename, 'r');
  const buffer = Buffer.alloc(4);
  try {
    const result = await file.read(buffer, 0, 4, 0);
    if (result.bytesRead < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b ||
        ![[0x03, 0x04], [0x05, 0x06], [0x07, 0x08]].some(signature =>
          buffer[2] === signature[0] && buffer[3] === signature[1])) {
      throw importError('上传内容不是有效的 ZIP 文件。');
    }
  } finally {
    await file.close();
  }
}

async function resolveTags(specs) {
  const names = Array.from(new Set(specs.flatMap(spec => spec.tags)));
  const tags = new Map();
  for (const name of names) {
    const tag = await ProblemTag.findOne({ where: { name } });
    if (!tag) throw importError('标签“' + name + '”不存在，请先在标签管理中创建。');
    tags.set(name, tag.id);
  }
  return tags;
}

async function removeCreatedProblem(problem) {
  try { await fs.remove(problem.getTestdataPath()); } catch (error) {}
  try { await fs.remove(problem.getTestdataArchivePath()); } catch (error) {}
  try { await problem.delete(); } catch (error) {
    syzoj.log('[problem-bulk-import] Rollback failed for #' + problem.id + ': ' + error.message);
  }
}

async function importProblemSpecs(specs, actor, makePublic) {
  const tagIds = await resolveTags(specs);
  const created = [];
  try {
    for (const spec of specs) {
      const problem = Problem.create({ type: 'traditional' });
      problem.title = spec.title;
      problem.user_id = actor.id;
      problem.publicizer_id = null;
      problem.is_anonymous = spec.isAnonymous;
      problem.description = spec.description;
      problem.input_format = spec.inputFormat;
      problem.output_format = spec.outputFormat;
      problem.example = spec.example;
      problem.limit_and_hint = spec.hint;
      problem.time_limit = spec.timeLimit;
      problem.memory_limit = spec.memoryLimit;
      problem.additional_file_id = null;
      problem.ac_num = 0;
      problem.submit_num = 0;
      problem.is_public = false;
      problem.file_io = false;
      problem.file_io_input_name = null;
      problem.file_io_output_name = null;
      problem.publicize_time = null;
      problem.vjudge_config = null;
      const validationError = await problem.validate();
      if (validationError) throw importError(spec.folderName + ' 的题目配置无效：' + validationError);
      await problem.save();
      created.push(problem);

      await problem.setTags(spec.tags.map(name => tagIds.get(name)));
      await fs.remove(problem.getTestdataPath());
      await fs.copy(spec.testdataDirectory, problem.getTestdataPath(), { overwrite: false, errorOnExist: true });
      await fs.remove(problem.getTestdataArchivePath());
      const parsedTestdata = await syzoj.utils.parseTestdata(problem.getTestdataPath(), false);
      if (!parsedTestdata || parsedTestdata.error) {
        throw importError(spec.folderName + ' 的测试数据无法被评测系统识别。');
      }
    }

    for (const problem of created) {
      problem.is_public = makePublic;
      if (makePublic) {
        problem.publicizer_id = actor.id;
        problem.publicize_time = new Date();
      }
      await problem.save();
    }
    return created;
  } catch (error) {
    for (const problem of created.slice().reverse()) await removeCreatedProblem(problem);
    throw error;
  }
}

app.get('/problem/:id/import', requireProblemManager, async (req, res) => {
  if (String(req.params.id) !== '0') {
    return res.status(400).render('error', { err: new ErrorMessage('ZIP 批量导入只能从添加题目入口发起。') });
  }
  res.render('problem_import', {
    problemImportCsrfToken: ensureImportCsrfToken(req),
    maximumArchiveSizeMiB: MAX_ARCHIVE_SIZE / 1024 / 1024
  });
});

app.post('/problem/:id/import', requireProblemManager, receiveArchive, async (req, res) => {
  let stagingDirectory = null;
  try {
    if (String(req.params.id) !== '0') throw importError('ZIP 批量导入只能从添加题目入口发起。');
    if (!validImportCsrfToken(req)) throw importError('页面已失效，请刷新后重新上传。', 403);
    if (!req.file) throw importError('请选择 ZIP 文件。');
    await verifyZipSignature(req.file.path);
    await fs.ensureDir(STAGING_ROOT);
    stagingDirectory = path.join(STAGING_ROOT, crypto.randomBytes(20).toString('hex'));
    const imported = await syzoj.utils.lock(['Problem::BulkImport'], async () => {
      const specs = await extractArchive(req.file.path, stagingDirectory);
      return importProblemSpecs(specs, res.locals.user, req.body.is_public === 'on');
    });
    req.session.problemImportCsrfToken = crypto.randomBytes(32).toString('hex');
    res.render('problem_import_result', { imported });
  } catch (error) {
    syzoj.log('[problem-bulk-import] ' + (error.stack || error));
    res.status(error.statusCode || 400).render('error', { err: new ErrorMessage(error.message || 'ZIP 导入失败。') });
  } finally {
    if (req.file && req.file.path) await fs.remove(req.file.path).catch(() => {});
    if (stagingDirectory) await fs.remove(stagingDirectory).catch(() => {});
  }
});
