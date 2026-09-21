(function () {
  'use strict';
  if (window.__nwpuojContestNotices) return;
  window.__nwpuojContestNotices = true;

  function key() {
    return window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID()
      : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
  function timestamp(seconds) {
    return new Date(Number(seconds) * 1000).toLocaleString('zh-CN', { hour12: false });
  }
  function status(element, message) {
    element.textContent = message || '';
    element.hidden = !message;
  }
  async function request(url, body) {
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, 15000);
    var options = { credentials: 'same-origin', cache: 'no-store', signal: controller.signal };
    if (body) {
      var csrf = document.querySelector('meta[name="csrf-token"]');
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/json', 'Idempotency-Key': key() };
      options.body = JSON.stringify(Object.assign({}, body, { _csrf: csrf ? csrf.content : '' }));
    }
    try {
      var response = await window.fetch(url, options);
      var result = await response.json();
      if (!response.ok || result.error) {
        var error = new Error(result.error && result.error.message || '请求失败，请稍后重试。');
        error.status = response.status;
        throw error;
      }
      return result.data;
    } finally { window.clearTimeout(timeout); }
  }

  var historyRoot = document.querySelector('[data-contest-notice-history]');
  var refreshHistory = function () {};
  if (historyRoot) {
    var historyUrl = '/api/v2/contests/' + historyRoot.dataset.contestId + '/notices';
    var historyRows = historyRoot.querySelector('[data-notice-history-rows]');
    var historyStatus = historyRoot.querySelector('[data-notice-history-status]');
    var region = historyRoot.querySelector('[data-notice-table-region]');
    var moreButton = historyRoot.querySelector('[data-notice-history-more]');
    var refreshButton = historyRoot.querySelector('[data-notice-history-refresh]');
    var records = new Map();
    var beforeId = null;
    var historyLoaded = false;
    var historyBusy = false;

    async function loadHistory(older) {
      if (historyBusy || (older && !beforeId)) return;
      historyBusy = true;
      moreButton.disabled = refreshButton.disabled = true;
      try {
        var result = await request(historyUrl + (older ? '?before_id=' + beforeId : ''));
        // If more than one page arrived while offline, restart the history
        // window so its older-page cursor cannot leave a gap in the middle.
        if (!older && records.size && result.items.length === 50 && !result.items.some(function (notice) { return records.has(notice.id); })) {
          records.clear();
          historyLoaded = false;
        }
        if (!historyLoaded || older) beforeId = result.next_before_id;
        historyLoaded = true;
        var changed = false;
        result.items.forEach(function (notice) {
          if (!records.has(notice.id)) { records.set(notice.id, notice); changed = true; }
        });
        // Leave existing rows and focus untouched on unchanged polling responses.
        if (changed) {
          var fragment = document.createDocumentFragment();
          Array.from(records.values()).sort(function (a, b) { return b.id - a.id; }).forEach(function (notice) {
            var row = document.createElement('tr');
            var time = document.createElement('td');
            var content = document.createElement('td');
            time.textContent = timestamp(notice.published_at);
            content.textContent = notice.content;
            row.appendChild(time);
            row.appendChild(content);
            fragment.appendChild(row);
          });
          historyRows.replaceChildren(fragment);
        }
        region.hidden = !records.size;
        moreButton.hidden = !beforeId;
        status(historyStatus, records.size ? '' : '暂无比赛通知');
      } catch (error) {
        status(historyStatus, '通知加载失败，请点击“刷新通知”重试。');
      } finally {
        historyBusy = false;
        moreButton.disabled = refreshButton.disabled = false;
      }
    }
    refreshHistory = function () { return loadHistory(false); };
    refreshButton.addEventListener('click', refreshHistory);
    moreButton.addEventListener('click', function () { loadHistory(true); });
    refreshHistory();
    window.setInterval(function () { if (!document.hidden) refreshHistory(); }, 15000);
  }

  var form = document.querySelector('[data-contest-notice-publish]');
  if (form) {
    var publishUrl = '/api/v2/contests/' + form.dataset.contestId + '/notices';
    var textarea = form.elements.content;
    var publishButton = form.querySelector('[type="submit"]');
    var publishLabel = form.querySelector('[data-notice-publish-label]');
    var publishStatus = form.querySelector('[data-notice-publish-status]');
    var draftKey = 'contest-notice-pending:' + form.dataset.contestId;
    var pending = null;
    var publishing = false;
    try {
      pending = JSON.parse(window.sessionStorage.getItem(draftKey));
      if (pending && typeof pending.content === 'string') {
        textarea.value = pending.content;
        status(publishStatus, '上次发布结果尚未确认。重试会核对发布标识，不会重复发布。');
      }
    } catch (_) { pending = null; }
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (publishing || !form.reportValidity()) return;
      var content = textarea.value.trim();
      if (!content) { status(publishStatus, '请输入通知内容。'); textarea.focus(); return; }
      if (!window.confirm('确认向本场比赛发布这条通知？发布后将保留在比赛通知历史中。')) return;
      if (!pending || pending.content !== content) pending = { content: content, publish_token: key() };
      try { window.sessionStorage.setItem(draftKey, JSON.stringify(pending)); } catch (_) {}
      publishing = true;
      publishButton.disabled = textarea.readOnly = true;
      publishLabel.textContent = '正在发布…';
      status(publishStatus, '');
      try {
        await request(publishUrl, pending);
        pending = null;
        try { window.sessionStorage.removeItem(draftKey); } catch (_) {}
        textarea.value = '';
        status(publishStatus, '通知已发布。参赛者会在赛时收到提醒。');
        refreshHistory();
      } catch (error) {
        status(publishStatus, error.status && error.status < 500 ? error.message
          : '未能确认发布结果，请重试；同一条通知不会重复发布。');
      } finally {
        publishing = false;
        publishButton.disabled = textarea.readOnly = false;
        publishLabel.textContent = '发布通知';
      }
    });
  }

  var notifier = document.querySelector('[data-contest-notifier]');
  if (!notifier) return;
  var url = '/api/v2/contests/' + notifier.dataset.contestId + '/notices';
  var readKey = 'contest-notice-read:' + notifier.dataset.userId + ':' + notifier.dataset.contestId;
  var dialog = notifier.querySelector('dialog');
  var ackButton = notifier.querySelector('[data-notice-ack]');
  var readStatus = notifier.querySelector('[data-notice-read-status]');
  var current = null;
  var readThrough = 0;
  var polling = false;
  var acknowledging = false;
  var stopped = false;
  var timer;

  function closeNotice() {
    current = null;
    dialog.close();
    document.body.classList.toggle('is-dialog-open', !!document.querySelector('dialog.app-dialog[open]'));
  }
  function showNotice(notice) {
    if (document.hidden || document.querySelector('dialog[open]')) return;
    current = notice;
    notifier.querySelector('[data-notice-content]').textContent = notice.content;
    notifier.querySelector('[data-notice-published-at]').textContent = timestamp(notice.published_at);
    status(readStatus, '');
    dialog.__appOpener = document.activeElement;
    dialog.showModal();
    document.body.classList.add('is-dialog-open');
    ackButton.focus();
  }
  async function poll() {
    if (polling || stopped || document.hidden) return;
    window.clearTimeout(timer);
    polling = true;
    try {
      var data = await request(url + '/unread');
      readThrough = Math.max(readThrough, Number(data.read_through) || 0);
      stopped = !data.eligible || data.server_time >= data.end_time;
      if (current && (!data.active || readThrough >= current.id)) closeNotice();
      var nextNotice = data.items.find(function (notice) { return notice.id > readThrough; });
      if (data.active && !current && nextNotice) showNotice(nextNotice);
    } catch (error) {
      if ([401, 403, 404].indexOf(error.status) !== -1) { stopped = true; if (current) closeNotice(); }
      // Network failures must not discard an unread notice or the active dialog.
    } finally {
      polling = false;
      if (!stopped) timer = window.setTimeout(poll, 5000);
    }
  }
  dialog.addEventListener('cancel', function (event) { event.preventDefault(); });
  // The shared dialog handler closes on backdrop clicks. This dialog requires
  // explicit acknowledgement; neither Escape nor a backdrop click marks it read.
  dialog.addEventListener('click', function (event) {
    if (event.target === dialog) event.stopImmediatePropagation();
  }, true);
  ackButton.addEventListener('click', async function () {
    if (!current || acknowledging) return;
    var noticeId = current.id;
    acknowledging = ackButton.disabled = true;
    status(readStatus, '');
    try {
      await request(url + '/' + noticeId + '/read', {});
      readThrough = Math.max(readThrough, noticeId);
      try { window.localStorage.setItem(readKey, String(noticeId)); } catch (_) {}
      if (current && current.id === noticeId) closeNotice();
      poll();
    } catch (error) {
      status(readStatus, '已读状态保存失败，请点击“知道了”重试。');
    } finally { acknowledging = ackButton.disabled = false; }
  });
  window.addEventListener('storage', function (event) {
    if (event.key !== readKey) return;
    readThrough = Math.max(readThrough, Number(event.newValue) || 0);
    if (current && readThrough >= current.id) closeNotice();
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { poll(); refreshHistory(); } });
  window.addEventListener('online', function () { poll(); refreshHistory(); });
  window.addEventListener('pageshow', function (event) { if (event.persisted) poll(); });
  poll();
})();
