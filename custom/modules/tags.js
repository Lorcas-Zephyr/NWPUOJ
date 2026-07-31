let ProblemTag = syzoj.model('problem_tag');
let ProblemTagMap = syzoj.model('problem_tag_map');
const TypeORM = require('typeorm');

// 标签列表页：展示所有标签 + 每个标签下的题目数
app.get('/tags', async (req, res) => {
  try {
    // 取出所有标签
    let tags = await ProblemTag.find({});
    if (syzoj.utils.problemWorkflowV2) await syzoj.utils.problemWorkflowV2.ensureSchema();
    const categoryRows = await TypeORM.getConnection().query('SELECT id,category FROM problem_tag');
    const categories = new Map(categoryRows.map(row => [Number(row.id), row.category]));

    // 为每个标签查询关联的题目数量
    // 注意：这里只统计了 problem_tag_map 中的关联数，
    // 不区分 public/private，简单实现先这样
    for (let tag of tags) {
      tag.problemCount = await ProblemTagMap.count({ tag_id: tag.id });
      tag.category = categories.get(Number(tag.id)) || null;
    }

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
