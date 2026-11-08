'use strict';

// Run only in a disposable, network-disabled judge container. Uses real
// compilers/sandboxes and daemon dispatch, with local cache/RPC substitutes.
// No database, production queue, submission, or shared upload volume is used.
const assert = require('assert');
const path = require('path');
const fs = require('/app/node_modules/fs-extra');
const root = '/tmp/communication-smoke';
const config = require('/app/lib/runner/config').globalConfig;
const metadata = new Map();
function substitute(name, exports) { require.cache[require.resolve(name)] = { exports }; }

substitute('/app/lib/runner/executable', {
  async pushBinary(name, language, code, directory) {
    const target = path.join(root, 'binaries', name);
    await fs.copy(directory, target);
    metadata.set(name, [target, language, code]);
  },
  async fetchBinary(name) { assert(metadata.has(name), 'Missing local binary'); return metadata.get(name); }
});
substitute('/app/lib/daemon/config', { globalConfig: { testDataDirectory: config.testDataDirectory, dataDisplayLimit: 128 } });
substitute('/app/lib/daemon/redis', {
  getCompileLock: async () => async () => {},
  checkBinaryExistance: async name => metadata.has(name)
});
let queue = Promise.resolve();
const compiler = require('/app/lib/runner/compile');
const runner = require('/app/lib/runner/judge');
substitute('/app/lib/daemon/rmq', {
  runTask(task, _priority, started) {
    const next = queue.then(async () => {
      if (started) await started();
      if (task.type === 1) return compiler.compile(task.task);
      assert.equal(task.type, 2);
      return runner.judgeStandard(task.task);
    });
    queue = next.catch(() => {});
    return next;
  }
});
const { judge } = require('/app/lib/daemon/judge');
const { convertResult } = require('/app/lib/judgeResult');

async function check(name, language, code, expected, options = {}) {
  const dataName = options.data || 'example';
  const result = await judge({ taskId: 'isolated-communication-test', type: options.type || 4,
    testData: dataName, priority: 1, param: { language, code, timeLimit: options.time || 5000, memoryLimit: 256 }
  }, null, () => {}, async () => {});
  const converted = convertResult('isolated-communication-test', result);
  assert.equal(converted.statusString, expected, name + ': ' + JSON.stringify(result));
  if (expected === 'Accepted' && (options.type || 4) === 4) {
    const cases = result.judge.subtasks[0].cases;
    for (const c of cases) assert.equal(c.result.communication.rounds.length, 2);
  }
  console.log('SMOKE PASS ' + name + ': ' + expected);
  return result;
}

(async () => {
  await fs.ensureDir(root);
  await fs.copy('/fixture/examples/communication', path.join(config.testDataDirectory, 'example'));
  const cpp = await fs.readFile('/fixture/examples/communication/solution.cpp', 'utf8');
  for (const language of ['cpp11', 'cpp17', 'cpp20', 'cpp23']) await check(language, language, cpp, 'Accepted');
  await check('c', 'c', '#include <stdio.h>\nint main(){int p;long long a,b;if(scanf("%d",&p)!=1)return 1;if(p==1){scanf("%lld%lld",&a,&b);printf("%lld\\n",a+b);}else{scanf("%lld",&a);printf("%lld\\n",2*a);}return 0;}', 'Accepted');
  const python = 'import sys, os\nv = list(map(int, sys.stdin.read().split()))\nassert not os.path.exists("carry")\nopen("carry", "w").write("cannot cross rounds")\nprint(v[1]+v[2] if v[0]==1 else 2*v[1])\n';
  for (const language of ['python311', 'pypy3']) await check(language + ' isolation', language, python, 'Accepted');
  await check('java', 'java', 'import java.util.*; public class Main { public static void main(String[] args) { Scanner s=new Scanner(System.in); int p=s.nextInt(); long a=s.nextLong(); System.out.println(p==1 ? a+s.nextLong() : 2*a); }}', 'Accepted');
  await check('first round nonzero exit', 'python311', 'print(11)\nraise RuntimeError("round 1")\n', 'Runtime Error');
  await check('second round nonzero exit', 'python311', 'import sys\nv=list(map(int,sys.stdin.read().split()))\nif v[0]==1: print(v[1]+v[2])\nelse: raise RuntimeError("round 2")\n', 'Runtime Error');
  await check('wrong communication', 'python311', 'print(0)\n', 'Wrong Answer');
  await check('malformed communication', 'python311', 'print("invalid")\n', 'Presentation Error');
  await check('wrong second round', 'python311', 'import sys\nv=list(map(int,sys.stdin.read().split()))\nprint(v[1]+v[2] if v[0]==1 else 0)\n', 'Wrong Answer');
  await check('round 1 timeout', 'cpp17', 'int main(){while(true){}}', 'Time Limit Exceeded', { time: 100 });
  await check('round 2 timeout', 'cpp17', '#include <iostream>\nint main(){int p;long long a,b;std::cin>>p>>a;if(p==1){std::cin>>b;std::cout<<a+b;}else{while(true){}}}', 'Time Limit Exceeded', { time: 100 });
  await check('compile failure', 'cpp17', 'this is not C++', 'Compile Error');

  await fs.copy(path.join(config.testDataDirectory, 'example'), path.join(config.testDataDirectory, 'broken'));
  await fs.writeFile(path.join(config.testDataDirectory, 'broken', 'transform.cpp'), 'int main(){return 3;}');
  await check('transformer failure', 'cpp17', cpp, 'Judgement Failed', { data: 'broken' });
  await fs.writeFile(path.join(config.testDataDirectory, 'broken', 'transform.cpp'), 'this does not compile');
  const broken = await judge({ taskId: 'isolated', type: 4, testData: 'broken', priority: 1,
    param: { language: 'cpp17', code: cpp, timeLimit: 1000, memoryLimit: 256 }
  }, null, () => {}, async () => {});
  assert.equal(broken.error, 1);
  assert(/Transformer Compilation/.test(broken.systemMessage));
  console.log('SMOKE PASS transformer compile failure: TestDataError');

  await fs.ensureDir(path.join(config.testDataDirectory, 'traditional'));
  await fs.writeFile(path.join(config.testDataDirectory, 'traditional', '1.in'), '4 7\n');
  await fs.writeFile(path.join(config.testDataDirectory, 'traditional', '1.out'), '11\n');
  await check('ordinary problem regression', 'cpp17', '#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b;}', 'Accepted', { type: 1, data: 'traditional' });
  console.log('SMOKE COMPLETE');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
