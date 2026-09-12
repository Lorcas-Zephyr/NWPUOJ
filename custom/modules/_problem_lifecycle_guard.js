const TypeORM = require('typeorm');
const problemDomain = require('../libs/problem-domain');
const { linkUserMentions } = require('../libs/user-mentions');
const STATEMENT_FIELDS = ['description', 'input_format', 'output_format', 'example', 'limit_and_hint'];

if (!syzoj.utils.markdown.__normalizesFieldValues) {
  const renderMarkdown = syzoj.utils.markdown;
  const normalizedMarkdown = function normalizedMarkdown(value, fields, ...args) {
    if (value && Array.isArray(fields)) {
      fields.forEach(field => {
        value[field] = value[field] == null ? '' : String(value[field]);
      });
    }
    return renderMarkdown(value, fields, ...args);
  };
  normalizedMarkdown.__normalizesFieldValues = true;
  syzoj.utils.markdown = normalizedMarkdown;
}

async function referencingContests(problemId) {
  return TypeORM.getConnection().query(
    `SELECT id,title FROM contest
     WHERE CONCAT('|',COALESCE(problems,''),'|') LIKE CONCAT('%|',?,'|%')
     ORDER BY id ASC`,
    [problemId]
  );
}

async function rejectIfUsedByContest(req, res, next) {
  try {
    const problemId = Number(req.params.id);
    if (!Number.isSafeInteger(problemId) || problemId <= 0) return next();
    const contests = await referencingContests(problemId);
    if (!contests.length) return next();
    const names = contests.slice(0, 3).map(contest => `#${contest.id} ${contest.title}`).join('、');
    res.status(409).render('error', {
      err: new ErrorMessage(`题目仍被比赛使用，不能删除或修改编号：${names}${contests.length > 3 ? ' 等' : ''}`)
    });
  } catch (error) {
    next(error);
  }
}

// Problem pages contain mutable statements and viewer-specific permissions.
// Never let a post-save navigation reuse an older rendered document.
app.use('/problem/:id', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.setHeader('Cache-Control', 'private, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use('/problem/:id', async (req, res, next) => {
  const route = /^\/problem\/(\d+)\/?$/.exec(String(req.originalUrl || '').split('?')[0]);
  if (req.method !== 'GET' || !route) return next();
  try {
    const problemId = Number(route[1]);
    const rows = await TypeORM.getConnection().query(`SELECT problem.id,problem.user_id,problem.is_public,
        state.current_version_id,version.status AS version_status,version.content_json
      FROM problem
      LEFT JOIN problem_v2_state state ON state.problem_id=problem.id
      LEFT JOIN problem_v2_version version ON version.id=state.current_version_id AND version.problem_id=problem.id
      WHERE problem.id=? LIMIT 1`, [problemId]);
    if (!rows.length || !rows[0].current_version_id || !rows[0].content_json) return next();
    const row = rows[0];
    const resource = problemDomain.problemResource(row);
    const canEdit = !!res.locals.user && await syzoj.utils.authorizationV2.authorize(
      res.locals.user,
      'problem:edit',
      resource,
      { scope: `problem:${problemId}` }
    );
    const requestedVersionId = String(req.query && req.query.version || '');
    const isPublishedVersion = row.version_status === 'published';
    const mayViewCurrent = isPublishedVersion || !row.is_public && canEdit || canEdit && requestedVersionId === String(row.current_version_id);
    if (!mayViewCurrent) return next();
    const rendered = problemDomain.parseStoredContent(row.content_json);
    STATEMENT_FIELDS.forEach(field => {
      rendered[field] = rendered[field] == null ? '' : String(rendered[field]);
    });
    await syzoj.utils.markdown(rendered, STATEMENT_FIELDS);
    await Promise.all(STATEMENT_FIELDS.map(async field => {
      rendered[field] = await linkUserMentions(rendered[field]);
    }));
    res.locals.problemV2View = {
      content: rendered,
      versionId: String(row.current_version_id),
      isDraft: !isPublishedVersion,
      isPublic: !!row.is_public
    };
    next();
  } catch (error) {
    next(error);
  }
});
