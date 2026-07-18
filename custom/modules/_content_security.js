const crypto = require('crypto');
const TypeORM = require('typeorm');
const Article = syzoj.model('article');
const Problem = syzoj.model('problem');
const ProblemSolution = syzoj.model('problem-solution');

const previewWindows = new Map();
let activePreviews = 0;
let formTokenSchemaPromise;

function byteLength(value) {
  return Buffer.byteLength(String(value == null ? '' : value), 'utf8');
}

async function canSeeProblemContent(problemId, user) {
  if (!problemId) return true;
  const problem = await Problem.findById(Number(problemId));
  if (!problem || !await problem.isAllowedUseBy(user)) return false;
  if (syzoj.utils.canAccessProblemOutsideContest && !await syzoj.utils.canAccessProblemOutsideContest(problem.id, user)) {
    return false;
  }
  return true;
}

syzoj.utils.canSeeProblemContent = canSeeProblemContent;

function ensureFormTokenSchema() {
  if (!formTokenSchemaPromise) {
    formTokenSchemaPromise = TypeORM.getConnection().query(`
      CREATE TABLE IF NOT EXISTS content_form_token (
        token_hash CHAR(64) CHARACTER SET ascii NOT NULL,
        user_id INT NOT NULL,
        scope VARCHAR(80) CHARACTER SET ascii NOT NULL,
        expires_at BIGINT NOT NULL,
        PRIMARY KEY (token_hash),
        KEY idx_content_form_token_user_scope (user_id, scope),
        KEY idx_content_form_token_expiry (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=ascii
    `).catch(error => {
      formTokenSchemaPromise = null;
      throw error;
    });
  }
  return formTokenSchemaPromise;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function issueFormTokens(tokenDefinitions) {
  return async (req, res, next) => {
    try {
      if (!res.locals.user) return next();
      await ensureFormTokenSchema();
      const now = Math.floor(Date.now() / 1000);
      const tokens = res.locals.contentFormTokens || {};
      for (const definition of tokenDefinitions) {
        const token = crypto.randomBytes(32).toString('hex');
        await TypeORM.getConnection().query(
          'INSERT INTO content_form_token (token_hash,user_id,scope,expires_at) VALUES (?,?,?,?)',
          [tokenHash(token), res.locals.user.id, definition.scope(req), now + 2 * 60 * 60]
        );
        tokens[definition.name] = token;
      }
      res.locals.contentFormTokens = tokens;
      TypeORM.getConnection().query('DELETE FROM content_form_token WHERE expires_at<? LIMIT 1000', [now]).catch(error => {
        syzoj.log('[content-token-cleanup] ' + (error.stack || error));
      });
      next();
    } catch (error) {
      next(error);
    }
  };
}

function consumeFormToken(scopeFactory) {
  return async (req, res, next) => {
    try {
      if (!res.locals.user) throw new ErrorMessage('请登录后继续。');
      const token = String(req.body && req.body._content_token || '');
      if (!/^[a-f0-9]{64}$/.test(token)) throw new ErrorMessage('表单已过期，请刷新页面后重试。');
      await ensureFormTokenSchema();
      const result = await TypeORM.getConnection().query(
        'DELETE FROM content_form_token WHERE token_hash=? AND user_id=? AND scope=? AND expires_at>=?',
        [tokenHash(token), res.locals.user.id, scopeFactory(req), Math.floor(Date.now() / 1000)]
      );
      if (!result || result.affectedRows !== 1) {
        throw new ErrorMessage('表单已提交或过期，请刷新页面后重试。');
      }
      next();
    } catch (error) {
      res.status(409).render('error', { err: error });
    }
  };
}

async function guardArticleParent(req, res, next, requireEdit) {
  try {
    const id = Number(req.params.id);
    let article = Number.isSafeInteger(id) && id > 0 ? await Article.findById(id) : null;
    const problemId = article ? article.problem_id : Number(req.query.problem_id || (req.body && req.body.problem_id) || 0);
    if (problemId && !await canSeeProblemContent(problemId, res.locals.user)) {
      return res.status(403).render('error', { err: new ErrorMessage('您没有权限访问该题目的讨论。') });
    }
    if (requireEdit && article && !await article.isAllowedEditBy(res.locals.user)) {
      return res.status(403).render('error', { err: new ErrorMessage('您没有权限编辑此帖子。') });
    }
    next();
  } catch (error) {
    next(error);
  }
}

app.get('/article/:id', (req, res, next) => guardArticleParent(req, res, next, false));
app.get('/article/:id/edit', (req, res, next) => guardArticleParent(req, res, next, true));
app.post('/article/:id/edit', (req, res, next) => guardArticleParent(req, res, next, true));
app.post('/article/:id/comment', (req, res, next) => guardArticleParent(req, res, next, false));
app.post('/article/:id/delete', (req, res, next) => guardArticleParent(req, res, next, true));
app.post('/article/:id/comment/:commentId/delete', (req, res, next) => guardArticleParent(req, res, next, false));

async function guardSolutionParent(req, res, next) {
  try {
    const id = Number(req.params.id || req.params.sid);
    const solution = Number.isSafeInteger(id) && id > 0 ? await ProblemSolution.findById(id) : null;
    const problemId = solution ? solution.problem_id : Number(req.query.pid || (req.body && req.body.problem_id) || 0);
    if (problemId && !await canSeeProblemContent(problemId, res.locals.user)) {
      return res.status(403).render('error', { err: new ErrorMessage('您没有权限访问该题目的题解。') });
    }
    next();
  } catch (error) {
    next(error);
  }
}

app.get('/solution/:id', guardSolutionParent);
app.get('/solution/:id/edit', guardSolutionParent);
app.post('/solution/:id/edit', guardSolutionParent);
app.post('/solution/:id/approve', guardSolutionParent);
app.post('/solution/:id/reject', guardSolutionParent);
app.post('/solution/:id/withdraw', guardSolutionParent);
app.post('/solution/:id/delete', guardSolutionParent);
app.post('/solution/:sid/comment/:cid/delete', guardSolutionParent);
app.get('/discussion/problem/:pid', async (req, res, next) => {
  try {
    if (!await canSeeProblemContent(Number(req.params.pid), res.locals.user)) {
      return res.status(403).render('error', { err: new ErrorMessage('您没有权限访问该题目的讨论。') });
    }
    next();
  } catch (error) {
    next(error);
  }
});

app.post('/solution/:id/comment', async (req, res, next) => {
  try {
    const solution = await ProblemSolution.findById(Number(req.params.id));
    if (solution && !await canSeeProblemContent(solution.problem_id, res.locals.user)) {
      return res.status(403).render('error', { err: new ErrorMessage('您没有权限访问该题解。') });
    }
    next();
  } catch (error) {
    next(error);
  }
});

app.get('/article/:id/edit', issueFormTokens([
  { name: 'articleEdit', scope: req => 'article-edit:' + req.params.id }
]));
app.get('/article/:id', issueFormTokens([
  { name: 'articleComment', scope: req => 'article-comment:' + req.params.id }
]));
app.get('/solution/:id/edit', issueFormTokens([
  { name: 'solutionEdit', scope: req => 'solution-edit:' + req.params.id }
]));
app.get('/solution/:id', issueFormTokens([
  { name: 'solutionComment', scope: req => 'solution-comment:' + req.params.id },
  { name: 'solutionReview', scope: req => 'solution-review:' + req.params.id }
]));

function validateBody(req, res, next) {
  try {
    if (/^\/article\/\d+\/edit$/.test(req.path)) {
      const title = String(req.body.title || '').trim();
      const content = String(req.body.content || '').trim();
      if (!title) throw new ErrorMessage('标题不能为空。');
      if (title.length > 80 || byteLength(title) > 240) throw new ErrorMessage('标题不能超过 80 个字符或 240 字节。');
      if (!content) throw new ErrorMessage('内容不能为空。');
      if (byteLength(content) > 256 * 1024) throw new ErrorMessage('内容不能超过 256 KiB。');
    } else if (/^\/solution\/\d+\/edit$/.test(req.path)) {
      if (byteLength(req.body.title) > 240) throw new ErrorMessage('标题不能超过 240 字节。');
      if (byteLength(req.body.content) > 256 * 1024) throw new ErrorMessage('内容不能超过 256 KiB。');
    } else if (/^\/solution\/\d+\/reject$/.test(req.path)) {
      const reason = String(req.body.reason || '').trim();
      if (!reason) throw new ErrorMessage('拒绝原因不能为空。');
      if (reason.length > 255 || byteLength(reason) > 765) throw new ErrorMessage('拒绝原因不能超过 255 个字符。');
    } else if (/\/(?:article|solution)\/\d+\/comment$/.test(req.path)) {
      const comment = String(req.body.comment || '').trim();
      if (!comment) throw new ErrorMessage('评论内容不能为空。');
      if (byteLength(comment) > 16 * 1024) throw new ErrorMessage('评论内容不能超过 16 KiB。');
    }
    next();
  } catch (error) {
    res.status(400).render('error', { err: error });
  }
}

app.post(['/article/:id/edit', '/article/:id/comment', '/solution/:id/edit', '/solution/:id/comment', '/solution/:id/reject'], validateBody);
app.post('/article/:id/edit', consumeFormToken(req => 'article-edit:' + req.params.id));
app.post('/article/:id/comment', consumeFormToken(req => 'article-comment:' + req.params.id));
app.post('/solution/:id/edit', consumeFormToken(req => 'solution-edit:' + req.params.id));
app.post('/solution/:id/comment', consumeFormToken(req => 'solution-comment:' + req.params.id));
app.post(['/solution/:id/approve', '/solution/:id/reject'], consumeFormToken(req => 'solution-review:' + req.params.id));

app.post('/article/:id/comment', async (req, res) => {
  try {
    const articleId = Number(req.params.id);
    const article = await Article.findById(articleId);
    if (!article) throw new ErrorMessage('无此帖子。');
    if (!await article.isAllowedCommentBy(res.locals.user)) throw new ErrorMessage('您没有权限进行此操作。');
    const now = syzoj.utils.getCurrentDate();
    await TypeORM.getConnection().transaction(async manager => {
      const rows = await manager.query('SELECT id FROM article WHERE id=? FOR UPDATE', [articleId]);
      if (!rows.length) throw new ErrorMessage('无此帖子。');
      await manager.query(
        'INSERT INTO article_comment (content,article_id,user_id,public_time) VALUES (?,?,?,?)',
        [String(req.body.comment).trim(), articleId, res.locals.user.id, now]
      );
      await manager.query(`
        UPDATE article SET
          comments_num=(SELECT COUNT(*) FROM article_comment WHERE article_id=?),
          sort_time=COALESCE((SELECT MAX(public_time) FROM article_comment WHERE article_id=?),public_time)
        WHERE id=?
      `, [articleId, articleId, articleId]);
    });
    res.redirect(syzoj.utils.makeUrl(['article', articleId]));
  } catch (error) {
    syzoj.log(error);
    res.render('error', { err: error });
  }
});

app.post('/article/:id/comment/:commentId/delete', async (req, res) => {
  try {
    if (!res.locals.user) throw new ErrorMessage('请登录后继续。');
    const articleId = Number(req.params.id);
    const commentId = Number(req.params.commentId);
    await TypeORM.getConnection().transaction(async manager => {
      const rows = await manager.query(`
        SELECT ac.user_id,a.user_id AS article_user_id
        FROM article_comment ac
        INNER JOIN article a ON a.id=ac.article_id
        WHERE ac.id=? AND ac.article_id=? FOR UPDATE
      `, [commentId, articleId]);
      if (!rows.length) throw new ErrorMessage('无此评论。');
      const allowed = res.locals.user.is_admin || rows[0].user_id === res.locals.user.id || rows[0].article_user_id === res.locals.user.id;
      if (!allowed) throw new ErrorMessage('您没有权限进行此操作。');
      await manager.query('DELETE FROM article_comment WHERE id=? AND article_id=?', [commentId, articleId]);
      await manager.query(`
        UPDATE article SET
          comments_num=(SELECT COUNT(*) FROM article_comment WHERE article_id=?),
          sort_time=COALESCE((SELECT MAX(public_time) FROM article_comment WHERE article_id=?),public_time)
        WHERE id=?
      `, [articleId, articleId, articleId]);
    });
    res.redirect(syzoj.utils.makeUrl(['article', articleId]));
  } catch (error) {
    syzoj.log(error);
    res.render('error', { err: error });
  }
});

app.post('/api/markdown', async (req, res) => {
  if (!res.locals.user) return res.status(401).send('请登录后使用预览。');
  const source = String(req.body && req.body.s || '');
  if (byteLength(source) > 64 * 1024) return res.status(413).send('预览内容不能超过 64 KiB。');
  const key = String(res.locals.user.id);
  const now = Date.now();
  const recent = (previewWindows.get(key) || []).filter(time => now - time < 10000);
  if (recent.length >= 10) return res.status(429).send('预览请求过于频繁。');
  if (activePreviews >= 4) return res.status(503).send('预览服务繁忙，请稍后重试。');
  recent.push(now);
  previewWindows.set(key, recent);
  activePreviews++;
  try {
    const rendered = await Promise.race([
      syzoj.utils.markdown(source),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('Markdown preview timeout')), 3000))
    ]);
    res.send(rendered);
  } catch (error) {
    syzoj.log('[markdown-preview] ' + (error.stack || error));
    res.status(503).send('预览暂时不可用。');
  } finally {
    activePreviews--;
  }
});

app.get('/discussion/problems', async (req, res, next) => {
  try {
    const manager = !!(res.locals.user && await res.locals.user.hasPrivilege('manage_problem'));
    const query = Article.createQueryBuilder('article').andWhere('article.problem_id IS NOT NULL');
    if (!manager) {
      if (res.locals.user) {
        query.andWhere(`article.problem_id IN (
          SELECT visible_problem.id FROM problem visible_problem
          WHERE visible_problem.is_public=1 OR visible_problem.user_id=:discussionViewer
        )`, { discussionViewer: res.locals.user.id });
      } else {
        query.andWhere('article.problem_id IN (SELECT visible_problem.id FROM problem visible_problem WHERE visible_problem.is_public=1)');
      }
      query.andWhere(`NOT EXISTS (
        SELECT 1 FROM contest active_contest
        WHERE active_contest.end_time>UNIX_TIMESTAMP()
          AND CONCAT('|',COALESCE(active_contest.problems,''),'|') LIKE CONCAT('%|',article.problem_id,'|%')
      )`);
    }
    const paginate = syzoj.utils.paginate(
      await Article.countQuery(query),
      req.query.page,
      syzoj.config.page.discussion
    );
    const articles = await Article.queryPage(paginate, query, { sort_time: 'DESC', id: 'DESC' });
    for (const article of articles) {
      await article.loadRelationships();
      article.problem = await Problem.findById(article.problem_id);
    }
    res.render('discussion', { articles, paginate, problem: null, in_problems: true });
  } catch (error) {
    next(error);
  }
});

app.get('/user/:id', (req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = function renderUserWithVisibleArticles(view, options) {
    if (view !== 'user' || !options || !options.show_user || !Array.isArray(options.show_user.articles)) {
      return originalRender.apply(res, arguments);
    }
    Promise.all(options.show_user.articles.map(async article => {
      return await canSeeProblemContent(article.problem_id, res.locals.user) ? article : null;
    })).then(articles => {
      options.show_user.articles = articles.filter(Boolean);
      originalRender(view, options);
    }).catch(next);
    return res;
  };
  next();
});
