(function () {
  'use strict';
  var root = document.querySelector('[data-weekly-page]');
  if (!root) return;
  var board, busy = false, loadSequence = 0, page = { rank: 1, members: 1, attendance: 1 }, pending = new Map(), selected = new Set();
  var api = window.NWPUOJApi, base = '/api/v2/weekly-ranklist';
  var get = function (selector) { return root.querySelector(selector); };
  function element(tag, text, className) { var node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; }
  function button(text, fn, primary) { var node = element('button', text, 'app-button ' + (primary ? 'app-button-primary' : 'app-button-secondary') + ' app-button-small'); node.type = 'button'; node.addEventListener('click', fn); return node; }
  function message(text, failure) { var node = get('[data-weekly-status]'); node.textContent = text; node.hidden = !text; node.classList.toggle('is-error', !!failure); }
  function link(text, url) { var node = element('a', text); node.href = url; return node; }
  function refreshUserColors(scope) {
    if (window.NWPUOJApp && window.NWPUOJApp.refreshUsernameTiers) window.NWPUOJApp.refreshUsernameTiers(scope);
  }
  function display(row, real) { return real && row.real_name && row.student_id ? row.real_name + '-' + row.student_id : row.username; }
  function match(row, value) { return [row.username, row.user_id, row.real_name, row.student_id].join(' ').toLowerCase().includes(value.toLowerCase()); }
  function number(value) { return value == null ? '—' : Number(value).toFixed(2); }
  function time(value) { return new Date(value * 1000).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }); }
  async function confirmRemoval(text) {
    var dialog = get('[data-weekly-confirm]'); get('[data-weekly-confirm-text]').textContent = text;
    return new Promise(function (resolve) { dialog.addEventListener('close', function () { resolve(dialog.returnValue === 'confirm'); }, { once: true }); dialog.showModal(); });
  }
  function paginate(kind, rows, render) {
    var pages = Math.max(1, Math.ceil(rows.length / 100)); page[kind] = Math.min(page[kind], pages);
    var target = get('[data-weekly-pages="' + kind + '"]'); target.replaceChildren();
    var previous = button('上一页', function () { page[kind]--; render(); }); previous.disabled = page[kind] <= 1;
    var next = button('下一页', function () { page[kind]++; render(); }); next.disabled = page[kind] >= pages;
    target.append(previous, element('span', '第 ' + page[kind] + ' / ' + pages + ' 页 · ' + rows.length + ' 人 · 每页 100 人'), next);
    return rows.slice((page[kind] - 1) * 100, page[kind] * 100);
  }
  function header(target, labels) { var tr = element('tr'); labels.forEach(function (label) { tr.append(element('th', label)); }); target.replaceChildren(tr); return tr; }
  function empty(tbody, count, text) { if (tbody.children.length) return; var tr = element('tr'), td = element('td', text); td.colSpan = count; tr.append(td); tbody.append(tr); }
  function renderRank() {
    var tbody = get('[data-weekly-rank]'); if (!tbody || !board) return;
    var tr = header(get('[data-weekly-rank-head]'), ['名次', '参赛者', '总分', 'G1', 'G2', 'S1', 'S2', '线下次数']);
    board.contests.forEach(function (contest, index) { var th = element('th'); var a = link('第 ' + (index + 1) + ' 场 · #' + contest.id, '/contest/' + contest.id + '/ranklist'); a.title = contest.title; th.append(a, element('small', contest.title)); tr.append(th); });
    var real = get('[data-weekly-identities]') && get('[data-weekly-identities]').checked;
    var rows = board.rows.filter(function (row) { return match(row, get('[data-weekly-rank-filter]').value); });
    tbody.replaceChildren();
    paginate('rank', rows, renderRank).forEach(function (row) {
      var tr = element('tr'); if (window.__NWPUOJ_APP && window.__NWPUOJ_APP.user && row.user_id === window.__NWPUOJ_APP.user.id) tr.className = 'weekly-me';
      tr.append(element('td', row.rank)); var user = element('td'); user.append(link(display(row, real), '/user/' + row.user_id)); tr.append(user);
      [row.total, row.g1, row.g2, row.s1, row.s2].forEach(function (value) { tr.append(element('td', number(value))); });
      tr.append(element('td', row.onsite_count + ' / 4'));
      row.cells.forEach(function (cell) {
        var td = element('td', number(cell.score), cell.group ? 'weekly-' + cell.group : '');
        var participation = !cell.finished ? '未结束' : cell.onsite ? '线下 · ' + cell.group.toUpperCase() : !cell.participated ? '缺席' : '线上 · ' + (cell.group || '未计入').toUpperCase();
        var solvedRatio = (cell.solved == null ? '—' : cell.solved) + '/' + (cell.total_problems == null ? '—' : cell.total_problems);
        td.append(element('small', participation + ' · 通过 ' + solvedRatio));
        td.title = cell.finished ? '通过 ' + solvedRatio + ' 题 · 罚时 ' + Math.floor(cell.penalty / 60) + ' 分 · 总榜内第 ' + cell.rank + ' 名 · N=' + cell.population + ' · ' + (cell.group ? '计入 ' + cell.group.toUpperCase() : '不计入平均分') : '比赛结束后自动计算';
        tr.append(td);
      }); tbody.append(tr);
    });
    empty(tbody, 8 + board.contests.length, board.member_count ? '没有匹配的成员。' : '尚未添加总榜成员。');
    refreshUserColors(tbody);
  }
  function renderContests() {
    var list = get('[data-weekly-contests]'); if (!list) return;
    list.replaceChildren();
    board.contests.concat(board.excluded_contests || []).forEach(function (contest) {
      var item = element('div', null, 'weekly-contest-item'), text = element('div');
      text.append(link('#' + contest.id + ' · ' + contest.title, '/contest/' + contest.id), element('small', contest.start_time ? time(contest.start_time) + ' — ' + time(contest.end_time) : '非 ACM 赛制，已暂停计分，请移除或恢复赛制。'));
      item.append(text, button('移除', async function () { if (await confirmRemoval('从总榜移除这场比赛？其线下登记也会移除；原比赛和提交不受影响。')) write('/contests', { contest_ids: [contest.id], remove: true }); })); list.append(item);
    });
    if (!list.children.length) list.append(element('p', '尚未选择计分比赛。', 'app-help'));
  }
  function renderMembers() {
    var tbody = get('[data-weekly-members]'); if (!tbody) return;
    var rows = board.rows.filter(function (row) { return match(row, get('[data-weekly-member-filter]').value); });
    tbody.replaceChildren(); var current = paginate('members', rows, renderMembers);
    current.forEach(function (row) {
      var tr = element('tr'), td = element('td'), input = element('input'); input.type = 'checkbox'; input.checked = selected.has(row.user_id); input.dataset.memberId = row.user_id; input.setAttribute('aria-label', '选择 ' + row.username);
      input.addEventListener('change', function () { if (input.checked) selected.add(row.user_id); else selected.delete(row.user_id); renderMembers(); }); td.append(input); tr.append(td);
      var user = element('td'); user.append(link(row.username, '/user/' + row.user_id)); tr.append(user, element('td', row.real_name || '—'), element('td', row.student_id || '—'), element('td', row.onsite_count)); tbody.append(tr);
    });
    empty(tbody, 5, '没有匹配的总榜成员。');
    refreshUserColors(tbody);
    var selectAll = get('[data-weekly-select-all]'); selectAll.checked = current.length > 0 && current.every(function (row) { return selected.has(row.user_id); }); selectAll.indeterminate = !selectAll.checked && current.some(function (row) { return selected.has(row.user_id); });
    get('[data-weekly-remove-members]').disabled = !selected.size;
  }
  function pendingLabel() { get('[data-weekly-save-attendance]').disabled = !pending.size; get('[data-weekly-attendance-pending]').textContent = pending.size ? pending.size + ' 项更改尚未保存' : ''; }
  function renderAttendance() {
    var tbody = get('[data-weekly-attendance]'); if (!tbody) return;
    var tr = header(get('[data-weekly-attendance-head]'), ['成员']);
    board.contests.forEach(function (contest, i) { var th = element('th', '第 ' + (i + 1) + ' 场'); th.title = contest.title; tr.append(th); }); tbody.replaceChildren();
    var rows = board.rows.filter(function (row) { return match(row, get('[data-weekly-attendance-filter]').value); });
    paginate('attendance', rows, renderAttendance).forEach(function (row) {
      var tr = element('tr'); tr.append(element('td', display(row, true)));
      row.cells.forEach(function (cell, i) {
        var td = element('td'), input = element('input'), key = row.user_id + ':' + cell.contest_id; input.type = 'checkbox'; input.checked = pending.has(key) ? pending.get(key).onsite : cell.onsite; input.setAttribute('aria-label', row.username + ' 第 ' + (i + 1) + ' 场线下参赛');
        input.addEventListener('change', function () { if (input.checked === cell.onsite) pending.delete(key); else pending.set(key, { user_id: row.user_id, contest_id: cell.contest_id, onsite: input.checked }); pendingLabel(); }); td.append(input); tr.append(td);
      }); tbody.append(tr);
    }); empty(tbody, board.contests.length + 1, '请先添加成员和比赛。'); pendingLabel();
  }
  function render() {
    get('[data-weekly-title]').textContent = board.title;
    get('[data-weekly-summary]').textContent = board.member_count + ' 位成员 · ' + board.contests.length + ' 场比赛 · ' + board.finished_count + ' 场已结束 · 总分 = 60% G1 + 40% G2';
    get('[data-weekly-rules-policy]').textContent = 'N 按' + (board.rules.population === 'all' ? '总榜全部成员' : '总榜中该场至少通过一题的成员') + '计算；缺席' + (board.rules.count_absent ? '按 0 分计入 G2 场数。' : '不计入 G2 场数。');
    get('[data-weekly-updated]').textContent = board.calculated_at ? '最近完整计算：' + new Date(board.calculated_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '';
    var config = get('[data-weekly-config]'); if (config) { config.elements.title.value = board.title; config.elements.population.value = board.rules.population; config.elements.count_absent.value = String(board.rules.count_absent); }
    renderRank(); renderContests(); renderMembers(); renderAttendance();
  }
  async function load() {
    var sequence = ++loadSequence;
    try {
      var next = (await api.readResource(base)).data;
      if (sequence !== loadSequence || busy) return;
      if (board && board.revision === next.revision && board.calculated_at === next.calculated_at && board.can_manage === next.can_manage) return;
      board = next; render();
    } catch (e) { if (sequence === loadSequence && !busy) message(e.message, true); }
  }
  async function write(path, data, formData) {
    if (busy || !board) return;
    busy = true; ++loadSequence; root.setAttribute('aria-busy', 'true'); root.querySelectorAll('button,input,select').forEach(function (node) { node.disabled = true; }); message('正在保存并重新计算全部场次…');
    try {
      var token = window.__NWPUOJ_APP && window.__NWPUOJ_APP.csrfToken || '';
      var key = window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
      var result;
      if (formData) { formData.set('if_match', board.edit_etag); formData.set('_csrf', token); result = await api.request(base + path, { method: 'POST', headers: { 'If-Match': board.edit_etag, 'Idempotency-Key': key, 'X-CSRF-Token': token }, body: formData }); }
      else result = await api.writeResource(base + path, 'POST', Object.assign({ _csrf: token }, data), { etag: board.edit_etag, requireEtag: true, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-CSRF-Token': token } });
      board = result.data; if (path === '/attendance') pending.clear();
      if (data && data.remove) { selected.clear(); pending.clear(); }
      var op = board.operation || {}, detail = '已保存，全部场次和成员已重新计算。';
      if (op.added_count != null) detail += ' 新增 ' + op.added_count + ' 人，已在名单中 ' + op.existing_count + ' 人。';
      if (op.missing_student_ids && op.missing_student_ids.length) detail += ' 未匹配学号：' + op.missing_student_ids.join('、');
      message(detail); render();
    } catch (e) { message(e.message, true); }
    finally { busy = false; root.removeAttribute('aria-busy'); root.querySelectorAll('button,input,select').forEach(function (node) { node.disabled = false; }); if (board) { renderMembers(); renderAttendance(); renderRank(); } }
  }
  root.querySelectorAll('[data-weekly-picker]').forEach(function (picker) {
    var input = picker.querySelector('input'), results = picker.querySelector('.weekly-search-results'), timer, sequence = 0;
    input.addEventListener('input', function () {
      clearTimeout(timer); var request = ++sequence; results.hidden = true;
      if (!input.value.trim()) return;
      timer = setTimeout(async function () { try {
        var response = await api.readResource(base + '/search/' + picker.dataset.weeklyPicker + '?q=' + encodeURIComponent(input.value.trim()));
        if (request !== sequence) return; results.replaceChildren();
        response.data.forEach(function (item) {
          var label = picker.dataset.weeklyPicker === 'contests' ? '#' + item.id + ' · ' + item.title : picker.dataset.weeklyPicker === 'classes' ? item.name + ' · ' + item.member_count + ' 人' : item.username + ' · UID ' + item.id + (item.real_name ? ' · ' + item.real_name : '') + (item.student_id ? ' · ' + item.student_id : '');
          results.append(button(label, function () { results.hidden = true; input.value = ''; var kind = picker.dataset.weeklyPicker; if (kind === 'contests') write('/contests', { contest_ids: [item.id] }); else if (kind === 'classes') write('/members/import-class', { class_ids: [item.id] }); else write('/members', { user_ids: [item.id] }); }));
        }); if (!response.data.length) results.append(element('p', '没有找到匹配项。')); results.hidden = false;
      } catch (e) { message(e.message, true); } }, 250);
    });
    input.addEventListener('keydown', function (e) { if (e.key === 'Escape') results.hidden = true; if (e.key === 'ArrowDown') { var first = results.querySelector('button'); if (first) first.focus(); } });
  });
  document.addEventListener('click', function (event) { root.querySelectorAll('[data-weekly-picker]').forEach(function (picker) { if (!picker.contains(event.target)) picker.querySelector('.weekly-search-results').hidden = true; }); });
  root.querySelectorAll('[data-weekly-tab]').forEach(function (tab) { tab.addEventListener('click', function () { root.querySelectorAll('[data-weekly-tab]').forEach(function (node) { node.classList.toggle('is-active', node === tab); node.setAttribute('aria-selected', String(node === tab)); }); root.querySelectorAll('[data-weekly-panel]').forEach(function (panel) { panel.hidden = panel.dataset.weeklyPanel !== tab.dataset.weeklyTab; }); }); });
  ['rank', 'member', 'attendance'].forEach(function (kind) { var input = get('[data-weekly-' + kind + '-filter]'); if (input) input.addEventListener('input', function () { var k = kind === 'member' ? 'members' : kind; page[k] = 1; ({ rank: renderRank, members: renderMembers, attendance: renderAttendance })[k](); }); });
  var identity = get('[data-weekly-identities]'); if (identity) identity.addEventListener('change', renderRank);
  var config = get('[data-weekly-config]'); if (config) config.addEventListener('submit', function (event) { event.preventDefault(); write('/config', { title: config.elements.title.value, rules: { population: config.elements.population.value, count_absent: config.elements.count_absent.value === 'true' } }); });
  var csv = get('[data-weekly-csv]'); if (csv) { csv.addEventListener('submit', function (event) { event.preventDefault(); write('/members/import-csv', null, new FormData(csv)); }); csv.querySelector('input').addEventListener('change', function (event) { get('[data-weekly-filename]').textContent = event.target.files[0] ? event.target.files[0].name : '尚未选择文件'; }); }
  var all = get('[data-weekly-select-all]'); if (all) all.addEventListener('change', function () { get('[data-weekly-members]').querySelectorAll('[data-member-id]').forEach(function (input) { if (all.checked) selected.add(Number(input.dataset.memberId)); else selected.delete(Number(input.dataset.memberId)); }); renderMembers(); });
  var remove = get('[data-weekly-remove-members]'); if (remove) remove.addEventListener('click', async function () { if (await confirmRemoval('移除选中的 ' + selected.size + ' 名成员及其线下登记，并重新计算全体成员成绩？原账户不受影响。')) write('/members', { user_ids: Array.from(selected), remove: true }); });
  var save = get('[data-weekly-save-attendance]'); if (save) save.addEventListener('click', function () { write('/attendance', { changes: Array.from(pending.values()) }); });
  var recalc = get('[data-weekly-recalculate]'); if (recalc) recalc.addEventListener('click', function () { write('/recalculate', {}); });
  window.addEventListener('beforeunload', function (event) { if (pending.size) { event.preventDefault(); event.returnValue = ''; } });
  load();
  if (root.dataset.mode === 'ranklist') setInterval(function () { if (!document.hidden && !busy) load(); }, 30000);
})();
