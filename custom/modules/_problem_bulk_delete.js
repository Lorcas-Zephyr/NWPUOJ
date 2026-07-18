const crypto = require('crypto');
const Problem = syzoj.model('problem');
const Contest = syzoj.model('contest');

function operationError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode || 400;
  error.expected = true;
  return error;
}

function parseProblemIds(value) {
  const values = Array.isArray(value) ? value : [value];
  const ids = values.map(item => Number(item));
  if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw operationError('请选择需要删除的题目。');
  }
  return Array.from(new Set(ids));
}

function isValidCsrfToken(req) {
  const expected = req.session && req.session.problemBulkDeleteCsrfToken;
  const actual = req.body && req.body.csrf_token;
  if (typeof expected !== 'string' || typeof actual !== 'string' || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

app.post('/problems/bulk-delete', async (req, res) => {
  try {
    if (!res.locals.user || !res.locals.user.is_admin) {
      throw operationError('只有超级管理员可以批量删除题目。', 403);
    }
    if (!isValidCsrfToken(req)) {
      throw operationError('页面已失效，请刷新题库后重试。', 403);
    }
    if (req.body.confirmation !== 'DELETE') {
      throw operationError('确认文字不正确，未删除任何题目。');
    }

    const problemIds = parseProblemIds(req.body.problem_ids);
    if (problemIds.length > 200) throw operationError('一次最多批量删除 200 道题目。');

    let deleted = 0;
    await syzoj.utils.lock(['Problem::bulk-delete'], async () => {
      const problems = [];
      for (const problemId of problemIds) {
        const problem = await Problem.findById(problemId);
        if (!problem) throw operationError('题目 #' + problemId + ' 不存在，未删除任何题目。');
        problems.push(problem);
      }

      const selectedIds = new Set(problemIds);
      const contestReferences = [];
      const contests = await Contest.find();
      for (const contest of contests) {
        const matchedIds = (await contest.getProblems()).filter(problemId => selectedIds.has(problemId));
        if (matchedIds.length) {
          contestReferences.push('#' + contest.id + ' ' + contest.title + '（题目 #' + matchedIds.join(', #') + '）');
        }
      }
      if (contestReferences.length) {
        throw operationError('以下比赛仍在使用所选题目，请先从比赛中移除：' + contestReferences.join('；'));
      }

      for (const problem of problems) {
        await problem.delete();
        deleted++;
      }
    });

    const repository = ['all', 'uoj', 'hdu', 'poj'].includes(req.body.repository) ? req.body.repository : 'main';
    res.redirect('/problems?' + (repository === 'all' ? '' : 'repository=' + repository + '&') + 'bulk_deleted=' + deleted);
  } catch (e) {
    if (!e.expected) syzoj.log(e);
    res.status(e.statusCode || 500);
    res.render('error', { err: e });
  }
});
