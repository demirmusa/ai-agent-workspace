/* The console's real CLI pane: data.onMountTerminal(run, host) mounts the actual terminal once per PTY run and may return (or resolve)
 * an adapter {update(run), resize(), scrollToBottom(), onViewportChange(fn), destroy()}; no JSON/ANSI terminal emulation here. */
(function (global) {
  'use strict';
  const kit = global.AIWSConversationKit;
  /** Owns the pane inside ctx.root; `ctx` gives the live data, destroyed and onViewport() (called when the terminal scrolls). */
  function nativeTerminal(ctx) {
    const pane = ctx.root.querySelector('.cv-native-terminal'), host = pane.querySelector('.cv-terminal-host'), notice = pane.querySelector('.cv-terminal-notice');
    let terminalId = null, adapter = null, cleanup = null, generation = 0, viewport = { atBottom: true, changes: 0, revision: null };
    const attach = (next, token) => {
      if (ctx.destroyed || token !== generation) { next?.destroy?.(); return; }
      adapter = next;
      const subscription = next?.onViewportChange?.(view => {
        if (ctx.destroyed || token !== generation) return;
        const changed = viewport.revision !== null && view.revision !== undefined && view.revision !== viewport.revision;
        viewport.atBottom = view.atBottom !== false; if (viewport.atBottom) viewport.changes = 0; else if (changed) viewport.changes = 1;
        if (view.revision !== undefined) viewport.revision = view.revision;
        ctx.onViewport();
      });
      cleanup = typeof subscription === 'function' ? subscription : () => subscription?.dispose?.();
      next?.resize?.();
    };
    function release() { generation++; cleanup?.(); cleanup = null; adapter?.destroy?.(); adapter = null; viewport = { atBottom: true, changes: 0, revision: null }; }
    /** Mounts the terminal of `chosen` (a PTY run, or null) when it differs from the mounted one; returns whether it changed. */
    function mount(chosen) {
      const nextId = chosen?.id || null; if (nextId === terminalId) return false;
      release(); terminalId = nextId; host.replaceChildren();
      if (chosen && ctx.data.onMountTerminal) {
        const token = generation;
        try {
          const mounted = ctx.data.onMountTerminal(chosen, host);
          if (mounted?.then) mounted.then(next => attach(next, token)).catch(error => { if (!ctx.destroyed && token === generation) notice.textContent = error?.message || globalThis.AIWSI18n.text('Terminal açılamadı.'); });
          else attach(mounted, token);
        } catch (error) { host.textContent = error?.message || globalThis.AIWSI18n.text('Terminal açılamadı.'); }
      }
      return true;
    }
    /** Passes the run to the adapter and fits it while it is the visible view. */
    function update(chosen, shown) { adapter?.update?.(chosen); if (shown) { try { adapter?.resize?.(); } catch { /* A hidden console is fitted when attached again. */ } } }
    function scrollToBottom() { adapter?.scrollToBottom?.(); viewport.atBottom = true; viewport.changes = 0; }
    return { pane, notice, mount, update, scrollToBottom, get viewport() { return viewport; }, destroy: release };
  }
  Object.assign(kit, { nativeTerminal });
})(globalThis);
