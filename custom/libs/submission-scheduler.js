'use strict';

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function languageSlots(config, language) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 1;
  return positiveNumber(config[language], positiveNumber(config.default, 1));
}

function queuedScore(row, activeByLanguage, slotConfig, now) {
  const language = String(row.language || 'unknown');
  const active = Math.max(0, Number(activeByLanguage[language] || 0));
  const slots = languageSlots(slotConfig, language);
  const created = new Date(row.created_at || 0).getTime();
  const age = Number.isFinite(created) ? Math.max(0, now - created) : 0;
  const pressurePenalty = active / slots * 60000;
  return age - pressurePenalty;
}

function rankQueuedSubmissions(rows, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const activeByLanguage = options.activeByLanguage || {};
  const slotConfig = options.languageSlots || {};
  const limit = Math.max(1, Number.parseInt(options.limit, 10) || 20);
  const ranked = Array.from(rows || []).map(row => ({
    row,
    contest: row.contest_id == null ? 0 : 1,
    score: queuedScore(row, activeByLanguage, slotConfig, now)
  })).sort((left, right) =>
    right.contest - left.contest ||
    right.score - left.score ||
    Number(left.row.submission_id) - Number(right.row.submission_id)
  );
  const users = new Set();
  const selected = [];
  for (const item of ranked) {
    const userId = Number(item.row.user_id || 0);
    if (users.has(userId)) continue;
    users.add(userId);
    selected.push(item.row);
    if (selected.length >= limit) break;
  }
  return selected;
}

module.exports = { languageSlots, queuedScore, rankQueuedSubmissions };
