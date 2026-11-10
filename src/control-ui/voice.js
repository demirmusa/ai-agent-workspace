/* Dictation in every text field and live terminal. Ctrl/Cmd + Shift + M in a focused field, or the microphone button that appears next to
 * it, streams the microphone to the control server (/api/voice), which relays it to the speech service of the provider chosen in the
 * application settings; the transcript is typed into the field at the caret while a waveform shows that it is listening. The same
 * shortcut, Esc or Enter stops it; what was heard is already typed. The field keeps focus the whole time: the button never takes it.
 * app/voice-setup.js calls AIWSVoice.setup once; the wiki page Terminals-Files-and-Voice describes the feature. */
(function (global) {
  'use strict';
  const { providerIcon, icon } = global.AIWSUI, t = global.AIWSI18n, { write, flushHeard } = global.AIWSVoiceWriter, { caretRect } = global.AIWSVoiceCaret;
  const BARS = 9, FINISH_WAIT = 4000, SETTLE_WAIT = 1200;
  const textTypes = new Set(['text', 'search', 'url', 'email', 'tel']);
  let host = { provider: () => '', token: () => '', toast: () => {} };
  let panel = null, button = null, buttonTarget = null, buttonTimer = 0, session = null;
  /** Typing tells that the microphone is not wanted: the button fades out until a field is clicked with the mouse. */
  let typing = false;

  /** The element the panel sits under: CodeMirror editors and terminals keep their focus in a hidden textarea. */
  const anchorOf = element => element.closest('.CodeMirror, .xterm') || element;
  function eligible(element) {
    if (!(element instanceof HTMLElement) || element.closest('[data-voice="off"], #voice-panel, #voice-button') || element.readOnly || element.disabled) return false;
    if (element.closest('.xterm')) return Boolean(global.AIWSTerminal?.inputOf(element));
    if (element instanceof HTMLTextAreaElement) return true;
    if (element instanceof HTMLInputElement) return textTypes.has(element.type);
    return element.isContentEditable;
  }
  const supported = () => Boolean(navigator.mediaDevices?.getUserMedia && global.AudioContext && global.WebSocket);

  function renderProvider(provider = host.provider()) {
    const slot = panel?.querySelector('.voice-provider');
    if (!slot) return;
    slot.dataset.provider = provider || '';
    slot.innerHTML = provider ? providerIcon(provider) : '';
  }
  function ensureElements() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'voice-panel'; panel.className = 'voice-panel popup-menu'; panel.popover = 'manual'; panel.setAttribute('role', 'status'); panel.setAttribute('aria-live', 'polite');
    panel.innerHTML = `<span class="voice-provider"></span><span class="voice-wave" aria-hidden="true">${'<i></i>'.repeat(BARS)}</span>`;
    button = document.createElement('button');
    button.id = 'voice-button'; button.type = 'button'; button.className = 'voice-button popup-menu'; button.popover = 'manual'; button.tabIndex = -1;
    button.title = t.text('Sesle yaz (Ctrl + Shift + M)'); button.setAttribute('aria-label', t.text('Sesle yaz'));
    button.innerHTML = icon('mic');
    // Pressing the button must neither take the focus from the field it types into nor read as a click outside the panel holding it.
    for (const type of ['pointerdown', 'mousedown']) button.addEventListener(type, event => { event.preventDefault(); event.stopPropagation(); });
    button.addEventListener('click', event => { event.preventDefault(); const target = buttonTarget; hideButton(); if (target?.isConnected) void start(target); });
    document.body.append(panel, button);
    renderProvider();
  }

  // The panel and the button are popovers so they stay above an open modal dialog (top layer). A modal dialog makes everything outside it
  // inert, the top layer included, so they move into the open dialog holding their field (back to the body otherwise) before they show.
  const adopt = (element, target) => { const parent = anchorOf(target).closest('dialog[open]') || document.body; if (element.parentElement !== parent) parent.append(element); };
  const show = (element, on) => { if (on !== element.matches(':popover-open')) { if (on) element.showPopover(); else element.hidePopover(); } };
  const restack = element => { if (element.matches(':popover-open')) element.hidePopover(); element.showPopover(); };
  /** Puts a popover under a rect (above it when there is no room, inside its bottom edge when neither fits), never off screen. The
   *  panel is centred on its field; the button starts at the caret. Hides the popover while the rect is out of view. */
  function placeAt(element, rect, align) {
    const gap = 6;
    if (!rect || rect.bottom - rect.top <= 0 || rect.bottom < 0 || rect.top > innerHeight) { show(element, false); return; }
    show(element, true);
    const width = element.offsetWidth, height = element.offsetHeight;
    const top = rect.bottom + gap + height <= innerHeight ? rect.bottom + gap : rect.top - height - gap >= 0 ? rect.top - height - gap : Math.min(innerHeight, rect.bottom) - height - gap;
    const left = align === 'caret' ? rect.left - width / 2 : rect.left + (rect.right - rect.left - width) / 2;
    element.style.left = `${Math.max(gap, Math.min(innerWidth - width - gap, left))}px`;
    element.style.top = `${Math.max(gap, top)}px`;
  }
  const fieldRect = target => { const rect = anchorOf(target).getBoundingClientRect(); return rect.width && rect.height ? rect : null; };
  /** The button sits right under the caret; a field whose caret cannot be measured gets it under its right end. */
  function placeButton() {
    const field = fieldRect(buttonTarget), caret = field && caretRect(buttonTarget);
    placeAt(button, caret || (field && { left: field.right - button.offsetWidth / 2, top: field.top, bottom: field.bottom }), 'caret');
  }
  function place() {
    if (buttonTarget) { if (buttonTarget.isConnected && document.activeElement === buttonTarget) placeButton(); else hideButton(); }
    if (!session) return;
    if (!session.target.isConnected) { cancel(); return; }
    placeAt(panel, fieldRect(session.target), 'center');
  }
  // Typing and clicking move the caret, so the button is moved once per frame after them.
  let placeFrame = 0;
  const placeSoon = () => { if (buttonTarget && !placeFrame) placeFrame = requestAnimationFrame(() => { placeFrame = 0; place(); }); };

  // ---- Microphone button ----
  /** Offers the button next to a focused field while no dictation runs. */
  function offerButton(target) {
    if (session || !host.provider() || !supported() || !eligible(target)) { hideButton(); return; }
    ensureElements();
    if (buttonTarget !== target) { buttonTarget = target; adopt(button, target); restack(button); }
    // The field can grow, move or leave the page and a terminal's cursor can move without any event here (a modal closing on Enter,
    // program output), so the button also checks its place regularly.
    buttonTimer ||= setInterval(place, 250);
    placeButton();
  }
  function hideButton() { if (!buttonTarget) return; buttonTarget = null; clearInterval(buttonTimer); buttonTimer = 0; show(button, false); }
  function setTyping(on) { typing = on; button?.classList.toggle('is-away', on); }

  // ---- One dictation ----
  const failureText = error => ['NotAllowedError', 'SecurityError'].includes(error?.name) ? 'Mikrofon izni verilmedi.'
    : ['NotFoundError', 'OverconstrainedError'].includes(error?.name) ? 'Mikrofon bulunamadı.'
    : error?.name === 'NotReadableError' ? 'Mikrofon başka bir uygulama tarafından kullanılıyor.' : 'Ses tanıma kullanılamıyor.';
  async function start(target) {
    const provider = host.provider();
    if (session || !provider || !supported()) return;
    ensureElements(); renderProvider(provider); hideButton(); setTyping(false);
    const current = session = { target, provider, socket: null, stream: null, context: null, node: null, ready: false, ending: false, levels: new Array(BARS).fill(0), timer: null, settle: null, heard: '', done: '', range: null, written: '', lastFinal: '', lastFinalRange: null, lastFinalWritten: '', hadTranscript: false, skipUtterance: false };
    panel.dataset.state = 'connecting'; adopt(panel, target); restack(panel); place();
    try {
      current.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (session !== current) { stopCapture(current); return; }
      const query = new URLSearchParams({ provider, language: t.language }), token = host.token();
      if (token) query.set('token', token);
      current.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/voice?${query}`);
      current.socket.binaryType = 'arraybuffer';
      current.socket.onmessage = event => onMessage(current, event);
      current.socket.onclose = () => { if (session === current) end(current); };
      current.socket.onerror = () => { if (session === current && !current.ready) { host.toast(t.text('Ses bağlantısı kurulamadı.')); end(current); } };
      current.context = new AudioContext();
      await current.context.audioWorklet.addModule('/voice-worklet.js');
      if (session !== current) { stopCapture(current); return; }
      current.node = new AudioWorkletNode(current.context, 'voice-capture');
      current.context.createMediaStreamSource(current.stream).connect(current.node);
      // Levels change once per 100 ms frame of audio, so the bars are written when a frame arrives (only the changed ones)
      // rather than on every animation frame of the session; their CSS transition smooths the steps.
      const bars = [...panel.querySelectorAll('.voice-wave i')], shown = [];
      current.node.port.onmessage = event => {
        current.levels.push(Math.min(1, event.data.level * 6)); current.levels.shift();
        if (current.socket?.readyState === WebSocket.OPEN && !current.ending) current.socket.send(event.data.pcm);
        if (session === current) bars.forEach((bar, index) => { const level = current.levels[index]; if (shown[index] !== level) { shown[index] = level; bar.style.setProperty('--level', String(level)); } });
      };
    } catch (error) {
      console.error('Dictation failed to start', error);
      host.toast(t.text(failureText(error)));
      if (session === current) end(current);
    }
  }
  function onMessage(current, event) {
    if (session !== current) return;
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'ready') { current.ready = true; panel.dataset.state = 'listening'; }
    else if (message.type === 'transcript') {
      clearTimeout(current.settle); current.heard = message.final ? '' : message.text;
      if (message.final) write(current, message.text, true);
      // Typing while the user is still talking disturbs the audio: wait for a pause.
      else current.settle = setTimeout(() => flushHeard(current), SETTLE_WAIT);
    } else if (message.type === 'error') { host.toast(message.message); if (!current.ready) end(current); }
    else if (message.type === 'closed') end(current);
    place();
  }
  function stopCapture(current) {
    current.node?.port && (current.node.port.onmessage = null);
    current.stream?.getTracks().forEach(track => track.stop()); void current.context?.close().catch(() => {});
  }
  /** Stops listening, waits briefly for the last words, then closes. */
  function finish() {
    const current = session;
    if (!current || current.ending) return;
    current.ending = true; panel.dataset.state = 'finishing'; stopCapture(current); clearTimeout(current.settle); flushHeard(current);
    if (current.socket?.readyState === WebSocket.OPEN) current.socket.send(JSON.stringify({ type: 'finish' })); else { end(current); return; }
    current.timer = setTimeout(() => end(current), FINISH_WAIT);
  }
  function cancel() { const current = session; if (current) { current.ending = true; end(current); } }
  function end(current) {
    if (session !== current) return;
    session = null; clearTimeout(current.timer); clearTimeout(current.settle); stopCapture(current);
    if (current.socket) { current.socket.onclose = null; current.socket.onmessage = null; try { current.socket.close(); } catch { /* Already closed. */ } }
    show(panel, false); delete panel.dataset.state;
    if (current.target.isConnected && !current.keepFocus) current.target.focus({ preventScroll: true });
    if (document.activeElement === current.target) offerButton(current.target);
  }

  // Ctrl/Cmd + Shift + M starts dictation in the focused field and stops it again.
  document.addEventListener('keydown', event => {
    if (event.code !== 'KeyM' || !event.shiftKey || event.altKey || !(event.ctrlKey || event.metaKey)) return;
    // A handled shortcut must not reach the field's own key handling: a terminal would send Ctrl+M as Enter to its program.
    if (session) {
      event.preventDefault(); event.stopPropagation();
      const previousTarget = session.target, wasEnding = session.ending;
      if (wasEnding) cancel(); else { finish(); return; }
      if (!eligible(document.activeElement) || document.activeElement === previousTarget) return;
    }
    if (!host.provider() || !supported() || !eligible(document.activeElement)) return;
    event.preventDefault(); event.stopPropagation(); void start(document.activeElement);
  }, true);
  // Enter ends dictation at once and keeps its usual effect (sending the message, running the command): what was heard
  // is typed first, and nothing arrives in the field after the key has acted. Shift + Enter stays a line break.
  document.addEventListener('keydown', event => {
    if (!session || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    clearTimeout(session.settle); flushHeard(session);
    session.keepFocus = document.activeElement !== session.target;
    cancel();
  }, true);
  document.addEventListener('keydown', event => {
    if (!session || event.key !== 'Escape') return;
    event.stopPropagation(); event.preventDefault();
    clearTimeout(session.settle); flushHeard(session);
    if (session.ending || session.hadTranscript) cancel(); else finish();
  }, true);
  // Typing in the field (a character, deleting, an IME composition) fades the button out; pressing the mouse anywhere but on the
  // button brings it back for the field it focuses.
  document.addEventListener('keydown', event => {
    if (typing || session || !buttonTarget || event.target !== buttonTarget || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.length === 1 || ['Backspace', 'Delete', 'Process'].includes(event.key) || event.isComposing) setTyping(true);
  }, true);
  document.addEventListener('pointerdown', event => { if (typing && event.button === 0 && !button?.contains(event.target)) setTyping(false); }, true);
  // Without a dictation, focusing a field offers the button; leaving the field takes it away.
  document.addEventListener('focusin', event => { if (!session) offerButton(event.target); });
  document.addEventListener('focusout', event => { if (event.target === buttonTarget) hideButton(); });
  // Dictation follows the field the user clicks into while it runs.
  document.addEventListener('focusin', event => {
    if (!session || session.ending || event.target === session.target || !eligible(event.target)) return;
    clearTimeout(session.settle); flushHeard(session);
    session.skipUtterance = Boolean(session.done);
    session.done = ''; session.range = null; session.written = ''; session.lastFinal = ''; session.lastFinalRange = null; session.lastFinalWritten = '';
    session.target = event.target; adopt(panel, event.target); place();
  });
  for (const type of ['input', 'keyup', 'pointerup', 'selectionchange']) document.addEventListener(type, placeSoon, true);
  addEventListener('resize', place);
  document.addEventListener('scroll', place, true);

  global.AIWSVoice = Object.freeze({
    /** Wires dictation to the app: the chosen provider ('' when none can dictate), the control token and the toast. */
    setup(options) { host = { ...host, ...options }; ensureElements(); renderProvider(); },
    /** Drops a dictation in progress without typing what is still pending. */
    cancel,
    /** Re-evaluates dictation after the provider setting changes. */
    refresh() { renderProvider(); if (!host.provider()) cancel(); if (document.activeElement && !session) offerButton(document.activeElement); },
  });
})(window);
