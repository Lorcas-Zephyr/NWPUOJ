'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const test = require('node:test');
const snapshots = require('../libs/testdata-snapshot');

test('testdata snapshots copy a stable manifest into an immutable relative directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwpuoj-testdata-snapshot-'));
  try {
    const source = snapshots.currentTestdataPath(root, 7);
    await fs.ensureDir(path.join(source, 'subtasks'));
    await fs.writeFile(path.join(source, '2.in'), '2 3\n');
    await fs.writeFile(path.join(source, '2.out'), '5\n');
    await fs.writeFile(path.join(source, 'subtasks', 'rules.yml'), 'subtasks: []\n');
    const first = await snapshots.capture(root, 7, 'ps_snapshot_0001');
    const repeated = await snapshots.capture(root, 7, 'ps_snapshot_0001');
    assert.equal(first.path, 'snapshots/ps_snapshot_0001');
    assert.equal(first.created, true);
    assert.equal(repeated.created, false);
    assert.equal(repeated.hash, first.hash);
    assert.equal(await fs.readFile(path.join(snapshots.snapshotDirectory(root, first.id), '2.out'), 'utf8'), '5\n');

    await fs.writeFile(path.join(source, '2.out'), '6\n');
    const second = await snapshots.capture(root, 7, 'ps_snapshot_0002');
    assert.notEqual(second.hash, first.hash);
    assert.equal(await fs.readFile(path.join(snapshots.snapshotDirectory(root, first.id), '2.out'), 'utf8'), '5\n');
  } finally {
    await fs.remove(root);
  }
});

test('testdata snapshots reject unsafe identifiers and symbolic links', async () => {
  assert.throws(() => snapshots.snapshotRelativePath('../escape'), /Invalid testdata snapshot identifier/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwpuoj-testdata-snapshot-'));
  try {
    const source = snapshots.currentTestdataPath(root, 8);
    await fs.ensureDir(source);
    await fs.writeFile(path.join(root, 'outside.txt'), 'outside');
    await fs.symlink(path.join(root, 'outside.txt'), path.join(source, 'linked.in'));
    await assert.rejects(snapshots.capture(root, 8, 'ps_snapshot_0003'), /symbolic links/);
  } finally {
    await fs.remove(root);
  }
});
