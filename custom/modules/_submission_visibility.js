const JudgeState = syzoj.model('judge_state');
const Contest = syzoj.model('contest');
const TypeORM = require('typeorm');

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

async function hasAccessiblePublishedProblemSet(userId, problemId) {
  const rows = await TypeORM.getConnection().query(
    `SELECT 1
       FROM problem_set set_table
       INNER JOIN problem_set_item item ON item.problem_set_id=set_table.id
       LEFT JOIN problem_set_participant participant
         ON participant.problem_set_id=set_table.id AND participant.user_id=?
      WHERE item.problem_id=? AND set_table.status='published'
        AND (set_table.visibility='public' OR participant.user_id IS NOT NULL)
      LIMIT 1`,
    [Number(userId), Number(problemId)]
  );
  return rows.length > 0;
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

async function problemSetSubmissionContext(req, judge, user) {
  if (!user || !req.query || !/^[1-9]\d*$/.test(String(req.query.problem_set || ''))) return false;
  if (typeof syzoj.utils.canManageProblemSet !== 'function') return false;
  const problemSetId = Number(req.query.problem_set);
  const rows = await TypeORM.getConnection().query(
    `SELECT set_table.id,set_table.title,set_table.owner_id,set_table.status,set_table.visibility,set_table.deadline_at,item.ordinal,
            COALESCE(JSON_UNQUOTE(JSON_EXTRACT(version.content_json,'$.title')),problem.title) AS problem_title,
            (participant.user_id IS NOT NULL) AS participant
       FROM problem_set set_table
       INNER JOIN problem_set_submission link ON link.problem_set_id=set_table.id
       INNER JOIN problem_set_item item ON item.problem_set_id=set_table.id AND item.problem_id=link.problem_id
       INNER JOIN problem ON problem.id=link.problem_id
       LEFT JOIN problem_v2_state state ON state.problem_id=problem.id
       LEFT JOIN problem_v2_version version ON version.id=state.current_version_id
       LEFT JOIN problem_set_participant participant ON participant.problem_set_id=set_table.id AND participant.user_id=?
      WHERE set_table.id=? AND link.submission_id=? LIMIT 1`, [Number(user.id), problemSetId, Number(judge.id)]
  );
  if (!rows.length) return null;
  const row = rows[0];
  const manager = await syzoj.utils.canManageProblemSet(row, user, 'problemset:edit');
  const visible = manager || (row.status === 'published' && (row.visibility === 'public' || !!row.participant));
  if (!visible) return null;
  return {
    problemSet: {
      id: Number(row.id),
      title: row.title,
      owner_id: Number(row.owner_id),
      status: row.status,
      visibility: row.visibility,
      deadline_at: row.deadline_at == null ? null : Number(row.deadline_at)
    },
    problemOrdinal: Number(row.ordinal),
    problemTitle: row.problem_title,
    manager
  };
}

syzoj.utils.canViewSubmissionDetail = canViewSubmissionDetail;

const originalAllowedVisit = JudgeState.prototype.isAllowedVisitBy;
if (!JudgeState.prototype.__nwpuAcceptedSourceAccess) {
  JudgeState.prototype.isAllowedVisitBy = async function isAllowedVisitByWithAcceptedSource(user) {
    if (await originalAllowedVisit.call(this, user)) return true;
    return !!(user && Number(this.type) === 0 &&
      await hasValidAcceptedSubmission(user.id, this.problem_id) &&
      await hasAccessiblePublishedProblemSet(user.id, this.problem_id));
  };
  JudgeState.prototype.__nwpuAcceptedSourceAccess = true;
}

async function guardSubmissionDetail(req, res, next) {
  try {
    if (!/^[1-9]\d*$/.test(req.params.id)) {
      return res.status(404).render('error', { err: new ErrorMessage('提交记录 ID 不正确。') });
    }
    const judge = await JudgeState.findById(Number(req.params.id));
    if (!judge) return next();
    const problemSetContext = await problemSetSubmissionContext(req, judge, res.locals.user);
    const acceptedAccess = await canViewSubmissionDetail(judge, res.locals.user);
    if (!(problemSetContext && problemSetContext.manager) && !acceptedAccess) {
      return res.status(403).render('error', {
        err: new ErrorMessage('通过该题后才能查看其他用户的提交详情。')
      });
    }
    if (problemSetContext) res.locals.problemSetSubmissionContext = problemSetContext;
    next();
  } catch (error) {
    syzoj.log('[submission-visibility] ' + (error.stack || error));
    res.status(500).render('error', { err: error });
  }
}

app.get('/submission/:id', guardSubmissionDetail);
app.get('/contest/submission/:id', guardSubmissionDetail);
