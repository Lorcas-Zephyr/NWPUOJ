"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const winston = require("winston");
const interfaces_1 = require("../interfaces");
const standard_1 = require("./standard");
const interfaces_2 = require("../../interfaces");
const testData_1 = require("../testData");
const utils_1 = require("../../utils");
const submit_answer_1 = require("./submit-answer");
const interaction_1 = require("./interaction");
const communication_1 = require("./communication");
async function judge(task, extraData, reportProgress, reportCompileProgress) {
    winston.verbose(`Judging ${task.taskId}`);
    let testData = null;
    try {
        winston.debug(`Reading rules file for ${task.testData}...`);
        testData = await testData_1.readRulesFile(utils_1.filterPath(task.testData));
    }
    catch (err) {
        winston.info(`Error reading test data for ${task.testData}`, err);
        return { error: interfaces_2.ErrorType.TestDataError, systemMessage: `An error occurred while parsing test data: ${err.toString()}` };
    }
    if (testData == null) {
        winston.verbose(`Test data ${task.testData} unavailable`);
        return { error: interfaces_2.ErrorType.TestDataError, systemMessage: "Testdata unavailable." };
    }
    let judger;
    console.log("Task typ: " + task.type);
    if (task.type === interfaces_1.ProblemType.Standard) {
        judger = new standard_1.StandardJudger(testData, task.param, task.priority);
    }
    else if (task.type === interfaces_1.ProblemType.AnswerSubmission) {
        judger = new submit_answer_1.AnswerSubmissionJudger(testData, extraData, task.priority);
    }
    else if (task.type === interfaces_1.ProblemType.Interaction) {
        judger = new interaction_1.InteractionJudger(testData, task.param, task.priority);
    }
    else if (task.type === communication_1.PROBLEM_TYPE) {
        judger = new communication_1.CommunicationJudger(testData, task.param, task.priority);
    }
    else {
        throw new Error(`Task type not supported`);
    }
    try {
        winston.debug(`Preprocessing testdata for ${task.testData}...`);
        await judger.preprocessTestData();
    }
    catch (err) {
        winston.verbose(`Test data ${task.testData} err`, err);
        return { error: interfaces_2.ErrorType.TestDataError, systemMessage: err.toString() };
    }
    winston.debug(`Compiling...`);
    const compileResult = await judger.compile();
    winston.debug(`Reporting compilation progress...`);
    await reportCompileProgress(compileResult);
    if (compileResult.status !== interfaces_2.TaskStatus.Done) {
        winston.verbose(`Compilation error: ${compileResult.message}`);
        return {
            compile: compileResult
        };
    }
    winston.debug(`Judging...`);
    const judgeResult = await judger.judge(r => reportProgress({ compile: compileResult, judge: r }));
    await judger.cleanup();
    return { compile: compileResult, judge: judgeResult };
}
exports.judge = judge;
