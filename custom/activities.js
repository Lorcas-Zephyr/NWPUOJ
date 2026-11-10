(function () {
  'use strict';
  var root = document.querySelector('[data-activity-page]');
  if (!root) return;
  var mode = root.dataset.activityPage, id = Number(root.dataset.activityId), state = null, fields = [];
  var rosterPage = 1, busy = false, configStep = 0, configDirty = false, mineDirty = false, editingAnswers = false, clockOffset = 0;
  var listScope = new URLSearchParams(location.search).get('scope') || 'all';
  var api = '/api/v2/activities' + (id ? '/' + id : '');
  var $ = function (selector) { return root.querySelector(selector); };
  var labels = { draft: '填写中', pending: '待审核', approved: '报名成功', returned: '退回修改', withdrawn: '已撤回' };
  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
  function date(value) { return value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Number(value))) : '待定'; }
  function local(value) { return value ? new Date(Number(value) + 8 * 3600000).toISOString().slice(0, 16) : ''; }
  function epoch(value) { return value ? Date.parse(value + ':00+08:00') : null; }
  function status(value) { return '<span class="activity-state activity-state-' + esc(value) + '">' + esc(labels[value] || value) + '</span>'; }
  function message(value, error) { var target = $('[data-activity-message]'); target.hidden = !value; target.textContent = value || ''; target.classList.toggle('is-error', !!error); if (error) target.scrollIntoView({ block: 'nearest' }); }
  function empty(title, detail) { return '<div class="activity-empty"><strong>' + esc(title) + '</strong><p>' + esc(detail || '') + '</p></div>'; }
  function now() { return Date.now() + clockOffset; }
  function phase(a) { return a.status === 'draft' ? '草稿' : a.status === 'closed' || now() >= Number(a.closes_at) ? '报名已结束' : now() < Number(a.opens_at) ? '报名未开始' : '报名进行中'; }
  function isOpen() { return state && phase(state.activity) === '报名进行中'; }
  async function request(url, method, body) {
    var response = await fetch(url, { method: method || 'GET', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': (window.__NWPUOJ_APP || {}).csrfToken || '' }, body: body ? JSON.stringify(body) : undefined });
    var result = await response.json();
    if (!response.ok) throw new Error(result.error && result.error.message || result.message || '请求失败，请重试。');
    return result.data;
  }
  async function work(fn, success) {
    if (busy) return false;
    busy = true; root.setAttribute('aria-busy', 'true'); message('');
    try { await fn(); if (success) message(success); return true; }
    catch (error) { message(error.message, true); return false; }
    finally { busy = false; root.removeAttribute('aria-busy'); }
  }
  function draftKey(kind) {
    var user = state && state.user_id || (window.__NWPUOJ_APP || {}).user && window.__NWPUOJ_APP.user.id;
    return user ? 'nwpuoj.activity.v1.' + user + '.' + (mode === 'new' ? 'new' : id) + '.' + kind : null;
  }
  function draftContext(kind) {
    if (kind === 'config') return { revision: state && state.activity.revision || 0 };
    var own = state.mine && state.mine.members.find(function (person) { return person.user_id === state.user_id; });
    return { registration: state.mine && state.mine.id || 0, status: state.mine && state.mine.status || '',
      answers: own && own.answers || {}, team_name: state.mine && state.mine.team_name || '', fields: state.activity.fields };
  }
  function readDraft(kind) {
    try { var value = JSON.parse(sessionStorage.getItem(draftKey(kind))); return value && value.context && Date.now() - value.time < 86400000 ? value : null; } catch (_) { return null; }
  }
  function clearDraft(kind) {
    try { sessionStorage.removeItem(draftKey(kind)); } catch (_) {}
    var notice = $('[data-draft-notice="' + kind + '"]'); if (notice) notice.hidden = true;
    var target = kind === 'config' ? $('[data-config-save-hint]') : $('[data-form-draft-status]');
    if (target) target.textContent = '';
  }
  function persistDraft(kind) {
    var key = draftKey(kind); if (!key) return;
    var value = kind === 'config' ? { values: configValues(), step: configStep } : ownDraft(); if (!value) return;
    try {
      sessionStorage.setItem(key, JSON.stringify({ time: Date.now(), context: draftContext(kind), value: value }));
      var notice = $('[data-draft-notice="' + kind + '"]'); if (notice) notice.hidden = true;
      var target = kind === 'config' ? $('[data-config-save-hint]') : $('[data-form-draft-status]');
      if (target) target.textContent = '草稿已暂存';
    } catch (_) {
      var target = kind === 'config' ? $('[data-config-save-hint]') : $('[data-form-draft-status]');
      if (target) target.textContent = '草稿暂存不可用，请勿关闭页面';
    }
  }
  function offerDraft(kind) {
    var notice = $('[data-draft-notice="' + kind + '"]'), draft = readDraft(kind);
    if (!notice) return;
    if (!draft || JSON.stringify(draft.context) !== JSON.stringify(draftContext(kind))) { clearDraft(kind); return; }
    if (kind === 'mine' && (!isOpen() || !state.user_id || state.can_manage)) { notice.hidden = true; return; }
    notice.hidden = false;
    notice.innerHTML = '<span>有尚未提交的' + (kind === 'config' ? '配置' : '报名') + '草稿</span><div><button class="app-button app-button-quiet" type="button" data-restore-draft="' + kind + '">恢复</button><button class="app-button app-button-quiet" type="button" data-discard-draft="' + kind + '">丢弃</button></div>';
  }
  function recoverDraft(kind) {
    var draft = readDraft(kind); if (!draft || JSON.stringify(draft.context) !== JSON.stringify(draftContext(kind))) return clearDraft(kind);
    if (kind === 'config') { fillConfig(draft.value.values); configDirty = true; showStep(draft.value.step); }
    else { mineDirty = true; restoreDraft(draft.value); updateCompletion(); }
    $('[data-draft-notice="' + kind + '"]').hidden = true;
    persistDraft(kind);
  }
  function remaining(a) {
    if (phase(a) !== '报名进行中') return '';
    var minutes = Math.max(1, Math.ceil((a.closes_at - now()) / 60000));
    return minutes >= 1440 ? '距截止 ' + Math.ceil(minutes / 1440) + ' 天' : minutes >= 60 ? '距截止 ' + Math.floor(minutes / 60) + ' 小时' : '距截止 ' + minutes + ' 分钟';
  }
  function entryLabel() {
    if (state.can_manage || !isOpen() && !state.mine && !state.invitations.length) return '';
    if (!state.user_id) return '登录报名';
    if (state.mine) return '查看报名';
    return state.invitations.length ? '处理邀请' : '开始报名';
  }
  function updateCompletion() {
    var form = $('[data-save-answers]') || $('[data-start-registration]'); if (!form) return;
    var meter = form.querySelector('[data-form-completion]'); if (!meter) return;
    var required = state.activity.fields.filter(function (f) { return f.required; }), values = answerValues(form).answers;
    var missing = required.filter(function (f) { return Array.isArray(values[f.id]) ? !values[f.id].length : !String(values[f.id] || '').trim(); });
    var teamName = form.elements.team_name; if (teamName) { required = required.concat({}); if (!teamName.value.trim()) missing.push({label:'队伍名称',id:'team_name'}); }
    meter.textContent = missing.length ? '必填 ' + (required.length - missing.length) + ' / ' + required.length : '必填信息已完整';
    meter.classList.toggle('is-complete', !missing.length);
  }
  function applyTemplate(name) {
    var templates = {
      individual: {mode:'individual',require_review:false,fields:[{id:'f_phone',label:'联系方式',type:'text',required:true,options:[]}]},
      team: {mode:'team',require_review:true,min_members:2,max_members:3,fields:[{id:'f_phone',label:'联系方式',type:'text',required:true,options:[]},{id:'f_group',label:'参赛组别',type:'select',required:true,options:['本科生组','研究生组']}]},
      training: {mode:'individual',require_review:true,fields:[{id:'f_phone',label:'联系方式',type:'text',required:true,options:[]},{id:'f_experience',label:'编程基础',type:'select',required:true,options:['零基础','掌握基础语法','有算法竞赛经验']},{id:'f_expectation',label:'学习意向',type:'textarea',required:false,options:[]}]}
    };
    if (mode !== 'new' || !templates[name]) return;
    if (fields.length && !window.confirm('应用模板将替换报名规则和问题，活动名称、介绍与时间保留。')) return;
    var values = Object.assign(configValues(), templates[name]); fillConfig(values); configDirty = true;
    root.querySelectorAll('[data-activity-template]').forEach(function (button) { button.setAttribute('aria-pressed', String(button.dataset.activityTemplate === name)); });
    persistDraft('config');
  }
  function pagination(target, total, current, attr) {
    target.innerHTML = '<span class="app-help">共 ' + total + ' 条 · 第 ' + current + ' / ' + Math.max(1, Math.ceil(total / 30)) + ' 页</span>' + (current > 1 ? '<button class="app-button app-button-secondary" type="button" ' + attr + '="' + (current - 1) + '">上一页</button>' : '') + (current * 30 < total ? '<button class="app-button app-button-secondary" type="button" ' + attr + '="' + (current + 1) + '">下一页</button>' : '');
  }
  async function loadList(page) {
    var params = new URLSearchParams(new FormData($('[data-list-search]'))); params.set('scope', listScope); params.set('page', page || 1);
    var result = await request('/api/v2/activities?' + params); clockOffset = (result.server_now || Date.now()) - Date.now();
    history.replaceState(null, '', '?' + params);
    root.querySelectorAll('[data-list-scope]').forEach(function (button) { button.setAttribute('aria-pressed', String(button.dataset.listScope === listScope)); });
    $('[data-activity-list]').innerHTML = result.items.map(function (a) {
      var d = local(a.starts_at || a.closes_at), open = phase(a) === '报名进行中';
      var managed = !!result.can_manage, invited = !managed && Number(a.invitation_count) > 0, review = Number(a.review_count) > 0;
      var action = managed ? review ? '审核报名' : '管理活动' : invited ? '处理邀请' : a.my_status ? '查看报名' : open ? '查看并报名' : '查看活动';
      var tab = managed ? '?tab=roster' : a.my_status || invited ? '?tab=mine' : '';
      return '<article class="activity-list-row"><div class="activity-date-mark"><span>' + d.slice(0, 4) + '.' + d.slice(5, 7) + '</span><strong>' + d.slice(8, 10) + '</strong><small>' + (a.starts_at ? '活动日' : '截止日') + '</small></div><div class="activity-list-content"><div class="activity-meta"><span class="activity-state ' + (open ? 'activity-state-open' : '') + '">' + phase(a) + '</span><span>' + (a.mode === 'team' ? '组队 · ' + a.min_members + '–' + a.max_members + ' 人' : '个人报名') + '</span><span>已报名 ' + (Number(a.registered_count) || 0) + ' 人</span>' + (!managed && a.my_status ? status(a.my_status) : '') + (invited ? '<span class="activity-state activity-state-pending">' + a.invitation_count + ' 份邀请</span>' : '') + (review ? '<span class="activity-caption">待审核 ' + a.review_count + '</span>' : '') + '</div><h2><a href="/activities/' + a.id + '">' + esc(a.title) + '</a></h2><div class="activity-meta"><span>报名截止 ' + date(a.closes_at) + '</span><span>' + esc(a.location || '地点待定') + '</span>' + (open ? '<span class="activity-deadline">' + remaining(a) + '</span>' : '') + '</div></div><a class="app-button ' + (open ? 'app-button-primary' : 'app-button-secondary') + '" href="/activities/' + a.id + tab + '">' + action + '<span aria-hidden="true">→</span></a></article>';
    }).join('') || empty('暂无符合条件的活动', '试试其他分类或搜索关键词。');
    $('[data-list-result-count]').textContent = result.total + ' 个活动';
    pagination($('[data-activity-pages]'), result.total, result.page, 'data-list-page');
  }
  function selectedTab() {
    var tab = new URLSearchParams(location.search).get('tab') || 'intro';
    if (tab === 'mine' && state && state.can_manage) return 'roster';
    return ['intro', 'mine'].includes(tab) || (state && state.can_manage && ['roster', 'fields', 'settings'].includes(tab)) ? tab : 'intro';
  }
  function showTab() {
    var tab = mode === 'new' ? 'settings' : selectedTab(), config = ['settings', 'fields'].includes(tab);
    root.querySelectorAll('[data-activity-panel]').forEach(function (panel) { panel.hidden = panel.dataset.activityPanel !== tab; });
    root.querySelectorAll('[data-activity-tab]').forEach(function (item) { var active = item.dataset.activityTab === (tab === 'fields' ? 'settings' : tab); item.classList.toggle('is-active', active); if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); });
    if ($('[data-activity-config]')) { $('[data-activity-config]').hidden = !config; if (config) showStep(tab === 'fields' ? 2 : configStep); }
    if (tab === 'roster') return loadRoster(1);
  }
  function showStep(index) {
    configStep = Math.max(0, Math.min(3, index));
    root.querySelectorAll('[data-config-step]').forEach(function (panel) { panel.hidden = Number(panel.dataset.configStep) !== configStep; });
    root.querySelectorAll('[data-config-goto]').forEach(function (button) { var active = Number(button.dataset.configGoto) === configStep; button.classList.toggle('is-active', active); if (active) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current'); });
    $('[data-config-prev]').hidden = configStep === 0; $('[data-config-next]').hidden = configStep === 3; $('[data-config-save]').hidden = configStep !== 3;
    updatePreview();
  }
  function fillConfig(a) {
    var form = $('[data-activity-config]'); if (!form) return;
    ['title', 'description', 'location', 'mode', 'status', 'min_members', 'max_members', 'require_review'].forEach(function (name) { form.elements[name].value = String(a[name] == null ? '' : a[name]); });
    if (a.mode !== 'team') { form.elements.min_members.value = 2; form.elements.max_members.value = 3; }
    ['opens_at', 'closes_at', 'starts_at'].forEach(function (name) { var input = form.elements[name]; input.value = local(a[name]); if (input._flatpickr) input._flatpickr.setDate(input.value, false, 'Y-m-d\\TH:i'); });
    var locked = !!(state && state.fields_locked);
    form.querySelectorAll('[name="mode"], [name="min_members"], [name="max_members"], [name="require_review"], [data-add-field], [data-field-preset]').forEach(function (input) { input.disabled = locked; });
    $('[data-config-locked]').hidden = !locked;
    form.elements.status.querySelector('[value="draft"]').disabled = locked && a.status !== 'draft';
    fields = JSON.parse(JSON.stringify(a.fields || [])); renderFields(); teamSettings(); configDirty = false;
  }
  function teamSettings() { root.querySelectorAll('[data-team-setting]').forEach(function (item) { item.hidden = $('[data-activity-config]').elements.mode.value !== 'team'; }); }
  function renderFields() {
    var locked = !!(state && state.fields_locked);
    $('[data-activity-fields]').innerHTML = fields.map(function (field, index) {
      return '<fieldset class="activity-field-editor" data-field-index="' + index + '"' + (locked ? ' disabled' : '') + '><legend>问题 ' + (index + 1) + '</legend><div class="app-form-grid"><label class="app-field"><span class="app-label">问题名称</span><input class="app-input" data-field-prop="label" maxlength="100" value="' + esc(field.label) + '" required></label><label class="app-field"><span class="app-label">填写方式</span><select class="app-select" data-field-prop="type">' + [['text', '短文本'], ['textarea', '长文本'], ['radio', '单选'], ['checkbox', '多选'], ['select', '下拉选择']].map(function (pair) { return '<option value="' + pair[0] + '"' + (field.type === pair[0] ? ' selected' : '') + '>' + pair[1] + '</option>'; }).join('') + '</select></label></div>' + (['radio', 'checkbox', 'select'].includes(field.type) ? '<label class="app-field"><span class="app-label">选项（每行一个）</span><textarea class="app-textarea" data-field-prop="options" rows="3" required>' + esc(field.options.join('\n')) + '</textarea></label>' : '') + '<div class="activity-field-actions"><label class="activity-choice"><input type="checkbox" data-field-prop="required"' + (field.required ? ' checked' : '') + '>必填</label><button type="button" class="app-button app-button-quiet" data-field-move="-1"' + (!index ? ' disabled' : '') + '>上移</button><button type="button" class="app-button app-button-quiet" data-field-move="1"' + (index === fields.length - 1 ? ' disabled' : '') + '>下移</button><button type="button" class="app-button app-button-quiet" data-field-remove>删除</button></div></fieldset>';
    }).join('') || empty('还没有自定义问题', '只需要实名资料时，可直接进入下一步。');
    updatePreview();
  }
  function collectFields() { root.querySelectorAll('[data-field-index]').forEach(function (row) { var field = fields[Number(row.dataset.fieldIndex)]; row.querySelectorAll('[data-field-prop]').forEach(function (input) { var key = input.dataset.fieldProp; field[key] = key === 'required' ? input.checked : key === 'options' ? input.value.split('\n').map(function (line) { return line.trim(); }).filter(Boolean) : input.value; }); }); }
  function configValues() {
    var form = $('[data-activity-config]'), data = {};
    ['title', 'description', 'location', 'mode', 'status', 'min_members', 'max_members', 'require_review'].forEach(function (name) { data[name] = form.elements[name].value; });
    ['opens_at', 'closes_at', 'starts_at'].forEach(function (name) { data[name] = epoch(form.elements[name].value); });
    data.require_review = data.require_review === 'true'; data.fields = fields; data.revision = state && state.activity.revision;
    return data;
  }
  function updatePreview() {
    if (!$('[data-activity-config]')) return;
    collectFields(); var a = configValues();
    $('[data-fields-preview]').innerHTML = fields.map(function (field) { return question(field, {}, true); }).join('') || '<p>仅收集账号资料</p>';
    $('[data-config-preview]').innerHTML = '<div class="activity-publish-preview"><h3>' + esc(a.title || '未填写活动名称') + '</h3><dl class="activity-fact-list"><div><dt>参与方式</dt><dd>' + (a.mode === 'team' ? a.min_members + '–' + a.max_members + ' 人组队' : '个人报名') + ' · ' + (a.require_review ? '提交后审核' : '提交即通过') + '</dd></div><div><dt>报名时间</dt><dd>' + date(a.opens_at) + ' — ' + date(a.closes_at) + '</dd></div><div><dt>活动安排</dt><dd>' + date(a.starts_at) + ' · ' + esc(a.location || '地点待定') + '</dd></div><div><dt>收集信息</dt><dd>账号实名资料' + (fields.length ? ' + ' + fields.length + ' 个问题' : '') + '</dd></div></dl></div>';
    var checks = [];
    if (!a.description.trim()) checks.push('未填写活动介绍');
    if (!a.location.trim()) checks.push('未填写活动地点');
    if (a.starts_at && a.starts_at < a.closes_at) checks.push('活动时间早于报名截止');
    if (a.closes_at <= now()) checks.push('报名截止时间已过');
    var checksNode = $('[data-publish-checks]'); checksNode.hidden = !checks.length;
    checksNode.innerHTML = checks.length ? '<strong>待核对</strong><ul>' + checks.map(function (item) { return '<li>' + item + '</li>'; }).join('') + '</ul>' : '';
    $('[data-config-save]').textContent = mode === 'new' ? (a.status === 'published' ? '创建并公开活动' : '创建活动') : '保存设置';
  }
  function validateStep(index) {
    var panel = $('[data-config-step="' + index + '"]');
    // Hidden wizard panels are validated after becoming visible, including the
    // visible Flatpickr text inputs instead of its hidden original controls.
    showStep(index);
    var controls = Array.from(panel.querySelectorAll('input,select,textarea')).filter(function (input) { return !input.disabled && input.type !== 'hidden' && !input.closest('[hidden]'); });
    for (var input of controls) if (!input.checkValidity()) { input.reportValidity(); return false; }
    var a = configValues();
    if (index === 1 && !(a.closes_at > a.opens_at)) { message('报名截止时间必须晚于开始时间。', true); return false; }
    if (index === 1 && a.mode === 'team' && Number(a.max_members) < Number(a.min_members)) { message('最多人数不能少于最少人数。', true); return false; }
    if (index === 2) {
      collectFields();
      for (var field of fields) if (['radio', 'checkbox', 'select'].includes(field.type) && (!field.options.length || field.options.length > 40 || new Set(field.options).size !== field.options.length)) { message('“' + field.label + '”需要 1–40 个不重复的选项。', true); return false; }
    }
    return true;
  }
  function identity(person) { return '<dl class="activity-identity">' + [['用户名', person.username], ['姓名', person.real_name], ['学号', person.student_id], ['学院', person.college], ['邮箱', person.email || '未填写']].map(function (pair) { return '<div' + (pair[0] === '邮箱' ? ' class="activity-identity-email"' : '') + '><dt>' + pair[0] + '</dt><dd>' + esc(pair[1]) + '</dd></div>'; }).join('') + '</dl>'; }
  function question(field, values, disabled) {
    var value = values[field.id], common = ' name="' + esc(field.id) + '"' + (disabled ? ' disabled' : ''), required = field.required && field.type !== 'checkbox' ? ' required' : '', control;
    if (field.type === 'textarea') control = '<textarea class="app-textarea" rows="3" maxlength="4000"' + common + required + '>' + esc(value || '') + '</textarea>';
    else if (field.type === 'select') control = '<select class="app-select"' + common + required + '><option value="">请选择</option>' + field.options.map(function (option) { return '<option' + (option === value ? ' selected' : '') + '>' + esc(option) + '</option>'; }).join('') + '</select>';
    else if (['radio', 'checkbox'].includes(field.type)) control = field.options.map(function (option) { return '<label class="activity-choice"><input type="' + field.type + '"' + common + required + ' value="' + esc(option) + '"' + ((Array.isArray(value) ? value.includes(option) : value === option) ? ' checked' : '') + '>' + esc(option) + '</label>'; }).join('');
    else control = '<input class="app-input" type="text" maxlength="500"' + common + required + ' value="' + esc(value || '') + '">';
    var label = esc(field.label || '未命名问题') + (field.required ? ' <em>*</em>' : '');
    return ['radio', 'checkbox'].includes(field.type) ? '<fieldset class="app-field"><legend class="app-label">' + label + '</legend>' + control + '</fieldset>' : '<label class="app-field"><span class="app-label">' + label + '</span>' + control + '</label>';
  }
  function steps(items, current) { return '<ol class="activity-progress">' + items.map(function (item, index) { return '<li class="' + (index < current ? 'is-complete' : index === current ? 'is-current' : '') + '"' + (index === current ? ' aria-current="step"' : '') + '><span>' + (index < current ? '✓' : index + 1) + '</span>' + item + '</li>'; }).join('') + '</ol>'; }
  function mineAside(a, r) {
    if (a.mode !== 'team' || !r) return '<aside class="activity-registration-aside"><h3>报名安排</h3><dl class="activity-fact-list"><div><dt>报名截止</dt><dd>' + date(a.closes_at) + '</dd></div><div><dt>审核方式</dt><dd>' + (a.require_review ? '提交后由活动管理者审核' : '提交即报名成功') + '</dd></div></dl></aside>';
    var leader = Number(r.leader_id) === state.user_id, editing = ['draft', 'returned'].includes(r.status), enabled = isOpen(), missing = r.members.filter(function (m) { return m.user_id !== state.user_id && !m.ready; });
    var enough = r.members.length >= a.min_members;
    var html = '<aside class="activity-registration-aside"><div class="activity-section-heading"><h3>队伍成员 <span>' + r.members.length + '/' + a.max_members + '</span></h3><button type="button" class="app-button app-button-quiet" data-refresh-mine>刷新</button></div>';
    html += r.members.map(function (m) { return '<div class="activity-member"><span class="activity-avatar" aria-hidden="true">' + esc(m.username.slice(0, 1).toUpperCase()) + '</span><div><strong>' + esc(m.username) + '</strong><small>' + (m.user_id === Number(r.leader_id) ? '队长' : '队员') + (m.user_id === state.user_id ? ' · 我' : '') + '</small></div><span class="activity-member-ready ' + (m.ready ? 'is-ready' : '') + '">' + (m.ready ? '已确认' : '待填写') + '</span>' + (enabled && leader && editing && m.user_id !== state.user_id ? '<button class="app-button app-button-quiet" type="button" data-remove-member="' + m.user_id + '">移除</button>' : '') + '</div>'; }).join('');
    html += (r.invitations || []).map(function (invite) { return '<div class="activity-member activity-pending-member"><span>' + esc(invite.username) + ' · 等待接受邀请</span>' + (enabled && leader ? '<button class="app-button app-button-quiet" type="button" data-cancel-invitation="' + invite.id + '">取消</button>' : '') + '</div>'; }).join('');
    if (enabled && leader && editing && r.members.length < a.max_members) html += '<form class="activity-invite-form" data-invite-member><label class="app-field"><span class="app-label">邀请队员</span><input class="app-input" name="username" placeholder="输入队员的 OJ 用户名" maxlength="80" required></label><button class="app-button app-button-secondary" type="submit">邀请</button></form>';
    html += '<div class="activity-submit-checklist"><h4>整队提交前</h4><p class="' + (enough ? 'is-ready' : '') + '">' + (enough ? '✓ 人数已满足要求' : '还需 ' + (a.min_members - r.members.length) + ' 位成员加入') + '</p><p>' + (missing.length ? '等待 ' + esc(missing.map(function (m) { return m.username; }).join('、')) + ' 确认资料' : '✓ 其他成员资料已确认') + '</p>';
    if (enabled && leader && editing) html += '<button class="app-button app-button-primary" type="submit" form="activity-answer-form" name="intent" value="submit" data-submit-registration' + (!enough || missing.length ? ' disabled' : '') + '>确认并提交整队报名</button>';
    else if (editing && !leader) html += '<p>等待队长提交</p>';
    return html + '</div></aside>';
  }
  function renderMine() {
    var target = $('[data-activity-mine]'), a = state.activity, r = state.mine, enabled = isOpen(), team = a.mode === 'team';
    if (!target || state.can_manage) return;
    if (!state.user_id) { target.innerHTML = empty('登录后报名', '使用本人的 OJ 账户填写信息、接收组队邀请。') + '<a class="app-button app-button-primary" href="/login?url=' + encodeURIComponent('/activities/' + id + '?tab=mine') + '">登录报名</a>'; return; }
    var html = enabled ? '' : '<p class="activity-inline-notice">' + phase(a) + '，当前仅可查看报名信息。</p>';
    html += state.invitations.map(function (invite) { return '<div class="activity-invitation"><div><span class="activity-caption">组队邀请</span><h3>' + esc(invite.team_name) + '</h3><p>' + esc(invite.leader_username) + ' 邀请你加入队伍</p></div>' + (enabled ? '<div class="activity-button-group"><button class="app-button app-button-secondary" type="button" data-invitation="' + invite.id + '" data-invite-action="decline">拒绝</button><button class="app-button app-button-primary" type="button" data-invitation="' + invite.id + '" data-invite-action="accept">接受并加入</button></div>' : '') + '</div>'; }).join('');
    if (!r && !state.identity) { target.innerHTML = html + empty('先完善账号资料', state.identity_error) + '<a class="app-button app-button-primary" href="/user/' + state.user_id + '/edit">完善账号资料</a>'; return; }
    var leader = !r || Number(r.leader_id) === state.user_id, editing = !r || ['draft', 'returned'].includes(r.status), own = r ? r.members.find(function (m) { return m.user_id === state.user_id; }) : state.identity;
    html += steps(['填写报名信息', '报名结果'], editing ? 0 : 1);
    html += '<div class="activity-registration-layout"><div class="activity-registration-main">';
    if (!r && team) {
      html += '<div class="activity-section-heading"><div><h2>组队报名</h2></div></div><div class="activity-team-choice" role="group" aria-label="组队身份"><button class="app-button app-button-secondary" type="button" data-team-role="captain" aria-pressed="true">我是队长</button><button class="app-button app-button-secondary" type="button" data-team-role="member" aria-pressed="false">我是队员</button></div>';
      if (enabled) html += '<form class="activity-answer-form" data-start-registration data-team-create><label class="app-field"><span class="app-label">队伍名称</span><input class="app-input" name="team_name" placeholder="为你的队伍起一个名字" maxlength="80" required></label><button class="app-button app-button-primary" type="submit">创建队伍，邀请成员</button><span class="activity-caption" data-form-draft-status></span></form>';
    html += '<div class="activity-team-join" data-team-join hidden><h3>等待队长邀请</h3><div><code>' + esc(state.identity.username) + '</code><button class="app-button app-button-secondary" type="button" data-copy-username>复制用户名</button></div></div>';
    } else {
      if (r) {
        var titles = { draft: team ? r.team_name : '完成你的报名', returned: '请修改后重新提交', pending: '报名已提交，等待审核', approved: '报名成功' };
        html += '<div class="activity-receipt activity-receipt-' + r.status + '"><div class="activity-section-heading"><h2>' + esc(titles[r.status] || '我的报名') + '</h2></div><p>' + (r.submitted_at ? '报名编号 #' + r.id + ' · 提交于 ' + date(r.submitted_at) : '报名编号 #' + r.id) + '</p>' + (r.review_note ? '<div class="activity-review-note"><strong>审核说明</strong><p>' + esc(r.review_note) + '</p></div>' : '') + '</div>';
      } else html += '<div class="activity-section-heading"><div><h2>填写报名信息</h2></div></div>';
      if (own) {
        html += identity(own);
        var showForm = enabled && (editing || editingAnswers);
        if (showForm) html += '<form id="activity-answer-form" class="activity-answer-form" ' + (r ? 'data-save-answers' : 'data-start-registration') + '>' + (leader && team ? '<label class="app-field"><span class="app-label">队伍名称</span><input class="app-input" name="team_name" maxlength="80" value="' + esc(r.team_name) + '" required></label>' : '') + a.fields.map(function (field) { return question(field, own.answers || {}, false); }).join('') + '<div class="activity-form-completion" data-form-completion role="status"></div><div class="activity-button-group"><button class="app-button ' + (team && editing ? 'app-button-secondary' : 'app-button-primary') + '" type="submit" name="intent" value="' + (!team && editing ? 'submit' : 'save') + '">' + (!team && editing ? '确认并提交报名' : team && editing ? '保存并确认我的信息' : '保存修改') + '</button>' + (!editing ? '<button class="app-button app-button-quiet" type="button" data-cancel-edit>取消修改</button>' : '') + '</div><span class="activity-caption" data-form-draft-status></span></form>';
        else {
          html += '<dl class="activity-answer-summary">' + a.fields.map(function (field) { var value = (own.answers || {})[field.id]; return '<div><dt>' + esc(field.label) + '</dt><dd>' + esc(Array.isArray(value) ? value.join('、') : value || '未填写') + '</dd></div>'; }).join('') + '</dl>';
          if (enabled && r) html += '<button type="button" class="app-button app-button-secondary" data-edit-answers>修改报名信息</button>';
        }
      }
    }
    if (enabled && r) html += '<div class="activity-withdraw"><button type="button" class="app-button app-button-danger-outline" data-withdraw-registration>' + (leader ? '撤回' + (team ? '整队报名' : '报名') : '退出队伍') + '</button></div>';
    target.innerHTML = html + '</div>' + mineAside(a, r) + '</div>';
    updateCompletion();
  }
  function ownDraft() {
    var form = $('[data-save-answers]') || $('[data-start-registration]');
    return form && mineDirty ? { values: Array.from(new FormData(form)), editing: editingAnswers } : null;
  }
  function restoreDraft(draft) {
    if (!draft) return;
    editingAnswers = draft.editing; renderMine();
    var form = $('[data-save-answers]') || $('[data-start-registration]'); if (!form) return;
    Array.from(form.elements).forEach(function (input) { if (!input.name || input.type === 'submit') return; var values = draft.values.filter(function (entry) { return entry[0] === input.name; }).map(function (entry) { return entry[1]; }); if (input.type === 'checkbox' || input.type === 'radio') input.checked = values.includes(input.value); else if (values.length) input.value = values[0]; });
    updateCompletion();
  }
  async function loadDetail(fill, preserveDraft) {
    var draft = preserveDraft ? ownDraft() : null;
    state = await request(api); clockOffset = state.server_now - Date.now(); var a = state.activity;
    $('[data-activity-title]').textContent = a.title; document.title = a.title + ' - NWPUOJ';
    $('[data-activity-summary]').textContent = (a.mode === 'team' ? '组队报名 · ' + a.min_members + '–' + a.max_members + ' 人' : '个人报名') + ' · ' + phase(a);
    $('[data-activity-phase]').textContent = phase(a); $('[data-activity-phase]').classList.toggle('activity-state-open', isOpen());
    $('[data-activity-description]').innerHTML = state.description_html || '<p>暂无活动介绍</p>';
    $('[data-activity-facts]').innerHTML = '<h3>活动安排</h3><dl class="activity-fact-list">' + [['已报名人数', (Number(a.registered_count) || 0) + ' 人'], ['报名开始', date(a.opens_at)], ['报名截止', date(a.closes_at)], ['活动时间', date(a.starts_at)], ['活动地点', a.location || '待定'], ['审核方式', a.require_review ? '提交后审核' : '提交即报名成功']].map(function (pair) { return '<div><dt>' + pair[0] + '</dt><dd>' + esc(pair[1]) + '</dd></div>'; }).join('') + '</dl>';
    var entry = $('[data-activity-entry]'), label = entryLabel(), mineCount = $('[data-mine-count]');
    entry.hidden = !label;
    entry.innerHTML = label ? '<a class="app-button app-button-primary" href="?tab=mine" data-activity-tab="mine">' + label + '<span aria-hidden="true">→</span></a>' : '';
    if (mineCount) { mineCount.hidden = !state.invitations.length; mineCount.textContent = state.invitations.length; }
    renderMine(); restoreDraft(draft); updateCompletion(); if (fill) fillConfig(a);
    if (!draft) offerDraft('mine'); if (fill) offerDraft('config');
  }
  async function action(name, values, preserveDraft) { await request(api + '/registration/action', 'POST', Object.assign({ action: name, revision: state.mine.revision }, values || {})); if (!preserveDraft) { clearDraft('mine'); mineDirty = false; editingAnswers = false; } await loadDetail(false, preserveDraft); }
  function answerValues(form) {
    var data = new FormData(form), values = {};
    state.activity.fields.forEach(function (field) { values[field.id] = field.type === 'checkbox' ? data.getAll(field.id) : data.get(field.id) || ''; });
    return { answers: values, team_name: data.get('team_name') };
  }
  function validateAnswers(form) {
    for (var field of state.activity.fields) if (field.type === 'checkbox' && field.required && !new FormData(form).getAll(field.id).length) { message('请选择“' + field.label + '”的至少一个选项。', true); var input = form.querySelector('[name="' + field.id + '"]'); if (input) input.focus(); return false; }
    return form.reportValidity();
  }
  function rosterMember(person, activity) {
    return '<section class="activity-roster-person" data-roster-person="' + person.user_id + '" hidden>' + identity(person) + '<dl class="activity-answer-summary">' + activity.fields.map(function (field) {
      var value = (person.answers || {})[field.id];
      var answer = Array.isArray(value) ? value.join('、') : value;
      return '<div><dt>' + esc(field.label) + '</dt><dd' + (!answer ? ' class="activity-caption"' : '') + '>' + esc(answer || '未填写') + '</dd></div>';
    }).join('') + '</dl>' + '</section>';
  }
  function rosterRegistration(r, activity) {
    var captain = r.members.find(function (person) { return person.user_id === Number(r.leader_id); });
    var leader = captain || r.members[0] || {};
    var team = activity.mode === 'team', title = team ? r.team_name : leader.real_name || leader.username;
    var reviewable = !['draft', 'withdrawn'].includes(r.status);
    var html = '<details class="activity-registration" name="activity-roster" data-roster-id="' + r.id + '"><summary>' +
      '<span class="activity-roster-name"><strong>' + esc(title || '个人报名') + '</strong><small>#' + r.id + ' · ' + (team ? captain ? '队长 ' : '成员 ' : '') + esc(leader.username || '—') + '</small></span>' +
      '<span class="activity-roster-members"><strong>' + r.members.length + ' 人</strong><small>' + (team ? esc(r.members.map(function (person) { return person.username; }).join(' / ')) : esc(leader.student_id || '')) + '</small></span>' +
      '<time class="activity-roster-time">' + (r.submitted_at ? date(r.submitted_at) : '尚未提交') + '</time>' + status(r.status) +
      '<span class="activity-roster-expand"><span class="activity-roster-open-label">' + (r.status === 'pending' ? '审核' : '详情') + '</span><span class="activity-roster-close-label">收起</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></span></summary>' +
      '<div class="activity-roster-detail"><div class="activity-roster-profile"><div class="activity-section-heading"><h3>报名资料</h3></div>';
    if (r.members.length > 1) html += '<div class="activity-roster-member-switch" role="group" aria-label="选择查看的成员">' + r.members.map(function (person, index) {
      return '<button type="button" data-roster-member="' + person.user_id + '" aria-pressed="' + (index === 0) + '">' + esc(person.username) + (person.user_id === Number(r.leader_id) ? '<small>队长</small>' : '') + '</button>';
    }).join('') + '</div>';
    html += r.members.map(function (person) { return rosterMember(person, activity); }).join('') + '</div><aside class="activity-roster-review"><div class="activity-section-heading"><h3>' + (reviewable ? '审核报名' : '报名状态') + '</h3>' + status(r.status) + '</div>';
    if (r.review_note) html += '<div class="activity-last-review"><span>上次审核说明</span><p>' + esc(r.review_note) + '</p></div>';
    if (reviewable) html += '<form class="activity-review" data-review-id="' + r.id + '" data-review-revision="' + r.revision + '"><fieldset class="app-field activity-review-decisions"><legend class="app-label">审核结果</legend>' + [['approved', '通过'], ['returned', '退回修改']].map(function (pair) {
      return '<label><input type="radio" name="status" value="' + pair[0] + '" required' + (r.status === pair[0] ? ' checked' : '') + '><span>' + pair[1] + '</span></label>';
    }).join('') + '</fieldset><label class="app-field"><span class="app-label">审核说明<span data-review-required' + (r.status === 'returned' ? '' : ' hidden') + '> *</span></span><textarea class="app-textarea" name="note" rows="3" maxlength="1000" placeholder="填写需补充或修改的内容"' + (r.status === 'returned' ? ' required' : '') + '>' + esc(r.review_note || '') + '</textarea></label><div class="activity-review-actions"><button class="app-button app-button-primary" type="submit">保存审核结果</button>' + (r.status === 'pending' ? '<button class="app-button app-button-secondary" type="submit" name="next" value="1">保存并审核下一份 →</button>' : '') + '</div></form>';
    else html += '<p>' + (r.status === 'draft' ? '尚未提交' : '报名已撤回') + '</p>';
    return html + '</aside></div></details>';
  }
  function selectRosterMember(record, userId) {
    var people = Array.from(record.querySelectorAll('[data-roster-person]'));
    var selected = people.find(function (person) { return person.dataset.rosterPerson === String(userId); }) || people[0];
    people.forEach(function (person) { person.hidden = person !== selected; });
    record.querySelectorAll('[data-roster-member]').forEach(function (button) { button.setAttribute('aria-pressed', String(!!selected && button.dataset.rosterMember === selected.dataset.rosterPerson)); });
  }
  async function loadRoster(page, focusId, advance) {
    var previous = new Map();
    root.querySelectorAll('[data-roster-id]').forEach(function (record) {
      var person = record.querySelector('[data-roster-person]:not([hidden])'), review = record.querySelector('[data-review-id]');
      previous.set(record.dataset.rosterId, { open: record.open, person: person && person.dataset.rosterPerson,
        revision: review && review.dataset.reviewRevision, values: review && Object.fromEntries(new FormData(review)) });
    });
    var params = new URLSearchParams(new FormData($('[data-roster-search]'))); params.set('page', page || 1);
    var data = await request(api + '/registrations?' + params);
    rosterPage = data.page; params.set('page', rosterPage);
    $('[data-roster-export]').href = api + '/registrations/export?' + params;
    var summary = data.summary || {}, total = Object.keys(summary).reduce(function (sum, key) { return sum + Number(summary[key] || 0); }, 0);
    $('[data-roster-summary]').innerHTML = [['', '全部', total], ['pending', '待审核'], ['approved', '报名成功'], ['returned', '退回修改'], ['withdrawn', '已撤回']].map(function (pair) {
      return '<button type="button" data-roster-status="' + pair[0] + '" aria-pressed="' + (params.get('status') === pair[0]) + '"><span>' + pair[1] + '</span><strong>' + (pair.length === 3 ? pair[2] : summary[pair[0]] || 0) + '</strong></button>';
    }).join('');
    var queue = $('[data-review-queue]'); queue.hidden = !summary.pending;
    queue.innerHTML = '<button class="app-button app-button-secondary" type="button" data-start-review>开始审核 →</button>';
    var filtered = !!(params.get('search') || params.get('status'));
    $('[data-roster-reset]').hidden = !filtered;
    $('[data-roster-result-count]').textContent = (filtered ? '筛选结果 · ' : '') + data.total + ' 份报名';
    $('[data-roster-name-label]').textContent = data.activity.mode === 'team' ? '队伍 / 队长' : '报名人';
    $('[data-activity-roster]').innerHTML = data.items.map(function (r) { return rosterRegistration(r, data.activity); }).join('') || empty('暂无报名记录', filtered ? '没有找到符合当前筛选条件的报名。' : '活动公开后，参与者的报名会出现在这里。');
    root.querySelectorAll('[data-roster-id]').forEach(function (record) {
      var old = previous.get(record.dataset.rosterId), review = record.querySelector('[data-review-id]');
      record.open = !!(old && old.open);
      selectRosterMember(record, old && old.person);
      // A save refreshes the counts but must not discard another review draft.
      // Retain its draft only while the displayed registration revision agrees.
      if (review && old && old.values && old.revision === review.dataset.reviewRevision) {
        review.elements.status.value = old.values.status || '';
        review.elements.note.value = old.values.note || '';
        review.elements.note.required = review.elements.status.value === 'returned';
        review.querySelector('[data-review-required]').hidden = !review.elements.note.required;
      }
    });
    pagination($('[data-roster-pages]'), data.total, data.page, 'data-roster-page');
    if (advance) {
      var next = $('[data-roster-id]');
      if (next) { next.open = true; next.querySelector('summary').focus(); next.scrollIntoView({block:'nearest'}); }
      else message('当前筛选范围的审核已完成。');
    } else if (focusId) {
      var record = $('[data-roster-id="' + focusId + '"]');
      if (record) record.querySelector('summary').focus({ preventScroll: true });
      else $('[data-roster-search] [name="search"]').focus({ preventScroll: true });
    }
  }
  function leaveForm() { return !mineDirty || window.confirm('报名信息尚未提交，确认离开？已暂存的草稿可稍后恢复。'); }
  root.addEventListener('toggle', function (event) {
    var opened = event.target;
    if (!opened.matches('[data-roster-id]') || !opened.open) return;
    root.querySelectorAll('[data-roster-id][open]').forEach(function (record) { if (record !== opened) record.open = false; });
  }, true);
  root.addEventListener('input', function (event) {
    if (event.target.closest('[data-activity-config]')) { configDirty = true; updatePreview(); persistDraft('config'); }
    if (event.target.closest('[data-save-answers],[data-start-registration]')) { mineDirty = true; updateCompletion(); persistDraft('mine'); }
  });
  root.addEventListener('change', function (event) {
    if (event.target.closest('[data-activity-config]')) { configDirty = true; if (event.target.matches('[name="mode"]')) teamSettings(); if (event.target.matches('[data-field-prop="type"]')) { collectFields(); renderFields(); } updatePreview(); persistDraft('config'); }
    if (event.target.closest('[data-save-answers],[data-start-registration]')) { mineDirty = true; updateCompletion(); persistDraft('mine'); }
    if (event.target.closest('[data-roster-search]') && event.target.name === 'sort') work(function () { return loadRoster(1); });
    if (event.target.closest('[data-review-id]') && event.target.name === 'status') { event.target.form.elements.note.required = event.target.value !== 'approved'; event.target.form.querySelector('[data-review-required]').hidden = event.target.value === 'approved'; }
  });
  root.addEventListener('click', function (event) {
    var button = event.target.closest('button,a'); if (!button || !root.contains(button)) return;
    if (busy) { event.preventDefault(); return; }
    if (button.hasAttribute('data-restore-draft')) return recoverDraft(button.dataset.restoreDraft);
    if (button.hasAttribute('data-discard-draft')) return clearDraft(button.dataset.discardDraft);
    if (button.hasAttribute('data-team-role')) { var member = button.dataset.teamRole === 'member'; if ($('[data-team-create]')) $('[data-team-create]').hidden = member; $('[data-team-join]').hidden = !member; root.querySelectorAll('[data-team-role]').forEach(function (item) { item.setAttribute('aria-pressed', String(item === button)); }); return; }
    if (button.hasAttribute('data-copy-username')) return work(async function () { await navigator.clipboard.writeText(state.identity.username); }, '用户名已复制。');
    if (button.hasAttribute('data-activity-template')) return applyTemplate(button.dataset.activityTemplate);
    if (button.hasAttribute('data-activity-tab')) { event.preventDefault(); if (!leaveForm()) return; mineDirty = false; editingAnswers = false; renderMine(); offerDraft('mine'); history.replaceState(null, '', button.href); work(showTab); return; }
    if (button.hasAttribute('data-config-goto')) { var targetStep = Number(button.dataset.configGoto); if (targetStep > configStep) for (var step = configStep; step < targetStep; step++) if (!validateStep(step)) return; showStep(targetStep); return; }
    if (button.hasAttribute('data-config-next')) { var next = configStep + 1; if (validateStep(configStep)) showStep(next); return; }
    if (button.hasAttribute('data-config-prev')) return showStep(configStep - 1);
    if (button.hasAttribute('data-add-field') || button.hasAttribute('data-field-preset')) {
      collectFields(); if (fields.length >= 30) return message('最多添加 30 个问题。', true);
      var preset = { phone: ['联系方式', 'text'], grade: ['年级', 'select', ['2026 级', '2025 级', '2024 级', '2023 级', '其他']], note: ['备注', 'textarea'] }[button.dataset.fieldPreset];
      fields.push({ id: 'f_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), label: preset ? preset[0] : '', type: preset ? preset[1] : 'text', required: !preset || button.dataset.fieldPreset !== 'note', options: preset && preset[2] || [] }); configDirty = true; renderFields(); persistDraft('config'); var rows = root.querySelectorAll('[data-field-prop="label"]'); rows[rows.length - 1].focus(); return;
    }
    if (button.hasAttribute('data-field-remove') || button.hasAttribute('data-field-move')) { collectFields(); var index = Number(button.closest('[data-field-index]').dataset.fieldIndex); if (button.hasAttribute('data-field-remove')) fields.splice(index, 1); else { var target = index + Number(button.dataset.fieldMove); if (target >= 0 && target < fields.length) { var field = fields.splice(index, 1)[0]; fields.splice(target, 0, field); } } configDirty = true; renderFields(); persistDraft('config'); return; }
    if (button.hasAttribute('data-list-scope')) { listScope = button.dataset.listScope; return work(function () { return loadList(1); }); }
    if (button.hasAttribute('data-list-page')) return work(function () { return loadList(Number(button.dataset.listPage)); });
    if (button.hasAttribute('data-start-review')) { $('[data-roster-search]').elements.status.value = 'pending'; $('[data-roster-search]').elements.sort.value = 'review'; return work(function () { return loadRoster(1, null, true); }); }
    if (button.hasAttribute('data-roster-member')) { selectRosterMember(button.closest('[data-roster-id]'), button.dataset.rosterMember); return; }
    if (button.hasAttribute('data-roster-reset')) { var searchForm = $('[data-roster-search]'); searchForm.reset(); searchForm.elements.status.value = ''; return work(function () { return loadRoster(1); }); }
    if (button.hasAttribute('data-roster-page')) return work(function () { return loadRoster(Number(button.dataset.rosterPage)); });
    if (button.hasAttribute('data-roster-status')) { $('[data-roster-search]').elements.status.value = button.dataset.rosterStatus; return work(function () { return loadRoster(1); }); }
    if (button.hasAttribute('data-copy-activity')) return work(async function () { var result = await request(api + '/copy', 'POST', {}); configDirty = false; location.href = '/activities/' + result.id + '?tab=settings'; });
    if (button.hasAttribute('data-delete-activity')) { $('[data-delete-name]').textContent = state.activity.title; $('[data-confirm-delete]').reset(); $('[data-delete-error]').hidden = true; $('[data-delete-dialog]').showModal(); return; }
    if (button.hasAttribute('data-delete-cancel')) return $('[data-delete-dialog]').close();
    if (button.hasAttribute('data-edit-answers')) { editingAnswers = true; return renderMine(); }
    if (button.hasAttribute('data-cancel-edit')) { if (leaveForm()) { editingAnswers = false; mineDirty = false; clearDraft('mine'); renderMine(); } return; }
    if (button.hasAttribute('data-refresh-mine')) return work(function () { return loadDetail(false, true); }, '成员状态已更新，未保存的输入已保留。');
    if (button.hasAttribute('data-invitation')) { if (!leaveForm()) return; return work(async function () { await request(api + '/invitations/' + button.dataset.invitation, 'POST', { action: button.dataset.inviteAction }); clearDraft('mine'); mineDirty = false; await loadDetail(false); }, button.dataset.inviteAction === 'accept' ? '已加入队伍，请确认自己的报名信息。' : '已拒绝邀请。'); }
    if (button.hasAttribute('data-cancel-invitation')) return work(function () { return action('cancel-invitation', { invitation_id: Number(button.dataset.cancelInvitation) }, true); });
    if (button.hasAttribute('data-remove-member') && window.confirm('确认移除该成员？')) return work(function () { return action('remove-member', { user_id: Number(button.dataset.removeMember) }, true); });
    if (button.hasAttribute('data-withdraw-registration') && window.confirm('确认撤回报名或退出队伍？组队报名将需要重新提交。')) return work(function () { return action(Number(state.mine.leader_id) === state.user_id ? 'withdraw' : 'leave'); }, '已撤回报名或退出队伍。');
  });
  root.addEventListener('submit', function (event) {
    var form = event.target; event.preventDefault(); if (busy) return;
    if (form.matches('[data-confirm-delete]')) return work(async function () {
      if (form.elements.title.value !== state.activity.title) { $('[data-delete-error]').hidden = false; $('[data-delete-error]').textContent = '活动名称不一致，请输入完整名称。'; form.elements.title.focus(); return; }
      try { await request(api, 'DELETE', { title: form.elements.title.value, revision: state.activity.revision }); configDirty = mineDirty = false; location.href = '/activities'; }
      catch (error) { $('[data-delete-error]').hidden = false; $('[data-delete-error]').textContent = error.message; }
    });
    if (form.matches('[data-activity-config]')) {
      for (var step = 0; step < 3; step++) if (!validateStep(step)) return;
      showStep(3);
      return work(async function () { var result = await request(api, mode === 'new' ? 'POST' : 'PATCH', configValues()); clearDraft('config'); configDirty = false; location.href = '/activities/' + result.id; });
    }
    if (form.matches('[data-start-registration]')) {
      if (state.activity.mode !== 'team' && !validateAnswers(form)) return;
      return work(async function () { var data = state.activity.mode === 'team' ? Object.fromEntries(new FormData(form)) : Object.assign(answerValues(form), { submit: true }); await request(api + '/registrations', 'POST', data); clearDraft('mine'); mineDirty = false; await loadDetail(false); }, state.activity.mode === 'team' ? '队伍已创建，接下来邀请成员并确认资料。' : '报名已提交。');
    }
    if (form.matches('[data-invite-member]')) return work(function () { return action('invite', Object.fromEntries(new FormData(form)), true); }, '邀请已添加，请告知队员到本活动确认加入。');
    if (form.matches('[data-save-answers]')) {
      if (!validateAnswers(form)) return;
      var submit = event.submitter && event.submitter.value === 'submit';
      return work(function () { return action(submit ? 'submit' : 'save', answerValues(form)); }, submit ? '报名已提交。' : '信息已保存并确认。');
    }
    if (form.matches('[data-list-search]')) return work(function () { return loadList(1); });
    if (form.matches('[data-roster-search]')) return work(function () { return loadRoster(1); });
    if (form.matches('[data-review-id]')) return work(async function () { var data = Object.fromEntries(new FormData(form)); data.revision = Number(form.dataset.reviewRevision); await request(api + '/registrations/' + form.dataset.reviewId + '/review', 'POST', data); if (event.submitter && event.submitter.name === 'next') { $('[data-roster-search]').elements.status.value = 'pending'; $('[data-roster-search]').elements.sort.value = 'review'; await loadRoster(1, null, true); } else await loadRoster(rosterPage, Number(form.dataset.reviewId)); }, '审核结果已保存。');
  });
  window.addEventListener('beforeunload', function (event) { if (configDirty || mineDirty) { event.preventDefault(); event.returnValue = ''; } });
  work(async function () {
    if (mode === 'list') { $('[data-list-search]').elements.search.value = new URLSearchParams(location.search).get('search') || ''; return loadList(Number(new URLSearchParams(location.search).get('page')) || 1); }
    if (mode === 'new') { fillConfig({ title: '', description: '', location: '', mode: 'individual', status: 'draft', require_review: true, opens_at: Date.now(), closes_at: Date.now() + 7 * 86400000, starts_at: null, fields: [] }); offerDraft('config'); return showTab(); }
    await loadDetail(true); await showTab();
  });
})();
