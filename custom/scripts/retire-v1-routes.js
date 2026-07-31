'use strict';

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const root = path.resolve(__dirname, '..', '..');
const defaultModulesRoot = path.join(root, 'custom', 'modules');
const writeMethods = new Set(['post', 'put', 'patch', 'delete']);
const routeMethods = new Set(['get', ...writeMethods]);
const approvedCallbacks = new Set(['/judge']);

function routePaths(node) {
  if (!node) return [];
  if (node.type === 'Literal' && typeof node.value === 'string') return [node.value];
  if (node.type !== 'ArrayExpression') return [];
  return node.elements.flatMap(routePaths);
}

function routeRegistration(statement) {
  if (!statement || statement.type !== 'ExpressionStatement') return null;
  const call = statement.expression;
  if (!call || call.type !== 'CallExpression') return null;
  const callee = call.callee;
  if (!callee || callee.type !== 'MemberExpression' || callee.computed) return null;
  if (!callee.object || callee.object.type !== 'Identifier' || callee.object.name !== 'app') return null;
  if (!callee.property || callee.property.type !== 'Identifier' || !routeMethods.has(callee.property.name)) return null;
  const paths = routePaths(call.arguments[0]);
  if (!paths.length) return null;
  return { statement, call, method: callee.property.name.toUpperCase(), paths };
}

function retireRoute(method, route) {
  if (approvedCallbacks.has(route) || route.startsWith('/api/v2')) return false;
  if (method === 'GET') return route.startsWith('/api/');
  return writeMethods.has(method.toLowerCase());
}

function scanFile(filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const acornMajor = Number(String(acorn.version || '6').split('.')[0]);
  const ast = acorn.parse(source, { ecmaVersion: acornMajor >= 7 ? 'latest' : 2019, sourceType: 'script', allowHashBang: true });
  const edits = [];
  const retired = [];
  for (const statement of ast.body) {
    const registration = routeRegistration(statement);
    if (!registration) continue;
    const v1Paths = registration.paths.filter(route => retireRoute(registration.method, route));
    if (!v1Paths.length) continue;
    const retainedPaths = registration.paths.filter(route => !v1Paths.includes(route));
    retired.push(...v1Paths.map(route => `${registration.method} ${route}`));
    if (retainedPaths.length) {
      const replacement = retainedPaths.length === 1 ? JSON.stringify(retainedPaths[0]) : `[${retainedPaths.map(JSON.stringify).join(', ')}]`;
      edits.push({ start: registration.call.arguments[0].start, end: registration.call.arguments[0].end, replacement });
    } else {
      let end = statement.end;
      while (end < source.length && (source[end] === ' ' || source[end] === '\t')) end++;
      if (source[end] === '\r') end++;
      if (source[end] === '\n') end++;
      edits.push({ start: statement.start, end, replacement: '' });
    }
  }
  let output = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
  }
  return { source, output, edits, retired };
}

function main() {
  const write = process.argv.includes('--write');
  const rootArgument = process.argv.find(argument => argument.startsWith('--modules-root='));
  const modulesRoot = rootArgument ? path.resolve(rootArgument.slice('--modules-root='.length)) : defaultModulesRoot;
  if (!fs.existsSync(modulesRoot)) throw new Error(`Modules directory does not exist: ${modulesRoot}`);
  let changedFiles = 0;
  let retiredRoutes = 0;
  for (const entry of fs.readdirSync(modulesRoot).filter(name => name.endsWith('.js')).sort()) {
    const filename = path.join(modulesRoot, entry);
    const result = scanFile(filename);
    if (!result.edits.length) continue;
    changedFiles++;
    retiredRoutes += result.retired.length;
    console.log(`${write ? 'retired' : 'would retire'} ${entry}: ${result.retired.join(', ')}`);
    if (write) fs.writeFileSync(filename, result.output);
  }
  console.log(`${write ? 'retired' : 'would retire'} ${retiredRoutes} v1 route registrations in ${changedFiles} modules`);
}

if (require.main === module) main();

module.exports = { routePaths, scanFile, routeRegistration, retireRoute };
