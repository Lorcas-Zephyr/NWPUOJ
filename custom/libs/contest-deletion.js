'use strict';

const contestRating = require('./contest-rating');

const Contest = syzoj.model('contest');

async function canDeleteContest(user, contest) {
  if (!user || !contest) return false;
  const resource = { id: contest.id, ownerId: contest.holder_id, scope: `contest:${contest.id}` };
  if (await syzoj.utils.authorizationV2.authorize(user, 'contest:publish', resource, { scope: resource.scope })) return true;
  return syzoj.utils.authorizationV2.authorize(user, 'contest:publish', null, { scope: 'global' });
}

async function deleteContest(req, contest, actor) {
  const reason = syzoj.utils.operationReason(req, '删除比赛');
  const recalculation = await contestRating.deleteContestAndRecalculate(contest.id, { actorId: actor.id });
  const auditEventId = await syzoj.utils.authorizationV2.recordAudit(req, {
    action: 'contest:delete',
    resourceType: 'contest',
    resourceId: contest.id,
    scope: `contest:${contest.id}`,
    reason,
    details: {
      title: contest.title,
      recalculated_contests: recalculation.contestCount,
      affected_users: recalculation.userIds.length,
      compatibility_cycle_evidence: recalculation.cycleEvidence
    }
  });
  await syzoj.utils.apiV2.appendEvent({
    stream: `contest:${contest.id}`,
    type: 'contest.deleted',
    aggregateId: contest.id,
    actor,
    payload: {
      reason,
      audit_event_id: auditEventId,
      recalculated_contests: recalculation.contestCount,
      affected_users: recalculation.userIds.length,
      compatibility_cycle_evidence: recalculation.cycleEvidence
    }
  });
  Contest.deleteFromCache(contest.id);
  if (syzoj.utils.expireTemporaryContestAccounts) await syzoj.utils.expireTemporaryContestAccounts(contest.id);
  if (syzoj.utils.invalidateContestReadCache) syzoj.utils.invalidateContestReadCache(contest.id);
  if (syzoj.utils.refreshJudgeAdminActionCache) await syzoj.utils.refreshJudgeAdminActionCache();
  if (syzoj.utils.refreshContestCheaterCache) await syzoj.utils.refreshContestCheaterCache();
  return {
    contest_id: Number(contest.id),
    title: contest.title,
    recalculated_contests: Number(recalculation.contestCount || 0),
    affected_users: recalculation.userIds.length,
    compatibility_cycle_evidence: recalculation.cycleEvidence,
    audit_event_id: auditEventId
  };
}

module.exports = { canDeleteContest, deleteContest };
