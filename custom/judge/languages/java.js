"use strict";

const JAVA_LIBRARY_PATH = "/usr/lib/jvm/java-11-openjdk-amd64/lib/jli";

function javaEnvironmentCommand(command) {
    return `export LD_LIBRARY_PATH="${JAVA_LIBRARY_PATH}"; exec ${command}`;
}

exports.lang = {
    name: "java",
    sourceFileName: "Main.java",
    fileExtension: "java",
    binarySizeLimit: 5000 * 1024,
    compile: (sourcePath, outputDirectory) => ({
        executable: "/bin/bash",
        parameters: [
            "bash",
            "-c",
            javaEnvironmentCommand("/usr/bin/compile-java \"$1\" \"$2\""),
            "compile-java",
            sourcePath,
            outputDirectory
        ],
        time: 5000,
        memory: 1024 * 1024 * 1024 * 2,
        process: 30,
        stderr: `${outputDirectory}/message.txt`,
        messageFile: "message.txt",
        workingDirectory: outputDirectory
    }),
    run: (binaryDirectory, workingDirectory, time, memory,
        stdinFile = null, stdoutFile = null, stderrFile = null) => ({
        executable: "/bin/bash",
        parameters: [
            "bash",
            "-c",
            javaEnvironmentCommand("\"$1\""),
            "java",
            `${binaryDirectory}/run`
        ],
        time,
        memory,
        process: 25,
        stdin: stdinFile,
        stdout: stdoutFile,
        stderr: stderrFile,
        workingDirectory
    })
};
