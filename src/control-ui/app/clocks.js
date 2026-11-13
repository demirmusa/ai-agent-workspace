'use strict';
// Run timers: they tick in place, so markup stays identical between renders and unchanged views are not rebuilt.
/** The active time of a run: the reported active time counted on while it runs, else its wall-clock span. */
function elapsed(run) {
  if(!run)return '0:00';const end=run.finishedAt?new Date(run.finishedAt).getTime():Date.now();
  const active=typeof run.activeMs==='number'?run.activeMs+(['running','waiting'].includes(run.status)?Date.now()-(runClockReceivedAt.get(run.id)||stateReceivedAt):0):end-new Date(run.startedAt).getTime();const seconds=Math.max(0,Math.floor(active/1000));
  return clockDuration(seconds);
}
function refreshRunTimers(root=document){for(const element of root.querySelectorAll('[data-run-timer]')){const run=runById(element.dataset.runTimer);if(!run)continue;const finished=run.finishedAt&&!['running','waiting'].includes(run.status)&&Number.isFinite(Date.parse(run.finishedAt));const value=finished?agoShort(run.finishedAt):elapsed(run);if(element.textContent!==value)element.textContent=value;if(finished){const title=dateTime(run.finishedAt,{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});if(element.title!==title)element.title=title;}}}
const elapsedTimer=setInterval(()=>{if(!document.hidden)refreshRunTimers();},1000);
window.addEventListener('pagehide',()=>clearInterval(elapsedTimer));
