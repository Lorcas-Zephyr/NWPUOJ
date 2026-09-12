"use strict";

function createCppLanguage(name, standard, compiler = "/usr/bin/g++-13") {
    const compilerCommand = compiler.substring(compiler.lastIndexOf("/") + 1);
    return {
        name,
        sourceFileName: "a.cpp",
        fileExtension: "cpp",
        binarySizeLimit: 5000 * 1024,
        compile: (sourcePath, outputDirectory) => ({
            executable: compiler,
            parameters: [
                compilerCommand,
                sourcePath,
                "-o", `${outputDirectory}/a.out`,
                `-std=${standard}`,
                "-O2",
                "-fdiagnostics-color=always",
                "-DONLINE_JUDGE"
            ],
            time: 5000,
            memory: 2 * 1024 * 1024 * 1024,
            process: 10,
            stdout: `${outputDirectory}/message.txt`,
            stderr: `${outputDirectory}/message.txt`,
            messageFile: "message.txt",
            workingDirectory: outputDirectory
        }),
        run: (binaryDirectory, workingDirectory, time, memory,
            stdinFile = null, stdoutFile = null, stderrFile = null) => ({
            executable: `${binaryDirectory}/a.out`,
            parameters: [],
            time,
            memory,
            stackSize: memory,
            process: 1,
            stdin: stdinFile,
            stdout: stdoutFile,
            stderr: stderrFile,
            workingDirectory
        })
    };
}

exports.createCppLanguage = createCppLanguage;
