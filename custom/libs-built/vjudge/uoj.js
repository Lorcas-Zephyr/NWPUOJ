const crypto = require('crypto');
const cheerio = require('cheerio');
const request = require('request');
const requestPromise = require('request-promise');
const TypeORM = require('typeorm');
const TurndownService = require('/app/custom-node-modules/turndown');
const turndownPluginGfm = require('/app/custom-node-modules/turndown-plugin-gfm');

const endpoint = (process.env.SYZOJ_WEB_UOJ_ENDPOINT || 'https://uoj.ac').replace(/\/+$/, '');
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

const languageNames = {
  'uoj.C++03': 'C++',
  'uoj.C++11': 'C++11',
  'uoj.C++14': 'C++14',
  'uoj.C++17': 'C++17',
  'uoj.C++20': 'C++20',
  'uoj.C': 'C',
  'uoj.Python3': 'Python3',
  'uoj.Python2.7': 'Python2.7',
  'uoj.Java8': 'Java8',
  'uoj.Java11': 'Java11',
  'uoj.Java17': 'Java17',
  'uoj.Pascal': 'Pascal'
};

const languageLabels = {
  'uoj.C++03': ['C++ 03', 'cpp'],
  'uoj.C++11': ['C++ 11', 'cpp'],
  'uoj.C++14': ['C++ 14', 'cpp'],
  'uoj.C++17': ['C++ 17', 'cpp'],
  'uoj.C++20': ['C++ 20', 'cpp'],
  'uoj.C': ['C', 'c'],
  'uoj.Python3': ['Python 3', 'python'],
  'uoj.Python2.7': ['Python 2.7', 'python'],
  'uoj.Java8': ['Java 8', 'java'],
  'uoj.Java11': ['Java 11', 'java'],
  'uoj.Java17': ['Java 17', 'java'],
  'uoj.Pascal': ['Pascal', 'pascal']
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
turndown.addRule('uojPreformattedText', {
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
  return !!(process.env.SYZOJ_WEB_UOJ_USERNAME && process.env.SYZOJ_WEB_UOJ_PASSWORD);
}

async function requestWithRetry(method, uri, options) {
  const maxAttempts = method === 'GET' ? 3 : 1;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await client(Object.assign({ method: method, uri: uri }, options || {}));
      if (response.statusCode < 400) return response;

      if ([401, 403].includes(response.statusCode)) {
        throw errorWithCode('UOJ 登录会话已失效。', 'UOJ_AUTH');
      }

      const error = errorWithCode('UOJ 请求失败，HTTP ' + response.statusCode, 'UOJ_HTTP');
      error.statusCode = response.statusCode;
      if (![429, 500, 502, 503, 504].includes(response.statusCode) || attempt === maxAttempts) {
        throw error;
      }
      lastError = error;
    } catch (e) {
      lastError = e;
      if (e.code === 'UOJ_AUTH') throw e;
      if (attempt === maxAttempts || (e.statusCode && ![429, 500, 502, 503, 504].includes(e.statusCode))) {
        throw e;
      }
    }
    await delay(500 * attempt);
  }

  throw lastError;
}

function parseCsrfToken(html) {
  const $ = cheerio.load(html || '');
  const inputToken = $('input[name="_token"]').first().attr('value');
  if (inputToken) return inputToken;
  const scriptToken = /_token\s*:\s*["']([^"']+)["']/.exec(html || '');
  return scriptToken && scriptToken[1];
}

function parsePasswordSalt(html) {
  const match = /md5\([^,]+,\s*["']([^"']+)["']\)/.exec(html || '');
  return match && match[1];
}

function hashPassword(password, salt) {
  return crypto.createHmac('md5', salt).update(password, 'utf8').digest('hex');
}

function isLoginPage(html) {
  return /<form[^>]+id=["']form-login["']/.test(html || '');
}

function isAuthResponse(response) {
  const location = String(response.headers && response.headers.location || '');
  return [401, 403].includes(response.statusCode) || /\/login(?:[/?#]|$)/.test(location) || isLoginPage(response.body);
}

async function performLogin() {
  if (!configured()) {
    throw new Error('未配置 UOJ VJudge 账号。请设置 SYZOJ_WEB_UOJ_USERNAME 和 SYZOJ_WEB_UOJ_PASSWORD。');
  }

  const page = await requestWithRetry('GET', '/login');
  if ([301, 302, 303, 307, 308].includes(page.statusCode)) {
    authenticated = true;
    return;
  }

  const token = parseCsrfToken(page.body);
  const salt = parsePasswordSalt(page.body);
  if (!token || !salt) throw new Error('无法解析 UOJ 登录页面，登录协议可能已经变化。');

  const response = await requestWithRetry('POST', '/login', {
    form: {
      _token: token,
      login: '',
      username: process.env.SYZOJ_WEB_UOJ_USERNAME,
      password: hashPassword(process.env.SYZOJ_WEB_UOJ_PASSWORD, salt)
    }
  });
  const result = String(response.body || '').trim();
  if (result !== 'ok') {
    const reasons = {
      failed: '用户名或密码错误',
      expired: '登录页面已过期',
      'account:banned': '账号已被封禁',
      'account:expired': '账号已过期'
    };
    throw new Error('UOJ 登录失败：' + (reasons[result] || result || '未知错误'));
  }
  authenticated = true;
}

async function ensureLogin(force) {
  if (authenticated && !force) return;
  if (!loginPromise) {
    if (force) authenticated = false;
    loginPromise = performLogin().finally(() => {
      loginPromise = null;
    });
  }
  await loginPromise;
}

function supportedLanguagesFromPage(html) {
  const normalized = String(html || '').replace(/\\"/g, '"').replace(/\\\//g, '/');
  const result = new Set();
  const pattern = /<option[^>]*value=["']([^"']+)["']/g;
  let match;
  while ((match = pattern.exec(normalized))) result.add(match[1]);
  return result;
}

function parseSubmissionIds(html) {
  const $ = cheerio.load(html || '');
  const ids = [];
  $('a[href]').each((_, element) => {
    const match = /^\/submission\/(\d+)$/.exec($(element).attr('href') || '');
    if (match) ids.push(parseInt(match[1]));
  });
  return ids;
}

async function latestSubmissionId(problemId) {
  const response = await requestWithRetry('GET', '/submissions', {
    qs: {
      problem_id: problemId,
      submitter: process.env.SYZOJ_WEB_UOJ_USERNAME
    }
  });
  if (isAuthResponse(response)) throw errorWithCode('UOJ 登录会话已失效。', 'UOJ_AUTH');
  const ids = parseSubmissionIds(response.body);
  return ids.length ? Math.max.apply(Math, ids) : 0;
}

async function submitOnce(problemId, language, code, onBeforeSubmit) {
  if (Buffer.byteLength(code, 'utf8') > 50 * 1024) {
    throw new Error('UOJ 源代码长度不能超过 50 KiB。');
  }
  const beforeId = await latestSubmissionId(problemId);
  const page = await requestWithRetry('GET', '/problem/' + problemId);
  if (page.statusCode !== 200) throw new Error('无法打开 UOJ 题目 #' + problemId + '。');

  const token = parseCsrfToken(page.body);
  if (!token) throw new Error('无法从 UOJ 题目页面读取 CSRF Token。');
  const upstreamLanguage = languageNames[language];
  if (!upstreamLanguage) throw new Error('不支持的 UOJ 语言：' + language);

  const availableLanguages = supportedLanguagesFromPage(page.body);
  if (availableLanguages.size && !availableLanguages.has(upstreamLanguage)) {
    throw new Error('UOJ 题目 #' + problemId + ' 不支持语言 ' + upstreamLanguage + '。');
  }
  if (onBeforeSubmit) {
    await onBeforeSubmit({ beforeId, expectedLanguage: upstreamLanguage, codeLength: Buffer.byteLength(code, 'utf8') });
  }

  const response = await requestWithRetry('POST', '/problem/' + problemId, {
    form: {
      _token: token,
      answer_answer_language: upstreamLanguage,
      answer_answer_upload_type: 'editor',
      answer_answer_editor: code,
      'submit-answer': 'answer'
    }
  });

  if (isAuthResponse(response)) {
    throw errorWithCode('UOJ 登录会话已失效。', 'UOJ_AUTH');
  }
  if (![301, 302, 303].includes(response.statusCode) && !String(response.body || '').includes('我的提交记录')) {
    throw new Error('UOJ 拒绝了提交，题目表单或账号状态可能已经变化。');
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    let currentId;
    try {
      currentId = await latestSubmissionId(problemId);
    } catch (e) {
      if (e.code !== 'UOJ_AUTH') throw e;
      await ensureLogin(true);
      continue;
    }
    if (currentId > beforeId) return currentId;
    await delay(300);
  }
  throw new Error('UOJ 已接收请求，但未找到对应的提交记录。');
}

function queueSubmission(action, userId) {
  if (queuedSubmissions >= MAX_QUEUED_SUBMISSIONS) throw errorWithCode('UOJ 提交队列已满，请稍后重试。', 'UOJ_QUEUE_FULL');
  if (userId) {
    const lastSubmission = recentUserSubmissions.get(Number(userId)) || 0;
    if (Date.now() - lastSubmission < USER_SUBMISSION_COOLDOWN) {
      throw errorWithCode('UOJ 提交过于频繁，请稍后重试。', 'UOJ_RATE_LIMIT');
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
      throw errorWithCode('本地评测任务已取消或被替换。', 'UOJ_ABORT');
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
    throw errorWithCode('本地评测任务已取消或被替换。', 'UOJ_ABORT');
  }
}

async function persistRemoteSubmission(judgeState, submissionId, problemId) {
  return persistVjudgeMarker(judgeState, {
    provider: 'uoj', phase: 'judging', submissionId, problemId
  });
}

async function submitRemote(problemId, language, code, userId, onBeforeSubmit) {
  await ensureLogin(false);
  return queueSubmission(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await submitOnce(problemId, language, code, onBeforeSubmit);
      } catch (e) {
        if (e.code !== 'UOJ_AUTH' || attempt > 0) throw e;
        await ensureLogin(true);
      }
    }
  }, userId);
}

function safeVjudgeError(error) {
  const message = String(error && error.message || error || '未知错误');
  if (/未配置 UOJ VJudge 账号|源代码长度|不支持的 UOJ 语言|默认禁止用于比赛|远程题号不正确|提交过于频繁|提交队列已满/.test(message)) {
    return message.slice(0, 240);
  }
  return 'UOJ 远程评测暂时不可用，请稍后重试。';
}

function parseTimeMs(text) {
  const match = /([0-9]+(?:\.[0-9]+)?)\s*(ms|s)?/i.exec(String(text || '').replace(/,/g, ''));
  if (!match) return 0;
  return Math.round(parseFloat(match[1]) * (match[2] && match[2].toLowerCase() === 's' ? 1000 : 1));
}

function parseMemoryKiB(text) {
  const match = /([0-9]+(?:\.[0-9]+)?)\s*(kb|kib|mb|mib)?/i.exec(String(text || '').replace(/,/g, ''));
  if (!match) return 0;
  const value = parseFloat(match[1]);
  return Math.round(value * (match[2] && /^m/i.test(match[2]) ? 1024 : 1));
}

function resultTypeForText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (/^(Accepted|Extra Test Passed)$/i.test(text)) return 1;
  if (/^(Partially Correct|Acceptable Answer)$/i.test(text)) return 3;
  if (/Memory Limit Exceeded/i.test(text)) return 4;
  if (/Time Limit Exceeded/i.test(text)) return 5;
  if (/Output Limit Exceeded/i.test(text)) return 6;
  if (/File Error/i.test(text)) return 7;
  if (/Runtime Error|Dangerous Syscalls/i.test(text)) return 8;
  if (/Judg(?:e)?ment Failed/i.test(text)) return 9;
  if (/Invalid Interaction/i.test(text)) return 10;
  return 2;
}

function parseDetailHeader($, title) {
  const header = title.closest('.card-header, .panel-heading').first();
  const columns = header.find('.row').first().children('div');
  const texts = [];
  if (columns.length) {
    columns.each((_, element) => texts.push($(element).text().replace(/\s+/g, ' ').trim()));
  } else {
    texts.push(header.text().replace(/\s+/g, ' ').trim());
  }

  let score = null;
  let time = null;
  let memory = null;
  const info = [];
  for (const text of texts) {
    let match;
    if (!text || /^(?:Subtask|Test)\s*#\d+\s*:|^Extra Test\s*:/i.test(text)) continue;
    if ((match = /^score\s*:\s*([+-]?\d+(?:\.\d+)?)/i.exec(text))) {
      score = parseFloat(match[1]);
    } else if (/^time\s*:/i.test(text)) {
      time = parseTimeMs(text);
    } else if (/^memory\s*:/i.test(text)) {
      memory = parseMemoryKiB(text);
    } else {
      info.push(text);
    }
  }
  return { score: score, time: time, memory: memory, info: info.join(' ').trim() };
}

function parseVisibleTestDetails($, card) {
  const details = {};
  card.find('h4').each((_, element) => {
    const heading = $(element).text().replace(/\s+/g, ' ').trim().toLowerCase();
    const content = $(element).next('pre').first();
    if (!content.length) return;
    let key = null;
    if (/^(input|输入)\s*:$/.test(heading)) key = 'input';
    else if (/^(output|输出)\s*:$/.test(heading)) key = 'output';
    else if (/^(result|结果)\s*:$/.test(heading)) key = 'result';
    if (!key) return;
    const text = content.text().replace(/^\n+|\n+$/g, '');
    details[key] = text.length > 16384 ? text.slice(0, 16384) + '\n[内容已截断]' : text;
  });
  return details;
}

function parseJudgementDetails(html, totalScore) {
  const $ = cheerio.load(html || '');
  const root = $('#details_details_accordion').first();
  if (!root.length) return [];

  const subtasks = [];
  const subtaskByNumber = new Map();
  root.find('.card-title, .panel-title').each((_, element) => {
    const title = $(element);
    const match = /^Subtask\s*#(\d+)\s*:/i.exec(title.text().trim());
    if (!match || subtaskByNumber.has(match[1])) return;
    const fields = parseDetailHeader($, title);
    const subtask = {
      number: parseInt(match[1]),
      score: fields.score,
      info: fields.info,
      resultStatus: fields.info || null,
      resultType: !fields.info || /^Skipped$/i.test(fields.info) ? null : resultTypeForText(fields.info),
      cases: []
    };
    subtaskByNumber.set(match[1], subtask);
    subtasks.push(subtask);
  });

  const ungroupedCases = [];
  root.find('.card-title, .panel-title').each((_, element) => {
    const title = $(element);
    const match = /^(?:Test\s*#(\d+)|Extra Test)\s*:/i.exec(title.text().trim());
    if (!match) return;
    const fields = parseDetailHeader($, title);
    const card = title.closest('.card, .panel').first();
    const subtaskContainer = card.parents('[id*="_collapse_subtask_"][id$="_accordion"]').first();
    const subtaskMatch = /_collapse_subtask_(\d+)_accordion$/.exec(subtaskContainer.attr('id') || '');
    const info = fields.info || (card.hasClass('card-uoj-accepted') ? 'Accepted' : 'Wrong Answer');
    const type = resultTypeForText(info);
    const skipped = /^Skipped$/i.test(info);
    const testNumber = match[1] ? parseInt(match[1]) : 0;
    const visibleDetails = parseVisibleTestDetails($, card);
    const testLabel = testNumber ? 'Test #' + testNumber : 'Extra Test';
    const currentCase = {
      status: skipped ? 4 : 2,
      result: {
        type: type,
        time: fields.time,
        memory: fields.memory,
        scoringRate: fields.score == null ? (type === 1 ? 1 : 0) : fields.score / 100,
        systemMessage: 'UOJ ' + testLabel + ': ' + info,
        input: visibleDetails.input == null ? undefined : {
          name: 'UOJ ' + testLabel + ' input',
          content: visibleDetails.input,
          remote: true
        },
        userOutput: visibleDetails.output,
        spjMessage: visibleDetails.result
      },
      uojScore: fields.score
    };
    if (subtaskMatch && subtaskByNumber.has(subtaskMatch[1])) {
      subtaskByNumber.get(subtaskMatch[1]).cases.push(currentCase);
    } else {
      ungroupedCases.push(currentCase);
    }
  });

  const visibleSubtasks = subtasks.filter(subtask => {
    if (subtask.cases.length) return true;
    if (!subtask.info) return false;
    if (/^Skipped$/i.test(subtask.info)) {
      subtask.cases.push({ status: 4 });
    } else {
      subtask.cases.push({
        status: 2,
        result: {
          type: subtask.resultType,
          time: null,
          memory: null,
          scoringRate: Number.isFinite(subtask.score) ? subtask.score / 100 : 0,
          systemMessage: 'UOJ Subtask #' + subtask.number + ': ' + subtask.info
        }
      });
    }
    return true;
  });
  if (ungroupedCases.length) {
    visibleSubtasks.push({
      number: 1,
      score: totalScore,
      info: '',
      resultStatus: null,
      resultType: null,
      cases: ungroupedCases
    });
  }
  if (!visibleSubtasks.length) return [];

  for (const subtask of visibleSubtasks) {
    if (subtask.score == null) {
      const caseScores = subtask.cases.map(currentCase => currentCase.uojScore).filter(Number.isFinite);
      subtask.score = caseScores.length ? caseScores.reduce((sum, score) => sum + score, 0) : 0;
    }
    for (const currentCase of subtask.cases) delete currentCase.uojScore;
    delete subtask.number;
    delete subtask.info;
  }

  const parsedScore = visibleSubtasks.reduce((sum, subtask) => sum + subtask.score, 0);
  if (Number.isFinite(totalScore) && Math.abs(parsedScore - totalScore) > 0.0001) {
    visibleSubtasks[visibleSubtasks.length - 1].score += totalScore - parsedScore;
  }
  return visibleSubtasks;
}

function aggregateTypeFromSubtasks(subtasks) {
  for (const subtask of subtasks || []) {
    if (subtask.resultType != null && subtask.resultType !== 1) return subtask.resultType;
    for (const currentCase of subtask.cases || []) {
      if (currentCase.result && currentCase.result.type !== 1) return currentCase.result.type;
    }
  }
  return null;
}

function buildFinishedProgress(result) {
  const hasDetailedSubtasks = result.subtasks && result.subtasks.length;
  const subtasks = hasDetailedSubtasks ? result.subtasks : [{
    score: result.score,
    cases: [{
      status: 2,
      result: {
        type: result.type,
        time: result.time,
        memory: result.memory,
        scoringRate: result.score / 100,
        systemMessage: result.message
      }
    }]
  }];
  const firstCase = subtasks[0] && subtasks[0].cases && subtasks[0].cases[0];
  if (hasDetailedSubtasks && firstCase && firstCase.result) {
    firstCase.result.systemMessage += '\n' + result.message;
  }
  return {
    compile: { status: 2 },
    judge: { subtasks: subtasks },
    vjudgeSummary: {
      type: result.type,
      score: result.score,
      time: result.time,
      memory: result.memory
    }
  };
}

function parseFinalResult(html, submissionId) {
  const $ = cheerio.load(html || '');
  const scoreLink = $('.uoj-score').first();
  const submissionRow = $('a[href="/submission/' + submissionId + '"]').first().closest('tr');
  const resultCell = submissionRow.children('td').eq(3);
  const resultText = resultCell.text().replace(/\s+/g, ' ').trim();
  if (!scoreLink.length && /^Compile Error$/i.test(resultText)) {
    let compilerMessage = '';
    $('.panel-title, .card-title').each((_, title) => {
      if (/^(详细|details)$/i.test($(title).text().trim()) && !compilerMessage) {
        compilerMessage = $(title).closest('.panel, .card').find('pre').first().text().trim();
      }
    });
    return {
      compileError: true,
      message: compilerMessage.slice(0, 12000) || 'UOJ Compile Error'
    };
  }
  if (!scoreLink.length) {
    if (/^(Wrong Answer|Memory Limit Exceeded|Time Limit Exceeded|Output Limit Exceeded|File Error|Runtime Error|Dangerous Syscalls|Judg(?:e)?ment Failed|Invalid Interaction)$/i.test(resultText)) {
      return {
        compileError: false,
        score: 0,
        time: parseTimeMs(resultCell.next().text()),
        memory: parseMemoryKiB(resultCell.next().next().text()),
        type: resultTypeForText(resultText),
        subtasks: parseJudgementDetails(html, 0),
        message: endpoint + '/submission/' + submissionId
      };
    }
    throw new Error('无法解析 UOJ 提交 #' + submissionId + ' 的最终结果。');
  }

  const score = parseFloat(scoreLink.text());
  if (!Number.isFinite(score)) throw new Error('UOJ 提交 #' + submissionId + ' 的分数格式不正确。');
  const scoreCell = scoreLink.closest('td');
  const time = parseTimeMs(scoreCell.next().text());
  const memory = parseMemoryKiB(scoreCell.next().next().text());
  const subtasks = parseJudgementDetails(html, score);

  let type = 2;
  if (score === 100) type = 1;
  else if (score > 0) type = 3;
  else type = aggregateTypeFromSubtasks(subtasks) || 2;

  return {
    compileError: false,
    score: Math.max(0, Math.min(100, score)),
    time: time,
    memory: memory,
    type: type,
    subtasks: subtasks,
    message: endpoint + '/submission/' + submissionId
  };
}

async function fetchSubmissionStatus(submissionId) {
  const headers = {
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'application/json, text/javascript, */*; q=0.01'
  };
  let response = await requestWithRetry('GET', '/submission-status-details', {
    qs: { 'get[]': submissionId },
    headers: headers
  });
  if (isAuthResponse(response)) throw errorWithCode('UOJ 登录会话已失效。', 'UOJ_AUTH');

  try {
    const payload = JSON.parse(response.body);
    const status = Array.isArray(payload) ? payload[0] : payload;
    if (status && typeof status.judged === 'boolean') return status;
  } catch (e) {}

  response = await requestWithRetry('GET', '/submission/' + submissionId, {
    qs: { get: 'status-details' },
    headers: headers
  });
  if (isAuthResponse(response)) throw errorWithCode('UOJ 登录会话已失效。', 'UOJ_AUTH');
  try {
    const status = JSON.parse(response.body);
    if (status && typeof status.judged === 'boolean') return status;
  } catch (e) {}

  const $ = cheerio.load(response.body || '');
  const row = $('a[href="/submission/' + submissionId + '"]').first().closest('tr');
  const resultText = row.children('td').eq(3).text().replace(/\s+/g, ' ').trim();
  if (resultText) return { judged: !/^(Waiting|Judging|Waiting Rejudge)$/i.test(resultText) };
  throw new Error('无法解析 UOJ 提交状态，接口可能已经变化。');
}

async function pollResult(submissionId, judgeState, onProgress) {
  const pollLimit = Math.max(1, Math.min(300, parseInt(process.env.SYZOJ_WEB_UOJ_POLL_LIMIT || '120')));
  let progressSent = false;

  for (let attempt = 0; attempt < pollLimit; attempt++) {
    await delay(3000);
    let status;
    try {
      status = await fetchSubmissionStatus(submissionId);
    } catch (e) {
      if (e.code !== 'UOJ_AUTH') throw e;
      await ensureLogin(true);
      continue;
    }

    if (!status.judged) {
      if (!progressSent) {
        progressSent = true;
        const accepted = await onProgress({
          taskId: judgeState.task_id,
          type: 3,
          progress: {
            judge: {
              subtasks: [{ score: 0, cases: [{ status: 1 }] }]
            }
          }
        });
        if (accepted === false) throw errorWithCode('本地评测任务已取消或被替换。', 'UOJ_ABORT');
      }
      continue;
    }

    let finalPage;
    try {
      finalPage = await requestWithRetry('GET', '/submission/' + submissionId);
      if (isAuthResponse(finalPage)) throw errorWithCode('UOJ 登录会话已失效。', 'UOJ_AUTH');
    } catch (e) {
      if (e.code !== 'UOJ_AUTH') throw e;
      await ensureLogin(true);
      continue;
    }
    const result = parseFinalResult(finalPage.body, submissionId);
    if (result.compileError) {
      return {
        compile: { status: 3, message: result.message }
      };
    }
    return buildFinishedProgress(result);
  }

  throw new Error('等待 UOJ 评测结果超时。');
}

function sanitizeArticle($, article) {
  article.find('script, style, iframe, object, embed, form, input, button').remove();
  article.find('*').each((_, element) => {
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
      const token = 'UOJMATHPLACEHOLDER' + math.length + 'TOKEN';
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
    markdown = markdown.split('UOJMATHPLACEHOLDER' + index + 'TOKEN').join(value);
  });
  return markdown.replace(/\n{3,}/g, '\n\n').trim();
}

function sectionForHeading(text) {
  const heading = String(text || '').trim().toLowerCase();
  if (/输入格式|input format/.test(heading)) return 'inputFormat';
  if (/输出格式|output format/.test(heading)) return 'outputFormat';
  if (/样例|sample/.test(heading)) return 'example';
  if (/限制|约定|提示|说明|constraints?|notes?|download|下载/.test(heading)) return 'hint';
  return null;
}

function parseLimit(text, kind) {
  const normalized = String(text || '')
    .replace(/\\texttt\{([^}]+)\}/g, '$1')
    .replace(/\s+/g, ' ');
  const label = kind === 'time' ? '(?:时间限制|time limit)' : '(?:空间限制|内存限制|memory limit)';
  const unit = kind === 'time' ? '(ms|s|毫秒|秒)' : '(kb|kib|mb|mib|gb|gib)';
  const match = new RegExp(label + '[^0-9]{0,30}([0-9]+(?:\\.[0-9]+)?)\\s*' + unit, 'i').exec(normalized);
  if (!match) return kind === 'time' ? 1000 : 256;

  const value = parseFloat(match[1]);
  const parsedUnit = match[2].toLowerCase();
  if (kind === 'time') return Math.round(value * (/^(s|秒)$/.test(parsedUnit) ? 1000 : 1));
  if (/^g/.test(parsedUnit)) return Math.round(value * 1024);
  if (/^k/.test(parsedUnit)) return Math.max(1, Math.round(value / 1024));
  return Math.round(value);
}

function parseProblemHtml(html, remoteId) {
  const $ = cheerio.load(html || '', { decodeEntities: false });
  const article = $('article').first();
  const header = $('.page-header.text-center').first();
  if (!article.length || !header.length) throw new Error('UOJ 题目 #' + remoteId + ' 不存在或题面不可见。');

  const title = header.text().trim().replace(new RegExp('^#' + remoteId + '\\s*[.。]?\\s*'), '');
  if (!title) throw new Error('无法解析 UOJ 题目 #' + remoteId + ' 的标题。');

  const normalizedHtml = String(html || '').replace(/\\"/g, '"');
  const submissionFields = [];
  const fieldPattern = /\.(source_code|text_file)_form_group\(["']answer_([^"']+)["']/g;
  let fieldMatch;
  while ((fieldMatch = fieldPattern.exec(normalizedHtml))) {
    submissionFields.push({ type: fieldMatch[1], name: fieldMatch[2] });
  }
  if (submissionFields.length !== 1 || submissionFields[0].type !== 'source_code' || submissionFields[0].name !== 'answer') {
    throw new Error('UOJ 题目 #' + remoteId + ' 不是受支持的单源文件提交题。');
  }

  const allText = $('body').text();
  sanitizeArticle($, article);
  const sections = {
    description: [],
    inputFormat: [],
    outputFormat: [],
    example: [],
    hint: []
  };
  let current = 'description';
  article.contents().each((_, node) => {
    if (node.type === 'tag' && node.name === 'h3') {
      const next = sectionForHeading($(node).text());
      if (next) {
        current = next;
        return;
      }
    }
    sections[current].push($.html(node));
  });

  const sourceUrl = endpoint + '/problem/' + remoteId;
  sections.hint.push('<p><a href="' + sourceUrl + '" target="_blank" rel="noopener noreferrer">查看 UOJ 原题</a></p>');
  return {
    title: title,
    description: htmlToMarkdown(sections.description.join('')),
    inputFormat: htmlToMarkdown(sections.inputFormat.join('')),
    outputFormat: htmlToMarkdown(sections.outputFormat.join('')),
    example: htmlToMarkdown(sections.example.join('')),
    hint: htmlToMarkdown(sections.hint.join('')),
    timeLimit: parseLimit(allText, 'time'),
    memoryLimit: parseLimit(allText, 'memory')
  };
}

function parseProblemListHtml(html) {
  const $ = cheerio.load(html || '');
  const problemIds = new Set();
  let pageCount = 1;

  $('table tbody a[href]').each((_, element) => {
    try {
      const url = new URL($(element).attr('href'), endpoint);
      const match = /^\/problem\/(\d+)$/.exec(url.pathname);
      if (match) problemIds.add(parseInt(match[1]));
    } catch (e) {}
  });
  $('ul.pagination a[href]').each((_, element) => {
    try {
      const url = new URL($(element).attr('href'), endpoint);
      const page = parseInt(url.searchParams.get('page'));
      if (Number.isSafeInteger(page)) pageCount = Math.max(pageCount, page);
    } catch (e) {}
  });

  return { problemIds: Array.from(problemIds), pageCount: pageCount };
}

async function fetchProblemIds() {
  const firstResponse = await requestWithRetry('GET', '/problems');
  if (firstResponse.statusCode !== 200) throw new Error('无法打开 UOJ 题库。');

  const firstPage = parseProblemListHtml(firstResponse.body);
  const problemIds = new Set(firstPage.problemIds);
  for (let page = 2; page <= firstPage.pageCount; page++) {
    const response = await requestWithRetry('GET', '/problems', { qs: { page: page } });
    if (response.statusCode !== 200) throw new Error('无法打开 UOJ 题库第 ' + page + ' 页。');
    for (const problemId of parseProblemListHtml(response.body).problemIds) problemIds.add(problemId);
    await delay(200);
  }
  return Array.from(problemIds).sort((a, b) => a - b);
}

async function fetchProblem(remoteId) {
  const id = parseInt(remoteId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('UOJ 题号不正确。');
  await ensureLogin();
  let response = await requestWithRetry('GET', '/problem/' + id);
  if (isAuthResponse(response)) {
    await ensureLogin(true);
    response = await requestWithRetry('GET', '/problem/' + id);
  }
  if (response.statusCode !== 200) throw new Error('UOJ 题目 #' + id + ' 不存在或不可访问。');
  return parseProblemHtml(response.body, id);
}

async function runVjudge(judgeState, problem, onProgress) {
  let finished = false;
  try {
    const problemId = parseInt(problem.vjudge_config);
    if (!Number.isSafeInteger(problemId) || problemId <= 0) throw new Error('UOJ 远程题号不正确。');
    if (judgeState.type === 1 && process.env.SYZOJ_WEB_UOJ_ALLOW_CONTESTS !== 'true') {
      throw new Error('UOJ VJudge 默认禁止用于比赛，以免参赛代码在上游公开。');
    }

    const submissionId = await submitRemote(
      problemId,
      judgeState.language,
      judgeState.code,
      judgeState.user_id,
      metadata => persistVjudgeMarker(judgeState, {
        provider: 'uoj',
        phase: 'submitting',
        problemId,
        beforeId: metadata.beforeId,
        expectedLanguage: metadata.expectedLanguage,
        codeLength: metadata.codeLength
      })
    );
    await persistRemoteSubmission(judgeState, submissionId, problemId);
    const progress = await pollResult(submissionId, judgeState, onProgress);
    await onProgress({ taskId: judgeState.task_id, type: 4, progress: progress });
    finished = true;
  } catch (e) {
    if (e.code === 'UOJ_ABORT') return;
    console.error('UOJ VJudge failed:', e && e.stack ? e.stack : e);
    if (!finished) {
      try {
        await onProgress({
          taskId: judgeState.task_id,
          type: 4,
          progress: {
            error: 0,
            systemMessage: safeVjudgeError(e)
          }
        });
      } catch (reportError) {
        console.error('Failed to report UOJ VJudge error:', reportError);
      }
    }
  }
}

function vjudge(judgeState, problem, onProgress) {
  setImmediate(() => {
    runVjudge(judgeState, problem, onProgress).catch(e => {
      console.error('Unhandled UOJ VJudge error:', e);
    });
  });
}

vjudge.resume = function resume(judgeState, submissionId, onProgress) {
  setImmediate(() => {
    pollResult(submissionId, judgeState, onProgress)
      .then(progress => onProgress({ taskId: judgeState.task_id, type: 4, progress: progress }))
      .catch(async e => {
        if (e.code === 'UOJ_ABORT') return;
        try {
          await onProgress({
            taskId: judgeState.task_id,
            type: 4,
            progress: { error: 0, systemMessage: safeVjudgeError(e) }
          });
        } catch (reportError) {
          console.error('Failed to report resumed UOJ VJudge error:', reportError);
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
        const currentId = await latestSubmissionId(marker.problemId);
        if (currentId > marker.beforeId) submissionId = currentId;
        else await delay(500);
      }
      if (!submissionId) throw new Error('UOJ 提交阶段中断，未找到可安全关联的远端提交。');
      await persistRemoteSubmission(judgeState, submissionId, marker.problemId);
      const progress = await pollResult(submissionId, judgeState, onProgress);
      await onProgress({ taskId: judgeState.task_id, type: 4, progress });
    } catch (e) {
      if (e.code === 'UOJ_ABORT') return;
      console.error('Recovered UOJ VJudge failed:', e && e.stack ? e.stack : e);
      await onProgress({
        taskId: judgeState.task_id,
        type: 4,
        progress: { error: 0, systemMessage: safeVjudgeError(e) }
      });
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
  await ensureLogin(true);
  return true;
};
vjudge.configured = configured;
vjudge._test = {
  parseFinalResult: parseFinalResult,
  parseJudgementDetails: parseJudgementDetails,
  buildFinishedProgress: buildFinishedProgress,
  parseProblemHtml: parseProblemHtml,
  parseProblemListHtml: parseProblemListHtml,
  inspectLatest: async function inspectLatest(problemId) {
    await ensureLogin(true);
    const submissionId = await latestSubmissionId(problemId);
    const status = await fetchSubmissionStatus(submissionId);
    return {
      submissionId: submissionId,
      status: status
    };
  },
  inspectLatestResult: async function inspectLatestResult(problemId) {
    await ensureLogin(true);
    const submissionId = await latestSubmissionId(problemId);
    if (!submissionId) throw new Error('UOJ 题目 #' + problemId + ' 没有可检查的提交。');
    const response = await requestWithRetry('GET', '/submission/' + submissionId);
    if (isAuthResponse(response)) throw new Error('UOJ 登录会话已失效。');
    return {
      submissionId: submissionId,
      result: parseFinalResult(response.body, submissionId)
    };
  }
};

module.exports = vjudge;
