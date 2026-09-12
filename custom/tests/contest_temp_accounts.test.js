const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  appendPlayersToRanklist,
  csvCell,
  isLoginAllowed,
  normalizeRows,
  normalizeStudentIdRows,
  parseCsv,
  uniqueUsername,
  usernamePart
} = require('../libs/contest-temp-accounts');
const {
  ORDINARY_STUDENT_ID_SCOPE,
  temporaryStudentIdScope
} = require('../libs/registration-profile-schema');

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

test('normalizes ordinary-account student ID CSVs with or without a header', () => {
  assert.deepEqual(normalizeStudentIdRows(Buffer.from('\uFEFF学号\r\n2026000001\r\n2026000002\r\n')), ['2026000001', '2026000002']);
  assert.deepEqual(normalizeStudentIdRows(Buffer.from('2026000001\n2026000002\n')), ['2026000001', '2026000002']);
  assert.throws(() => normalizeStudentIdRows(Buffer.from('学号\n2026000001\n2026000001\n')), /学号在文件中重复/);
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

test('limits generated temporary-account usernames to twenty characters', async () => {
  const manager = { async query() { return []; } };
  const username = await uniqueUsername(manager, '超长学院名称超长学院名称-超长姓名', '2026000001', new Set());
  assert.ok(username.length <= 20);
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

test('scopes student ID uniqueness to ordinary accounts or one temporary-account contest', () => {
  assert.equal(ORDINARY_STUDENT_ID_SCOPE, 'ordinary');
  assert.equal(temporaryStudentIdScope(42), 'contest:42');
  assert.throws(() => temporaryStudentIdScope(0), /positive integer/);
});

test('applies scoped student ID uniqueness in schema migration, registration, and temporary import', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../libs/registration-profile-schema.js'), 'utf8');
  const registration = fs.readFileSync(path.join(__dirname, '../modules/_registration_identity.js'), 'utf8');
  const temporaryImport = fs.readFileSync(path.join(__dirname, '../modules/_contest_temp_accounts.js'), 'utf8');

  assert.match(schema, /DROP INDEX uq_user_registration_profile_student_id/);
  assert.match(schema, /UNIQUE KEY uq_user_registration_profile_student_scope \(student_id_scope,student_id\)/);
  assert.match(schema, /SET profile\.student_id_scope=CONCAT\('contest:', account\.contest_id\)/);
  assert.match(registration, /WHERE student_id_scope=\? AND student_id=\? AND user_id!=\?/);
  assert.match(temporaryImport, /WHERE student_id_scope=\? AND student_id IN \(\?\) FOR UPDATE/);
  assert.match(temporaryImport, /\(user_id,student_id_scope,student_id,real_name,college,created_at,updated_at\)/);
  assert.match(temporaryImport, /已在本场比赛的临时账户中使用/);
});

test('v2 temporary-account import is transactional, audited, evented, and one-time', () => {
  const route = fs.readFileSync(path.join(__dirname, '../modules/_contest_temp_accounts.js'), 'utf8');
  const v2Route = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_contest_temp_accounts.js'), 'utf8');
  const foundation = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_foundation.js'), 'utf8');
  const view = fs.readFileSync(path.join(__dirname, '../views/contest_registrations.ejs'), 'utf8');

  assert.match(v2Route, /app\.get\('\/api\/v2\/admin\/contest-temp-accounts'/);
  assert.match(v2Route, /app\.post\('\/api\/v2\/admin\/contest-temp-accounts\/import'/);
  assert.match(route, /async function importTemporaryAccounts[\s\S]*withTransactionRetry/);
  assert.match(route, /action: 'contest:temporary-account\.import'/);
  assert.match(route, /type: 'contest\.temporary-accounts\.imported'/);
  assert.match(v2Route, /req\.apiV2SensitiveResponse = true/);
  assert.match(v2Route, /Cache-Control', 'private, no-store'/);
  assert.match(foundation, /SENSITIVE_RESPONSE_NOT_REPLAYABLE/);
  assert.match(foundation, /const storedResponse = req\.apiV2SensitiveResponse/);
  assert.match(view, /data-temporary-accounts-v2/);
  assert.match(view, /fetch\('\/api\/v2\/admin\/contest-temp-accounts\/import'/);
  assert.doesNotMatch(view, /API_DOMAIN_DISABLED|legacySubmit|HTMLFormElement\.prototype\.submit/);
  assert.match(view, /URL\.createObjectURL\(new Blob/);
});

test('generated contest accounts remain registered and submission-eligible when self registration is disabled', () => {
  const temporaryImport = fs.readFileSync(path.join(__dirname, '../modules/_contest_temp_accounts.js'), 'utf8');
  const registration = fs.readFileSync(path.join(__dirname, '../modules/_contest_registration.js'), 'utf8');
  const mutation = fs.readFileSync(path.join(__dirname, '../libs/contest-mutation.js'), 'utf8');
  const submission = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_submission_domain.js'), 'utf8');

  assert.match(registration, /allow_registration TINYINT\(1\) NOT NULL DEFAULT 1/);
  assert.match(mutation, /if \(!options\.managed && Number\(context\.setting\.allow_registration\) === 0\)[\s\S]*请使用比赛账号参赛/);
  assert.match(temporaryImport, /INSERT INTO temporary_contest_account[\s\S]*INSERT INTO contest_player/);
  assert.doesNotMatch(temporaryImport, /contestMutation\.registerUser/);
  assert.match(registration, /async function canParticipateInContest[\s\S]*findRegistration\(contest\.id, user\.id\)/);
  assert.match(submission, /async function registeredForContest[\s\S]*FROM contest_player WHERE contest_id=\? AND user_id=\?/);
});

test('global rankings exclude temporary accounts while contest standings keep every participant', () => {
  const globalRanklist = fs.readFileSync(path.join(__dirname, '../modules/_ranklist.js'), 'utf8');
  const webConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '../web.json'), 'utf8'));
  const contestInteractions = fs.readFileSync(path.join(__dirname, '../modules/_contest_interactions.js'), 'utf8');
  const contestApi = fs.readFileSync(path.join(__dirname, '../modules/_api_v2_contest_domain.js'), 'utf8');
  const contestRating = fs.readFileSync(path.join(__dirname, '../libs/contest-rating.js'), 'utf8');
  const classicStandingSource = contestInteractions.slice(
    contestInteractions.indexOf('async function loadContestRanklist'),
    contestInteractions.indexOf('async function loadContestProblemPresentation')
  );
  const v2StandingSource = contestApi.slice(
    contestApi.indexOf('async function standingSource'),
    contestApi.indexOf('async function insertStandingRows')
  );
  const ratingStandingSource = contestRating.slice(
    contestRating.indexOf('async function canonicalStandings'),
    contestRating.indexOf('async function finalizeContestInTransaction')
  );

  assert.equal(webConfig.page.ranklist, 100);
  assert.match(globalRanklist, /leftJoin\('temporary_contest_account', 'temporary_account'/);
  assert.match(globalRanklist, /andWhere\('temporary_account\.user_id IS NULL'\)/);
  assert.match(globalRanklist, /let total = await ordinaryUsers\(\)\.getCount\(\)/);
  assert.doesNotMatch(globalRanklist, /User\.queryPage/);
  assert.match(classicStandingSource, /LEFT JOIN temporary_contest_account temporary_account/);
  assert.doesNotMatch(classicStandingSource, /temporary_account\.user_id IS NULL/);
  assert.doesNotMatch(v2StandingSource, /temporary_contest_account/);
  assert.doesNotMatch(ratingStandingSource, /temporary_contest_account/);
});
