(function () {
  'use strict';
  var root = document.querySelector('[data-activity-page]');
  if (!root) return;
  var mode = root.dataset.activityPage, id = Number(root.dataset.activityId), state = null, fields = [], rosterPage = 1, busy = false;
  var api = '/api/v2/activities' + (id ? '/' + id : '');
  var $ = function (selector) { return root.querySelector(selector); };
  var labels = { draft: '填写中', pending: '待审核', approved: '报名成功', returned: '退回修改', rejected: '已拒绝', withdrawn: '已撤回' };
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
  function date(value) { return value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Number(value))) : '待定'; }
  function local(value) { var d = new Date(Number(value) + 8 * 3600000); return value ? d.toISOString().slice(0, 16) : ''; }
  function epoch(value) { return value ? Date.parse(value + ':00+08:00') : null; }
  function status(value) { return '<span class="activity-state activity-state-' + esc(value) + '">' + esc(labels[value] || value) + '</span>'; }
  function message(value, error) { var target = $('[data-activity-message]'); target.hidden = !value; target.textContent = value || ''; target.classList.toggle('is-error', !!error); if (error) target.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  async function request(url, method, body) {
    var response = await fetch(url, { method: method || 'GET', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': (window.__NWPUOJ_APP || {}).csrfToken || '' }, body: body ? JSON.stringify(body) : undefined });
    var result = await response.json();
    if (!response.ok) throw new Error(result.error && result.error.message || result.message || '请求失败，请刷新后重试。');
    return result.data;
  }
  async function work(fn, success) {
    if (busy) return;
    busy = true;
    var controls = Array.from(root.querySelectorAll('button:not(:disabled)'));
    controls.forEach(function (button) { button.disabled = true; });
    message('');
    try { await fn(); if (success) message(success); } catch (error) { message(error.message, true); }
    finally { busy = false; controls.forEach(function (button) { if (button.isConnected) button.disabled = false; }); }
  }
  function pagination(target, total, current, attr) {
    target.innerHTML = '<span class="app-help">共 ' + total + ' 条 · 第 ' + current + ' / ' + Math.max(1, Math.ceil(total / 30)) + ' 页</span>' + (current > 1 ? '<button class="app-button app-button-secondary" type="button" ' + attr + '="' + (current - 1) + '">上一页</button>' : '') + (current * 30 < total ? '<button class="app-button app-button-secondary" type="button" ' + attr + '="' + (current + 1) + '">下一页</button>' : '');
  }
  function phase(a) { return a.status === 'draft' ? '草稿' : a.status === 'closed' || Date.now() >= Number(a.closes_at) ? '报名已结束' : Date.now() < Number(a.opens_at) ? '报名未开始' : '报名进行中'; }
  async function loadList(page) {
    var result = await request('/api/v2/activities?page=' + (page || 1));
    $('[data-activity-list]').innerHTML = result.items.length ? result.items.map(function (a) { return '<article class="activity-list-row"><div><h2><a href="/activities/' + a.id + '">' + esc(a.title) + '</a></h2><div class="activity-meta"><span>' + (a.mode === 'team' ? '组队 · ' + a.min_members + '–' + a.max_members + ' 人' : '个人报名') + '</span><span>截止 ' + date(a.closes_at) + '</span>' + (a.location ? '<span>' + esc(a.location) + '</span>' : '') + '</div></div><a class="app-button app-button-secondary" href="/activities/' + a.id + '">' + phase(a) + '</a></article>'; }).join('') : '<p class="app-help">暂无公开活动。</p>';
    pagination($('[data-activity-pages]'), result.total, result.page, 'data-list-page');
  }
  function selectedTab() {
    var requested = new URLSearchParams(location.search).get('tab') || 'intro';
    return ['intro', 'mine'].includes(requested) || (state && state.can_manage && ['roster', 'fields', 'settings'].includes(requested)) ? requested : 'intro';
  }
  function showTab() {
    var tab = mode === 'new' ? 'settings' : selectedTab();
    root.querySelectorAll('[data-activity-panel]').forEach(function (panel) { panel.hidden = panel.dataset.activityPanel !== tab && !(mode === 'new' && panel.dataset.activityPanel === 'fields'); });
    root.querySelectorAll('[data-activity-tab]').forEach(function (item) { var active = item.dataset.activityTab === tab; item.classList.toggle('is-active', active); if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); });
    if ($('[data-config-actions]')) $('[data-config-actions]').hidden = !['settings', 'fields'].includes(tab);
    if (tab === 'roster') return loadRoster(1);
  }
  function fillConfig(a) {
    var form = $('[data-activity-config]');
    if (!form) return;
    ['title', 'description', 'location', 'mode', 'status', 'min_members', 'max_members', 'require_review'].forEach(function (name) { form.elements[name].value = String(a[name] == null ? '' : a[name]); });
    if (a.mode !== 'team') { form.elements.min_members.value = 2; form.elements.max_members.value = 3; }
    ['opens_at', 'closes_at', 'starts_at'].forEach(function (name) { var input = form.elements[name]; input.value = local(a[name]); if (input._flatpickr) input._flatpickr.setDate(input.value, false, 'Y-m-d\\TH:i'); });
    fields = JSON.parse(JSON.stringify(a.fields || [])); renderFields(); teamSettings();
  }
  function teamSettings() { root.querySelectorAll('[data-team-setting]').forEach(function (item) { item.hidden = $('[data-activity-config]').elements.mode.value !== 'team'; }); }
  function renderFields() {
    $('[data-activity-fields]').innerHTML = fields.map(function (field, index) {
      return '<div class="activity-field-editor" data-field-index="' + index + '"><div class="app-form-grid"><label class="app-field"><span class="app-label">字段名称</span><input class="app-input" data-field-prop="label" maxlength="100" value="' + esc(field.label) + '" required></label><label class="app-field"><span class="app-label">填写方式</span><select class="app-select" data-field-prop="type">' + [['text', '短文本'], ['textarea', '长文本'], ['radio', '单选'], ['checkbox', '多选'], ['select', '下拉选择']].map(function (pair) { return '<option value="' + pair[0] + '"' + (field.type === pair[0] ? ' selected' : '') + '>' + pair[1] + '</option>'; }).join('') + '</select></label></div>' + (['radio', 'checkbox', 'select'].includes(field.type) ? '<label class="app-field"><span class="app-label">选项（每行一个）</span><textarea class="app-textarea" data-field-prop="options" rows="3" required>' + esc(field.options.join('\n')) + '</textarea></label>' : '') + '<div class="activity-actions"><label class="activity-choice"><input type="checkbox" data-field-prop="required"' + (field.required ? ' checked' : '') + '>必填</label><button type="button" class="app-button app-button-quiet" data-field-move="-1"' + (!index ? ' disabled' : '') + '>上移</button><button type="button" class="app-button app-button-quiet" data-field-move="1"' + (index === fields.length - 1 ? ' disabled' : '') + '>下移</button><button type="button" class="app-button app-button-quiet" data-field-remove>删除字段</button></div></div>';
    }).join('') || '<p class="app-help">当前仅收集账户实名资料，可按需添加手机号、年级等字段。</p>';
  }
  function collectFields() { root.querySelectorAll('[data-field-index]').forEach(function (row) { var field = fields[Number(row.dataset.fieldIndex)]; row.querySelectorAll('[data-field-prop]').forEach(function (input) { var key = input.dataset.fieldProp; field[key] = key === 'required' ? input.checked : key === 'options' ? input.value.split('\n').map(function (line) { return line.trim(); }).filter(Boolean) : input.value; }); }); }
  function identity(person) { return '<dl class="activity-identity">' + [['用户名', person.username], ['姓名', person.real_name], ['学号', person.student_id], ['学院', person.college]].map(function (pair) { return '<div><dt>' + pair[0] + '</dt><dd>' + esc(pair[1]) + '</dd></div>'; }).join('') + '</dl>'; }
  function question(field, values, disabled) {
    var value = values[field.id], common = ' name="' + field.id + '"' + (disabled ? ' disabled' : ''), required = field.required && field.type !== 'checkbox' ? ' required' : '';
    var control;
    if (field.type === 'textarea') control = '<textarea class="app-textarea" rows="4" maxlength="4000"' + common + required + '>' + esc(value || '') + '</textarea>';
    else if (field.type === 'select') control = '<select class="app-select"' + common + required + '><option value="">请选择</option>' + field.options.map(function (option) { return '<option' + (option === value ? ' selected' : '') + '>' + esc(option) + '</option>'; }).join('') + '</select>';
    else if (['radio', 'checkbox'].includes(field.type)) control = field.options.map(function (option) { return '<label class="activity-choice"><input type="' + field.type + '"' + common + required + ' value="' + esc(option) + '"' + ((Array.isArray(value) ? value.includes(option) : value === option) ? ' checked' : '') + '>' + esc(option) + '</label>'; }).join('');
    else control = '<input class="app-input" type="text" maxlength="500"' + common + required + ' value="' + esc(value || '') + '">';
    var label = esc(field.label) + (field.required ? ' *' : '');
    return ['radio', 'checkbox'].includes(field.type) ? '<fieldset class="app-field"><legend class="app-label">' + label + '</legend>' + control + '</fieldset>' : '<label class="app-field"><span class="app-label">' + label + '</span>' + control + '</label>';
  }
  function renderMine() {
    var target = $('[data-activity-mine]'), a = state.activity, r = state.mine;
    var enabled = a.status === 'published' && state.server_now >= a.opens_at && state.server_now < a.closes_at;
    if (!state.user_id) { target.innerHTML = '<p>登录后使用本人账户填写报名表。</p><a class="app-button app-button-primary" href="/login?url=' + encodeURIComponent('/activities/' + id + '?tab=mine') + '">登录报名</a>'; return; }
    var html = enabled ? '' : '<p class="app-notice">' + phase(a) + '，当前仅可查看报名信息。</p>';
    html += state.invitations.map(function (invite) { return '<div class="activity-invitation"><span><strong>' + esc(invite.team_name) + '</strong> · ' + esc(invite.leader_username) + ' 邀请你加入</span>' + (enabled ? '<div class="activity-actions"><button class="app-button app-button-primary" type="button" data-invitation="' + invite.id + '" data-invite-action="accept">接受邀请</button><button class="app-button app-button-secondary" type="button" data-invitation="' + invite.id + '" data-invite-action="decline">拒绝</button></div>' : '') + '</div>'; }).join('');
    if (!r) {
      if (state.identity) html += identity(state.identity); else html += '<p>' + esc(state.identity_error) + '</p><a href="/user/' + state.user_id + '/edit">完善账号资料</a>';
      if (enabled && state.identity) html += '<form class="activity-answer-form" data-start-registration>' + (a.mode === 'team' ? '<label class="app-field"><span class="app-label">队伍名称</span><input class="app-input" name="team_name" maxlength="80" required></label>' : '') + '<p class="app-help">' + (a.mode === 'team' ? '你将成为队长。创建后邀请队员，待每人确认信息后提交整队报名。' : '开始填写后，请保存信息并点击提交报名。') + '</p><button class="app-button app-button-primary" type="submit">' + (a.mode === 'team' ? '创建队伍' : '开始填写报名表') + '</button></form>';
      target.innerHTML = html; return;
    }
    var leader = Number(r.leader_id) === state.user_id, editing = ['draft', 'returned'].includes(r.status), own = r.members.find(function (m) { return m.user_id === state.user_id; });
    html += '<div class="activity-actions"><h2>' + esc(a.mode === 'team' ? r.team_name : '我的报名') + '</h2>' + status(r.status) + '</div>' + (r.review_note ? '<p class="app-notice">审核说明：' + esc(r.review_note) + '</p>' : '');
    if (a.mode === 'team') {
      html += '<h3>队伍成员 · ' + r.members.length + ' / ' + a.max_members + '</h3><p class="app-help">每位成员填写自己的信息。成员退出后整队回到填写状态，需要队长重新提交。</p>' + r.members.map(function (m) { return '<div class="activity-member"><span>' + esc(m.username) + (m.user_id === Number(r.leader_id) ? ' · 队长' : '') + ' · ' + (m.ready ? '信息已确认' : '待填写信息') + '</span>' + (enabled && leader && editing && m.user_id !== state.user_id ? '<button class="app-button app-button-quiet" type="button" data-remove-member="' + m.user_id + '">移除</button>' : '') + '</div>'; }).join('');
      html += (r.invitations || []).map(function (invite) { return '<div class="activity-member"><span>' + esc(invite.username) + ' · 等待接受邀请</span>' + (enabled ? '<button class="app-button app-button-quiet" type="button" data-cancel-invitation="' + invite.id + '">取消邀请</button>' : '') + '</div>'; }).join('');
      if (enabled && leader && editing && r.members.length < a.max_members) html += '<form class="activity-toolbar" data-invite-member><label class="app-field"><span class="app-label">邀请队员</span><input class="app-input" name="username" placeholder="输入准确的 OJ 用户名" maxlength="80" required></label><button class="app-button app-button-secondary" type="submit">发送邀请</button></form>';
    }
    if (own) html += '<h3>我的报名信息</h3>' + identity(own) + '<form class="activity-answer-form" data-save-answers>' + (leader && a.mode === 'team' ? '<label class="app-field"><span class="app-label">队伍名称</span><input class="app-input" name="team_name" maxlength="80" value="' + esc(r.team_name) + '" required' + (!enabled || r.status === 'rejected' ? ' disabled' : '') + '></label>' : '') + a.fields.map(function (field) { return question(field, own.answers, !enabled || r.status === 'rejected'); }).join('') + (enabled && r.status !== 'rejected' ? '<p class="app-help">' + (a.require_review ? '报名成功后修改信息会重新进入审核。' : '提交后修改的信息会同步更新。') + '</p><button class="app-button app-button-secondary" type="submit">保存并确认我的信息</button>' : '') + '</form>';
    if (enabled) html += '<div class="activity-actions">' + (leader && editing ? '<button type="button" class="app-button app-button-primary" data-submit-registration>' + (a.mode === 'team' ? '提交整队报名' : '提交报名') + '</button>' : '') + '<button type="button" class="app-button app-button-quiet" data-withdraw-registration>' + (leader ? '撤回' + (a.mode === 'team' ? '整队报名' : '报名') : '退出队伍') + '</button></div>';
    target.innerHTML = html;
  }
  async function loadDetail(fill) {
    state = await request(api);
    var a = state.activity;
    $('[data-activity-title]').textContent = a.title; document.title = a.title + ' - NWPUOJ';
    $('[data-activity-summary]').textContent = (a.mode === 'team' ? '组队报名 · ' + a.min_members + '–' + a.max_members + ' 人' : '个人报名') + ' · ' + phase(a);
    $('[data-activity-description]').innerHTML = state.description_html || '<p class="app-help">暂无活动介绍。</p>';
    $('[data-activity-facts]').innerHTML = '<span>报名：' + date(a.opens_at) + ' 至 ' + date(a.closes_at) + '</span><span>活动时间：' + date(a.starts_at) + '</span><span>地点：' + esc(a.location || '待定') + '</span><span>' + (a.require_review ? '提交后需审核' : '提交即报名成功') + '</span><span>北京时间 · 24 小时制</span>';
    renderMine(); if (fill) fillConfig(a);
  }
  async function action(name, values) { await request(api + '/registration/action', 'POST', Object.assign({ action: name, revision: state.mine.revision }, values || {})); await loadDetail(false); }
  async function loadRoster(page) {
    rosterPage = page || 1;
    var params = new URLSearchParams(new FormData($('[data-roster-search]'))); params.set('page', rosterPage);
    var data = await request(api + '/registrations?' + params.toString());
    $('[data-roster-export]').href = api + '/registrations/export?' + params.toString();
    $('[data-activity-roster]').innerHTML = data.items.map(function (r) {
      return '<details class="activity-registration"><summary><strong>#' + r.id + ' ' + esc(r.team_name || (r.members[0] || {}).username || '个人报名') + '</strong>' + status(r.status) + '<span class="app-help">' + r.members.length + ' 人 · ' + (r.submitted_at ? date(r.submitted_at) : '尚未提交') + '</span><span class="app-help">查看详情</span></summary><div class="app-table-region" tabindex="0" aria-label="报名详情"><table class="app-table"><thead><tr><th>成员</th><th>姓名 / 学号</th><th>学院</th>' + data.activity.fields.map(function (f) { return '<th>' + esc(f.label) + '</th>'; }).join('') + '</tr></thead><tbody>' + r.members.map(function (m) { return '<tr><td>' + esc(m.username) + (m.user_id === Number(r.leader_id) ? '（队长 / 报名人）' : '') + '</td><td>' + esc(m.real_name) + '<br>' + esc(m.student_id) + '</td><td>' + esc(m.college) + '</td>' + data.activity.fields.map(function (f) { var value = m.answers[f.id]; return '<td>' + esc(Array.isArray(value) ? value.join('、') : value) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>' + (r.review_note ? '<p>审核说明：' + esc(r.review_note) + '</p>' : '') + (!['draft', 'withdrawn'].includes(r.status) ? '<form class="activity-review" data-review-id="' + r.id + '" data-review-revision="' + r.revision + '"><label class="app-field"><span class="app-label">审核结果</span><select class="app-select" name="status"><option value="approved">通过报名</option><option value="returned">退回修改</option><option value="rejected">拒绝报名</option></select></label><label class="app-field"><span class="app-label">审核说明（退回 / 拒绝必填）</span><input class="app-input" name="note" maxlength="1000" value="' + esc(r.review_note) + '"></label><button class="app-button app-button-primary" type="submit">保存审核</button></form>' : '') + '</details>';
    }).join('') || '<p class="app-help">没有符合条件的报名记录。</p>';
    pagination($('[data-roster-pages]'), data.total, data.page, 'data-roster-page');
  }
  root.addEventListener('change', function (event) {
    if (event.target.matches('[name="mode"]')) teamSettings();
    if (event.target.matches('[data-field-prop="type"]')) { collectFields(); renderFields(); }
  });
  root.addEventListener('click', function (event) {
    var button = event.target.closest('button,a'); if (!button || !root.contains(button)) return;
    if (button.hasAttribute('data-activity-tab')) { event.preventDefault(); if (busy) return; history.replaceState(null, '', button.href); work(showTab); return; }
    if (button.hasAttribute('data-add-field')) { collectFields(); if (fields.length >= 30) return message('最多添加 30 个字段。', true); fields.push({ id: 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), label: '', type: 'text', required: true, options: [] }); renderFields(); return; }
    if (button.hasAttribute('data-field-remove') || button.hasAttribute('data-field-move')) { collectFields(); var index = Number(button.closest('[data-field-index]').dataset.fieldIndex); if (button.hasAttribute('data-field-remove')) fields.splice(index, 1); else { var target = index + Number(button.dataset.fieldMove); if (target >= 0 && target < fields.length) { var field = fields.splice(index, 1)[0]; fields.splice(target, 0, field); } } renderFields(); return; }
    if (button.hasAttribute('data-list-page')) return work(function () { return loadList(Number(button.dataset.listPage)); });
    if (button.hasAttribute('data-roster-page')) return work(function () { return loadRoster(Number(button.dataset.rosterPage)); });
    if (button.hasAttribute('data-copy-activity')) return work(async function () { var result = await request(api + '/copy', 'POST', {}); location.href = '/activities/' + result.id + '?tab=settings'; });
    if (button.hasAttribute('data-invitation')) return work(async function () { await request(api + '/invitations/' + button.dataset.invitation, 'POST', { action: button.dataset.inviteAction }); await loadDetail(false); }, button.dataset.inviteAction === 'accept' ? '已加入队伍，请填写并确认自己的报名信息。' : '已拒绝邀请。');
    if (button.hasAttribute('data-cancel-invitation')) return work(function () { return action('cancel-invitation', { invitation_id: Number(button.dataset.cancelInvitation) }); });
    if (button.hasAttribute('data-remove-member') && window.confirm('确认移除该成员？')) return work(function () { return action('remove-member', { user_id: Number(button.dataset.removeMember) }); });
    if (button.hasAttribute('data-submit-registration')) return work(function () { return action('submit'); }, '报名已提交。');
    if (button.hasAttribute('data-withdraw-registration') && window.confirm('确认撤回报名或退出队伍？组队报名将需要重新提交。')) return work(function () { return action(Number(state.mine.leader_id) === state.user_id ? 'withdraw' : 'leave'); }, '已撤回报名或退出队伍。');
  });
  root.addEventListener('submit', function (event) {
    var form = event.target; event.preventDefault();
    if (form.matches('[data-activity-config]')) return work(async function () {
      collectFields(); var data = Object.fromEntries(new FormData(form));
      ['opens_at', 'closes_at', 'starts_at'].forEach(function (name) { data[name] = epoch(data[name]); });
      data.require_review = data.require_review === 'true'; data.fields = fields; data.revision = state && state.activity.revision;
      var result = await request(api, mode === 'new' ? 'POST' : 'PATCH', data);
      if (mode === 'new') location.href = '/activities/' + result.id + '?tab=settings'; else await loadDetail(true);
    }, '活动设置已保存。');
    if (form.matches('[data-start-registration]')) return work(async function () { await request(api + '/registrations', 'POST', Object.fromEntries(new FormData(form))); await loadDetail(false); }, '已创建，请填写并确认报名信息。');
    if (form.matches('[data-invite-member]')) return work(function () { return action('invite', Object.fromEntries(new FormData(form))); }, '邀请已添加。请队员打开本活动的“我的报名”确认加入。');
    if (form.matches('[data-save-answers]')) return work(async function () {
      var data = new FormData(form), values = {};
      state.activity.fields.forEach(function (field) { values[field.id] = field.type === 'checkbox' ? data.getAll(field.id) : data.get(field.id) || ''; });
      await action('save', { answers: values, team_name: data.get('team_name') });
    }, '信息已保存。填写中的报名还需由本人或队长点击提交。');
    if (form.matches('[data-roster-search]')) return work(function () { return loadRoster(1); });
    if (form.matches('[data-review-id]')) return work(async function () { var data = Object.fromEntries(new FormData(form)); data.revision = Number(form.dataset.reviewRevision); await request(api + '/registrations/' + form.dataset.reviewId + '/review', 'POST', data); await loadRoster(rosterPage); }, '审核结果已保存。');
  });
  work(async function () {
    if (mode === 'list') return loadList(1);
    if (mode === 'new') { fillConfig({ title: '', description: '', location: '', mode: 'individual', status: 'draft', require_review: true, opens_at: Date.now(), closes_at: Date.now() + 7 * 86400000, starts_at: null, fields: [] }); return showTab(); }
    await loadDetail(true); await showTab();
  });
})();
