/* The console composer: sends an instruction to the agent (Ctrl/Cmd+Enter), interrupts it (Esc or Durdur) or delivers the queued
 * message now, and grows every console textarea with its text without making the thread jump. */
(function (global) {
  'use strict';
  const kit = global.AIWSConversationKit;
  /** Wires the composer form inside ctx.root. `ctx` gives root, scroll and the live data, viewReadOnly and selectedAgentId. */
  function composer(ctx) {
    const { root, scroll } = ctx, form = root.querySelector('.cv-composer'), draft = form.querySelector('textarea'), sendError = root.querySelector('.cv-send-error');
    const submit = form.querySelector('button[type=submit]'), interruptButton = form.querySelector('.cv-interrupt'), deliverButton = form.querySelector('.cv-deliver-now'), hint = root.querySelector('.cv-composer-hint');
    // Inputs grow with their text up to the CSS max-height, so a short reply stays one line.
    // Collapsing to auto shrinks the dock and makes the browser clamp scroll.scrollTop, so the thread would jump; keep the gap to the bottom.
    const grow = area => {
      if (!area?.matches?.('textarea')) return;
      const gap = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop;
      area.style.height = 'auto'; if (area.scrollHeight) area.style.height = `${area.scrollHeight + 2}px`;
      scroll.scrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight - gap);
    };
    root.addEventListener('input', event => grow(event.target));
    const fail = (error, fallback) => { sendError.textContent = error?.message || globalThis.AIWSI18n.text(fallback); sendError.hidden = false; };
    form.addEventListener('submit', async event => {
      const data = ctx.data;
      event.preventDefault(); const text = draft.value.trim(); if (!text && !data.sendWithoutText || ctx.viewReadOnly || ctx.selectedAgentId || data.composerDisabled || !data.onSendMessage || form.dataset.busy) return;
      form.dataset.busy = 'true'; submit.disabled = true; sendError.hidden = true;
      try { await data.onSendMessage(text); if (draft.value.trim() === text) { draft.value = ''; grow(draft); } }
      catch (error) { fail(error, 'Mesaj gönderilemedi.'); }
      finally { delete form.dataset.busy; submit.disabled = Boolean(ctx.data.composerDisabled); }
    });
    const interrupt = async () => { if (!ctx.data.onInterrupt || interruptButton.hidden) return; try { sendError.hidden = true; await ctx.data.onInterrupt(); } catch (error) { fail(error, 'Durdurulamadı.'); } };
    interruptButton.addEventListener('click', interrupt);
    deliverButton.addEventListener('click', async () => { if (!ctx.data.onDeliverNow) return; try { sendError.hidden = true; await ctx.data.onDeliverNow(); } catch (error) { fail(error, 'Gönderilemedi.'); } });
    // Escape interrupts only from the draft and only while there is a run to stop; anywhere else in the console (a question's reply,
    // the native terminal) and with nothing running it stays the page's, which closes the panel.
    draft.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.defaultPrevented && ctx.data.onInterrupt && !interruptButton.hidden) { event.preventDefault(); void interrupt(); }
      else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); form.requestSubmit(); }
    });
    /** Shows the composer unless the view is read-only, a request's reply box is open or the live CLI takes the input. */
    function render({ chosen, mode, answering }) {
      const data = ctx.data;
      // A pending question's reply box is the only input; a second composer under it would compete with it.
      form.hidden = Boolean(ctx.viewReadOnly || answering || chosen && mode === 'terminal' && ['running', 'waiting'].includes(chosen.status) || !data.onSendMessage && !data.composerDisabled);
      draft.disabled = Boolean(data.composerDisabled); draft.required = !data.sendWithoutText;
      interruptButton.hidden = !data.onInterrupt; deliverButton.hidden = !data.onDeliverNow; submit.disabled = Boolean(data.composerDisabled || form.dataset.busy);
      const sendLabel = data.sendLabel || globalThis.AIWSI18n.text('Gönder ↗'); if (submit.textContent !== sendLabel) submit.textContent = sendLabel;
      if (data.sendTitle) submit.title = data.sendTitle; else submit.removeAttribute('title');
      if (data.composerHint) { if (hint.textContent !== data.composerHint) hint.textContent = data.composerHint; }
      else hint.innerHTML = chosen ? globalThis.AIWSI18n.text('Görev notu olarak kaydedilir · CLI komutlarını terminale yazabilirsin.') : globalThis.AIWSI18n.text('Göreve kaydedilir · Anında iletilir <kbd>Ctrl ↵</kbd> · Durdurmak için <kbd>Esc</kbd>');
    }
    return { render };
  }
  Object.assign(kit, { composer });
})(globalThis);
