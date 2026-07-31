'use strict';

function createProviderScheduler(options = {}) {
  const now = options.now || (() => Date.now());
  const wait = options.wait || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const chains = new Map();
  const nextAllowedAt = new Map();

  function run(provider, intervalMs, operation) {
    const id = String(provider || '');
    const interval = Math.max(0, Number(intervalMs) || 0);
    const previous = chains.get(id) || Promise.resolve();
    const scheduled = previous.catch(() => {}).then(async () => {
      const remaining = Math.max(0, Number(nextAllowedAt.get(id) || 0) - now());
      if (remaining) await wait(remaining);
      nextAllowedAt.set(id, now() + interval);
      return operation();
    });
    // A failed operation must not permanently stall later work for this provider.
    chains.set(id, scheduled.catch(() => {}));
    return scheduled;
  }

  return { run };
}

module.exports = { createProviderScheduler };
