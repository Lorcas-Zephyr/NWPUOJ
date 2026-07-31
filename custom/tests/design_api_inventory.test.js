'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');

function documentedRoutes() {
  const design = fs.readFileSync(path.join(root, 'DESIGN.md'), 'utf8');
  const routes = [];
  for (const match of design.matchAll(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/v2\/[^\s#]+)/gm)) {
    routes.push({ method: match[1].toLowerCase(), path: match[2].split('?')[0] });
  }
  return routes;
}

function moduleSource() {
  const directory = path.join(root, 'custom/modules');
  return fs.readdirSync(directory)
    .filter(file => file.endsWith('.js'))
    .map(file => fs.readFileSync(path.join(directory, file), 'utf8'))
    .join('\n');
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function routePattern(route) {
  const target = escapePattern(route.path);
  return new RegExp(`app\\.${route.method}\\(\\s*(?:\\[[^\\]]*?)?['"]${target}['"]`);
}

test('every API route documented by DESIGN.md is registered with its declared HTTP method', () => {
  const routes = documentedRoutes();
  const source = moduleSource();
  const unique = new Map(routes.map(route => [`${route.method} ${route.path}`, route]));
  const missing = Array.from(unique.values()).filter(route => !routePattern(route).test(source));

  assert.equal(routes.length >= 100, true, 'the design API catalog unexpectedly shrank');
  assert.deepEqual(missing, []);
});
