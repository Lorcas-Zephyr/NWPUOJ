'use strict';

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function item(domain, legacy, projected, details) {
  const migrationDomain = {
    identity: 'identity',
    problems: 'problem',
    submissions: 'submission',
    contests: 'contest',
    ratings: 'rating'
  }[domain] || domain;
  const normalizedDetails = Object.fromEntries(Object.entries(details || {}).map(([key, value]) => [key, nonNegativeNumber(value)]));
  const normalizedLegacy = nonNegativeNumber(legacy);
  const normalizedProjected = nonNegativeNumber(projected);
  return {
    domain,
    migration_domain: migrationDomain,
    legacy: normalizedLegacy,
    projected: normalizedProjected,
    details: normalizedDetails,
    consistent: normalizedLegacy === normalizedProjected && Object.values(normalizedDetails).every(value => value === 0)
  };
}

module.exports = { item };
