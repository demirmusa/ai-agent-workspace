(function () {
  // Each visible console owns a view of the same backend PTY. Never move a live
  // xterm textarea between consoles: removing it from the DOM drops its focus.
  //
  // Output is a single character stream per run. Live chunks carry their offset
  // in that stream, so a view can join at any time: it loads the replay (which
  // ends at a known offset) and then applies only the live data after it.
  const views = new Set();
  // Several views can show one PTY, but only one may decide its size. The view
  // the user touched last (or the newest visible one) owns the dimensions.
  const sizeOwners = new Map();
  // The server accepts at most 65536 characters of input per request.
  const INPUT_BATCH = 32768;
  // Output held for a hidden terminal; beyond this the terminal reloads its replay when it is shown again.
  const HELD_LIMIT = 4_000_000;
  function receive(runId, offset, data) {
    for (const view of views) if (view.runId === runId) view.receive(offset, data);
  }
  const ANSI_COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
  // The xterm options that follow the terminal tokens of the application theme (styles.css).
  function themeOptions(host) {
    const style = window.getComputedStyle?.(host);
    const color = name => style?.getPropertyValue(`--terminal${name}`)?.trim() || undefined;
    const theme = { background: color(''), foreground: color('-ink'), cursor: color('-cursor'), selectionBackground: color('-selection') };
    for (const name of ANSI_COLORS) {
      theme[name] = color(`-ansi-${name}`);
      theme[`bright${name[0].toUpperCase()}${name.slice(1)}`] = color(`-ansi-bright-${name}`);
    }
    return { theme, minimumContrastRatio: Number(color('-min-contrast')) || 1 };
  }
  function create(host, { run, output = '', end, load, onInput, onResize, onClear, onImage, onError = () => {} }) {
    const element = host.ownerDocument.createElement('div');
    element.className = 'terminal-instance';
    host.append(element);
    let current = run, replay = '', revision = 0, destroyed = false, frame = null, fitTimer = null, resizeTimer = null;
    let position = 0, replaying = false, replayId = 0, loading = null, queued = [], lastSize = '', sentSize = '', recorded = null;
    let inputQueue = Promise.resolve(), typed = '', typedQueued = false, lastSent = '';
    // A terminal is shown while no ancestor is [hidden] (no layout read) and the resize observer last saw it with a size.
    let sized = true, held = [], heldSize = 0, heldReload = false;
    const shown = () => sized && !host.closest('[hidden]');
    const listeners = new Set(), subscriptions = [];
    const terminal = window.Terminal ? new window.Terminal({
      cursorBlink: true, convertEol: run.terminalMode !== 'pty',
      fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, monospace', fontSize: 12, scrollback: 5000,
      ...themeOptions(host),
    }) : null;
    // Theme switches and plugin themes repaint the terminal without touching its contents.
    const themeObserver = terminal && window.MutationObserver ? new window.MutationObserver(() => Object.assign(terminal.options, themeOptions(host))) : null;
    themeObserver?.observe(host.ownerDocument.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-plugin-theme'] });
    const fit = terminal && window.FitAddon?.FitAddon ? new window.FitAddon.FitAddon() : null;
    const interactive = () => current.terminalMode === 'pty' && ['running', 'waiting'].includes(current.status);
    const visible = () => !destroyed && sized && element.isConnected && !element.closest('[hidden]');
    const viewport = () => {
      const buffer = terminal?.buffer?.active;
      return { atBottom: !buffer || buffer.viewportY >= buffer.baseY, revision };
    };
    const publish = () => { for (const listener of listeners) listener(viewport()); };
    // Tell the PTY the final size only after the layout settles: every resize makes
    // a TUI repaint the whole screen, and racing repaints garble the output.
    const sendSize = () => {
      resizeTimer = null;
      if (!visible() || !interactive() || !lastSize) return;
      // Another window showing the same PTY must not resize it while the user works elsewhere.
      if (!host.ownerDocument.hasFocus()) return;
      const owner = sizeOwners.get(current.id);
      if (owner && owner !== api && owner.visible()) return;
      if (owner !== api) { sizeOwners.set(current.id, api); sentSize = ''; }
      if (lastSize === sentSize) return;
      sentSize = lastSize;
      const [cols, rows] = lastSize.split('x').map(Number);
      Promise.resolve(onResize?.({ cols, rows })).catch(() => { if (sentSize === `${cols}x${rows}`) sentSize = ''; });
    };
    const scheduleSize = (delay = 150) => { clearTimeout(resizeTimer); resizeTimer = setTimeout(sendSize, delay); };
    const resize = () => {
      if (shown()) flushHeld();
      if (!visible() || replaying) return;
      // A finished run's output was drawn for the PTY's own size; refitting it to the panel garbles the TUI.
      if (recorded && !interactive()) { try { if (terminal.cols !== recorded.cols || terminal.rows !== recorded.rows) terminal.resize(recorded.cols, recorded.rows); } catch { /* Resize again once the console has a layout. */ } return; }
      try { fit?.fit(); } catch { /* Fit again once the console has a layout. */ }
      if (terminal?.cols && terminal?.rows) lastSize = `${terminal.cols}x${terminal.rows}`;
      if (interactive() && lastSize && lastSize !== sentSize) scheduleSize();
    };
    // Fitting reflows the whole scrollback; while a panel is dragged, fit at most
    // every few frames and once more when the size settles.
    const scheduleResize = () => {
      if (frame !== null || destroyed) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (fitTimer === null) { resize(); fitTimer = setTimeout(() => { fitTimer = null; resize(); }, 90); }
      });
    };
    const claimSize = () => {
      if (!interactive()) return;
      if (sizeOwners.get(current.id) !== api) { sizeOwners.set(current.id, api); sentSize = ''; }
      if (lastSize && lastSize !== sentSize) scheduleSize(0);
    };
    // HTTP requests can complete out of order. Keep keystrokes and escape
    // sequences in the order in which they were produced. Keys typed while a
    // request is in flight go out together in the next one instead of one round trip each.
    const send = data => {
      if (!interactive() || destroyed) return;
      if (sizeOwners.get(current.id) !== api) claimSize();
      lastSent = data;
      typed += data;
      if (typedQueued) return;
      typedQueued = true;
      inputQueue = inputQueue.then(async () => {
        while (typed && !destroyed && interactive()) {
          const next = typed.slice(0, INPUT_BATCH); typed = typed.slice(next.length);
          await onInput(next);
        }
      }).catch(error => onError(error)).finally(() => { typed = ''; typedQueued = false; });
    };
    const focus = event => { if (event.button === 0 && interactive()) { claimSize(); terminal?.focus(); } };
    host.addEventListener('pointerdown', focus);
    // A pasted image is not typed into the PTY: it is uploaded and its local path is typed instead,
    // with a thumbnail strip that opens the image full size.
    let removePreview = null;
    const pasteImage = event => {
      const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
      if (!files.length || !onImage || !interactive()) return;
      // Copied text (for example from an office document) still pastes as usual.
      if (event.clipboardData?.getData?.('text/plain')) return;
      event.preventDefault(); event.stopImmediatePropagation();
      removePreview?.(); removePreview = window.AIWSImages?.pastePreview?.(element, files) || null;
      inputQueue = inputQueue.then(async () => {
        for (const file of files) {
          const path = await onImage(file);
          if (!destroyed && interactive()) await onInput('"' + path.replace(/[\r\n\x00-\x1f\x7f]/g, '') + '" ');
        }
      }).catch(onError);
    };
    host.addEventListener('paste', pasteImage, true);
    // A file dragged from the files panel types its absolute path at the cursor, quoted when needed.
    const draggedFile = event => interactive() && event.dataTransfer?.types?.includes?.(window.AIWSFiles?.absolutePathType);
    const dragOver = event => {
      if (!draggedFile(event)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy';
      element.classList.add('path-drop-target');
    };
    const dragLeave = event => { if (!element.contains(event.relatedTarget)) element.classList.remove('path-drop-target'); };
    const dropPath = event => {
      element.classList.remove('path-drop-target');
      if (!draggedFile(event)) return;
      event.preventDefault(); event.stopPropagation();
      const path = event.dataTransfer.getData(window.AIWSFiles.absolutePathType).replace(/[\r\n\x00-\x1f\x7f]/g, '');
      if (!path) return;
      claimSize(); terminal?.focus();
      const text = (/[\s"'`$&|;<>()[\]{}^%!,]/.test(path) ? `"${path}"` : path) + ' ';
      inputQueue = inputQueue.then(() => { if (!destroyed && interactive()) return onInput(text); }).catch(onError);
    };
    host.addEventListener('dragover', dragOver, true); host.addEventListener('dragleave', dragLeave, true); host.addEventListener('drop', dropPath, true);
    if (terminal) {
      if (fit) terminal.loadAddon(fit);
      terminal.open(element);
      // Let the browser dispatch copy and paste to xterm's clipboard handlers.
      // With no selection Ctrl+C still reaches the PTY as an interrupt; Ctrl+V
      // would otherwise be sent as a literal ^V and the paste event never fires.
      terminal.attachCustomKeyEventHandler?.(event => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return true;
        const key = event.key.toLowerCase();
        if (key === 'v') return false;
        return !(key === 'c' && terminal.hasSelection?.());
      });
      subscriptions.push(terminal.onData(send));
      subscriptions.push(terminal.onResize(size => {
        lastSize = `${size.cols}x${size.rows}`;
        if (interactive()) scheduleSize();
      }));
      subscriptions.push(terminal.onScroll?.(publish), terminal.onWriteParsed?.(publish));
    }
    // A terminal without a layout box (a hidden tab, a cached console) holds its writes: xterm redraws every row on
    // each scroll and, at zero width, re-measures every glyph with a forced layout of the whole page. The held work
    // runs in order once the terminal is shown again (its next size report, write or update); past HELD_LIMIT characters a
    // reload replaces it.
    const flushHeld = () => {
      if (!held.length && !heldReload) return;
      const pending = held; held = []; heldSize = 0;
      if (heldReload) { heldReload = false; reload(); return; }
      for (const operation of pending) if (!destroyed) operation();
    };
    const xterm = (operation, size = 0) => {
      if (destroyed) return;
      if (shown()) { flushHeld(); return operation(); }
      if (heldReload) return;
      heldSize += size;
      if (load && heldSize > HELD_LIMIT) { held = []; heldSize = 0; heldReload = true; return; }
      held.push(operation);
    };
    const observer = window.ResizeObserver ? new window.ResizeObserver(entries => {
      const box = entries.at(-1)?.contentRect;
      sized = Boolean(box && box.width > 0 && box.height > 0);
      if (shown()) flushHeld();
      scheduleResize();
    }) : null;
    observer?.observe(host);
    window.addEventListener('resize', scheduleResize);
    // The window the user returns to takes the PTY size back from the other window.
    const refocus = () => { if (visible() && interactive()) { sentSize = ''; scheduleSize(0); } };
    window.addEventListener('focus', refocus);
    const renderFallback = () => {
      let pre = element.querySelector('pre');
      if (!pre) { pre = host.ownerDocument.createElement('pre'); pre.className = 'terminal-fallback'; element.append(pre); }
      pre.textContent = replay || globalThis.AIWSI18n.text(loading ? 'Terminal yükleniyor…' : 'Henüz terminal çıktısı yok.');
    };
    const write = data => {
      if (destroyed || !data) return;
      revision++;
      if (terminal) xterm(() => terminal.write(data), data.length);
      else { replay = (replay + data).slice(-1_000_000); renderFallback(); }
    };
    // A TUI is redrawn at whatever size the PTY had; replaying it all at the final size garbles every earlier frame.
    const replayWithSizes = (output, start, resizes) => {
      const initial = resizes.filter(item => item.offset <= start).at(-1) || resizes[0];
      const steps = resizes.filter(item => item.offset > start && item.offset < start + output.length);
      revision++; const token = ++replayId; replaying = true;
      const done = () => { if (replayId === token || destroyed) replaying = false; if (!destroyed) resize(); };
      const run = (index, from) => {
        if (destroyed || replayId !== token) return done();
        if (index >= steps.length) { terminal.write(output.slice(from), done); return; }
        const step = steps[index], at = step.offset - start;
        terminal.write(output.slice(from, at), () => {
          if (destroyed || replayId !== token) return done();
          try { terminal.resize(step.cols, step.rows); } catch { /* Keep the current size. */ }
          run(index + 1, at);
        });
      };
      xterm(() => {
        try { terminal.resize(initial.cols, initial.rows); } catch { /* Keep the current size. */ }
        run(0, 0);
      }, output.length);
    };
    const reset = (output, endOffset, resizes) => {
      replayId++; replaying = false; held = []; heldSize = 0; heldReload = false;
      if (revision && terminal) xterm(() => terminal.reset?.());
      replay = ''; position = Number.isFinite(endOffset) ? endOffset : output.length;
      if (terminal && recorded && !interactive() && resizes?.length > 1 && output) { replayWithSizes(output, position - output.length, resizes); return; }
      write(output); if (!terminal) renderFallback();
    };
    const receive = (offset, data) => {
      if (destroyed || !data) return;
      if (!Number.isFinite(offset)) { position += data.length; write(data); return; }
      if (loading) { queued.push([offset, data]); return; }
      const finish = offset + data.length;
      if (finish <= position) return; // Already part of the replay.
      if (offset > position) { reload(); return; } // A chunk was missed: start over from the replay.
      const fresh = data.slice(position - offset);
      position = finish; write(fresh);
    };
    const reload = () => {
      if (!load || destroyed) return;
      const request = loading = Promise.resolve().then(load).then(snapshot => {
        if (destroyed || loading !== request) return;
        loading = null; recorded = Number.isInteger(snapshot.cols) && Number.isInteger(snapshot.rows) ? { cols: snapshot.cols, rows: snapshot.rows } : null;
        element.classList.toggle('terminal-recorded', Boolean(recorded) && !interactive());
        if (recorded && !interactive()) resize();
        reset(snapshot.output || '', snapshot.end, snapshot.resizes);
        const pending = queued; queued = [];
        for (const [offset, data] of pending) receive(offset, data);
      }).catch(error => { if (loading === request) { loading = null; queued = []; onError(error); } });
      if (!terminal) renderFallback();
    };
    const update = (next) => {
      if (destroyed) return;
      const wasInteractive = interactive();
      current = next;
      if (shown()) flushHeld();
      element.classList.toggle('terminal-recorded', Boolean(recorded) && !interactive());
      if (terminal?.options) terminal.options.disableStdin = !interactive();
      if (!terminal) renderFallback();
      if (!wasInteractive && interactive() && lastSize) scheduleSize(0);
      scheduleResize();
    };
    const api = {
      // resize() is batched to the next frame and throttled while a layout is animating.
      element, terminal, fit, runId: run.id, update, write, resize: scheduleResize, fitNow: resize, receive, reload, visible, interactive,
      /** Text typed for the user (dictation), in order with their keystrokes; the last input tells whether a space is needed. */
      typeText(text) { send(text.replace(/[\x00-\x1f\x7f]+/g, ' ')); },
      lastInput: () => lastSent,
      scrollToBottom() { terminal?.scrollToBottom(); },
      /** Clears the console and the PTY's screen together, so the program goes on drawing from the top. */
      clear() { terminal?.clear(); if (interactive()) Promise.resolve(onClear?.()).catch(() => {}); terminal?.focus(); },
      onViewportChange(listener) { listeners.add(listener); listener(viewport()); return () => listeners.delete(listener); },
      destroy() {
        if (destroyed) return;
        destroyed = true; views.delete(api); removePreview?.();
        if (sizeOwners.get(current.id) === api) sizeOwners.delete(current.id);
        if (frame !== null) cancelAnimationFrame(frame);
        clearTimeout(fitTimer); clearTimeout(resizeTimer);
        observer?.disconnect(); themeObserver?.disconnect(); window.removeEventListener('resize', scheduleResize); window.removeEventListener('focus', refocus);
        host.removeEventListener('pointerdown', focus); host.removeEventListener('paste', pasteImage, true);
        host.removeEventListener('dragover', dragOver, true); host.removeEventListener('dragleave', dragLeave, true); host.removeEventListener('drop', dropPath, true);
        for (const subscription of subscriptions) subscription?.dispose?.();
        listeners.clear(); terminal?.dispose(); element.remove();
      },
    };
    views.add(api);
    if (load) { loading = null; reload(); } else reset(output, end);
    update(run);
    // The newest console takes over the PTY size unless the user is typing elsewhere.
    if (interactive() && !sizeOwners.get(run.id)?.visible()) sizeOwners.set(run.id, api);
    return api;
  }
  /** The live terminal view that a focused element belongs to and accepts input, if any. */
  const inputOf = element => [...views].find(view => view.element.contains(element) && view.interactive()) || null;
  window.AIWSTerminal = { create, receive, inputOf };
})();
