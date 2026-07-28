const assert = require('node:assert/strict');
const test = require('node:test');
const {
  appendPlayersToRanklist,
  csvCell,
  isLoginAllowed,
  normalizeRows,
  parseCsv,
  uniqueUsername,
  usernamePart
} = require('../libs/contest-temp-accounts');

test('parses BOM, CRLF, quoted commas and escaped quotes', () => {
  const rows = parseCsv('\uFEFF姓名,学号,学院\r\n"张,三",2026000001,"计算机""学院"\r\n');
  assert.deepEqual(rows, [
    ['姓名', '学号', '学院'],
    ['张,三', '2026000001', '计算机"学院']
  ]);
});

test('normalizes accepted header aliases and trims values', () => {
  const rows = normalizeRows(Buffer.from(' real name ,student_id,college\n 张三 ,2026000001, 计算机学院 \n'));
  assert.deepEqual(rows, [{ name: '张三', studentId: '2026000001', college: '计算机学院' }]);
});

test('rejects malformed, duplicate and oversized imports', () => {
  assert.throws(() => parseCsv('姓名,学号,学院\n"张三,2026000001,计算机学院'), /引号未闭合/);
  assert.throws(() => normalizeRows(Buffer.from(
    '姓名,学号,学院\n张三,2026000001,计算机学院\n李四,2026000001,自动化学院\n'
  )), /学号在文件中重复/);
  const rows = ['姓名,学号,学院'];
  for (let index = 0; index < 1001; index++) rows.push(`学生${index},${String(index).padStart(10, '0')},学院`);
  assert.throws(() => normalizeRows(Buffer.from(rows.join('\n'))), /一次最多导入 1000 个账户/);
});

test('escapes CSV formulas and embedded quotes', () => {
  assert.equal(csvCell('=HYPERLINK("https://example.invalid")'), '"\'=HYPERLINK(""https://example.invalid"")"');
  assert.equal(csvCell('normal'), '"normal"');
});

test('normalizes username parts and resolves database collisions', async () => {
  assert.equal(usernamePart(' 计算机 / 学院 '), '计算机学院');
  const manager = {
    async query(sql, params) {
      assert.match(sql, /SELECT id FROM user/);
      return params[0] === '计算机学院-张三' ? [{ id: 1 }] : [];
    }
  };
  const reserved = new Set();
  assert.equal(await uniqueUsername(manager, '计算机学院-张三', '2026000001', reserved), '计算机学院-张三-0001');
  assert.ok(reserved.has('计算机学院-张三-0001'));
});

test('preserves existing ranklist order while appending imported players', () => {
  assert.deepEqual(appendPlayersToRanklist(
    { player_num: 3, 1: 11, 2: null, 3: 13 },
    [21, 22]
  ), { player_num: 4, 1: 11, 2: 13, 3: 21, 4: 22 });
});

test('denies temporary accounts exactly at expiry and allows regular users', () => {
  const expiries = new Map([[7, 1000]]);
  assert.equal(isLoginAllowed(expiries, 7, 999), true);
  assert.equal(isLoginAllowed(expiries, 7, 1000), false);
  assert.equal(isLoginAllowed(expiries, 8, 1000), true);
});
