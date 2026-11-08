(function () {
  'use strict';
  var ready = false;
  var callbacks = [];
  var timer;
  var selectSequence = 0;
  function enhanceSelect(select) {
    if (select.hidden) return;
    var wrapper = document.createElement('span');
    wrapper.className = 'app-editor-select';
    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'app-editor-select-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-label', select.getAttribute('aria-label'));
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    var text = document.createElement('span');
    trigger.appendChild(text);
    trigger.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6"/></svg>');
    var menu = document.createElement('span');
    menu.className = 'app-editor-select-menu';
    menu.id = 'editor-select-' + (++selectSequence);
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', select.getAttribute('aria-label'));
    menu.hidden = true;
    trigger.setAttribute('aria-controls', menu.id);
    var active = 0, search = '', searchTime = 0;
    var options = Array.from(select.options).filter(function (option) { return !option.disabled; });
    var items = options.map(function (option, index) {
      var item = document.createElement('span');
      item.className = 'app-editor-select-option';
      item.id = menu.id + '-' + index;
      item.dataset.value = option.value;
      item.setAttribute('role', 'option');
      var label = document.createElement('span');
      label.textContent = option.textContent;
      if (option.dataset.version) {
        item.title = option.textContent + ' · ' + option.dataset.version;
      }
      item.appendChild(label);
      item.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8 3 3 6-6"/></svg>');
      item.addEventListener('mousedown', function (event) { event.preventDefault(); });
      item.addEventListener('click', function () { choose(index); });
      menu.appendChild(item);
      return item;
    });
    function sync() {
      text.textContent = select.selectedOptions[0].textContent;
      items.forEach(function (item, index) { item.setAttribute('aria-selected', String(options[index].value === select.value)); });
    }
    function highlight(index) {
      active = (index + items.length) % items.length;
      items.forEach(function (item, index) { item.classList.toggle('is-highlighted', index === active); });
      trigger.setAttribute('aria-activedescendant', items[active].id);
      var item = items[active];
      if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop;
      else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight;
    }
    function close() {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
    }
    function open() {
      menu.hidden = false;
      menu.scrollTop = 0;
      trigger.setAttribute('aria-expanded', 'true');
      highlight(Math.max(0, options.findIndex(function (option) { return option.value === select.value; })));
    }
    function choose(index) {
      select.value = options[index].value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      close();
      trigger.focus();
    }
    trigger.addEventListener('click', function () { if (menu.hidden) open(); else close(); });
    trigger.addEventListener('keydown', function (event) {
      if (event.key === 'Tab') { if (!menu.hidden) choose(active); close(); return; }
      if (event.key === 'Escape') {
        if (!menu.hidden) { event.preventDefault(); event.stopPropagation(); close(); }
        return;
      }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        if (menu.hidden) { open(); return; }
        if (event.key === 'Enter' || event.key === ' ') choose(active);
        else highlight(event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : active + (event.key === 'ArrowUp' ? -1 : 1));
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        if (menu.hidden) open();
        search = (Date.now() - searchTime < 600 ? search : '') + event.key.toLowerCase();
        searchTime = Date.now();
        var index = options.findIndex(function (option) { return option.textContent.toLowerCase().startsWith(search); });
        if (index >= 0) highlight(index);
      }
    });
    trigger.addEventListener('blur', close);
    document.addEventListener('pointerdown', function (event) { if (!wrapper.contains(event.target)) close(); });
    select.addEventListener('change', sync);
    select.before(wrapper);
    wrapper.append(select, trigger, menu);
    select.hidden = true;
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;
    sync();
  }
  window.onEditorLoaded = function (callback) {
    if (ready) callback();
    else callbacks.push(callback);
  };
  window.NWPUOJInstallCodeEditor = function (factory) {
    // A late bundle must not replace source already typed in the fallback.
    if (ready) return;
    ready = true;
    window.clearTimeout(timer);
    window.createCodeEditor = factory;
    callbacks.splice(0).forEach(function (callback) { callback(); });
  };
  window.NWPUOJBindEditorControls = function (element, editor) {
    var workspace = element.closest('[data-code-workbench]');
    if (!workspace) return;
    var font = workspace.querySelector('[data-editor-font]');
    var indent = workspace.querySelector('[data-editor-indent]');
    var full = workspace.querySelector('[data-editor-fullscreen]');
    var preferences = {};
    try { preferences = JSON.parse(localStorage.getItem('nwpuoj_editor_preferences') || '{}') || {}; } catch (error) {}
    if ([12, 14, 16, 18, 20].includes(Number(preferences.font))) font.value = preferences.font;
    if ([2, 4, 8].includes(Number(preferences.indent))) indent.value = preferences.indent;
    function applyPreferences() {
      editor.updateOptions({ fontSize: Number(font.value), tabSize: Number(indent.value) });
      try { localStorage.setItem('nwpuoj_editor_preferences', JSON.stringify({ font: Number(font.value), indent: Number(indent.value) })); } catch (error) {}
    }
    font.addEventListener('change', applyPreferences);
    indent.addEventListener('change', applyPreferences);
    applyPreferences();
    workspace.querySelectorAll('.app-editor-toolbar select').forEach(enhanceSelect);
    var oldOverflow = '';
    function expand(active) {
      workspace.classList.toggle('is-expanded', active);
      full.setAttribute('aria-pressed', String(active));
      full.setAttribute('aria-label', active ? '退出全屏' : '全屏编辑');
      full.title = active ? '退出全屏（Esc）' : '全屏编辑';
      if (active) {
        oldOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        workspace.setAttribute('role', 'dialog');
        workspace.setAttribute('aria-modal', 'true');
        workspace.setAttribute('aria-label', '全屏代码编辑器');
        editor.focus();
      } else {
        document.body.style.overflow = oldOverflow;
        workspace.removeAttribute('role');
        workspace.removeAttribute('aria-modal');
        workspace.removeAttribute('aria-label');
        full.focus();
      }
      editor.layout();
    }
    full.addEventListener('click', function () { expand(!workspace.classList.contains('is-expanded')); });
    workspace.addEventListener('keydown', function (event) {
      if (!workspace.classList.contains('is-expanded')) return;
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        expand(false);
      } else if (event.key === 'Tab' && !event.defaultPrevented) {
        var controls = Array.from(workspace.querySelectorAll('button, select, input, textarea, [tabindex="0"], [contenteditable="true"]')).filter(function (node) { return !node.disabled && node.getClientRects().length; });
        var first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    });
  };
  window.NWPUOJCreateFallbackEditor = function (element, language, content) {
    element.textContent = '';
    element.dataset.editorEngine = 'textarea';
    var textarea = document.createElement('textarea');
    textarea.className = 'app-code-fallback';
    textarea.value = content || '';
    textarea.setAttribute('aria-label', element.getAttribute('aria-label') || '代码编辑器');
    textarea.setAttribute('spellcheck', 'false');
    textarea.setAttribute('autocomplete', 'off');
    var tabSize = 4;
    textarea.addEventListener('keydown', function (event) {
      if (event.key !== 'Tab') return;
      event.preventDefault();
      textarea.setRangeText(' '.repeat(tabSize), textarea.selectionStart, textarea.selectionEnd, 'end');
    });
    element.appendChild(textarea);
    var editor = {
      getValue: function () { return textarea.value; },
      setValue: function (value) { textarea.value = value || ''; },
      setLanguage: function () {},
      layout: function () {},
      updateOptions: function (options) { textarea.style.fontSize = options.fontSize + 'px'; tabSize = options.tabSize; textarea.style.tabSize = tabSize; },
      focus: function () { textarea.focus(); }
    };
    window.NWPUOJBindEditorControls(element, editor);
    return editor;
  };
  function fallback() { window.NWPUOJInstallCodeEditor(window.NWPUOJCreateFallbackEditor); }
  document.addEventListener('error', function (event) {
    if (event.target && event.target.matches && event.target.matches('script[data-code-editor-bundle]')) fallback();
  }, true);
  timer = window.setTimeout(fallback, 5000);
})();
