"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const redis = require("../redis");
const rmq = require("../rmq");
const utils_1 = require("../../utils");
const interfaces_1 = require("../../interfaces");
const winston = require("winston");
async function compile(code, language, extraFiles = [], priority) {
    // Extra sources belong to the immutable testdata snapshot. A header change
    // must not reuse a binary compiled for another problem or snapshot.
    const fingerprint = utils_1.codeFingerprint(extraFiles && extraFiles.length
        ? JSON.stringify({ code, extraFiles }) : code, language.name);
    winston.debug(`Compiling code, fingerprint = ${fingerprint}`);
    let result;
    const unlock = await redis.getCompileLock(fingerprint);
    winston.debug(`Got redis lock for ${fingerprint}`);
    try {
        if (await redis.checkBinaryExistance(fingerprint)) {
            winston.debug('Binary already exists. Exiting');
            result = { status: interfaces_1.TaskStatus.Done };
        }
        else {
            const task = {
                code: code,
                language: language.name,
                extraFiles: extraFiles,
                binaryName: fingerprint
            };
            result = await rmq.runTask({ type: interfaces_1.RPCTaskType.Compile, task: task }, priority);
        }
        return [fingerprint, result];
    }
    finally {
        await unlock();
    }
}
exports.compile = compile;
