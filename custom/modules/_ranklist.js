// Ranking uses the same account Rating as username colors.
// 文件名以 _ 开头确保字母排序在 SYZOJ 自带的 user.js 之前先加载
let User = syzoj.model('user');

app.get('/ranklist', async (req, res) => {
  try {
    let sort = req.query.sort === 'hit' ? 'rating' : req.query.sort || 'rating';
    let order = req.query.order || 'desc';

    if (!['ac_num', 'rating', 'id', 'username'].includes(sort)) {
      throw new ErrorMessage('错误的排序参数。');
    }
    if (!['asc', 'desc'].includes(order)) {
      throw new ErrorMessage('错误的排序参数。');
    }

    const ordinaryUsers = () => User.createQueryBuilder('u')
      .leftJoin('temporary_contest_account', 'temporary_account', 'temporary_account.user_id = u.id')
      .where('u.is_show = TRUE')
      .andWhere('temporary_account.user_id IS NULL');
    let pageSize = syzoj.config.page.ranklist;
    let total = await ordinaryUsers().getCount();
    let paginate = syzoj.utils.paginate(total, req.query.page, pageSize);

    const ranklist = await ordinaryUsers()
      .orderBy(`u.${sort}`, order.toUpperCase())
      .addOrderBy('u.id', 'ASC')
      .limit(paginate.perPage)
      .offset((paginate.currPage - 1) * paginate.perPage)
      .getMany();

    await ranklist.forEachAsync(async function(x) { return x.renderInformation(); });

    res.render('ranklist', {
      ranklist: ranklist,
      paginate: paginate,
      curSort: sort,
      curOrder: order === 'asc'
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});
