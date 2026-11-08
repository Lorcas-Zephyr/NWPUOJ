'use strict';

const path = require('path');
const fs = require('fs-extra');
const { SandboxStatus } = require('simple-sandbox/lib/interfaces');
const { TestcaseResultType: Verdict } = require('../interfaces');
const { globalConfig: config } = require('./config');
const { createOrEmptyDir, tryEmptyDir } = require('./utils');
const { readFileLength } = require('../utils');
const { fetchBinary } = require('./executable');
const { runProgram, runDiff } = require('./run');
const { signals } = require('./signals');

async function regularFile(filename) {
    try { return (await fs.lstat(filename)).isFile(); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function preview(filename, limit) {
    // Contestants can unlink their redirected output and create a symlink.
    // Never follow those links while copying or displaying sandbox output.
    return await regularFile(filename) ? await readFileLength(filename, limit) : '';
}

function runVerdict(run) {
    if (run.outputLimitExceeded) return [Verdict.OutputLimitExceeded, 'Output limit exceeded.'];
    const result = run.result;
    if (result.status === SandboxStatus.TimeLimitExceeded) return [Verdict.TimeLimitExceeded, 'Time limit exceeded.'];
    if (result.status === SandboxStatus.MemoryLimitExceeded) return [Verdict.MemoryLimitExceeded, 'Memory limit exceeded.'];
    if (result.status === SandboxStatus.RuntimeError) return [Verdict.RuntimeError, `Killed: ${signals[result.code] || result.code}`];
    if (result.status !== SandboxStatus.OK) return [Verdict.RuntimeError, `Sandbox status: ${SandboxStatus[result.status] || result.status}`];
    if (result.code !== 0) return [Verdict.RuntimeError, `Exited with return code ${result.code}`];
    return [Verdict.Accepted, 'Exited with return code 0'];
}

async function judgeCommunication(task, runSpj) {
    const firstDir = path.join(config.workingDirectory, 'communication-first');
    const transformDir = path.join(config.workingDirectory, 'communication-transform');
    const secondDir = path.join(config.workingDirectory, 'communication-second');
    const checkerDir = path.join(config.workingDirectory, 'data-spj');
    const dirs = [firstDir, transformDir, secondDir, checkerDir];
    const dataPath = path.join(config.testDataDirectory, task.testDataName);
    const inputPath = task.inputData == null ? null : path.join(dataPath, task.inputData);
    const answerPath = task.answerData == null ? null : path.join(dataPath, task.answerData);
    const communication = { rounds: [], secondInput: null };
    let elapsedNs = 0, peakMemory = 0;

    function result(type, message, score = 0, checkerMessage = null) {
        const last = communication.rounds[communication.rounds.length - 1];
        return {
            result: type, scoringRate: score,
            time: Math.round(elapsedNs / 1e6), memory: peakMemory,
            userOutput: last ? last.userOutput : '',
            userError: last ? last.userError : '',
            systemMessage: message, spjMessage: checkerMessage, communication
        };
    }

    try {
        await Promise.all(dirs.map(createOrEmptyDir));
        if (!task.communication.transformerExecutableName) {
            return result(Verdict.JudgementFailed, 'Communication transformer is missing.');
        }
        const [userBinary, userLanguage, code] = await fetchBinary(task.userExecutableName);
        const [transformBinary, transformLanguage] = await fetchBinary(task.communication.transformerExecutableName);

        async function runRound(number, directory, input) {
            // Each invocation gets a fresh process, working directory and sandbox.
            // Only the compiler's read-only binary directory is shared.
            const remaining = Math.max(1, task.time - Math.ceil(elapsedNs / 1e6));
            const [promise] = await runProgram(userLanguage, userBinary, directory,
                remaining, task.memory * 1024 * 1024, input, 'user_out', 'stderr');
            const run = await promise;
            elapsedNs += run.result.time || 0;
            const memory = (run.result.memory || 0) / 1024;
            peakMemory = Math.max(peakMemory, memory);
            let [type, message] = runVerdict(run);
            if (type === Verdict.Accepted && !await regularFile(path.join(directory, 'user_out'))) {
                type = Verdict.FileError;
                message = 'Standard output is missing or is not a regular file.';
            }
            if (type === Verdict.Accepted && elapsedNs > task.time * 1e6) {
                type = Verdict.TimeLimitExceeded;
                message = 'Combined time limit exceeded.';
            }
            const round = {
                round: number, type, time: Math.round((run.result.time || 0) / 1e6), memory,
                userOutput: await preview(path.join(directory, 'user_out'), config.dataDisplayLimit),
                userError: await preview(path.join(directory, 'stderr'), config.stderrDisplayLimit),
                systemMessage: message
            };
            communication.rounds.push(round);
            return round;
        }

        if (inputPath) await fs.copy(inputPath, path.join(firstDir, 'input'));
        const first = await runRound(1, firstDir, inputPath ? 'input' : null);
        if (first.type !== Verdict.Accepted) return result(first.type, `Round 1: ${first.systemMessage}`);
        if (elapsedNs >= task.time * 1e6) return result(Verdict.TimeLimitExceeded, 'Round 1 exhausted the combined time limit.');

        // The transformer is trusted problem code, but still runs sandboxed.
        // It receives a fresh original input, never the contestant's writable copy.
        await fs.copy(path.join(firstDir, 'user_out'), path.join(transformDir, 'first_output'));
        await fs.copy(path.join(firstDir, 'user_out'), path.join(checkerDir, 'first_output'));
        if (inputPath) await fs.copy(inputPath, path.join(transformDir, 'input'));
        if (answerPath) await fs.copy(answerPath, path.join(transformDir, 'answer'));
        const [transformPromise] = await runProgram(transformLanguage, transformBinary, transformDir,
            config.spjTimeLimit, config.spjMemoryLimit * 1024 * 1024, 'first_output', 'second_input', 'message.txt');
        const transformed = await transformPromise;
        const transformMessage = await preview(path.join(transformDir, 'message.txt'), config.stderrDisplayLimit);
        if (transformed.outputLimitExceeded || transformed.result.status !== SandboxStatus.OK) {
            return result(Verdict.JudgementFailed, 'Communication transformer failed: ' +
                (transformed.outputLimitExceeded ? 'Output limit exceeded.' : SandboxStatus[transformed.result.status]), 0, transformMessage);
        }
        if (transformed.result.code === 1 || transformed.result.code === 2) {
            return result(transformed.result.code === 1 ? Verdict.WrongAnswer : Verdict.PresentationError,
                'Communication transformer rejected round 1 output.', 0, transformMessage);
        }
        if (transformed.result.code !== 0 || !await regularFile(path.join(transformDir, 'second_input'))) {
            return result(Verdict.JudgementFailed, `Communication transformer failed (exit ${transformed.result.code}, second input must be a regular file).`, 0, transformMessage);
        }

        communication.secondInput = await preview(path.join(transformDir, 'second_input'), config.dataDisplayLimit);
        await fs.copy(path.join(transformDir, 'second_input'), path.join(secondDir, 'input'));
        await fs.copy(path.join(transformDir, 'second_input'), path.join(checkerDir, 'second_input'));
        const second = await runRound(2, secondDir, 'input');
        if (second.type !== Verdict.Accepted) return result(second.type, `Round 2: ${second.systemMessage}`);

        await fs.copy(path.join(secondDir, 'user_out'), path.join(checkerDir, 'user_out'));
        if (inputPath) await fs.copy(inputPath, path.join(checkerDir, 'input'));
        if (answerPath) await fs.copy(answerPath, path.join(checkerDir, 'answer'));
        if (task.spjExecutableName) {
            const [checkerBinary, checkerLanguage] = await fetchBinary(task.spjExecutableName);
            await fs.writeFile(path.join(checkerDir, 'code'), code);
            const checked = await runSpj(checkerBinary, checkerLanguage);
            return result(checked.status, 'Both rounds completed.', checked.score, checked.message);
        }
        if (!answerPath) return result(Verdict.JudgementFailed, 'An answer file or Special Judge is required.');
        const checked = await runDiff(checkerDir, 'user_out', 'answer');
        return result(checked.pass ? Verdict.Accepted : Verdict.WrongAnswer,
            'Both rounds completed.', checked.pass ? 1 : 0, checked.message);
    }
    finally {
        await Promise.all(dirs.map(tryEmptyDir));
    }
}

exports.judgeCommunication = judgeCommunication;
