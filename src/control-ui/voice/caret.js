/* Where the caret of a focused field is on screen, for voice.js's microphone button. Inputs and textareas are measured with a hidden
 * mirror that copies the field's text box up to the caret; CodeMirror editors and contenteditable elements report it themselves, and a
 * terminal keeps its hidden input on the cursor cell. Returns a viewport rect { left, top, bottom }, or null when there is none. */
(function (global) {
  'use strict';
  const copied = ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch', 'letterSpacing', 'wordSpacing', 'lineHeight', 'textTransform', 'textIndent', 'tabSize', 'direction'];
  let mirror = null;

  function fieldCaret(field) {
    const style = getComputedStyle(field), box = field.getBoundingClientRect();
    mirror ||= Object.assign(document.createElement('div'), { ariaHidden: 'true' });
    for (const name of copied) mirror.style[name] = style[name];
    const area = field instanceof HTMLTextAreaElement;
    Object.assign(mirror.style, { position: 'fixed', left: '0', top: '0', visibility: 'hidden', pointerEvents: 'none', overflow: 'hidden', height: 'auto', whiteSpace: area ? 'pre-wrap' : 'pre', overflowWrap: area ? 'break-word' : 'normal', borderColor: 'transparent' });
    const position = field.selectionDirection === 'backward' ? field.selectionStart : field.selectionEnd;
    const marker = document.createElement('span');
    marker.textContent = '​';
    mirror.replaceChildren(document.createTextNode(field.value.slice(0, position ?? field.value.length)), marker);
    document.body.append(mirror);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 16;
    // A single-line input centres its text vertically; the mirror starts at the top of the content box.
    const shift = area ? 0 : Math.max(0, (field.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - lineHeight) / 2);
    const left = box.left + marker.offsetLeft - field.scrollLeft, top = box.top + marker.offsetTop + shift - field.scrollTop;
    mirror.remove();
    // A caret scrolled out of the field is shown at the field's nearest edge.
    const clampedTop = Math.min(Math.max(top, box.top), box.bottom - lineHeight);
    return { left: Math.min(Math.max(left, box.left), box.right), top: clampedTop, bottom: clampedTop + lineHeight };
  }
  function editableCaret(element) {
    const selection = getSelection();
    if (!selection?.rangeCount || !element.contains(selection.focusNode)) return null;
    const range = document.createRange();
    range.setStart(selection.focusNode, selection.focusOffset); range.collapse(true);
    const rect = range.getClientRects()[0] || (selection.focusNode instanceof Element ? selection.focusNode.getBoundingClientRect() : null);
    return rect && (rect.height || rect.width) ? { left: rect.left, top: rect.top, bottom: rect.bottom } : null;
  }

  function caretRect(element) {
    const editor = element.closest('.CodeMirror')?.CodeMirror;
    if (editor) { const at = editor.cursorCoords(null, 'window'); return { left: at.left, top: at.top, bottom: at.bottom }; }
    if (element.closest('.xterm')) { const rect = element.getBoundingClientRect(); return rect.height ? { left: rect.left, top: rect.top, bottom: rect.bottom } : null; }
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return fieldCaret(element);
    return element.isContentEditable ? editableCaret(element) : null;
  }
  global.AIWSVoiceCaret = Object.freeze({ caretRect });
})(window);
