"use strict";

const JAVA_LIBRARY_PATH = "/usr/lib/jvm/java-11-openjdk-amd64/lib/jli";

function javaEnvironmentCommand(command) {
    // The caller may need to export additional variables before launching the
    // generated runner. Do not put `exec` before the whole command string.
    return `export LD_LIBRARY_PATH="${JAVA_LIBRARY_PATH}"; ${command}`;
}

// The judge host may expose many CPUs to a sandbox. Without an explicit
// processor count, HotSpot creates a large GC/compiler thread pool and can
// fail with pthread_create(EAGAIN) even when the submitted program uses one
// thread. Keep Java's runtime thread footprint bounded by the process limit.
// `binaryDirectory/run` is a generated launcher script, not a Java class.
// Keep executing that launcher and pass the limits through JAVA_TOOL_OPTIONS;
// invoking `java ... "$1"` makes HotSpot treat `/sandbox/*/run` as a class.
const JAVA_RUN_COMMAND = 'export JAVA_TOOL_OPTIONS="-XX:ActiveProcessorCount=2 -XX:CICompilerCount=2 -XX:ParallelGCThreads=2 -XX:ConcGCThreads=1"; exec "$1"';

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
            javaEnvironmentCommand(JAVA_RUN_COMMAND),
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
