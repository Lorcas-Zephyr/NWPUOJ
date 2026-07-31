'use strict';

const TypeORM = require('typeorm');

const Contest = syzoj.model('contest');

function apiFailure(res, error) {
  const status = Number(error && error.statusCode) || 400;
  const code = status === 404 ? 'CONTEST_NOT_FOUND'
    : status === 403 ? 'CAPABILITY_REQUIRED'
      : status === 409 ? 'REGISTRATION_FAILED'
        : status >= 500 ? 'CONTENT_WRITE_FAILED'
          : 'VALIDATION_FAILED';
  return syzoj.utils.apiV2.fail(res, status, code, error.message || '临时账户导入失败。');
}

function service() {
  return syzoj.utils.temporaryContestAccounts;
}

app.get('/api/v2/admin/contest-temp-accounts', async (req, res) => {
  const contestId = Number(req.query.contest_id);
  const contest = Number.isSafeInteger(contestId) && contestId > 0 ? await Contest.findById(contestId) : null;
  if (!contest) return syzoj.utils.apiV2.fail(res, 404, 'CONTEST_NOT_FOUND', 'Contest was not found.');
  if (!await service().canManageContestRegistrations(contest, res.locals.user)) {
    return syzoj.utils.apiV2.fail(res, res.locals.user ? 403 : 401, res.locals.user ? 'CAPABILITY_REQUIRED' : 'AUTHENTICATION_REQUIRED', res.locals.user ? 'Capability required: contest:registration.manage.' : 'Authentication is required.');
  }
  await service().ensureSchema();
  const limit = syzoj.utils.apiV2.parseLimit(req, 100, 200);
  const cursor = Number(syzoj.utils.apiV2.decodeCursor(req.query.cursor) || 0);
  const rows = await TypeORM.getConnection().query(
    `SELECT account.user_id,user.username,profile.student_id,profile.real_name,profile.college,
            account.expires_at,account.created_at,account.created_by
     FROM temporary_contest_account account
     INNER JOIN user ON user.id=account.user_id
     INNER JOIN user_registration_profile profile ON profile.user_id=account.user_id
     WHERE account.contest_id=? AND account.user_id>?
     ORDER BY account.user_id ASC LIMIT ?`,
    [contestId,cursor,limit + 1]
  );
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  res.locals.apiMeta.limit = limit;
  res.locals.apiMeta.next_cursor = more && page.length
    ? syzoj.utils.apiV2.encodeCursor(Number(page[page.length - 1].user_id))
    : null;
  return syzoj.utils.apiV2.send(res, page.map(row => ({
    user_id: Number(row.user_id),
    username: row.username,
    student_id: row.student_id,
    real_name: row.real_name,
    college: row.college,
    expires_at: new Date(Number(row.expires_at) * 1000).toISOString(),
    created_at: new Date(Number(row.created_at) * 1000).toISOString(),
    created_by: Number(row.created_by)
  })));
});

app.post('/api/v2/admin/contest-temp-accounts/import', (req, res) => {
  service().upload(req, res, async uploadError => {
    try {
      if (uploadError) {
        const error = service().inputError(uploadError.code === 'LIMIT_FILE_SIZE' ? 'CSV 文件不能超过 1 MiB。' : uploadError.message);
        error.statusCode = uploadError.code === 'LIMIT_FILE_SIZE' ? 413 : 422;
        throw error;
      }
      const contestId = Number(req.body && req.body.contest_id);
      const contest = Number.isSafeInteger(contestId) && contestId > 0 ? await Contest.findById(contestId) : null;
      if (!contest) throw service().inputError('无此比赛。', 404);
      if (!await service().canManageContestRegistrations(contest, res.locals.user)) throw service().inputError('您没有权限管理该比赛。', 403);
      if (!req.file) throw service().inputError('请选择 CSV 文件。', 422);
      const rows = service().normalizeRows(req.file.buffer);
      const result = await service().importTemporaryAccounts({ contestId, actor: res.locals.user, rows, req });
      req.apiV2SensitiveResponse = true;
      res.setHeader('Cache-Control', 'private, no-store');
      return syzoj.utils.apiV2.send(res, {
        contest_id: contestId,
        created_count: result.credentials.length,
        accounts: result.credentials.map(item => ({
          user_id: Number(item.userId),
          username: item.username,
          password: item.password,
          name: item.name,
          student_id: item.studentId,
          college: item.college,
          expires_at: new Date(Number(item.expiresAt) * 1000).toISOString()
        })),
        audit_event_id: result.auditEventId,
        event_id: result.event.id
      }, 201);
    } catch (error) {
      syzoj.log('[temporary-contest-account] v2 import failed: ' + (error.stack || error));
      return apiFailure(res, error);
    }
  });
});
