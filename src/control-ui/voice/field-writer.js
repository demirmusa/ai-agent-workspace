/* Typing a dictation into the focused field for voice.js: each utterance is written at the caret and rewritten in place while the
 * speech service refines it, without repeating words the user already has; CodeMirror editors, inputs, textareas,
 * contenteditable elements and terminals are supported. */
(function (global) {
  'use strict';
  const editorOf = element => element.closest('.CodeMirror')?.CodeMirror || null;
  const spaced = (before, text) => (before && !/\s$/.test(before) ? ' ' : '') + text;
  const cleanWords = value => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, '').replace(/\s+/g, ' ').trim();
  function insertUtterance(target, text) {
    if (!text) return null;
    // A terminal cannot be rewritten in place: like contenteditable, later refinements only add their new words.
    const terminal = global.AIWSTerminal?.inputOf(target);
    if (terminal) { terminal.typeText(spaced(terminal.lastInput().replace(/[\x00-\x1f\x7f]$/, ' '), text)); return null; }
    const editor = editorOf(target);
    if (editor) {
      const from = editor.getCursor('from'), to = editor.getCursor('to');
      const out = spaced(editor.getRange({ line: 0, ch: 0 }, from), text);
      editor.replaceRange(out, from, to);
      return { range: { from, to: editor.getCursor('to') }, written: out };
    }
    if (target.isContentEditable && !('value' in target)) {
      target.focus(); const before = global.getSelection()?.anchorNode?.textContent?.slice(0, global.getSelection().anchorOffset) ?? '';
      document.execCommand('insertText', false, spaced(before, text));
      return null;
    }
    const start = target.selectionStart ?? target.value.length, end = target.selectionEnd ?? start;
    const out = spaced(target.value.slice(0, start), text);
    target.setRangeText(out, start, end, 'end');
    target.dispatchEvent(new Event('input', { bubbles: true }));
    return { range: { start, end: start + out.length }, written: out };
  }
  function replaceUtterance(target, range, written, text) {
    if (!range || !text) return null;
    const editor = editorOf(target);
    if (editor) {
      if (!range.from || !range.to || editor.getRange(range.from, range.to) !== written) return null;
      const out = spaced(editor.getRange({ line: 0, ch: 0 }, range.from), text);
      if (out !== written) { editor.replaceRange(out, range.from, range.to); range.to = editor.getCursor('to'); }
      return { range, written: out };
    }
    if (typeof range.start !== 'number' || typeof range.end !== 'number' || !('value' in target) || target.value.slice(range.start, range.end) !== written) return null;
    const out = spaced(target.value.slice(0, range.start), text);
    if (out !== written) {
      target.setRangeText(out, range.start, range.end, 'end');
      target.dispatchEvent(new Event('input', { bubbles: true }));
      range.end = range.start + out.length;
    }
    return { range, written: out };
  }
  /** When the user edited the field mid-utterance, finds only the new words beyond what was already typed. */
  function suffixAfterDone(done, text) {
    const doneWords = done.trim().split(/\s+/).filter(Boolean), textWords = text.trim().split(/\s+/).filter(Boolean);
    const norm = word => word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    let matched = 0;
    while (matched < doneWords.length && matched < textWords.length && norm(doneWords[matched]) === norm(textWords[matched])) matched++;
    if (matched > 0) return textWords.slice(matched).join(' ');
    for (let overlap = Math.min(doneWords.length, textWords.length); overlap >= 1; overlap--) {
      if (doneWords.slice(-overlap).every((word, idx) => norm(word) === norm(textWords[idx]))) return textWords.slice(overlap).join(' ');
    }
    return '';
  }
  /** Updates the active utterance in place, or appends a new utterance at the caret without repeating prior words. */
  function write(current, rawText, final) {
    const text = String(rawText ?? '').trim();
    if (!text) return;
    if (current.skipUtterance) { if (final) current.skipUtterance = false; return; }
    const words = cleanWords(text);
    // Ignore post-endpoint or post-CloseStream echoes of the phrase that just finished.
    if (!current.range && !current.done && current.lastFinal && words && words === cleanWords(current.lastFinal)) {
      if (text !== current.lastFinal && current.lastFinalRange) {
        const updated = replaceUtterance(current.target, current.lastFinalRange, current.lastFinalWritten, text);
        if (updated) { current.lastFinal = text; current.lastFinalRange = updated.range; current.lastFinalWritten = updated.written; }
      }
      return;
    }
    let tracked = current.range ? replaceUtterance(current.target, current.range, current.written, text) : null;
    if (!tracked) {
      const delta = current.done ? suffixAfterDone(current.done, text) : text;
      tracked = delta ? insertUtterance(current.target, delta) : null;
    }
    if (tracked) { current.range = tracked.range; current.written = tracked.written; }
    current.done = text; current.hadTranscript = true;
    if (final) {
      current.lastFinal = text; current.lastFinalRange = current.range; current.lastFinalWritten = current.written;
      current.done = ''; current.range = null; current.written = '';
    }
  }
  function flushHeard(current) { if (current.heard) { const text = current.heard; current.heard = ''; write(current, text, false); } }
  global.AIWSVoiceWriter = Object.freeze({ write, flushHeard });
})(window);
