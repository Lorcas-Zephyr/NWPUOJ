'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const customRoot = path.join(root, 'custom');

function walk(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'uploads' || entry.name === 'tests') continue;
      result.push(...walk(filename));
    }
    else if (/\.(?:js|ejs)$/.test(entry.name)) result.push(filename);
  }
  return result;
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

function stringValue(source, start) {
  const quote = source[start];
  let value = '';
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index];
    if (character === '\\') {
      value += source[index + 1] || '';
      index++;
    } else if (character === quote) {
      return { value, end: index + 1 };
    } else {
      value += character;
    }
  }
  return null;
}

function firstArgument(source, openIndex) {
  let depth = 0;
  let quote = null;
  let template = false;
  for (let index = openIndex + 1; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === '\\') index++;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '`') { template = !template; continue; }
    if (template) continue;
    if (character === '\'' || character === '"') { quote = character; continue; }
    if (character === '(' || character === '[' || character === '{') { depth++; continue; }
    if (character === ')' && depth === 0) return source.slice(openIndex + 1, index);
    if (character === ']' || character === '}' || character === ')') { depth--; continue; }
    if (character === ',' && depth === 0) return source.slice(openIndex + 1, index);
  }
  return source.slice(openIndex + 1);
}

function literalPaths(argument) {
  const paths = [];
  for (let index = 0; index < argument.length; index++) {
    if (argument[index] !== '\'' && argument[index] !== '"') continue;
    const parsed = stringValue(argument, index);
    if (!parsed) continue;
    if (parsed.value.startsWith('/')) paths.push(parsed.value);
    index = parsed.end - 1;
  }
  return paths;
}

function routeRegistrations(filename, source) {
  const routes = [];
  const call = /\bapp\.(get|post|put|patch|delete)\s*\(/g;
  for (const match of source.matchAll(call)) {
    const argument = firstArgument(source, match.index + match[0].length - 1);
    for (const route of literalPaths(argument)) routes.push({ method: match[1].toUpperCase(), route, source: path.relative(root, filename), line: lineNumber(source, match.index) });
  }
  return routes;
}

function literalCalls(filename, source, expression, kind) {
  const calls = [];
  for (const match of source.matchAll(expression)) {
    const parsed = stringValue(source, match.index + match[0].length - 1);
    if (!parsed || !parsed.value.startsWith('/')) continue;
    // Page navigations are owned by the server-rendered shell. The compatibility
    // inventory is for JSON/client contracts, so retain only API-shaped calls.
    if (!parsed.value.startsWith('/api/')) continue;
    if (parsed.value.startsWith('/api/v2')) continue;
    calls.push({ kind, method: kind === 'fetch' ? 'GET/WRITE' : null, route: parsed.value, source: path.relative(root, filename), line: lineNumber(source, match.index) });
  }
  return calls;
}

function makeUrlExpression(filename, source, attribute, kind) {
  const calls = [];
  const pattern = new RegExp(`${attribute}\\s*=\\s*["']<%=\\s*syzoj\\.utils\\.makeUrl\\(\\[([^\\]]+)\\]`, 'g');
  for (const match of source.matchAll(pattern)) {
    const parts = match[1].split(',').map(part => {
      const literal = part.trim().match(/^['"]([^'"]+)['"]$/);
      return literal ? literal[1] : ':param';
    });
    if (!parts.length) continue;
    const route = '/' + parts.join('/');
    if (route.startsWith('/api/v2')) continue;
    calls.push({ kind, method: 'POST/WRITE', route, expression: `makeUrl([${match[1]}])`, source: path.relative(root, filename), line: lineNumber(source, match.index) });
  }
  return calls;
}

function openingForms(source) {
  const forms = [];
  let cursor = 0;
  while ((cursor = source.indexOf('<form', cursor)) !== -1) {
    const start = cursor;
    let quote = null;
    cursor += 5;
    for (; cursor < source.length; cursor++) {
      const character = source[cursor];
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === '>') {
        forms.push({ start, source: source.slice(start, cursor + 1) });
        cursor++;
        break;
      }
    }
  }
  return forms;
}

function formRegistrations(filename, source) {
  const forms = [];
  for (const form of openingForms(source)) {
    const tag = form.source;
    const methodMatch = tag.match(/\bmethod\s*=\s*(["'])(.*?)\1/i);
    const method = (methodMatch ? methodMatch[2] : 'GET').trim().toUpperCase();
    const actionMatch = tag.match(/\baction\s*=\s*(["'])(.*?)\1/i);
    let route = actionMatch ? actionMatch[2] : '';
    let expression;
    if (!route) {
      const makeUrlMatch = tag.match(/\baction\s*=\s*["']<%=\s*syzoj\.utils\.makeUrl\(\[([^\]]+)\]/i);
      if (makeUrlMatch) {
        const parts = makeUrlMatch[1].split(',').map(part => {
          const literal = part.trim().match(/^['"]([^'"]+)['"]$/);
          return literal ? literal[1] : ':param';
        });
        route = '/' + parts.join('/');
        expression = `makeUrl([${makeUrlMatch[1]}])`;
      }
    }
    const v2Owned = /\bdata-[\w:-]*v2[\w:-]*(?:\s|=|>|<)/i.test(tag);
    if (!route && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      if (v2Owned) continue;
      route = '(implicit-current-page)';
    }
    if (!route || route.startsWith('/api/v2')) continue;
    if (!route.startsWith('/') && route !== '(implicit-current-page)') continue;
    forms.push({
      kind: 'form',
      method,
      route,
      implicit: route === '(implicit-current-page)',
      ...(expression ? { expression } : {}),
      source: path.relative(root, filename),
      line: lineNumber(source, form.start)
    });
  }
  return forms;
}

function discover() {
  const files = walk(customRoot);
  const routes = [];
  const forms = [];
  const clients = [];
  for (const filename of files) {
    const source = fs.readFileSync(filename, 'utf8');
    if (filename.includes(`${path.sep}modules${path.sep}`) || /custom\/[^/]+\.js$/.test(path.relative(root, filename))) routes.push(...routeRegistrations(filename, source));
    if (filename.endsWith('.ejs')) {
      forms.push(...formRegistrations(filename, source));
      clients.push(...makeUrlExpression(filename, source, 'href-post', 'href-post'));
    }
    clients.push(...literalCalls(filename, source, /\bfetch\s*\(\s*(["'])/g, 'fetch'));
    clients.push(...literalCalls(filename, source, /\b(?:url|href)\s*:\s*(["'])/g, 'url'));
  }
  const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const approvedCallbackShapes = new Set(['POST /judge']);
  const nonV2Routes = routes.filter(item => !item.route.startsWith('/api/v2'));
  const frontendPageRoutes = nonV2Routes.filter(item => item.method === 'GET' && !item.route.startsWith('/api/'));
  const v1ApiReads = nonV2Routes.filter(item => item.method === 'GET' && item.route.startsWith('/api/'));
  const approvedCallbacks = nonV2Routes.filter(item => approvedCallbackShapes.has(`${item.method} ${item.route}`));
  const v1WriteRoutes = nonV2Routes.filter(item => writeMethods.has(item.method) && !approvedCallbackShapes.has(`${item.method} ${item.route}`));
  const v1WriteForms = forms.filter(item => writeMethods.has(item.method) && !item.route.startsWith('/api/v2'));
  const v1ClientCalls = clients.filter(item => !item.route.startsWith('/api/v2'));
  return {
    generated_at: new Date().toISOString(),
    frontend_page_routes: frontendPageRoutes,
    v1_api_reads: v1ApiReads,
    v1_write_routes: v1WriteRoutes,
    v1_write_forms: v1WriteForms,
    v1_client_calls: v1ClientCalls,
    approved_runtime_callbacks: approvedCallbacks,
    compatibility_adapters: [],
    summary: {
      frontend_page_route_registrations: frontendPageRoutes.length,
      frontend_page_route_shapes: new Set(frontendPageRoutes.map(item => `${item.method} ${item.route}`)).size,
      v1_api_reads: v1ApiReads.length,
      v1_write_routes: v1WriteRoutes.length,
      v1_write_route_shapes: new Set(v1WriteRoutes.map(item => `${item.method} ${item.route}`)).size,
      v1_write_forms: v1WriteForms.length,
      v1_client_calls: v1ClientCalls.length,
      approved_runtime_callbacks: approvedCallbacks.length,
      compatibility_adapters: 0
    }
  };
}

if (require.main === module) {
  const inventory = discover();
  if (process.argv.includes('--write')) {
    const target = path.join(root, 'COMPATIBILITY-INVENTORY.json');
    fs.writeFileSync(target, `${JSON.stringify(inventory, null, 2)}\n`);
    console.log(`wrote ${target}`);
  }
  console.log(JSON.stringify(inventory.summary, null, 2));
}

module.exports = { discover, firstArgument, literalPaths, openingForms, formRegistrations };
