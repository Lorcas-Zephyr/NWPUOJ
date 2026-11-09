(function () {
  'use strict';

  var app = window.__NWPUOJ_APP || {};
  var root = document.documentElement;

  function refreshIcons(scope) {
    if (typeof window.__NWPUOJ_RENDER_ICONS === 'function') {
      window.__NWPUOJ_RENDER_ICONS(scope || document);
      refreshUsernameTiers(scope);
      return;
    }
    if (!window.lucide || typeof window.lucide.createIcons !== 'function') return;
    try {
      window.lucide.createIcons({
        icons: window.lucide.icons,
        root: scope || document,
        attrs: { 'aria-hidden': 'true', focusable: 'false' }
      });
    } catch (error) {
      window.lucide.createIcons({ icons: window.lucide.icons });
    }
    refreshUsernameTiers(scope);
  }

  function setTheme(theme) {
    var nextTheme = theme === 'dark' ? 'dark' : 'light';
    root.setAttribute('data-theme', nextTheme);
    try { localStorage.setItem('nwpuoj_theme', nextTheme); } catch (error) {}
    var themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.content = nextTheme === 'dark' ? '#090b0e' : '#111318';
  }

  function toggleTheme() {
    setTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  }

  function sameOrigin(url) {
    try { return new URL(url || window.location.href, window.location.href).origin === window.location.origin; }
    catch (error) { return false; }
  }

  function protectForm(form) {
    if (!form || !app.csrfToken || String(form.method || 'get').toLowerCase() === 'get' || !sameOrigin(form.action)) return;
    var input = form.querySelector('input[name="_csrf"]');
    if (!input) {
      input = document.createElement('input');
      input.type = 'hidden';
      input.name = '_csrf';
      form.appendChild(input);
    }
    input.value = app.csrfToken;
  }

  function postLink(link) {
    var message = link.getAttribute('data-confirm');
    if (message && !window.confirm(message)) return;
    var form = document.createElement('form');
    form.method = 'post';
    form.action = link.getAttribute('href-post');
    form.hidden = true;
    protectForm(form);
    document.body.appendChild(form);
    form.submit();
  }

  function showToast(message, type) {
    var region = document.querySelector('[data-toast-region]');
    if (!region || !message) return;
    var toast = document.createElement('div');
    toast.className = 'app-toast' + (type ? ' app-toast-' + type : '');
    toast.setAttribute('role', type === 'danger' ? 'alert' : 'status');
    var icon = document.createElement('i');
    icon.setAttribute('data-lucide', type === 'danger' ? 'circle-alert' : type === 'success' ? 'circle-check' : 'info');
    var text = document.createElement('span');
    text.textContent = message;
    toast.appendChild(icon);
    toast.appendChild(text);
    region.appendChild(toast);
    refreshIcons(toast);
    window.setTimeout(function () {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(6px)';
      window.setTimeout(function () { toast.remove(); }, 180);
    }, 3200);
  }

  function closeAccounts(except) {
    document.querySelectorAll('.app-account[open]').forEach(function (details) {
      if (details !== except) details.open = false;
    });
  }

  function setupSidebar() {
    var shell = document.querySelector('[data-app-shell]');
    var openButton = document.querySelector('[data-sidebar-open]');
    var closeButton = document.querySelector('[data-sidebar-close]');
    if (!shell || !openButton || !closeButton) return;

    function setOpen(open) {
      shell.classList.toggle('is-sidebar-open', open);
      document.body.classList.toggle('is-locked', open);
      closeButton.hidden = !open;
      openButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    openButton.addEventListener('click', function () { setOpen(true); });
    closeButton.addEventListener('click', function () { setOpen(false); });
    shell.querySelectorAll('.app-sidebar a').forEach(function (link) {
      link.addEventListener('click', function () { setOpen(false); });
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth > 860) setOpen(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') setOpen(false);
    });
  }

  function setupDialogs() {
    function syncDialogLock() {
      document.body.classList.toggle('is-dialog-open', !!document.querySelector('dialog.app-dialog[open]'));
    }

    function openDialog(dialog, opener) {
      if (!dialog || typeof dialog.showModal !== 'function' || dialog.open) return;
      dialog.__appOpener = opener || document.activeElement;
      dialog.showModal();
      syncDialogLock();
    }

    document.addEventListener('click', function (event) {
      var opener = event.target.closest('[data-dialog-open]');
      if (opener) {
        var dialog = document.getElementById(opener.getAttribute('data-dialog-open'));
        openDialog(dialog, opener);
        return;
      }
      var closer = event.target.closest('[data-dialog-close]');
      if (closer) {
        var parentDialog = closer.closest('dialog');
        if (parentDialog) parentDialog.close();
      }
    });
    document.querySelectorAll('dialog.app-dialog').forEach(function (dialog) {
      dialog.addEventListener('close', function () {
        syncDialogLock();
        var opener = dialog.__appOpener;
        dialog.__appOpener = null;
        if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
      });
      dialog.addEventListener('click', function (event) {
        if (event.target !== dialog) return;
        var box = dialog.getBoundingClientRect();
        var inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
        if (!inside) dialog.close();
      });
    });
  }

  function setupPageProgress() {
    var progress = document.querySelector('[data-page-progress]');
    var main = document.getElementById('app-main');
    if (!progress) return;
    progress.hidden = true;
    progress.setAttribute('aria-valuetext', '加载完成');
    if (main) main.setAttribute('aria-busy', 'false');
    window.addEventListener('beforeunload', function () {
      progress.hidden = false;
      progress.setAttribute('aria-valuetext', '正在加载');
    });
  }

  function setupAccessibleRegions() {
    document.querySelectorAll('.app-table-region').forEach(function (region, index) {
      if (!region.hasAttribute('role')) region.setAttribute('role', 'region');
      if (!region.hasAttribute('tabindex')) region.setAttribute('tabindex', '0');
      if (!region.hasAttribute('aria-label') && !region.hasAttribute('aria-labelledby')) {
        var section = region.closest('section, .app-page, .app-admin-page');
        var heading = section && section.querySelector('h1, h2, h3, .app-section-title');
        region.setAttribute('aria-label', heading ? heading.textContent.trim() + '数据表' : '数据表 ' + (index + 1));
      }
    });

    document.querySelectorAll('dialog.app-dialog').forEach(function (dialog, index) {
      dialog.setAttribute('aria-modal', 'true');
      if (dialog.hasAttribute('aria-label') || dialog.hasAttribute('aria-labelledby')) return;
      var heading = dialog.querySelector('h1, h2, h3');
      if (!heading) {
        dialog.setAttribute('aria-label', '操作面板');
        return;
      }
      if (!heading.id) heading.id = 'app-dialog-title-' + (index + 1);
      dialog.setAttribute('aria-labelledby', heading.id);
    });

    document.querySelectorAll('.app-icon-button').forEach(function (button) {
      if (button.hasAttribute('aria-label')) return;
      var title = String(button.getAttribute('title') || '').trim();
      if (title) button.setAttribute('aria-label', title);
    });
  }

  function setupConnectivityState() {
    var state = document.querySelector('[data-connectivity-state]');
    if (!state) return;
    var message = state.querySelector('[data-connectivity-message]');
    var retry = state.querySelector('[data-connectivity-retry]');
    var offlineIcon = state.querySelector('.app-connectivity-icon-offline');
    var restoredIcon = state.querySelector('.app-connectivity-icon-restored');
    var hideTimer = null;

    function render(mode) {
      if (hideTimer) window.clearTimeout(hideTimer);
      state.classList.toggle('is-restored', mode === 'restored');
      state.hidden = false;
      if (mode === 'restored') {
        message.textContent = '网络连接已恢复，页面内容可以继续更新。';
        if (offlineIcon) offlineIcon.hidden = true;
        if (restoredIcon) restoredIcon.hidden = false;
        retry.hidden = true;
        hideTimer = window.setTimeout(function () { state.hidden = true; }, 2600);
      } else if (mode === 'request-failed') {
        message.textContent = '请求暂时失败，当前页面内容已保留，可以重新连接。';
        if (offlineIcon) offlineIcon.hidden = false;
        if (restoredIcon) restoredIcon.hidden = true;
        retry.hidden = false;
      } else {
        message.textContent = '网络连接已中断，当前页面内容已保留，恢复后可继续操作。';
        if (offlineIcon) offlineIcon.hidden = false;
        if (restoredIcon) restoredIcon.hidden = true;
        retry.hidden = false;
      }
    }

    if (navigator.onLine === false) render('offline');
    window.addEventListener('offline', function () { render('offline'); });
    window.addEventListener('online', function () { render('restored'); });
    window.addEventListener('nwpuoj:network-error', function () { render('request-failed'); });
    retry.addEventListener('click', function () { window.location.reload(); });
  }

  function setupCommandPanel() {
    var dialog = document.getElementById('app-command-dialog');
    var opener = document.querySelector('[data-command-open]');
    if (!dialog || !opener || typeof dialog.showModal !== 'function') return;
    var input = dialog.querySelector('[data-command-input]');
    var items = Array.prototype.slice.call(dialog.querySelectorAll('[data-command-item]'));
    var groups = Array.prototype.slice.call(dialog.querySelectorAll('.app-command-group'));
    var empty = dialog.querySelector('[data-command-empty]');

    function visibleItems() {
      return items.filter(function (item) { return !item.hidden; });
    }

    function filterItems() {
      var query = String(input.value || '').trim().toLocaleLowerCase('zh-CN');
      items.forEach(function (item) {
        var terms = (item.textContent + ' ' + (item.getAttribute('data-command-terms') || '')).toLocaleLowerCase('zh-CN');
        item.hidden = !!query && terms.indexOf(query) === -1;
      });
      groups.forEach(function (group) {
        group.hidden = !group.querySelector('[data-command-item]:not([hidden])');
      });
      empty.hidden = visibleItems().length !== 0;
    }

    function openPanel() {
      closeAccounts();
      dialog.showModal();
      input.value = '';
      filterItems();
      window.setTimeout(function () { input.focus(); }, 0);
    }

    opener.addEventListener('click', openPanel);
    input.addEventListener('input', filterItems);
    input.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowDown') return;
      var first = visibleItems()[0];
      if (first) { event.preventDefault(); first.focus(); }
    });
    dialog.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      var visible = visibleItems();
      var current = visible.indexOf(document.activeElement);
      if (current === -1) return;
      event.preventDefault();
      visible[(current + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length].focus();
    });
    dialog.addEventListener('click', function (event) {
      if (event.target.closest('[data-command-item]')) dialog.close();
    });
    document.addEventListener('keydown', function (event) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      if (dialog.open) dialog.close();
      else openPanel();
    });
  }

  function setupActionMenus() {
    function closeOutside(target) {
      document.querySelectorAll('details.app-action-menu[open]').forEach(function (menu) {
        if (!target || !menu.contains(target)) menu.open = false;
      });
    }
    // Capture also covers pages whose local click handlers stop propagation.
    document.addEventListener('click', function (event) { closeOutside(event.target); }, true);
    document.addEventListener('toggle', function (event) {
      if (event.target.matches && event.target.matches('details.app-action-menu') && event.target.open) closeOutside(event.target);
    }, true);
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      var active = document.activeElement;
      var menu = active && active.closest('details.app-action-menu[open]');
      closeOutside(null);
      if (menu) {
        var summary = menu.querySelector('summary');
        if (summary) summary.focus();
        event.preventDefault();
      }
    });
  }

  function setupSelectionGroups() {
    document.querySelectorAll('[data-select-group]').forEach(function (group) {
      var master = group.querySelector('[data-select-all]');
      var items = Array.prototype.slice.call(group.querySelectorAll('[data-select-item]'));
      var count = group.querySelector('[data-selected-count]');
      var actions = group.querySelectorAll('[data-requires-selection]');
      if (!master || !items.length) return;

      function update() {
        var selected = items.filter(function (item) { return item.checked; }).length;
        master.checked = selected === items.length;
        master.indeterminate = selected > 0 && selected < items.length;
        if (count) count.textContent = String(selected);
        actions.forEach(function (action) {
          action.disabled = selected === 0;
          action.classList.toggle('is-disabled', selected === 0);
        });
      }

      master.addEventListener('change', function () {
        items.forEach(function (item) { item.checked = master.checked; });
        update();
      });
      items.forEach(function (item) { item.addEventListener('change', update); });
      update();
    });
  }

  function setupStatementCopies() {
    var sequence = 0;
    document.querySelectorAll('.app-problem-statement .app-markdown pre').forEach(function (pre) {
      if (pre.closest('.app-statement-code-block, .app-vditor-host, [contenteditable="true"]')) return;
      var wrapper = document.createElement('div');
      wrapper.className = 'app-statement-code-block';
      do { wrapper.id = 'app-statement-code-' + (++sequence); } while (document.getElementById(wrapper.id));
      var toolbar = document.createElement('div');
      toolbar.className = 'app-statement-code-toolbar';
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'app-statement-code-copy';
      button.title = '复制代码';
      button.setAttribute('aria-label', '复制代码');
      // The button lives outside <pre>: copying/selecting code never includes
      // its label, and horizontal scrolling cannot move it off screen.
      button.setAttribute('data-copy', '#' + wrapper.id + ' > pre');
      button.innerHTML = '<i data-lucide="copy"></i><span data-copy-label>复制</span>';
      toolbar.appendChild(button);
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(toolbar);
      wrapper.appendChild(pre);
      refreshIcons(button);
    });
  }

  function setupCopies() {
    function legacyCopy(value) {
      var active = document.activeElement;
      var selection = window.getSelection ? window.getSelection() : null;
      var ranges = [];
      if (selection) {
        for (var index = 0; index < selection.rangeCount; index += 1) ranges.push(selection.getRangeAt(index));
      }
      var textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.readOnly = true;
      textarea.setAttribute('aria-hidden', 'true');
      textarea.style.position = 'fixed';
      textarea.style.inset = '0 auto auto -9999px';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      var copied = false;
      try { copied = document.execCommand('copy'); } catch (error) {}
      textarea.remove();
      if (selection) {
        selection.removeAllRanges();
        ranges.forEach(function (range) { selection.addRange(range); });
      }
      if (active && typeof active.focus === 'function') active.focus();
      if (!copied) throw new Error('Clipboard copy is unavailable.');
    }

    async function copyText(value) {
      try {
        legacyCopy(value);
        return;
      } catch (error) {}
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(value);
        return;
      }
      throw new Error('Clipboard copy is unavailable.');
    }

    document.addEventListener('click', async function (event) {
      var button = event.target.closest('[data-copy]');
      if (!button) return;
      event.preventDefault();
      if (button.dataset.copying === 'true') return;
      var source = document.querySelector(button.getAttribute('data-copy'));
      if (!source) return;
      var value = 'value' in source ? source.value : source.textContent;
      var label = button.querySelector('[data-copy-label]');
      window.clearTimeout(button.__copyResetTimer);
      button.dataset.copying = 'true';
      try {
        await copyText(value);
        button.setAttribute('aria-label', '已复制');
        if (label) label.textContent = '已复制';
        button.classList.add('is-copied');
        showToast('已复制到剪贴板', 'success');
      } catch (error) {
        button.classList.remove('is-copied');
        if (label) label.textContent = '复制失败';
        button.setAttribute('aria-label', '复制失败，请手动选择内容');
        showToast('复制失败，请手动选择内容', 'danger');
      } finally {
        delete button.dataset.copying;
        button.__copyResetTimer = window.setTimeout(function () {
          button.setAttribute('aria-label', button.getAttribute('title') || '复制');
          button.classList.remove('is-copied');
          if (label) label.textContent = '复制';
        }, 1600);
      }
    });
  }

  function setupPasswordToggles() {
    document.addEventListener('click', function (event) {
      var button = event.target.closest('[data-password-toggle]');
      if (!button) return;
      var input = document.getElementById(button.getAttribute('data-password-toggle'));
      if (!input) return;
      var reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      button.setAttribute('aria-label', reveal ? '隐藏密码' : '显示密码');
      button.innerHTML = '<i data-lucide="' + (reveal ? 'eye-off' : 'eye') + '"></i>';
      refreshIcons(button);
    });
  }

  function setupFileInputs() {
    var controls = new WeakMap();
    var sequence = 0;

    function sync(input) {
      if (!input || !input.matches || !input.matches('input[type="file"]') || !input.parentNode) return;
      // Vditor uploads immediately and owns its toolbar/status feedback.
      // Ordinary upload fields still retain their selected filename lists.
      if (input.closest('.app-vditor-host')) return;
      var control = controls.get(input);
      if (!control) {
        var field = input.closest('.app-file-field');
        var surface = field && field.querySelector('span');
        var status = surface && surface.querySelector('[data-file-selection]');
        if (!status) {
          status = document.createElement('span');
          if (surface) surface.appendChild(status);
          else input.insertAdjacentElement('afterend', status);
        }
        status.classList.add('app-file-selection');
        status.setAttribute('data-file-selection', '');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.setAttribute('aria-atomic', 'true');
        if (!status.id) {
          do { status.id = 'app-file-selection-' + (++sequence); } while (document.getElementById(status.id) !== status);
        }
        var descriptions = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
        if (descriptions.indexOf(status.id) === -1) descriptions.push(status.id);
        input.setAttribute('aria-describedby', descriptions.join(' '));
        control = { status: status, signature: null };
        controls.set(input, control);
      }
      var files = Array.from(input.files || []);
      var signature = JSON.stringify(files.map(function (file) { return [file.name, file.size, file.lastModified]; }));
      if (control.signature === signature) return;
      control.signature = signature;
      var status = control.status;
      status.textContent = '';
      status.classList.toggle('is-selected', files.length > 0);
      if (!files.length) { status.textContent = '未选择文件'; return; }
      var summary = document.createElement('span');
      summary.textContent = files.length === 1 ? '已选择：' : '已选择 ' + files.length + ' 个文件：';
      status.appendChild(summary);
      var list = document.createElement('span');
      list.className = 'app-file-selection-list';
      list.setAttribute('role', 'list');
      list.setAttribute('aria-label', '已选择的文件');
      if (files.length > 1) list.tabIndex = 0;
      files.forEach(function (file) {
        var name = document.createElement('span');
        name.className = 'app-file-selection-name';
        name.setAttribute('role', 'listitem');
        name.textContent = file.name;
        name.title = file.name;
        list.appendChild(name);
      });
      status.appendChild(list);
    }

    function scan(scope) {
      if (scope.matches && scope.matches('input[type="file"]')) sync(scope);
      if (scope.querySelectorAll) scope.querySelectorAll('input[type="file"]').forEach(sync);
    }
    scan(document);
    ['input', 'change', 'cancel'].forEach(function (eventName) {
      document.addEventListener(eventName, function (event) { sync(event.target); }, true);
    });
    // The reset event fires before the browser clears the native FileList.
    document.addEventListener('reset', function (event) {
      var form = event.target;
      window.setTimeout(function () {
        Array.from(form.elements || []).forEach(sync);
      }, 0);
    }, true);
    window.addEventListener('pageshow', function () { scan(document); });
    // Support file inputs added by dialogs or later partial-page updates.
    if (window.MutationObserver) new MutationObserver(function (records) {
      records.forEach(function (record) {
        record.addedNodes.forEach(function (node) { if (node.nodeType === 1) scan(node); });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  function setupDateTimePickers() {
    var timeSelectSequence = 0;
    function syncTimeSelects(instance) {
      var hour = instance.calendarContainer.querySelector('[data-datetime-hour]');
      var minute = instance.calendarContainer.querySelector('[data-datetime-minute]');
      if (hour) hour.value = instance.hourElement.value;
      if (minute) minute.value = instance.minuteElement.value;
      [hour, minute].forEach(function (select) { if (select && select.appTimeChoices) select.appTimeChoices.sync(); });
    }
    function setupTimeSelects(instance) {
      var controls = document.createElement('div');
      controls.className = 'app-datetime-time-controls';
      var selects = [];
      function closeTimeChoices() {
        selects.forEach(function (select) { select.appTimeChoices.close(); });
      }
      function timeSelect(labelText, count, attribute) {
        var field = document.createElement('div');
        field.className = 'app-datetime-time-field';
        var label = document.createElement('label');
        label.textContent = labelText;
        var wrapper = document.createElement('div');
        wrapper.className = 'app-datetime-select';
        var select = document.createElement('select');
        select.className = 'app-select';
        select.id = 'app-datetime-time-' + (++timeSelectSequence);
        label.htmlFor = select.id;
        select.setAttribute(attribute, '');
        select.setAttribute('aria-label', labelText + '（0–' + (count - 1) + '）');
        select.setAttribute('aria-expanded', 'false');
        var menu = document.createElement('div');
        menu.className = 'app-datetime-options';
        menu.id = select.id + '-options';
        menu.hidden = true;
        menu.setAttribute('role', 'listbox');
        menu.setAttribute('aria-label', labelText + '选项');
        select.setAttribute('aria-controls', menu.id);
        var choices = [];
        function close() {
          menu.hidden = true;
          select.setAttribute('aria-expanded', 'false');
        }
        function sync() {
          choices.forEach(function (choice) { choice.setAttribute('aria-selected', String(choice.dataset.value === select.value)); });
        }
        function choose(value) {
          close();
          select.focus({ preventScroll: true });
          select.value = value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        for (var value = 0; value < count; value++) {
          var option = document.createElement('option');
          option.value = option.textContent = ('0' + value).slice(-2);
          select.appendChild(option);
          var choice = document.createElement('button');
          choice.type = 'button';
          choice.className = 'app-datetime-option';
          choice.textContent = choice.dataset.value = option.value;
          choice.tabIndex = -1;
          choice.setAttribute('role', 'option');
          choice.addEventListener('click', function (event) { choose(event.currentTarget.dataset.value); });
          choices.push(choice);
          menu.appendChild(choice);
        }
        function open() {
          closeTimeChoices();
          select.focus({ preventScroll: true });
          var rect = select.getBoundingClientRect();
          var viewport = window.visualViewport;
          var top = viewport ? viewport.offsetTop : 0;
          var bottom = top + (viewport ? viewport.height : window.innerHeight);
          var below = bottom - rect.bottom - 12;
          var above = rect.top - top - 12;
          var upward = below < Math.min(224, menu.scrollHeight || 224) && above > below;
          menu.dataset.placement = upward ? 'above' : 'below';
          menu.style.maxHeight = Math.min(224, Math.max(40, upward ? above : below)) + 'px';
          menu.hidden = false;
          select.setAttribute('aria-expanded', 'true');
          sync();
          // Scroll only the bounded options pane, never the page or calendar.
          menu.scrollTop = choices[select.selectedIndex].offsetTop - (menu.clientHeight - choices[select.selectedIndex].offsetHeight) / 2;
        }
        // A native popup cannot be sized or positioned within the viewport.
        // Keep select semantics/keyboard value changes, but own the popup.
        ['pointerdown', 'mousedown'].forEach(function (type) {
          select.addEventListener(type, function (event) { if (event.button === 0) event.preventDefault(); });
        });
        select.addEventListener('click', function (event) {
          event.preventDefault();
          if (menu.hidden) open(); else close();
        });
        function keyboard(event) {
          event.stopPropagation();
          var index = choices.indexOf(document.activeElement);
          if (index < 0) index = select.selectedIndex;
          if (event.key === 'Escape') {
            event.preventDefault();
            if (!menu.hidden) { close(); select.focus({ preventScroll: true }); }
            else { instance.altInput.focus(); instance.close(); }
          } else if (event.key === 'Tab') {
            event.preventDefault();
            closeTimeChoices();
            if (event.shiftKey ? select === hour : select === minute) { instance.altInput.focus(); instance.close(); }
            else (event.shiftKey ? hour : minute).focus();
          } else if (event.key === 'Enter' || event.key === ' ' || event.key === 'F4' || event.altKey && event.key === 'ArrowDown') {
            event.preventDefault();
            if (menu.hidden) open(); else choose(choices[index].dataset.value);
          } else if (!menu.hidden && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            index = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : Math.max(0, Math.min(count - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
            choices[index].focus({ preventScroll: true });
            var choice = choices[index];
            if (choice.offsetTop < menu.scrollTop) menu.scrollTop = choice.offsetTop;
            else if (choice.offsetTop + choice.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = choice.offsetTop + choice.offsetHeight - menu.clientHeight;
          }
        }
        select.addEventListener('keydown', keyboard);
        menu.addEventListener('keydown', keyboard);
        select.appTimeChoices = { close: close, sync: sync };
        selects.push(select);
        wrapper.appendChild(select);
        wrapper.appendChild(menu);
        field.appendChild(label);
        field.appendChild(wrapper);
        controls.appendChild(field);
        return select;
      }
      var hour = timeSelect('小时', 24, 'data-datetime-hour');
      var minute = timeSelect('分钟', 60, 'data-datetime-minute');
      function updateTime() {
        var date = new Date(instance.selectedDates[0] || new Date());
        date.setHours(Number(hour.value), Number(minute.value), 0, 0);
        instance.setDate(date, true);
      }
      [hour, minute].forEach(function (select) {
        select.addEventListener('change', function () { closeTimeChoices(); updateTime(); });
      });
      instance.config.onClose.push(closeTimeChoices);
      instance.calendarContainer.addEventListener('pointerdown', function (event) {
        if (!event.target.closest('.app-datetime-select')) closeTimeChoices();
      });
      // Keep Flatpickr's time inputs for its date calculations; show the
      // explicit hour/minute choices in the same calendar popup.
      instance.timeContainer.setAttribute('aria-hidden', 'true');
      instance.calendarContainer.appendChild(controls);
      function focusTimeAfterDatePick(event) {
        if (event.type === 'keydown' && event.key !== 'Enter') return;
        var day = event.target.closest('.flatpickr-day');
        if (!day || day.classList.contains('flatpickr-disabled') || day.classList.contains('notAllowed')) return;
        // The calendar rebuilds its days before finishing a date selection.
        window.setTimeout(function () { if (instance.isOpen) hour.focus(); }, 0);
      }
      instance.daysContainer.addEventListener('click', focusTimeAfterDatePick, true);
      instance.daysContainer.addEventListener('keydown', focusTimeAfterDatePick, true);
      syncTimeSelects(instance);
    }
    function parseDateTime(value) {
      var parts = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(value);
      if (!parts) return undefined;
      var date = new Date(0);
      date.setFullYear(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
      date.setHours(Number(parts[4]), Number(parts[5]), 0, 0);
      if (date.getFullYear() !== Number(parts[1]) || date.getMonth() !== Number(parts[2]) - 1 || date.getDate() !== Number(parts[3]) || date.getHours() !== Number(parts[4]) || date.getMinutes() !== Number(parts[5])) return undefined;
      return date;
    }
    document.querySelectorAll('input[type="datetime-local"], [data-app-datetime-picker]').forEach(function (input) {
      if (typeof window.flatpickr === 'function') {
        var picker = window.flatpickr(input, {
          locale: window.flatpickr.l10ns.zh,
          enableTime: true,
          time_24hr: true,
          disableMobile: true,
          minuteIncrement: 1,
          dateFormat: 'Y-m-d\\TH:i',
          altInput: true,
          altFormat: 'Y-m-d H:i',
          altInputClass: 'app-input app-datetime-input',
          allowInput: true,
          parseDate: parseDateTime,
          onReady: function (dates, value, instance) {
            instance.calendarContainer.classList.add('app-datetime-calendar');
            instance.calendarContainer.setAttribute('role', 'dialog');
            instance.calendarContainer.setAttribute('aria-label', '选择日期和时间（24 小时制）');
            if (input.hasAttribute('aria-label')) instance.altInput.setAttribute('aria-label', input.getAttribute('aria-label'));
            instance.altInput.placeholder = 'YYYY-MM-DD HH:mm（24 小时制）';
            setupTimeSelects(instance);
          },
          onOpen: function (dates, value, instance) { syncTimeSelects(instance); },
          onChange: function (dates, value, instance) { syncTimeSelects(instance); },
          onValueUpdate: function (dates, value, instance) {
            instance.altInput.setCustomValidity('');
            syncTimeSelects(instance);
          }
        });
        // Keep the submitted ISO local value current even when the user types
        // a time and immediately submits without leaving the field.
        picker.altInput.addEventListener('input', function () {
          var text = picker.altInput.value;
          var date = parseDateTime(text);
          picker.altInput.setCustomValidity(text && !date ? '请输入有效的日期和 24 小时制时间，例如 2026-11-15 13:05。' : '');
          if (date) picker.setDate(date, true);
          else if (!text) picker.clear();
          else {
            input.value = '';
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
        return;
      }
      function openPicker() {
        if (typeof input.showPicker !== 'function' || input.disabled || input.readOnly) return;
        try { input.showPicker(); } catch (error) {}
      }
      input.addEventListener('focus', openPicker);
      input.addEventListener('click', openPicker);
    });
  }

  function refreshUsernameTiers(scope) {
    var tiers = window.__SYZOJ_USER_TIERS || {};
    var target = scope && typeof scope.querySelectorAll === 'function' ? scope : document;
    target.querySelectorAll('a[href^="/user/"]').forEach(function (link) {
      if (Array.prototype.some.call(link.classList, function (name) { return name.indexOf('username-tier-') === 0; })) return;
      var path;
      try {
        var url = new URL(link.href, window.location.href);
        if (url.origin !== window.location.origin) return;
        path = url.pathname;
      } catch (error) {
        return;
      }
      var match = /^\/user\/(\d+)\/?$/.exec(path);
      if (!match) return;
      link.classList.add('username-tier-' + (tiers[match[1]] || 'default'));
    });
  }

  function setupReveals() {
    var elements = document.querySelectorAll('[data-reveal]');
    if (!elements.length || !('IntersectionObserver' in window)) return;
    elements.forEach(function (element) {
      element.style.opacity = '0';
      element.style.transform = 'translateY(8px)';
      element.style.transition = 'opacity 260ms ease, transform 260ms ease';
    });
    // Long statements must reveal as soon as a small portion enters the viewport.
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.001 });
    elements.forEach(function (element) { observer.observe(element); });
  }

  function setupGlobalEvents() {
    document.addEventListener('click', function (event) {
      var post = event.target.closest('[href-post]');
      if (post) {
        event.preventDefault();
        postLink(post);
        return;
      }
      var emailVerification = event.target.closest('[data-email-verification-v2]');
      if (emailVerification && !emailVerification.disabled) {
        event.preventDefault();
        emailVerification.disabled = true;
        fetch('/api/v2/me/email-verification', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        }).then(function (response) {
          return response.json().then(function (body) { return { response: response, body: body }; });
        }).then(function (result) {
          if (!result.response.ok) throw new Error(result.body && result.body.error && result.body.error.message || '验证邮件发送失败。');
          showToast('验证邮件已发送', 'success');
          window.setTimeout(function () { window.location.assign(result.body.data.redirect_url); }, 250);
        }).catch(function (error) {
          showToast(error.message || '验证邮件发送失败。', 'danger');
          emailVerification.disabled = false;
        });
        return;
      }
      var themeButton = event.target.closest('[data-theme-toggle]');
      if (themeButton) toggleTheme();

      var historyButton = event.target.closest('[data-history-back]');
      if (historyButton) {
        if (window.history.length > 1) window.history.back();
        else window.location.href = '/';
      }

      if (event.target.closest('[data-state-retry]')) window.location.reload();

      var account = event.target.closest('.app-account');
      if (!account) closeAccounts();
    });

    document.addEventListener('toggle', function (event) {
      if (event.target.matches && event.target.matches('.app-account') && event.target.open) closeAccounts(event.target);
    }, true);

    document.addEventListener('submit', function (event) {
      var form = event.target;
      protectForm(form);
      var confirmation = form.getAttribute('data-confirm');
      if (confirmation && !window.confirm(confirmation)) event.preventDefault();
    }, true);

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeAccounts();
    });
  }

  function wrapFetch() {
    if (!window.fetch || window.fetch.__nwpuojWrapped) return;
    var nativeFetch = window.fetch;
    var wrapped = function (input, options) {
      var requestOptions = Object.assign({}, options || {});
      var url = typeof input === 'string' ? input : input.url;
      var method = String(requestOptions.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
      var methodTunnel = /^(PATCH|PUT|DELETE)$/.test(method);
      if (methodTunnel && sameOrigin(url)) {
        var tunnelHeaders = new Headers(requestOptions.headers || (typeof input !== 'string' ? input.headers : undefined));
        tunnelHeaders.set('X-HTTP-Method-Override', method);
        requestOptions.method = 'POST';
        requestOptions.headers = tunnelHeaders;
      }
      if (app.csrfToken && sameOrigin(url) && !/^(GET|HEAD|OPTIONS)$/.test(method)) {
        var headers = new Headers(requestOptions.headers || (typeof input !== 'string' ? input.headers : undefined));
        headers.set('X-CSRF-Token', app.csrfToken);
        if (!headers.has('Idempotency-Key')) {
          headers.set('Idempotency-Key', window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : String(Date.now()) + Math.random());
        }
        requestOptions.headers = headers;
      }
      return nativeFetch.call(window, input, requestOptions).catch(function (error) {
        if (error && (error.name === 'TypeError' || navigator.onLine === false)) {
          window.dispatchEvent(new CustomEvent('nwpuoj:network-error'));
        }
        throw error;
      });
    };
    wrapped.__nwpuojWrapped = true;
    window.fetch = wrapped;
  }

  function initialize() {
    refreshIcons();
    setTheme(root.getAttribute('data-theme'));
    document.querySelectorAll('form').forEach(protectForm);
    setupSidebar();
    setupDialogs();
    setupPageProgress();
    setupConnectivityState();
    setupAccessibleRegions();
    setupCommandPanel();
    setupActionMenus();
    setupSelectionGroups();
    setupStatementCopies();
    setupCopies();
    setupPasswordToggles();
    setupFileInputs();
    setupDateTimePickers();
    refreshUsernameTiers();
    setupReveals();
    setupGlobalEvents();
    wrapFetch();
  }

  window.NWPUOJApp = {
    refreshIcons: refreshIcons,
    refreshUsernameTiers: refreshUsernameTiers,
    showToast: showToast,
    protectForm: protectForm,
    setTheme: setTheme
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
  else initialize();
})();
