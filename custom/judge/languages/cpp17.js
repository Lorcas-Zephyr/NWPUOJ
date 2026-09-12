"use strict";

// Large testlib-based checkers and interactors need more time to compile than
// ordinary submissions. Their execution time limits remain unchanged.
exports.lang = {
    name: "cpp17",
    sourceFileName: "a.cpp",
    fileExtension: "cpp",
    binarySizeLimit: 5000 * 1024,
    compile: (sourcePath, outputDirectory, doNotUseX32Abi) => ({
        executable: "/usr/bin/g++-8",
        parameters: ["g++-8", sourcePath, "-o", `${outputDirectory}/a.out`, "-std=c++17", "-O2", "-fdiagnostics-color=always", "-DONLINE_JUDGE", !doNotUseX32Abi && "-mx32"].filter(x => x),
        time: 15000,
        memory: 1024 * 1024 * 1024 * 2,
        process: 10,
        stderr: `${outputDirectory}/message.txt`,
        messageFile: 'message.txt',
        workingDirectory: outputDirectory
    }),
    run: (binaryDirectory, workingDirectory, time, memory, stdinFile = null, stdoutFile = null, stderrFile = null) => ({
        executable: `${binaryDirectory}/a.out`,
        parameters: [],
        time: time,
        memory: memory,
        stackSize: memory,
        process: 1,
        stdin: stdinFile,
        stdout: stdoutFile,
        stderr: stderrFile,
        workingDirectory: workingDirectory
    })
};
