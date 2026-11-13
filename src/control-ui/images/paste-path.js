/* A pasted image in any plain text field is saved and its file path typed instead. */
(function () {
  'use strict';
  const { data, mentionPath } = window.AIWSImages;
  // A pasted image in any plain text field is saved and its file path typed at the caret.
  // CodeMirror editors upload to Markdown and the AI composer attaches chips; both call preventDefault first.
  function pathField(target) {
    const field = target?.closest?.('textarea, input');
    if (!field || field.closest('.CodeMirror, .xterm, .terminal-instance') || field.readOnly || field.disabled) return null;
    return field.tagName === 'TEXTAREA' || ['text', 'search', 'url', ''].includes(field.type) ? field : null;
  }
  function insertFieldText(field, value) {
    const start = field.selectionStart ?? field.value.length, end = field.selectionEnd ?? start;
    const before = field.value.slice(0, start), text = `${before && !/\s$/.test(before) ? ' ' : ''}${mentionPath(value)} `;
    field.setRangeText(text, start, end, 'end'); field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  document.addEventListener('paste', async event => {
    if (event.defaultPrevented) return;
    const field = pathField(event.target);
    const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
    // Copied text (for example from an office document) still pastes as usual.
    if (!field || !files.length || !api || event.clipboardData.getData('text/plain')) return;
    event.preventDefault();
    try {
      for (const file of files) {
        const project = projectScope?.();
        const saved = await api('/attachments', 'POST', { data: await data(file), ...(project ? { projectId: project } : {}) });
        insertFieldText(field, saved.path);
      }
    } catch (error) { onPathError?.(error); }
  });
  let api = null, projectScope = null, onPathError = null;
  /** Wires text-field image pastes to the control API; app/image-setup.js calls it once. */
  function configurePaths(options) { ({ api, projectId: projectScope, onError: onPathError } = options); }
  Object.assign(window.AIWSImages, { configurePaths });
})();
