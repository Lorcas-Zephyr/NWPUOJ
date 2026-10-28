(function () {
  'use strict';
  if (window.NWPUOJMarkdown) return;
  var version = '4.0.0';
  var cdn = '/self/lib/vditor-' + version;
  var script = document.currentScript;
  var uploadAllowed = !!(script && script.dataset.uploadAllowed === '1');
  // This allow-list is deliberately explicit: contest notices, account/CSV
  // lists, judging source code and hidden Markdown payloads stay plain text.
  var selector = [
    '[data-problem-editor-v2] textarea[name="description"]',
    '[data-contest-editor-v2] textarea[name="information"]',
    '[data-contest-editor-v2] textarea[name="subtitle"]',
    '[data-problem-set-editor] textarea[name="description"]',
    '[data-markdown-editor] textarea[name="content"]',
    '[data-announcement-v2-edit] textarea[name="content"]',
    '[data-site-notification-editor] textarea[name="content"]',
    '[data-message-v2] textarea[name="content"]',
    '[data-ticket-v2="create"] textarea[name="description"]',
    '[data-ticket-v2="reply"] textarea[name="content"]',
    '[data-clipboard-v2="save"] textarea[name="content"]',
    '[data-discussion-v2-reply] textarea[name="comment"]',
    '[data-solution-v2-form="comment"] textarea[name="comment"]'
  ].join(',');
  var states = new Map();
  var assets;
  var serial = 0;

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var element = document.createElement('script');
      element.src = url;
      element.onload = resolve;
      element.onerror = function () { reject(new Error('编辑器资源加载失败')); };
      document.head.appendChild(element);
    });
  }
  function loadStyle(url) {
    return new Promise(function (resolve, reject) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      link.onload = resolve;
      link.onerror = function () { reject(new Error('编辑器样式加载失败')); };
      document.head.appendChild(link);
    });
  }
  function loadAssets() {
    if (!assets) {
      // Loading these once and in sequence avoids races between several
      // editors on the same page and keeps every dependency on this origin.
      assets = Promise.all([loadStyle(cdn + '/dist/index.css'), loadStyle('/self/lib/noj-markdown.css?rev=20261005-3'),
        loadScript(cdn + '/dist/js/i18n/zh_CN.js'), loadScript(cdn + '/dist/js/lute/lute.min.js')])
        .then(function () { return loadScript(cdn + '/dist/index.min.js'); });
    }
    return assets;
  }
  function dark() { return document.documentElement.getAttribute('data-theme') === 'dark'; }
  function notify(message) {
    if (window.NWPUOJApp) window.NWPUOJApp.showToast(message, 'danger');
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }
  function capturePosition(state) {
    var mode = state.editor.getCurrentMode();
    if (mode === 'sv') {
      var textarea = state.host.querySelector('textarea.vditor-sv');
      return { mode: mode, start: textarea.selectionStart, end: textarea.selectionEnd };
    }
    var selection = window.getSelection();
    var range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    return { mode: mode, range: range && state.host.contains(range.commonAncestorContainer) ? range.cloneRange() : null };
  }
  function restorePosition(state, position) {
    state.editor.focus();
    if (!position || position.mode !== state.editor.getCurrentMode()) return;
    if (position.mode === 'sv') state.host.querySelector('textarea.vditor-sv').setSelectionRange(position.start, position.end);
    else if (position.range && position.range.startContainer.isConnected && state.host.contains(position.range.commonAncestorContainer)) {
      var selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(position.range);
    }
  }
  function insertImage(state, name, address, position) {
    if (state.source.disabled || state.source.readOnly) throw new Error('当前内容不可编辑。');
    var url = new URL(address, location.origin);
    if (!/^https?:$/.test(url.protocol)) throw new Error('图片地址无效。');
    if (position) restorePosition(state, position);
    var alt = String(name || '图片').replace(/[\r\n]/g, ' ').replace(/[\\\[\]<>`*_]/g, '\\$&');
    // insertValue treats its argument as HTML in rich modes. Use the Markdown
    // API and a percent-encoded destination that also works in Lute's preview.
    var destination = url.href.replace(/[()<>]/g, function (character) { return '%' + character.charCodeAt(0).toString(16).toUpperCase(); });
    state.editor.insertMD('![' + alt + '](' + destination + ')\n');
    state.dirty = true;
    state.flush(true);
  }
  function openImageLibrary(state) {
    if (!uploadAllowed || state.source.disabled || state.source.readOnly || document.querySelector('.app-image-library[open]')) return;
    var position = capturePosition(state);
    var dialog = document.createElement('dialog');
    dialog.className = 'app-dialog app-image-library';
    dialog.setAttribute('aria-labelledby', state.host.id + '-library-title');
    dialog.innerHTML = '<div class="app-dialog-header"><div><h2>我的图床</h2><p>选择图片，插入到当前光标位置</p></div><button class="app-icon-button" type="button" data-library-close aria-label="关闭图床">×</button></div>' +
      '<div class="app-image-library-tools"><input class="app-input" type="search" placeholder="搜索图片名称" aria-label="搜索图床图片"><button class="app-button app-button-primary" type="button" data-library-upload>上传新图片</button></div>' +
      '<div class="app-image-library-scroll"><p class="app-image-library-message" role="status">正在读取图床…</p><div class="app-image-library-grid"></div><button class="app-button app-button-secondary" type="button" data-library-more hidden>显示更多</button></div>' +
      '<div class="app-dialog-actions"><span>图片保存在 OJ 图床</span><a class="app-button app-button-quiet" href="/image-host" target="_blank" rel="noopener">管理图床 ↗</a><button class="app-button app-button-secondary" type="button" data-library-close>取消</button></div>';
    dialog.querySelector('h2').id = state.host.id + '-library-title';
    var grid = dialog.querySelector('.app-image-library-grid');
    var message = dialog.querySelector('[role="status"]');
    var search = dialog.querySelector('input[type="search"]');
    var more = dialog.querySelector('[data-library-more]');
    var controller = new AbortController();
    var items = [], limit = 18;
    function cleanup() {
      controller.abort(); dialog.remove();
      document.body.classList.toggle('is-dialog-open', !!document.querySelector('dialog[open]'));
    }
    function closeLibrary() { dialog.close(); cleanup(); }
    function draw() {
      var query = search.value.trim().toLocaleLowerCase();
      var matches = items.filter(function (item) { return String(item.original_name || '').toLocaleLowerCase().includes(query); });
      grid.replaceChildren();
      matches.slice(0, limit).forEach(function (item) {
        var url;
        try { url = new URL(item.url, location.origin); } catch (_) { return; }
        if (!/^https?:$/.test(url.protocol)) return;
        var button = document.createElement('button'); button.type = 'button'; button.className = 'app-image-library-item';
        button.title = String(item.original_name || '图片'); button.setAttribute('aria-label', '插入 ' + button.title);
        var preview = document.createElement('span'); preview.className = 'app-image-library-preview';
        var image = document.createElement('img'); image.src = url.href; image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
        image.addEventListener('error', function () { image.hidden = true; preview.classList.add('is-unavailable'); preview.setAttribute('aria-label', '图片暂不可预览'); });
        preview.appendChild(image);
        var name = document.createElement('span'); name.textContent = button.title;
        var size = document.createElement('small'); size.textContent = Number(item.file_size || 0) >= 1048576 ? (Number(item.file_size) / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(Number(item.file_size || 0) / 1024)) + ' KB';
        button.append(preview, name, size);
        button.addEventListener('click', function () {
          closeLibrary();
          try { insertImage(state, item.original_name, url.href, position); } catch (error) { notify(error.message); }
        });
        grid.appendChild(button);
      });
      message.textContent = matches.length ? '共 ' + matches.length + ' 张图片' : items.length ? '没有匹配的图片' : '图床还没有图片，上传一张即可使用。';
      more.hidden = matches.length <= limit;
    }
    search.addEventListener('input', function () { limit = 18; draw(); });
    more.addEventListener('click', function () { limit += 18; draw(); });
    dialog.querySelectorAll('[data-library-close]').forEach(function (button) { button.addEventListener('click', closeLibrary); });
    dialog.querySelector('[data-library-upload]').addEventListener('click', function () {
      closeLibrary(); restorePosition(state, position);
      state.uploadPosition = position;
      state.host.querySelector('input[type="file"]').click();
    });
    dialog.addEventListener('click', function (event) {
      var box = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) closeLibrary();
    });
    dialog.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeLibrary(); }
    });
    dialog.addEventListener('close', cleanup, { once: true });
    document.body.appendChild(dialog); dialog.showModal(); document.body.classList.add('is-dialog-open');
    fetch('/api/v2/image-host', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async function (response) {
        var payload = await response.json();
        if (!response.ok) throw new Error(payload.error && payload.error.message || '图床读取失败，请稍后重试。');
        items = Array.isArray(payload.data) ? payload.data : [];
        draw();
      }).catch(function (error) { if (error.name !== 'AbortError') message.textContent = error.message; });
  }
  function fieldContainer(source) {
    var label = source.closest('label');
    if (!label || label.querySelectorAll('input,textarea,select').length !== 1) return;
    // A contenteditable inside a native <label> otherwise transfers clicks
    // back to the hidden textarea, disrupting cursor and table operations.
    var container = document.createElement('div');
    Array.prototype.forEach.call(label.attributes, function (attribute) {
      if (attribute.name !== 'for') container.setAttribute(attribute.name, attribute.value);
    });
    while (label.firstChild) container.appendChild(label.firstChild);
    label.replaceWith(container);
  }
  function attach(source) {
    if (states.has(source)) return;
    fieldContainer(source);
    var host = document.createElement('div');
    host.id = 'noj-markdown-' + (++serial);
    host.className = 'app-vditor-host';
    host.hidden = true;
    source.insertAdjacentElement('afterend', host);
    var label = source.parentElement.querySelector('.app-label');
    if (label && !label.id) label.id = host.id + '-label';
    var descriptor = Object.getOwnPropertyDescriptor(source instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value');
    var form = source.form;
    var originalTabIndex = source.getAttribute('tabindex');
    var modeToggle = form && form.matches('[data-site-notification-editor]') && form.querySelector('[name="allow_markdown"]');
    var initialValue = descriptor.get.call(source);
    var largeDocument = initialValue.length > 12000 || (initialValue.match(/\n/g) || []).length > 300;
    var state = { source: source, host: host, editor: null, ready: false, syncing: false, dirty: false, baseline: '', form: form, uploadCount: 0 };
    var syncTimer;
    var statusbar, statusText, counterText;
    states.set(source, state);
    function raw() { return descriptor.get.call(source); }
    function validate() {
      var value = raw(), limit = source.maxLength;
      var message = source.required && !value.trim() ? '请填写' + (label ? label.textContent : '内容') + '。' :
        limit >= 0 && value.length > limit ? '内容不能超过 ' + limit + ' 个字符，当前为 ' + value.length + ' 个字符。' : '';
      source.setCustomValidity(message);
    }
    function write(value, dispatch) {
      value = String(value || '');
      if (!value.trim()) value = '';
      var changed = value !== raw();
      descriptor.set.call(source, value);
      if (value.length > 12000) largeDocument = true;
      validate();
      updateStatus();
      if (changed && dispatch) source.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function flush(dispatch, force) {
      if (!state.ready || state.syncing || !force && modeToggle && !modeToggle.checked || !state.dirty && !force) return;
      window.clearTimeout(syncTimer);
      var value = state.editor.getValue();
      state.dirty = false;
      // Do not normalize/rewrite existing Markdown just by opening/saving a
      // page. Only copy a value after the editor's actual content has changed.
      if (value !== state.baseline) {
        state.baseline = value;
        write(value, dispatch);
      }
    }
    function fromSource() {
      if (!state.ready || state.syncing) return;
      state.syncing = true;
      try {
        var value = raw();
        if (value.length > 12000 || (value.match(/\n/g) || []).length > 300) {
          largeDocument = true;
        }
        state.editor.setValue(value, true);
        state.baseline = state.editor.getValue();
        state.dirty = false;
        validate();
        updateStatus();
      } finally { state.syncing = false; }
    }
    state.flush = flush;
    state.fromSource = fromSource;
    // Existing save handlers, programmatic draft restores, asynchronous API
    // loads and "publish" buttons continue using the original form field.
    Object.defineProperty(source, 'value', {
      configurable: true,
      get: function () { flush(false); return raw(); },
      set: function (value) { descriptor.set.call(source, value); fromSource(); }
    });
    function access() {
      if (!state.ready) return;
      var plain = !!(modeToggle && !modeToggle.checked);
      host.hidden = plain;
      source.classList.toggle('app-vditor-source', !plain);
      source.setAttribute('aria-hidden', plain ? 'false' : 'true');
      if (!plain) source.tabIndex = -1;
      else if (originalTabIndex == null) source.removeAttribute('tabindex');
      else source.setAttribute('tabindex', originalTabIndex);
      if (source.disabled || source.readOnly || plain) state.editor.disabled();
      else state.editor.enable();
      host.setAttribute('aria-disabled', source.disabled || source.readOnly ? 'true' : 'false');
      host.querySelectorAll('[data-type="image-library"]').forEach(function (button) { button.disabled = source.disabled || source.readOnly || plain; });
      updateStatus();
    }
    source.addEventListener('input', function (event) {
      if (event.isTrusted || modeToggle && !modeToggle.checked) fromSource();
    });
    source.addEventListener('invalid', function (event) {
      if (!state.ready || host.hidden) return;
      event.preventDefault();
      notify(source.validationMessage);
      state.editor.focus();
    });
    new MutationObserver(function () { access(); validate(); }).observe(source, { attributes: true, attributeFilter: ['disabled', 'readonly', 'required', 'maxlength'] });
    if (modeToggle) modeToggle.addEventListener('change', function () {
      if (modeToggle.checked) fromSource();
      else flush(true, true);
      access();
    });
    // Rich-mode serialization walks the whole document. Batch it while typing;
    // source mode already supplies Markdown directly through Vditor's callback.
    host.addEventListener('input', function (event) {
      if (!event.target.closest('.vditor-ir,.vditor-wysiwyg,.vditor-sv')) return;
      if (state.editor.getCurrentMode() === 'sv') return;
      state.dirty = true;
      window.clearTimeout(syncTimer);
      if (source.required && !raw()) Promise.resolve().then(function () { flush(true); });
      else syncTimer = window.setTimeout(function () { flush(true); }, 240);
    });
    function updateStatus() {
      if (!statusbar) return;
      var currentMode = state.editor.getCurrentMode();
      var preview = host.querySelector('.vditor-preview');
      var names = { ir: '即时渲染', sv: preview && preview.style.display !== 'none' ? '分屏预览' : '源码编辑', wysiwyg: '所见即所得' };
      var modeLabel = host.querySelector('[data-editor-mode-label]');
      if (modeLabel && modeLabel.textContent !== names[currentMode]) modeLabel.textContent = names[currentMode];
      host.dataset.editorMode = currentMode;
      statusText.textContent = state.uploadCount ? '正在上传到图床…' : source.readOnly || source.disabled ? '只读' : largeDocument ? currentMode === 'sv' ? '长文档 · 可收起预览提升流畅度' : '长文档 · 源码编辑更流畅' : uploadAllowed ? '支持粘贴或拖入图片 · OJ 图床' : 'Markdown';
      statusbar.classList.toggle('is-uploading', !!state.uploadCount);
      counterText.textContent = raw().length.toLocaleString('zh-CN') + ' 字';
    }
    var rows = Number(source.rows || 3);
    var height = rows >= 18 ? 540 : rows >= 6 ? 360 : 260;
    var toolbar = ['headings', 'bold', 'italic', 'strike', '|', 'list', 'ordered-list', 'quote', '|', 'code', 'inline-code', 'link', 'table'];
    if (uploadAllowed) {
      toolbar.push('|', { name: 'upload', tip: '上传到 OJ 图床', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 16h2V8.8l2.6 2.6L17 10l-5-5-5 5 1.4 1.4L11 8.8V16zM5 18v2h14v-2h2v4H3v-4h2z"/></svg><span>上传图片</span>' },
        { name: 'image-library', tip: '从我的图床选择', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h18v18H3V3zm2 2v14h14V5H5zm2 12 3-4 2 2 3-5 3 7H7zm1-6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg><span>图床</span>', click: function (event) { event.preventDefault(); openImageLibrary(state); } });
    }
    toolbar.push('|', 'undo', 'redo', '|', { name: 'edit-mode', tip: '切换编辑模式', icon: '<span data-editor-mode-label>分屏预览</span><span class="app-editor-chevron" aria-hidden="true"></span>' },
      { name: 'both', tip: '打开或收起预览', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h18v16H3V4zm2 2v12h6V6H5zm8 0v12h6V6h-6z"/></svg><span>预览</span>' }, 'fullscreen');
    var options = {
      cdn: cdn, lang: 'zh_CN', mode: 'sv', value: initialValue, height: height, minHeight: 180,
      placeholder: source.getAttribute('placeholder') || '输入 Markdown，可切换源码、即时渲染或所见即所得模式',
      theme: dark() ? 'dark' : 'classic',
      cache: { enable: false }, counter: { enable: false },
      toolbar: toolbar, toolbarConfig: { pin: false }, resize: { enable: true },
      outline: { enable: false },
      preview: {
        delay: 500, maxWidth: 1600, mode: 'both',
        markdown: { sanitize: true, autoSpace: false, fixTermTypo: false, footnotes: false, toc: false, mark: false, callout: false },
        math: { engine: 'KaTeX', inlineDigit: true },
        theme: { current: dark() ? 'dark' : 'light', path: cdn + '/dist/css/content-theme' },
        hljs: { enable: true, style: dark() ? 'native' : 'github' },
        render: { media: { enable: false } }, actions: []
      },
      input: function (value) {
        if (!state.ready || state.syncing || modeToggle && !modeToggle.checked) return;
        window.clearTimeout(syncTimer);
        state.dirty = false;
        state.baseline = value;
        write(value, true);
      },
      blur: function () { flush(true); source.dispatchEvent(new Event('change', { bubbles: true })); },
      after: function () {
        state.ready = true;
        state.baseline = state.editor.getValue();
        if (raw() !== initialValue) fromSource();
        else validate();
        // Mark actual rich-content changes, including toolbar actions and undo,
        // without serializing on reads of an otherwise unchanged field.
        var contentObserver = new MutationObserver(function () { if (!state.syncing && state.editor.getCurrentMode() !== 'sv') state.dirty = true; });
        host.querySelectorAll('.vditor-ir [contenteditable],.vditor-wysiwyg [contenteditable]').forEach(function (element) {
          contentObserver.observe(element, { childList: true, characterData: true, subtree: true });
        });
        statusbar = document.createElement('div'); statusbar.className = 'app-vditor-statusbar';
        statusText = document.createElement('span'); statusText.setAttribute('role', 'status');
        counterText = document.createElement('span');
        statusbar.append(statusText, counterText); host.appendChild(statusbar);
        var fileInput = host.querySelector('input[type="file"]');
        if (fileInput) {
          fileInput.setAttribute('aria-label', '上传图片到 OJ 图床');
          fileInput.addEventListener('cancel', function () { state.uploadPosition = null; });
          fileInput.addEventListener('change', function () { if (!fileInput.files.length) state.uploadPosition = null; });
        }
        host.querySelectorAll('button[data-mode],button[data-type="both"]').forEach(function (button) {
          button.addEventListener('click', function () { state.dirty = true; updateStatus(); });
        });
        host.addEventListener('keydown', function () { Promise.resolve().then(updateStatus); });
        updateStatus();
        access();
        source.dataset.vditorReady = '1';
        host.querySelectorAll('[contenteditable],textarea.vditor-sv').forEach(function (editable) {
          editable.setAttribute('role', 'textbox');
          editable.setAttribute('aria-multiline', 'true');
          if (label) editable.setAttribute('aria-labelledby', label.id);
        });
        if (form) {
          form.classList.add('has-vditor');
          form.dispatchEvent(new CustomEvent('nwpuoj:markdown-ready'));
        }
      }
    };
    if (uploadAllowed) options.upload = {
      url: '/api/v2/image-host', accept: 'image/png,image/jpeg,image/gif,image/webp', max: 10 * 1024 * 1024,
      handler: async function (files) {
        if (source.disabled || source.readOnly) return '当前内容不可编辑。';
        var position = state.uploadPosition || capturePosition(state);
        state.uploadPosition = null;
        state.uploadCount++;
        updateStatus();
        try {
          for (var file of files) {
            if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type) || file.size > 10 * 1024 * 1024) throw new Error('请选择不超过 10 MiB 的 JPG、PNG、GIF 或 WebP 图片。');
            var body = new FormData(); body.append('image', file);
            var response = await fetch('/api/v2/image-host', { method: 'POST', credentials: 'same-origin', body: body });
            var result = await response.json();
            if (!response.ok || !result.data || !result.data.url) throw new Error(result.error && result.error.message || '图片上传失败。');
            var url = new URL(result.data.url, location.origin);
            if (!/^https?:$/.test(url.protocol)) throw new Error('图片地址无效。');
            insertImage(state, file.name, url.href, position);
            position = capturePosition(state);
          }
          state.editor.tip('', 1);
          return null;
        } catch (error) { notify(error.message); return escapeHtml(error.message); }
        finally { state.uploadCount--; updateStatus(); }
      }
    };
    try { state.editor = new window.Vditor(host.id, options); }
    catch (error) {
      delete source.value;
      states.delete(source);
      host.remove();
      notify('编辑器加载失败，仍可在文本框中编辑 Markdown。');
    }
  }
  function initialize(scope) {
    var fields = Array.from((scope || document).querySelectorAll(selector)).filter(function (source) { return !states.has(source); });
    if (!fields.length) return Promise.resolve();
    return loadAssets().then(function () { fields.forEach(attach); }).catch(function () {
      notify('编辑器资源加载失败，仍可在文本框中编辑 Markdown。');
    });
  }
  document.addEventListener('submit', function (event) {
    var uploading = false, targeted = false;
    states.forEach(function (state) { if (state.form === event.target) { targeted = true; state.flush(false); uploading = uploading || !!state.uploadCount; } });
    if (!targeted) return;
    if (uploading || !event.target.checkValidity()) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (uploading) notify('图片仍在上传，请完成后再保存。');
    }
  }, true);
  // Flush before native required/maxlength validation and non-submit publish
  // buttons. Toolbar/menu clicks do not force an extra conversion per key.
  document.addEventListener('click', function (event) {
    var button = event.target.closest('button,input[type="submit"]');
    if (!button || button.closest('.app-vditor-host')) return;
    var uploading = false;
    states.forEach(function (state) { if (state.form === button.form) { state.flush(false); uploading = uploading || !!state.uploadCount; } });
    if (uploading && (button.type === 'submit' || button.hasAttribute('data-notification-publish'))) {
      event.preventDefault(); event.stopImmediatePropagation(); notify('图片仍在上传，请完成后再保存。');
    }
  }, true);
  document.addEventListener('formdata', function (event) {
    states.forEach(function (state) {
      if (state.form !== event.target || !state.source.name || state.source.disabled) return;
      state.flush(false);
      event.formData.set(state.source.name, state.source.value);
    });
  }, true);
  document.addEventListener('reset', function (event) {
    setTimeout(function () { states.forEach(function (state) { if (state.form === event.target) state.fromSource(); }); }, 0);
  }, true);
  document.addEventListener('nwpuoj:themechange', function () {
    states.forEach(function (state) {
      if (state.ready) state.editor.setTheme(dark() ? 'dark' : 'classic', dark() ? 'dark' : 'light', dark() ? 'native' : 'github', cdn + '/dist/css/content-theme');
    });
  });
  window.NWPUOJMarkdown = {
    initialize: initialize, selector: selector,
    getEditor: function (source) { var state = states.get(source); return state && state.editor; },
    sync: function (source) { var state = states.get(source); if (state) state.flush(false); }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { initialize(); });
  else initialize();
})();
