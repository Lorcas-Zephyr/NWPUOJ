'use strict';

// Exercise the real list handlers and paginator on connection-local temporary
// tables, including matches beyond the first unfiltered page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('contest and problem-set filters run before SQL pagination and respect visibility', { timeout: 60000 }, () => {
  const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
  const section = (name, start, end) => {
    const source = read(name);
    return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  };
  const input = {
    contests: section('modules/_base_workspace.js', "app.get('/contests'", "app.get('/api/v2/base/users/search'"),
    sets: section('modules/_problem_sets.js', "app.get('/problem-sets'", "app.get('/problem-set/new'")
  };
  const code = async function () {
    const assert = require('assert').strict, vm = require('vm');
    const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const orm = require('typeorm'), config = require('/app/config/web.json').db;
    const host = process.env.SYZOJ_WEB_DB_HOST || config.host;
    class Contest extends require('/app/models-built/common').default {}
    const columns = { id: { type: Number, primary: true }, title: { type: String }, holder_id: { type: Number },
      start_time: { type: Number }, end_time: { type: Number }, is_public: { type: Number }, subtitle: { type: String } };
    const connection = await orm.createConnection({ type: 'mysql', host: host.split(':')[0], port: Number(host.split(':')[1] || 3306),
      username: process.env.SYZOJ_WEB_DB_USERNAME || config.username, password: process.env.SYZOJ_WEB_DB_PASSWORD || config.password,
      database: process.env.SYZOJ_WEB_DB_DATABASE || config.database,
      entities: [new orm.EntitySchema({ name: 'ListContest', target: Contest, tableName: 'contest', columns })] });
    const runner = connection.createQueryRunner(); await runner.connect();
    try {
      const definitions = {
        contest: 'id INT PRIMARY KEY,title TEXT,holder_id INT,start_time INT,end_time INT,is_public INT,subtitle TEXT',
        contest_player: 'contest_id INT,user_id INT', contest_registration_removal: 'contest_id INT,user_id INT',
        contest_v2_state: 'contest_id INT,status VARCHAR(16)', base_workspace_contest: 'contest_id INT',
        user: 'id INT PRIMARY KEY,username VARCHAR(40)',
        problem_set: 'id INT PRIMARY KEY,title TEXT,owner_id INT,status VARCHAR(16),visibility VARCHAR(16),deadline_at INT,updated_at INT',
        problem_set_item: 'id INT PRIMARY KEY,problem_set_id INT',
        problem_set_participant: 'problem_set_id INT,user_id INT,PRIMARY KEY(problem_set_id,user_id)'
      };
      for (const [name, fields] of Object.entries(definitions)) await runner.query(`CREATE TEMPORARY TABLE ${name} (${fields}) ENGINE=InnoDB`);
      await runner.query("INSERT INTO user VALUES (1,'admin'),(2,'owner'),(3,'other')");
      for (let id = 1; id <= 52; id++) {
        const owner = id % 2 === 0 ? 2 : 3;
        const start = id % 3 === 0 ? 100 + id : id % 3 === 1 ? 1100 + id : 200 + id;
        const end = id % 3 === 2 ? 300 + id : 2000 + id;
        await runner.query('INSERT INTO contest VALUES (?,?,?,?,?,?,?)', [id, 'Contest ' + id, owner, start, end, id <= 48 ? 1 : 0, '']);
        await runner.query('INSERT INTO problem_set VALUES (?,?,?,?,?,?,?)', [id, 'Set ' + id, owner, id === 51 ? 'archived' : 'published',
          id <= 48 ? 'public' : 'private', id % 2 === 0 ? null : 500, id]);
        if (id % 3 === 0 || id === 49) {
          await runner.query('INSERT INTO contest_player VALUES (?,2),(?,3)', [id, id]);
          await runner.query('INSERT INTO problem_set_participant VALUES (?,2)', [id]);
        }
      }
      await runner.query("INSERT INTO contest_v2_state VALUES (51,'archived')");
      await runner.query('INSERT INTO base_workspace_contest VALUES (52)');
      await runner.query('INSERT INTO contest_registration_removal VALUES (6,2),(6,3)');
      Contest.createQueryBuilder = alias => connection.getRepository(Contest).createQueryBuilder(alias, runner);
      const utility = require('fs').readFileSync('/app/utility.js', 'utf8');
      const paginateStart = utility.indexOf('  paginate(');
      const paginator = vm.runInNewContext('({' + utility.slice(paginateStart, utility.indexOf('\n  },', paginateStart) + 4) + '})');
      const utils = { getCurrentDate: () => 1000, markdown: async value => value,
        paginate: paginator.paginate, authorizationV2: { authorize: async () => false } };
      const routes = new Map();
      const context = { app: { get: (route, handler) => routes.set(route, handler) },
        syzoj: { model: () => Contest, utils, config: { page: { contest: 10 } } },
        base: { isAdmin: user => !!(user && user.is_admin), outside: () => 'NOT EXISTS (SELECT 1 FROM base_workspace_contest b WHERE b.contest_id=contest.id)' },
        classGroups: { isUnrestricted: user => !!(user && user.is_admin) },
        TypeORM: { getConnection: () => ({ query: (sql, params) => runner.query(sql, params) }) },
        ensureSchema: async () => {}, run: handler => handler };
      vm.runInNewContext(input.contests + input.sets, context);
      async function call(kind, query = {}, user = { id: 2 }, temporaryContestSession = false) {
        let result;
        await routes.get(kind === 'contest' ? '/contests' : '/problem-sets')({ query }, {
          locals: { user, temporaryContestSession }, status() { return this; },
          render(view, data) { assert.notEqual(view, 'error', data.err && data.err.stack); result = data; }
        });
        return result;
      }
      const contestState = row => row.start_time > 1000 ? 'upcoming' : row.end_time > 1000 ? 'running' : 'ended';
      const allContests = await runner.query('SELECT * FROM contest');
      const allSets = await runner.query('SELECT * FROM problem_set');
      for (const kind of ['contest', 'set']) {
        const stateOf = kind === 'contest' ? contestState : row => row.deadline_at ? 'ended' : 'open';
        const states = kind === 'contest' ? ['all', 'running', 'upcoming', 'ended'] : ['all', 'open', 'ended'];
        for (const state of states) for (const mine of [false, true]) for (const participating of [false, true]) {
          let expected = (kind === 'contest' ? allContests : allSets).filter(row => {
            if (kind === 'contest' ? !row.is_public || row.id >= 51 : row.status === 'archived' || row.visibility !== 'public' && row.owner_id !== 2 && row.id !== 49) return false;
            return (state === 'all' || stateOf(row) === state) && (!mine || Number(row.holder_id || row.owner_id) === 2) &&
              (!participating || (row.id % 3 === 0 || row.id === 49) && (kind !== 'contest' || row.id !== 6));
          });
          expected.sort(kind === 'set' ? (a, b) => b.id - a.id : (a, b) => {
            const order = { upcoming: 0, running: 1, ended: 2 };
            return order[stateOf(a)] - order[stateOf(b)] || (stateOf(a) === 'ended' ? b.start_time - a.start_time || b.id - a.id : a.start_time - b.start_time || a.id - b.id);
          });
          const seen = [];
          for (let page = 1; page <= Math.max(1, Math.ceil(expected.length / 10)); page++) {
            const data = await call(kind, { state, mine: mine ? '1' : '', participating: participating ? '1' : '', page });
            const rows = kind === 'contest' ? data.contests : data.problemSets;
            assert.equal(kind === 'contest' ? data.contestListTotal : data.problemSetListTotal, expected.length);
            assert.deepEqual(rows.map(row => row.id), expected.slice((page - 1) * 10, page * 10).map(row => row.id), `${kind} ${JSON.stringify({ state, mine, participating, page })}`);
            seen.push(...rows.map(row => row.id));
          }
          assert.equal(new Set(seen).size, expected.length);
        }
      }
      const temp = await call('contest', {}, { id: 3 }, true);
      assert.ok(temp.contests.every(row => (row.id % 3 === 0 || row.id === 49) && row.id !== 6));
      assert.equal(temp.contestListTotal, 16);
      const admin = await call('contest', {}, { id: 1, is_admin: true });
      assert.equal(admin.contestListTotal, 50);
      const empty = await call('set', { mine: '1' }, { id: 999 });
      assert.equal(empty.problemSetListTotal, 0); assert.equal(empty.problemSets.length, 0);
      const invalid = await call('contest', { state: 'invalid', mine: '1', participating: '1' }, null);
      assert.equal(invalid.contestListTotal, 48);
      console.log('All status/personal combinations, multi-page completeness, visibility, temporary accounts, empty and invalid filters passed.');
    } finally { await runner.release(); await connection.close(); }
  };
  const result = spawnSync('docker', ['exec', '-i', 'nwpuoj-web-1', 'node', '-e', '(' + code.toString() + ')().catch(e=>{console.error(e.stack);process.exitCode=1})'], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 55000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
