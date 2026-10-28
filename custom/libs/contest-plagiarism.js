'use strict';

const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const { languageExtension } = require('./contest-code-export');

const ENGINE_VERSION = '6.3.0';
const FAMILIES = {
  c: ['cpp', 'C / C++', 'cpp'], cpp: ['cpp', 'C / C++', 'cpp'],
  py: ['python3', 'Python / PyPy', 'py'], java: ['java', 'Java', 'java'],
  js: ['javascript', 'JavaScript', 'js'], ts: ['typescript', 'TypeScript', 'ts'],
  go: ['go', 'Go', 'go'], rs: ['rust', 'Rust', 'rs'], kt: ['kotlin', 'Kotlin', 'kt'], cs: ['csharp', 'C#', 'cs']
};
const MIN_SIMILARITY = 0.3;

// Self-contained report: no CDN, network calls or local JPlag installation.
function webReportClient() {
  'use strict';
  const data = JSON.parse(document.getElementById('report-data').textContent);
  const get = id => document.getElementById(id);
  const make = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const format = value => (value * 100).toFixed(1) + '%';
  const dialog = get('comparison');
  let page = 1, filtered = [], current, matchIndex = 0;
  function draw() {
    const query = get('search').value.trim().toLowerCase(), minimum = Number(get('minimum').value);
    filtered = data.pairs.filter(pair => {
      const first = data.submissions[pair.first_id], second = data.submissions[pair.second_id];
      return pair.similarity * 100 + 1e-8 >= minimum &&
        (!query || [first.username, second.username, first.id, second.id].join(' ').toLowerCase().includes(query));
    });
    const pageCount = Math.max(1, Math.ceil(filtered.length / 50));
    page = Math.min(page, pageCount);
    get('pairs').replaceChildren();
    filtered.slice((page - 1) * 50, page * 50).forEach(pair => {
      const tr = make('tr');
      [data.submissions[pair.first_id], data.submissions[pair.second_id]].forEach(row => {
        const td = make('td', row.username);
        td.append(make('small', 'UID ' + row.user_id + ' · 提交 #' + row.id, 'muted')); tr.append(td);
      });
      tr.append(make('td', format(pair.similarity), 'similarity'));
      const td = make('td'), button = make('button', '查看比对');
      button.type = 'button'; button.addEventListener('click', () => show(pair));
      td.append(button); tr.append(td); get('pairs').append(tr);
    });
    if (!filtered.length) {
      const td = make('td', '当前筛选下没有比较记录。请同时检查下方未完成检测的代码。');
      td.colSpan = 4; const tr = make('tr'); tr.append(td); get('pairs').append(tr);
    }
    get('page').textContent = '第 ' + page + ' / ' + pageCount + ' 页 · 共 ' + filtered.length + ' 对';
    get('prev').disabled = page <= 1; get('next').disabled = page >= pageCount;
  }
  function show(pair) {
    current = pair; matchIndex = 0;
    get('comparison-title').textContent = '代码比对 · 平均相似度 ' + format(pair.similarity);
    ['first', 'second'].forEach((side, sideIndex) => {
      const row = data.submissions[pair[side + '_id']];
      get(side + '-title').textContent = row.username + ' · 提交 #' + row.id + ' · ' + row.language;
      const target = get(side + '-code'); target.replaceChildren(); target.scrollTop = 0;
      const offset = sideIndex * 2, marked = new Set(), lines = row.code.split('\n');
      pair.matches.forEach(match => {
        for (let n = Math.max(1, match[offset]); n <= Math.min(lines.length, match[offset + 1]); n++) marked.add(n);
      });
      const fragment = document.createDocumentFragment();
      lines.forEach((text, index) => {
        const line = make('span', null, 'line' + (marked.has(index + 1) ? ' match' : ''));
        line.dataset.line = index + 1;
        line.append(make('span', index + 1, 'number'), make('span', text || ' ')); fragment.append(line);
      });
      target.append(fragment);
    });
    dialog.showModal(); focusMatch(0);
  }
  function focusMatch(delta) {
    const matches = current.matches;
    get('match-prev').disabled = get('match-next').disabled = !matches.length;
    if (!matches.length) { get('match-label').textContent = '没有相似片段'; return; }
    matchIndex = (matchIndex + delta + matches.length) % matches.length;
    get('match-label').textContent = '相似片段 ' + (matchIndex + 1) + ' / ' + matches.length;
    ['first', 'second'].forEach((side, sideIndex) => {
      const target = get(side + '-code'), offset = sideIndex * 2;
      const start = matches[matchIndex][offset], end = matches[matchIndex][offset + 1];
      target.querySelectorAll('.line').forEach(line => {
        line.classList.toggle('current', Number(line.dataset.line) >= start && Number(line.dataset.line) <= end);
      });
      const line = target.querySelector('[data-line="' + start + '"]');
      if (line) target.scrollTop = Math.max(0, line.offsetTop - 40);
    });
  }
  get('minimum').addEventListener('change', () => { page = 1; draw(); });
  get('search').addEventListener('input', () => { page = 1; draw(); });
  get('prev').addEventListener('click', () => { page--; draw(); });
  get('next').addEventListener('click', () => { page++; draw(); });
  get('close').addEventListener('click', () => dialog.close());
  get('match-prev').addEventListener('click', () => focusMatch(-1));
  get('match-next').addEventListener('click', () => focusMatch(1));
  draw();
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function renderWebReport(data) {
  const title = '#' + data.contest_id + ' · 代码查重报告', group = data.group;
  const state = { completed: '已完成', partial: '部分完成' }[group.state] || group.state;
  const failed = group.failed || [];
  const failureLabels = { CANNOT_PARSE: '无法解析', TOO_SMALL: '有效 token 不足', NOTHING_TO_PARSE: '没有可解析的代码' };
  // Escaping "<" prevents contestant text from closing the inert JSON script.
  const payload = JSON.stringify(data).replace(/[<>&\u2028\u2029]/g, character =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
  const script = '(' + webReportClient.toString() + ')();';
  const hash = require('crypto').createHash('sha256').update(script).digest('base64');
  const csp = "default-src 'none'; script-src 'sha256-" + hash + "'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
  const css = [
    ':root{color-scheme:light;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#172033;background:#f6f8fb}*{box-sizing:border-box}body{max-width:1400px;margin:auto;padding:32px 24px}h1{margin:0 0 10px;font-size:26px}h2{font-size:18px}h1,h2{overflow-wrap:anywhere}button{white-space:nowrap;flex-shrink:0}p{color:#5b6577;line-height:1.7}',
    '.meta,.toolbar,.pagination,.match-nav{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:20px 0}.meta span{padding:5px 10px;border-radius:999px;background:#e8f1ff;color:#1459ad;font-size:13px}label{display:grid;gap:8px;font-size:14px}select,input,button{font:inherit;padding:9px 12px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;color:inherit}button{cursor:pointer;color:#155eb4}button:hover{border-color:#1767c5;background:#f1f6ff}button:disabled{opacity:.5;cursor:default}:focus-visible{outline:2px solid #1767c5;outline-offset:2px}',
    '.table-region{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left;background:#fff}th,td{padding:14px;border-bottom:1px solid #e2e8f0}th{color:#657083;background:#f1f5f9}.muted{display:block;color:#64748b;font-size:12px;margin-top:5px}.similarity{font-weight:650;color:#155eb4}.pagination{justify-content:flex-end}details{margin:24px 0}summary{cursor:pointer;font-weight:600}',
    'dialog{width:min(1320px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:calc(100dvh - 32px);padding:20px;border:1px solid #dbe2ec;border-radius:12px;background:white;color:#172033}dialog::backdrop{background:#11182799}.dialog-header{display:flex;gap:16px;justify-content:space-between;align-items:center}.dialog-header h2{margin:0}.columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}.columns h3{font-size:14px;overflow-wrap:anywhere}',
    '.code{position:relative;margin:0;overflow:auto;max-height:55vh;background:#f7f9fc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 0;font:13px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;tab-size:4}.line{display:block;white-space:pre;min-width:max-content;padding-right:14px}.match{background:#e5f1ff}.current{background:#fff0b5}.number{display:inline-block;width:4.5em;padding-right:1em;color:#7a8799;text-align:right;user-select:none}',
    '@media(max-width:760px){body{padding:20px 12px}h1{font-size:22px}.columns{grid-template-columns:minmax(0,1fr)}.code{max-height:35vh}th,td{padding:10px;min-width:110px}input{max-width:100%}.pagination{justify-content:space-between}.toolbar label{width:100%}}'
  ].join('\n');
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="' + escapeHtml(csp) + '"><title>' + escapeHtml(title) + '</title><style>' + css + '</style></head><body>',
    '<h1>' + escapeHtml(title) + '</h1><h2>题目 #' + Number(group.problem_id) + ' ' + escapeHtml(group.title) + ' · ' + escapeHtml(group.language_label) + '</h2>',
    '<p>报告已包含代码和比对结果，可直接用浏览器离线查看，无需安装 JPlag。相似度仅供人工核查，不代表作弊结论。</p>',
    '<div class="meta"><span>任务 #' + Number(data.job_id) + '</span><span>JPlag ' + escapeHtml(data.engine) + '</span><span>' + escapeHtml(state) + '</span><span>' + Number(group.count) + ' 份代码</span><span>' + data.pairs.length + ' 对比较</span></div>',
    '<p>每人每题每种语言取最后一次 AC，没有 AC 则取最后一次提交。此报告包含本分组平均相似度不低于 ' + Number(data.minimum_similarity) * 100 + '% 的全部已保存比较。' + escapeHtml(group.message || '') + '</p>',
    '<div class="toolbar"><label>最低平均相似度<select id="minimum"><option value="30">30%</option><option value="50">50%</option><option value="70">70%</option><option value="90">90%</option><option value="100">100%</option></select></label><label>搜索选手或提交编号<input id="search" type="search" placeholder="用户名 / 提交编号" autocomplete="off"></label></div>',
    '<div class="table-region"><table><thead><tr><th>选手一 / 提交</th><th>选手二 / 提交</th><th>平均相似度</th><th>操作</th></tr></thead><tbody id="pairs"></tbody></table></div><div class="pagination"><button id="prev" type="button">上一页</button><span id="page" role="status"></span><button id="next" type="button">下一页</button></div>',
    '<details' + (failed.length ? ' open' : '') + '><summary>未完成检测的代码（' + failed.length + '）</summary><p>这些代码没有完成比较，不能据此认定没有重复。</p>',
    failed.length ? '<div class="table-region"><table><thead><tr><th>选手</th><th>提交</th><th>原因</th></tr></thead><tbody>' + failed.map(row => '<tr><td>' + escapeHtml(row.username) + '</td><td>' + (row.submission_id ? '#' + Number(row.submission_id) : '—') + '</td><td>' + escapeHtml(failureLabels[row.state] || row.state) + '</td></tr>').join('') + '</tbody></table></div>' : '<p>本分组没有解析失败或 token 不足的代码。</p>',
    '</details><dialog id="comparison" aria-labelledby="comparison-title"><header class="dialog-header"><h2 id="comparison-title">代码比对</h2><button id="close" type="button">关闭</button></header><div class="match-nav"><button id="match-prev" type="button">上一处</button><span id="match-label" role="status"></span><button id="match-next" type="button">下一处</button></div><div class="columns"><section><h3 id="first-title"></h3><pre id="first-code" class="code" tabindex="0" aria-label="选手一代码"></pre></section><section><h3 id="second-title"></h3><pre id="second-code" class="code" tabindex="0" aria-label="选手二代码"></pre></section></div></dialog>',
    '<noscript><p>请启用浏览器 JavaScript 来查看比对列表和代码片段。</p></noscript><script id="report-data" type="application/json">' + payload + '</script><script>' + script + '</script></body></html>'
  ].join('\n');
}

async function buildWebReport({ directory, group, job }) {
  const metadata = await fs.readJson(path.join(directory, 'submissions.json'));
  const headers = await readReportJson(path.join(directory, 'report.jplag'),
    ['submissionMappings.json', 'topComparisons.json', 'runInformation.json']);
  const { pairs, failed } = parseComparisons(headers, metadata);
  pairs.sort((a, b) => b.similarity - a.similarity || a.first_id - b.first_id);
  const details = await readReportJson(path.join(directory, 'report.jplag'), pairs.map(pair => pair.comparison_file), {
    maxTotalBytes: 512 * 1024 * 1024,
    transform: comparison => {
      if (!comparison || !Array.isArray(comparison.matches)) throw new Error('代码比对报告无法读取。');
      return comparison.matches.map(match => {
        const lines = [match.startInFirst.line, match.endInFirst.line, match.startInSecond.line, match.endInSecond.line];
        if (!lines.every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('相似片段行号无效。');
        return lines;
      });
    }
  });
  const selected = new Set(pairs.flatMap(pair => [pair.first_id, pair.second_id]));
  const submissions = {};
  let sourceBytes = 0;
  for (const row of metadata.filter(item => selected.has(item.id))) {
    if (!Number.isSafeInteger(row.user_id) || !/^[a-z0-9]+$/.test(row.extension)) throw new Error('提交快照格式无效。');
    const file = path.join(directory, 'sources', 'u' + row.user_id, 'Main.' + row.extension);
    sourceBytes += (await fs.stat(file)).size;
    if (sourceBytes > 64 * 1024 * 1024) throw new Error('网页报告代码超过 64 MiB，请在比赛查重页逐项查看比对。');
    submissions[row.id] = { id: row.id, user_id: row.user_id, username: row.username,
      language: row.language || group.language_label, code: await fs.readFile(file, 'utf8') };
  }
  return renderWebReport({ contest_id: Number(job.contest_id), job_id: Number(job.id), engine: ENGINE_VERSION,
    minimum_similarity: MIN_SIMILARITY, group: { ...group, failed }, submissions,
    pairs: pairs.map(pair => {
      if (!details[pair.comparison_file]) throw new Error('代码比对报告不完整。');
      return { first_id: pair.first_id, second_id: pair.second_id, similarity: pair.similarity, matches: details[pair.comparison_file] };
    }) });
}

function selectSubmissions(rows, snapshot, languages) {
  const selected = new Map();
  const stats = { total: 0, unsupported: 0, empty: 0, replaced: 0, selected: 0 };
  for (const row of rows) {
    if (Number(row.submit_time) < snapshot.start_time || Number(row.submit_time) >= snapshot.end_time || Number(row.id) > snapshot.max_submission_id) continue;
    stats.total++;
    const language = FAMILIES[languageExtension(row.language, languages)];
    if (!language || /^python2(?:$|[._-])/.test(String(row.language)) || ['submit-answer', 'engineering'].includes(row.type)) { stats.unsupported++; continue; }
    const code = row.version_source == null ? row.code : row.version_source;
    if (typeof code !== 'string' || !code.trim()) { stats.empty++; continue; }
    const key = `${Number(row.problem_id)}:${language[0]}:${Number(row.user_id)}`;
    const candidate = { id: Number(row.id), user_id: Number(row.user_id), username: row.username || `用户 #${row.user_id}`,
      problem_id: Number(row.problem_id), title: row.title || `题目 #${row.problem_id}`, language: row.language,
      family: language[0], family_label: language[1], extension: language[2], code, accepted: row.status === 'Accepted' };
    const previous = selected.get(key);
    // One comparable program per contestant/problem/language family: latest AC,
    // or latest attempt if no AC. Repeated attempts must not inflate similarity.
    if (!previous || (candidate.accepted && !previous.accepted) ||
        (candidate.accepted === previous.accepted && candidate.id > previous.id)) selected.set(key, candidate);
    if (previous) stats.replaced++;
  }
  stats.selected = selected.size;
  const groups = new Map();
  for (const submission of selected.values()) {
    const key = `p${submission.problem_id}-${submission.family}`;
    if (!groups.has(key)) groups.set(key, { key, problem_id: submission.problem_id, title: submission.title,
      language: submission.family, language_label: submission.family_label, submissions: [] });
    groups.get(key).submissions.push(submission);
  }
  return { stats, groups: [...groups.values()].sort((a, b) => a.problem_id - b.problem_id || a.language.localeCompare(b.language)) };
}

function runtimePaths(root = '/opt/jplag') {
  return { java: path.join(root, 'jdk/bin/java'), jar: path.join(root, 'jplag.jar') };
}

async function runtimeAvailable(root) {
  const runtime = runtimePaths(root);
  try { await fs.access(runtime.java, fs.constants.X_OK); await fs.access(runtime.jar, fs.constants.R_OK); return true; }
  catch (_) { return false; }
}

async function runJPlag({ directory, language, runtimeRoot, timeoutMs = 15 * 60 * 1000 }) {
  const runtime = runtimePaths(runtimeRoot);
  const report = path.join(directory, 'report.jplag');
  const args = ['-Xmx2g', '-XX:ActiveProcessorCount=2', '-Djava.awt.headless=true', '-jar', runtime.jar,
    '-M', 'RUN', '-l', language, '--skip-version-check', '--cluster-skip', '--encoding', 'UTF-8',
    '-n', '-1', '-m', String(MIN_SIMILARITY), '-r', report, path.join(directory, 'sources')];
  await new Promise((resolve, reject) => {
    // No shell and no compilation/execution of contestant code. JVM runs at low
    // scheduler priority with a bounded heap and a hard per-group timeout.
    const child = spawn('/usr/bin/nice', ['-n', '10', runtime.java, ...args], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: `${path.dirname(runtime.java)}:/usr/bin:/bin`, JAVA_HOME: path.dirname(path.dirname(runtime.java)), LANG: 'C.UTF-8' },
      cwd: directory });
    let output = '', timedOut = false;
    const capture = data => { output = (output + data.toString('utf8')).slice(-20000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('该分组查重超过 15 分钟，已停止。可减少提交后重新查重。'));
      if (code !== 0) {
        const error = new Error('JPlag 无法完成该分组，可能是有效代码不足、语法不受支持或资源限制。');
        error.engineLog = output;
        return reject(error);
      }
      resolve();
    });
  });
  return report;
}

function readReportJson(archive, names, { maxTotalBytes = 64 * 1024 * 1024, transform = value => value } = {}) {
  const wanted = new Set(names);
  return new Promise((resolve, reject) => {
    require('yauzl').open(archive, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const result = {}; let total = 0, finished = false;
      const fail = error => { if (!finished) { finished = true; zip.close(); reject(error); } };
      zip.on('error', fail);
      zip.on('end', () => { if (!finished) { finished = true; resolve(result); } });
      zip.on('entry', entry => {
        if (!wanted.has(entry.fileName)) return zip.readEntry();
        if (entry.uncompressedSize > 64 * 1024 * 1024) return fail(new Error('查重报告过大，无法读取。'));
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail(error);
          const chunks = [];
          stream.on('error', fail);
          stream.on('data', chunk => {
            total += chunk.length;
            if (total > maxTotalBytes) { stream.destroy(); return fail(new Error('查重报告过大，无法读取。')); }
            chunks.push(chunk);
          });
          stream.on('end', () => {
            if (finished) return;
            try { result[entry.fileName] = transform(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (_) { return fail(new Error('JPlag 报告格式无法识别。')); }
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function parseComparisons(report, submissions) {
  const mappings = report['submissionMappings.json'];
  const top = report['topComparisons.json'];
  if (!mappings || !Array.isArray(top) || !mappings.submissionIds || !mappings.submissionIdsToComparisonFileName) throw new Error('JPlag 报告版本或格式不兼容。');
  const users = new Map(submissions.map(row => [`u${row.user_id}`, row]));
  const pairs = [];
  for (const comparison of top) {
    const first = users.get(mappings.submissionIds[comparison.firstSubmission]);
    const second = users.get(mappings.submissionIds[comparison.secondSubmission]);
    const file = (mappings.submissionIdsToComparisonFileName[comparison.firstSubmission] || {})[comparison.secondSubmission];
    if (!first || !second || !file) throw new Error('查重报告与提交快照不匹配。');
    if (first.user_id === second.user_id) continue;
    const similarity = Number(comparison.similarities.AVG);
    if (!Number.isFinite(similarity) || similarity < 0 || similarity > 1) throw new Error('查重报告包含无效相似度。');
    pairs.push({ first_id: first.id, second_id: second.id, first_user_id: first.user_id, second_user_id: second.user_id,
      first_username: first.username, second_username: second.username, similarity,
      max_similarity: Number(comparison.similarities.MAX), comparison_file: 'comparisons/' + file });
  }
  const run = report['runInformation.json'];
  if (!run || !Array.isArray(run.failedSubmissions)) throw new Error('JPlag 运行信息无法识别。');
  return { pairs, failed: run.failedSubmissions.map(item => {
    const name = item.submissionId;
    const submission = users.get(name) || users.get(mappings.submissionIds[name]);
    return { state: item.submissionState, username: submission ? submission.username : name, submission_id: submission ? submission.id : null };
  }) };
}

async function analyzeGroup(group, directory, runtimeRoot) {
  await fs.ensureDir(directory, { mode: 0o700 });
  const meta = group.submissions.map(({ code, ...row }) => row);
  await fs.writeJson(path.join(directory, 'submissions.json'), meta, { mode: 0o600 });
  if (group.submissions.length < 2) return { pairs: [], failed: [], state: 'skipped', message: '不足两名选手，未比较。' };
  if (group.submissions.length > 1500) throw new Error('该分组超过 1500 名选手，未运行；请联系站长分批处理。');
  for (const row of group.submissions) {
    const sourceDir = path.join(directory, 'sources', `u${row.user_id}`);
    await fs.ensureDir(sourceDir, { mode: 0o700 });
    await fs.writeFile(path.join(sourceDir, `Main.${row.extension}`), row.code, { mode: 0o600 });
  }
  const archive = await runJPlag({ directory, language: group.language, runtimeRoot });
  const report = await readReportJson(archive, ['submissionMappings.json', 'topComparisons.json', 'runInformation.json']);
  const result = parseComparisons(report, meta);
  return { ...result, state: result.failed.length ? 'partial' : 'completed', message: result.failed.length ? `${result.failed.length} 份代码无法解析或有效 token 不足。` : '' };
}

module.exports = { ENGINE_VERSION, MIN_SIMILARITY, FAMILIES, selectSubmissions, runtimePaths, runtimeAvailable, runJPlag, readReportJson, parseComparisons, analyzeGroup, buildWebReport, renderWebReport };
