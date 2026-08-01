// 提交记录的管理员动作:取消评测 / 判定作弊
// 文件名以 _ 开头,确保字母序较早加载
let JudgeState = syzoj.model('judge_state');
let JudgeStateAdminAction = syzoj.model('judge-state-admin-action');
let User = syzoj.model('user');
let Contest = syzoj.model('contest');
const TypeORM = require('typeorm');
const contestMutation = require('../libs/contest-mutation');
const judger = require('../libs/judger');

// 全局缓存:被标记过的 judge_id 集合(给 Vue 组件 + judger.js 用)
syzoj.cheatedJudgeIds = new Set();
syzoj.cancelledJudgeIds = new Set();

async function refreshAdminActionCache() {
  try {
    let rows = await JudgeStateAdminAction.find({});
    let cheated = new Set();
    let cancelled = new Set();
    let cheaters = new Set();
    for (let r of rows) {
      if (r.action_type === 'cheated') {
        cheated.add(r.judge_id);
        if (r.affected_user_id) cheaters.add(r.affected_user_id);
      } else if (r.action_type === 'cancelled') {
        cancelled.add(r.judge_id);
      }
    }
    syzoj.cheatedJudgeIds = cheated;
    syzoj.cancelledJudgeIds = cancelled;
    syzoj.cheaterUserIds = cheaters;
  } catch (e) {
    syzoj.log('[judge-admin-action] cache refresh failed: ' + e.message);
  }
}
setTimeout(refreshAdminActionCache, 1000);
setInterval(refreshAdminActionCache, 60 * 1000);
syzoj.utils.refreshJudgeAdminActionCache = refreshAdminActionCache;

async function canManageJudgeAction(user, judge) {
  if (!user || !judge) return false;
  const scope = Number(judge.type) === 1 ? `contest:${judge.type_info}` : `problem:${judge.problem_id}`;
  if (await syzoj.utils.authorizationV2.authorize(user, 'submission:rejudge', { scope }, { scope })) return true;
  if (Number(judge.type) !== 1) return false;
  const contest = await Contest.findById(Number(judge.type_info));
  if (!contest || !await contest.isSupervisior(user)) return false;
  return syzoj.utils.authorizationV2.authorize(user, 'contest:edit', {
    id: contest.id,
    ownerId: contest.holder_id,
    scope: `contest:${contest.id}`
  }, { scope: `contest:${contest.id}` });
}

function operationReason(req) {
  return syzoj.utils.operationReason(req, '提交评测管理操作').slice(0, 255);
}

function requireRecentLogin(req) {
  if (!syzoj.utils.authorizationV2.recentLoginSatisfied(req)) {
    throw new ErrorMessage('这是高风险操作，请重新登录后继续。');
  }
}

async function auditJudgeAction(req, judge, action, reason, details) {
  const scope = Number(judge.type) === 1 ? `contest:${judge.type_info}` : `problem:${judge.problem_id}`;
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
    action,
    resourceType: 'submission',
    resourceId: judge.id,
    scope,
    reason,
    details: Object.assign({ problem_id: Number(judge.problem_id), user_id: Number(judge.user_id) }, details || {})
  });
  await syzoj.utils.apiV2.appendEvent({
    stream: `submission:${judge.id}`,
    type: action.replace(':', '.'),
    aggregateId: judge.id,
    actor: req.res.locals.user,
    payload: Object.assign({ submission_id: Number(judge.id), reason, audit_event_id: auditEventId }, details || {})
  });
  req.res.setHeader('X-Audit-Event-ID', auditEventId);
  return auditEventId;
}

syzoj.utils.canManageJudgeAction = canManageJudgeAction;

async function hasOtherValidAcceptedSubmission(userId, problemId, excludeJudgeId) {
  let qb = JudgeState.createQueryBuilder('js')
    .leftJoin('judge_state_admin_action', 'a', 'a.judge_id = js.id')
    .where('js.user_id = :uid', { uid: userId })
    .andWhere('js.problem_id = :pid', { pid: problemId })
    .andWhere('js.status = :st', { st: 'Accepted' })
    .andWhere('js.type != :contestType', { contestType: 1 })
    .andWhere('js.id <> :ex', { ex: excludeJudgeId })
    .andWhere('a.judge_id IS NULL');
  let cnt = await qb.getCount();
  return cnt > 0;
}

async function rebuildAffectedStatistics(judge, skipContestLock) {
  if (judge.type === 1) {
    const rebuilt = await contestMutation.rebuildContestPlayer(
      Number(judge.type_info),
      Number(judge.user_id),
      { skipLock: !!skipContestLock }
    );
    if (!rebuilt) throw new ErrorMessage('比赛排行榜已锁定，不能修改该提交。');
    return;
  }
  const connection = TypeORM.getConnection();
  await connection.query(
    `UPDATE user SET ac_num=(
       SELECT COUNT(DISTINCT js.problem_id) FROM judge_state js
       LEFT JOIN judge_state_admin_action action ON action.judge_id=js.id
       WHERE js.user_id=? AND js.type!=1 AND js.status='Accepted' AND action.judge_id IS NULL
     ) WHERE id=?`,
    [judge.user_id, judge.user_id]
  );
  await connection.query(
    `UPDATE problem SET
       submit_num=(SELECT COUNT(*) FROM judge_state js WHERE js.problem_id=? AND js.type!=1),
       ac_num=(SELECT COUNT(*) FROM judge_state js
         LEFT JOIN judge_state_admin_action action ON action.judge_id=js.id
         WHERE js.problem_id=? AND js.type!=1 AND js.status='Accepted' AND action.judge_id IS NULL)
     WHERE id=?`,
    [judge.problem_id, judge.problem_id, judge.problem_id]
  );
}

// ============ 判定作弊 / 取消评测 ============
app.post('/api/v2/submissions/:id/admin-actions', async (req, res) => {
  const api = syzoj.utils.apiV2;
  try {
    if (!res.locals.user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
    let id = parseInt(req.params.id);
    let actionType = (req.body.action_type || '').trim();

    if (!['cancelled', 'cheated'].includes(actionType)) {
      throw new ErrorMessage('无效的操作类型。');
    }

    let judge = await JudgeState.findById(id);
    if (!judge) throw new ErrorMessage('无此提交记录。');
    if (!await canManageJudgeAction(res.locals.user, judge)) throw new ErrorMessage('您没有权限进行此操作。');
    requireRecentLogin(req);
    const reason = operationReason(req);

    let existing = await JudgeStateAdminAction.findOne({ where: { judge_id: id } });
    if (existing) {
      throw new ErrorMessage('该提交已被标记为「' + (existing.action_type === 'cancelled' ? '取消评测' : '作弊') + '」。请先撤销当前标记。');
    }

    let now = parseInt((new Date()).getTime() / 1000);
    let wasAccepted = (judge.status === 'Accepted');
    const previousStatus = judge.status;

    let action = await JudgeStateAdminAction.create();
    action.judge_id = id;
    action.action_type = actionType;
    action.operator_id = res.locals.user.id;
    action.operator_time = now;
    action.reason = reason;
    action.was_accepted = wasAccepted;
    action.affected_problem_id = judge.problem_id;
    action.affected_user_id = judge.user_id;
    await action.save();

    // 同步调整 ac_num
    if (wasAccepted) {
      let hasOther = await hasOtherValidAcceptedSubmission(judge.user_id, judge.problem_id, id);
      if (!hasOther) {
        let user = await User.findById(judge.user_id);
        if (user && user.ac_num > 0) {
          user.ac_num = user.ac_num - 1;
          await user.save();
        }
      }
    }

    // 取消评测立即写库为 Cancelled, 防止 daemon 后续返回结果覆盖
    if (actionType === 'cancelled') {
      judge.status = 'Cancelled';
      judge.pending = false;
      judge.score = 0;
      judge.result = null;
      await judge.save();
    }
    judger.emitJudgeStateChange(judge.task_id);
    await rebuildAffectedStatistics(judge, res.locals.contestMutationLockHeld);

    // 立刻刷新缓存
    await refreshAdminActionCache();
    if (syzoj.utils.refreshContestCheaterCache) await syzoj.utils.refreshContestCheaterCache();
    await auditJudgeAction(req, judge, `submission:${actionType}`, reason, { action_type: actionType, previous_status: previousStatus });

    return api.send(res, { submission_id: id, action_type: actionType, status: actionType, audit_recorded: true }, 201);
  } catch (e) {
    syzoj.log(e);
    return api.fail(res, e.statusCode || 409, e.code || 'SUBMISSION_ADMIN_ACTION_FAILED', e.message);
  }
});

// ============ 撤销标记 ============
app.delete('/api/v2/submissions/:id/admin-actions', async (req, res) => {
  const api = syzoj.utils.apiV2;
  try {
    if (!res.locals.user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
    let id = parseInt(req.params.id);
    let action = await JudgeStateAdminAction.findOne({ where: { judge_id: id } });
    if (!action) throw new ErrorMessage('该提交并未被标记。');

    let judge = await JudgeState.findById(id);
    if (!judge) throw new ErrorMessage('无此提交记录。');
    if (!await canManageJudgeAction(res.locals.user, judge)) throw new ErrorMessage('您没有权限进行此操作。');
    requireRecentLogin(req);
    const reason = operationReason(req);
    const revokedType = action.action_type;

    let wasCancelled = (action.action_type === 'cancelled');

    // 如果当初是 AC 提交且因标记减过 ac_num,现在恢复
    if (action.was_accepted && action.affected_user_id && action.affected_problem_id) {
      let hasOther = await hasOtherValidAcceptedSubmission(action.affected_user_id, action.affected_problem_id, id);
      if (!hasOther && judge.status === 'Accepted') {
        let user = await User.findById(action.affected_user_id);
        if (user) {
          user.ac_num = (user.ac_num || 0) + 1;
          await user.save();
        }
      }
    }

    await action.destroy();
    judger.emitJudgeStateChange(judge.task_id);
    await rebuildAffectedStatistics(judge, res.locals.contestMutationLockHeld);
    await refreshAdminActionCache();
    if (syzoj.utils.refreshContestCheaterCache) await syzoj.utils.refreshContestCheaterCache();
    await auditJudgeAction(req, judge, 'submission:admin-action.revoke', reason, { revoked_action_type: revokedType });

    // 撤销 cancelled 标记后,db 状态保持 Cancelled
    // 因为评测结果已经在取消时被丢弃,无法恢复。用户需要重新提交。
    // 这里不做任何 status 操作,保留 Cancelled 状态作为历史记录。

    return api.send(res, { submission_id: id, revoked: true, previous_action_type: revokedType });
  } catch (e) {
    syzoj.log(e);
    return api.fail(res, e.statusCode || 409, e.code || 'SUBMISSION_ADMIN_ACTION_REVOKE_FAILED', e.message);
  }
});

// 暴露给其他模块用的工具:批量查询某些 judge_id 是否被标记
syzoj.utils.getJudgeAdminActions = async function(judgeIds) {
  if (!judgeIds || judgeIds.length === 0) return {};
  let rows = await JudgeStateAdminAction.createQueryBuilder()
    .where('judge_id IN (:...ids)', { ids: judgeIds })
    .getMany();
  let map = {};
  for (let r of rows) {
    map[r.judge_id] = {
      action_type: r.action_type,
      operator_id: r.operator_id,
      operator_time: r.operator_time,
      reason: r.reason
    };
  }
  return map;
};


// ============ 重新评测(Cancelled 状态恢复) ============
// 仅适用于 Cancelled 状态的提交
// 取消标记属于管理员操作，只能由管理员清除。
app.post('/api/v2/submissions/:id/restore-and-rejudge', async (req, res) => {
  const api = syzoj.utils.apiV2;
  try {
    if (!res.locals.user) return api.fail(res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');

    let id = parseInt(req.params.id);
    let judge = await JudgeState.findById(id);
    if (!judge) throw new ErrorMessage('无此提交记录。');

    if (!await canManageJudgeAction(res.locals.user, judge)) throw new ErrorMessage('您没有权限重新评测此提交。');
    requireRecentLogin(req);
    const reason = operationReason(req);

    if (judge.status !== 'Cancelled') {
      throw new ErrorMessage('仅可对已取消评测的提交使用此操作。');
    }

    // 删除 admin_action 记录
    let action = await JudgeStateAdminAction.findOne({ where: { judge_id: id } });
    if (action) await action.destroy();

    await refreshAdminActionCache();
    if (syzoj.utils.refreshContestCheaterCache) await syzoj.utils.refreshContestCheaterCache();

    await syzoj.utils.rejudgeSubmissionWithCurrentSnapshot(judge, res.locals.user.id);
    await rebuildAffectedStatistics(judge, res.locals.contestMutationLockHeld);
    await auditJudgeAction(req, judge, 'submission:restore-and-rejudge', reason, { previous_status: 'Cancelled' });

    return api.send(res, { submission_id: id, restored: true, rejudged: true }, 202);
  } catch (e) {
    syzoj.log(e);
    return api.fail(res, e.statusCode || 409, e.code || 'SUBMISSION_RESTORE_REJUDGE_FAILED', e.message);
  }
});
