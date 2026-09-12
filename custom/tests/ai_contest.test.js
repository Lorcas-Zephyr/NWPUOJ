'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('AI integration is limited to DeepSeek and GPT with runtime-only credentials', () => {
  const providers = read('custom/libs/ai-provider-adapters.js');
  const orchestrator = read('custom/libs/ai-contest-orchestrator.js');
  const moduleSource = read('custom/modules/_ai_contest.js');
  const compose = read('docker-compose.yml');
  const envExample = read('env-ai.example');

  assert.match(providers, /deepseek-v4-pro/);
  assert.match(providers, /gpt-5\.6-sol/);
  assert.match(providers, /SYZOJ_AI_DEEPSEEK_API_KEY/);
  assert.match(providers, /SYZOJ_AI_GPT_API_KEY/);
  assert.doesNotMatch(providers, /(?:claude|opus|kimi|glm|qwen)/i);
  assert.match(orchestrator, /username = config\.name/);
  assert.match(providers, /name: 'DeepSeek'/);
  assert.match(providers, /name: 'GPT'/);
  assert.match(orchestrator, /waitForJudge/);
  assert.match(orchestrator, /modelRepair/);
  assert.match(orchestrator, /function publicProblem/);
  assert.match(orchestrator, /function languageCatalog/);
  assert.match(orchestrator, /const MODEL_RETRIES = 3/);
  assert.match(orchestrator, /const TERMINAL_RUN_STATES = new Set/);
  assert.match(orchestrator, /function retryableModelError/);
  assert.match(orchestrator, /function modelTextComplete/);
  assert.match(orchestrator, /source: normalizeSourceText\(solution\.value\)/);
  assert.match(orchestrator, /maxTokens: 512, thinking: false/);
  assert.match(orchestrator, /state: 'solving', current_problem_id: problemId/);
  assert.match(orchestrator, /return \{ maxTokens: 12000 \}/);
  assert.match(orchestrator, /DEEPSEEK_REASONING_TIMEOUT_MS = 10 \* 60 \* 1000/);
  assert.match(orchestrator, /maxTokens: 65536, thinking: true, reasoningEffort: 'high', timeoutMs: DEEPSEEK_REASONING_TIMEOUT_MS/);
  assert.match(providers, /type: options\.thinking \? 'enabled' : 'disabled'/);
  assert.match(providers, /provider === 'deepseek' \? 128000 : 16000/);
  assert.match(providers, /requestBody\.reasoning_effort/);
  assert.match(orchestrator, /const reason = String\(error\.message \|\| error\)/);
  assert.match(orchestrator, /'planning','solving','submitting'/);
  assert.match(providers, /async function completeText/);
  assert.match(providers, /AI_RESPONSE_TRUNCATED/);
  assert.match(providers, /AI_RESPONSE_EMPTY/);
  assert.match(providers, /finishReason === 'length'/);
  assert.match(orchestrator, /AI_RUN_TERMINATED/);
  assert.match(orchestrator, /recoverInterruptedProviderRuns/);
  assert.match(orchestrator, /async function ensureContestProblemSnapshots/);
  assert.match(orchestrator, /async function recoverMissingSnapshotRuns/);
  assert.match(orchestrator, /await recoverMissingSnapshotRuns\(\)/);
  assert.match(orchestrator, /INNER JOIN problem_v2_snapshot snapshot/);
  assert.match(orchestrator, /\['failed', 'stopped', 'cancelled'\]\.includes/);
  assert.match(orchestrator, /state: 'queued', current_problem_id: null, current_attempt: 0/);
  assert.match(orchestrator, /available_languages: languageCatalog\(\)/);
  assert.doesNotMatch(orchestrator, /problems: problems, previous/);
  assert.doesNotMatch(orchestrator, /result: String\(judge && judge\.result/);
  assert.match(orchestrator, /MAX_ATTEMPTS = 20/);
  assert.match(moduleSource, /只有全站管理员可以管理 AI 参赛/);
  assert.match(moduleSource, /cancelRun\(req\.params\.runId, contest\.id\)/);
  assert.match(moduleSource, /actor: res\.locals\.user, req/);
  assert.match(compose, /env-ai/);
  assert.doesNotMatch(envExample, /sk-[A-Za-z0-9]/);
});

test('AI route and leaderboard expose the restricted AI account workflow', () => {
  const orchestrator = read('custom/libs/ai-contest-orchestrator.js');
  const moduleSource = read('custom/modules/_ai_contest.js');
  const ranklist = read('custom/views/contest_ranklist.ejs');
  const header = read('custom/views/admin_header.ejs');
  const view = read('custom/views/admin_ai.ejs');

  for (const route of [
    "app.get('/api/v2/admin/ai/agents'",
    "app.get('/api/v2/admin/ai/runs'",
    "app.get('/api/v2/contests/:id/ai-runs'",
    "app.post('/api/v2/contests/:id/ai-runs'",
    "app.post('/api/v2/contests/:id/ai-runs/:runId/cancel'"
  ]) assert.match(moduleSource, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(ranklist, /\['ai', 'AI账户'\]/);
  assert.match(header, /ai: \['AI参赛'/);
  assert.match(view, /启动 AI 参赛/);
  assert.match(view, /再次启动后从已有进度继续/);
  assert.match(view, /max_attempts/);
  assert.match(view, /保留最近 200 条记录/);
  assert.match(view, /\/api\/v2\/admin\/ai\/runs/);
  assert.match(view, /比赛已删除/);
  assert.match(orchestrator, /async function getRunHistory/);
  assert.match(orchestrator, /LEFT JOIN contest ON contest\.id=run\.contest_id/);
  assert.match(orchestrator, /getRunHistory/);
});
