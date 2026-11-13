'use strict';
// Toasts and the error banner.
let toastTimer,errorTimer;
/** Shows a short message. `action` ({label, run}) adds a button that runs once and hides the toast; the toast then stays longer. */
function toast(message, action) {
  const host = $('#toast'); host.textContent = message; clearTimeout(toastTimer);
  if (action) { const button = document.createElement('button'); button.type = 'button'; button.className = 'toast-action'; button.textContent = action.label; button.onclick = () => { clearTimeout(toastTimer); host.hidden = true; void action.run(); }; host.append(' ', button); }
  host.hidden = false; toastTimer = setTimeout(() => host.hidden = true, action ? 8000 : 4500);
}
/** The toast action that reverses a change: sends `request`, then reads the state again. */
const undoAction = request => ({ label: globalThis.AIWSI18n.text('Geri al'), run: async () => { try { await request(); toast(globalThis.AIWSI18n.text('Geri alındı')); } catch (problem) { error(problem.message); } await refresh(); } });
function dismissError() { clearTimeout(errorTimer); errorTimer = undefined; $('#error-banner').hidden = true; }
function error(message) {
  clearTimeout(errorTimer);
  $('#error-banner').innerHTML = globalThis.AIWSI18n.template`${window.AIWSUI.icon('triangle')}<span class="error-banner-text">${esc(message)}</span><button type="button" id="dismiss-error" class="button small ghost">Kapat</button>`;
  $('#error-banner').hidden = false;
  $('#dismiss-error').onclick = dismissError;
  errorTimer = setTimeout(dismissError, 10_000);
}
window.addEventListener('pagehide',()=>{clearTimeout(toastTimer);clearTimeout(errorTimer);});
