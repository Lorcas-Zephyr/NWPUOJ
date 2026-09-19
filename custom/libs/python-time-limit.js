'use strict';

const DEFAULT_PYTHON_TIME_LIMIT_MULTIPLIER = 2;
const DEFAULT_JAVA_TIME_LIMIT_MULTIPLIER = 2;

function isPythonLanguage(language) {
  const name = String(language || '').trim().toLowerCase();
  return /^(?:python|pypy)(?:$|[0-9._:-])/.test(name);
}

function isJavaLanguage(language) {
  return /^java(?:$|[0-9._:-])/.test(String(language || '').trim().toLowerCase());
}

// Retain this module's path and Python argument for existing callers.
function effectiveTimeLimit(timeLimit, language, multiplier = DEFAULT_PYTHON_TIME_LIMIT_MULTIPLIER, javaMultiplier = DEFAULT_JAVA_TIME_LIMIT_MULTIPLIER) {
  const base = Number(timeLimit || 0);
  const python = isPythonLanguage(language);
  const java = isJavaLanguage(language);
  if (!python && !java) return base;
  const factor = Number(java ? javaMultiplier : multiplier);
  const fallback = java ? DEFAULT_JAVA_TIME_LIMIT_MULTIPLIER : DEFAULT_PYTHON_TIME_LIMIT_MULTIPLIER;
  const applied = Number.isFinite(factor) && factor > 0 ? factor : fallback;
  return Math.max(1, Math.round(base * applied));
}

module.exports = {
  DEFAULT_PYTHON_TIME_LIMIT_MULTIPLIER,
  DEFAULT_JAVA_TIME_LIMIT_MULTIPLIER,
  effectiveTimeLimit,
  isPythonLanguage,
  isJavaLanguage
};
