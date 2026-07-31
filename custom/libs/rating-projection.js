'use strict';

function finite(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`Invalid Rating projection field: ${field}.`);
  return number;
}

function normalizeProjection(value) {
  if (!value || typeof value !== 'object') throw new TypeError('Rating projection is required.');
  return {
    rating: Math.round(finite(value.rating, 'rating')),
    deviation: finite(value.deviation, 'deviation'),
    volatility: finite(value.volatility, 'volatility')
  };
}

function sameProjection(left, right) {
  if (!left || !right) return false;
  const normalizedLeft = normalizeProjection(left);
  const normalizedRight = normalizeProjection(right);
  return normalizedLeft.rating === normalizedRight.rating &&
    Math.abs(normalizedLeft.deviation - normalizedRight.deviation) <= 0.000001 &&
    Math.abs(normalizedLeft.volatility - normalizedRight.volatility) <= 0.000000001;
}

function projectionDifference({ userId, sourceEventId, before, after }) {
  const normalizedUserId = Number(userId);
  if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId < 1) throw new TypeError('Invalid Rating projection user.');
  const normalizedBefore = normalizeProjection(before);
  const normalizedAfter = normalizeProjection(after);
  if (sameProjection(normalizedBefore, normalizedAfter)) return null;
  return {
    user_id: normalizedUserId,
    source_event_id: String(sourceEventId),
    before: normalizedBefore,
    after: normalizedAfter
  };
}

function rollbackIsCurrent(current, item) {
  return !!(item && item.after) && sameProjection(current, item.after);
}

module.exports = { normalizeProjection, projectionDifference, rollbackIsCurrent, sameProjection };
