const crypto = require('crypto');
const TypeORM = require('typeorm');
const Problem = syzoj.model('problem');
const ProblemTag = syzoj.model('problem_tag');
const JudgeState = syzoj.model('judge_state');
const hdu = require('../libs/vjudge/hdu');
const judger = require('../libs/judger');
const createImportStatus = require('../libs/vjudge-import-status');

const BULK_IMPORT_INTERVAL = 500;
const bulkImportStatus = { state: 'idle' };
const importStatus = createImportStatus('hdu', bulkImportStatus);

async function requireAdmin(res) {
  if (!res.locals.user || !await syzoj.utils.authorizationV2.authorize(res.locals.user, 'vjudge:import.create', null, { scope: 'global' })) {
    throw new ErrorMessage('您没有权限进行此操作。');
  }
}

async function requireAdminAction(req, res) {
  await requireAdmin(res);
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) {
    const error = new ErrorMessage('高风险 VJudge 操作需要近期登录或 MFA 验证。'); error.statusCode = 403; throw error;
  }
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

async function ensureHduSourceTag() {
  let sourceTag;
  await syzoj.utils.lock(['HDU::source-tag'], async () => {
    sourceTag = await ProblemTag.findOne({ where: { name: 'HDU' } });
    if (!sourceTag) {
      sourceTag = ProblemTag.create({ name: 'HDU', color: 'pink' });
      await sourceTag.save();
    } else if (sourceTag.color !== 'pink') {
      sourceTag.color = 'pink';
      await sourceTag.save();
    }
    if (syzoj.utils.problemWorkflowV2) await syzoj.utils.problemWorkflowV2.ensureSchema();
    await TypeORM.getConnection().query("UPDATE problem_tag SET category='source',color='pink' WHERE id=?", [sourceTag.id]);
  });
  return sourceTag;
}

async function importHduProblem(remoteId, options) {
  let result;
  await syzoj.utils.lock(['HDU::import', remoteId], async () => {
    let problem = await Problem.findOne({
      where: {
        type: 'vjudge:hdu',
        vjudge_config: String(remoteId)
      }
    });
    if (options.skipExisting && problem) {
      result = { skipped: true, localId: problem.id };
      return;
    }

    const remote = await hdu.fetchProblem(remoteId);
    const isNew = !problem;
    if (isNew) problem = Problem.create({ type: 'vjudge:hdu' });

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

    const sourceTag = await ensureHduSourceTag();
    const tagIds = (await problem.getTags()).map(tag => tag.id);
    if (!tagIds.includes(sourceTag.id)) await problem.setTags(tagIds.concat(sourceTag.id));
    result = { skipped: false, localId: problem.id };
  });
  return result;
}

async function runBulkImport(userId, isPublic) {
  try {
    await hdu.verifyAccount();
    const remoteIds = await hdu.fetchProblemIds();
    const existingProblems = await Problem.find({ where: { type: 'vjudge:hdu' } });
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
        const result = await importHduProblem(remoteId, {
          userId: userId,
          isPublic: isPublic,
          skipExisting: true
        });
        if (result.skipped) bulkImportStatus.skipped++;
        else bulkImportStatus.imported++;
      } catch (e) {
        bulkImportStatus.failed++;
        if (bulkImportStatus.failures.length < 50) {
          bulkImportStatus.failures.push({
            remoteId: remoteId,
            message: e && e.message ? e.message : String(e)
          });
        }
        syzoj.log('[hdu-import-all] Failed H' + remoteId + ': ' + (e.stack || e));
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
  } catch (e) {
    bulkImportStatus.state = 'failed';
    bulkImportStatus.phase = null;
    bulkImportStatus.currentRemoteId = null;
    bulkImportStatus.error = e && e.message ? e.message : String(e);
    bulkImportStatus.finishedAt = new Date().toISOString();
    syzoj.log('[hdu-import-all] Failed: ' + (e.stack || e));
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

syzoj.utils.vjudgeImporters = syzoj.utils.vjudgeImporters || {};
syzoj.utils.vjudgeImporters.hdu = {
  withCredential: (reference, operation) => hdu.withCredential(reference, operation, { secretResolver: syzoj.utils.vjudgeSecretResolver }),
  checkAccount: () => hdu.checkAccount(),
  verifyAccount: () => hdu.checkAccount(),
  searchProblems: (query, cursor) => hdu.searchProblems(query, cursor),
  fetchProblem: remoteId => hdu.fetchProblem(remoteId),
  fetchProblemList: cursor => hdu.fetchProblemList(cursor),
  submit: (remoteProblem, language, source, options) => hdu.submit(remoteProblem, language, source, options),
  pollSubmission: (remoteSubmissionId, options) => hdu.pollSubmission(remoteSubmissionId, options),
  normalizeResult: rawResult => hdu.normalizeResult(rawResult),
  fetchProblemIds: () => hdu.fetchProblemIds(),
  importProblem: (remoteId, options) => importHduProblem(remoteId, options)
};




app.get('/admin/hdu/import-all/status', async (req, res) => {
  try {
    await requireAdmin(res);
    await importStatus.ready();
    res.json(bulkImportStatus);
  } catch (e) {
    res.status(403).json({ state: 'failed', error: e.message || String(e) });
  }
});

async function resumePendingHduSubmissions(attempt) {
  try {
    const pending = await JudgeState.find({ where: { pending: true } });
    for (const state of pending) {
      if (judger.getCachedJudgeState(state.task_id)) continue;
      const problem = await Problem.findById(state.problem_id);
      if (!problem || problem.type !== 'vjudge:hdu') continue;
      judger.initializeRecoveredVJudge(state);

      let marker = state.result;
      if (typeof marker === 'string') {
        try { marker = JSON.parse(marker); } catch (e) { marker = null; }
      }
      marker = marker && marker.vjudge;
      const submissionId = marker && Number(marker.submissionId);
      const problemId = marker && Number(marker.problemId);
      const onProgress = progress => judger.handleVJudgeProgress(state.id, progress);
      if (marker && marker.provider === 'hdu' && Number.isSafeInteger(submissionId) && Number.isSafeInteger(problemId)) {
        hdu.resume(state, submissionId, problemId, onProgress);
        syzoj.log('[hdu-vjudge] Resumed submission #' + state.id + ' from HDU #' + submissionId);
      } else if (marker && marker.provider === 'hdu' && marker.phase === 'submitting' &&
        Number.isSafeInteger(problemId) && Number.isSafeInteger(Number(marker.beforeId)) &&
        Number.isSafeInteger(Number(marker.codeLength)) && marker.expectedLanguage) {
        marker.beforeId = Number(marker.beforeId);
        marker.codeLength = Number(marker.codeLength);
        hdu.resumeSubmitting(state, marker, onProgress);
        syzoj.log('[hdu-vjudge] Recovering submission #' + state.id + ' interrupted during HDU submit');
      } else {
        await onProgress({
          taskId: state.task_id,
          type: 4,
          progress: {
            error: 0,
            systemMessage: 'Web 重启发生在 HDU Run ID 持久化之前，请重新评测。'
          }
        });
      }
    }
  } catch (e) {
    syzoj.log('[hdu-vjudge] Failed to resume pending submissions: ' + (e.stack || e));
    if (attempt < 3) setTimeout(() => resumePendingHduSubmissions(attempt + 1), attempt * 1000);
  }
}

setTimeout(() => resumePendingHduSubmissions(1), 1500);
