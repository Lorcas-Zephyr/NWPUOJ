'use strict';

const crypto = require('crypto');
const TypeORM = require('typeorm');
const aiProviders = require('./ai-provider-adapters');
const submissionDomain = require('./submission-domain');
const submissionStorage = require('./submission-storage');
const contestMutation = require('./contest-mutation');

const Contest = syzoj.model('contest');
const Problem = syzoj.model('problem');
const JudgeState = syzoj.model('judge_state');
const Judger = syzoj.lib('judger');
const MAX_ATTEMPTS = 20;
const MODEL_RETRIES = 3;
const DEEPSEEK_REASONING_TIMEOUT_MS = 10 * 60 * 1000;
const RUN_STATES = new Set(['queued', 'planning', 'solving', 'submitting', 'waiting_result', 'repairing', 'completed', 'stopped', 'failed', 'cancelled']);
const TERMINAL_RUN_STATES = new Set(['completed', 'stopped', 'failed', 'cancelled']);
const activeRuns = new Set();
let schemaPromise = null;

function now() { return Math.floor(Date.now() / 1000); }
function id() { return crypto.randomUUID(); }
function json(value, fallback) { try { return value == null ? fallback : JSON.parse(value); } catch (_) { return fallback; } }
function aiError(code, message, statusCode = 409) { return Object.assign(new Error(message), { code, statusCode }); }
function retryableModelError(error) { return !!(error && ['AI_PROVIDER_ERROR', 'AI_RESPONSE_INVALID', 'AI_RESPONSE_EMPTY', 'AI_RESPONSE_TRUNCATED', 'AI_TIMEOUT', 'AI_RATE_LIMITED'].includes(error.code)); }
function sleep(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

async function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const connection = TypeORM.getConnection();
    await connection.query(`CREATE TABLE IF NOT EXISTS ai_agent_account (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL,
      provider VARCHAR(32) NOT NULL, model VARCHAR(120) NOT NULL,
      api_key_env VARCHAR(120) NOT NULL, enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_ai_agent_user(user_id), UNIQUE KEY uq_ai_agent_provider(provider)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS ai_contest_run (
      id CHAR(36) NOT NULL PRIMARY KEY, contest_id INT NOT NULL, agent_id INT NOT NULL, user_id INT NOT NULL,
      state VARCHAR(24) NOT NULL, current_problem_id INT NULL, current_attempt INT NOT NULL DEFAULT 0,
      max_attempts INT NOT NULL DEFAULT 20, total_tokens BIGINT NOT NULL DEFAULT 0,
      last_error VARCHAR(1000) NULL, started_at INT NULL, updated_at INT NOT NULL,
      finished_at INT NULL, created_at INT NOT NULL,
      UNIQUE KEY uq_ai_run_contest_agent(contest_id,agent_id), KEY idx_ai_run_state(state,updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS ai_contest_attempt (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, run_id CHAR(36) NOT NULL,
      problem_id INT NOT NULL, attempt_no INT NOT NULL, submission_id INT NULL,
      language VARCHAR(40) NULL, source LONGTEXT NULL, verdict VARCHAR(80) NULL,
      judge_status VARCHAR(80) NULL, state VARCHAR(24) NOT NULL, model_response LONGTEXT NULL,
      tokens INT NOT NULL DEFAULT 0, created_at INT NOT NULL, completed_at INT NULL,
      UNIQUE KEY uq_ai_attempt(run_id,problem_id,attempt_no), KEY idx_ai_attempt_submission(submission_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`ALTER TABLE ai_contest_run ADD COLUMN IF NOT EXISTS max_attempts INT NOT NULL DEFAULT 20 AFTER current_attempt`);
  })().catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}

async function ensureAgentAccounts() {
  await ensureSchema();
  const connection = TypeORM.getConnection();
  for (const provider of ['deepseek', 'gpt']) {
    const config = aiProviders.providerConfig(provider);
    const username = config.name;
    await connection.transaction(async manager => {
      const existing = await manager.query('SELECT id,username FROM user WHERE BINARY username=? LIMIT 1 FOR UPDATE', [username]);
      let userId;
      if (existing.length) {
        const agents = await manager.query('SELECT id,provider FROM ai_agent_account WHERE user_id=? LIMIT 1 FOR UPDATE', [existing[0].id]);
        if (!agents.length) throw aiError('AI_ACCOUNT_NAME_CONFLICT', `用户名 ${username} 已被普通账户占用，无法创建 AI 账户。`, 409);
        if (agents[0].provider !== provider) throw aiError('AI_ACCOUNT_PROVIDER_CONFLICT', `AI 账户 ${username} 已绑定其他模型厂商。`, 409);
        userId = Number(existing[0].id);
      } else {
        const password = `ai-${crypto.randomBytes(32).toString('hex')}`;
        const passwordHash = await syzoj.utils.hashPassword(password);
        const result = await manager.query(`INSERT INTO user
          (username,email,password,nickname,nameplate,information,ac_num,submit_num,is_admin,is_show,public_email,prefer_formatted_code,sex,rating,register_time)
          VALUES (?,NULL,?,?,'','AI 参赛账户',0,0,0,1,0,1,0,?,?)`, [username, passwordHash, username, Number(syzoj.config.default.user.rating || 1500), now()]);
        userId = Number(result.insertId);
      }
      await manager.query(`INSERT INTO ai_agent_account (user_id,provider,model,api_key_env,enabled,created_at,updated_at)
        VALUES (?,?,?,?,1,FROM_UNIXTIME(?),FROM_UNIXTIME(?))
        ON DUPLICATE KEY UPDATE model=VALUES(model),api_key_env=VALUES(api_key_env),updated_at=VALUES(updated_at)`,
      [userId, provider, config.model, config.keyEnv, now(), now()]);
    });
  }
}

async function listAgents() {
  await ensureAgentAccounts();
  const rows = await TypeORM.getConnection().query('SELECT agent.id,agent.user_id,agent.provider,agent.model,agent.api_key_env,agent.enabled,user.username FROM ai_agent_account agent INNER JOIN user ON user.id=agent.user_id ORDER BY agent.id');
  return rows.map(row => ({ id: Number(row.id), user_id: Number(row.user_id), username: row.username, provider: row.provider, model: row.model, enabled: !!row.enabled, configured: !!String(process.env[row.api_key_env] || '').trim() }));
}

async function contestProblemIds(contest) { return (await contest.getProblems()).map(Number).filter(Number.isSafeInteger); }

async function problemForPrompt(contestId, problemId) {
  const connection = TypeORM.getConnection();
  const snapshots = await connection.query(`SELECT snapshot.problem_id,snapshot.content_json,snapshot.content_hash,snapshot.testdata_hash,snapshot.testdata_path,problem.title,problem.type
    FROM contest_v2_problem_snapshot link
    INNER JOIN problem_v2_snapshot snapshot ON snapshot.id=link.problem_snapshot_id
    INNER JOIN problem ON problem.id=snapshot.problem_id
    WHERE link.contest_id=? AND link.problem_id=? LIMIT 1`, [contestId, problemId]);
  if (!snapshots.length) throw aiError('AI_PROBLEM_SNAPSHOT_MISSING', '比赛题目的快照不可用。', 409);
  const content = json(snapshots[0].content_json, {});
  return {
    id: Number(snapshots[0].problem_id), title: String(content.title || snapshots[0].title || ''), type: String(content.type || snapshots[0].type || 'traditional'),
    judge_snapshot_hash: String(snapshots[0].content_hash || ''), judge_testdata_hash: snapshots[0].testdata_hash || null,
    judge_testdata_path: snapshots[0].testdata_path || null,
    description: String(content.description || ''), input_format: String(content.input_format || ''),
    output_format: String(content.output_format || ''), example: String(content.example || ''), limit_and_hint: String(content.limit_and_hint || ''),
    time_limit: Number(content.time_limit || 1000), memory_limit: Number(content.memory_limit || 256),
    file_io: !!content.file_io, file_io_input_name: content.file_io_input_name || null,
    file_io_output_name: content.file_io_output_name || null,
    python_time_limit_multiplier: Number(content.python_time_limit_multiplier || 2),
    vjudge_config: content.vjudge_config || null
  };
}

async function availableLanguages(problem) {
  const languages = problem.getVJudgeLanguages ? problem.getVJudgeLanguages() : null;
  const configured = languages || syzoj.config.enabled_languages || [];
  return Array.isArray(configured) ? configured : Object.keys(configured);
}

function languageCatalog() {
  const configured = syzoj.config.enabled_languages || [];
  const ids = Array.isArray(configured) ? configured : Object.keys(configured);
  return ids.map(id => {
    const definition = syzoj.languages && syzoj.languages[id];
    return { id: String(id), name: definition && definition.show ? String(definition.show) : String(id) };
  });
}

async function contestStatus(contest) {
  const row = await TypeORM.getConnection().query('SELECT * FROM contest_v2_state WHERE contest_id=? LIMIT 1', [contest.id]);
  return syzoj.utils.contestV2 && syzoj.utils.contestV2.status
    ? syzoj.utils.contestV2.status(contest, row[0] || null)
    : (now() < Number(contest.start_time) ? 'scheduled' : now() >= Number(contest.end_time) ? 'ended' : 'running');
}

async function ensureContestProblemSnapshots(contest, actor = null, req = null) {
  const problemIds = await contestProblemIds(contest);
  if (!problemIds.length) throw aiError('CONTEST_PROBLEMS_REQUIRED', '比赛没有题目。', 409);
  const contestV2 = syzoj.utils.contestV2;
  if (!contestV2 || typeof contestV2.snapshotProblems !== 'function') {
    throw aiError('AI_SNAPSHOT_SERVICE_UNAVAILABLE', '比赛题目快照服务不可用。', 503);
  }
  await contestV2.snapshotProblems(contest, actor, req, { refresh: false });
  const rows = await TypeORM.getConnection().query(`SELECT link.problem_id
    FROM contest_v2_problem_snapshot link
    INNER JOIN problem_v2_snapshot snapshot ON snapshot.id=link.problem_snapshot_id AND snapshot.problem_id=link.problem_id
    WHERE link.contest_id=? AND link.problem_id IN (?)`, [contest.id, problemIds]);
  const available = new Set(rows.map(row => Number(row.problem_id)));
  const missing = problemIds.filter(problemId => !available.has(Number(problemId)));
  if (missing.length) throw aiError('AI_PROBLEM_SNAPSHOT_MISSING', `比赛题目快照不完整：${missing.join(', ')}。`, 409);
  return problemIds;
}

async function registerAgent(contestId, userId) {
  return contestMutation.registerUser(contestId, userId, { managed: true });
}

async function createRuns(contestId, providers, options = {}) {
  await ensureAgentAccounts();
  const contest = await Contest.findById(Number(contestId));
  if (!contest) throw aiError('CONTEST_NOT_FOUND', '比赛不存在。', 404);
  await ensureContestProblemSnapshots(contest, options.actor || null, options.req || null);
  const requested = Array.isArray(providers) && providers.length ? providers : ['deepseek', 'gpt'];
  const agents = await TypeORM.getConnection().query('SELECT id,user_id,provider,enabled FROM ai_agent_account WHERE provider IN (?)', [requested.map(item => String(item).toLowerCase())]);
  if (!agents.length) throw aiError('AI_AGENT_NOT_FOUND', '没有找到可用的 AI 账户。', 404);
  const maxAttempts = Math.min(MAX_ATTEMPTS, Math.max(1, Number(options.max_attempts || MAX_ATTEMPTS)));
  const runs = [];
  for (const agent of agents) {
    if (!agent.enabled) continue;
    await registerAgent(contest.id, agent.user_id);
    const runId = id();
    await TypeORM.getConnection().query(`INSERT INTO ai_contest_run (id,contest_id,agent_id,user_id,state,current_attempt,max_attempts,total_tokens,last_error,started_at,updated_at,finished_at,created_at)
      VALUES (?,?,?,?,'queued',0,?,0,NULL,NULL,?,NULL,?) ON DUPLICATE KEY UPDATE id=ai_contest_run.id`, [runId, contest.id, agent.id, agent.user_id, maxAttempts, now(), now()]);
    const current = await TypeORM.getConnection().query('SELECT id,state FROM ai_contest_run WHERE contest_id=? AND agent_id=? LIMIT 1', [contest.id, agent.id]);
    if (['failed', 'stopped', 'cancelled'].includes(String(current[0].state))) {
      await updateRun(current[0].id, { state: 'queued', current_problem_id: null, current_attempt: 0, max_attempts: maxAttempts, last_error: null, finished_at: null });
      current[0].state = 'queued';
    }
    runs.push({ id: current[0].id, contest_id: contest.id, agent_id: Number(agent.id), user_id: Number(agent.user_id), state: current[0].state });
  }
  for (const run of runs) setImmediate(() => runLoop(run.id));
  return runs;
}

async function loadRun(runId) {
  const rows = await TypeORM.getConnection().query(`SELECT run.*,agent.provider,agent.model,agent.api_key_env,agent.enabled,user.username
    FROM ai_contest_run run INNER JOIN ai_agent_account agent ON agent.id=run.agent_id INNER JOIN user ON user.id=run.user_id WHERE run.id=? LIMIT 1`, [runId]);
  return rows[0] || null;
}

async function updateRun(runId, patch) {
  const fields = Object.keys(patch); if (!fields.length) return;
  const values = fields.map(field => patch[field]);
  await TypeORM.getConnection().query(`UPDATE ai_contest_run SET ${fields.map(field => `${field}=?`).join(',')},updated_at=? WHERE id=?`, [...values, now(), runId]);
}

async function ensureRunActive(runId) {
  const current = await loadRun(runId);
  if (!current || TERMINAL_RUN_STATES.has(String(current.state))) throw aiError('AI_RUN_TERMINATED', 'AI 参赛运行已结束。', 409);
  return current;
}

async function submitAgentCode(run, problem, language, source) {
  const sourceText = String(source || '');
  if (!sourceText.trim()) throw aiError('AI_SOURCE_INVALID', 'AI 返回的代码为空。', 422);
  if (Buffer.byteLength(sourceText) > Number(syzoj.config.limit.submit_code || 512 * 1024)) throw aiError('AI_SOURCE_TOO_LARGE', 'AI 返回的代码超过提交限制。', 413);
  const validLanguages = await availableLanguages(problem);
  if (!validLanguages.includes(language)) throw aiError('AI_LANGUAGE_INVALID', 'AI 返回的语言不是该题目允许的语言。', 422);
  const connection = TypeORM.getConnection();
  const snapshot = await connection.query('SELECT problem_snapshot_id FROM contest_v2_problem_snapshot WHERE contest_id=? AND problem_id=? LIMIT 1', [run.contest_id, problem.id]);
  if (!snapshot.length) throw aiError('AI_PROBLEM_SNAPSHOT_MISSING', '比赛题目的快照不可用。', 409);
  const snapshotId = String(snapshot[0].problem_snapshot_id || '');
  const sourceVisibility = 'private';
  const storedJudge = await connection.transaction(async manager => {
    const judge = await submissionStorage.insertSubmission(manager, {
      submit_time: now(), status: 'Unknown', task_id: require('randomstring').generate(10), code: sourceText,
      code_length: Buffer.byteLength(sourceText), language, user_id: run.user_id, problem_id: problem.id,
      is_public: 0, type: 1, type_info: run.contest_id, pending: false
    });
    const codeVersion = await submissionDomain.createCodeVersion(manager, { submissionId: judge.id, userId: run.user_id, language, source: sourceText, sourceVisibility });
    await submissionDomain.createProjection(manager, { submissionId: judge.id, problemId: problem.id, snapshotId, userId: run.user_id, contestId: run.contest_id, language, codeVersionId: codeVersion.id, sourceVisibility, actorId: run.user_id });
    return judge;
  });
  const judge = JudgeState.create(storedJudge);
  const immutable = Object.assign({}, problem, { judge_snapshot_id: snapshotId });
  await judge.updateRelatedInfo(true);
  await Judger.judge(judge, immutable, 3, { snapshotId });
  judge.pending = true;
  judge.status = 'Waiting';
  await judge.save();
  await connection.transaction(manager => submissionDomain.transitionProjection(manager, {
    submissionId: judge.id,
    status: 'queued',
    operation: 'queue',
    actorId: run.user_id,
    eventType: 'submission.queued',
    patch: { dispatch_attempts: 1, dispatch_enabled: false, last_error: null, next_retry_at: null }
  }));
  return Number(judge.id);
}

async function waitForJudge(submissionId, timeoutMs = 30 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await TypeORM.getConnection().query('SELECT id,status,pending,score,total_time,max_memory,result,compilation FROM judge_state WHERE id=? LIMIT 1', [submissionId]);
    if (rows.length && !Number(rows[0].pending) && !['Unknown', 'Waiting'].includes(String(rows[0].status))) return rows[0];
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw aiError('AI_JUDGE_TIMEOUT', '等待评测结果超时。', 504);
}

function verdict(judge) { return String(judge && judge.status || 'Unknown'); }
function resultForModel(judge) {
  return { verdict: verdict(judge), score: judge && judge.score == null ? null : Number(judge.score), time_ms: judge && judge.total_time == null ? null : Number(judge.total_time), memory_kb: judge && judge.max_memory == null ? null : Number(judge.max_memory), compilation: String(judge && judge.compilation || '').slice(0, 8000) };
}

function publicProblem(problem) {
  return {
    id: Number(problem.id), title: problem.title, type: problem.type,
    description: problem.description, input_format: problem.input_format,
    output_format: problem.output_format, example: problem.example,
    limit_and_hint: problem.limit_and_hint
  };
}

function contestWindowOpen(contest) {
  const current = now();
  return current >= Number(contest.start_time) && current < Number(contest.end_time);
}

function solutionRequestOptions(run) {
  if (String(run && run.provider) === 'deepseek') {
    return { maxTokens: 65536, thinking: true, reasoningEffort: 'high', timeoutMs: DEEPSEEK_REASONING_TIMEOUT_MS };
  }
  return { maxTokens: 12000 };
}

async function modelPlan(run, problems, previous, allAttempts = previous) {
  const selection = await modelComplete(run, [
    { role: 'system', content: '你是参赛选手。选择下一道题和编程语言。严格只返回 JSON，不要 Markdown。JSON 示例：{"problem_id":911110,"language":"cpp17"}' },
    { role: 'user', content: JSON.stringify({ task: '参加公平的编程比赛。只能使用题面和公开样例，不得猜测或请求隐藏测试数据、标准答案、题解或其他选手代码。请选择一道尚未解决的题目。', problems: problems.map(publicProblem), available_languages: languageCatalog(), previous, output: { problem_id: 'number', language: 'language id from available_languages' } }) }
  ], { maxTokens: 512, thinking: false });
  const problemId = Number(selection.value && selection.value.problem_id);
  const problem = problems.find(item => Number(item.id) === problemId);
  if (!problem) throw aiError('AI_PLAN_INVALID', 'AI 选择了不属于本场比赛或已解决的题目。', 422);
  const language = String(selection.value && selection.value.language || '');
  const attemptNo = allAttempts.filter(item => Number(item.problem_id) === problemId).length + 1;
  await updateRun(run.id, { state: 'solving', current_problem_id: problemId, current_attempt: attemptNo });
  const solution = await modelTextComplete(run, [
    { role: 'system', content: '你是编程比赛选手。只返回完整源代码纯文本，不要 JSON、Markdown 代码块、解释或额外文字。' },
    { role: 'user', content: JSON.stringify({ task: '解答这道题并返回可直接提交的完整源代码。不得请求或使用隐藏测试数据、标准答案、题解或其他选手代码。', problem: publicProblem(problem), available_languages: languageCatalog(), language }) }
  ], solutionRequestOptions(run));
  return {
    value: { problem_id: problemId, language, source: normalizeSourceText(solution.value) },
    usage: mergeUsage(selection.usage, solution.usage)
  };
}

async function modelRepair(run, problem, language, source, judge) {
  const response = await modelTextComplete(run, [
    { role: 'system', content: '你是编程比赛选手。根据公开评测结果修复代码。只返回完整源代码纯文本，不要 JSON、Markdown 代码块、解释或额外文字。不要请求隐藏数据。' },
    { role: 'user', content: JSON.stringify({ task: '修复这次提交，返回使用同一语言的完整可提交代码。', problem: publicProblem(problem), available_languages: languageCatalog(), language, source, judge: resultForModel(judge) }) }
  ], solutionRequestOptions(run));
  return { ...response, value: { language, source: normalizeSourceText(response.value) } };
}

function mergeUsage(...items) {
  return items.reduce((total, usage) => ({
    prompt_tokens: total.prompt_tokens + Number(usage && usage.prompt_tokens || 0),
    completion_tokens: total.completion_tokens + Number(usage && usage.completion_tokens || 0),
    total_tokens: total.total_tokens + Number(usage && usage.total_tokens || 0)
  }), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
}

function normalizeSourceText(value) {
  const source = String(value || '').trim();
  const fenced = source.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/);
  return String(fenced ? fenced[1] : source).trim();
}

async function modelRequest(run, messages, options, method, retryInstruction) {
  let lastError;
  for (let attempt = 1; attempt <= MODEL_RETRIES; attempt++) {
    try {
      await ensureRunActive(run.id);
      const retryHint = attempt === 1 ? [] : [{ role: 'system', content: retryInstruction }];
      const response = await aiProviders[method](run.provider, messages.concat(retryHint), options);
      await ensureRunActive(run.id);
      await updateRun(run.id, { last_error: null }).catch(() => {});
      return response;
    } catch (error) {
      lastError = error;
      await ensureRunActive(run.id);
      if (!retryableModelError(error) || attempt === MODEL_RETRIES) throw error;
      const delay = error.code === 'AI_RATE_LIMITED' ? 15000 * attempt : 2000 * attempt;
      const reason = String(error.message || error).replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted]').slice(0, 300);
      await updateRun(run.id, { last_error: `模型请求失败（第 ${attempt}/${MODEL_RETRIES} 次）：${reason}；${Math.ceil(delay / 1000)} 秒后重试。` }).catch(() => {});
      await sleep(delay);
    }
  }
  throw lastError;
}

function modelComplete(run, messages, options) {
  return modelRequest(run, messages, options, 'completeJson', '上一次响应不可用。请重新生成，必须返回可解析的单个 JSON 对象，不要输出 Markdown、解释或额外文字。');
}

function modelTextComplete(run, messages, options) {
  return modelRequest(run, messages, options, 'completeText', '上一次响应不可用。请重新生成，只返回完整源代码纯文本，不要输出 JSON、Markdown、解释或额外文字。');
}

async function recoverInterruptedProviderRuns() {
  await TypeORM.getConnection().query(`UPDATE ai_contest_run run
    INNER JOIN contest ON contest.id=run.contest_id
    SET run.state='queued',run.last_error='模型请求中断，已自动恢复。',run.updated_at=UNIX_TIMESTAMP()
    WHERE run.state='failed' AND contest.end_time>UNIX_TIMESTAMP()
      AND (run.last_error LIKE 'AI provider request timed out.%'
        OR run.last_error LIKE 'AI response did not contain valid JSON.%'
        OR run.last_error LIKE 'AI provider returned empty content.%'
        OR run.last_error LIKE 'AI provider response was truncated.%'
        OR run.last_error LIKE 'AI provider returned HTTP%')`);
}

async function recoverMissingSnapshotRuns() {
  const rows = await TypeORM.getConnection().query(`SELECT DISTINCT run.contest_id
    FROM ai_contest_run run INNER JOIN contest ON contest.id=run.contest_id
    WHERE run.state='failed' AND run.last_error='比赛题目的快照不可用。' AND contest.end_time>UNIX_TIMESTAMP()`);
  for (const row of rows) {
    const contest = await Contest.findById(Number(row.contest_id));
    if (!contest) continue;
    try {
      await ensureContestProblemSnapshots(contest);
      await TypeORM.getConnection().query(`UPDATE ai_contest_run SET state='queued',current_problem_id=NULL,current_attempt=0,last_error=NULL,finished_at=NULL,updated_at=UNIX_TIMESTAMP()
        WHERE contest_id=? AND state='failed' AND last_error='比赛题目的快照不可用。'`, [contest.id]);
    } catch (error) {
      syzoj.log(`[ai-contest] contest ${contest.id} snapshot recovery failed: ${error.message || error}`);
    }
  }
}

async function runLoop(runId) {
  if (activeRuns.has(runId)) return;
  activeRuns.add(runId);
  try {
    while (true) {
      const run = await loadRun(runId);
      if (!run || !RUN_STATES.has(run.state) || TERMINAL_RUN_STATES.has(String(run.state))) return;
      const contest = await Contest.findById(Number(run.contest_id));
      if (!contest) { await updateRun(runId, { state: 'failed', last_error: '比赛不存在。', finished_at: now() }); return; }
      if (now() < Number(contest.start_time)) {
        await updateRun(runId, { state: 'queued' });
        await new Promise(resolve => setTimeout(resolve, Math.min(30000, Math.max(1000, Number(contest.start_time) * 1000 - Date.now()))));
        continue;
      }
      if (now() >= Number(contest.end_time)) { await updateRun(runId, { state: 'stopped', last_error: '比赛已结束。', finished_at: now() }); return; }
      if (!run.started_at) await updateRun(runId, { started_at: now() });
      const problemIds = await contestProblemIds(contest);
      const attempts = await TypeORM.getConnection().query('SELECT problem_id,attempt_no,verdict FROM ai_contest_attempt WHERE run_id=? ORDER BY id ASC', [runId]);
      if (run.state === 'waiting_result') {
        const pending = await TypeORM.getConnection().query('SELECT * FROM ai_contest_attempt WHERE run_id=? AND state=? AND submission_id IS NOT NULL ORDER BY id DESC LIMIT 1', [runId, 'waiting_result']);
        if (pending.length) {
          const judge = await waitForJudge(Number(pending[0].submission_id));
          const finalVerdict = verdict(judge);
          await TypeORM.getConnection().query('UPDATE ai_contest_attempt SET verdict=?,judge_status=?,state=?,model_response=?,completed_at=? WHERE id=?', [finalVerdict === 'Accepted' ? 'Accepted' : finalVerdict, finalVerdict, 'completed', JSON.stringify(resultForModel(judge)), now(), pending[0].id]);
          if (finalVerdict !== 'Accepted') {
            await ensureRunActive(runId);
            if (!contestWindowOpen(contest)) { await updateRun(runId, { state: 'stopped', last_error: '比赛已结束。', finished_at: now() }); return; }
            const problem = await problemForPrompt(contest.id, Number(pending[0].problem_id));
            const nextAttempt = Number(pending[0].attempt_no) + 1;
            if (nextAttempt > Number(run.max_attempts || MAX_ATTEMPTS)) { await updateRun(runId, { state: 'planning' }); continue; }
            await updateRun(runId, { state: 'repairing', current_problem_id: Number(pending[0].problem_id), current_attempt: Number(pending[0].attempt_no) + 1 });
            const repair = await modelRepair(run, problem, String(pending[0].language || ''), String(pending[0].source || ''), judge);
            if (!contestWindowOpen(contest)) { await updateRun(runId, { state: 'stopped', last_error: '比赛已结束。', finished_at: now() }); return; }
            let language = String(repair.value && repair.value.language || pending[0].language || '');
            let source = String(repair.value && repair.value.source || '');
            const nextPlan = { value: { problem_id: Number(pending[0].problem_id), language, source }, usage: repair.usage };
            const refreshed = await ensureRunActive(runId);
            const attemptResult = await submitAgentCode(refreshed, problem, language, source);
            await TypeORM.getConnection().query(`INSERT INTO ai_contest_attempt (run_id,problem_id,attempt_no,submission_id,language,source,verdict,judge_status,state,model_response,tokens,created_at)
              VALUES (?,?,?,?,?,?,'Pending','Waiting','waiting_result',?,?,?)`, [runId, problem.id, nextAttempt, attemptResult, language, source, JSON.stringify(nextPlan.value), Number(repair.usage && repair.usage.total_tokens || 0), now()]);
            await updateRun(runId, { state: 'waiting_result', current_attempt: nextAttempt, total_tokens: Number(run.total_tokens || 0) + Number(repair.usage && repair.usage.total_tokens || 0) });
            continue;
          }
          continue;
        }
      }
      const solved = new Set(attempts.filter(item => item.verdict === 'Accepted').map(item => Number(item.problem_id)));
      if (solved.size >= problemIds.length) { await updateRun(runId, { state: 'completed', finished_at: now(), current_problem_id: null }); return; }
      const maxAttempts = Number(run.max_attempts || MAX_ATTEMPTS);
      const exhausted = new Set(problemIds.filter(problemId => !solved.has(problemId) && attempts.filter(item => Number(item.problem_id) === Number(problemId)).length >= maxAttempts));
      const availableProblemIds = problemIds.filter(problemId => !solved.has(problemId) && !exhausted.has(problemId));
      if (!availableProblemIds.length) { await updateRun(runId, { state: 'stopped', last_error: '未解决题目已达到最大尝试次数。', finished_at: now() }); return; }
      const problemPayload = await Promise.all(availableProblemIds.map(problemId => problemForPrompt(contest.id, problemId)));
      await updateRun(runId, { state: 'planning' });
      let plan = await modelPlan(run, problemPayload, attempts.slice(-10).map(item => ({ problem_id: Number(item.problem_id), attempt_no: Number(item.attempt_no), verdict: item.verdict })), attempts);
      await ensureRunActive(runId);
      let problemId = Number(plan.value && plan.value.problem_id);
      if (!availableProblemIds.includes(problemId)) throw aiError('AI_PLAN_INVALID', 'AI 选择了不属于本场比赛或已解决或已耗尽尝试次数的题目。', 422);
      let problem = problemPayload.find(item => item.id === problemId);
      let language = String(plan.value && plan.value.language || '');
      let source = String(plan.value && plan.value.source || '');
      let attemptNo = Number(attempts.filter(item => Number(item.problem_id) === problemId).length) + 1;
      while (attemptNo <= Number(run.max_attempts || MAX_ATTEMPTS)) {
        await ensureRunActive(runId);
        if (!contestWindowOpen(contest)) { await updateRun(runId, { state: 'stopped', last_error: '比赛已结束。', finished_at: now() }); return; }
        await updateRun(runId, { state: 'submitting', current_problem_id: problemId, current_attempt: attemptNo, total_tokens: Number(run.total_tokens || 0) + Number(plan.usage && plan.usage.total_tokens || 0) });
        const inserted = await TypeORM.getConnection().query(`INSERT INTO ai_contest_attempt (run_id,problem_id,attempt_no,submission_id,language,source,verdict,judge_status,state,model_response,tokens,created_at)
          VALUES (?,?,?,?,?,?,'Pending','Waiting','submitting',?,?,?)`, [runId, problemId, attemptNo, null, language, source, JSON.stringify(plan.value || {}), Number(plan.usage && plan.usage.total_tokens || 0), now()]);
        const attemptId = Number(inserted.insertId);
        const submissionId = await submitAgentCode(run, problem, language, source);
        await TypeORM.getConnection().query('UPDATE ai_contest_attempt SET submission_id=?,state=?,created_at=? WHERE id=?', [submissionId, 'waiting_result', now(), attemptId]);
        await updateRun(runId, { state: 'waiting_result' });
        const judge = await waitForJudge(submissionId);
        const finalVerdict = verdict(judge);
        await TypeORM.getConnection().query('UPDATE ai_contest_attempt SET verdict=?,judge_status=?,state=?,model_response=?,completed_at=? WHERE id=?', [finalVerdict === 'Accepted' ? 'Accepted' : finalVerdict, finalVerdict, 'completed', JSON.stringify(resultForModel(judge)), now(), attemptId]);
        if (finalVerdict === 'Accepted') break;
        attemptNo++;
        if (attemptNo > Number(run.max_attempts || MAX_ATTEMPTS)) break;
        await ensureRunActive(runId);
        await updateRun(runId, { state: 'repairing', current_attempt: attemptNo });
        plan = await modelRepair(run, problem, language, source, judge);
        if (!contestWindowOpen(contest)) { await updateRun(runId, { state: 'stopped', last_error: '比赛已结束。', finished_at: now() }); return; }
        language = String(plan.value && plan.value.language || language);
        source = String(plan.value && plan.value.source || '');
      }
    }
  } catch (error) {
    const message = String(error.message || error).replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted]').slice(0, 1000);
    const currentRun = await loadRun(runId).catch(() => null);
    if (!currentRun || TERMINAL_RUN_STATES.has(String(currentRun.state)) || (error && error.code === 'AI_RUN_TERMINATED')) return;
    const activeContest = await Contest.findById(Number(currentRun.contest_id)).catch(() => null);
    if (retryableModelError(error) && activeContest && now() < Number(activeContest.end_time)) {
      await updateRun(runId, { state: 'queued', last_error: `${message} 将在稍后自动恢复。`, finished_at: null }).catch(() => {});
      setTimeout(() => runLoop(runId), error.code === 'AI_RATE_LIMITED' ? 30000 : 5000).unref();
    } else if (error && error.code === 'AI_JUDGE_TIMEOUT' && activeContest && now() < Number(activeContest.end_time)) {
      await updateRun(runId, { state: 'waiting_result', last_error: `${message} 将继续等待评测。`, finished_at: null }).catch(() => {});
      setTimeout(() => runLoop(runId), 5000).unref();
    } else {
      await updateRun(runId, { state: 'failed', last_error: message, finished_at: now() }).catch(() => {});
      syzoj.log(`[ai-contest] run ${runId} failed: ${message}`);
    }
  } finally {
    activeRuns.delete(runId);
  }
}

async function resumeRuns() {
  await ensureAgentAccounts();
  await recoverMissingSnapshotRuns();
  await recoverInterruptedProviderRuns();
  const rows = await TypeORM.getConnection().query("SELECT id FROM ai_contest_run WHERE state IN ('queued','planning','solving','submitting','waiting_result','repairing') ORDER BY created_at ASC LIMIT 20");
  rows.forEach(row => setImmediate(() => runLoop(row.id)));
}

async function getRuns(contestId) {
  await ensureAgentAccounts();
  const rows = await TypeORM.getConnection().query(`SELECT run.id,run.contest_id,run.user_id,run.agent_id,run.state,run.current_problem_id,run.current_attempt,run.max_attempts,run.total_tokens,run.last_error,run.started_at,run.updated_at,run.finished_at,user.username,agent.provider,agent.model
    FROM ai_contest_run run INNER JOIN user ON user.id=run.user_id INNER JOIN ai_agent_account agent ON agent.id=run.agent_id WHERE run.contest_id=? ORDER BY run.created_at ASC`, [contestId]);
  return rows.map(normalizeRun);
}

function normalizeRun(row) {
  return {
    ...row,
    id: String(row.id),
    contest_id: Number(row.contest_id),
    user_id: Number(row.user_id),
    agent_id: Number(row.agent_id),
    current_problem_id: row.current_problem_id == null ? null : Number(row.current_problem_id),
    current_attempt: Number(row.current_attempt),
    max_attempts: Number(row.max_attempts),
    total_tokens: Number(row.total_tokens),
    started_at: row.started_at == null ? null : Number(row.started_at),
    updated_at: row.updated_at == null ? null : Number(row.updated_at),
    finished_at: row.finished_at == null ? null : Number(row.finished_at),
    created_at: row.created_at == null ? null : Number(row.created_at),
    state: String(row.state)
  };
}

async function getRunHistory(limit = 200) {
  await ensureAgentAccounts();
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 200));
  const rows = await TypeORM.getConnection().query(`SELECT run.id,run.contest_id,run.user_id,run.agent_id,run.state,run.current_problem_id,run.current_attempt,run.max_attempts,run.total_tokens,run.last_error,run.started_at,run.updated_at,run.finished_at,run.created_at,
      user.username,agent.provider,agent.model,contest.title AS contest_title
    FROM ai_contest_run run
    LEFT JOIN user ON user.id=run.user_id
    LEFT JOIN ai_agent_account agent ON agent.id=run.agent_id
    LEFT JOIN contest ON contest.id=run.contest_id
    ORDER BY run.created_at DESC LIMIT ?`, [safeLimit]);
  return rows.map(normalizeRun);
}

async function cancelRun(runId, contestId = null) {
  await ensureSchema();
  const current = await loadRun(runId);
  if (!current) throw aiError('AI_RUN_NOT_FOUND', 'AI 参赛运行不存在。', 404);
  if (contestId != null && Number(current.contest_id) !== Number(contestId)) throw aiError('AI_RUN_NOT_FOUND', 'AI 参赛运行不存在。', 404);
  if (!TERMINAL_RUN_STATES.has(String(current.state))) {
    await updateRun(runId, { state: 'cancelled', finished_at: now(), last_error: '管理员取消 AI 参赛。' });
  }
  return loadRun(runId);
}

module.exports = { MAX_ATTEMPTS, cancelRun, createRuns, ensureAgentAccounts, ensureContestProblemSnapshots, ensureSchema, getRunHistory, getRuns, listAgents, resumeRuns, runLoop };
syzoj.utils.aiContest = module.exports;
