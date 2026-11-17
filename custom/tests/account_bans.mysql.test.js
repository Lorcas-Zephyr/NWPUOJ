'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('ban lifecycle, transactions, login IP selection and irreversible session revocation (isolated MySQL tables)', { timeout: 60000 }, () => {
  const auth = fs.readFileSync(path.join(root, 'modules/_auth_security.js'), 'utf8');
  const run = async function () {
    const fs = require('fs'), vm = require('vm'), assert = require('assert').strict, crypto = require('crypto');
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const orm = require('typeorm'), config = require('/app/config/web.json').db;
    const host = process.env.SYZOJ_WEB_DB_HOST || config.host;
    const conn = await orm.createConnection({type:'mysql',host:host.split(':')[0],port:Number(host.split(':')[1]||3306),username:process.env.SYZOJ_WEB_DB_USERNAME||config.username,password:process.env.SYZOJ_WEB_DB_PASSWORD||config.password,database:process.env.SYZOJ_WEB_DB_DATABASE||config.database});
    const prefix = 'test_bans_' + crypto.randomBytes(6).toString('hex') + '_';
    const tables = ['account_ban','user','auth_audit_event','audit_fixture'];
    const pattern = new RegExp('\\b(' + tables.join('|') + ')\\b','g');
    const wrap = db => ({ query: (sql,args) => db.query(sql.replace(pattern,name=>prefix+name),args), transaction: fn => conn.transaction(m=>fn(wrap(m))) });
    const db = wrap(conn), routes = {}, revoked = [];
    let rejectAudit = false, auditCalls = 0, rejectAuditAt = 0;
    const normalize = require('/app/libs/login-ip').normalizeIp;
    const utils = {
      apiV2: { send: (res,data,status=200)=>Object.assign(res,{status,data}), fail: (res,status,code,message)=>Object.assign(res,{status,code,message}) },
      authorizationV2: { authorize: async ()=>true, recentLoginSatisfied: ()=>true, recordAudit: async (_req,event,manager)=>{
        await manager.query('INSERT INTO audit_fixture(action) VALUES(?)',[event.action]);
        if (rejectAudit || ++auditCalls === rejectAuditAt) throw new Error('audit rejected');
        return 1;
      } },
      normalizeBanIp: normalize,
      revokeUserSessions: async (_req,id)=>revoked.push(['user',id]), revokeIpSessions: async (_req,ip)=>revoked.push(['ip',ip]),
      secureCookieOptions: ()=>({path:'/'})
    };
    const context = vm.createContext({ require:name=>name==='typeorm'?{getConnection:()=>db}:require(name),
      app:Object.fromEntries(['get','post','delete'].map(m=>[m,(url,fn)=>{routes[m+' '+url]=fn;}])),
      syzoj:{siteOwnerUserId:99,utils,log(){}}, normalizeBanIp:normalize, APPEAL_EMAIL:'npuicpc@163.com',
      TypeORM:{getConnection:()=>db}, ErrorMessage:Error, getUserAccountState:async()=>({status:'active'}),
      clearLegacyLoginCookie(){}, destroySession:async req=>{req.destroyed=true; req.session=null;}, Date, Intl
    });
    vm.runInContext(input.schema,context);
    utils.ensureAccountBanSchema=context.ensureAccountBanSchema;
    utils.findActiveAccountBan=context.findActiveAccountBan;
    utils.findActiveIpBan=context.findActiveIpBan;
    vm.runInContext(input.guard,context);
    // Separate lexical scope from the auth functions.
    vm.runInContext('(function(){'+input.routes+'\n})();',context);
    const admin={id:90,is_admin:true}, ordinary={id:1}, owner={id:99,is_admin:true};
    const call=async(method,url,body={},params={},actor=admin,query={})=>{
      const res={locals:{user:actor}};
      await routes[method+' '+url]({body,params,query,ip:'192.0.2.90'},res);
      return res;
    };
    const create=body=>call('post','/api/v2/admin/bans',body);
    const lift=id=>call('delete','/api/v2/admin/bans/:id',{}, {id});
    const guard=async(userId,ip,originalIp,authenticatedAt=Date.now()-60000)=>{
      const req={ip,path:'/api/v2/problems/1/submissions',session:{user_id:userId,authenticatedIp:originalIp,apiV2AuthenticatedAt:authenticatedAt}};
      const res={locals:{user:{id:userId}},clearCookie(){}};
      await utils.enforceAccountBans(req,res,error=>{if(error)throw error;res.allowed=true;});
      return {req,res};
    };
    try {
      await db.query('CREATE TABLE user(id INT PRIMARY KEY,username VARCHAR(80),is_admin TINYINT) ENGINE=InnoDB');
      await db.query('CREATE TABLE auth_audit_event(id INT AUTO_INCREMENT PRIMARY KEY,action VARCHAR(80),resource_type VARCHAR(32),resource_id VARCHAR(80),ip_address VARCHAR(80),created_at DATETIME(3)) ENGINE=InnoDB');
      await db.query('CREATE TABLE audit_fixture(id INT AUTO_INCREMENT PRIMARY KEY,action VARCHAR(80)) ENGINE=InnoDB');
      await db.query("INSERT INTO user VALUES(1,'alice',0),(2,'bob',0),(90,'admin',1),(99,'owner',1)");
      await db.query("INSERT INTO auth_audit_event(action,resource_type,resource_id,ip_address,created_at) VALUES('auth:login','user','1','::ffff:192.0.2.1',UTC_TIMESTAMP(3))");
      await utils.ensureAccountBanSchema();
      assert.equal((await create({type:'account',permanent:true,user_id:99})).code,'OWNER_ACCOUNT_PROTECTED');
      assert.equal((await create({type:'account',permanent:true,user_id:90})).code,'SELF_ACCOUNT_STATUS_FORBIDDEN');
      assert.equal((await call('post','/api/v2/admin/bans',{type:'account',permanent:true,user_id:90},{},{id:91,is_admin:true})).code,'OWNER_CAPABILITY_REQUIRED');
      assert.equal((await call('post','/api/v2/admin/bans',{}, {}, ordinary)).status,403);
      rejectAudit=true;
      assert.equal((await create({type:'account',permanent:true,user_id:1})).status,503);
      assert.equal(Number((await db.query('SELECT COUNT(*) n FROM account_ban'))[0].n),0,'failed audit rolls back the ban');
      rejectAudit=false;
      const first=await create({type:'account',permanent:false,expires_at:new Date(Date.now()+86400000).toISOString(),username:'alice'});
      assert.equal(first.status,201);
      assert.ok((await utils.findActiveAccountBan(1)).expires_at.endsWith('Z'));
      assert.match(context.banLoginMessage('account',await utils.findActiveAccountBan(1)),/npuicpc@163.com/);
      assert.equal((await guard(1,'192.0.2.8','192.0.2.1')).res.code,'ACCOUNT_BANNED');
      assert.equal((await guard(2,'192.0.2.8','192.0.2.8')).res.allowed,true);
      const permanent=await create({type:'account',permanent:true,user_id:1});
      assert.equal((await utils.findActiveAccountBan(1)).expires_at,null,'permanent ban takes precedence');
      assert.equal((await lift(permanent.data.id)).status,200);
      assert.ok(await utils.findActiveAccountBan(1),'lifting one record leaves the other effective');
      assert.equal((await lift(first.data.id)).status,200);
      assert.equal(await utils.findActiveAccountBan(1),null);
      assert.equal((await guard(1,'192.0.2.8','192.0.2.1')).res.code,'SESSION_REVOKED','unban cannot revive old sessions');
      assert.equal((await guard(1,'192.0.2.8','192.0.2.1',Date.now()+1)).res.allowed,true);
      assert.equal((await create({type:'ip',permanent:true,user_id:1,ip:'192.0.2.2'})).status,422,'profile IP must be recorded');
      const ipBan=await create({type:'ip',permanent:false,expires_at:new Date(Date.now()+86400000).toISOString(),user_id:1,ip:'::ffff:c000:201'});
      assert.equal(ipBan.status,201);
      assert.equal(ipBan.data.ip,'192.0.2.1');
      assert.ok(await utils.findActiveIpBan('::ffff:192.0.2.1'));
      const switched=await guard(1,'192.0.2.8','192.0.2.1',Date.now()+1);
      assert.equal(switched.res.code,'IP_BANNED'); assert.equal(switched.req.destroyed,true);
      assert.equal((await guard(2,'192.0.2.1',undefined)).res.code,'IP_BANNED','legacy session on banned IP is destroyed');
      assert.equal((await guard(2,'192.0.2.2','192.0.2.2')).res.allowed,true,'other IP remains active');
      const details=await call('get','/api/v2/admin/bans/users/:id',{}, {id:1});
      assert.equal(details.data.ips[0].ip,'192.0.2.1'); assert.equal(details.data.bans.length,1);
      await db.query("UPDATE account_ban SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?",[ipBan.data.id]);
      assert.equal(await utils.findActiveIpBan('192.0.2.1'),null,'expiry permits fresh logins');
      assert.equal((await guard(2,'192.0.2.1','192.0.2.1')).res.code,'SESSION_REVOKED');
      assert.equal((await guard(2,'192.0.2.1','192.0.2.1',Date.now()+1)).res.allowed,true);
      assert.deepEqual(revoked.at(-1),['ip','192.0.2.1']);
      assert.equal((await call('get','/api/v2/admin/bans',{}, {},admin,{status:'all',q:'alice'})).data.total,3);
      await db.query("INSERT INTO auth_audit_event(action,resource_type,resource_id,ip_address,created_at) VALUES('auth:login','user','1','2001:db8::1',UTC_TIMESTAMP(3))");
      const count=async table=>Number((await db.query('SELECT COUNT(*) n FROM '+table))[0].n);
      const before={bans:await count('account_ban'),audits:await count('audit_fixture'),sessions:revoked.length};
      const batch={type:'ip',permanent:true,user_id:1,ips:['192.0.2.1','2001:db8::1','::ffff:192.0.2.1']};
      assert.equal((await create({...batch,ips:['192.0.2.1','192.0.2.50']})).status,422,'every profile IP must belong to the account');
      assert.equal(await count('account_ban'),before.bans,'invalid batch writes nothing');
      rejectAuditAt=auditCalls+2;
      assert.equal((await create(batch)).status,503,'failure on second IP rejects the entire batch');
      assert.equal(await count('account_ban'),before.bans);
      assert.equal(await count('audit_fixture'),before.audits,'all audits roll back with the batch');
      assert.equal(revoked.length,before.sessions,'failed batch does not revoke sessions');
      rejectAuditAt=0;
      const batchResult=await create(batch);
      assert.equal(batchResult.status,201); assert.equal(batchResult.data.total,2,'aliases are deduplicated');
      assert.deepEqual(Array.from(batchResult.data.items,x=>x.ip),['192.0.2.1','2001:db8::1']);
      assert.equal(await count('audit_fixture'),before.audits+2);
      assert.deepEqual(revoked.slice(-2),[['ip','192.0.2.1'],['ip','2001:db8::1']]);
      for(const ip of ['192.0.2.1','2001:db8::1']) {
        assert.equal((await guard(2,ip,ip)).res.code,'IP_BANNED','each selected IP blocks existing sessions');
      }
      assert.equal((await guard(2,'192.0.2.50','192.0.2.50',Date.now()+1)).res.allowed,true);
      await lift(batchResult.data.items[0].id);
      assert.equal(await utils.findActiveIpBan('192.0.2.1'),null);
      assert.ok(await utils.findActiveIpBan('2001:db8::1'),'each IP can be lifted independently');
      console.log('account/IP bans, aliases, expiry, audit rollback, protected accounts, session revocation: passed');
    } finally {
      for(const name of tables) await conn.query('DROP TABLE IF EXISTS '+prefix+name);
      await conn.close();
    }
  };
  const input={schema:auth.slice(auth.indexOf('let resetTablePromise'),auth.indexOf('function ensureResetTable(')),guard:auth.slice(auth.indexOf('syzoj.utils.enforceAccountBans ='),auth.indexOf('\napp.use(async',auth.indexOf('syzoj.utils.enforceAccountBans ='))),routes:fs.readFileSync(path.join(root,'modules/_account_bans.js'),'utf8')};
  const result=spawnSync('docker',['compose','exec','-T','web','node','-e','('+run.toString()+')().catch(e=>{console.error(e);process.exit(1);})'],{cwd:path.join(root,'..'),input:JSON.stringify(input),encoding:'utf8',timeout:55000});
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  console.log(result.stdout.trim());
});
