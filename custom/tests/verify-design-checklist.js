'use strict';

const fs = require('fs');
const path = require('path');

const checklistPath = path.resolve(__dirname, '../../TODO-DESIGN.md');
const source = fs.readFileSync(checklistPath, 'utf8');
const statuses = { x: 0, '~': 0, ' ': 0 };

for (const line of source.split(/\r?\n/)) {
  const match = line.match(/^- \[(x|~| )\] /);
  if (match) statuses[match[1]] += 1;
  else if (/^- \[[^\]]*\] /.test(line)) {
    throw new Error('Invalid design checklist status: ' + line);
  }
}

for (let section = 0; section <= 12; section += 1) {
  if (!source.includes('## ' + section + '.')) {
    throw new Error('Missing design checklist section ' + section);
  }
}

if (!/^Updated: \d{4}-\d{2}-\d{2}$/m.test(source)) {
  throw new Error('Design checklist must contain an ISO updated date');
}
if (!source.includes('## Current Checkpoint')) {
  throw new Error('Design checklist must contain a current checkpoint');
}

const total = statuses.x + statuses['~'] + statuses[' '];
if (!total) throw new Error('Design checklist contains no tracked items');

console.log(
  'Design checklist: ' + total + ' items, ' + statuses.x + ' complete, ' +
  statuses['~'] + ' in progress, ' + statuses[' '] + ' not started.'
);
