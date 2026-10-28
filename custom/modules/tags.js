const TypeORM = require('typeorm');

// 标签列表页：展示所有标签 + 每个标签下的题目数
app.get('/tags', async (req, res) => {
  try {
    if (syzoj.utils.problemWorkflowV2) await syzoj.utils.problemWorkflowV2.ensureSchema();
    // One aggregate query instead of one count query per tag. Preserve the
    // existing association-count semantics and include unused catalog tags.
    const rows = await TypeORM.getConnection().query(`
      SELECT tag.id,tag.name,tag.color,tag.category,COUNT(map.problem_id) AS problem_count
      FROM problem_tag tag LEFT JOIN problem_tag_map map ON map.tag_id=tag.id
      GROUP BY tag.id,tag.name,tag.color,tag.category`);
    const tags = rows.map(row => ({
      id: Number(row.id), name: row.name, color: row.color,
      category: row.category || null, problemCount: Number(row.problem_count || 0)
    }));

    // 按类型和名字排序，让同类标签保持稳定顺序。
    tags.sort((a, b) => {
      if (a.category !== b.category) {
        return (a.category || '') > (b.category || '') ? 1 : -1;
      }
      return (a.name || '') > (b.name || '') ? 1 : -1;
    });

    res.render('tags', {
      tags: tags
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', {
      err: e
    });
  }
});
