'use strict';
const { AsyncLocalStorage } = require('async_hooks');
const reads = new AsyncLocalStorage();

function middleware(req, res, next) {
  // Never memoize writes, transactions or a long-lived stream's authorization.
  if (!['GET', 'HEAD'].includes(req.method) || /\/events$/.test(req.path)) return next();
  return reads.run(new Map(), next);
}
function memo(key, loader) {
  const cache = reads.getStore();
  if (!cache) return loader();
  if (!cache.has(key)) cache.set(key, Promise.resolve().then(loader).catch(error => { cache.delete(key); throw error; }));
  return cache.get(key);
}
module.exports = { middleware, memo };
