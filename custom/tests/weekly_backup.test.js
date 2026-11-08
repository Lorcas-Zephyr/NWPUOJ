'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repo = path.resolve(__dirname, '../..');
const script = path.join(repo, 'custom/scripts/weekly-backup.sh');

test('weekly backup atomically replaces the latest archive and preserves it on failure', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noj-weekly-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const backupDir = path.join(root, 'backups');
  fs.mkdirSync(bin);
  fs.mkdirSync(backupDir);
  const docker = path.join(bin, 'docker');
  fs.writeFileSync(docker, `#!/usr/bin/env node
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'compose' && args.includes('exec')) {
  if (process.env.FAIL_DB === '1') process.exit(9);
  process.stdout.write('database-' + (process.env.DUMP_VERSION || 'one'));
} else if (args[0] === 'compose' && args.includes('images')) {
  process.stdout.write('[{"image":"fixture"}]\\n');
} else if (args[0] === 'run') {
  const mounts = args.flatMap((arg, i) => arg === '-v' ? [args[i + 1]] : []);
  const source = mounts.find(mount => mount.endsWith(':/source/metadata:ro')).split(':/source/metadata:ro')[0];
  const outputDir = mounts.find(mount => mount.endsWith(':/out')).split(':/out')[0];
  const tarAt = args.indexOf('tar');
  const destination = path.join(outputDir, path.basename(args[tarAt + 2]));
  const result = spawnSync('tar', ['czf', destination, '-C', source, '.']);
  process.exit(result.status || 0);
} else process.exit(2);
`);
  fs.chmodSync(docker, 0o755);

  function run(extraEnv = {}) {
    return spawnSync('bash', [script], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        NWPUOJ_BACKUP_DIR: backupDir,
        ...extraEnv
      }
    });
  }

  const first = run({ DUMP_VERSION: 'one' });
  assert.equal(first.status, 0, first.stderr);
  const latest = path.join(backupDir, 'nwpuoj-latest.tar.gz');
  const firstBytes = fs.readFileSync(latest);
  const entries = spawnSync('tar', ['-tzf', latest], { encoding: 'utf8' });
  assert.equal(entries.status, 0, entries.stderr);
  assert.match(entries.stdout, /database\.sql/);
  assert.match(entries.stdout, /images\.json/);
  assert.match(entries.stdout, /manifest\.txt/);

  const failed = run({ FAIL_DB: '1' });
  assert.notEqual(failed.status, 0);
  assert.deepEqual(fs.readFileSync(latest), firstBytes);

  const second = run({ DUMP_VERSION: 'two' });
  assert.equal(second.status, 0, second.stderr);
  assert.notDeepEqual(fs.readFileSync(latest), firstBytes);
  assert.deepEqual(fs.readdirSync(backupDir).filter(name => name.endsWith('.tar.gz')), ['nwpuoj-latest.tar.gz']);
});

test('weekly cron runs Sunday at 03:00 Shanghai time', () => {
  const cron = fs.readFileSync(path.join(repo, 'custom/scripts/weekly-backup.cron'), 'utf8');
  assert.match(cron, /CRON_TZ=Asia\/Shanghai/);
  assert.match(cron, /^0 3 \* \* 0 /m);
});
