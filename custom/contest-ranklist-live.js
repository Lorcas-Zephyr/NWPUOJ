(function () {
  'use strict';
  var root = document.querySelector('[data-contest-rank-live]');
  if (!root) return;
  var revision = '';
  var busy = false;
  var stopped = false;
  var timer;
  var pendingToolbar;
  var message = root.querySelector('[data-rank-refresh-status]');
  var endpoint = '/api/v2/contests/' + root.dataset.contestId + '/ranklist-view';

  function replaceContent(current, next) {
    if (current && next && current.innerHTML !== next.innerHTML) current.replaceChildren.apply(current, Array.from(next.childNodes));
  }
  function patchToolbar() {
    var toolbar = root.querySelector('[data-rank-toolbar]');
    if (!pendingToolbar || !toolbar || toolbar.querySelector('details[open]') || toolbar.contains(document.activeElement)) return;
    replaceContent(toolbar, pendingToolbar);
    pendingToolbar = null;
    var live = toolbar.querySelector('[data-rank-live-toggle]');
    var form = toolbar.querySelector('.app-rank-class-filter-menu');
    if (live && live.checked && form && !form.querySelector('[name="view"]')) {
      var field = document.createElement('input');
      field.type = 'hidden'; field.name = 'view'; field.value = 'live'; form.appendChild(field);
    }
    if (window.__NWPUOJ_RENDER_ICONS) window.__NWPUOJ_RENDER_ICONS(toolbar);
  }
  function patchBoard(current, next) {
    var table = current.querySelector('table');
    var nextTable = next.querySelector('table');
    if (!table || !nextTable) { replaceContent(current, next); return; }
    replaceContent(table.tHead, nextTable.tHead);
    var tbody = table.tBodies[0];
    var oldRows = new Map(Array.from(tbody.rows).map(function (row) { return [row.dataset.rankUserId, row]; }));
    Array.from(nextTable.tBodies[0].rows).forEach(function (incoming, index) {
      var row = oldRows.get(incoming.dataset.rankUserId);
      if (row) {
        oldRows.delete(incoming.dataset.rankUserId);
        row.className = incoming.className;
        if (row.cells.length !== incoming.cells.length) replaceContent(row, incoming);
        else Array.from(incoming.cells).forEach(function (cell, column) {
          var oldCell = row.cells[column];
          oldCell.className = cell.className;
          replaceContent(oldCell, cell);
        });
      } else row = incoming;
      if (tbody.rows[index] !== row) tbody.insertBefore(row, tbody.rows[index] || null);
    });
    oldRows.forEach(function (row) { row.remove(); });
    replaceContent(current.querySelector('[data-rank-pagination]'), next.querySelector('[data-rank-pagination]'));
  }
  function apply(data) {
    if (data.clock) window.dispatchEvent(new CustomEvent('contest-clock-sync', { detail: data.clock }));
    if (data.unchanged || !data.html) return;
    var template = document.createElement('template');
    template.innerHTML = data.html;
    var next = template.content.querySelector('[data-contest-rank-live]');
    if (!next) throw new Error('Invalid standings response');
    var title = document.querySelector('.app-contest-context h1');
    if (title && data.title) title.textContent = data.title;
    var x = window.scrollX, y = window.scrollY;
    var scrollRegion = root.querySelector('.app-table-region');
    var left = scrollRegion ? scrollRegion.scrollLeft : 0;
    ['summary', 'freeze', 'rating'].forEach(function (name) {
      replaceContent(root.querySelector('[data-rank-region="' + name + '"]'), next.querySelector('[data-rank-region="' + name + '"]'));
    });
    patchBoard(root.querySelector('[data-rank-region="board"]'), next.querySelector('[data-rank-region="board"]'));
    pendingToolbar = next.querySelector('[data-rank-toolbar]');
    if (!data.can_manage) {
      var management = root.querySelector('.app-toolbar-actions');
      if (management) management.remove();
    }
    patchToolbar();
    scrollRegion = root.querySelector('.app-table-region');
    if (scrollRegion) scrollRegion.scrollLeft = left;
    if (window.__NWPUOJ_RENDER_ICONS) window.__NWPUOJ_RENDER_ICONS(root);
    window.scrollTo(x, y);
  }
  async function refresh() {
    if (busy || stopped || document.hidden) return;
    window.clearTimeout(timer);
    busy = true;
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, 15000);
    var delay = 15000;
    try {
      var query = new URLSearchParams(window.location.search);
      if (revision) query.set('revision', revision);
      var response = await fetch(endpoint + '?' + query.toString(), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if ([401, 403, 404].indexOf(response.status) !== -1) {
        stopped = true;
        pendingToolbar = null;
        // Remove previously visible private results when access is revoked.
        root.querySelector('[data-rank-region="board"]').replaceChildren();
        var toolbar = root.querySelector('[data-rank-toolbar]');
        if (toolbar) toolbar.replaceChildren();
        throw new Error('访问权限已变化，请刷新页面确认。');
      }
      var result = await response.json();
      if (!response.ok || result.error) throw new Error('排行榜更新暂时失败，正在自动重试。');
      apply(result.data);
      revision = result.data.revision;
      delay = result.data.next_update_ms || delay;
      message.hidden = true;
    } catch (error) {
      message.textContent = stopped ? error.message : '排行榜更新暂时失败，正在自动重试；现有成绩已保留。';
      message.hidden = false;
      delay = 30000;
    } finally {
      busy = false;
      window.clearTimeout(timeout);
      if (!stopped) timer = window.setTimeout(refresh, delay + Math.random() * Math.min(1500, delay / 10));
    }
  }
  root.addEventListener('toggle', patchToolbar, true);
  root.addEventListener('focusout', function () { window.setTimeout(patchToolbar, 0); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) window.clearTimeout(timer);
    else refresh();
  });
  window.addEventListener('online', refresh);
  window.addEventListener('pageshow', function (event) { if (event.persisted) refresh(); });
  window.addEventListener('pagehide', function () { window.clearTimeout(timer); });
  var firstDelay = Number(root.dataset.rankRefreshMs) || 15000;
  timer = window.setTimeout(refresh, firstDelay + Math.random() * Math.min(1000, firstDelay / 10));
})();
