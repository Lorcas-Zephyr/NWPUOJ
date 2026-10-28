"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pathLib = require("path");
const randomString = require("randomstring");
const util = require("util");
const fse = require("fs-extra");
const winston = require("winston");
const syspipe = require('syspipe');
const interfaces_1 = require("simple-sandbox/lib/interfaces");
const interfaces_2 = require("../interfaces");
const utils_1 = require("./utils");
const utils_2 = require("../utils");
const config_1 = require("./config");
const run_1 = require("./run");
const executable_1 = require("./executable");
const signals_1 = require("./signals");
const workingDir = `${config_1.globalConfig.workingDirectory}/data`;
const spjWorkingDir = `${config_1.globalConfig.workingDirectory}/data-spj`;
const spjFullScore = 100;
function getStatusByScore(score) {
    switch (score) {
        case spjFullScore:
            return interfaces_2.TestcaseResultType.Accepted;
        case 0:
            return interfaces_2.TestcaseResultType.WrongAnswer;
        default:
            return interfaces_2.TestcaseResultType.PartiallyCorrect;
    }
}
async function runSpj(spjBinDir, spjLanguage) {
    const scoreFileName = 'score.txt';
    const messageFileName = 'message.txt';
    const [resultPromise] = await run_1.runProgram(spjLanguage, spjBinDir, spjWorkingDir, config_1.globalConfig.spjTimeLimit, config_1.globalConfig.spjMemoryLimit * 1024 * 1024, null, scoreFileName, messageFileName);
    const spjRunResult = await resultPromise;
    if (spjRunResult.result.status !== interfaces_1.SandboxStatus.OK) {
        return {
            status: interfaces_2.TestcaseResultType.JudgementFailed,
            message: `Special Judge ${interfaces_1.SandboxStatus[spjRunResult.result.status]} encountered.`,
            score: 0
        };
    }
    else {
        const scoreString = await utils_2.tryReadFile(pathLib.join(spjWorkingDir, scoreFileName)), score = Number(scoreString);
        const messageString = await utils_2.readFileLength(pathLib.join(spjWorkingDir, messageFileName), config_1.globalConfig.stderrDisplayLimit);
        if ((!scoreString) || isNaN(score) || score < 0 || score > spjFullScore) {
            return {
                status: interfaces_2.TestcaseResultType.JudgementFailed,
                message: `Special Judge returned an unrecoginzed score: ${scoreString}.`,
                score: 0
            };
        }
        else {
            return {
                status: getStatusByScore(score),
                message: messageString,
                score: score / spjFullScore
            };
        }
    }
}
async function judgeAnswerSubmission(task) {
    try {
        await utils_1.createOrEmptyDir(spjWorkingDir);
        const testDataPath = pathLib.join(config_1.globalConfig.testDataDirectory, task.testDataName);
        const inputFilePath = task.inputData != null ?
            pathLib.join(testDataPath, task.inputData) : null;
        if (inputFilePath != null)
            await fse.copy(inputFilePath, pathLib.join(spjWorkingDir, 'input'));
        const answerFilePath = task.answerData != null ?
            pathLib.join(testDataPath, task.answerData) : null;
        if (answerFilePath != null)
            await fse.copy(answerFilePath, pathLib.join(spjWorkingDir, 'answer'));
        await fse.writeFile(pathLib.join(spjWorkingDir, "user_out"), task.userAnswer);
        if (task.spjExecutableName != null) {
            const [spjBinDir, spjLanguage] = await executable_1.fetchBinary(task.spjExecutableName);
            winston.debug(`Using spj, language: ${spjLanguage.name}`);
            if (inputFilePath != null)
                await fse.copy(inputFilePath, pathLib.join(spjWorkingDir, 'input'));
            winston.debug(`Running spj`);
            const spjResult = await runSpj(spjBinDir, spjLanguage);
            winston.debug('Judgement done!!');
            return {
                result: spjResult.status,
                scoringRate: spjResult.score,
                spjMessage: spjResult.message,
            };
        }
        else {
            winston.debug(`Running diff`);
            const diffResult = await run_1.runDiff(spjWorkingDir, 'user_out', 'answer');
            winston.debug('Judgement done!!');
            return {
                result: diffResult.pass ? interfaces_2.TestcaseResultType.Accepted : interfaces_2.TestcaseResultType.WrongAnswer,
                scoringRate: diffResult.pass ? 1 : 0,
                spjMessage: diffResult.message,
            };
        }
    }
    finally {
        await utils_1.tryEmptyDir(spjWorkingDir);
    }
}
exports.judgeAnswerSubmission = judgeAnswerSubmission;
async function judgeStandard(task) {
    winston.debug("Standard judge task...", task);
    try {
        const testDataPath = pathLib.join(config_1.globalConfig.testDataDirectory, task.testDataName);
        const inputFilePath = task.inputData != null ?
            pathLib.join(testDataPath, task.inputData) : null;
        const answerFilePath = task.answerData != null ?
            pathLib.join(testDataPath, task.answerData) : null;
        winston.debug("Creating directories...");
        await Promise.all([utils_1.createOrEmptyDir(workingDir), utils_1.createOrEmptyDir(spjWorkingDir)]);
        let stdinRedirectionName, inputFileName, stdoutRedirectionName, outputFileName;
        const tempErrFile = randomString.generate(10) + ".err";
        if (task.fileIOInput != null) {
            inputFileName = task.fileIOInput;
            stdinRedirectionName = null;
        }
        else {
            if (task.inputData != null) {
                stdinRedirectionName = inputFileName = randomString.generate(10) + ".in";
            }
            else {
                stdinRedirectionName = inputFileName = null;
            }
        }
        if (task.fileIOOutput != null) {
            outputFileName = task.fileIOOutput;
            stdoutRedirectionName = null;
        }
        else {
            stdoutRedirectionName = outputFileName = randomString.generate(10) + ".out";
        }
        if (inputFilePath != null) {
            winston.debug("Copying input file...");
            await fse.copy(inputFilePath, pathLib.join(workingDir, inputFileName));
        }
        winston.debug("Fetching user binary...");
        const [binaryDirectory, language, userCode] = await executable_1.fetchBinary(task.userExecutableName);
        winston.debug("Running user program...");
        const [resultPromise] = await run_1.runProgram(language, binaryDirectory, workingDir, task.time, task.memory * 1024 * 1024, stdinRedirectionName, stdoutRedirectionName, tempErrFile);
        const runResult = await resultPromise;
        winston.verbose((task.inputData || "<none> ") + " Run result: " + JSON.stringify(runResult));
        const time = Math.round(runResult.result.time / 1e6), memory = runResult.result.memory / 1024;
        let status = null, message = null;
        if (runResult.outputLimitExceeded) {
            status = interfaces_2.TestcaseResultType.OutputLimitExceeded;
        }
        else if (runResult.result.status === interfaces_1.SandboxStatus.TimeLimitExceeded) {
            status = interfaces_2.TestcaseResultType.TimeLimitExceeded;
        }
        else if (runResult.result.status === interfaces_1.SandboxStatus.MemoryLimitExceeded) {
            status = interfaces_2.TestcaseResultType.MemoryLimitExceeded;
        }
        else if (runResult.result.status === interfaces_1.SandboxStatus.RuntimeError) {
            message = `Killed: ${signals_1.signals[runResult.result.code]}`;
            status = interfaces_2.TestcaseResultType.RuntimeError;
        }
        else if (runResult.result.status !== interfaces_1.SandboxStatus.OK) {
            message = "Warning: corrupt sandbox result " + util.inspect(runResult.result);
            status = interfaces_2.TestcaseResultType.RuntimeError;
        }
        else {
            message = `Exited with return code ${runResult.result.code}`;
        }
        const [userOutput, userError] = await Promise.all([
            utils_2.readFileLength(pathLib.join(workingDir, outputFileName), config_1.globalConfig.dataDisplayLimit),
            utils_2.readFileLength(pathLib.join(workingDir, tempErrFile), config_1.globalConfig.stderrDisplayLimit)
        ]);
        try {
            await fse.move(pathLib.join(workingDir, outputFileName), pathLib.join(spjWorkingDir, 'user_out'));
        }
        catch (e) {
            if (e.code === 'ENOENT' && runResult.result.status === interfaces_1.SandboxStatus.OK && !runResult.outputLimitExceeded) {
                status = interfaces_2.TestcaseResultType.FileError;
            }
        }
        const partialResult = {
            time: time,
            memory: memory,
            userOutput: userOutput,
            userError: userError,
            systemMessage: message
        };
        if (status !== null) {
            return Object.assign({ scoringRate: 0, spjMessage: null, result: status }, partialResult);
        }
        else {
            if (answerFilePath != null)
                await fse.copy(answerFilePath, pathLib.join(spjWorkingDir, 'answer'));
            if (task.spjExecutableName != null) {
                const [spjBinDir, spjLanguage] = await executable_1.fetchBinary(task.spjExecutableName);
                winston.debug(`Using spj, language: ${spjLanguage.name}`);
                if (inputFilePath != null)
                    await fse.copy(inputFilePath, pathLib.join(spjWorkingDir, 'input'));
                await fse.writeFile(pathLib.join(spjWorkingDir, 'code'), userCode);
                winston.debug(`Running spj`);
                const spjResult = await runSpj(spjBinDir, spjLanguage);
                winston.debug('Judgement done!!');
                return Object.assign({
                    scoringRate: spjResult.score,
                    spjMessage: spjResult.message,
                    result: spjResult.status
                }, partialResult);
            }
            else {
                winston.debug(`Running diff`);
                const diffResult = await run_1.runDiff(spjWorkingDir, 'user_out', 'answer');
                winston.debug('Judgement done!!');
                return Object.assign({
                    scoringRate: diffResult.pass ? 1 : 0,
                    spjMessage: diffResult.message,
                    result: diffResult.pass ? interfaces_2.TestcaseResultType.Accepted : interfaces_2.TestcaseResultType.WrongAnswer,
                }, partialResult);
            }
        }
    }
    finally {
        await utils_1.tryEmptyDir(workingDir);
        await utils_1.tryEmptyDir(spjWorkingDir);
    }
}
exports.judgeStandard = judgeStandard;
async function judgeInteraction(task) {
    let pipe1 = null, pipe2 = null;
    try {
        const testDataPath = pathLib.join(config_1.globalConfig.testDataDirectory, task.testDataName);
        const inputFilePath = task.inputData != null ?
            pathLib.join(testDataPath, task.inputData) : null;
        const answerFilePath = task.answerData != null ?
            pathLib.join(testDataPath, task.answerData) : null;
        winston.debug("Creating directories...");
        await Promise.all([utils_1.createOrEmptyDir(workingDir), utils_1.createOrEmptyDir(spjWorkingDir)]);
        const tempErrFile = randomString.generate(10) + ".err";
        if (inputFilePath != null) {
            await fse.copy(inputFilePath, pathLib.join(spjWorkingDir, 'input'));
        }
        if (answerFilePath != null) {
            await fse.copy(answerFilePath, pathLib.join(spjWorkingDir, 'answer'));
        }
        winston.debug("Fetching user binary...");
        const [userBinaryDirectory, userLanguage, userCode] = await executable_1.fetchBinary(task.userExecutableName);
        winston.debug("Fetching interactor binary...");
        const [interactorBinaryDirectory, interactorLanguage] = await executable_1.fetchBinary(task.interactorExecutableName);
        await fse.writeFile(pathLib.join(spjWorkingDir, 'code'), userCode);
        pipe1 = syspipe.pipe(),
            pipe2 = syspipe.pipe();
        const [userProgramTaskPromise, stopUser] = await run_1.runProgram(userLanguage, userBinaryDirectory, workingDir, task.time, task.memory * 1024 * 1024, pipe1.read, pipe2.write, tempErrFile);
        const [interactorTaskPromise] = await run_1.runProgram(interactorLanguage, interactorBinaryDirectory, spjWorkingDir, task.time * 2, task.memory * 1024 * 1024, pipe2.read, pipe1.write, tempErrFile);
        // Fixed-group interactors validate contestant EOF. Keeping parent-side
        // writers open prevents EOF even after the contestant has exited.
        const fixedGroup = answerFilePath != null && /^NOJ_FIXED_GROUP_V1 /.test(await utils_2.tryReadFile(answerFilePath));
        if (fixedGroup) {
            for (const p of [pipe1, pipe2]) {
                await fse.close(p.read);
                await fse.close(p.write);
            }
            pipe1 = pipe2 = null;
        }
        const [interactorResult, runResult] = await Promise.all([interactorTaskPromise
                .then((result) => { stopUser(); return result; }, (err) => { stopUser(); return Promise.reject(err); }), userProgramTaskPromise]);
        const time = Math.round(runResult.result.time / 1e6), memory = runResult.result.memory / 1024;
        let status = null, message = null;
        if (fixedGroup && runResult.result.status === interfaces_1.SandboxStatus.OK && runResult.result.code !== 0) {
            status = interfaces_2.TestcaseResultType.RuntimeError;
        }
        if (runResult.outputLimitExceeded) {
            status = interfaces_2.TestcaseResultType.OutputLimitExceeded;
        }
        else if (runResult.result.status === interfaces_1.SandboxStatus.TimeLimitExceeded) {
            status = interfaces_2.TestcaseResultType.TimeLimitExceeded;
        }
        else if (runResult.result.status === interfaces_1.SandboxStatus.MemoryLimitExceeded) {
            status = interfaces_2.TestcaseResultType.MemoryLimitExceeded;
        }
        else if (runResult.result.status === interfaces_1.SandboxStatus.RuntimeError) {
            message = `Killed: ${signals_1.signals[runResult.result.code]}`;
            status = interfaces_2.TestcaseResultType.RuntimeError;
        }
        else if (runResult.result.status === interfaces_1.SandboxStatus.Cancelled) {
        }
        else if (runResult.result.status !== interfaces_1.SandboxStatus.OK) {
            message = "Warning: corrupt sandbox result " + util.inspect(runResult.result);
            status = interfaces_2.TestcaseResultType.RuntimeError;
        }
        else {
            message = `Exited with return code ${runResult.result.code}`;
        }
        if (interactorResult.result.status !== interfaces_1.SandboxStatus.OK) {
            if (interactorResult.result.status === interfaces_1.SandboxStatus.TimeLimitExceeded) {
                message = 'Interactor Time Limit Exceeded. This is likely to happen if your program stuck.';
                status = interfaces_2.TestcaseResultType.TimeLimitExceeded;
            }
            else {
                message = `A ${interfaces_1.SandboxStatus[interactorResult.result.status]} encountered while running interactor`;
                status = interfaces_2.TestcaseResultType.JudgementFailed;
            }
        }
        const partialResult = {
            time: time,
            memory: memory,
            userOutput: null,
            userError: await utils_2.readFileLength(pathLib.join(workingDir, tempErrFile), config_1.globalConfig.stderrDisplayLimit),
            spjMessage: await utils_2.readFileLength(pathLib.join(spjWorkingDir, tempErrFile), config_1.globalConfig.stderrDisplayLimit)
        };
        let score = 0;
        if (status == null) {
            const scoreString = await utils_2.tryReadFile(spjWorkingDir + '/score.txt');
            const rawScore = Number(scoreString);
            if ((!scoreString) || isNaN(rawScore)) {
                score = null;
                status = interfaces_2.TestcaseResultType.JudgementFailed;
                message = `Interactor returned a non-number score ${scoreString}`;
            }
            else if (rawScore === -1) {
                status = interfaces_2.TestcaseResultType.PresentationError;
                message = 'Interactor reported a presentation error (invalid interaction format)';
            }
            else {
                score = rawScore;
                status = getStatusByScore(rawScore);
            }
        }
        winston.debug(`Interaction problem judge succeeded, score = ${score}`);
        return Object.assign(partialResult, {
            result: status,
            scoringRate: score / spjFullScore,
            systemMessage: message
        });
    }
    finally {
        const closePipe = async (p) => {
            try {
                if (p) {
                    await fse.close(p.read);
                    await fse.close(p.write);
                }
            }
            catch (e) { }
        };
        await closePipe(pipe1);
        await closePipe(pipe2);
        await utils_1.tryEmptyDir(spjWorkingDir);
        await utils_1.tryEmptyDir(workingDir);
    }
}
exports.judgeInteraction = judgeInteraction;
//# sourceMappingURL=judge.js.map
