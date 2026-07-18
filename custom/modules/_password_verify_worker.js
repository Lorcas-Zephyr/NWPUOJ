'use strict';

const bcrypt = require('bcryptjs');
const { parentPort } = require('worker_threads');

if (parentPort) {
  parentPort.on('message', async message => {
    try {
      const value = message.operation === 'hash'
        ? await bcrypt.hash(message.password, 11)
        : await bcrypt.compare(message.password, message.hash);
      parentPort.postMessage({ id: message.id, ok: true, value });
    } catch (error) {
      parentPort.postMessage({ id: message.id, ok: false, error: error.message });
    }
  });
}
