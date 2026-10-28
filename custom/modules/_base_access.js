'use strict';
const base = require('../libs/base-workspace');
const TypeORM = require('typeorm');
syzoj.utils.baseWorkspace = base;

// Run before legacy adapters, direct file routes, and all API domain routes.
app.use(async (req, res, next) => {
  try {
    // Express routes are case-insensitive and decode route parameters.
    // Normalize before checking, so encoded or differently-cased links cannot
    // bypass the same resource boundary.
    const routePath = decodeURIComponent(req.path).toLowerCase();
    await base.ensureSchema();
    res.locals.baseMember = await base.isMember(res.locals.user);
    res.locals.baseAdmin = base.isAdmin(res.locals.user);
    res.locals.baseContext = false;
    if (routePath.startsWith('/base') || routePath.startsWith('/api/v2/base')) res.set('Cache-Control', 'private, no-store, max-age=0');
    if (/\/events\/?$/.test(routePath) || /^\/api\/v2\/events\//.test(routePath)) base.trackConnection(res.locals.user && res.locals.user.id, res);
    function deny() {
      if (routePath.startsWith('/api/')) return res.status(403).json({ data: null, error: { code: 'BASE_ACCESS_REQUIRED', message: '仅基地成员可以访问此内容。', fields: {} } });
      return res.status(403).render('error', { err: new ErrorMessage('仅基地成员可以访问此内容。') });
    }
    if (/^\/(?:api\/v2\/)?base(?:\/|$)/.test(routePath) && !res.locals.baseMember) return deny();
    const resourceToken = /^\/(?:api\/v2\/(?:problems|contests|(?:admin\/)?submissions)|problem|contest(?:\/submission)?|submission)\/([0-9][^/]*)(?:\/|$)/.exec(routePath);
    if (resourceToken && !/^\d+$/.test(resourceToken[1])) return deny();
    let match = /^\/(?:api\/v2\/problems|problem)\/(\d+)(?:\/|$)/.exec(routePath);
    if (match && await base.contains('problem', match[1])) {
      const problem = await syzoj.model('problem').findById(Number(match[1]));
      res.set('Cache-Control', 'private, no-store, max-age=0');
      if (!await base.canReadProblem(problem, res.locals.user)) return deny();
      if (/\/testdata(?:\/|$)/.test(routePath) && !await base.canManage('problem', problem, res.locals.user)) return deny();
      res.locals.baseContext = true;
      if (req.method === 'GET' && res.locals.baseAdmin) res.locals.baseProblemMigration = (await base.migrationStates([Number(match[1])])).get(Number(match[1])) || null;
    }
    match = /^\/(?:api\/v2\/contests|contest)\/(\d+)(?:\/|$)/.exec(routePath);
    if (match && await base.contains('contest', match[1])) {
      res.set('Cache-Control', 'private, no-store, max-age=0');
      if (!res.locals.baseMember) return deny();
      res.locals.baseContext = true;
      if (/\/(?:rating(?:-|\/|$)|rate\/?$)/.test(routePath)) return res.status(403).json({ error: { code: 'BASE_UNRATED', message: '基地比赛不参与 Rating。' } });
      if (req.method !== 'GET' && /\/(?:temporary-accounts|ai-runs)(?:\/|$)/.test(routePath)) return deny();
    }
    match = /^\/(?:api\/v2\/(?:admin\/)?submissions|submission|contest\/submission)\/(\d+)(?:\/|$)/.exec(routePath);
    if (match) {
      const judge = await syzoj.model('judge_state').findById(Number(match[1]));
      if (judge && !await base.canAccessSubmission(judge, res.locals.user)) return deny();
      if (judge && await base.contains('problem', judge.problem_id)) res.locals.baseContext = true;
    }
    match = /^\/api\/v2\/problem-jobs\/([^/]+)/.exec(routePath);
    if (match && syzoj.utils.problemV2) {
      const rows = await TypeORM.getConnection().query('SELECT problem_id FROM problem_v2_job WHERE id=?', [match[1]]);
      if (rows[0] && await base.contains('problem', rows[0].problem_id) && !res.locals.baseMember) return deny();
    }
    match = /^\/api\/v2\/events\/(problem|contest):(\d+)\/?$/.exec(routePath);
    if (match && await base.contains(match[1], match[2])) {
      if (!res.locals.baseMember) return deny();
      if (match[1] === 'problem' && !await base.canReadProblem(await syzoj.model('problem').findById(Number(match[2])), res.locals.user)) return deny();
    }
    if (req.query.base === '1' && /^\/(problem|contest)\/0\/edit\/?$/.test(routePath)) {
      if (!res.locals.baseMember) return deny();
      res.locals.baseContext = true;
    }
    if (routePath === '/' || /^\/user\/\d+\/?$/.test(routePath)) {
      const render = res.render.bind(res);
      res.render = function (view, options, callback) {
        if (view === 'user' && options) {
          Promise.all((options.participatedContests || []).map(async item => await base.contains('contest', item.id) ? null : item))
            .then(items => { options.participatedContests = items.filter(Boolean); render(view, options, callback); }).catch(next);
          return res;
        }
        if (view !== 'index') return render(view, options, callback);
        (async () => {
          options.contests = await syzoj.model('contest').createQueryBuilder('c').where('c.is_public=1')
            .andWhere(base.outside('contest', 'c.id'))
            .andWhere("NOT EXISTS (SELECT 1 FROM contest_v2_state s WHERE s.contest_id=c.id AND s.status='archived')")
            .orderBy('CASE WHEN c.start_time>UNIX_TIMESTAMP() THEN 0 WHEN c.end_time>UNIX_TIMESTAMP() THEN 1 ELSE 2 END', 'ASC')
            .addOrderBy('CASE WHEN c.end_time>UNIX_TIMESTAMP() THEN c.start_time ELSE -c.start_time END', 'ASC').take(5).getMany();
          const flags = await Promise.all((options.problems || []).map(item => base.contains('problem', item.id)));
          options.problems = (options.problems || []).filter((_, i) => !flags[i]);
          render(view, options, callback);
        })().catch(next);
        return res;
      };
    }
    next();
  } catch (error) { next(error); }
});
