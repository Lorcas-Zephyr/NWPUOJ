'use strict';

// Run in a disposable judge container with --network none. Compilation, pipes,
// and sandboxes are real; binary storage and daemon RPC stay in this container.
const assert = require('assert').strict;
const path = require('path');
const fs = require('/app/node_modules/fs-extra');
const config = require('/app/lib/runner/config').globalConfig;
const metadata = new Map();
function substitute(name, exports) { require.cache[require.resolve(name)] = { exports }; }
substitute('/app/lib/runner/executable', {
  async pushBinary(name, language, code, directory) {
    const target = path.join(config.binaryDirectory, name);
    await fs.copy(directory, target);
    metadata.set(name, [target, language, code]);
  },
  async fetchBinary(name) { assert(metadata.has(name)); return metadata.get(name); }
});
substitute('/app/lib/daemon/config', { globalConfig: { testDataDirectory: config.testDataDirectory, dataDisplayLimit: 128 } });
substitute('/app/lib/daemon/redis', { getCompileLock: async () => async () => {}, checkBinaryExistance: async name => metadata.has(name) });
const compiler = require('/app/lib/runner/compile');
const runner = require('/app/lib/runner/judge');
const { RPCTaskType } = require('/app/lib/interfaces');
const { ProblemType } = require('/app/lib/daemon/interfaces');
let queue = Promise.resolve();
substitute('/app/lib/daemon/rmq', {
  runTask(task, _priority, started) {
    const next = queue.then(async () => {
      if (started) await started();
      if (task.type === RPCTaskType.Compile) return compiler.compile(task.task);
      assert.equal(task.type, RPCTaskType.RunInteraction);
      return runner.judgeInteraction(task.task);
    });
    queue = next.catch(() => {});
    return next;
  }
});
const { judge } = require('/app/lib/daemon/judge');
const { convertResult } = require('/app/lib/judgeResult');
const cpp = '#include <iostream>\nint main(){long long n;if(!(std::cin>>n))return 0;long long l=1,r=n;while(l<=r){long long m=(l+r)/2;std::cout<<"? "<<m<<std::endl;char c;if(!(std::cin>>c)||c==\'E\')return 0;if(c==\'=\'){std::cout<<"! "<<m<<std::endl;return 0;}if(c==\'<\')r=m-1;else l=m+1;}}';
const python = 'import sys\nn=int(input())\nl,r=1,n\nwhile l<=r:\n m=(l+r)//2\n print("?",m,flush=True)\n c=sys.stdin.readline().strip()\n if c=="=":\n  print("!",m,flush=True)\n  break\n if c=="<": r=m-1\n elif c==">": l=m+1\n else: break\n';
async function check(name, language, code, expected, data='example', time=1500) {
  const result = await judge({ taskId:'isolated-interaction',type:ProblemType.Interaction,testData:data,priority:1,
    param:{language,code,timeLimit:time,memoryLimit:512}},null,()=>{},async()=>{});
  assert.equal(convertResult('isolated-interaction',result).statusString,expected,name+': '+JSON.stringify(result));
  console.log('SMOKE PASS '+name+': '+expected);
  return result;
}
(async()=>{
  const example = path.join(config.testDataDirectory,'example');
  await fs.ensureDir(example);
  await fs.writeFile(path.join(example,'1.in'),'10 7\n');
  await fs.writeFile(path.join(example,'1.ans'),'OK\n');
  await fs.writeFile(path.join(example,'data.yml'),'inputFile: "#.in"\noutputFile: "#.ans"\ninteractor:\n  language: cpp17\n  fileName: interactor.cpp\nsubtasks:\n  - score: 100\n    type: sum\n    cases: [1]\n');
  await fs.writeFile(path.join(example,'interactor.cpp'),`#include <bits/stdc++.h>
using namespace std;
int main(){ifstream input("input");int n,x;input>>n>>x;cout<<n<<endl;string op,extra;int y,used=0;
auto finish=[](int score,const char* message){ofstream("score.txt")<<score;cerr<<message<<endl;return 0;};
while(cin>>op>>y){if(y<1||y>n)return finish(0,"Out of range");
if(op=="!"){if(y!=x)return finish(0,"Wrong answer");if(cin>>extra)return finish(0,"Trailing output");return finish(100,"Accepted after EOF");}
if(op!="?"||++used>5)return finish(0,"Invalid query");cout<<(x<y?"<":x>y?">":"=")<<endl;}
return finish(0,"EOF without final answer");}`);
  if(process.env.REPRO_EXPECT_TIMEOUT==='1') {
    await check('reproduce parent pipe keeping EOF open','cpp17',cpp,'Time Limit Exceeded');
    return;
  }
  for(const language of ['cpp17','cpp23']) await check(language+' final answer followed by EOF',language,cpp,'Accepted');
  for(const language of ['python311','pypy3']) await check(language+' final answer followed by EOF',language,python,'Accepted');
  await check('wrong answer','python311','print("! 1",flush=True)\n','Wrong Answer');
  await check('trailing output','python311','print("! 7\\nextra",flush=True)\n','Wrong Answer');
  await check('EOF without final answer','python311','input()\n','Wrong Answer');
  await check('nonzero exit','python311','input()\nraise RuntimeError("fixture")\n','Runtime Error');
  await check('query limit','python311','import sys\ninput()\nfor i in range(6):\n print("? 1",flush=True)\n if not sys.stdin.readline(): break\n','Wrong Answer');
  await check('contestant timeout','cpp17','int main(){while(true){}}','Time Limit Exceeded','example',100);
  const fixed = path.join(config.testDataDirectory,'fixed');
  await fs.copy(example,fixed);
  await fs.writeFile(path.join(fixed,'1.ans'),'NOJ_FIXED_GROUP_V1 fixture\n');
  await check('existing fixed group behavior','cpp17',cpp,'Accepted','fixed');
  const noAnswer = path.join(config.testDataDirectory,'no-answer');
  await fs.copy(example,noAnswer);
  await fs.writeFile(path.join(noAnswer,'data.yml'),(await fs.readFile(path.join(noAnswer,'data.yml'),'utf8')).replace('outputFile: "#.ans"\n',''));
  await check('interactor without answer file','cpp17',cpp,'Accepted','no-answer');
  if(await fs.pathExists('/problem-fixture/data.yml')) {
    await fs.copy('/problem-fixture',path.join(config.testDataDirectory,'actual-problem'));
    for(const language of ['cpp17','python311','pypy3']) await check('problem 911638 all testcases '+language,language,language==='cpp17'?cpp:python,'Accepted','actual-problem',3000);
  }
  console.log('SMOKE COMPLETE');
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
