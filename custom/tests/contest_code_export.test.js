'use strict';

const assert = require('assert/strict');
const fs = require('fs-extra');
const { execFile } = require('child_process');
const { promisify } = require('util');
const test = require('node:test');
const { buildContestCodeArchive, cleanupContestCodeArchive, languageExtension } = require('../libs/contest-code-export');

const execFileAsync = promisify(execFile);

test('contest code export groups submissions by user and uses problem-submission filenames', async () => {
  const rows = [
    { id: 101, user_id: 7, username: 'alice', problem_id: 911105, language: 'cpp23', code: 'int main() {}', type: 'traditional' },
    { id: 102, user_id: 7, username: 'alice', problem_id: 911106, language: 'python311', code: 'print(1)', type: 'traditional' },
    { id: 103, user_id: 8, username: 'bob/name', problem_id: 911105, language: 'java', code: 'class Main {}', type: 'traditional' },
    { id: 104, user_id: 9, username: '张三', problem_id: 911107, language: 'c', code: 'int main() {}', type: 'traditional' }
  ];
  const connection = { query: async sql => {
    if (/submission_v2_code_version/.test(sql)) return [];
    return rows;
  } };
  const result = await buildContestCodeArchive({
    connection,
    contestId: 900001,
    languages: { cpp23: { fileExtension: 'cpp' }, python311: { fileExtension: 'py' } }
  });
  try {
    const listing = await execFileAsync('/usr/bin/unzip', ['-Z1', result.archive]);
    assert.match(listing.stdout, /alice\/911105-101\.cpp/);
    assert.match(listing.stdout, /alice\/911106-102\.py/);
    assert.match(listing.stdout, /bob_name\/911105-103\.java/);
    assert.match(listing.stdout, /张三\/911107-104\.c/);
  } finally {
    await cleanupContestCodeArchive(result);
  }
});

test('contest code export recognizes common language extensions', () => {
  assert.equal(languageExtension('cpp23', {}), 'cpp');
  assert.equal(languageExtension('cpp17-clang', {}), 'cpp');
  assert.equal(languageExtension('cpp-noilinux', {}), 'cpp');
  assert.equal(languageExtension('c-noilinux', {}), 'c');
  assert.equal(languageExtension('python311', {}), 'py');
  assert.equal(languageExtension('java', {}), 'java');
  assert.equal(languageExtension('pascal', {}), 'pas');
  assert.equal(languageExtension('cpp17', { cpp17: { format: 'cpp' } }), 'cpp');
  assert.equal(languageExtension('', {}), 'txt');
});

test('contest code export creates a valid empty archive when there are no submissions', async () => {
  const result = await buildContestCodeArchive({ connection: { query: async () => [] }, contestId: 900002, languages: {} });
  try {
    assert.equal((await fs.readFile(result.archive)).toString('hex'), '504b0506000000000000000000000000000000000000');
  } finally {
    await cleanupContestCodeArchive(result);
  }
});
