export const lang = {
    name: "cpp17",
    sourceFileName: "a.cpp",
    fileExtension: "cpp",
    binarySizeLimit: 5000 * 1024,
    compile: (sourcePath: string, outputDirectory: string, doNotUseX32Abi: boolean) => ({
        executable: "/usr/bin/g++-8",
        parameters: ["g++-8", sourcePath, "-o", `${outputDirectory}/a.out`, "-std=c++17", "-O2", "-fdiagnostics-color=always", "-DONLINE_JUDGE", !doNotUseX32Abi && "-mx32"].filter(x => x),
        time: 15000,
        memory: 2 * 1024 * 1024 * 1024,
        process: 10,
        stderr: `${outputDirectory}/message.txt`,
        messageFile: "message.txt",
        workingDirectory: outputDirectory
    }),
    run: (binaryDirectory: string, workingDirectory: string, time: number, memory: number, stdinFile = null, stdoutFile = null, stderrFile = null) => ({
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
