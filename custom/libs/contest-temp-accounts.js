'use strict';

const MAX_IMPORT_ROWS = 1000;

function inputError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode || 400;
  return error;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (character === '\n') {
      row.push(cell.trim());
      if (row.some(value => value)) rows.push(row);
      row = [];
      cell = '';
    } else if (character !== '\r') {
      cell += character;
    }
  }
  if (quoted) throw inputError('CSV 引号未闭合。');
  row.push(cell.trim());
  if (row.some(value => value)) rows.push(row);
  return rows;
}

function normalizeRows(buffer) {
  const rows = parseCsv(buffer.toString('utf8'));
  if (!rows.length) throw inputError('CSV 文件为空。');
  const header = rows[0].map(value => value.replace(/\s+/g, '').toLowerCase());
  const aliases = {
    name: ['姓名', 'name', 'realname'],
    studentId: ['学号', 'studentid', 'student_id'],
    college: ['学院', 'college']
  };
  const indexes = {};
  for (const [field, names] of Object.entries(aliases)) indexes[field] = header.findIndex(value => names.includes(value));
  if (Object.values(indexes).some(index => index < 0)) throw inputError('CSV 表头必须包含：姓名、学号、学院。');
  const dataRows = rows.slice(1);
  if (!dataRows.length) throw inputError('CSV 中没有账户数据。');
  if (dataRows.length > MAX_IMPORT_ROWS) throw inputError(`一次最多导入 ${MAX_IMPORT_ROWS} 个账户。`);
  const studentIds = new Set();
  return dataRows.map((values, index) => {
    const item = {
      name: String(values[indexes.name] || '').trim(),
      studentId: String(values[indexes.studentId] || '').trim(),
      college: String(values[indexes.college] || '').trim()
    };
    const line = index + 2;
    if (!item.name || item.name.length > 64) throw inputError(`第 ${line} 行姓名为空或超过 64 个字符。`);
    if (!/^\d{10}$/.test(item.studentId)) throw inputError(`第 ${line} 行学号必须为 10 位数字。`);
    if (!item.college || item.college.length > 100) throw inputError(`第 ${line} 行学院为空或超过 100 个字符。`);
    if (studentIds.has(item.studentId)) throw inputError(`第 ${line} 行学号在文件中重复。`);
    studentIds.add(item.studentId);
    return item;
  });
}

function csvCell(value) {
  let text = String(value == null ? '' : value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function usernamePart(value) {
  return String(value || '').normalize('NFKC').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '');
}

async function uniqueUsername(manager, base, studentId, reserved) {
  const safeBase = base.slice(0, 68);
  const candidates = [safeBase, `${safeBase}-${studentId.slice(-4)}`];
  for (let suffix = 2; suffix <= 999; suffix++) candidates.push(`${safeBase}-${studentId.slice(-4)}-${suffix}`);
  for (const candidate of candidates) {
    if (candidate.length > 80 || reserved.has(candidate) || !/^[a-zA-Z0-9_\-\u4e00-\u9fff]+$/.test(candidate)) continue;
    const rows = await manager.query('SELECT id FROM user WHERE username=? LIMIT 1', [candidate]);
    if (!rows.length) {
      reserved.add(candidate);
      return candidate;
    }
  }
  throw inputError(`无法为学号 ${studentId} 生成唯一用户名。`);
}

function appendPlayersToRanklist(current, newPlayerIds) {
  const playerIds = [];
  for (let index = 1; index <= Number(current.player_num || 0); index++) {
    if (Number(current[index])) playerIds.push(Number(current[index]));
  }
  playerIds.push(...newPlayerIds.map(Number));
  const nextRanklist = { player_num: playerIds.length };
  playerIds.forEach((playerId, index) => { nextRanklist[index + 1] = playerId; });
  return nextRanklist;
}

function isLoginAllowed(expiryByUserId, userId, now) {
  const expiry = expiryByUserId.get(Number(userId));
  const currentTime = now == null ? Math.floor(Date.now() / 1000) : Number(now);
  return expiry == null || expiry > currentTime;
}

module.exports = {
  MAX_IMPORT_ROWS,
  appendPlayersToRanklist,
  csvCell,
  inputError,
  isLoginAllowed,
  normalizeRows,
  parseCsv,
  uniqueUsername,
  usernamePart
};
