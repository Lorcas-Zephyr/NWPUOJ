'use strict';
// Uses uniquely named, isolated test tables; no real user/activity records are
// read or mutated. Separate connections exercise real InnoDB row locks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('personal/team lifecycle, authorization, privacy, rollback and concurrent joins/reviews (MySQL)', { timeout: 60000 }, () => {
  const run = async function () {
    const fs = require('fs'), vm = require('vm'), assert = require('assert').strict, crypto = require('crypto');
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const t = require('typeorm'), c = require('/app/config/web.json').db, h = process.env.SYZOJ_WEB_DB_HOST || c.host;
    const connection = await t.createConnection({ type: 'mysql', host: h.split(':')[0], port: Number(h.split(':')[1] || 3306), username: process.env.SYZOJ_WEB_DB_USERNAME || c.username, password: process.env.SYZOJ_WEB_DB_PASSWORD || c.password, database: process.env.SYZOJ_WEB_DB_DATABASE || c.database });
    const prefix = 'test_activity_' + crypto.randomBytes(6).toString('hex') + '_';
    const names = ['activity', 'activity_registration', 'activity_member', 'activity_invitation', 'user', 'user_registration_profile', 'temporary_contest_account', 'audit_fixture'];
    const pattern = new RegExp('\\b(' + names.join('|') + ')\\b', 'g');
    const wrap = db => ({ query: (sql, args) => db.query(sql.replace(pattern, name => prefix + name), args), transaction: fn => connection.transaction(manager => fn(wrap(manager))) });
    const db = wrap(connection);
    const library = { exports: {} }; vm.runInNewContext(input.library, { module: library, exports: library.exports, require, Buffer, Date });
    let clock = 1000, denied = false, rejectAudit = false;
    const admin = { id: 99 }, u = id => ({ id });
    const service = library.exports.createService({ connection: () => db, now: () => clock, authorize: async user => user.id === 99 && !denied, audit: async (manager, event) => {
      await manager.query('INSERT INTO audit_fixture(action) VALUES(?)', [event.action]);
      if (rejectAudit) throw new Error('audit-failure');
    } });
    const fail = async (promise, expression) => assert.rejects(promise, expression);
    const config = { title: 'Fixture', description: 'test', location: 'test', mode: 'individual', status: 'published', opens_at: 1000, closes_at: 2000, require_review: true, fields: [{ id: 'f_phone', label: '联系方式', type: 'text', required: true, options: [] }] };
    const mine = async (id, user) => (await service.detail(id, user)).mine;
    const change = async (id, user, action, extra = {}) => service.change(id, user, { action, revision: (await mine(id, user)).revision, ...extra });
    try {
      await db.query('CREATE TABLE user(id INT PRIMARY KEY,username VARCHAR(80)) ENGINE=InnoDB');
      await db.query('CREATE TABLE user_registration_profile(user_id INT PRIMARY KEY,student_id_scope VARCHAR(32),student_id VARCHAR(10),real_name VARCHAR(64),college VARCHAR(100)) ENGINE=InnoDB');
      await db.query('CREATE TABLE temporary_contest_account(user_id INT PRIMARY KEY) ENGINE=InnoDB');
      await db.query('CREATE TABLE audit_fixture(id INT AUTO_INCREMENT PRIMARY KEY,action VARCHAR(80)) ENGINE=InnoDB');
      for (let id = 1; id <= 8; id++) {
        await db.query('INSERT INTO user VALUES(?,?)', [id, 'person' + id]);
        await db.query('INSERT INTO user_registration_profile VALUES(?,?,?,?,?)', [id, 'ordinary', '202600000' + id, '姓名' + id, '学院']);
      }
      await db.query('INSERT INTO temporary_contest_account VALUES(8)');
      await fail(service.create(u(1), config), /权限/);
      const personal = (await service.create(admin, config)).id;
      await fail(service.start(personal, null, {}), /登录/);
      await fail(service.start(personal, u(8), {}), /普通/);
      assert.equal((await service.roster(personal, admin)).total, 0, 'failed joins roll back registrations');
      await service.start(personal, u(1), {});
      await fail(service.start(personal, u(1), {}), /已在/);
      await fail(change(personal, u(1), 'submit'), /尚未保存/);
      await fail(change(personal, u(1), 'save', { answers: {} }), /联系方式/);
      await change(personal, u(1), 'save', { answers: { f_phone: '123', real_name: 'forged' } });
      await change(personal, u(1), 'submit');
      const p = await mine(personal, u(1)); assert.equal(p.status, 'pending');
      await fail(service.review(personal, p.id, u(2), { revision: p.revision, status: 'approved' }), /权限/);
      await service.review(personal, p.id, admin, { revision: p.revision, status: 'approved' });
      await change(personal, u(1), 'save', { answers: { f_phone: '123' } });
      assert.equal((await mine(personal, u(1))).status, 'approved', 'identical save retains approval');
      await change(personal, u(1), 'save', { answers: { f_phone: '456' } });
      assert.equal((await mine(personal, u(1))).status, 'pending', 'edit invalidates prior approval');
      await db.query("UPDATE user_registration_profile SET real_name='后改姓名' WHERE user_id=1");
      assert.equal((await mine(personal, u(1))).members[0].real_name, '姓名1', 'identity snapshot stable');
      const visitor = await service.detail(personal, u(2)); assert.equal(visitor.mine, null);
      assert.ok(!JSON.stringify(visitor).includes('456'));
      await fail(service.roster(personal, u(2)), /权限/);
      denied = true; await fail(service.roster(personal, admin), /权限/); denied = false;
      const detail = await service.detail(personal, admin);
      await fail(service.update(personal, admin, { ...config, revision: detail.activity.revision, fields: [] }), /不可修改/);
      const copied = (await service.copy(personal, admin)).id;
      assert.equal((await service.roster(copied, admin)).total, 0);
      await fail(service.detail(copied, u(2)), /不存在/);
      assert.ok(!(await service.list(u(2))).items.some(item => item.id === copied));
      rejectAudit = true;
      await fail(change(personal, u(1), 'withdraw'), /audit-failure/);
      rejectAudit = false;
      assert.equal((await mine(personal, u(1))).members.length, 1, 'audit failure rolls back participant removal');
      clock = 2000; await fail(change(personal, u(1), 'withdraw'), /时间/); clock = 1000;
      await change(personal, u(1), 'withdraw');
      assert.equal(await mine(personal, u(1)), null);
      const withdrawn = (await service.roster(personal, admin)).items[0]; assert.equal(withdrawn.status, 'withdrawn'); assert.equal(withdrawn.members[0].answers.f_phone, '456');
      await service.start(personal, u(1), {});
      const team = (await service.create(admin, { ...config, mode: 'team', min_members: 2, max_members: 3 })).id;
      await service.start(team, u(1), { team_name: 'A' });
      await service.start(team, u(2), { team_name: 'B' });
      await change(team, u(1), 'invite', { username: 'person3' });
      await change(team, u(2), 'invite', { username: 'person3' });
      const invitations = (await service.detail(team, u(3))).invitations;
      assert.equal(invitations.length, 2, 'pending invitations do not reserve participation');
      await fail(service.invitation(team, invitations[0].id, u(4), { action: 'accept' }), /不存在/);
      const joined = await Promise.allSettled(invitations.map(invite => service.invitation(team, invite.id, u(3), { action: 'accept' })));
      assert.equal(joined.filter(r => r.status === 'fulfilled').length, 1, 'concurrent accepts cannot join two teams');
      const member = await mine(team, u(3));
      const captain = u(Number(member.leader_id));
      assert.equal(member.members.length, 2);
      const other = member.members.find(m => m.user_id !== 3);
      assert.equal(other.real_name, undefined); assert.equal(other.answers, undefined, 'teammate answers remain private');
      await fail(change(team, u(3), 'submit'), /队长/);
      await change(team, captain, 'save', { team_name: 'Winners', answers: { f_phone: 'captain' } });
      await fail(change(team, captain, 'submit'), /尚未保存/);
      await change(team, u(3), 'save', { answers: { f_phone: 'member' } });
      const stale = await mine(team, captain);
      await change(team, captain, 'submit');
      await fail(service.review(team, stale.id, admin, { revision: stale.revision, status: 'approved' }), /更新/);
      const current = await mine(team, captain);
      const race = await Promise.allSettled([
        service.review(team, current.id, admin, { revision: current.revision, status: 'approved' }),
        service.change(team, u(3), { revision: current.revision, action: 'save', answers: { f_phone: 'changed' } })
      ]);
      assert.equal(race.filter(r => r.status === 'fulfilled').length, 1, 'review/edit race rejects stale writer');
      await change(team, u(3), 'leave');
      assert.equal((await mine(team, captain)).status, 'draft');
      assert.equal(await mine(team, u(3)), null);
      await fail(change(team, captain, 'submit'), /需有/);
      await change(team, captain, 'invite', { username: 'person4' });
      const invite4 = (await service.detail(team, u(4))).invitations[0];
      await service.invitation(team, invite4.id, u(4), { action: 'accept' });
      await change(team, captain, 'remove-member', { user_id: 4 });
      assert.equal(await mine(team, u(4)), null);
      // The unique student constraint is enforced even with inconsistent legacy profiles.
      await db.query('UPDATE user_registration_profile SET student_id=? WHERE user_id=5', ['202600000' + captain.id]);
      await fail(service.start(team, u(5), { team_name: 'duplicate' }), /已在/);
      const auto = (await service.create(admin, { ...config, require_review: false })).id;
      await service.start(auto, u(6), {}); await change(auto, u(6), 'save', { answers: { f_phone: 'ok' } }); await change(auto, u(6), 'submit');
      assert.equal((await mine(auto, u(6))).status, 'approved');
      process.stdout.write('PASS: activity authorization, identity snapshots, private forms, lifecycle, rollback, deadline, concurrent invitations and review races\n');
    } finally {
      for (const name of names) await connection.query('DROP TABLE IF EXISTS ' + prefix + name);
      await connection.close();
    }
  };
  const result = spawnSync('docker', ['compose', 'exec', '-T', 'web', 'node', '-e', '(' + run.toString() + ')().catch(error=>{console.error(error.stack);process.exit(1);});'], { cwd: path.resolve(__dirname, '../..'), input: JSON.stringify({ library: fs.readFileSync(path.resolve(__dirname, '../libs/activities.js'), 'utf8') }), encoding: 'utf8', timeout: 55000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS:/);
});
