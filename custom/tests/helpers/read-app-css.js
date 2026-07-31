'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const sources = [
  'custom/app-shell.css',
  'custom/app-shared.css',
  'custom/app-features.css'
];

module.exports = function readAppCss() {
  return sources.map(source => fs.readFileSync(path.join(root, source), 'utf8')).join('\n');
};
