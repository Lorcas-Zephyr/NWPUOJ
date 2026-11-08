(function () {
  'use strict';
  document.querySelectorAll('[data-login-ip]').forEach(function (root) {
    var weekly = root.dataset.weekly === 'true', form = root.querySelector('form'), rows = root.querySelector('[data-login-ip-rows]');
    var status = root.querySelector('[data-login-ip-status]'), previous = root.querySelector('[data-login-ip-prev]'), next = root.querySelector('[data-login-ip-next]');
    var page = 1, pages = 1, sequence = 0, timer, loaded = false;
    function node(tag, text, className) { var element = document.createElement(tag); if (text != null) element.textContent = text; if (className) element.className = className; return element; }
    function time(value) { return new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' '); }
    function link(text, href) { var a = node('a', text); a.href = href; return a; }
    function empty(text) { rows.replaceChildren(); var tr = node('tr'), td = node('td', text, 'login-ip-empty'); td.colSpan = weekly ? 6 : 3; tr.append(td); rows.append(tr); }
    function visible() { return !root.closest('[hidden]') && !document.hidden; }
    async function load() {
      var request = ++sequence, params = new URLSearchParams(new FormData(form)); params.set('page', page);
      previous.disabled = next.disabled = true; root.setAttribute('aria-busy', 'true'); status.classList.remove('is-error'); status.textContent = '正在读取登录记录…';
      try {
        var data = (await window.NWPUOJApi.readResource(root.dataset.endpoint + '?' + params)).data;
        if (request !== sequence) return;
        page = data.page; pages = data.page_count; rows.replaceChildren();
        if (weekly) {
          var select = form.elements.contest_id, selected = select.value;
          select.replaceChildren(new Option('全部计分比赛', ''));
          (data.contests || []).forEach(function (contest) { select.append(new Option('#' + contest.id + ' · ' + contest.title, contest.id)); });
          select.value = selected; if (select.selectedIndex < 0) select.value = '';
        }
        data.rows.forEach(function (record) {
          var tr = node('tr'), user = node('td'); user.append(link(record.username, '/user/' + record.user_id), node('small', 'UID ' + record.user_id));
          tr.append(user, node('td', record.ip_address), node('td', time(record.logged_in_at)));
          if (weekly) {
            var contest = node('td'), a = link('#' + record.contest_id + ' · ' + record.contest_title, '/contest/' + record.contest_id); a.className = 'login-ip-contest'; a.title = record.contest_title; contest.append(a);
            var end = node('td', time(record.contest_start * 1000)); end.append(node('small', time(record.last_submission * 1000)));
            var state = node('td'), onsite = !!Number(record.onsite), automatic = !onsite && !!Number(record.auto_online);
            state.append(node('span', onsite ? '线下' : automatic ? '已自动转线上' : '线上', 'app-status ' + (onsite ? 'app-status-success' : automatic ? 'app-status-pending' : 'app-status-muted')));
            tr.append(contest, end, state);
          }
          rows.append(tr);
        });
        if (!data.rows.length) empty(weekly ? '暂无符合条件的自动转线上记录。' : '没有匹配的登录记录，请调整用户名或时间范围。');
        status.textContent = '共 ' + data.total + (weekly ? ' 条相关登录记录 · 仅自动转线上 · 北京时间' : ' 条成功登录记录 · 北京时间');
        root.querySelector('[data-login-ip-page]').textContent = '第 ' + page + ' / ' + pages + ' 页 · 每页 50 条';
        if (window.NWPUOJApp && window.NWPUOJApp.refreshUsernameTiers) window.NWPUOJApp.refreshUsernameTiers(rows);
        loaded = true;
        if (weekly) window.dispatchEvent(new CustomEvent('weekly-ip-updated'));
      } catch (error) {
        if (request !== sequence) return;
        status.textContent = error.message || '暂时无法读取登录记录。'; status.classList.add('is-error'); empty('无法读取登录记录。');
        root.querySelector('[data-login-ip-page]').textContent = ''; pages = 1; page = 1;
      } finally {
        if (request === sequence) { root.removeAttribute('aria-busy'); previous.disabled = page <= 1; next.disabled = page >= pages; }
      }
    }
    function search() { clearTimeout(timer); timer = null; page = 1; load(); }
    form.addEventListener('submit', function (event) { event.preventDefault(); search(); });
    form.elements.q.addEventListener('input', function () { clearTimeout(timer); ++sequence; timer = setTimeout(search, 300); });
    form.addEventListener('reset', function () { setTimeout(function () { form.querySelectorAll('[data-app-datetime-picker]').forEach(function (input) { if (input._flatpickr) input._flatpickr.clear(); }); search(); }, 0); });
    if (weekly) {
      form.elements.contest_id.addEventListener('change', search);
      window.addEventListener('weekly-ip-show', function () { load(); });
    }
    previous.addEventListener('click', function () { if (page > 1) { page--; load(); } });
    next.addEventListener('click', function () { if (page < pages) { page++; load(); } });
    if (!weekly) { form.elements.q.value = new URLSearchParams(location.search).get('q') || ''; load(); }
    else if (visible()) load();
    setInterval(function () { if (loaded && visible() && !root.hasAttribute('aria-busy') && !timer) load(); }, 30000);
  });
})();
