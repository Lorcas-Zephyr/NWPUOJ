'use strict';
// Activated only by a trusted answer-file header, never contestant output.
const HEADER = /^NOJ_FIXED_GROUP_V1 (\d+) (\d+) (\d+) (\d+) (\d+)\s*$/;
const METRIC = /^NOJ_FIXED_GROUP_V1 (\d+) (\d+) (\d+) (\d+) (\d+) (\d+)\s*$/;
function parse(text, expression) {
  const m = expression.exec(String(text || '').trim());
  if (!m) return null;
  const values = m.slice(1).map(Number);
  return values.every(x => Number.isSafeInteger(x) && x > 0) ? values : null;
}
function applyFixedGroupScoring(source) {
  if (!source || !source.judge || !Array.isArray(source.judge.subtasks)) return false;
  let activated = false;
  for (const group of source.judge.subtasks) {
    const cases = group.cases || [];
    const headers = cases.map(c => parse(c.result && c.result.output && c.result.output.content, HEADER));
    const first = headers.find(Boolean);
    if (!first) continue;
    activated = true;
    group.score = 0;
    delete group.fixedScore;
    if (headers.some(h => !h) || cases.some(c => c.status !== 2)) continue;
    const [id, weight, , count] = first;
    if (weight > 100 || count !== cases.length || headers.some(h => h[0] !== id || h[1] !== weight || h[3] !== count || h[2] > count) || new Set(headers.map(h => h[2])).size !== count) continue;
    const metrics = cases.map(c => parse(c.result.spjMessage, METRIC));
    if (metrics.some((m, i) => !m || m.slice(0, 5).some((v, j) => v !== headers[i][j])) || cases.some(c => ![1, 3].includes(c.result.type))) continue;
    const baseline = headers.reduce((s, h) => s + h[4], 0);
    const actual = metrics.reduce((s, m) => s + m[5], 0);
    if (!Number.isSafeInteger(baseline) || !Number.isSafeInteger(actual)) continue;
    const raw = weight * (0.2 + 0.8 * Math.min(1, baseline / actual));
    group.score = Number(raw.toFixed(6));
    group.fixedScore = { baseline, actual, raw, policy: 'fixed-baseline-v1' };
    for (const c of cases) { c.result.type = actual <= baseline ? 1 : 3; c.result.scoringRate = raw / weight; }
  }
  if (activated) {
    source.judge.fixedGroupTotal = source.judge.subtasks.reduce((s, g) => s + (g.fixedScore ? g.fixedScore.raw : Number(g.score) || 0), 0);
  }
  return activated;
}
module.exports = { applyFixedGroupScoring };
