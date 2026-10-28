(function () {
  'use strict';
  var root = document.querySelector('[data-contest-plagiarism]');
  if (!root) return;
  var tabs = root.querySelector('.app-contest-admin-tabs'), currentTab = tabs.querySelector('.is-active');
  if (tabs.scrollWidth > tabs.clientWidth) tabs.scrollLeft = currentTab.offsetLeft - tabs.offsetLeft;
  var contestId = root.dataset.contestPlagiarism;
  var endpoint = '/api/v2/contests/' + contestId + '/plagiarism';
  var find = function (name) { return document.querySelector('[data-plagiarism-' + name + ']'); };
  var states = { queued: ['排队中', 'pending'], running: ['查重中', 'running'], completed: ['已完成', 'accepted'], partial: ['部分完成', 'pending'], failed: ['失败', 'rejected'], skipped: ['已跳过', 'muted'] };
  var jobs = [], selected = '', page = 1, pageCount = 1, nextBefore = null, active = false, starting = false, timer, detailSequence = 0;
  var token = null;
  var requestedJob = new URLSearchParams(window.location.search).get('job');
  var dialog = document.getElementById('plagiarism-comparison'), matches = [], matchIndex = 0, compareSequence = 0;
  function node(tag, text, className) { var el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; }
  function link(text, href) { var el = node('a', text); el.href = href; return el; }
  function date(value) { return new Date(value * 1000).toLocaleString('zh-CN', { hour12: false }); }
  function percentage(value) { return (value * 100).toFixed(1) + '%'; }
  function showError(error) { find('error').hidden = false; find('error').textContent = error.message || '请求失败，请重试。'; }
  async function request(url, options) {
    var response = await fetch(url, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options));
    var body;
    try { body = await response.json(); } catch (_) { throw new Error('无法读取服务器响应，请稍后重试。'); }
    if (!response.ok) { var error = new Error(body.error && body.error.message || '请求失败。'); error.status = response.status; throw error; }
    return body.data;
  }
  function updateStart() {
    find('start').disabled = starting || active || root.dataset.canStart !== '1';
    find('start').querySelector('span').textContent = starting ? '正在创建…' : active ? '查重进行中' : '一键查重';
  }
  function renderJobs() {
    var select = find('jobs'); select.replaceChildren();
    jobs.forEach(function (job) { var option = node('option', '#' + job.id + ' · ' + date(job.created_at) + ' · ' + (states[job.state] || [job.state])[0]); option.value = String(job.id); select.append(option); });
    if (!jobs.length) select.append(node('option', '暂无查重记录'));
    select.value = selected;
    active = jobs.some(function (job) { return job.state === 'queued' || job.state === 'running'; });
    find('empty').hidden = !!jobs.length;
    find('history-more').hidden = !nextBefore;
    updateStart();
  }
  function schedule() {
    clearTimeout(timer);
    if (active && !document.hidden) timer = setTimeout(function () { refresh().catch(showError); }, 3500);
  }
  async function refresh(older) {
    var data = await request(endpoint + (older ? '?before_id=' + nextBefore : ''));
    if (older) { jobs = jobs.concat(data.items); nextBefore = data.next_before_id; }
    else {
      var ids = new Set(data.items.map(function (job) { return job.id; }));
      jobs = data.items.concat(jobs.filter(function (job) { return !ids.has(job.id); }));
      if (jobs.length <= 20) nextBefore = data.next_before_id;
    }
    if (!selected) selected = jobs.length ? String(jobs[0].id) : '';
    if (requestedJob) {
      if (!jobs.some(function (job) { return String(job.id) === requestedJob; })) {
        var old = await request(endpoint + '/' + encodeURIComponent(requestedJob)); jobs.push(old);
      }
      selected = requestedJob; requestedJob = null;
    }
    renderJobs();
    if (selected) await loadDetail();
    schedule();
  }
  async function loadDetail() {
    var sequence = ++detailSequence;
    var query = new URLSearchParams({ page: String(page), minimum: find('minimum').value, group: find('group').value });
    var job = await request(endpoint + '/' + encodeURIComponent(selected) + '?' + query);
    if (sequence !== detailSequence) return;
    find('error').hidden = true;
    var summary = job.summary || {}, state = states[job.state] || [job.state, 'muted'];
    find('result').hidden = false;
    find('state').textContent = state[0]; find('state').className = 'app-status app-status-' + state[1];
    find('progress').textContent = job.state === 'queued' ? '任务已进入后台队列，可以离开此页，结果会自动保存。' : job.state === 'running' ? '已完成 ' + (summary.done || 0) + ' / ' + (summary.group_count || 0) + ' 个分组' + (summary.current ? ' · ' + summary.current : '') : summary.message || '完成 ' + (summary.done || 0) + ' 个分组，共 ' + (summary.pair_count || 0) + ' 对相似代码。';
    find('summary').textContent = 'JPlag ' + (summary.engine || '6.3.0') + ' · 赛时提交 ' + (summary.total || 0) + ' 次 · 选取 ' + (summary.selected || 0) + ' 份代码 · 不支持 ' + (summary.unsupported || 0) + ' 次 · 空代码 ' + (summary.empty || 0) + ' 次' + (job.finished_at ? ' · 完成于 ' + date(job.finished_at) : '');
    renderGroups(summary.groups || [], job.id);
    var tbody = find('pairs'); tbody.replaceChildren();
    (job.pairs || []).forEach(function (pair) {
      var tr = node('tr');
      tr.append(node('td', '#' + pair.problem_id + ' ' + pair.title), node('td', pair.language_label));
      ['first', 'second'].forEach(function (side) {
        var td = node('td'); td.append(link(pair[side + '_username'], '/user/' + pair[side + '_user_id']), node('br'), link('#' + pair[side + '_id'], '/contest/submission/' + pair[side + '_id'])); tr.append(td);
      });
      tr.append(node('td', percentage(pair.similarity), 'app-cell-number'));
      var button = node('button', '查看比对', 'app-button app-button-secondary'); button.type = 'button';
      button.addEventListener('click', function () { showComparison(job.id, pair.key); });
      var action = node('td'); action.append(button); tr.append(action); tbody.append(tr);
    });
    if (!job.pairs.length) { var tr = node('tr'), td = node('td', ['queued', 'running'].includes(job.state) ? '查重完成后显示比较结果。' : job.state === 'failed' ? '任务未能完成，请展开分组结果查看原因后重试。' : '当前筛选下没有可显示的比较，请同时检查分组结果及解析失败情况。'); td.colSpan = 6; tr.append(td); tbody.append(tr); }
    pageCount = job.page_count; find('page').textContent = '第 ' + page + ' / ' + pageCount + ' 页 · 共 ' + job.total + ' 对';
    find('prev').disabled = page <= 1; find('next').disabled = page >= pageCount;
  }
  function renderGroups(groups, jobId) {
    var tbody = find('groups'); tbody.replaceChildren();
    var selectedGroup = find('group').value;
    find('group').replaceChildren(node('option', '全部分组')); find('group').firstChild.value = '';
    groups.forEach(function (group) {
      var label = '#' + group.problem_id + ' ' + group.title + ' · ' + group.language_label;
      var option = node('option', label); option.value = group.key; find('group').append(option);
      var tr = node('tr'), result = node('td', (states[group.state] || [group.state])[0] + (group.message ? ' · ' + group.message : ''));
      if (group.failed && group.failed.length) result.append(node('small', group.failed.map(function (item) { return String(item.username || item.submissionName || item.name || '') + (item.submission_id ? ' #' + item.submission_id : '') + ' ' + String(item.state || ''); }).join('；'), 'app-row-description'));
      tr.append(node('td', label), node('td', group.count), result);
      var td = node('td');
      if (group.report) {
        var reportUrl = '/contest/' + contestId + '/plagiarism/' + jobId + '/report/' + encodeURIComponent(group.key);
        var actions = node('div', null, 'app-inline-actions');
        actions.append(link('下载网页报告', reportUrl + '?format=html'), link('原始 .jplag', reportUrl));
        td.append(actions);
      } else td.textContent = '—';
      tr.append(td); tbody.append(tr);
    });
    find('group').value = selectedGroup;
    if (find('group').selectedIndex < 0) find('group').value = '';
  }
  function renderCode(target, source, side) {
    target.replaceChildren();
    source.split('\n').forEach(function (text, index) {
      var line = node('span', null, 'app-plagiarism-line'); line.dataset.line = index + 1;
      line.append(node('span', index + 1, 'app-plagiarism-line-number'), node('span', text || ' '));
      if (matches.some(function (match) { return index + 1 >= match['startIn' + side].line && index + 1 <= match['endIn' + side].line; })) line.classList.add('is-match');
      target.append(line);
    });
  }
  function focusMatch(delta) {
    if (!matches.length) { find('match-label').textContent = '没有相似片段'; return; }
    matchIndex = (matchIndex + delta + matches.length) % matches.length;
    find('match-label').textContent = '相似片段 ' + (matchIndex + 1) + ' / ' + matches.length;
    ['First', 'Second'].forEach(function (side) {
      var code = find(side.toLowerCase() + '-code'), start = matches[matchIndex]['startIn' + side].line, end = matches[matchIndex]['endIn' + side].line;
      code.querySelectorAll('[data-line]').forEach(function (line) { line.classList.toggle('is-current', Number(line.dataset.line) >= start && Number(line.dataset.line) <= end); });
      var line = code.querySelector('[data-line="' + Number(start) + '"]'); if (line) code.scrollTop = Math.max(0, line.offsetTop - 40);
    });
  }
  async function showComparison(jobId, key) {
    var sequence = ++compareSequence;
    matches = []; matchIndex = 0;
    find('comparison-status').textContent = '正在加载代码比对…';
    ['first', 'second'].forEach(function (side) { find(side + '-code').replaceChildren(); find(side + '-title').textContent = ''; });
    find('match-label').textContent = ''; dialog.showModal();
    try {
      var result = await request(endpoint + '/' + jobId + '/comparison?key=' + encodeURIComponent(key));
      if (!dialog.open || sequence !== compareSequence) return;
      matches = result.matches;
      find('comparison-status').textContent = '平均相似度 ' + percentage(result.similarity) + '，高亮区域为 JPlag 匹配的代码片段。';
      ['first', 'second'].forEach(function (side) {
        var row = result[side]; find(side + '-title').replaceChildren(link(row.username + ' · #' + row.id, '/contest/submission/' + row.id));
        renderCode(find(side + '-code'), row.code, side === 'first' ? 'First' : 'Second');
      });
      focusMatch(0);
    } catch (error) { if (sequence === compareSequence) find('comparison-status').textContent = error.message; }
  }
  find('start').addEventListener('click', async function () {
    if (starting || active) return;
    starting = true; updateStart();
    if (!token) token = 'plagiarism-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    try {
      var job = await request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': token }, body: JSON.stringify({ request_token: token }) });
      selected = String(job.id); page = 1; token = null; find('group').value = '';
      window.history.replaceState(null, '', '?job=' + selected);
      await refresh();
    } catch (error) { if (error.status) token = null; showError(error); }
    finally { starting = false; updateStart(); }
  });
  find('jobs').addEventListener('change', function () { selected = this.value; page = 1; find('group').value = ''; window.history.replaceState(null, '', '?job=' + selected); loadDetail().catch(showError); });
  find('history-more').addEventListener('click', function () { refresh(true).catch(showError); });
  find('refresh').addEventListener('click', function () { refresh().catch(showError); });
  find('filter').addEventListener('submit', function (event) { event.preventDefault(); page = 1; loadDetail().catch(showError); });
  find('prev').addEventListener('click', function () { if (page > 1) { page--; loadDetail().catch(showError); } });
  find('next').addEventListener('click', function () { if (page < pageCount) { page++; loadDetail().catch(showError); } });
  find('match-prev').addEventListener('click', function () { focusMatch(-1); });
  find('match-next').addEventListener('click', function () { focusMatch(1); });
  dialog.addEventListener('close', function () { compareSequence++; });
  document.addEventListener('visibilitychange', function () { if (document.hidden) clearTimeout(timer); else refresh().catch(showError); });
  refresh().catch(showError);
})();
