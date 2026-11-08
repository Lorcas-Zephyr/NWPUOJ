'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const fs = require('fs-extra');
const upload = require('../libs/testdata-upload');
const domain = require('../libs/problem-domain');
const source = name => fs.readFileSync(path.join(__dirname, '../judge', name), 'utf8');
const SandboxStatus = { OK: 1, TimeLimitExceeded: 2, MemoryLimitExceeded: 3, RuntimeError: 4, Cancelled: 5 };
const Verdict = { Accepted: 1, WrongAnswer: 2, PartiallyCorrect: 3, MemoryLimitExceeded: 4,
  TimeLimitExceeded: 5, OutputLimitExceeded: 6, FileError: 7, RuntimeError: 8, JudgementFailed: 9, PresentationError: 11 };

function load(code, modules) {
  const context = { exports: {}, module: { exports: {} }, console,
    require(name) { assert.ok(Object.hasOwn(modules, name), `Unexpected module: ${name}`); return modules[name]; } };
  vm.runInNewContext(code, context);
  return context;
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noj-communication-test-'));
  t.after(() => fs.remove(root));
  const work = path.join(root, 'work'), data = path.join(root, 'testdata');
  await fs.ensureDir(path.join(data, 'fixture'));
  await fs.writeFile(path.join(data, 'fixture', '1.in'), '1\n4 7\n');
  await fs.writeFile(path.join(data, 'fixture', '1.out'), '22\n');
  const calls = [];
  let round = 0;
  const config = { workingDirectory: work, testDataDirectory: data, dataDisplayLimit: 128,
    stderrDisplayLimit: 128, spjTimeLimit: 1500, spjMemoryLimit: 256 };
  const modules = {
    path, 'fs-extra': fs, 'simple-sandbox/lib/interfaces': { SandboxStatus },
    '../interfaces': { TestcaseResultType: Verdict }, './config': { globalConfig: config },
    './utils': { createOrEmptyDir: file => fs.emptyDir(file), tryEmptyDir: file => fs.emptyDir(file) },
    '../utils': { readFileLength: async (name, length) => (await fs.readFile(name, 'utf8')).slice(0, length) },
    './signals': { signals: { 11: 'SIGSEGV' } },
    './executable': { fetchBinary: async name => [name, { name }, 'contestant code'] },
    './run': {
      async runProgram(_language, binary, directory, time, memory, stdin, stdout, stderr) {
        const number = binary === 'user' ? ++round : null;
        const call = { binary, directory, time, memory, number, stdin, stdout, stderr };
        calls.push(call);
        assert.equal(await fs.pathExists(path.join(directory, 'leaked-file')), false);
        if (binary === 'user') {
          assert.equal(await fs.pathExists(path.join(directory, 'answer')), false);
          assert.equal(await fs.pathExists(path.join(directory, 'first_output')), false);
          assert.equal(await fs.readFile(path.join(directory, stdin), 'utf8'), number === 1 ? '1\n4 7\n' : '2\n11\n');
          await fs.writeFile(path.join(directory, 'leaked-file'), 'must not cross rounds');
          await fs.writeFile(path.join(directory, 'input'), 'contestant changed input');
        } else {
          assert.equal(await fs.readFile(path.join(directory, stdin), 'utf8'), '11\n');
          assert.equal(await fs.readFile(path.join(directory, 'input'), 'utf8'), '1\n4 7\n');
        }
        const content = binary === 'transformer' ? '2\n11\n' : number === 1 ? '11\n' : '22\n';
        await fs.writeFile(path.join(directory, stdout), content);
        await fs.writeFile(path.join(directory, stderr), `diagnostic ${binary} ${number || ''}`);
        const result = { outputLimitExceeded: false, result: {
          status: SandboxStatus.OK, code: 0, time: (number || 10) * 10000000, memory: (number || 10) * 1024
        } };
        if (options.run) await options.run(call, result);
        return [Promise.resolve(result), () => {}];
      },
      async runDiff(directory, output, answer) {
        calls.push({ binary: 'diff' });
        assert.equal(await fs.readFile(path.join(directory, 'first_output'), 'utf8'), '11\n');
        assert.equal(await fs.readFile(path.join(directory, 'second_input'), 'utf8'), '2\n11\n');
        assert.equal(await fs.readFile(path.join(directory, 'input'), 'utf8'), '1\n4 7\n');
        const pass = await fs.readFile(path.join(directory, output), 'utf8') === await fs.readFile(path.join(directory, answer), 'utf8');
        return { pass, message: 'diff message' };
      }
    }
  };
  const runner = load(source('runner-communication.js'), modules).exports;
  const task = { testDataName: 'fixture', inputData: '1.in', answerData: '1.out', time: 100, memory: 64,
    userExecutableName: 'user', communication: { transformerExecutableName: 'transformer' } };
  return { root, work, calls, task, run: () => runner.judgeCommunication(task, async () => {
    calls.push({ binary: 'checker' });
    assert.equal(await fs.readFile(path.join(work, 'data-spj', 'code'), 'utf8'), 'contestant code');
    return { status: Verdict.PartiallyCorrect, score: 0.5, message: 'partial credit' };
  }) };
}

test('runs one binary twice with isolated files, transformed input, combined time and peak memory', async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.result, Verdict.Accepted);
  assert.equal(result.scoringRate, 1);
  assert.equal(result.time, 30);
  assert.equal(result.memory, 2);
  assert.deepEqual(f.calls.map(c => c.binary), ['user', 'transformer', 'user', 'diff']);
  assert.deepEqual(f.calls.filter(c => c.binary === 'user').map(c => c.time), [100, 90]);
  assert.equal(f.calls[1].time, 1500);
  assert.equal(result.communication.rounds.length, 2);
  assert.equal(result.communication.rounds[0].userOutput, '11\n');
  assert.equal(result.communication.secondInput, '2\n11\n');
  for (const dir of await fs.readdir(f.work)) assert.deepEqual(await fs.readdir(path.join(f.work, dir)), []);
});

test('runtime failures in either round retain RE/TLE/MLE/OLE and stop the pipeline', async t => {
  for (const round of [1, 2]) {
    for (const [status, code, ole, expected] of [
      [SandboxStatus.OK, 42, false, Verdict.RuntimeError],
      [SandboxStatus.RuntimeError, 11, false, Verdict.RuntimeError],
      [SandboxStatus.TimeLimitExceeded, 0, false, Verdict.TimeLimitExceeded],
      [SandboxStatus.MemoryLimitExceeded, 0, false, Verdict.MemoryLimitExceeded],
      [SandboxStatus.OK, 0, true, Verdict.OutputLimitExceeded]
    ]) {
      const f = await fixture(t, { run(call, result) {
        if (call.number === round) { Object.assign(result.result, { status, code }); result.outputLimitExceeded = ole; }
      } });
      const result = await f.run();
      assert.equal(result.result, expected, `round ${round}, status ${status}, code ${code}`);
      assert.match(result.systemMessage, new RegExp(`Round ${round}:`));
      assert.equal(result.scoringRate, 0);
      assert.equal(f.calls.length, round === 1 ? 1 : 3);
      for (const dir of await fs.readdir(f.work)) assert.deepEqual(await fs.readdir(path.join(f.work, dir)), []);
    }
  }
});

test('transformer can reject a message, and infrastructure failures are Judgement Failed', async t => {
  for (const [code, status, ole, expected] of [
    [1, SandboxStatus.OK, false, Verdict.WrongAnswer],
    [2, SandboxStatus.OK, false, Verdict.PresentationError],
    [3, SandboxStatus.OK, false, Verdict.JudgementFailed],
    [0, SandboxStatus.TimeLimitExceeded, false, Verdict.JudgementFailed],
    [0, SandboxStatus.OK, true, Verdict.JudgementFailed]
  ]) {
    const f = await fixture(t, { run(call, result) {
      if (call.binary === 'transformer') { Object.assign(result.result, { code, status }); result.outputLimitExceeded = ole; }
    } });
    const result = await f.run();
    assert.equal(result.result, expected);
    assert.equal(f.calls.length, 2);
    assert.match(result.spjMessage, /diagnostic transformer/);
  }
});

test('combined time is enforced and output symlinks are never followed', async t => {
  const timed = await fixture(t, { run(call, result) { if (call.number === 1) result.result.time = 100000000; } });
  assert.equal((await timed.run()).result, Verdict.TimeLimitExceeded);
  assert.equal(timed.calls.length, 1);
  for (const round of [1, 2]) {
    const linked = await fixture(t, { async run(call) {
      if (call.number === round) {
        await fs.remove(path.join(call.directory, call.stdout));
        await fs.symlink('/etc/passwd', path.join(call.directory, call.stdout));
      }
    } });
    const result = await linked.run();
    assert.equal(result.result, Verdict.FileError);
    assert.equal(result.userOutput, '');
  }
});

test('the final output checker determines WA or partial credit after both rounds', async t => {
  const wrong = await fixture(t, { async run(call) {
    if (call.number === 2) await fs.writeFile(path.join(call.directory, call.stdout), '23\n');
  } });
  assert.equal((await wrong.run()).result, Verdict.WrongAnswer);
  const partial = await fixture(t);
  partial.task.spjExecutableName = 'spj';
  const result = await partial.run();
  assert.equal(result.result, Verdict.PartiallyCorrect);
  assert.equal(result.scoringRate, 0.5);
  assert.equal(result.spjMessage, 'partial credit');
});

test('communication configuration validates real source files and participates in problem snapshots', async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, 'upload');
  await fs.ensureDir(directory);
  const languages = { cpp17: {} };
  await assert.rejects(upload.validateCommunicationTestdata(directory, 'communication', languages), /data.yml/);
  await fs.writeFile(path.join(directory, 'data.yml'), 'communication:\n  language: cpp17\n  fileName: transform.cpp\n');
  await assert.rejects(upload.validateCommunicationTestdata(directory, 'communication', languages), /transform.cpp/);
  await fs.writeFile(path.join(directory, 'transform.cpp'), 'int main() {}');
  await upload.validateCommunicationTestdata(directory, 'communication', languages);
  for (const filename of ['../outside.cpp', '/outside.cpp', '..\\outside.cpp']) {
    await fs.writeFile(path.join(directory, 'data.yml'), JSON.stringify({ communication: { language: 'cpp17', fileName: filename } }));
    await assert.rejects(upload.validateCommunicationTestdata(directory, 'communication', languages), /fileName/);
  }
  const content = domain.contentFromInput({ title: 'Communication', type: 'communication', time_limit: 1000, memory_limit: 64 });
  assert.deepEqual(domain.validateContent(content), {});
  assert.notEqual(domain.contentHash(content), domain.contentHash({ ...content, type: 'traditional' }));
  assert.equal(JSON.parse(domain.serializeContent(content)).type, 'communication');
});

test('communication diagnostics obey existing disclosure permissions', () => {
  const processor = load(fs.readFileSync(path.join(__dirname, '../libs-built/submissions_process.js'), 'utf8'), { './judger': {} }).module.exports;
  const communication = { rounds: [{ userOutput: 'private' }], secondInput: 'secret' };
  const overall = { judge: { subtasks: [{ cases: [{ result: { type: 1, communication } }] }] } };
  for (const showTestdata of [false, true]) for (const showDiagnostics of [false, true]) {
    const output = processor.processOverallResult(overall, { showDetailResult: true, showTestdata, showDiagnostics });
    assert.equal(output.judge.subtasks[0].cases[0].result.communication, showTestdata && showDiagnostics ? communication : undefined);
  }
});

test('daemon compilation cache distinguishes extra files from different snapshots', async () => {
  const binaries = new Set(), runs = [];
  const modules = {
    '../redis': { getCompileLock: async () => async () => {}, checkBinaryExistance: async key => binaries.has(key) },
    '../rmq': { runTask: async task => { runs.push(task); binaries.add(task.task.binaryName); return { status: 2 }; } },
    '../../utils': { codeFingerprint: (code, lang) => crypto.createHash('sha256').update(code + lang).digest('hex') },
    '../../interfaces': { TaskStatus: { Done: 2 }, RPCTaskType: { Compile: 1 } }, winston: { debug() {} }
  };
  const { compile } = load(source('daemon-compile.js'), modules).exports;
  const args = ['#include "data.h"', { name: 'cpp17' }];
  const a = await compile(...args, [{ name: 'data.h', content: '#define N 1' }], 1);
  const cached = await compile(...args, [{ name: 'data.h', content: '#define N 1' }], 1);
  const b = await compile(...args, [{ name: 'data.h', content: '#define N 2' }], 1);
  assert.equal(a[0], cached[0]);
  assert.notEqual(a[0], b[0]);
  assert.equal(runs.length, 2);
});

test('raw and historical API communication results hide intermediate data from contest participants', async () => {
  const processor = load(fs.readFileSync(path.join(__dirname, '../libs-built/submissions_process.js'), 'utf8'), { './judger': {} }).module.exports;
  const text = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_submission_domain.js'), 'utf8');
  let ended = false, details = true;
  const contest = { isSupervisior: async user => user.id === 2, isEnded: () => ended, allowedSeeingTestcase: () => details };
  const context = { Contest: { findById: async () => contest }, require: () => processor };
  vm.runInNewContext(text.slice(text.indexOf('async function visibleCommunicationResult('), text.indexOf('function validLanguage(')), context);
  const judge = { type: 1, type_info: 21, user_id: 7 };
  const result = { judge: { subtasks: [{ cases: [{ status: 2, result: { type: 1, time: 1, memory: 2,
    input: { content: 'private input' }, output: { content: 'private answer' }, userOutput: 'answer', userError: 'error',
    spjMessage: 'checker', systemMessage: 'system', communication: { rounds: [], secondInput: 'private transformed input' }
  } }] }] } };
  for (const user of [{ id: 7 }, { id: 3, judgeRead: true }]) {
    const visible = await context.visibleCommunicationResult(judge, user, result);
    const testcase = visible.judge.subtasks[0].cases[0].result;
    assert.equal(testcase.type, 1);
    for (const field of ['input', 'output', 'userOutput', 'userError', 'spjMessage', 'systemMessage', 'communication', 'time', 'memory']) {
      assert.equal(testcase[field], undefined, field);
    }
  }
  details = false;
  assert.equal((await context.visibleCommunicationResult(judge, { id: 7 }, result)).judge, null);
  ended = true;
  const after = await context.visibleCommunicationResult(judge, { id: 7 }, result);
  assert.equal(after.judge.subtasks[0].cases[0].result.time, 1);
  assert.equal(after.judge.subtasks[0].cases[0].result.communication, undefined);
  for (const user of [{ id: 2 }, { id: 1, is_admin: true }]) assert.equal(await context.visibleCommunicationResult(judge, user, result), result);
  assert.equal(await context.visibleCommunicationResult({ type: 0 }, { id: 7 }, result), result);
  assert.ok(result.judge.subtasks[0].cases[0].result.communication, 'filtering must not mutate durable results');
  for (const route of ['/api/v2/submissions/:id', '/api/v2/submissions/:id/testpoints', '/api/v2/submissions/:id/result-revisions']) {
    const start = text.indexOf("app.get('" + route + "'");
    const next = text.indexOf("\napp.get('", start + 1);
    assert.match(text.slice(start, next), /visibleCommunicationResult\(/);
  }
});
