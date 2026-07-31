const TypeORM = require('typeorm');

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
