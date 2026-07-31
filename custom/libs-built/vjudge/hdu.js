const cheerio = require('cheerio');
const childProcess = require('child_process');
const iconv = require('iconv-lite');
const request = require('request');
const requestPromise = require('request-promise');
const TypeORM = require('typeorm');
const credentialContext = require('../../libs/vjudge-credential-context');
const TurndownService = require('/app/custom-node-modules/turndown');
const turndownPluginGfm = require('/app/custom-node-modules/turndown-plugin-gfm');
const tesseract = require('/app/custom-node-modules/tesseract.js');
const tesseractEnglish = require('/app/custom-node-modules/@tesseract.js-data/eng');

const endpoint = (process.env.SYZOJ_WEB_HDU_ENDPOINT || 'https://acm.hdu.edu.cn').replace(/\/+$/, '');
const credentialSessions = new Map();

function currentCredentials() {
  return credentialContext.current('hdu');
}

function currentSession() {
  const credentials = currentCredentials();
  let session = credentialSessions.get(credentials.fingerprint);
  if (!session) {
    const jar = request.jar();
    session = {
      authenticated: false,
      loginPromise: null,
      client: requestPromise.defaults({
        baseUrl: endpoint, jar: jar, gzip: true, timeout: 20000, encoding: null,
        simple: false, resolveWithFullResponse: true, followRedirect: false,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
      })
    };
    credentialSessions.set(credentials.fingerprint, session);
  }
  return session;
}

function providerClient(options) {
  return currentSession().client(options);
}

const languageIds = {
  'hdu.G++': '0',
  'hdu.GCC': '1',
  'hdu.C++': '2',
  'hdu.C': '3',
  'hdu.Pascal': '4',
  'hdu.Java': '5',
  'hdu.CSharp': '6'
};

const languageLabels = {
  'hdu.G++': ['G++', 'cpp'],
  'hdu.GCC': ['GCC', 'c'],
  'hdu.C++': ['C++', 'cpp'],
  'hdu.C': ['C', 'c'],
  'hdu.Pascal': ['Pascal', 'pascal'],
  'hdu.Java': ['Java', 'java'],
  'hdu.CSharp': ['C#', 'csharp']
};

let submissionQueue = Promise.resolve();
let queuedSubmissions = 0;
const recentUserSubmissions = new Map();
const MAX_QUEUED_SUBMISSIONS = 50;
const USER_SUBMISSION_COOLDOWN = 5000;
let captchaWorkerPromise = null;

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**'
});
turndown.use(turndownPluginGfm.gfm);
turndown.addRule('hduPreformattedText', {
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

function decodeBody(body) {
  if (Buffer.isBuffer(body)) return iconv.decode(body, 'gb18030');
  return String(body || '');
}

function configured() {
  try { currentCredentials(); return true; } catch (error) { return false; }
}

async function requestWithRetry(method, uri, options) {
  const maxAttempts = method === 'GET' ? 3 : 1;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const requestOptions = Object.assign({ method: method, uri: uri }, options || {});
      const rawBody = !!requestOptions.rawBody;
      delete requestOptions.rawBody;
      const response = await providerClient(requestOptions);
      if (!rawBody) response.body = decodeBody(response.body);
      if (response.statusCode < 400) return response;

      const error = errorWithCode('HDU 请求失败，HTTP ' + response.statusCode, 'HDU_HTTP');
      error.statusCode = response.statusCode;
      if (![429, 500, 502, 503, 504].includes(response.statusCode) || attempt === maxAttempts) throw error;
      lastError = error;
    } catch (e) {
      lastError = e;
      if (attempt === maxAttempts || (e.statusCode && ![429, 500, 502, 503, 504].includes(e.statusCode))) throw e;
    }
    await delay(500 * attempt);
  }
  throw lastError;
}

function isLoginPage(html) {
  return /<form[^>]+(?:action=["']?\/?userloginex\.php|name=["']formlogin)/i.test(html || '');
}

function isAuthResponse(response) {
  const location = String(response.headers && response.headers.location || '');
  return [401, 403].includes(response.statusCode) || /userloginex\.php|\/login/i.test(location) || isLoginPage(response.body);
}

function isAuthenticatedPage(html) {
  const username = currentCredentials().username;
  return /action=["']?\/?userloginex\.php\?action=logout/i.test(html || '') ||
    (username && String(html || '').toLowerCase().includes(('userstatus.php?user=' + username).toLowerCase()));
}

async function performLogin() {
  if (!configured()) {
    throw new Error('未配置 HDU VJudge 账号。请设置 SYZOJ_WEB_HDU_USERNAME 和 SYZOJ_WEB_HDU_PASSWORD。');
  }

  const credentials = currentCredentials();
  const session = currentSession();
  await requestWithRetry('GET', '/');
  const response = await requestWithRetry('POST', '/userloginex.php?action=login', {
    form: {
      username: credentials.username,
      userpass: credentials.password,
      login: 'Sign In'
    }
  });
  if (/No such user|wrong password|login failed|error/i.test(response.body || '')) {
    throw new Error('HDU 登录失败：用户名或密码错误。');
  }

  const home = await requestWithRetry('GET', '/');
  if (!isAuthenticatedPage(home.body)) throw new Error('HDU 登录失败，登录协议或账号状态可能已经变化。');
  session.authenticated = true;
}

async function ensureLogin(force) {
  if (!configured()) {
    throw new Error('未配置 HDU VJudge 账号。请设置 SYZOJ_WEB_HDU_USERNAME 和 SYZOJ_WEB_HDU_PASSWORD。');
  }
  const session = currentSession();
  if (session.authenticated && !force) return;
  if (!session.loginPromise) {
    if (force) session.authenticated = false;
    session.loginPromise = performLogin().finally(() => {
      session.loginPromise = null;
    });
  }
  await session.loginPromise;
}

function parseTimeMs(text) {
  const match = /([0-9]+(?:\.[0-9]+)?)\s*(ms|s)?/i.exec(String(text || '').replace(/,/g, ''));
  if (!match) return 0;
  return Math.round(parseFloat(match[1]) * (match[2] && match[2].toLowerCase() === 's' ? 1000 : 1));
}

function parseMemoryKiB(text) {
  const match = /([0-9]+(?:\.[0-9]+)?)\s*(k|kb|kib|m|mb|mib)?/i.exec(String(text || '').replace(/,/g, ''));
  if (!match) return 0;
  const value = parseFloat(match[1]);
  return Math.round(value * (match[2] && /^m/i.test(match[2]) ? 1024 : 1));
}

function parseStatusRows(html) {
  const $ = cheerio.load(html || '');
  const rows = [];
  $('table.table_text tr').each((_, row) => {
    const cells = $(row).children('td');
    if (cells.length < 9) return;
    const submissionId = parseInt(cells.eq(0).text().trim());
    const problemId = parseInt(cells.eq(3).text().trim());
    if (!Number.isSafeInteger(submissionId) || !Number.isSafeInteger(problemId)) return;
    rows.push({
      submissionId: submissionId,
      submitTime: cells.eq(1).text().replace(/\s+/g, ' ').trim(),
      status: cells.eq(2).text().replace(/\s+/g, ' ').trim(),
      problemId: problemId,
      time: parseTimeMs(cells.eq(4).text()),
      memory: parseMemoryKiB(cells.eq(5).text()),
      codeLength: parseInt(cells.eq(6).text()) || 0,
      language: cells.eq(7).text().replace(/\s+/g, ' ').trim(),
      author: cells.eq(8).text().replace(/\s+/g, ' ').trim()
    });
  });
  return rows;
}

async function fetchStatusRows(problemId, first) {
  const response = await requestWithRetry('GET', '/status.php', {
    qs: {
      first: first || '',
      pid: problemId,
      user: currentCredentials().username,
      lang: 0,
      status: 0
    }
  });
  if (isAuthResponse(response)) throw errorWithCode('HDU 登录会话已失效。', 'HDU_AUTH');
  return parseStatusRows(response.body);
}

async function latestSubmissionId(problemId) {
  const rows = await fetchStatusRows(problemId);
  return rows.length ? Math.max.apply(Math, rows.map(row => row.submissionId)) : 0;
}

async function findNewSubmissionId(problemId, beforeId, expectedLanguage, codeLength) {
  const username = currentCredentials().username.toLowerCase();
  const rows = await fetchStatusRows(problemId);
  const matches = rows.filter(row => row.submissionId > beforeId &&
    row.author.toLowerCase() === username && row.language === expectedLanguage && row.codeLength === codeLength);
  if (!matches.length) return 0;
  if (matches.length > 1) {
    throw new Error('发现多个符合条件的 HDU Run ID，无法安全关联本地提交。');
  }
  return matches[0].submissionId;
}

function preprocessCaptcha(image, threshold) {
  return new Promise((resolve, reject) => {
    const convert = childProcess.spawn(process.env.SYZOJ_WEB_HDU_CONVERT_PATH || '/usr/bin/convert', [
      'png:-', '-background', 'white', '-alpha', 'remove', '-alpha', 'off',
      '-resize', '800%', '-colorspace', 'Gray', '-threshold', threshold, 'png:-'
    ]);
    const output = [];
    const errors = [];
    const timer = setTimeout(() => convert.kill('SIGKILL'), 10000);
    convert.stdout.on('data', chunk => output.push(chunk));
    convert.stderr.on('data', chunk => errors.push(chunk));
    convert.on('error', reject);
    convert.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(output));
      else reject(new Error('HDU 验证码预处理失败：' + Buffer.concat(errors).toString('utf8').trim()));
    });
    convert.stdin.end(image);
  });
}

async function getCaptchaWorker() {
  if (!captchaWorkerPromise) {
    captchaWorkerPromise = (async () => {
      const worker = await tesseract.createWorker(tesseractEnglish.code, 1, {
        langPath: tesseractEnglish.langPath,
        gzip: tesseractEnglish.gzip,
        cacheMethod: 'none'
      });
      await worker.setParameters({
        tessedit_char_whitelist: '0123456789',
        tessedit_pageseg_mode: tesseract.PSM.SINGLE_WORD
      });
      return worker;
    })().catch(error => {
      captchaWorkerPromise = null;
      throw error;
    });
  }
  return captchaWorkerPromise;
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function closestCaptchaCandidate(outputs, candidates) {
  const scores = new Map();
  for (const output of outputs) {
    if (!output) continue;
    const ranked = candidates.map(candidate => ({ candidate: candidate, distance: editDistance(output, candidate) }))
      .sort((a, b) => a.distance - b.distance);
    if (ranked[0].distance === 0) return ranked[0].candidate;
    if (ranked[0].distance <= 1 && (!ranked[1] || ranked[0].distance < ranked[1].distance)) {
      scores.set(ranked[0].candidate, (scores.get(ranked[0].candidate) || 0) + 1);
    }
  }
  const rankedScores = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
  if (rankedScores.length && (!rankedScores[1] || rankedScores[0][1] > rankedScores[1][1])) return rankedScores[0][0];
  return null;
}

async function recognizeCaptcha(image, candidates) {
  const worker = await getCaptchaWorker();
  const outputs = [];
  for (const threshold of ['70%', '55%', '85%']) {
    const processed = await preprocessCaptcha(image, threshold);
    for (const pageSegmentationMode of [tesseract.PSM.SINGLE_WORD, tesseract.PSM.RAW_LINE]) {
      const result = await worker.recognize(processed, { tessedit_pageseg_mode: pageSegmentationMode });
      const code = String(result.data.text || '').replace(/\D/g, '');
      outputs.push(code);
      if (candidates.includes(code)) return code;
    }
  }
  const corrected = closestCaptchaCandidate(outputs, candidates);
  if (corrected) return corrected;
  throw new Error('无法识别 HDU 提交验证码（识别结果：' + outputs.filter(Boolean).join(', ') +
    '；候选：' + candidates.join(', ') + '）。');
}

let captchaRecognizer = recognizeCaptcha;

async function submitOnce(problemId, language, code, onBeforeSubmit) {
  if (Buffer.byteLength(code, 'utf8') > 64 * 1024) throw new Error('HDU 源代码长度不能超过 64 KiB。');
  const languageId = languageIds[language];
  if (languageId == null) throw new Error('不支持的 HDU 语言：' + language);

  const beforeId = await latestSubmissionId(problemId);
  const codeLength = Buffer.byteLength(code, 'utf8');
  const expectedLanguage = languageLabels[language][0];
  if (onBeforeSubmit) {
    await onBeforeSubmit({
      beforeId: beforeId,
      expectedLanguage: expectedLanguage,
      codeLength: codeLength
    });
  }
  const encodedCode = Buffer.from(encodeURIComponent(code), 'latin1').toString('base64');
  let accepted = false;

  for (let captchaAttempt = 0; captchaAttempt < 3 && !accepted; captchaAttempt++) {
    const page = await requestWithRetry('GET', '/submit.php', { qs: { pid: problemId } });
    if (isAuthResponse(page)) throw errorWithCode('HDU 登录会话已失效。', 'HDU_AUTH');
    const $ = cheerio.load(page.body || '');
    const form = $('form[action*="submit.php"][action*="action=submit"]').first();
    if (!form.length) throw new Error('无法解析 HDU 提交页面，提交协议可能已经变化。');

    const availableLanguages = new Set();
    form.find('select[name="language"] option').each((_, option) => availableLanguages.add($(option).attr('value')));
    if (availableLanguages.size && !availableLanguages.has(languageId)) {
      throw new Error('HDU 当前不支持语言 ' + languageLabels[language][0] + '。');
    }
    const candidates = form.find('select[name="check"] option').map((_, option) => $(option).attr('value')).get()
      .filter(value => /^\d{4}$/.test(value || ''));
    if (!candidates.length) throw new Error('无法解析 HDU 提交验证码选项。');
    const captcha = await requestWithRetry('GET', '/ck.php', { rawBody: true });
    let verificationCode;
    try {
      verificationCode = await captchaRecognizer(captcha.body, candidates);
    } catch (e) {
      if (captchaAttempt < 2) continue;
      throw e;
    }

    const response = await requestWithRetry('POST', '/submit.php?action=submit', {
      form: {
        check: verificationCode,
        _usercode: encodedCode,
        problemid: String(problemId),
        language: languageId
      }
    });
    if (isAuthResponse(response)) throw errorWithCode('HDU 登录会话已失效。', 'HDU_AUTH');
    accepted = [301, 302, 303, 307, 308].includes(response.statusCode) || /Realtime Status/i.test(response.body || '');
    if (!accepted) {
      await delay(500);
      const currentId = await findNewSubmissionId(problemId, beforeId, expectedLanguage, codeLength);
      if (currentId > beforeId) return currentId;
    }
  }
  if (!accepted) throw new Error('HDU 拒绝了提交，验证码或账号状态可能已经变化。');

  for (let attempt = 0; attempt < 20; attempt++) {
    const currentId = await findNewSubmissionId(problemId, beforeId, expectedLanguage, codeLength);
    if (currentId > beforeId) return currentId;
    await delay(500);
  }
  throw new Error('HDU 已接收请求，但未找到对应的 Run ID。');
}

function queueSubmission(action, userId) {
  if (queuedSubmissions >= MAX_QUEUED_SUBMISSIONS) throw errorWithCode('HDU 提交队列已满，请稍后重试。', 'HDU_QUEUE_FULL');
  if (userId) {
    const lastSubmission = recentUserSubmissions.get(Number(userId)) || 0;
    if (Date.now() - lastSubmission < USER_SUBMISSION_COOLDOWN) {
      throw errorWithCode('HDU 提交过于频繁，请稍后重试。', 'HDU_RATE_LIMIT');
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
      throw errorWithCode('本地评测任务已取消或被替换。', 'HDU_ABORT');
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
    throw errorWithCode('本地评测任务已取消或被替换。', 'HDU_ABORT');
  }
}

async function persistRemoteSubmission(judgeState, submissionId, problemId) {
  await persistVjudgeMarker(judgeState, {
    provider: 'hdu',
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
      } catch (e) {
        if (e.code !== 'HDU_AUTH' || attempt > 0) throw e;
        await ensureLogin(true);
      }
    }
  }, userId);
}

function safeVjudgeError(error) {
  const message = String(error && error.message || error || '未知错误');
  if (/未配置 HDU VJudge 账号|源代码长度|不支持的 HDU 语言|默认禁止用于比赛|远程题号不正确|提交过于频繁|提交队列已满/.test(message)) {
    return message.slice(0, 240);
  }
  return 'HDU 远程评测暂时不可用，请稍后重试。';
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
    'Restricted Function': 8,
    'System Error': 9,
    'Out Of Contest Time': 9
  };
  return types[status] || 9;
}

async function fetchCompileError(submissionId) {
  const response = await requestWithRetry('GET', '/viewerror.php', { qs: { rid: submissionId } });
  if (isAuthResponse(response)) throw errorWithCode('HDU 登录会话已失效。', 'HDU_AUTH');
  const $ = cheerio.load(response.body || '');
  return $('pre').first().text().trim().slice(0, 12000) || 'HDU Compile Error';
}

async function pollResult(submissionId, problemId, judgeState, onProgress) {
  const pollLimit = Math.max(1, Math.min(300, parseInt(process.env.SYZOJ_WEB_HDU_POLL_LIMIT || '120')));
  let progressSent = false;

  for (let attempt = 0; attempt < pollLimit; attempt++) {
    await delay(3000);
    let rows;
    try {
      rows = await fetchStatusRows(problemId, submissionId + 1);
    } catch (e) {
      if (e.code !== 'HDU_AUTH') throw e;
      await queueSubmission(() => ensureLogin(true));
      continue;
    }
    const row = rows.find(item => item.submissionId === submissionId);
    if (!row || /^(Queuing|Compiling|Running|Judging)$/i.test(row.status)) {
      if (!progressSent) {
        progressSent = true;
        const accepted = await onProgress({
          taskId: judgeState.task_id,
          type: 3,
          progress: { judge: { subtasks: [{ score: 0, cases: [{ status: 1 }] }] } }
        });
        if (accepted === false) throw errorWithCode('本地评测任务已取消或被替换。', 'HDU_ABORT');
      }
      continue;
    }

    if (/^Compilation Error$/i.test(row.status)) {
      let message;
      try {
        message = await fetchCompileError(submissionId);
      } catch (e) {
        if (e.code !== 'HDU_AUTH') throw e;
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
              systemMessage: 'HDU Run ID: ' + submissionId
            }
          }]
        }]
      }
    };
  }
  throw new Error('等待 HDU 评测结果超时。');
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
      } catch (e) {
        node.removeAttr(name);
      }
    }
  });
}

function htmlToMarkdown(html) {
  const math = [];
  let protectedHtml = String(html || '');
  const protect = pattern => {
    protectedHtml = protectedHtml.replace(pattern, value => {
      const token = 'HDUMATHPLACEHOLDER' + math.length + 'TOKEN';
      math.push(value);
      return token;
    });
  };
  protect(/\$\$[\s\S]*?\$\$/g);
  protect(/\\\[[\s\S]*?\\\]/g);
  protect(/\\\([\s\S]*?\\\)/g);
  protect(/\$(?!\$)(?:\\.|[^$\n])+\$/g);

  let markdown = turndown.turndown(protectedHtml);
  math.forEach((value, index) => {
    markdown = markdown.split('HDUMATHPLACEHOLDER' + index + 'TOKEN').join(value);
  });
  return markdown.replace(/\n{3,}/g, '\n\n').trim();
}

function parseLimitPair(text, kind) {
  const label = kind === 'time' ? 'Time Limit' : 'Memory Limit';
  const match = new RegExp(label + ':\\s*(\\d+)(?:\\s*\\/\\s*(\\d+))?\\s*(MS|S|K|KB|M|MB)', 'i').exec(text || '');
  if (!match) return kind === 'time' ? 1000 : 64;
  const value = Math.max(parseInt(match[1]), parseInt(match[2] || match[1]));
  const unit = match[3].toUpperCase();
  if (kind === 'time') return unit === 'S' ? value * 1000 : value;
  if (unit === 'M' || unit === 'MB') return value;
  return Math.max(1, Math.ceil(value / 1024));
}

function parseProblemHtml(html, remoteId) {
  const $ = cheerio.load(html || '', { decodeEntities: false });
  const title = $('h1').filter((_, element) => /color\s*:\s*#?1A5CC8/i.test($(element).attr('style') || '')).first().text().trim();
  if (!title || !$('.panel_title').length) throw new Error('HDU 题目 #' + remoteId + ' 不存在或题面不可见。');

  const sections = {};
  $('.panel_title').each((_, heading) => {
    const name = $(heading).text().replace(/\s+/g, ' ').trim().toLowerCase();
    const content = $(heading).next('.panel_content').first();
    if (!content.length) return;
    sanitizeContent($, content);
    sections[name] = htmlToMarkdown(content.html());
  });

  const description = sections['problem description'] || '';
  const inputFormat = sections.input || '';
  const outputFormat = sections.output || '';
  const samples = [];
  if (sections['sample input']) samples.push('### Input\n\n' + sections['sample input']);
  if (sections['sample output']) samples.push('### Output\n\n' + sections['sample output']);
  const limitText = $('span').filter((_, element) => /Time Limit:/i.test($(element).text())).first().text().replace(/\s+/g, ' ').trim();
  const sourceUrl = endpoint + '/showproblem.php?pid=' + remoteId;
  const metadata = [];
  if (sections.author) metadata.push('Author: ' + sections.author);
  if (sections.source) metadata.push('Source: ' + sections.source);
  if (limitText) metadata.push(limitText);
  metadata.push('[查看 HDU 原题](' + sourceUrl + ')');

  return {
    title: title,
    description: description,
    inputFormat: inputFormat,
    outputFormat: outputFormat,
    example: samples.join('\n\n'),
    hint: metadata.join('\n\n'),
    timeLimit: parseLimitPair(limitText, 'time'),
    memoryLimit: parseLimitPair(limitText, 'memory')
  };
}

function parseProblemListHtml(html) {
  const problemIds = new Set();
  const pattern = /\bp\(\s*\d+\s*,\s*(\d+)\s*,/g;
  let match;
  while ((match = pattern.exec(html || ''))) problemIds.add(parseInt(match[1]));

  let volumeCount = 1;
  const volumePattern = /listproblem\.php\?vol=(\d+)/g;
  while ((match = volumePattern.exec(html || ''))) volumeCount = Math.max(volumeCount, parseInt(match[1]));
  return { problemIds: Array.from(problemIds), volumeCount: volumeCount };
}

async function fetchProblemIds() {
  const firstResponse = await requestWithRetry('GET', '/listproblem.php', { qs: { vol: 1 } });
  if (firstResponse.statusCode !== 200) throw new Error('无法打开 HDU 题库。');
  const firstVolume = parseProblemListHtml(firstResponse.body);
  const problemIds = new Set(firstVolume.problemIds);

  for (let volume = 2; volume <= firstVolume.volumeCount; volume++) {
    const response = await requestWithRetry('GET', '/listproblem.php', { qs: { vol: volume } });
    if (response.statusCode !== 200) throw new Error('无法打开 HDU 题库第 ' + volume + ' 卷。');
    for (const problemId of parseProblemListHtml(response.body).problemIds) problemIds.add(problemId);
    await delay(200);
  }
  return Array.from(problemIds).sort((a, b) => a - b);
}

async function fetchProblem(remoteId) {
  const id = parseInt(remoteId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('HDU 题号不正确。');
  await ensureLogin();
  let response = await requestWithRetry('GET', '/showproblem.php', { qs: { pid: id } });
  if (isAuthResponse(response)) {
    await queueSubmission(() => ensureLogin(true));
    response = await requestWithRetry('GET', '/showproblem.php', { qs: { pid: id } });
  }
  if (response.statusCode !== 200) throw new Error('HDU 题目 #' + id + ' 不存在或不可访问。');
  return parseProblemHtml(response.body, id);
}

async function runVjudge(judgeState, problem, onProgress) {
  let finished = false;
  try {
    const problemId = parseInt(problem.vjudge_config);
    if (!Number.isSafeInteger(problemId) || problemId <= 0) throw new Error('HDU 远程题号不正确。');
    if (judgeState.type === 1 && process.env.SYZOJ_WEB_HDU_ALLOW_CONTESTS !== 'true') {
      throw new Error('HDU VJudge 默认禁止用于比赛；确认上游账号和代码可见性策略后才可启用。');
    }

    const submissionId = await vjudge.submit(problemId, judgeState.language, judgeState.code, {
      localSubmission: judgeState,
      onBeforeSubmit: metadata => persistVjudgeMarker(judgeState, {
        provider: 'hdu',
        phase: 'submitting',
        problemId: problemId,
        beforeId: metadata.beforeId,
        expectedLanguage: metadata.expectedLanguage,
        codeLength: metadata.codeLength
      })
    });
    await persistRemoteSubmission(judgeState, submissionId, problemId);
    const progress = await vjudge.pollSubmission(submissionId, { remoteProblemId: problemId, localSubmission: judgeState, onProgress });
    await onProgress({ taskId: judgeState.task_id, type: 4, progress: progress });
    finished = true;
  } catch (e) {
    if (e.code === 'HDU_ABORT') return;
    console.error('HDU VJudge failed:', e && e.stack ? e.stack : e);
    if (!finished) {
      try {
        await onProgress({
          taskId: judgeState.task_id,
          type: 4,
          progress: { error: 0, systemMessage: safeVjudgeError(e) }
        });
      } catch (reportError) {
        console.error('Failed to report HDU VJudge error:', reportError);
      }
    }
  }
}

function vjudge(judgeState, problem, onProgress) {
  setImmediate(() => {
    runVjudge(judgeState, problem, onProgress).catch(e => console.error('Unhandled HDU VJudge error:', e));
  });
}

vjudge.resume = function resume(judgeState, submissionId, problemId, onProgress) {
  setImmediate(() => {
    pollResult(submissionId, problemId, judgeState, onProgress)
      .then(progress => onProgress({ taskId: judgeState.task_id, type: 4, progress: progress }))
      .catch(async e => {
        if (e.code === 'HDU_ABORT') return;
        try {
          await onProgress({
            taskId: judgeState.task_id,
            type: 4,
            progress: { error: 0, systemMessage: safeVjudgeError(e) }
          });
        } catch (reportError) {
          console.error('Failed to report resumed HDU VJudge error:', reportError);
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
        submissionId = await findNewSubmissionId(
          marker.problemId,
          marker.beforeId,
          marker.expectedLanguage,
          marker.codeLength
        );
        if (!submissionId) await delay(500);
      }
      if (!submissionId) {
        throw new Error('Web 重启发生在 HDU 提交阶段，未找到可安全关联的远端 Run ID，请重新评测。');
      }
      await persistRemoteSubmission(judgeState, submissionId, marker.problemId);
      const progress = await pollResult(submissionId, marker.problemId, judgeState, onProgress);
      await onProgress({ taskId: judgeState.task_id, type: 4, progress: progress });
    } catch (e) {
      if (e.code === 'HDU_ABORT') return;
      try {
        await onProgress({
          taskId: judgeState.task_id,
          type: 4,
          progress: { error: 0, systemMessage: safeVjudgeError(e) }
        });
      } catch (reportError) {
        console.error('Failed to report recovered HDU VJudge error:', reportError);
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
vjudge.checkAccount = vjudge.verifyAccount;
vjudge.withCredential = function withCredential(reference, operation, options) {
  return credentialContext.run('hdu', reference, operation, options);
};
vjudge.fetchProblemList = async function fetchProblemList(cursor) {
  const after = Number.parseInt(cursor, 10) || 0;
  const ids = await fetchProblemIds();
  const items = ids.filter(id => Number(id) > after).slice(0, 100).map(id => ({ remote_id: String(id) }));
  return { items: items, next_cursor: items.length === 100 ? items[items.length - 1].remote_id : null };
};
vjudge.searchProblems = async function searchProblems(query, cursor) {
  const page = await vjudge.fetchProblemList(cursor);
  const needle = String(query || '').trim().toLowerCase();
  return needle ? { ...page, items: page.items.filter(item => item.remote_id.toLowerCase().includes(needle)) } : page;
};
vjudge.submit = async function submit(remoteProblem, language, source, options) {
  const judgeState = options && options.localSubmission;
  const problemId = Number.parseInt(remoteProblem && (remoteProblem.remote_id || remoteProblem.id) || remoteProblem, 10);
  if (!judgeState || typeof judgeState !== 'object') {
    throw errorWithCode('远程提交必须关联本地评测任务。', 'HDU_LOCAL_SUBMISSION_REQUIRED');
  }
  if (!Number.isSafeInteger(problemId) || problemId < 1) throw errorWithCode('HDU 远程题号不正确。', 'HDU_PROBLEM');
  return submitRemote(problemId, language, String(source || ''), judgeState.user_id, options.onBeforeSubmit);
};
vjudge.pollSubmission = async function pollSubmission(remoteSubmissionId, options) {
  const judgeState = options && options.localSubmission;
  const problemId = Number.parseInt(options && options.remoteProblemId, 10);
  if (!judgeState || typeof judgeState !== 'object') {
    throw errorWithCode('远程同步必须关联本地评测任务。', 'HDU_LOCAL_SUBMISSION_REQUIRED');
  }
  if (!Number.isSafeInteger(problemId) || problemId < 1) throw errorWithCode('HDU 远程题号不正确。', 'HDU_PROBLEM');
  return pollResult(Number(remoteSubmissionId), problemId, judgeState, options.onProgress);
};
vjudge.normalizeResult = function normalizeResult(rawResult) {
  const raw = rawResult && typeof rawResult === 'object' ? rawResult : {};
  return { status: String(raw.statusString || raw.status || 'Pending'), verdict: Number(raw.type || 0), score: Number(raw.score || 0), time_ms: Number(raw.time || 0), memory_kib: Number(raw.memory || 0), terminal: !!raw.finished };
};
vjudge.configured = configured;
vjudge._test = {
  decodeBody: decodeBody,
  parseProblemHtml: parseProblemHtml,
  parseProblemListHtml: parseProblemListHtml,
  parseStatusRows: parseStatusRows,
  verdictType: verdictType,
  closestCaptchaCandidate: closestCaptchaCandidate,
  recognizeCaptcha: recognizeCaptcha,
  submitOnce: submitOnce,
  setCaptchaRecognizer: function setCaptchaRecognizer(recognizer) {
    captchaRecognizer = recognizer || recognizeCaptcha;
  }
};

module.exports = vjudge;
