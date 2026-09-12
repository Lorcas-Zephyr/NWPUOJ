export interface ExecParam {
    executable: string;
    parameters: string[];
    time: number;
    memory: number;
    process: number;
    stdin?: string | number;
    stdout?: string | number;
    stderr?: string | number;
    messageFile?: string;
    workingDirectory: string;
}

export interface Language {
    name: string;
    fileExtension: string;
    sourceFileName: string;
    binarySizeLimit: number;
    compile: (sourcePath: string, outputDirectory: string, doNotUseX32Abi: boolean) => ExecParam;
    run: (binaryDirectory: string, workingDirectory: string, time: number, memory: number,
        stdinFile?: string | number, stdoutFile?: string | number, stderrFile?: string | number) => ExecParam;
}

export const languages: Language[] = [
    require("./cpp"),
    require("./cpp11"),
    require("./cpp17"),
    require("./cpp20"),
    require("./cpp23"),
    require("./cpp-noilinux"),
    require("./cpp11-noilinux"),
    require("./cpp11-clang"),
    require("./cpp17-clang"),
    require("./c"),
    require("./c-noilinux"),
    require("./csharp"),
    require("./haskell"),
    require("./java"),
    require("./nodejs"),
    require("./pascal"),
    require("./python2"),
    require("./python3"),
    require("./python310"),
    require("./python311"),
    require("./pypy3"),
    require("./ruby")
].map(module => module.lang);

export function getLanguage(name: string): Language {
    return name == null ? null : languages.find(language => language.name === name);
}
