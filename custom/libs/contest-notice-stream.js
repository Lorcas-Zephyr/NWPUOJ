'use strict';

// Broadcast invalidations only, NEVER notice contents, IDs or user information.
// Clients fetch the content through a fresh authenticated HTTP request. This
// keeps revocation effective even if an existing socket outlives permission.
class ContestNoticeStream {
  constructor() { this.contests = new Map(); }
  publish(contestId) {
    const clients = this.contests.get(Number(contestId));
    if (clients) for (const client of Array.from(clients)) client.write('changed');
  }
  attach(req, res, contestId) {
    const id = Number(contestId);
    if (!this.contests.has(id)) this.contests.set(id, new Set());
    const clients = this.contests.get(id);
    let closed = false;
    let heartbeat, lifetime;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      clients.delete(client);
      if (!clients.size) this.contests.delete(id);
    };
    const finish = () => { cleanup(); if (!res.destroyed) res.end(); };
    const client = { write(event) {
      if (closed) return;
      // Disconnect slow clients instead of keeping unbounded response buffers.
      try { if (!res.write(`event: ${event}\ndata: {}\n\n`)) finish(); }
      catch (_) { cleanup(); if (typeof res.destroy === 'function') res.destroy(); }
    } };
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'private, no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.on('close', cleanup);
    req.on('aborted', cleanup);
    clients.add(client);
    // ready triggers a fresh unread/history sync, so every reconnect catches up.
    client.write('ready');
    if (!closed) {
      heartbeat = setInterval(() => client.write('heartbeat'), 15000);
      // Renew sessions/visibility periodically, without querying on heartbeats.
      lifetime = setTimeout(() => { client.write('renew'); finish(); }, 120000 + Math.floor(Math.random() * 60000));
      heartbeat.unref(); lifetime.unref();
    }
    return res;
  }
}
module.exports = { ContestNoticeStream };
