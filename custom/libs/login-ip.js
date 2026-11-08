'use strict';

const net = require('net');
const { URL } = require('url');
const invalid = message => Object.assign(new Error(message), { statusCode: 422, code: 'LOGIN_IP_FILTER_INVALID' });

function normalizeIp(value) {
  const ip = String(value || '').trim();
  if (net.isIP(ip) === 4) return ip;
  if (net.isIP(ip) !== 6 || ip.includes('%')) return null;
  const canonical = new URL('http://[' + ip + ']/').hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

// Audit DATETIME values are UTC. Do not use FROM_UNIXTIME, which depends on
// the database session timezone (the legacy connection uses local time).
// Submissions have second precision; include the entire last submission second.
// Practice/out-of-contest submissions never widen the verification window.
const submissionWindows = `SELECT c.id AS contest_id,c.title AS contest_title,c.start_time AS contest_start,j.user_id,
    MIN(j.submit_time) AS first_submission,MAX(j.submit_time) AS last_submission
  FROM weekly_ranklist_contest selected INNER JOIN contest c ON c.id=selected.contest_id AND c.type='acm'
  INNER JOIN judge_state j ON j.type=1 AND j.type_info=c.id AND j.submit_time>=c.start_time AND j.submit_time<c.end_time
  INNER JOIN weekly_ranklist_member m ON m.user_id=j.user_id
  GROUP BY c.id,c.title,c.start_time,j.user_id`;
const contestWindow = `e.created_at >= TIMESTAMPADD(SECOND,w.contest_start,'1970-01-01 00:00:00')
  AND e.created_at < TIMESTAMPADD(SECOND,w.last_submission+1,'1970-01-01 00:00:00')`;

async function reconcileOnsite(manager, recordAudit, userId) {
  const rows = await manager.query(`SELECT a.user_id,a.contest_id,e.ip_address,w.contest_start,w.first_submission,w.last_submission,
      DATE_FORMAT(MIN(e.created_at),'%Y-%m-%dT%H:%i:%s.%fZ') AS first_login,
      DATE_FORMAT(MAX(e.created_at),'%Y-%m-%dT%H:%i:%s.%fZ') AS last_login
    FROM weekly_ranklist_attendance a
    INNER JOIN (${submissionWindows}) w ON w.contest_id=a.contest_id AND w.user_id=a.user_id
    INNER JOIN auth_audit_event e ON e.resource_type='user' AND e.resource_id=CAST(a.user_id AS CHAR)
      AND e.action='auth:login' AND ${contestWindow}
    WHERE a.onsite=1 ${userId == null ? '' : 'AND a.user_id=?'}
    GROUP BY a.user_id,a.contest_id,e.ip_address,w.contest_start,w.first_submission,w.last_submission`, userId == null ? [] : [userId]);
  const pairs = new Map();
  for (const row of rows) {
    const ip = normalizeIp(row.ip_address);
    if (!ip) continue;
    const key = row.user_id + ':' + row.contest_id;
    if (!pairs.has(key)) pairs.set(key, { user_id: Number(row.user_id), contest_id: Number(row.contest_id), contest_start: Number(row.contest_start), first_submission: Number(row.first_submission), last_submission: Number(row.last_submission), ips: new Map() });
    const pair = pairs.get(key), previous = pair.ips.get(ip);
    pair.ips.set(ip, { ip_address: ip,
      first_login: previous && previous.first_login < row.first_login ? previous.first_login : row.first_login,
      last_login: previous && previous.last_login > row.last_login ? previous.last_login : row.last_login });
  }
  let count = 0;
  for (const pair of pairs.values()) {
    if (pair.ips.size < 2) continue;
    const evidence = Array.from(pair.ips.values()).sort((a, b) => a.ip_address.localeCompare(b.ip_address));
    await manager.query(`UPDATE weekly_ranklist_attendance SET onsite=0,recorded_by=0,updated_at=UTC_TIMESTAMP(3)
      WHERE user_id=? AND contest_id=? AND onsite=1`, [pair.user_id, pair.contest_id]);
    await manager.query(`INSERT INTO weekly_ranklist_ip_violation (user_id,contest_id,evidence_json,detected_at)
      VALUES (?,?,?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE evidence_json=VALUES(evidence_json),detected_at=VALUES(detected_at)`,
    [pair.user_id, pair.contest_id, JSON.stringify(evidence)]);
    await recordAudit(null, { action: 'weekly_ranklist:attendance.auto_online', resourceType: 'weekly_ranklist', resourceId: 1,
      reason: '比赛开始至该用户末次提交期间使用多个不同 IP 成功登录，自动改为线上参赛',
      details: { user_id: pair.user_id, contest_id: pair.contest_id, contest_start: pair.contest_start, first_submission: pair.first_submission,
        last_submission: pair.last_submission, previous_onsite: true, onsite: false, logins: evidence } }, manager);
    count++;
  }
  return count;
}

function localDate(value) {
  if (!value) return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) throw invalid('请选择有效的北京时间。');
  const ms = Date.parse(text + ':00+08:00');
  if (!Number.isFinite(ms) || new Date(ms + 8 * 3600000).toISOString().slice(0, 16) !== text) throw invalid('请选择有效的北京时间。');
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

async function listLogins(manager, query, weekly = false) {
  const keyword = String(query.q || '').trim().slice(0, 100);
  const from = localDate(query.from), to = localDate(query.to);
  if (from && to && from >= to) throw invalid('结束时间必须晚于开始时间。');
  const contestId = query.contest_id ? Number(query.contest_id) : null;
  if (contestId !== null && (!Number.isSafeInteger(contestId) || contestId < 1)) throw invalid('比赛编号不正确。');
  const requestedPage = Number(query.page || 1);
  if (!Number.isSafeInteger(requestedPage) || requestedPage < 1) throw invalid('页码不正确。');
  const conditions = ["e.action='auth:login'", "e.resource_type='user'"], values = [];
  if (keyword) {
    conditions.push('(u.id=? OR u.username LIKE ?)');
    const userId = /^\d+$/.test(keyword) && Number.isSafeInteger(Number(keyword)) ? Number(keyword) : 0;
    values.push(userId, '%' + keyword.replace(/[\\%_]/g, '\\$&') + '%');
  }
  if (from) { conditions.push('e.created_at>=?'); values.push(from); }
  if (to) { conditions.push('e.created_at<?'); values.push(to); }
  if (weekly && contestId) { conditions.push('w.contest_id=?'); values.push(contestId); }
  if (weekly) conditions.push('v.user_id IS NOT NULL AND a.onsite=0');
  const joins = `FROM auth_audit_event e INNER JOIN user u ON e.resource_id=CAST(u.id AS CHAR)
    ${weekly ? `INNER JOIN (${submissionWindows}) w ON w.user_id=u.id
    LEFT JOIN weekly_ranklist_attendance a ON a.user_id=u.id AND a.contest_id=w.contest_id
    LEFT JOIN weekly_ranklist_ip_violation v ON v.user_id=u.id AND v.contest_id=w.contest_id` : ''}
    WHERE ${conditions.join(' AND ')} ${weekly ? 'AND ' + contestWindow : ''}`;
  const [count] = await manager.query('SELECT COUNT(*) AS total ' + joins, values);
  const total = Number(count.total), pageCount = Math.max(1, Math.ceil(total / 50)), page = Math.min(requestedPage, pageCount);
  const rows = await manager.query(`SELECT e.id,u.id AS user_id,u.username,e.ip_address,
    DATE_FORMAT(e.created_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS logged_in_at
    ${weekly ? ',w.contest_id,w.contest_title,w.contest_start,w.first_submission,w.last_submission,COALESCE(a.onsite,0) AS onsite,v.detected_at IS NOT NULL AS auto_online' : ''}
    ${joins} ORDER BY e.created_at DESC,e.id DESC ${weekly ? ',w.contest_id DESC' : ''} LIMIT 50 OFFSET ?`, values.concat((page - 1) * 50));
  return { rows: rows.map(row => ({ ...row, id: String(row.id), ip_address: normalizeIp(row.ip_address) || row.ip_address || '—',
    logged_in_at: new Date(row.logged_in_at).toISOString() })), total, page, page_count: pageCount };
}

module.exports = { normalizeIp, reconcileOnsite, listLogins, localDate };
