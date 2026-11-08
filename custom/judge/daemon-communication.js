'use strict';

const path = require('path');
const { StandardJudger } = require('./standard');
const { compile } = require('./compile');
const { TaskStatus, RPCTaskType } = require('../../interfaces');
const { globalConfig } = require('../config');
const { readFileLength } = require('../../utils');
const { runTask } = require('../rmq');

// Additive daemon protocol value. Both rounds stay in one runner RPC so that
// intermediate data never travels through the queue or a shared data directory.
exports.PROBLEM_TYPE = 4;

class CommunicationJudger extends StandardJudger {
    async preprocessTestData() {
        if (!this.testData.communication) {
            throw new Error('Communication problems require a communication transformer in data.yml.');
        }
        await super.preprocessTestData();
        const transformer = this.testData.communication;
        const [name, result] = await compile(transformer.sourceCode, transformer.language, [], this.priority);
        if (result.status !== TaskStatus.Done) {
            throw new Error('===== Communication Transformer Compilation Message =====\n' + (result.message || 'Compilation failed.'));
        }
        this.transformerExecutableName = name;
    }

    async judgeTestcase(curCase, started) {
        const task = {
            testDataName: this.testData.name,
            inputData: curCase.input,
            answerData: curCase.output,
            time: this.parameters.timeLimit,
            memory: this.parameters.memoryLimit,
            userExecutableName: this.userCodeExecuableName,
            spjExecutableName: this.spjExecutableName,
            communication: { transformerExecutableName: this.transformerExecutableName }
        };
        const dataPath = path.join(globalConfig.testDataDirectory, this.testData.name);
        const [inputContent, outputContent, result] = await Promise.all([
            readFileLength(curCase.input ? path.join(dataPath, curCase.input) : null, globalConfig.dataDisplayLimit),
            readFileLength(curCase.output ? path.join(dataPath, curCase.output) : null, globalConfig.dataDisplayLimit),
            runTask({ type: RPCTaskType.RunStandard, task }, this.priority, started)
        ]);
        return Object.assign({}, result, {
            type: result.result,
            input: { name: curCase.input, content: inputContent },
            output: { name: curCase.output, content: outputContent }
        });
    }
}

exports.CommunicationJudger = CommunicationJudger;
