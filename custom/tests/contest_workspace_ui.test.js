'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('home removes the personalized training workbench and keeps a balanced public overview', () => {
  const home = read('custom/views/index.ejs');
  const css = read('custom/app-features.css');

  for (const removed of [
    '训练工作台',
    '个人进度与最近评测',
    '全部提交',
    'CONTINUE',
    '暂无待继续的题目',
    '从题库选择下一题开始练习',
    '选择下一题',
    '最近评测',
    '还没有提交记录',
    'data-home-training',
    '/api/v2/submissions?scope=mine'
  ]) {
    assert.doesNotMatch(home, new RegExp(removed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(home, /近期比赛/);
  assert.match(home, /公告归档/);
  assert.ok(
    home.indexOf('<h2 class="app-section-title">公告</h2>') <
      home.indexOf('<h2 class="app-section-title">近期比赛</h2>'),
    'announcements must appear before recent contests'
  );
  assert.doesNotMatch(home, /include benben_feed|关注动态|benben\/new/);
  assert.match(home, /data-home-problem-search/);
  assert.match(home, /renderUsername\(user, \{ noLink: true, noTag: true \}\)/);
  assert.match(css, /\.app-dashboard-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.65fr\) minmax\(280px, 0\.62fr\)/s);
  assert.doesNotMatch(css, /\.app-home-training-/);
});

test('contest list provides instant state filtering with v2-first registration workflows', () => {
  const view = read('custom/views/contests.ejs');
  const registrationScript = read('custom/views/contest_registration_v2_script.ejs');

  for (const state of ['all', 'running', 'upcoming', 'ended']) {
    assert.match(view, new RegExp('data-contest-filter="' + state + '"'));
  }
  assert.match(view, /data-contest-state="<%= state\.key %>"/);
  assert.match(view, /button\.setAttribute\('aria-pressed'/);
  assert.match(view, /data-contest-visible-count/);
  assert.doesNotMatch(view, /\['contest', contest\.id, '(?:register|unregister)'\]/);
  assert.match(view, /data-contest-registration-v2="register"/);
  assert.match(view, /data-contest-registration-v2="unregister"/);
  assert.match(view, /include contest_registration_v2_script/);
  assert.match(registrationScript, /\/api\/v2\/contests\/.*\/registration/);
  assert.match(registrationScript, /method: action === 'unregister' \? 'DELETE' : 'POST'/);
  assert.doesNotMatch(registrationScript, /API_DOMAIN_DISABLED|HTMLFormElement\.prototype\.submit/);
  assert.match(registrationScript, /Idempotency-Key/);
  assert.match(view, /\['contest', contest\.id, 'edit'\]/);
  assert.match(view, /include app_pagination/);
});

test('contest overview, standings, and public participants share the new context', () => {
  const context = read('custom/views/contest_context.ejs');
  const problems = read('custom/views/contest.ejs');
  const ranklist = read('custom/views/contest_ranklist.ejs');
  const participants = read('custom/views/contest_participants.ejs');
  const css = read('custom/app-features.css');

  assert.match(context, /role="progressbar"[^>]*aria-valuenow/);
  assert.match(context, /parentElement\.setAttribute\('aria-valuenow'/);
  assert.match(context, /data-contest-progress-label/);
  assert.match(context, /class="app-contest-focus"/);
  assert.match(context, /aria-current="page"/);
  const tabs = context.slice(context.indexOf('<nav class="app-tabs app-contest-tabs"'), context.indexOf('</nav>', context.indexOf('<nav class="app-tabs app-contest-tabs"')));
  assert.ok(tabs.indexOf("['contest', appContest.id, 'details']") < tabs.indexOf("{ view: 'problems' }"));
  assert.match(context, />详情<\/a>/);
  assert.match(context, /appContestSection === 'participants'/);
  assert.match(context, /\['contest', appContest\.id, 'participants'\]/);
  assert.match(context, /data-contest-registration-v2="register"/);
  assert.match(context, /data-contest-registration-v2="unregister"/);
  assert.match(context, /include contest_registration_v2_script/);
  assert.doesNotMatch(context, /\['contest', appContest\.id, 'registrations'\]/);
  assert.match(problems, /app-contest-workspace/);
  assert.match(problems, /app-contest-problem-list/);
  assert.match(problems, /app-contest-progress-panel/);
  assert.doesNotMatch(problems, /PROBLEM SET|<h2>比赛题目<\/h2>|app-contest-workspace-heading/);
  assert.match(problems, /app-contest-problem-row <%= appProblemClass %>/);
  assert.doesNotMatch(problems, /app-contest-problems-table|<table\b/);
  assert.match(ranklist, /app-contest-rank-summary/);
  assert.match(ranklist, /syzoj\.utils\.renderUsername\(item\.user\)/);
  assert.match(participants, /syzoj\.utils\.renderUsername\(participantUser\)/);
  assert.match(css, /\.app-contest-list-row\s*\{/);
  assert.match(css, /\.app-contest-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 250px/s);
  assert.match(css, /\.app-contest-progress-panel\s*\{[^}]*position:\s*sticky/s);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.app-contest-list-row/s);
});

test('contest details own information and announcements without duplicating contest page content', () => {
  const context = read('custom/views/contest_context.ejs');
  const details = read('custom/views/contest_details.ejs');
  const problems = read('custom/views/contest.ejs');
  const interactions = read('custom/modules/_contest_interactions.js');
  const loader = read('custom/modules/_user_privilege_loader.js');
  const css = read('custom/app-features.css');

  assert.match(interactions, /app\.get\('\/contest\/:id\/details'/);
  assert.match(interactions, /syzoj\.utils\.markdown\(content, \['subtitle', 'information'\]\)/);
  assert.match(loader, /details\|ranklist\|submissions\|participants\|registrations/);
  assert.match(details, /比赛信息/);
  assert.match(details, /比赛公告/);
  assert.match(details, /contestDetails\.subtitle/);
  assert.match(details, /contestDetails\.information/);
  assert.doesNotMatch(problems, /contest\.information|比赛公告/);
  assert.doesNotMatch(context, /app-contest-subtitle/);
  assert.match(css, /\.app-contest-detail-section\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)[^}]*gap:\s*18px/s);
});

test('bare contest entries default to details while the problem workspace stays directly addressable', () => {
  const context = read('custom/views/contest_context.ejs');
  const interactions = read('custom/modules/_contest_interactions.js');

  assert.match(interactions, /app\.get\('\/contest\/:id',[\s\S]*req\.query\.view === 'problems'[\s\S]*contestOverviewContext\.run\(true, next\)/);
  assert.match(interactions, /res\.redirect\(302, syzoj\.utils\.makeUrl\(\['contest', req\.params\.id, 'details'\]\)\)/);
  assert.match(context, /\['contest', appContest\.id\], \{ view: 'problems' \}/);
  assert.doesNotMatch(context, /appContestSection === 'problems'[\s\S]{0,180}makeUrl\(\['contest', appContest\.id\]\)(?!,)/);
});

test('contest rankings and submissions start directly with their working content', () => {
  const ranklist = read('custom/views/contest_ranklist.ejs');
  const submissions = read('custom/views/submissions.ejs');

  assert.doesNotMatch(ranklist, /STANDINGS|<h2>排行榜<\/h2>/);
  assert.doesNotMatch(submissions, /当前可查看参赛者提交|当前仅可查看自己的提交/);
  assert.match(submissions, /&& !displayConfig\.inContest/);
  assert.match(submissions, /&& !displayConfig\.inContest\) \{ %><header[\s\S]*?JUDGE ACTIVITY[\s\S]*?<\/header><% \} else if/s);
});

test('all public contest subpages use one title convention and expose the active section', () => {
  const context = read('custom/views/contest_context.ejs');
  const details = read('custom/views/contest_details.ejs');
  const problems = read('custom/views/contest.ejs');
  const ranklist = read('custom/views/contest_ranklist.ejs');
  const submissions = read('custom/views/submissions.ejs');
  const participants = read('custom/views/contest_participants.ejs');

  assert.match(details, /this\.title = '详情 - ' \+ contest\.title/);
  assert.match(problems, /this\.title = '题目 - ' \+ contest\.title/);
  assert.match(ranklist, /this\.title = '排行榜 - ' \+ contest\.title/);
  assert.match(submissions, /displayConfig\.inContest[\s\S]*'提交记录 - ' \+ contest\.title/);
  assert.match(participants, /this\.title = '参赛者 - ' \+ contest\.title/);
  assert.match(context, /CONTEST #<%= appContest\.id %> · <%= appContestSectionLabel %>/);
  for (const section of ['details', 'problems', 'ranklist', 'submissions', 'participants']) {
    assert.match(context, new RegExp(section + ": '[^']+'"));
  }
});

test('public participants and administrator registration management are separate workflows', () => {
  const route = read('custom/modules/_contest_registration.js');
  const context = read('custom/views/contest_context.ejs');
  const editor = read('custom/views/contest_edit.ejs');
  const participants = read('custom/views/contest_participants.ejs');
  const registrations = read('custom/views/contest_registrations.ejs');
  const temporaryAccounts = read('custom/modules/_contest_temp_accounts.js');
  const publicRoute = route.slice(
    route.indexOf("app.get('/contest/:id/participants'"),
    route.indexOf("app.get('/contest/:id/registrations'")
  );
  const managementRoute = route.slice(
    route.indexOf("app.get('/contest/:id/registrations'"),
    route.indexOf("app.get('/contest/:id/registrations/export'")
  );

  assert.match(route, /async function getContestParticipants\(contestId\)/);
  assert.match(route, /SELECT cp\.id AS player_id, cp\.user_id, u\.username/);
  assert.doesNotMatch(route.slice(route.indexOf('async function getContestParticipants'), route.indexOf('function csvCell')), /student_id|real_name|college/);
  assert.match(publicRoute, /res\.render\('contest_participants'/);
  assert.match(publicRoute, /participants:\s*await getContestParticipants\(contestId\)/);
  assert.doesNotMatch(publicRoute, /getContestRegistrations|removedRegistrations|registrationManagementCsrfToken/);
  assert.match(managementRoute, /if \(!canManage\)/);
  assert.match(managementRoute, /getContestRegistrations\(contestId\)/);
  assert.match(managementRoute, /res\.render\('contest_registrations'/);
  assert.match(context, /\['contest', appContest\.id, 'participants'\]/);
  assert.match(editor, /\['contest', contest\.id, 'registrations'\]/);
  assert.match(participants, /include contest_context/);
  assert.doesNotMatch(participants, /<h2 class="app-section-title">参赛者<\/h2>|已报名参加本场比赛的用户/);
  assert.doesNotMatch(participants, /姓名|学号|学院|导出报名信息|remove|restore/);
  assert.doesNotMatch(registrations, /include contest_context/);
  assert.match(registrations, /app-contest-admin-tabs/);
  assert.match(registrations, /<th>姓名<\/th><th>学号<\/th><th>学院<\/th>/);
  assert.match(registrations, /导出报名信息/);
  assert.match(registrations, /批量创建临时参赛用户/);
  assert.match(registrations, /temporary-accounts', 'template'/);
  assert.match(registrations, /\/api\/v2\/admin\/contest-temp-accounts\/import/);
  assert.match(registrations, /删除参赛者/);
  assert.doesNotMatch(registrations, /registrations', registration\.user_id, '(?:remove|restore)'/);
  assert.match(registrations, /title="恢复参赛者" aria-label="恢复参赛者"><i data-lucide="undo"><\/i><\/button>/);
  assert.doesNotMatch(registrations, /data-lucide="undo"><\/i>恢复<\/button>/);
  assert.doesNotMatch(registrations, /rebuild-standings/);
  assert.match(registrations, /data-contest-participant-v2="remove"/);
  assert.match(registrations, /data-contest-participant-v2="restore"/);
  assert.match(registrations, /\/api\/v2\/contests\/.*\/participants\/bulk-action/);
  assert.match(registrations, /data-contest-standings-v2/);
  assert.match(registrations, /\/standings\/rebuilds\//);
  assert.doesNotMatch(registrations, /API_DOMAIN_DISABLED|HTMLFormElement\.prototype\.submit/);
  assert.match(registrations, /Idempotency-Key/);
  assert.match(temporaryAccounts, /app\.get\('\/contest\/:id\/temporary-accounts\/template'/);
  const temporaryAccountsV2 = read('custom/modules/_api_v2_contest_temp_accounts.js');
  assert.match(temporaryAccountsV2, /app\.post\('\/api\/v2\/admin\/contest-temp-accounts\/import'/);
  assert.match(temporaryAccounts, /contestMutation\.acquireContestLock\(contestId\)/);
});

test('all contest-mode labels shown to users use ACM while compatibility identifiers stay lowercase', () => {
  const sources = [
    'custom/views/index.ejs',
    'custom/views/contests.ejs',
    'custom/views/contest_context.ejs',
    'custom/views/contest_edit.ejs',
    'custom/views/contest_ranklist.ejs',
    'custom/views/contest_registrations.ejs',
    'custom/modules/_api_v2_rating_domain.js'
  ].map(read).join('\n');

  assert.doesNotMatch(sources, /ICPC/);
  assert.match(sources, /acm:\s*'ACM'/);
  assert.match(sources, /\['acm',\s*'ACM',/);
  assert.match(sources, /\['icpc',\s*'ACM Rating'\]/);
});

test('username tiers are canonical, theme-aware, and applied to dynamic profile links', () => {
  const header = read('custom/views/app_header.ejs');
  const css = read('custom/username_tiers.css');
  const script = read('custom/app-v2.js');

  assert.match(header, /\/self\/username_tiers\.css/);
  assert.match(header, /renderUsername\(user, \{ noLink: true, noTag: true \}\)/);
  assert.match(css, /:root\s*\{[^}]*--username-admin:\s*#7a3eb1/s);
  assert.match(css, /:root\[data-theme="dark"\]\s*\{[^}]*--username-admin:\s*#c9a0ec/s);
  assert.match(css, /\.username-tier-cheater\s*\{[^}]*text-decoration:\s*line-through/s);
  assert.match(script, /function refreshUsernameTiers\(scope\)/);
  assert.ok(script.includes("var match = /^\\/user\\/(\\d+)\\/?$/.exec(path);"));
  assert.match(script, /refreshUsernameTiers:\s*refreshUsernameTiers/);
});
