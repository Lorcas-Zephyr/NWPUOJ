'use strict';

const DEFAULT_PYTHON_TIME_LIMIT_MULTIPLIER = 2;

function isPythonLanguage(language) {
  const name = String(language || '').trim().toLowerCase();
  return /^(?:python|pypy)(?:$|[0-9._:-])/.test(name);
}

function effectiveTimeLimit(timeLimit, language, multiplier = DEFAULT_PYTHON_TIME_LIMIT_MULTIPLIER) {
  const base = Number(timeLimit || 0);
  if (!isPythonLanguage(language)) return base;
  const factor = Number(multiplier);
  const applied = Number.isFinite(factor) && factor > 0 ? factor : DEFAULT_PYTHON_TIME_LIMIT_MULTIPLIER;
  return Math.max(1, Math.round(base * applied));
}

module.exports = {
  DEFAULT_PYTHON_TIME_LIMIT_MULTIPLIER,
  effectiveTimeLimit,
  isPythonLanguage
};
