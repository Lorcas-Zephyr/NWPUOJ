(function () {
  'use strict';

  var fallbackTimer = null;
  var fallbackActive = false;

  function applyWhiteTheme() {
    if (!window.monaco || !window.monaco.editor || !window.monaco.editor.setTheme) return;
    window.monaco.editor.setTheme('vs');
  }

  function tuneEditor(editor) {
    applyWhiteTheme();
    if (!editor || typeof editor.updateOptions !== 'function') return editor;

    editor.updateOptions({
      minimap: { enabled: false },
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      scrollBeyondLastLine: false,
      scrollbar: {
        useShadows: false,
        vertical: 'auto',
        horizontal: 'auto',
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10
      }
    });

    window.setTimeout(function () {
      if (typeof editor.layout === 'function') editor.layout();
    }, 0);
    return editor;
  }

  function patchFactory() {
    if (fallbackTimer) window.clearTimeout(fallbackTimer);
    fallbackTimer = null;

    var originalFactory = window.createCodeEditor;
    if (typeof originalFactory !== 'function' || originalFactory.__nwpuojWhiteEditor) return;

    var wrappedFactory = function (element, language, content) {
      return tuneEditor(originalFactory(element, language, content));
    };
    wrappedFactory.__nwpuojWhiteEditor = true;
    window.createCodeEditor = wrappedFactory;
    applyWhiteTheme();
  }

  function createFallbackEditor(element, language, content) {
    element.innerHTML = '';
    var textarea = document.createElement('textarea');
    textarea.className = 'app-code-fallback';
    textarea.value = content || '';
    textarea.setAttribute('aria-label', '代码编辑器');
    textarea.setAttribute('spellcheck', 'false');
    textarea.setAttribute('autocomplete', 'off');
    textarea.addEventListener('keydown', function (event) {
      if (event.key !== 'Tab') return;
      event.preventDefault();
      var start = textarea.selectionStart;
      var end = textarea.selectionEnd;
      textarea.setRangeText('    ', start, end, 'end');
    });
    element.appendChild(textarea);

    return {
      getValue: function () { return textarea.value; },
      setValue: function (value) { textarea.value = value || ''; },
      getModel: function () { return null; },
      layout: function () {},
      updateOptions: function () {},
      focus: function () { textarea.focus(); }
    };
  }

  function activateFallback() {
    if (window.editorLoaded || fallbackActive) return;
    fallbackActive = true;
    window.createCodeEditor = createFallbackEditor;
    window.editorLoaded = true;

    var callbacks = (window.editorLoadedHandles || []).slice();
    window.editorLoadedHandles = [];
    callbacks.forEach(function (callback) {
      try {
        callback();
      } catch (error) {
        window.setTimeout(function () { throw error; }, 0);
      }
    });
  }

  if (typeof window.onEditorLoaded === 'function') {
    window.onEditorLoaded(patchFactory);
  } else {
    window.editorLoadedHandles = window.editorLoadedHandles || [];
    window.onEditorLoaded = function (callback) {
      if (window.editorLoaded) callback();
      else window.editorLoadedHandles.push(callback);
    };
  }

  fallbackTimer = window.setTimeout(activateFallback, 5000);
  document.addEventListener('nwpuoj:themechange', applyWhiteTheme);
})();
