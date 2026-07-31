'use strict';

const REQUIRED_ROLLOUT_DOMAINS = Object.freeze(['api', 'problem', 'submission', 'contest', 'rating', 'vjudge', 'content', 'admin']);

function normalizeRollouts(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    domain: String(row.domain || ''),
    enabled: !!row.enabled,
    percentage: Math.max(0, Math.min(100, Number(row.percentage || 0)))
  })).filter(row => row.domain).sort((left, right) => left.domain.localeCompare(right.domain));
}

function sameRollouts(left, right) {
  return JSON.stringify(normalizeRollouts(left)) === JSON.stringify(normalizeRollouts(right));
}

function releaseGate(input) {
  const value = input || {};
  const domains = Array.isArray(value.domains) ? value.domains : [];
  const inconsistentDomains = domains.filter(domain => !domain.consistent).map(domain => domain.domain);
  const completeContestCycles = Math.max(0, Number(value.complete_contest_cycles || 0));
  const archivedContestCycles = Math.max(0, Number(value.archived_contest_cycles || 0));
  const compatibilityStartedAt = value.compatibility_started_at || null;
  const rollbackRehearsedAt = value.rollback_rehearsed_at || null;
  const rollouts = normalizeRollouts(value.rollouts);
  const rolloutByDomain = new Map(rollouts.map(row => [row.domain, row]));
  const incompleteRolloutDomains = REQUIRED_ROLLOUT_DOMAINS.filter(domain => {
    const row = rolloutByDomain.get(domain);
    return !row || !row.enabled || row.percentage !== 100;
  });
  const rollbackRehearsal = value.rollback_rehearsal && typeof value.rollback_rehearsal === 'object' ? value.rollback_rehearsal : null;
  const rollbackRehearsalVerified = !!(rollbackRehearsal && rollbackRehearsal.version === 1 &&
    rollbackRehearsal.disabled_verified && rollbackRehearsal.restored_verified &&
    rollbackRehearsal.consistency_verified && sameRollouts(rollbackRehearsal.rollouts, rollouts));
  const reasons = [];
  if (!compatibilityStartedAt) reasons.push('compatibility_window_not_started');
  if (inconsistentDomains.length) reasons.push('projection_inconsistent');
  if (incompleteRolloutDomains.length) reasons.push('rollout_not_fully_enabled');
  if (completeContestCycles < 1) reasons.push('complete_contest_cycle_not_observed');
  if (!rollbackRehearsedAt) reasons.push('rollback_rehearsal_missing');
  else if (!rollbackRehearsalVerified) reasons.push('rollback_rehearsal_unverified');
  return {
    compatibility_started_at: compatibilityStartedAt,
    compatibility_started_by: value.compatibility_started_by == null ? null : Number(value.compatibility_started_by),
    last_consistency_at: value.last_consistency_at || null,
    complete_contest_cycles: completeContestCycles,
    archived_contest_cycles: archivedContestCycles,
    rollback_rehearsed_at: rollbackRehearsedAt,
    rollback_rehearsed_by: value.rollback_rehearsed_by == null ? null : Number(value.rollback_rehearsed_by),
    rollback_rehearsal_verified: rollbackRehearsalVerified,
    v1_routes_removed: true,
    inconsistent_domains: inconsistentDomains,
    incomplete_rollout_domains: incompleteRolloutDomains,
    rollouts,
    ready_for_v2_release: reasons.length === 0,
    blockers: reasons
  };
}

module.exports = { REQUIRED_ROLLOUT_DOMAINS, normalizeRollouts, sameRollouts, releaseGate };
