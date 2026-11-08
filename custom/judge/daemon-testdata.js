"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const yaml = require("js-yaml");
const fse = require("fs-extra");
const pathLib = require("path");
const languages_1 = require("../languages");
const utils_1 = require("../utils");
const interfaces_1 = require("./interfaces");
const config_1 = require("./config");
function filterHyphen(input) {
    if (input == null || input === '-')
        return null;
    else
        return input;
}
function parseScoringType(typeString) {
    if (typeString === 'sum')
        return interfaces_1.SubtaskScoringType.Summation;
    else if (typeString === 'mul')
        return interfaces_1.SubtaskScoringType.Multiple;
    else if (typeString === 'min')
        return interfaces_1.SubtaskScoringType.Minimum;
    throw new Error("Subtask type must be one of the following: sum, mul, min");
}
async function parseExecutable(src, dataPath) {
    return { sourceCode: await fse.readFile(pathLib.join(dataPath, utils_1.filterPath(src.fileName)), 'utf8'), language: languages_1.getLanguage(src.language) };
}
async function parseYamlContent(obj, dataName) {
    const dataPath = pathLib.join(config_1.globalConfig.testDataDirectory, dataName);
    let extraFiles = {};
    if (obj.extraSourceFiles) {
        for (let l of obj.extraSourceFiles) {
            extraFiles[l.language] = [];
            for (let f of l.files) {
                extraFiles[l.language].push({
                    name: utils_1.filterPath(f.dest),
                    content: await fse.readFile(pathLib.join(dataPath, utils_1.filterPath(f.name)), 'utf8')
                });
            }
        }
    }
    return {
        subtasks: obj.subtasks.map(s => ({
            score: s.score,
            type: parseScoringType(s.type),
            cases: s.cases.map(c => ({
                input: obj.inputFile ? utils_1.filterPath(obj.inputFile.replace('#', c.toString())) : null,
                output: obj.outputFile ? utils_1.filterPath(obj.outputFile.replace('#', c.toString())) : null,
                userOutputFile: obj.userOutput ? utils_1.filterPath(obj.userOutput.replace('#', c.toString())) : null,
                name: c.toString()
            }))
        })),
        spj: obj.specialJudge && await parseExecutable(obj.specialJudge, dataPath),
        extraSourceFiles: extraFiles,
        interactor: obj.interactor && await parseExecutable(obj.interactor, dataPath),
        communication: obj.communication && await parseExecutable(obj.communication, dataPath),
        name: dataName,
    };
}
async function readRulesFile(dataName) {
    const dataPath = pathLib.join(config_1.globalConfig.testDataDirectory, dataName);
    let fileContent = await utils_1.tryReadFile(pathLib.join(dataPath, 'data.yml'));
    if (fileContent != null) {
        return parseYamlContent(yaml.safeLoad(fileContent), dataName);
    }
    else {
        let spj = null;
        for (const lang of languages_1.languages) {
            const spjName = pathLib.join(dataPath, "spj_" + lang.name + "." + lang.fileExtension);
            if (await fse.pathExists(spjName)) {
                spj = { sourceCode: await fse.readFile(spjName, 'utf8'), language: lang };
                break;
            }
        }
        let cases = [];
        let dirContent;
        try {
            dirContent = await fse.readdir(dataPath);
        }
        catch (err) {
            if (err.code === 'ENOENT') {
                return null;
            }
            throw err;
        }
        for (let fileName of await fse.readdir(dataPath)) {
            let outputFileName = null;
            const fileNameRegex = /^(.*)\.in$/;
            const matchResult = fileNameRegex.exec(fileName);
            if (matchResult != null) {
                const filePrefix = matchResult[1];
                if ((await fse.stat(pathLib.join(dataPath, fileName))).isFile()) {
                    const outputPathPrefix = pathLib.join(dataPath, filePrefix);
                    if (await fse.pathExists(outputPathPrefix + '.out')) {
                        outputFileName = filePrefix + '.out';
                    }
                    else if (await fse.pathExists(outputPathPrefix + '.ans')) {
                        outputFileName = filePrefix + '.ans';
                    }
                }
                if (outputFileName != null) {
                    cases.push({
                        input: filePrefix + '.in',
                        output: outputFileName,
                        name: filePrefix
                    });
                }
            }
        }
        cases.sort((a, b) => utils_1.compareStringByNumber(a.name, b.name));
        return !cases.length ? null : {
            subtasks: [{
                    score: 100,
                    type: interfaces_1.SubtaskScoringType.Summation,
                    cases: cases
                }],
            spj: spj,
            name: dataName,
            extraSourceFiles: {}
        };
    }
}
exports.readRulesFile = readRulesFile;
