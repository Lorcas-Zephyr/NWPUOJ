const crypto = require('crypto');
const Problem = syzoj.model('problem');
const ProblemTag = syzoj.model('problem_tag');
const JudgeState = syzoj.model('judge_state');
const poj = require('../libs/vjudge/poj');
const judger = require('../libs/judger');
const createImportStatus = require('../libs/vjudge-import-status');

const BULK_IMPORT_INTERVAL = 500;
const bulkImportStatus = { state: 'idle' };
const importStatus = createImportStatus('poj', bulkImportStatus);

function requireAdmin(res) {
  if (!res.locals.user || !res.locals.user.is_admin) throw new ErrorMessage('您没有权限进行此操作。');
}

function requireAdminAction(req, res) {
  requireAdmin(res);
  const expected = req.session && req.session.adminCsrfToken;
  const actual = req.body && req.body.csrf_token;
  if (typeof expected !== 'string' || typeof actual !== 'string' || expected.length !== actual.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) {
    res.status(403);
    const error = new ErrorMessage('页面已失效，请刷新后台管理页面后重试。');
    error.statusCode = 403;
    throw error;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensurePojSourceTag() {
  let sourceTag;
  await syzoj.utils.lock(['POJ::source-tag'], async () => {
    sourceTag = await ProblemTag.findOne({ where: { name: 'POJ' } });
    if (!sourceTag) {
      sourceTag = ProblemTag.create({ name: 'POJ', color: 'pink' });
      await sourceTag.save();
    } else if (sourceTag.color !== 'pink') {
      sourceTag.color = 'pink';
      await sourceTag.save();
    }
  });
  return sourceTag;
}

async function importPojProblem(remoteId, options) {
  let result;
  await syzoj.utils.lock(['POJ::import', remoteId], async () => {
    let problem = await Problem.findOne({
      where: { type: 'vjudge:poj', vjudge_config: String(remoteId) }
    });
    if (options.skipExisting && problem) {
      result = { skipped: true, localId: problem.id };
      return;
    }
    const remote = await poj.fetchProblem(remoteId);
    const isNew = !problem;
    if (isNew) problem = Problem.create({ type: 'vjudge:poj' });
    problem.title = remote.title.slice(0, 80);
    problem.description = remote.description;
    problem.input_format = remote.inputFormat;
    problem.output_format = remote.outputFormat;
    problem.example = remote.example;
    problem.limit_and_hint = remote.hint;
    problem.time_limit = remote.timeLimit;
    problem.memory_limit = remote.memoryLimit;
    problem.vjudge_config = String(remoteId);
    problem.file_io = false;
    problem.is_public = options.isPublic;
    if (isNew) {
      problem.is_anonymous = true;
      problem.user_id = options.userId;
    }
    if (problem.is_public) {
      problem.publicizer_id = options.userId;
      problem.publicize_time = new Date();
    }
    await problem.save();
    const sourceTag = await ensurePojSourceTag();
    const tagIds = (await problem.getTags()).map(tag => tag.id);
    if (!tagIds.includes(sourceTag.id)) await problem.setTags(tagIds.concat(sourceTag.id));
    result = { skipped: false, localId: problem.id };
  });
  return result;
}

async function runBulkImport(userId, isPublic) {
  try {
    await poj.verifyAccount();
    const remoteIds = await poj.fetchProblemIds();
    const existingProblems = await Problem.find({ where: { type: 'vjudge:poj' } });
    const existingIds = new Set(existingProblems.map(problem => String(problem.vjudge_config)));
    const pendingIds = remoteIds.filter(remoteId => !existingIds.has(String(remoteId)));
    bulkImportStatus.phase = 'importing';
    bulkImportStatus.total = remoteIds.length;
    bulkImportStatus.skipped = remoteIds.length - pendingIds.length;
    bulkImportStatus.processed = bulkImportStatus.skipped;
    await importStatus.save();

    for (const remoteId of pendingIds) {
      bulkImportStatus.currentRemoteId = remoteId;
      try {
        const result = await importPojProblem(remoteId, {
          userId: userId,
          isPublic: isPublic,
          skipExisting: true
        });
        if (result.skipped) bulkImportStatus.skipped++;
        else bulkImportStatus.imported++;
      } catch (error) {
        bulkImportStatus.failed++;
        if (bulkImportStatus.failures.length < 50) {
          bulkImportStatus.failures.push({
            remoteId: remoteId,
            message: error && error.message ? error.message : String(error)
          });
        }
        syzoj.log('[poj-import-all] Failed P' + remoteId + ': ' + (error.stack || error));
      }
      bulkImportStatus.processed++;
      await importStatus.save();
      await delay(BULK_IMPORT_INTERVAL);
    }
    bulkImportStatus.state = 'completed';
    bulkImportStatus.phase = null;
    bulkImportStatus.currentRemoteId = null;
    bulkImportStatus.finishedAt = new Date().toISOString();
    await importStatus.save();
  } catch (error) {
    bulkImportStatus.state = 'failed';
    bulkImportStatus.phase = null;
    bulkImportStatus.currentRemoteId = null;
    bulkImportStatus.error = error && error.message ? error.message : String(error);
    bulkImportStatus.finishedAt = new Date().toISOString();
    syzoj.log('[poj-import-all] Failed: ' + (error.stack || error));
    await importStatus.save().catch(saveError => syzoj.log(saveError));
  }
}

async function startBulkImport(userId, isPublic) {
  await importStatus.ready();
  if (bulkImportStatus.state === 'running') return false;
  Object.assign(bulkImportStatus, {
    state: 'running',
    phase: 'listing',
    total: 0,
    processed: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    failures: [],
    currentRemoteId: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null
  });
  await importStatus.save();
  setImmediate(() => runBulkImport(userId, isPublic));
  return true;
}

app.post('/admin/poj/check', async (req, res) => {
  try {
    requireAdminAction(req, res);
    await poj.verifyAccount();
    res.render('admin_other', { success: true, successMessage: 'POJ 账号连接成功。' });
  } catch (error) {
    syzoj.log('[poj-account-check] ' + (error.stack || error.message || error));
    res.render('error', { err: error });
  }
});

app.post('/admin/poj/import', async (req, res) => {
  try {
    requireAdminAction(req, res);
    const remoteId = parseInt(req.body.problem_id);
    if (!Number.isSafeInteger(remoteId) || remoteId <= 0) throw new ErrorMessage('POJ 题号不正确。');
    const result = await importPojProblem(remoteId, {
      userId: res.locals.user.id,
      isPublic: req.body.is_public === 'on',
      skipExisting: false
    });
    res.redirect(syzoj.utils.makeUrl(['problem', result.localId]));
  } catch (error) {
    syzoj.log('[poj-import] ' + (error.stack || error.message || error));
    res.render('error', { err: error });
  }
});

app.post('/admin/poj/import-all', async (req, res) => {
  try {
    requireAdminAction(req, res);
    if (!await startBulkImport(res.locals.user.id, req.body.is_public === 'on')) {
      return res.status(409).render('error', { err: new ErrorMessage('POJ 批量导入正在运行。') });
    }
    res.redirect('/admin/other');
  } catch (error) {
    syzoj.log('[poj-import-all] ' + (error.stack || error.message || error));
    res.render('error', { err: error });
  }
});

app.get('/admin/poj/import-all/status', async (req, res) => {
  try {
    requireAdmin(res);
    await importStatus.ready();
    res.json(bulkImportStatus);
  } catch (error) {
    res.status(403).json({ state: 'failed', error: error.message || String(error) });
  }
});

async function resumePendingPojSubmissions(attempt) {
  try {
    const pending = await JudgeState.find({ where: { pending: true } });
    for (const state of pending) {
      if (judger.getCachedJudgeState(state.task_id)) continue;
      const problem = await Problem.findById(state.problem_id);
      if (!problem || problem.type !== 'vjudge:poj') continue;
      judger.initializeRecoveredVJudge(state);
      let marker = state.result;
      if (typeof marker === 'string') {
        try { marker = JSON.parse(marker); } catch (error) { marker = null; }
      }
      marker = marker && marker.vjudge;
      const submissionId = marker && Number(marker.submissionId);
      const problemId = marker && Number(marker.problemId);
      const onProgress = progress => judger.handleVJudgeProgress(state.id, progress);
      if (marker && marker.provider === 'poj' && Number.isSafeInteger(submissionId) && Number.isSafeInteger(problemId)) {
        poj.resume(state, submissionId, problemId, onProgress);
        syzoj.log('[poj-vjudge] Resumed submission #' + state.id + ' from POJ #' + submissionId);
      } else if (marker && marker.provider === 'poj' && marker.phase === 'submitting' &&
        Number.isSafeInteger(problemId) && Number.isSafeInteger(Number(marker.beforeId)) &&
        Number.isSafeInteger(Number(marker.codeLength)) && marker.expectedLanguage) {
        marker.beforeId = Number(marker.beforeId);
        marker.codeLength = Number(marker.codeLength);
        poj.resumeSubmitting(state, marker, onProgress);
        syzoj.log('[poj-vjudge] Recovering submission #' + state.id + ' interrupted during POJ submit');
      } else {
        await onProgress({
          taskId: state.task_id,
          type: 4,
          progress: { error: 0, systemMessage: 'POJ 提交恢复信息不完整，请重新评测。' }
        });
      }
    }
  } catch (error) {
    syzoj.log('[poj-vjudge] Failed to resume pending submissions: ' + (error.stack || error));
    if (attempt < 3) setTimeout(() => resumePendingPojSubmissions(attempt + 1), attempt * 1000);
  }
}

setTimeout(() => resumePendingPojSubmissions(1), 1500);
