'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createProviderScheduler } = require('../libs/vjudge-provider-scheduler');

test('provider scheduler serializes one provider, enforces its interval, and keeps providers independent', async () => {
  let time = 0;
  const waits = [];
  const scheduler = createProviderScheduler({
    now: () => time,
    wait: async milliseconds => { waits.push(milliseconds); time += milliseconds; }
  });
  const order = [];
  await scheduler.run('hdu', 500, async () => order.push('hdu:first'));
  await scheduler.run('hdu', 500, async () => order.push('hdu:second'));
  await scheduler.run('poj', 500, async () => order.push('poj:first'));
  assert.deepEqual(order, ['hdu:first', 'hdu:second', 'poj:first']);
  assert.deepEqual(waits, [500]);
});

test('provider scheduler releases a failed provider queue for later operations', async () => {
  const scheduler = createProviderScheduler({ now: () => 0, wait: async () => {} });
  await assert.rejects(() => scheduler.run('uoj', 0, async () => { throw new Error('upstream failed'); }), /upstream failed/);
  assert.equal(await scheduler.run('uoj', 0, async () => 'recovered'), 'recovered');
});
