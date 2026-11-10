'use strict';
// The live status lines at the bottom of the sidebar: running agents and the control server connection.
function connection(ok) { $('#connection-dot').dataset.tone = ok ? 'done' : 'failed'; $('#connection-label').textContent = ok ? globalThis.AIWSI18n.text('Kontrol merkezi bağlı') : globalThis.AIWSI18n.text('Bağlantı yeniden deneniyor'); }
/** Counts the running agents of the whole workspace against the global agent slots, e.g. "2/8 agents running". */
function renderRunStatus(){
  const runningCount=state.runs.filter(r=>r.status==='running').length,slots=state.settings?.maxConcurrent||0;
  const label=$('#running-label'),dot=$('#running-dot');
  label.textContent=globalThis.AIWSI18n.template`${slots?`${runningCount}/${slots}`:runningCount} agent çalışıyor`; label.classList.toggle('running',runningCount>0); dot.dataset.tone=runningCount?'running':'idle'; dot.classList.toggle('is-live',runningCount>0);
}
