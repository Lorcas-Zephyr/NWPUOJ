'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const sourceRoot = path.resolve(process.argv[2] || '/tmp/nwpuoj-sncpc-import/source/sncpc');
const outputRoot = path.resolve(process.argv[3] || '/tmp/nwpuoj-sncpc-import/prepared');
const problemsRoot = path.join(sourceRoot, 'problems');
const buildRoot = path.join(outputRoot, '.build');

function decodeXml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attribute(fragment, name) {
  const match = new RegExp(`${name}="([^"]*)"`).exec(fragment || '');
  return match ? decodeXml(match[1]) : null;
}

function firstMatch(text, pattern, label) {
  const match = pattern.exec(text);
  if (!match) throw new Error(`Missing ${label}`);
  return decodeXml(match[1]);
}

function run(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    encoding: options.encoding || 'utf8',
    timeout: options.timeout || 120000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe']
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error && result.error.message || result.stderr || `exit ${result.status}`}`);
  }
  return result;
}

function compile(source, destination, includeDirectory) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const args = ['-std=gnu++23', '-O2', '-pipe'];
  if (includeDirectory) args.push('-I', includeDirectory);
  args.push(source, '-o', destination);
  run('g++', args, { timeout: 180000 });
}

function spawnToFile(command, args, input, output, timeout = 120000) {
  const inputFd = input ? fs.openSync(input, 'r') : 'ignore';
  const outputFd = fs.openSync(output, 'w');
  try {
    run(command, args, { timeout, stdio: [inputFd, outputFd, 'pipe'] });
  } finally {
    if (typeof inputFd === 'number') fs.closeSync(inputFd);
    fs.closeSync(outputFd);
  }
}

function replaceTextCommands(value) {
  let text = value;
  const commands = [
    ['textbf', '**', '**'],
    ['textit', '*', '*'],
    ['emph', '*', '*'],
    ['texttt', '`', '`'],
    ['underline', '', '']
  ];
  for (let pass = 0; pass < 4; pass++) {
    for (const [command, open, close] of commands) {
      text = text.replace(new RegExp(`\\\\${command}\\{([^{}]*)\\}`, 'g'), `${open}$1${close}`);
    }
  }
  return text;
}

function tableToMarkdown(body) {
  const rows = body.replace(/\\hline/g, '').split(/\\\\/).map(row => row.trim()).filter(Boolean);
  if (!rows.length) return '';
  return '\n\n' + rows.map(row => row.split('&').map(cell => cell.trim()).join(' | ')).join('\n') + '\n\n';
}

function texToMarkdown(source, assetDirectory, assetOutputDirectory, assetUrlRoot) {
  let text = String(source || '').replace(/\r/g, '');
  text = text.replace(/\\begin\{tabular\}\{[^}]*\}([\s\S]*?)\\end\{tabular\}/g, (_all, body) => tableToMarkdown(body));
  text = text.replace(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g, (_all, filename) => {
    const imagePath = path.join(assetDirectory, filename);
    if (!fs.existsSync(imagePath)) throw new Error(`Statement image is missing: ${filename}`);
    fs.mkdirSync(assetOutputDirectory, { recursive: true });
    fs.copyFileSync(imagePath, path.join(assetOutputDirectory, path.basename(filename)));
    return `\n\n![题目示意图](${assetUrlRoot}/${encodeURIComponent(path.basename(filename))})\n\n`;
  });
  text = text.replace(/\\epigraph\{/g, '> ').replace(/\}\{\}/g, '');
  text = replaceTextCommands(text);
  text = text.replace(/\\href\{([^}]+)\}\{([^}]+)\}/g, '[$2]($1)');
  text = text.replace(/\\url\{([^}]+)\}/g, '<$1>');
  text = text.replace(/\\begin\{(?:itemize|enumerate|center)\}|\\end\{(?:itemize|enumerate|center)\}/g, '');
  text = text.replace(/^[ \t]*\\item[ \t]*/gm, '- ');
  text = text.replace(/\\hline/g, '');
  text = text.replace(/\\([#%&_{}])/g, '$1');
  text = text.replace(/``/g, '“').replace(/''/g, '”');
  text = text.replace(/[ \t]+\\\\[ \t]*/g, '\n');
  return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

function sampleMarkdown(directory) {
  const inputs = fs.readdirSync(directory)
    .filter(name => /^example\.\d+$/.test(name))
    .sort((left, right) => Number(left.split('.')[1]) - Number(right.split('.')[1]));
  return inputs.map((name, index) => {
    const input = fs.readFileSync(path.join(directory, name), 'utf8').replace(/\r/g, '').trimEnd();
    const answer = fs.readFileSync(path.join(directory, `${name}.a`), 'utf8').replace(/\r/g, '').trimEnd();
    const suffix = inputs.length > 1 ? ` #${index + 1}` : '';
    return `### 输入${suffix}\n\n\`\`\`text\n${input}\n\`\`\`\n\n### 输出${suffix}\n\n\`\`\`text\n${answer}\n\`\`\``;
  }).join('\n\n');
}

function testSpecs(xml) {
  const block = firstMatch(xml, /<testset name="tests">([\s\S]*?)<\/testset>/, 'tests testset');
  return Array.from(block.matchAll(/<test\b([^>]*)\/>/g)).map((match, index) => ({
    id: index + 1,
    command: attribute(match[1], 'cmd'),
    sample: attribute(match[1], 'sample') === 'true'
  }));
}

function sourcePathFor(xml, kind) {
  const pattern = kind === 'main'
    ? /<solution tag="main">[\s\S]*?<source path="([^"]+)"/
    : /<interactor>[\s\S]*?<source path="([^"]+)"/;
  const match = pattern.exec(xml);
  return match ? decodeXml(match[1]) : null;
}

function checkerSourcePath(xml) {
  const block = /<checker(?:\s[^>]*)?>([\s\S]*?)<\/checker>/.exec(xml);
  if (!block) return null;
  const source = /<source path="([^"]+)"/.exec(block[1]);
  return source ? decodeXml(source[1]) : null;
}

function executableSources(xml) {
  const result = new Map();
  for (const match of xml.matchAll(/<executable>([\s\S]*?)<\/executable>/g)) {
    const source = /<source path="([^"]+)"/.exec(match[1]);
    const binary = /<binary path="([^"]+)"/.exec(match[1]);
    if (source && binary) result.set(path.basename(binary[1], path.extname(binary[1])), source[1]);
  }
  return result;
}

function generateMissingTests(problemDirectory, xml, specs, slug) {
  const testDirectory = path.join(problemDirectory, 'tests');
  const generators = executableSources(xml);
  const compiled = new Map();
  for (const spec of specs) {
    const filename = String(spec.id).padStart(2, '0');
    const target = path.join(testDirectory, filename);
    if (fs.existsSync(target)) continue;
    if (!spec.command) throw new Error(`${slug}: manual test ${spec.id} is missing`);
    const [name, ...args] = spec.command.trim().split(/\s+/);
    const source = generators.get(name);
    if (!source) throw new Error(`${slug}: generator ${name} was not found`);
    let binary = compiled.get(name);
    if (!binary) {
      binary = path.join(buildRoot, slug, `generator-${name}`);
      compile(path.join(problemDirectory, source), binary, path.join(problemDirectory, 'files'));
      compiled.set(name, binary);
    }
    spawnToFile(binary, args, null, target);
  }
}

function withoutTestlibInclude(source) {
  return source.replace(/^\s*#\s*include\s*[<"]testlib\.h[>"]\s*$/gm, '');
}

function checkerAdapter(problemDirectory, sourcePath) {
  const testlib = fs.readFileSync(path.join(problemDirectory, 'files', 'testlib.h'), 'utf8');
  const checker = withoutTestlibInclude(fs.readFileSync(path.join(problemDirectory, sourcePath), 'utf8'));
  return [
    '#define TESTLIB_THROW_EXIT_EXCEPTION_INSTEAD_OF_EXIT',
    testlib,
    '#define main polygon_checker_main',
    checker,
    '#undef main',
    'int main() {',
    '  char a0[] = "checker", a1[] = "input", a2[] = "user_out", a3[] = "answer";',
    '  char* argv[] = {a0, a1, a2, a3};',
    '  try { polygon_checker_main(4, argv); }',
    '  catch (exit_exception &error) { std::cout << (error.getExitCode() == 0 ? 100 : 0) << "\\n"; return 0; }',
    '  std::cout << 0 << "\\n";',
    '  return 0;',
    '}'
  ].join('\n');
}

function interactorAdapter(problemDirectory, sourcePath) {
  const testlib = fs.readFileSync(path.join(problemDirectory, 'files', 'testlib.h'), 'utf8');
  const interactor = withoutTestlibInclude(fs.readFileSync(path.join(problemDirectory, sourcePath), 'utf8'));
  return [
    '#define TESTLIB_THROW_EXIT_EXCEPTION_INSTEAD_OF_EXIT',
    testlib,
    '#define main polygon_interactor_main',
    interactor,
    '#undef main',
    'int main() {',
    '  char a0[] = "interactor", a1[] = "input", a2[] = "interaction.log", a3[] = "answer";',
    '  char* argv[] = {a0, a1, a2, a3};',
    '  int score = 0;',
    '  try { polygon_interactor_main(4, argv); }',
    '  catch (exit_exception &error) { score = error.getExitCode() == 0 ? 100 : 0; }',
    '  std::ofstream result("score.txt"); result << score << "\\n";',
    '  return 0;',
    '}'
  ].join('\n');
}

function dataYaml(caseIds, options = {}) {
  const lines = ['inputFile: "#.in"', 'outputFile: "#.ans"'];
  if (options.checker) lines.push('specialJudge:', '  language: cpp17', '  fileName: checker.cpp');
  if (options.interactor) lines.push('interactor:', '  language: cpp17', '  fileName: interactor.cpp');
  lines.push('subtasks:', '  - score: 100', '    type: sum', `    cases: [${caseIds.join(', ')}]`, '');
  return lines.join('\n');
}

function contestOrder() {
  const xml = fs.readFileSync(path.join(sourceRoot, 'contest.xml'), 'utf8');
  return Array.from(xml.matchAll(/<problem index="([^"]+)"[^>]*\/([^/"<>]+)"\/>/g))
    .map(match => ({ index: match[1].toUpperCase(), slug: match[2] }));
}

function prepareProblem(entry) {
  const problemDirectory = path.join(problemsRoot, entry.slug);
  const xml = fs.readFileSync(path.join(problemDirectory, 'problem.xml'), 'utf8');
  const specs = testSpecs(xml);
  generateMissingTests(problemDirectory, xml, specs, entry.slug);
  const statementDirectory = path.join(problemDirectory, 'statement-sections', 'chinese');
  const title = fs.readFileSync(path.join(statementDirectory, 'name.tex'), 'utf8').trim();
  const timeLimit = Number(firstMatch(xml, /<time-limit>(\d+)<\/time-limit>/, 'time limit'));
  const memoryBytes = Number(firstMatch(xml, /<memory-limit>(\d+)<\/memory-limit>/, 'memory limit'));
  const declaredTests = Number(firstMatch(xml, /<test-count>(\d+)<\/test-count>/, 'test count'));
  const type = sourcePathFor(xml, 'interactor') ? 'interaction' : 'traditional';
  const destination = path.join(outputRoot, entry.slug);
  const dataDirectory = path.join(destination, 'testdata');
  const assetOutputDirectory = path.join(outputRoot, '.assets', entry.slug);
  const assetUrlRoot = `/self/image-assets/sncpc-2026/${encodeURIComponent(entry.slug)}`;
  fs.rmSync(destination, { recursive: true, force: true });
  fs.rmSync(assetOutputDirectory, { recursive: true, force: true });
  fs.mkdirSync(dataDirectory, { recursive: true });

  const caseIds = specs.map(spec => spec.id);
  for (const id of caseIds) {
    const source = path.join(problemDirectory, 'tests', String(id).padStart(2, '0'));
    if (!fs.existsSync(source)) throw new Error(`${entry.slug}: test ${id} is missing after generation`);
    fs.copyFileSync(source, path.join(dataDirectory, `${id}.in`));
  }
  if (declaredTests !== caseIds.length) throw new Error(`${entry.slug}: declared ${declaredTests}, parsed ${caseIds.length}`);

  if (type === 'traditional') {
    const mainSource = sourcePathFor(xml, 'main');
    const solution = path.join(buildRoot, entry.slug, 'main-solution');
    compile(path.join(problemDirectory, mainSource), solution, path.join(problemDirectory, 'files'));
    for (const id of caseIds) {
      spawnToFile(solution, [], path.join(dataDirectory, `${id}.in`), path.join(dataDirectory, `${id}.ans`), Math.max(120000, timeLimit * 20));
      if (!fs.statSync(path.join(dataDirectory, `${id}.ans`)).size) throw new Error(`${entry.slug}: answer ${id} is empty`);
    }
  } else {
    for (const id of caseIds) fs.writeFileSync(path.join(dataDirectory, `${id}.ans`), '');
  }

  const checkerPath = checkerSourcePath(xml);
  const checkerName = attribute((/<checker([^>]*)>/.exec(xml) || [])[1], 'name');
  const customChecker = type === 'traditional' && checkerPath && checkerName !== 'std::ncmp.cpp';
  if (customChecker) {
    const source = checkerAdapter(problemDirectory, checkerPath);
    fs.writeFileSync(path.join(dataDirectory, 'checker.cpp'), source);
    compile(path.join(dataDirectory, 'checker.cpp'), path.join(buildRoot, entry.slug, 'checker'));
  }
  if (type === 'interaction') {
    const source = interactorAdapter(problemDirectory, sourcePathFor(xml, 'interactor'));
    fs.writeFileSync(path.join(dataDirectory, 'interactor.cpp'), source);
    compile(path.join(dataDirectory, 'interactor.cpp'), path.join(buildRoot, entry.slug, 'interactor'));
  }
  fs.writeFileSync(path.join(dataDirectory, 'data.yml'), dataYaml(caseIds, { checker: customChecker, interactor: type === 'interaction' }));

  const section = name => {
    const filename = path.join(statementDirectory, `${name}.tex`);
    return fs.existsSync(filename)
      ? texToMarkdown(fs.readFileSync(filename, 'utf8'), statementDirectory, assetOutputDirectory, assetUrlRoot)
      : '';
  };
  const notes = section('notes');
  const sourceNote = '题目来源：2026 年第 14 届陕西省大学生程序设计竞赛。';
  const metadata = {
    title,
    description: section('legend'),
    input_format: section('input'),
    output_format: section('output'),
    example: sampleMarkdown(statementDirectory),
    limit_and_hint: [notes, sourceNote].filter(Boolean).join('\n\n'),
    type,
    time_limit: timeLimit,
    python_time_limit_multiplier: 2,
    memory_limit: Math.ceil(memoryBytes / 1024 / 1024),
    file_io: false,
    file_io_input_name: null,
    file_io_output_name: null,
    vjudge_config: null,
    is_anonymous: false
  };
  fs.writeFileSync(path.join(destination, 'problem.json'), JSON.stringify(metadata, null, 2) + '\n');
  fs.writeFileSync(path.join(destination, 'statement.md'), metadata.description + '\n');
  return { index: entry.index, slug: entry.slug, title, type, declared_tests: declaredTests, actual_tests: caseIds.length, custom_checker: customChecker };
}

function main() {
  fs.mkdirSync(outputRoot, { recursive: true });
  const manifest = contestOrder().map(prepareProblem);
  fs.writeFileSync(path.join(outputRoot, 'manifest.json'), JSON.stringify({ tag: '2026陕西省赛', problems: manifest }, null, 2) + '\n');
  fs.rmSync(buildRoot, { recursive: true, force: true });
  for (const problem of manifest) console.log(`${problem.index} ${problem.slug}: ${problem.title} (${problem.actual_tests} tests${problem.custom_checker ? ', SPJ' : ''})`);
}

main();
