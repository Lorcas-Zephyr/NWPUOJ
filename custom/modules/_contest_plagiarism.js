'use strict';

const TypeORM = require('typeorm');
const fs = require('fs-extra');
const path = require('path');
const engine = require('../libs/contest-plagiarism');
const Contest = syzoj.model('contest');
const db = () => TypeORM.getConnection();
const api = () => syzoj.utils.apiV2;
// Deliberately outside uploads/static: every report and source read is authorized.
const ROOT = '/app/private-plagiarism';
let schemaPromise, working = false;
const webReportBuilds = new Map();
const now = () => Math.floor(Date.now() / 1000);
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const error = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
function positiveId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw error(422, 'VALIDATION_FAILED', '编号无效。');
  return id;
}
function ensureSchema() {
  if (!schemaPromise) schemaPromise = db().query(`CREATE TABLE IF NOT EXISTS contest_plagiarism_job (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    contest_id INT NOT NULL,
    requested_by INT NULL,
    request_token VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    state VARCHAR(24) NOT NULL,
    active_contest_id INT NULL,
    created_at INT NOT NULL,
    started_at INT NULL,
    finished_at INT NULL,
    snapshot_json MEDIUMTEXT NOT NULL,
    summary_json MEDIUMTEXT NOT NULL,
    UNIQUE KEY uq_plagiarism_request (contest_id,request_token),
    UNIQUE KEY uq_plagiarism_active (active_contest_id),
    KEY idx_plagiarism_history (contest_id,id),
    KEY idx_plagiarism_queue (state,id),
    CONSTRAINT fk_plagiarism_contest FOREIGN KEY (contest_id) REFERENCES contest(id) ON DELETE CASCADE,
    CONSTRAINT fk_plagiarism_actor FOREIGN KEY (requested_by) REFERENCES user(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).catch(e => { schemaPromise = null; throw e; });
  return schemaPromise;
}
async function access(req, res) {
  const contest = await Contest.findById(positiveId(req.params.id));
  if (!contest) throw error(404, 'CONTEST_NOT_FOUND', '无此比赛。');
  if (!res.locals.user || !await contest.isSupervisior(res.locals.user)) throw error(res.locals.user ? 403 : 401,
    res.locals.user ? 'CAPABILITY_REQUIRED' : 'AUTHENTICATION_REQUIRED', '仅本场比赛管理员和全站管理员可以查重和查看代码报告。');
  res.set('Cache-Control', 'private, no-store');
  await ensureSchema();
  return contest;
}
function resource(row) {
  return { id: Number(row.id), state: row.state, created_at: row.created_at, started_at: row.started_at,
    finished_at: row.finished_at, summary: parse(row.summary_json), snapshot: parse(row.snapshot_json) };
}
async function getJob(req, res) {
  const contest = await access(req, res);
  const rows = await db().query('SELECT * FROM contest_plagiarism_job WHERE contest_id=? AND id=?', [contest.id, positiveId(req.params.jobId)]);
  if (!rows.length) throw error(404, 'JOB_NOT_FOUND', '查重任务不存在。');
  return rows[0];
}
function jobDirectory(job) { return path.join(ROOT, String(positiveId(job.contest_id)), String(positiveId(job.id))); }
function handleError(res, e) {
  if (!e.statusCode) syzoj.log(`[contest-plagiarism] ${e.message}`);
  return api().fail(res, e.statusCode || 500, e.code || 'REQUEST_FAILED', e.statusCode ? e.message : '暂时无法处理查重请求，请稍后重试。');
}
async function update(job, state, summary) {
  await db().query('UPDATE contest_plagiarism_job SET state=?,summary_json=?,finished_at=?,active_contest_id=? WHERE id=?',
    [state, JSON.stringify(summary), state === 'running' ? null : now(), state === 'running' ? job.contest_id : null, job.id]);
}

async function processJob(job) {
  const snapshot = parse(job.snapshot_json);
  const root = jobDirectory(job);
  let summary = { engine: engine.ENGINE_VERSION, groups: [], done: 0, group_count: 0, pair_count: 0 };
  try {
    if (!await engine.runtimeAvailable()) throw new Error('JPlag 运行环境未就绪，请联系站长安装。');
    const size = (await db().query(`SELECT COUNT(*) AS count,COALESCE(SUM(OCTET_LENGTH(code)),0) AS bytes
      FROM judge_state WHERE type=1 AND type_info=? AND submit_time>=? AND submit_time<? AND id<=?`,
    [job.contest_id, snapshot.start_time, snapshot.end_time, snapshot.max_submission_id]))[0];
    if (Number(size.count) > 100000 || Number(size.bytes) > 256 * 1024 * 1024) throw new Error('比赛提交超过 100000 次或源代码总量超过 256 MiB，请联系站长分批处理。');
    const rows = await db().query(`SELECT js.id,js.user_id,js.problem_id,js.language,js.code,js.status,js.submit_time,
      u.username,p.type,p.title,v.source_code AS version_source
      FROM judge_state js LEFT JOIN user u ON u.id=js.user_id
      LEFT JOIN problem p ON p.id=js.problem_id
      LEFT JOIN submission_v2_code_version v ON v.submission_id=js.id
      WHERE js.type=1 AND js.type_info=? AND js.submit_time>=? AND js.submit_time<? AND js.id<=?
      ORDER BY js.id LIMIT 100001`, [job.contest_id, snapshot.start_time, snapshot.end_time, snapshot.max_submission_id]);
    if (rows.length > 100000) throw new Error('比赛超过 100000 次提交，请联系站长分批处理。');
    const selection = engine.selectSubmissions(rows, snapshot, syzoj.config.languages);
    summary = { ...summary, ...selection.stats, group_count: selection.groups.length };
    await fs.ensureDir(root, { mode: 0o700 });
    const pairs = [];
    await update(job, 'running', summary);
    for (const group of selection.groups) {
      const directory = path.join(root, group.key);
      const info = { key: group.key, problem_id: group.problem_id, title: group.title,
        language_label: group.language_label, count: group.submissions.length };
      summary.current = `${group.title} · ${group.language_label}`;
      await update(job, 'running', summary);
      try {
        const result = await engine.analyzeGroup(group, directory);
        Object.assign(info, { state: result.state, message: result.message, failed: result.failed, pair_count: result.pairs.length,
          report: result.state !== 'skipped' });
        result.pairs.forEach(pair => pairs.push({ ...pair, group: group.key, problem_id: group.problem_id, title: group.title, language_label: group.language_label }));
      } catch (e) {
        Object.assign(info, { state: 'failed', message: e.message, pair_count: 0, report: false });
        if (e.engineLog) await fs.writeFile(path.join(directory, 'engine.log'), e.engineLog, { mode: 0o600 });
      }
      summary.groups.push(info); summary.done++; summary.pair_count = pairs.length;
      await update(job, 'running', summary);
    }
    pairs.sort((a, b) => b.similarity - a.similarity || a.first_id - b.first_id || a.second_id - b.second_id);
    await fs.writeJson(path.join(root, 'pairs.json'), pairs, { mode: 0o600 });
    delete summary.current;
    const problems = summary.groups.filter(group => ['failed', 'partial'].includes(group.state));
    const completed = summary.groups.filter(group => ['completed', 'partial'].includes(group.state));
    const state = problems.length ? (completed.length ? 'partial' : 'failed') : 'completed';
    summary.message = !summary.selected ? '没有可查重的赛时源代码。' : !completed.length && !problems.length ? '各分组均不足两名选手，没有可比较的代码。' : '';
    await update(job, state, summary);
  } catch (e) {
    summary.message = e.message;
    await update(job, 'failed', summary);
  }
}

async function tick() {
  if (working) return;
  working = true;
  let runner, locked = false;
  try {
    await ensureSchema();
    const pending = await db().query("SELECT id FROM contest_plagiarism_job WHERE state IN ('queued','running') LIMIT 1");
    if (!pending.length) return;
    runner = db().createQueryRunner(); await runner.connect();
    const lock = await runner.query("SELECT GET_LOCK('nwpuoj:plagiarism-worker',0) AS acquired");
    locked = Number(lock[0].acquired) === 1;
    if (!locked) return;
    // Holding the global worker lock means no other live worker owns these rows.
    // Preserve interrupted history; never leave a job running forever on restart.
    const interrupted = await runner.query("SELECT * FROM contest_plagiarism_job WHERE state='running'");
    for (const row of interrupted) await update(row, 'failed', { ...parse(row.summary_json), message: '服务重启或任务中断，已保留历史；请重新查重。' });
    const rows = await runner.query("SELECT * FROM contest_plagiarism_job WHERE state='queued' ORDER BY id LIMIT 1");
    if (!rows.length) return;
    const job = rows[0];
    await runner.query("UPDATE contest_plagiarism_job SET state='running',started_at=? WHERE id=?", [now(), job.id]);
    await processJob(job);
  } catch (e) { syzoj.log(`[contest-plagiarism] worker: ${e.message}`); }
  finally {
    if (runner) {
      if (locked) await runner.query("SELECT RELEASE_LOCK('nwpuoj:plagiarism-worker')").catch(() => {});
      await runner.release().catch(() => {});
    }
    working = false;
  }
}

app.get('/contest/:id/plagiarism', async (req, res) => {
  try {
    const contest = await access(req, res);
    return res.render('contest_plagiarism', { contest, plagiarismReady: await engine.runtimeAvailable(), plagiarismEnded: Number(contest.end_time) <= now() });
  } catch (e) { return res.status(e.statusCode || 500).render('error', { err: e }); }
});

app.get('/api/v2/contests/:id/plagiarism', async (req, res) => {
  try {
    const contest = await access(req, res);
    const before = req.query.before_id ? positiveId(req.query.before_id) : 2147483647;
    const rows = await db().query('SELECT * FROM contest_plagiarism_job WHERE contest_id=? AND id<? ORDER BY id DESC LIMIT 21', [contest.id, before]);
    return api().send(res, { items: rows.slice(0, 20).map(resource), next_before_id: rows.length > 20 ? Number(rows[19].id) : null });
  } catch (e) { return handleError(res, e); }
});

app.post('/api/v2/contests/:id/plagiarism', async (req, res) => {
  try {
    const contest = await access(req, res);
    const token = String((req.body || {}).request_token || '');
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(token)) throw error(422, 'VALIDATION_FAILED', '请求标识无效，请刷新后重试。');
    if (!await engine.runtimeAvailable()) throw error(503, 'DEPENDENCY_UNAVAILABLE', 'JPlag 运行环境未就绪，请联系站长。');
    await api().ensureFoundationSchema();
    const row = await db().transaction(async manager => {
      const contests = await manager.query('SELECT start_time,end_time FROM contest WHERE id=? FOR UPDATE', [contest.id]);
      if (!contests.length) throw error(404, 'CONTEST_NOT_FOUND', '无此比赛。');
      if (Number(contests[0].end_time) > now()) throw error(409, 'CONTEST_NOT_ENDED', '比赛结束后可以一键查重。');
      const previous = await manager.query('SELECT * FROM contest_plagiarism_job WHERE contest_id=? AND (request_token=? OR active_contest_id=?) ORDER BY id DESC LIMIT 1', [contest.id, token, contest.id]);
      if (previous.length) return previous[0];
      const latest = await manager.query('SELECT MAX(id) AS id FROM judge_state WHERE type=1 AND type_info=?', [contest.id]);
      const snapshot = { start_time: Number(contests[0].start_time), end_time: Number(contests[0].end_time), max_submission_id: Number(latest[0].id) || 0,
        selection: 'latest_ac_or_latest_per_problem_language', engine: engine.ENGINE_VERSION, minimum_similarity: engine.MIN_SIMILARITY };
      const summary = { engine: engine.ENGINE_VERSION, groups: [], done: 0, group_count: 0, pair_count: 0 };
      const inserted = await manager.query(`INSERT INTO contest_plagiarism_job
        (contest_id,requested_by,request_token,state,active_contest_id,created_at,snapshot_json,summary_json) VALUES (?,?,?,'queued',?,?,?,?)`,
        [contest.id, res.locals.user.id, token, contest.id, now(), JSON.stringify(snapshot), JSON.stringify(summary)]);
      await syzoj.utils.authorizationV2.recordAudit(req, { action: 'contest:plagiarism.create', resourceType: 'contest', resourceId: Number(contest.id),
        scope: `contest:${contest.id}`, details: { job_id: Number(inserted.insertId), engine: engine.ENGINE_VERSION } }, manager);
      return (await manager.query('SELECT * FROM contest_plagiarism_job WHERE id=?', [inserted.insertId]))[0];
    });
    setImmediate(() => tick());
    return api().send(res, resource(row), 202);
  } catch (e) { return handleError(res, e); }
});

app.get('/api/v2/contests/:id/plagiarism/:jobId', async (req, res) => {
  try {
    const job = await getJob(req, res);
    const page = req.query.page ? positiveId(req.query.page) : 1;
    const minimum = req.query.minimum == null ? 30 : Number(req.query.minimum);
    if (!Number.isFinite(minimum) || minimum < 30 || minimum > 100) throw error(422, 'VALIDATION_FAILED', '相似度应为 30 到 100。');
    let pairs = [];
    if (!['queued', 'running'].includes(job.state) && await fs.pathExists(path.join(jobDirectory(job), 'pairs.json'))) pairs = await fs.readJson(path.join(jobDirectory(job), 'pairs.json'));
    pairs = pairs.filter(pair => pair.similarity * 100 + 1e-8 >= minimum && (!req.query.group || pair.group === req.query.group));
    const total = pairs.length;
    return api().send(res, { ...resource(job), pairs: pairs.slice((page - 1) * 50, page * 50).map(({ comparison_file, ...pair }) => ({ ...pair,
      // The pair key is resolved from stored results, never used as a file path.
      key: `${pair.group}:${pair.first_id}:${pair.second_id}` })), total, page, page_count: Math.max(1, Math.ceil(total / 50)) });
  } catch (e) { return handleError(res, e); }
});

app.get('/api/v2/contests/:id/plagiarism/:jobId/comparison', async (req, res) => {
  try {
    const job = await getJob(req, res);
    if (['queued', 'running'].includes(job.state)) throw error(409, 'OPERATION_IN_PROGRESS', '任务尚未完成。');
    const root = jobDirectory(job);
    const pairs = await fs.readJson(path.join(root, 'pairs.json'));
    const pair = pairs.find(item => `${item.group}:${item.first_id}:${item.second_id}` === req.query.key);
    if (!pair) throw error(404, 'SUBMISSION_NOT_FOUND', '该代码比对不存在。');
    const directory = path.join(root, pair.group);
    const meta = await fs.readJson(path.join(directory, 'submissions.json'));
    const first = meta.find(row => row.id === pair.first_id), second = meta.find(row => row.id === pair.second_id);
    const report = await engine.readReportJson(path.join(directory, 'report.jplag'), [pair.comparison_file]);
    const comparison = report[pair.comparison_file];
    if (!comparison || !Array.isArray(comparison.matches)) throw new Error('代码比对报告无法读取。');
    const source = row => fs.readFile(path.join(directory, 'sources', `u${row.user_id}`, `Main.${row.extension}`), 'utf8');
    return api().send(res, { first: { ...first, code: await source(first) }, second: { ...second, code: await source(second) },
      similarity: pair.similarity, matches: comparison.matches });
  } catch (e) { return handleError(res, e); }
});

app.get('/contest/:id/plagiarism/:jobId/report/:group', async (req, res) => {
  try {
    const job = await getJob(req, res);
    const group = parse(job.summary_json).groups.find(item => item.key === req.params.group && item.report);
    if (!group) throw error(404, 'JOB_NOT_FOUND', '该分组没有可下载的报告。');
    if (req.query.format && !['html', 'jplag'].includes(req.query.format)) throw error(422, 'VALIDATION_FAILED', '报告格式无效。');
    res.set('X-Content-Type-Options', 'nosniff');
    const directory = path.join(jobDirectory(job), group.key);
    const filename = `contest-${job.contest_id}-job-${job.id}-${group.key}`;
    if (req.query.format === 'html') {
      const file = path.join(directory, 'report-web-v1.html');
      if (!await fs.pathExists(file)) {
        if (!webReportBuilds.has(file)) {
          if (webReportBuilds.size) throw error(429, 'RATE_LIMITED', '正在生成另一份网页报告，请稍后再试。');
          webReportBuilds.set(file, (async () => {
            const html = await engine.buildWebReport({ directory, group, job });
            await fs.writeFile(file + '.tmp', html, { mode: 0o600 });
            await fs.rename(file + '.tmp', file);
          })().finally(() => webReportBuilds.delete(file)));
        }
        await webReportBuilds.get(file);
      }
      return res.download(file, filename + '.html');
    }
    return res.download(path.join(directory, 'report.jplag'), filename + '.jplag');
  } catch (e) { return res.status(e.statusCode || 500).render('error', { err: e }); }
});

const timer = setInterval(tick, 10000);
timer.unref();
ensureSchema().then(() => tick()).catch(e => syzoj.log(`[contest-plagiarism] initialization: ${e.message}`));
