'use strict';

// Bounded single-flight cache for immutable shared read projections. A rejected
// loader is never cached; invalidating an in-flight entry cannot resurrect it.
class ReadCache {
  constructor(limit = 256) { this.entries = new Map(); this.limit = limit; }
  get(key, ttl, loader) {
    const current = this.entries.get(key);
    if (current && current.until > Date.now()) return current.promise;
    const entry = { until: Infinity };
    entry.promise = Promise.resolve().then(loader).then(value => {
      entry.until = Date.now() + ttl;
      return value;
    }).catch(error => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
    return entry.promise;
  }
  invalidate(prefix) {
    for (const key of this.entries.keys()) if (String(key).startsWith(String(prefix))) this.entries.delete(key);
  }
}
module.exports = { ReadCache };
