const TypeORM = require('typeorm');

app.get('/problems/tag/:id/edit', async (req, res) => {
  try {
    const user = res.locals.user;
    const allowed = user && await syzoj.utils.authorizationV2.authorize(user, 'problem:tag.manage', null, { scope: 'global' });
    if (!allowed) throw new ErrorMessage('您没有权限进行此操作。');
    if (syzoj.utils.problemWorkflowV2) await syzoj.utils.problemWorkflowV2.ensureSchema();
    const id = parseInt(req.params.id) || 0;
    const rows = id ? await TypeORM.getConnection().query('SELECT id,name,color,category FROM problem_tag WHERE id=? LIMIT 1', [id]) : [];
    const tag = rows[0] || { id: 0, name: '', color: 'violet', category: 'algorithm' };
    res.render('problem_tag_edit', { tag });
  } catch (error) {
    syzoj.log(error);
    res.render('error', { err: error });
  }
});
