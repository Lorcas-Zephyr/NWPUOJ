'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ReadCache } = require('../libs/read-cache');
const requestReads = require('../libs/request-read-cache');
const { ContestNoticeStream } = require('../libs/contest-notice-stream');

test('450 simultaneous readers share a single calculation and caches remain bounded', async () => {
  const cache = new ReadCache(8);
  let calculations = 0;
  const results = await Promise.all(Array.from({ length: 450 }, () => cache.get('21:live', 2000, async () => { calculations++; return ['rank']; })));
  assert.equal(calculations, 1);
  assert.ok(results.every(result => result === results[0]));
  await cache.get('21:frozen:120', 2000, async () => { calculations++; return ['frozen']; });
  assert.equal(calculations, 2);
  for (let i = 0; i < 20; i++) await cache.get(String(i), 2000, () => i);
  assert.equal(cache.entries.size, 8);
});

test('invalidated in-flight work cannot overwrite a newer value; failed loaders retry', async () => {
  const cache = new ReadCache();
  let release;
  const first = cache.get('21:live', 1000, () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  cache.invalidate('21:');
  await cache.get('21:live', 1000, () => 'new');
  release('old');
  assert.equal(await first, 'old');
  assert.equal(await cache.get('21:live', 1000, () => 'incorrect'), 'new');
  await assert.rejects(cache.get('bad', 1000, () => { throw Error('fixture'); }));
  assert.equal(await cache.get('bad', 1000, () => 'recovered'), 'recovered');
});

test('authorization read memo is request-local, coalesces reads, and never caches writes or streams', async () => {
  let queries = 0;
  const query = async () => ++queries;
  const run = req => requestReads.middleware(req, {}, async () => Promise.all([
    requestReads.memo('auth:teams:7', query), requestReads.memo('auth:teams:7', query)
  ]));
  assert.deepEqual(await run({ method: 'GET', path: '/api/v2/contests/21/ranklist-view' }), [1, 1]);
  assert.deepEqual(await run({ method: 'GET', path: '/api/v2/contests/21/ranklist-view' }), [2, 2]);
  assert.deepEqual(await run({ method: 'POST', path: '/api/v2/users/7' }), [3, 4]);
  assert.deepEqual(await run({ method: 'GET', path: '/api/v2/contests/21/notices/events' }), [5, 6]);
});

function connection(stream, id, backpressure = false) {
  const req = new EventEmitter(), res = new EventEmitter();
  res.frames = []; res.headers = {}; res.status = () => res;
  res.set = headers => { res.headers = headers; return res; };
  res.flushHeaders = () => {};
  res.write = frame => { res.frames.push(frame); return !backpressure; };
  res.end = () => { res.ended = true; res.emit('close'); };
  stream.attach(req, res, id);
  return res;
}

test('450 notification listeners receive payload-free pushes and disconnect without leaks', () => {
  const stream = new ContestNoticeStream();
  const readers = Array.from({ length: 450 }, () => connection(stream, 21));
  const other = connection(stream, 22);
  assert.equal(stream.contests.get(21).size, 450);
  stream.publish(21);
  assert.ok(readers.every(reader => reader.frames.length === 2 && reader.frames[1] === 'event: changed\ndata: {}\n\n'));
  assert.equal(other.frames.length, 1);
  assert.match(readers[0].headers['Cache-Control'], /no-transform/);
  for (const reader of readers) reader.end();
  other.end();
  assert.equal(stream.contests.size, 0);
});

test('slow or broken SSE clients cannot retain buffers or break publishing', () => {
  const stream = new ContestNoticeStream();
  const slow = connection(stream, 21, true);
  assert.equal(slow.ended, true);
  assert.equal(stream.contests.size, 0);
  const broken = connection(stream, 21);
  broken.write = () => { throw Error('closed socket'); };
  assert.doesNotThrow(() => stream.publish(21));
  assert.equal(stream.contests.size, 0);
});
