import { basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { indentUnit, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { python } from '@codemirror/lang-python';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import { tags } from '@lezer/highlight';

const lightHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#a626a4' },
  { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: '#1f2937' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: '#175cd3' },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: '#986801' },
  { tag: [tags.definition(tags.name), tags.separator], color: '#1f2937' },
  { tag: [tags.typeName, tags.className, tags.number, tags.bool], color: '#b85c13' },
  { tag: [tags.operator, tags.operatorKeyword], color: '#417e8a' },
  { tag: [tags.string, tags.regexp, tags.special(tags.string)], color: '#288442' },
  { tag: tags.meta, color: '#8190a3', fontStyle: 'normal' },
  { tag: tags.comment, color: '#8190a3', fontStyle: 'italic' }
]);
function languageSupport(language) {
  if (language === 'cpp' || language === 'c') return cpp();
  if (language === 'java') return java();
  if (language === 'python') return python();
  return [];
}
function themeExtension() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return [EditorView.theme({
    // CodeMirror draws selections behind the content. Keep the active line
    // translucent so it cannot cover a selection on the same line.
    '.cm-activeLine': { backgroundColor: dark ? '#ffffff08' : '#145fb808' },
    '.cm-selectionBackground': { backgroundColor: dark ? '#30435a' : '#d9e5f3' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
      backgroundColor: dark ? '#355b87' : '#bfd8fb'
    }
  }, { dark }), syntaxHighlighting(dark ? oneDarkHighlightStyle : lightHighlight)];
}
const appearance = EditorView.theme({
  '&': { height: '100%', color: 'var(--app-text)', backgroundColor: 'var(--app-surface)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', lineHeight: '1.75' },
  '.cm-content': { padding: '20px 0', caretColor: 'var(--app-accent)' },
  '.cm-line': { padding: '0 24px 0 14px' },
  '.cm-gutters': { backgroundColor: 'var(--app-surface)', color: 'var(--app-text-muted)', border: 'none', paddingRight: '10px' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '40px', paddingLeft: '12px' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--app-bg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--app-accent)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--app-bg)', color: 'var(--app-text-muted)', borderColor: 'var(--app-line)' },
  '.cm-panels': { backgroundColor: 'var(--app-bg)', color: 'var(--app-text)' },
  '.cm-panels-bottom': { borderTop: '1px solid var(--app-line)' },
  '.cm-textfield': { color: 'var(--app-text)', backgroundColor: 'var(--app-surface)', border: '1px solid var(--app-line-strong)', borderRadius: '4px' },
  '.cm-button': { color: 'var(--app-text)', backgroundImage: 'none', backgroundColor: 'var(--app-surface)', border: '1px solid var(--app-line-strong)', borderRadius: '4px' },
  '.cm-tooltip': { border: '1px solid var(--app-line)', backgroundColor: 'var(--app-surface-raised)', color: 'var(--app-text)', borderRadius: '6px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--app-accent-soft)', color: 'var(--app-accent)' }
});

function createEditor(element, language, content) {
  const languageSlot = new Compartment(), themeSlot = new Compartment(), indentSlot = new Compartment(), fontSlot = new Compartment();
  const workspace = element.closest('[data-code-workbench]');
  const cursor = workspace && workspace.querySelector('[data-editor-cursor]');
  function updateCursor(state) {
    if (!cursor) return;
    const position = state.selection.main.head, line = state.doc.lineAt(position);
    cursor.textContent = '行 ' + line.number + '，列 ' + (position - line.from + 1);
  }
  element.textContent = '';
  const view = new EditorView({
    parent: element,
    state: EditorState.create({
      doc: content || '',
      extensions: [
        basicSetup, keymap.of([indentWithTab]), appearance,
        languageSlot.of(languageSupport(language)), themeSlot.of(themeExtension()),
        indentSlot.of([indentUnit.of('    '), EditorState.tabSize.of(4)]),
        fontSlot.of(EditorView.theme({ '&': { fontSize: '14px' } })),
        placeholder('在这里编写代码，或上传源码文件…'),
        EditorView.contentAttributes.of({ 'aria-label': element.getAttribute('aria-label') || '代码编辑器', spellcheck: 'false', autocapitalize: 'off' }),
        EditorState.phrases.of({ 'Find': '查找', 'Replace': '替换', 'next': '下一个', 'previous': '上一个', 'all': '全部', 'match case': '区分大小写', 'by word': '全词匹配', 'regexp': '正则表达式', 'replace': '替换', 'replace all': '全部替换', 'close': '关闭', 'No completions': '没有补全建议' }),
        EditorView.updateListener.of(update => { if (update.docChanged || update.selectionSet) updateCursor(update.state); })
      ]
    })
  });
  element.dataset.editorEngine = 'codemirror';
  const observer = new MutationObserver(() => view.dispatch({ effects: themeSlot.reconfigure(themeExtension()) }));
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const editor = {
    getValue: () => view.state.doc.toString(),
    setValue: value => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value || '' } }),
    setLanguage: next => view.dispatch({ effects: languageSlot.reconfigure(languageSupport(next)) }),
    layout: () => view.requestMeasure(),
    focus: () => view.focus(),
    updateOptions: options => view.dispatch({ effects: [
      fontSlot.reconfigure(EditorView.theme({ '&': { fontSize: options.fontSize + 'px' } })),
      indentSlot.reconfigure([indentUnit.of(' '.repeat(options.tabSize)), EditorState.tabSize.of(options.tabSize)])
    ] }),
    destroy: () => { observer.disconnect(); view.destroy(); }
  };
  updateCursor(view.state);
  window.NWPUOJBindEditorControls(element, editor);
  return editor;
}
window.NWPUOJInstallCodeEditor(function (element, language, content) {
  try { return createEditor(element, language, content); }
  catch (error) { return window.NWPUOJCreateFallbackEditor(element, language, content); }
});
