'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SandboxStatus = { OK: 1, TimeLimitExceeded: 2, MemoryLimitExceeded: 3, RuntimeError: 4, Cancelled: 5 };
const TestcaseResultType = { Accepted: 1, WrongAnswer: 2, PartiallyCorrect: 3, MemoryLimitExceeded: 4,
  TimeLimitExceeded: 5, OutputLimitExceeded: 6, FileError: 7, RuntimeError: 8, JudgementFailed: 9,
  InvalidInteraction: 10, PresentationError: 11 };

function loadJudge(options = {}) {
  const calls = { diff: 0, spj: 0 };
  const userRun = { outputLimitExceeded: false,
    result: { status: SandboxStatus.OK, code: 0, time: 1000000, memory: 1024 }, ...options.run };
  const files = new Map([['answer', options.fixedGroup ? 'NOJ_FIXED_GROUP_V1 fixture' : 'answer']]);
  const modules = {
    path, util: require('node:util'),
    randomstring: { generate: () => 'fixture' },
    winston: { debug() {}, verbose() {} },
    syspipe: { pipe: () => ({ read: 10, write: 11 }) },
    'simple-sandbox/lib/interfaces': { SandboxStatus },
    '../interfaces': { TestcaseResultType },
    './config': { globalConfig: { workingDirectory: '/work', testDataDirectory: '/testdata' } },
    './utils': { createOrEmptyDir: async () => {}, tryEmptyDir: async () => {} },
    '../utils': {
      readFileLength: async name => name.endsWith('.err') ? (options.stderr || '') : 'answer',
      tryReadFile: async name => path.basename(name) === 'score.txt' ? '100' : files.get(path.basename(name))
    },
    'fs-extra': {
      copy: async () => {}, close: async () => {}, writeFile: async () => {},
      move: async () => {
        if (options.missingOutput) throw Object.assign(new Error('Missing output'), { code: 'ENOENT' });
      }
    },
    './signals': { signals: { 11: 'SIGSEGV' } },
    './executable': { fetchBinary: async name => [name, { name }, 'source'] },
    './run': {
      runProgram: async (_language, binary) => {
        if (binary !== 'user') calls.spj++;
        return [Promise.resolve(binary === 'user' ? userRun : {
          outputLimitExceeded: false, result: { status: SandboxStatus.OK, code: 0 }
        }), () => {}];
      },
      runDiff: async () => { calls.diff++; return { pass: options.pass !== false, message: 'diff' }; }
    }
  };
  const context = { exports: {}, require(name) {
    assert.ok(Object.hasOwn(modules, name), `Unexpected module: ${name}`);
    return modules[name];
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../judge/runner-judge.js'), 'utf8'), context);
  const task = { testDataName: 'fixture', inputData: 'input', answerData: 'answer',
    userExecutableName: 'user', interactorExecutableName: 'interactor', time: 1000, memory: 256 };
  return { judge: context.exports, task, calls };
}

test('nonzero exits are RE before diff or special judging, even after printing the expected answer', async () => {
  for (const code of [1, 2, 42, 255]) {
    for (const spj of [false, true]) {
      const { judge, task, calls } = loadJudge({ run: {
        result: { status: SandboxStatus.OK, code, time: 1000000, memory: 1024 }
      }, stderr: 'uncaught exception' });
      if (spj) task.spjExecutableName = 'spj';
      const result = await judge.judgeStandard(task);
      assert.equal(result.result, TestcaseResultType.RuntimeError, `exit ${code}, spj ${spj}`);
      assert.equal(result.scoringRate, 0);
      assert.equal(result.systemMessage, `Exited with return code ${code}`);
      assert.equal(result.userError, 'uncaught exception');
      assert.equal(calls.diff, 0);
      assert.equal(calls.spj, 0);
    }
  }
});

test('a missing output file does not replace a runtime failure with File Error', async () => {
  const { judge, task } = loadJudge({ missingOutput: true, run: {
    result: { status: SandboxStatus.OK, code: 1, time: 1000000, memory: 1024 }
  } });
  assert.equal((await judge.judgeStandard(task)).result, TestcaseResultType.RuntimeError);
});

test('successful exits still use the output checker and require the output file', async () => {
  for (const [options, expected] of [
    [{}, TestcaseResultType.Accepted], [{ pass: false }, TestcaseResultType.WrongAnswer],
    [{ missingOutput: true }, TestcaseResultType.FileError]
  ]) {
    const { judge, task } = loadJudge(options);
    assert.equal((await judge.judgeStandard(task)).result, expected);
  }
});

test('resource limits and fatal signals keep their existing verdicts', async () => {
  for (const [status, code, outputLimitExceeded, expected] of [
    [SandboxStatus.TimeLimitExceeded, 1, false, TestcaseResultType.TimeLimitExceeded],
    [SandboxStatus.MemoryLimitExceeded, 1, false, TestcaseResultType.MemoryLimitExceeded],
    [SandboxStatus.RuntimeError, 11, false, TestcaseResultType.RuntimeError],
    [SandboxStatus.OK, 1, true, TestcaseResultType.OutputLimitExceeded]
  ]) {
    const { judge, task, calls } = loadJudge({ run: { outputLimitExceeded,
      result: { status, code, time: 1000000, memory: 1024 } } });
    assert.equal((await judge.judgeStandard(task)).result, expected);
    assert.equal(calls.diff, 0);
  }
});

test('ordinary and fixed group interaction both reject nonzero contestant exits', async () => {
  for (const fixedGroup of [false, true]) {
    const { judge, task } = loadJudge({ fixedGroup, run: {
      result: { status: SandboxStatus.OK, code: 1, time: 1000000, memory: 1024 }
    } });
    const result = await judge.judgeInteraction(task);
    assert.equal(result.result, TestcaseResultType.RuntimeError);
    assert.equal(result.scoringRate, 0);
    assert.equal(result.systemMessage, 'Exited with return code 1');
  }
});

test('interaction preserves acceptance and interactor cancellation handling', async () => {
  for (const status of [SandboxStatus.OK, SandboxStatus.Cancelled]) {
    const { judge, task } = loadJudge({ run: { result: { status, code: 0, time: 1000000, memory: 1024 } } });
    assert.equal((await judge.judgeInteraction(task)).result, TestcaseResultType.Accepted);
  }
});
