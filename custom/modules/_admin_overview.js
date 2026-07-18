const TypeORM = require('typeorm');

const PROVIDERS = [
  { key: 'luogu', name: '洛谷', type: 'vjudge:luogu' },
  { key: 'uoj', name: 'UOJ', type: 'vjudge:uoj' },
  { key: 'hdu', name: 'HDU', type: 'vjudge:hdu' },
  { key: 'poj', name: 'POJ', type: 'vjudge:poj' }
];

function providerConfigured(provider) {
  if (provider.key === 'luogu') return !!syzoj.config.luogu_openapi_token;
  const prefix = 'SYZOJ_WEB_' + provider.key.toUpperCase();
  return !!process.env[prefix + '_USERNAME'] && !!process.env[prefix + '_PASSWORD'];
}

function parseImportStatus(value) {
  try {
    const status = JSON.parse(value || '{}');
    return status && typeof status === 'object' ? status : {};
  } catch (error) {
    return { state: 'failed', error: '导入状态数据无效。' };
  }
}

app.get('/admin/info', async (req, res) => {
  try {
    if (!res.locals.user || !res.locals.user.is_admin) {
      return res.status(403).render('error', { err: new ErrorMessage('您没有权限进行此操作。') });
    }
    const connection = TypeORM.getConnection();
    const now = syzoj.utils.getCurrentDate();
    const todayStart = syzoj.utils.getCurrentDate(true);
    const [summaryRows, problemTypeRows, importRows, recentActions, recentTickets] = await Promise.all([
      connection.query(
        `SELECT
          (SELECT COUNT(*) FROM judge_state) AS all_submissions,
          (SELECT COUNT(*) FROM judge_state WHERE submit_time>=?) AS today_submissions,
          (SELECT COUNT(*) FROM problem) AS problems,
          (SELECT COUNT(*) FROM article) AS articles,
          (SELECT COUNT(*) FROM contest) AS contests,
          (SELECT COUNT(*) FROM user) AS users,
          (SELECT COUNT(*) FROM problem_solution WHERE status='pending') AS pending_solutions,
          (SELECT COUNT(*) FROM ticket WHERE status IN ('pending','in_progress')) AS open_tickets,
          (SELECT COUNT(*) FROM ticket WHERE status='pending' AND assignee_id IS NULL) AS unassigned_tickets,
          (SELECT COUNT(*) FROM judge_state WHERE pending=1) AS pending_judgements,
          (SELECT COUNT(*) FROM judge_state WHERE pending=1 AND submit_time<?) AS stale_judgements,
          (SELECT COUNT(*) FROM judge_state
            WHERE pending=0 AND submit_time>=?
              AND status IN ('System Error','Judgement Failed','Unknown','No Testdata')) AS recent_judge_failures`,
        [todayStart, now - 900, now - 86400]
      ),
      connection.query("SELECT type,COUNT(*) AS count FROM problem WHERE type LIKE 'vjudge:%' GROUP BY type"),
      connection.query('SELECT provider,status_json,updated_at FROM vjudge_import_task'),
      connection.query(
        `SELECT action.judge_id,action.action_type,action.operator_time,action.reason,
                action.affected_problem_id,action.affected_user_id,
                operator.username AS operator_name,affected.username AS affected_username,
                problem.title AS problem_title
         FROM judge_state_admin_action action
         LEFT JOIN user operator ON operator.id=action.operator_id
         LEFT JOIN user affected ON affected.id=action.affected_user_id
         LEFT JOIN problem ON problem.id=action.affected_problem_id
         ORDER BY action.operator_time DESC LIMIT 8`
      ),
      connection.query(
        `SELECT ticket.id,ticket.title,ticket.category,ticket.status,ticket.updated_at,
                creator.username AS creator_name,assignee.username AS assignee_name
         FROM ticket
         LEFT JOIN user creator ON creator.id=ticket.creator_id
         LEFT JOIN user assignee ON assignee.id=ticket.assignee_id
         WHERE ticket.status IN ('pending','in_progress')
         ORDER BY ticket.updated_at DESC LIMIT 8`
      )
    ]);

    const summary = summaryRows[0] || {};
    Object.keys(summary).forEach(key => { summary[key] = Number(summary[key] || 0); });
    const problemCounts = Object.fromEntries(problemTypeRows.map(row => [row.type, Number(row.count)]));
    const imports = Object.fromEntries(importRows.map(row => [row.provider, {
      status: parseImportStatus(row.status_json),
      updatedAt: Math.floor(new Date(row.updated_at).getTime() / 1000)
    }]));
    const providers = PROVIDERS.map(provider => ({
      key: provider.key,
      name: provider.name,
      type: provider.type,
      configured: providerConfigured(provider),
      contestEnabled: !!(syzoj.utils.contestSubmissionEnabled && syzoj.utils.contestSubmissionEnabled({ type: provider.type })),
      problemCount: problemCounts[provider.type] || 0,
      importTask: imports[provider.key] || null
    }));

    res.render('admin_info', { summary, providers, recentActions, recentTickets });
  } catch (error) {
    syzoj.log('[admin-overview] ' + (error.stack || error));
    res.status(500).render('error', { err: error });
  }
});
