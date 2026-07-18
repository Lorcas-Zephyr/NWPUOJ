const JudgeState = syzoj.model('judge_state');
const Contest = syzoj.model('contest');

async function hasValidAcceptedSubmission(userId, problemId) {
  const count = await JudgeState.createQueryBuilder('js')
    .leftJoin('judge_state_admin_action', 'action', 'action.judge_id = js.id')
    .where('js.user_id = :userId', { userId: userId })
    .andWhere('js.problem_id = :problemId', { problemId: problemId })
    .andWhere('js.status = :status', { status: 'Accepted' })
    .andWhere('js.type != :contestType', { contestType: 1 })
    .andWhere('action.judge_id IS NULL')
    .getCount();
  return count > 0;
}

async function canViewSubmissionDetail(judge, user) {
  if (!user) return false;
  if (judge.user_id === user.id || user.is_admin) return true;
  if (await user.hasPrivilege('manage_problem')) return true;

  await judge.loadRelationships();
  if (judge.problem && await judge.problem.isAllowedEditBy(user)) return true;

  if (judge.type === 1) {
    const contest = await Contest.findById(judge.type_info);
    if (contest && await contest.isSupervisior(user)) return true;
    if (!contest || !contest.isEnded() || !contest.is_public) return false;
  }

  return hasValidAcceptedSubmission(user.id, judge.problem_id);
}

syzoj.utils.canViewSubmissionDetail = canViewSubmissionDetail;

async function guardSubmissionDetail(req, res, next) {
  try {
    if (!/^[1-9]\d*$/.test(req.params.id)) {
      return res.status(404).render('error', { err: new ErrorMessage('提交记录 ID 不正确。') });
    }
    const judge = await JudgeState.findById(Number(req.params.id));
    if (!judge) return next();
    if (!await canViewSubmissionDetail(judge, res.locals.user)) {
      return res.status(403).render('error', {
        err: new ErrorMessage('通过该题后才能查看其他用户的提交详情。')
      });
    }
    next();
  } catch (error) {
    syzoj.log('[submission-visibility] ' + (error.stack || error));
    res.status(500).render('error', { err: error });
  }
}

app.get('/submission/:id', guardSubmissionDetail);
app.get('/contest/submission/:id', guardSubmissionDetail);
