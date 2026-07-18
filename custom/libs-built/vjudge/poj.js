const cheerio = require('cheerio');
const request = require('request');
const requestPromise = require('request-promise');
const TypeORM = require('typeorm');
const TurndownService = require('/app/custom-node-modules/turndown');
const turndownPluginGfm = require('/app/custom-node-modules/turndown-plugin-gfm');

const endpoint = (process.env.SYZOJ_WEB_POJ_ENDPOINT || 'http://poj.org').replace(/\/+$/, '');
const jar = request.jar();
const client = requestPromise.defaults({
  baseUrl: endpoint,
  jar: jar,
  gzip: true,
  timeout: 20000,
  simple: false,
  resolveWithFullResponse: true,
  followRedirect: false,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
  }
});

const languageIds = {
  'poj.G++': '0',
  'poj.GCC': '1',
  'poj.Java': '2',
  'poj.Pascal': '3',
  'poj.C++': '4',
  'poj.C': '5',
  'poj.Fortran': '6'
};

const languageLabels = {
  'poj.G++': ['G++', 'cpp'],
  'poj.GCC': ['GCC', 'c'],
  'poj.Java': ['Java', 'java'],
  'poj.Pascal': ['Pascal', 'pascal'],
  'poj.C++': ['C++', 'cpp'],
  'poj.C': ['C', 'c'],
  'poj.Fortran': ['Fortran', 'fortran']
};

let authenticated = false;
let loginPromise = null;
let submissionQueue = Promise.resolve();
let queuedSubmissions = 0;
const recentUserSubmissions = new Map();
const MAX_QUEUED_SUBMISSIONS = 50;
const USER_SUBMISSION_COOLDOWN = 5000;

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**'
});
turndown.use(turndownPluginGfm.gfm);
turndown.addRule('pojPreformattedText', {
  filter: 'pre',
  replacement: function replacement(content, node) {
    const text = String(node.textContent || '').replace(/^\n+|\n+$/g, '');
    return '\n\n```plain\n' + text + '\n```\n\n';
  }
});

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function configured() {
  return !!(process.env.SYZOJ_WEB_POJ_USERNAME && process.env.SYZOJ_WEB_POJ_PASSWORD);
}

async function requestWithRetry(method, uri, options) {
  const maxAttempts = method === 'GET' ? 3 : 1;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await client(Object.assign({ method: method, uri: uri }, options || {}));
      if (response.statusCode < 400) return response;
      const error = errorWithCode('POJ 请求失败，HTTP ' + response.statusCode, 'POJ_HTTP');
      error.statusCode = response.statusCode;
      if (![429, 500, 502, 503, 504].includes(response.statusCode) || attempt === maxAttempts) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || (error.statusCode && ![429, 500, 502, 503, 504].includes(error.statusCode))) {
        throw error;
      }
    }
    await delay(500 * attempt);
  }
  throw lastError;
}

function isLoginPage(html) {
  return /<form[^>]+(?:action=["']?\/?login\b)[\s\S]*?name=["']?user_id1\b/i.test(html || '');
}

function isAuthResponse(response) {
  const location = String(response.headers && response.headers.location || '');
  return [401, 403].includes(response.statusCode) || /\/login(?:[/?#;]|$)/i.test(location) || isLoginPage(response.body);
}

function isAuthenticatedPage(html) {
  const username = String(process.env.SYZOJ_WEB_POJ_USERNAME || '');
  return /login\?action=logout/i.test(html || '') &&
    (!username || String(html || '').toLowerCase().includes(('user_id=' + username).toLowerCase()));
}

async function performLogin() {
  if (!configured()) {
    throw new Error('未配置 POJ VJudge 账号。请设置 SYZOJ_WEB_POJ_USERNAME 和 SYZOJ_WEB_POJ_PASSWORD。');
  }
  await requestWithRetry('GET', '/');
  const response = await requestWithRetry('POST', '/login', {
    form: {
      user_id1: process.env.SYZOJ_WEB_POJ_USERNAME,
      password1: process.env.SYZOJ_WEB_POJ_PASSWORD,
      B1: 'login',
      url: '.'
    }
  });
  if (/wrong|invalid|failed|not exist/i.test(response.body || '')) {
    throw new Error('POJ 登录失败：用户名或密码错误。');
  }
  const home = await requestWithRetry('GET', '/');
  if (!isAuthenticatedPage(home.body)) throw new Error('POJ 登录失败，登录协议或账号状态可能已经变化。');
  authenticated = true;
}

async function ensureLogin(force) {
  if (authenticated && !force) return;
  if (!loginPromise) {
    if (force) authenticated = false;
    loginPromise = performLogin().finally(() => { loginPromise = null; });
  }
  await loginPromise;
}

function parseTimeMs(text) {
  const match = /([0-9]+(?:\.[0-9]+)?)\s*(ms|s)?/i.exec(String(text || '').replace(/,/g, ''));
  if (!match) return 0;
  return Math.round(parseFloat(match[1]) * (match[2] && match[2].toLowerCase() === 's' ? 1000 : 1));
}

function parseMemoryKiB(text) {
  const match = /([0-9]+(?:\.[0-9]+)?)\s*(k|kb|kib|m|mb|mib)?/i.exec(String(text || '').replace(/,/g, ''));
  if (!match) return 0;
  return Math.round(parseFloat(match[1]) * (match[2] && /^m/i.test(match[2]) ? 1024 : 1));
}

function parseStatusRows(html) {
  const $ = cheerio.load(html || '');
  const rows = [];
  $('table.a tr').each((_, row) => {
    const cells = $(row).children('td');
    if (cells.length < 9) return;
    const submissionId = parseInt(cells.eq(0).text().trim());
    const problemId = parseInt(cells.eq(2).text().trim());
    if (!Number.isSafeInteger(submissionId) || !Number.isSafeInteger(problemId)) return;
    rows.push({
      submissionId: submissionId,
      author: cells.eq(1).text().replace(/\s+/g, ' ').trim(),
      problemId: problemId,
      status: cells.eq(3).text().replace(/\s+/g, ' ').trim(),
      memory: parseMemoryKiB(cells.eq(4).text()),
      time: parseTimeMs(cells.eq(5).text()),
      language: cells.eq(6).text().replace(/\s+/g, ' ').trim(),
      codeLength: parseInt(cells.eq(7).text()) || 0,
      submitTime: cells.eq(8).text().replace(/\s+/g, ' ').trim()
    });
  });
  return rows;
}

async function fetchStatusRows(problemId) {
  const response = await requestWithRetry('GET', '/status', {
    qs: {
      problem_id: problemId,
      user_id: process.env.SYZOJ_WEB_POJ_USERNAME,
      result: '',
      language: ''
    }
  });
  if (isAuthResponse(response)) throw errorWithCode('POJ 登录会话已失效。', 'POJ_AUTH');
  return parseStatusRows(response.body);
}

async function latestSubmissionId(problemId) {
  const rows = await fetchStatusRows(problemId);
  return rows.length ? Math.max.apply(Math, rows.map(row => row.submissionId)) : 0;
}

async function findNewSubmissionId(problemId, beforeId, expectedLanguage, codeLength) {
  const username = String(process.env.SYZOJ_WEB_POJ_USERNAME || '').toLowerCase();
  const matches = (await fetchStatusRows(problemId)).filter(row => row.submissionId > beforeId &&
    row.author.toLowerCase() === username && row.language === expectedLanguage && row.codeLength === codeLength);
  if (!matches.length) return 0;
  if (matches.length > 1) throw new Error('发现多个符合条件的 POJ Run ID，无法安全关联本地提交。');
  return matches[0].submissionId;
}

async function submitOnce(problemId, language, code, onBeforeSubmit) {
  const codeLength = Buffer.byteLength(code, 'utf8');
  if (codeLength > 64 * 1024) throw new Error('POJ 源代码长度不能超过 64 KiB。');
  const languageId = languageIds[language];
  if (languageId == null) throw new Error('不支持的 POJ 语言：' + language);

  const beforeId = await latestSubmissionId(problemId);
  const page = await requestWithRetry('GET', '/submit', { qs: { problem_id: problemId } });
  if (isAuthResponse(page)) throw errorWithCode('POJ 登录会话已失效。', 'POJ_AUTH');
  const $ = cheerio.load(page.body || '');
  const form = $('form[action="submit"], form[action="/submit"]').filter((_, element) =>
    $(element).find('textarea[name="source"]').length > 0
  ).first();
  if (!form.length) throw new Error('无法解析 POJ 提交页面，提交协议可能已经变化。');
  const availableLanguages = new Set();
  form.find('select[name="language"] option').each((_, option) => availableLanguages.add($(option).attr('value')));
  if (availableLanguages.size && !availableLanguages.has(languageId)) {
    throw new Error('POJ 当前不支持语言 ' + languageLabels[language][0] + '。');
  }
  if (onBeforeSubmit) {
    await onBeforeSubmit({ beforeId: beforeId, expectedLanguage: languageLabels[language][0], codeLength: codeLength });
  }

  const response = await requestWithRetry('POST', '/submit', {
    form: {
      problem_id: String(problemId),
      language: languageId,
      source: Buffer.from(code, 'utf8').toString('base64'),
      submit: 'Submit',
      encoded: '1'
    }
  });
  if (isAuthResponse(response)) throw errorWithCode('POJ 登录会话已失效。', 'POJ_AUTH');
  if (![301, 302, 303, 307, 308].includes(response.statusCode) && /error|invalid|too long|no such problem/i.test(response.body || '')) {
    throw new Error('POJ 拒绝了提交，题目表单或账号状态可能已经变化。');
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    const submissionId = await findNewSubmissionId(problemId, beforeId, languageLabels[language][0], codeLength);
    if (submissionId > beforeId) return submissionId;
    await delay(500);
  }
  throw new Error('POJ 已接收请求，但未找到对应的 Run ID。');
}

function queueSubmission(action, userId) {
  if (queuedSubmissions >= MAX_QUEUED_SUBMISSIONS) throw errorWithCode('POJ 提交队列已满，请稍后重试。', 'POJ_QUEUE_FULL');
  if (userId) {
    const lastSubmission = recentUserSubmissions.get(Number(userId)) || 0;
    if (Date.now() - lastSubmission < USER_SUBMISSION_COOLDOWN) {
      throw errorWithCode('POJ 提交过于频繁，请稍后重试。', 'POJ_RATE_LIMIT');
    }
    recentUserSubmissions.set(Number(userId), Date.now());
  }
  queuedSubmissions += 1;
  const result = submissionQueue.then(action, action).finally(() => { queuedSubmissions -= 1; });
  submissionQueue = result.catch(() => {});
  return result;
}

async function persistVjudgeMarker(judgeState, marker) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const rows = await TypeORM.getConnection().query(
      'SELECT `task_id`, `pending` FROM `judge_state` WHERE `id` = ? LIMIT 1',
      [judgeState.id]
    );
    if (!rows.length || rows[0].task_id !== judgeState.task_id) {
      throw errorWithCode('本地评测任务已取消或被替换。', 'POJ_ABORT');
    }
    if (rows[0].pending) break;
    await delay(50);
    if (attempt === 39) throw new Error('本地评测任务未进入等待状态。');
  }
  const result = await TypeORM.getConnection().query(
    'UPDATE `judge_state` SET `result` = ? WHERE `id` = ? AND `task_id` = ? AND `pending` = 1',
    [JSON.stringify({ vjudge: marker }), judgeState.id, judgeState.task_id]
  );
  if (!result || result.affectedRows !== 1) {
    throw errorWithCode('本地评测任务已取消或被替换。', 'POJ_ABORT');
  }
}

async function persistRemoteSubmission(judgeState, submissionId, problemId) {
  await persistVjudgeMarker(judgeState, {
    provider: 'poj',
    phase: 'judging',
    submissionId: submissionId,
    problemId: problemId
  });
}

async function submitRemote(problemId, language, code, userId, onBeforeSubmit) {
  return queueSubmission(async () => {
    await ensureLogin(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await submitOnce(problemId, language, code, onBeforeSubmit);
      } catch (error) {
        if (error.code !== 'POJ_AUTH' || attempt > 0) throw error;
        await ensureLogin(true);
      }
    }
  }, userId);
}

function safeVjudgeError(error) {
  const message = String(error && error.message || error || '未知错误');
  if (/未配置 POJ VJudge 账号|源代码长度|不支持的 POJ 语言|默认禁止用于比赛|远程题号不正确|提交过于频繁|提交队列已满/.test(message)) {
    return message.slice(0, 240);
  }
  return 'POJ 远程评测暂时不可用，请稍后重试。';
}

function verdictType(status) {
  const types = {
    'Accepted': 1,
    'Wrong Answer': 2,
    'Presentation Error': 3,
    'Memory Limit Exceeded': 4,
    'Time Limit Exceeded': 5,
    'Output Limit Exceeded': 6,
    'Runtime Error': 8,
    'System Error': 9
  };
  return types[status] || 9;
}

async function fetchCompileError(submissionId) {
  const response = await requestWithRetry('GET', '/showcompileinfo', { qs: { solution_id: submissionId } });
  if (isAuthResponse(response)) throw errorWithCode('POJ 登录会话已失效。', 'POJ_AUTH');
  const $ = cheerio.load(response.body || '');
  return $('pre').first().text().trim().slice(0, 12000) || 'POJ Compile Error';
}

async function pollResult(submissionId, problemId, judgeState, onProgress) {
  const pollLimit = Math.max(1, Math.min(300, parseInt(process.env.SYZOJ_WEB_POJ_POLL_LIMIT || '120')));
  let progressSent = false;
  for (let attempt = 0; attempt < pollLimit; attempt++) {
    await delay(3000);
    let rows;
    try {
      rows = await fetchStatusRows(problemId);
    } catch (error) {
      if (error.code !== 'POJ_AUTH') throw error;
      await queueSubmission(() => ensureLogin(true));
      continue;
    }
    const row = rows.find(item => item.submissionId === submissionId);
    if (!row || /^(Waiting|Compiling|Running(?:\s*&\s*Judging)?|Judging)$/i.test(row.status)) {
      if (!progressSent) {
        progressSent = true;
        const accepted = await onProgress({
          taskId: judgeState.task_id,
          type: 3,
          progress: { judge: { subtasks: [{ score: 0, cases: [{ status: 1 }] }] } }
        });
        if (accepted === false) throw errorWithCode('本地评测任务已取消或被替换。', 'POJ_ABORT');
      }
      continue;
    }
    if (/^Compile Error$/i.test(row.status)) {
      let message;
      try {
        message = await fetchCompileError(submissionId);
      } catch (error) {
        if (error.code !== 'POJ_AUTH') throw error;
        await queueSubmission(() => ensureLogin(true));
        message = await fetchCompileError(submissionId);
      }
      return { compile: { status: 3, message: message } };
    }
    const score = row.status === 'Accepted' ? 100 : 0;
    return {
      compile: { status: 2 },
      judge: {
        subtasks: [{
          score: score,
          cases: [{
            status: 2,
            result: {
              type: verdictType(row.status),
              time: row.time,
              memory: row.memory,
              scoringRate: score / 100,
              systemMessage: 'POJ Run ID: ' + submissionId
            }
          }]
        }]
      }
    };
  }
  throw new Error('等待 POJ 评测结果超时。');
}

function sanitizeContent($, content) {
  content.find('script, style, iframe, object, embed, form, input, button').remove();
  content.find('*').each((_, element) => {
    const node = $(element);
    for (const name of Object.keys(element.attribs || {})) {
      if (/^on/i.test(name) || ['style', 'srcdoc'].includes(name.toLowerCase())) node.removeAttr(name);
    }
    for (const name of ['href', 'src']) {
      const value = node.attr(name);
      if (!value || value.startsWith('#')) continue;
      try {
        const url = new URL(value, endpoint);
        if (!['http:', 'https:'].includes(url.protocol)) node.removeAttr(name);
        else node.attr(name, url.href);
      } catch (error) {
        node.removeAttr(name);
      }
    }
  });
}

function htmlToMarkdown(html) {
  return turndown.turndown(String(html || '')).replace(/\n{3,}/g, '\n\n').trim();
}

function parseLimit(text, kind) {
  const label = kind === 'time' ? 'Time Limit' : 'Memory Limit';
  const match = new RegExp(label + ':\\s*(\\d+)\\s*(MS|S|K|KB|M|MB)', 'i').exec(text || '');
  if (!match) return kind === 'time' ? 1000 : 64;
  const value = parseInt(match[1]);
  const unit = match[2].toUpperCase();
  if (kind === 'time') return unit === 'S' ? value * 1000 : value;
  if (unit === 'M' || unit === 'MB') return value;
  return Math.max(1, Math.ceil(value / 1024));
}

function parseProblemHtml(html, remoteId) {
  const $ = cheerio.load(html || '', { decodeEntities: false });
  const title = $('.ptt').first().text().replace(/\s+/g, ' ').trim();
  if (!title || !$('p.pst').length) throw new Error('POJ 题目 #' + remoteId + ' 不存在或题面不可见。');
  const sections = {};
  $('p.pst').each((_, heading) => {
    const name = $(heading).text().replace(/\s+/g, ' ').trim().toLowerCase();
    const content = $(heading).next('div.ptx, pre.sio').first();
    if (!content.length) return;
    sanitizeContent($, content);
    sections[name] = htmlToMarkdown($.html(content));
  });
  const samples = [];
  if (sections['sample input']) samples.push('### Input\n\n' + sections['sample input']);
  if (sections['sample output']) samples.push('### Output\n\n' + sections['sample output']);
  const limitText = $('.plm').first().text().replace(/\s+/g, ' ').trim();
  const metadata = [];
  if (sections.hint) metadata.push(sections.hint);
  if (sections.source) metadata.push('Source: ' + sections.source);
  if (limitText) metadata.push(limitText);
  metadata.push('[查看 POJ 原题](' + endpoint + '/problem?id=' + remoteId + ')');
  return {
    title: title,
    description: sections.description || '',
    inputFormat: sections.input || '',
    outputFormat: sections.output || '',
    example: samples.join('\n\n'),
    hint: metadata.join('\n\n'),
    timeLimit: parseLimit(limitText, 'time'),
    memoryLimit: parseLimit(limitText, 'memory')
  };
}

function parseProblemListHtml(html) {
  const $ = cheerio.load(html || '');
  const problemIds = new Set();
  let volumeCount = 1;
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href') || '';
    let match = /^problem\?id=(\d+)$/i.exec(href);
    if (match) problemIds.add(parseInt(match[1]));
    match = /^problemlist\?volume=(\d+)/i.exec(href);
    if (match) volumeCount = Math.max(volumeCount, parseInt(match[1]));
  });
  return { problemIds: Array.from(problemIds), volumeCount: volumeCount };
}

async function fetchProblemIds() {
  await ensureLogin();
  const firstResponse = await requestWithRetry('GET', '/problemlist', { qs: { volume: 1 } });
  if (isAuthResponse(firstResponse)) throw errorWithCode('POJ 登录会话已失效。', 'POJ_AUTH');
  const firstVolume = parseProblemListHtml(firstResponse.body);
  const problemIds = new Set(firstVolume.problemIds);
  for (let volume = 2; volume <= firstVolume.volumeCount; volume++) {
    const response = await requestWithRetry('GET', '/problemlist', { qs: { volume: volume } });
    if (isAuthResponse(response)) throw errorWithCode('POJ 登录会话已失效。', 'POJ_AUTH');
    for (const problemId of parseProblemListHtml(response.body).problemIds) problemIds.add(problemId);
    await delay(200);
  }
  return Array.from(problemIds).sort((left, right) => left - right);
}

async function fetchProblem(remoteId) {
  const id = parseInt(remoteId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('POJ 题号不正确。');
  await ensureLogin();
  let response = await requestWithRetry('GET', '/problem', { qs: { id: id } });
  if (isAuthResponse(response)) {
    await queueSubmission(() => ensureLogin(true));
    response = await requestWithRetry('GET', '/problem', { qs: { id: id } });
  }
  if (response.statusCode !== 200) throw new Error('POJ 题目 #' + id + ' 不存在或不可访问。');
  return parseProblemHtml(response.body, id);
}

async function runVjudge(judgeState, problem, onProgress) {
  let finished = false;
  try {
    const problemId = parseInt(problem.vjudge_config);
    if (!Number.isSafeInteger(problemId) || problemId <= 0) throw new Error('POJ 远程题号不正确。');
    if (judgeState.type === 1 && process.env.SYZOJ_WEB_POJ_ALLOW_CONTESTS !== 'true') {
      throw new Error('POJ VJudge 默认禁止用于比赛；确认上游账号和代码可见性策略后才可启用。');
    }
    const submissionId = await submitRemote(problemId, judgeState.language, judgeState.code, judgeState.user_id, metadata =>
      persistVjudgeMarker(judgeState, {
        provider: 'poj',
        phase: 'submitting',
        problemId: problemId,
        beforeId: metadata.beforeId,
        expectedLanguage: metadata.expectedLanguage,
        codeLength: metadata.codeLength
      })
    );
    await persistRemoteSubmission(judgeState, submissionId, problemId);
    const progress = await pollResult(submissionId, problemId, judgeState, onProgress);
    await onProgress({ taskId: judgeState.task_id, type: 4, progress: progress });
    finished = true;
  } catch (error) {
    if (error.code === 'POJ_ABORT') return;
    console.error('POJ VJudge failed:', error && error.stack ? error.stack : error);
    if (!finished) {
      try {
        await onProgress({
          taskId: judgeState.task_id,
          type: 4,
          progress: { error: 0, systemMessage: safeVjudgeError(error) }
        });
      } catch (reportError) {
        console.error('Failed to report POJ VJudge error:', reportError);
      }
    }
  }
}

function vjudge(judgeState, problem, onProgress) {
  setImmediate(() => {
    runVjudge(judgeState, problem, onProgress).catch(error => console.error('Unhandled POJ VJudge error:', error));
  });
}

vjudge.resume = function resume(judgeState, submissionId, problemId, onProgress) {
  setImmediate(() => {
    pollResult(submissionId, problemId, judgeState, onProgress)
      .then(progress => onProgress({ taskId: judgeState.task_id, type: 4, progress: progress }))
      .catch(async error => {
        if (error.code === 'POJ_ABORT') return;
        try {
          await onProgress({ taskId: judgeState.task_id, type: 4, progress: { error: 0, systemMessage: safeVjudgeError(error) } });
        } catch (reportError) {
          console.error('Failed to report resumed POJ VJudge error:', reportError);
        }
      });
  });
};

vjudge.resumeSubmitting = function resumeSubmitting(judgeState, marker, onProgress) {
  setImmediate(async () => {
    try {
      await queueSubmission(() => ensureLogin(false));
      let submissionId = 0;
      for (let attempt = 0; attempt < 20 && !submissionId; attempt++) {
        submissionId = await findNewSubmissionId(marker.problemId, marker.beforeId, marker.expectedLanguage, marker.codeLength);
        if (!submissionId) await delay(500);
      }
      if (!submissionId) {
        throw new Error('Web 重启发生在 POJ 提交阶段，未找到可安全关联的远端 Run ID，请重新评测。');
      }
      await persistRemoteSubmission(judgeState, submissionId, marker.problemId);
      const progress = await pollResult(submissionId, marker.problemId, judgeState, onProgress);
      await onProgress({ taskId: judgeState.task_id, type: 4, progress: progress });
    } catch (error) {
      if (error.code === 'POJ_ABORT') return;
      try {
        await onProgress({ taskId: judgeState.task_id, type: 4, progress: { error: 0, systemMessage: safeVjudgeError(error) } });
      } catch (reportError) {
        console.error('Failed to report recovered POJ VJudge error:', reportError);
      }
    }
  });
};

vjudge.languages = {};
Object.keys(languageLabels).forEach((language, index) => {
  const label = languageLabels[language];
  vjudge.languages[language] = {
    index: index,
    show: label[0],
    highlight: label[1],
    editor: label[1]
  };
  if (['cpp', 'c'].includes(label[1])) vjudge.languages[language].format = label[1];
});
vjudge.fetchProblem = fetchProblem;
vjudge.fetchProblemIds = fetchProblemIds;
vjudge.verifyAccount = async function verifyAccount() {
  await queueSubmission(() => ensureLogin(true));
  return true;
};
vjudge.configured = configured;
vjudge._test = {
  parseLimit: parseLimit,
  parseProblemHtml: parseProblemHtml,
  parseProblemListHtml: parseProblemListHtml,
  parseStatusRows: parseStatusRows,
  verdictType: verdictType,
  submitOnce: submitOnce
};

module.exports = vjudge;
