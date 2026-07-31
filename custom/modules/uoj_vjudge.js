const crypto = require('crypto');
const TypeORM = require('typeorm');
const Problem = syzoj.model('problem');
const ProblemTag = syzoj.model('problem_tag');
const JudgeState = syzoj.model('judge_state');
const uoj = require('../libs/vjudge/uoj');
const judger = require('../libs/judger');
const createImportStatus = require('../libs/vjudge-import-status');

const BULK_IMPORT_INTERVAL = 500;
const bulkImportStatus = { state: 'idle' };
const importStatus = createImportStatus('uoj', bulkImportStatus);

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

async function ensureUojSourceTag() {
  let sourceTag;
  await syzoj.utils.lock(['UOJ::source-tag'], async () => {
    sourceTag = await ProblemTag.findOne({ where: { name: 'UOJ' } });
    if (!sourceTag) {
      sourceTag = ProblemTag.create({ name: 'UOJ', color: 'pink' });
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

async function importUojProblem(remoteId, options) {
  let result;
  await syzoj.utils.lock(['UOJ::import', remoteId], async () => {
    let problem = await Problem.findOne({
      where: {
        type: 'vjudge:uoj',
        vjudge_config: String(remoteId)
      }
    });
    if (options.skipExisting && problem) {
      result = { skipped: true, localId: problem.id };
      return;
    }

    const remote = await uoj.fetchProblem(remoteId);
    const isNew = !problem;
    if (isNew) problem = Problem.create({ type: 'vjudge:uoj' });

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

    const sourceTag = await ensureUojSourceTag();
    const tagIds = (await problem.getTags()).map(tag => tag.id);
    if (!tagIds.includes(sourceTag.id)) await problem.setTags(tagIds.concat(sourceTag.id));
    result = { skipped: false, localId: problem.id };
  });
  return result;
}

async function runBulkImport(userId, isPublic) {
  try {
    await uoj.verifyAccount();
    const remoteIds = await uoj.fetchProblemIds();
    const existingProblems = await Problem.find({ where: { type: 'vjudge:uoj' } });
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
        const result = await importUojProblem(remoteId, {
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
        syzoj.log('[uoj-import-all] Failed U' + remoteId + ': ' + (e.stack || e));
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
    syzoj.log('[uoj-import-all] Failed: ' + (e.stack || e));
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
syzoj.utils.vjudgeImporters.uoj = {
  withCredential: (reference, operation) => uoj.withCredential(reference, operation, { secretResolver: syzoj.utils.vjudgeSecretResolver }),
  checkAccount: () => uoj.checkAccount(),
  verifyAccount: () => uoj.checkAccount(),
  searchProblems: (query, cursor) => uoj.searchProblems(query, cursor),
  fetchProblem: remoteId => uoj.fetchProblem(remoteId),
  fetchProblemList: cursor => uoj.fetchProblemList(cursor),
  submit: (remoteProblem, language, source, options) => uoj.submit(remoteProblem, language, source, options),
  pollSubmission: (remoteSubmissionId, options) => uoj.pollSubmission(remoteSubmissionId, options),
  normalizeResult: rawResult => uoj.normalizeResult(rawResult),
  fetchProblemIds: () => uoj.fetchProblemIds(),
  importProblem: (remoteId, options) => importUojProblem(remoteId, options)
};




app.get('/admin/uoj/import-all/status', async (req, res) => {
  try {
    await requireAdmin(res);
    await importStatus.ready();
    res.json(bulkImportStatus);
  } catch (e) {
    res.status(403).json({ state: 'failed', error: e.message || String(e) });
  }
});

async function resumePendingUojSubmissions(attempt) {
  try {
    const pending = await JudgeState.find({ where: { pending: true } });
    for (const state of pending) {
      if (judger.getCachedJudgeState(state.task_id)) continue;
      const problem = await Problem.findById(state.problem_id);
      if (!problem || problem.type !== 'vjudge:uoj') continue;
      judger.initializeRecoveredVJudge(state);
      let marker = state.result;
      if (typeof marker === 'string') {
        try { marker = JSON.parse(marker); } catch (e) { marker = null; }
      }
      marker = marker && marker.vjudge;
      const submissionId = marker && Number(marker.submissionId);
      const problemId = marker && Number(marker.problemId);
      const onProgress = progress => judger.handleVJudgeProgress(state.id, progress);
      if (marker && marker.provider === 'uoj' && Number.isSafeInteger(submissionId)) {
        uoj.resume(state, submissionId, onProgress);
        syzoj.log('[uoj-vjudge] Resumed submission #' + state.id + ' from UOJ #' + submissionId);
      } else if (marker && marker.provider === 'uoj' && marker.phase === 'submitting' &&
        Number.isSafeInteger(problemId) && Number.isSafeInteger(Number(marker.beforeId))) {
        marker.beforeId = Number(marker.beforeId);
        uoj.resumeSubmitting(state, marker, onProgress);
        syzoj.log('[uoj-vjudge] Recovering submission #' + state.id + ' interrupted during UOJ submit');
      } else {
        await onProgress({
          taskId: state.task_id,
          type: 4,
          progress: { error: 0, systemMessage: 'UOJ 提交恢复信息不完整，请重新评测。' }
        });
      }
    }
  } catch (e) {
    syzoj.log('[uoj-vjudge] Failed to resume pending submissions: ' + (e.stack || e));
    if (attempt < 3) setTimeout(() => resumePendingUojSubmissions(attempt + 1), attempt * 1000);
  }
}

setTimeout(() => resumePendingUojSubmissions(1), 1500);
