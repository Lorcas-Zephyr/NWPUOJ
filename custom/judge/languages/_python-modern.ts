export function createPythonLanguage(name: string, executable: string) {
    const command = executable.replace("/usr/bin/", "");
    const recursionBootstrap = "import runpy,sys;sys.setrecursionlimit(1000000);sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')";
    return {
        name,
        sourceFileName: "a.py",
        fileExtension: "py",
        binarySizeLimit: 5000 * 1024,

        compile: (sourcePath: string, outputDirectory: string) => ({
            executable: "/usr/bin/compile-script",
            parameters: [
                "compile-script",
                sourcePath,
                outputDirectory,
                `${command} -m py_compile a.py`
            ],
            time: 5000,
            memory: 1024 * 1024 * 1024,
            process: 10,
            stderr: `${outputDirectory}/message.txt`,
            messageFile: "message.txt",
            workingDirectory: outputDirectory
        }),

        run: (binaryDirectory: string, workingDirectory: string, time: number, memory: number,
            stdinFile = null, stdoutFile = null, stderrFile = null) => ({
            executable,
            parameters: [command, "-c", recursionBootstrap, `${binaryDirectory}/a.py`],
            time,
            memory,
            process: 1,
            stdin: stdinFile,
            stdout: stdoutFile,
            stderr: stderrFile,
            workingDirectory
        })
    };
}
