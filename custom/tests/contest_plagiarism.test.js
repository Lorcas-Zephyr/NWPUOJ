'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const engine = require('../libs/contest-plagiarism');

const snapshot = { start_time: 100, end_time: 200, max_submission_id: 100 };
const row = (id, patch = {}) => ({ id, user_id: 1, username: '选手', problem_id: 10, title: '题目', language: 'cpp23',
  code: 'int main(){return 0;}', status: 'Wrong Answer', submit_time: 150, type: 'traditional', ...patch });

test('selection respects inclusive start, exclusive end and snapshot boundary', () => {
  const result = engine.selectSubmissions([row(1, { submit_time: 99 }), row(2, { submit_time: 100 }), row(3, { submit_time: 200 }), row(101)], snapshot);
  assert.equal(result.stats.total, 1);
  assert.equal(result.groups[0].submissions[0].id, 2);
});
test('latest accepted per contestant/problem/family, fallback to latest attempt; C and PyPy family mappings', () => {
  const result = engine.selectSubmissions([row(1, { status: 'Accepted', language: 'c' }), row(2, { status: 'Accepted' }), row(3),
    row(4, { user_id: 2 }), row(5, { user_id: 2 }), row(6, { language: 'python311', problem_id: 11 }),
    row(7, { language: 'pypy3', problem_id: 11 }), row(8, { user_id: 3, problem_id: 12, language: 'java' })], snapshot);
  assert.deepEqual(result.groups.map(group => group.submissions.map(item => item.id)), [[2, 5], [7], [8]]);
  assert.deepEqual(result.groups.map(group => group.language), ['cpp', 'python3', 'java']);
  assert.equal(result.stats.replaced, 4);
});
test('empty/unsupported/answer archives are reported and authoritative source is preferred', () => {
  const result = engine.selectSubmissions([row(1, { code: ' ' }), row(2, { language: 'pascal' }), row(3, { type: 'submit-answer' }),
    row(4, { version_source: 'int main(){return 1;}', code: 'old' })], snapshot);
  assert.equal(result.stats.unsupported, 2);
  assert.equal(result.stats.empty, 1);
  assert.equal(result.groups[0].submissions[0].code, 'int main(){return 1;}');
});
test('missing runtime is detected without starting tasks', async () => {
  assert.equal(await engine.runtimeAvailable('/tmp/nonexistent-noj-jplag-runtime'), false);
});

test('real JPlag detects renamed C/C++, Python and Java copies, parses report and match coordinates', {
  skip: process.env.NWPUOJ_JPLAG_ENGINE_TEST !== '1', timeout: 120000
}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noj-jplag-test-'));
  const runtimeRoot = process.env.NWPUOJ_JPLAG_RUNTIME || path.resolve(__dirname, '../tools/jplag');
  const programs = {
    cpp: '#include <stdio.h>\nint main(){int n;scanf("%d",&n);int arr[1000];for(int i=0;i<n;i++){scanf("%d",&arr[i]);}for(int i=0;i<n;i++){for(int j=0;j+1<n-i;j++){if(arr[j]>arr[j+1]){int t=arr[j];arr[j]=arr[j+1];arr[j+1]=t;}}}for(int i=0;i<n;i++){printf("%d ",arr[i]);}return 0;}\n',
    python3: 'def sort_values(arr):\n    n = len(arr)\n    for i in range(n):\n        for j in range(n-i-1):\n            if arr[j] > arr[j+1]:\n                arr[j], arr[j+1] = arr[j+1], arr[j]\n    return arr\nvalues = list(map(int, input().split()))\nprint(*sort_values(values))\n',
    java: 'import java.util.*;\npublic class Main {public static void main(String[] args){Scanner scanner=new Scanner(System.in);int n=scanner.nextInt();int[] arr=new int[n];for(int i=0;i<n;i++){arr[i]=scanner.nextInt();}for(int i=0;i<n;i++){for(int j=0;j+1<n-i;j++){if(arr[j]>arr[j+1]){int t=arr[j];arr[j]=arr[j+1];arr[j+1]=t;}}}for(int x:arr){System.out.println(x);}}}\n'
  };
  try {
    for (const [language, code] of Object.entries(programs)) {
      const extension = language === 'python3' ? 'py' : language;
      const group = { key: 'p1-' + language, language, submissions: [
        { id: 1, user_id: 1, username: '甲', code, extension },
        { id: 2, user_id: 2, username: '乙', code: code.replace(/arr/g, 'numbers'), extension }
      ] };
      const directory = path.join(root, group.key);
      const result = await engine.analyzeGroup(group, directory, runtimeRoot);
      assert.equal(result.state, 'completed');
      assert.equal(result.pairs.length, 1);
      assert.ok(result.pairs[0].similarity > 0.95, language);
      const comparison = (await engine.readReportJson(path.join(directory, 'report.jplag'), [result.pairs[0].comparison_file]))[result.pairs[0].comparison_file];
      assert.ok(comparison.matches.length > 0);
      assert.ok(comparison.matches[0].startInFirst.line >= 1);
      assert.ok(comparison.matches[0].endInSecond.line >= 1);
    }
    const short = await engine.analyzeGroup({ key: 'short', language: 'cpp', submissions: [{ id: 1, user_id: 1, code: 'int main(){}', extension: 'cpp' }] }, path.join(root, 'short'), runtimeRoot);
    assert.equal(short.state, 'skipped');
    const partial = await engine.analyzeGroup({ key: 'partial', language: 'java', submissions: [
      { id: 1, user_id: 1, username: '甲', code: programs.java, extension: 'java' },
      { id: 2, user_id: 2, username: '乙', code: programs.java, extension: 'java' },
      { id: 3, user_id: 3, username: '丙', code: 'this is not java', extension: 'java' }
    ] }, path.join(root, 'partial'), runtimeRoot);
    assert.equal(partial.state, 'partial'); assert.equal(partial.pairs.length, 1);
    assert.equal(partial.failed[0].username, '丙'); assert.equal(partial.failed[0].submission_id, 3);
    await assert.rejects(engine.analyzeGroup({ key: 'invalid', language: 'java', submissions: [{ id: 1, user_id: 1, code: 'this is not java', extension: 'java' }, { id: 2, user_id: 2, code: 'also invalid', extension: 'java' }] }, path.join(root, 'invalid'), runtimeRoot), /JPlag/);
  } finally { await fs.remove(root); }
});
