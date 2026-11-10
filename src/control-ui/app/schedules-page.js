'use strict';
// The project Schedules tab: schedule cards, tasks waiting for their time and the schedule actions.
/** A recurrence as chips: the rule first, then its days and times (or the cron expression), each one a short readable part. */
function recurrenceChips(recurrence){
  const t=globalThis.AIWSI18n.text;if(!recurrence)return '';const chip=(text,mono=false)=>`<span class="ui-chip${mono?' is-mono':''}">${esc(text)}</span>`;
  if(recurrence.kind==='once')return chip(t('Bir kez'))+chip(scheduleTime(recurrence.at));
  if(recurrence.kind==='interval'){const single={hours:'Her saat',days:'Her gün',weeks:'Her hafta'},units={minutes:'dakikada bir',hours:'saatte bir',days:'günde bir',weeks:'haftada bir'};return chip(recurrence.every===1&&single[recurrence.unit]?t(single[recurrence.unit]):`${t('Her')} ${recurrence.every} ${t(units[recurrence.unit])}`);}
  if(recurrence.kind==='daily'){const days=recurrence.weekdays||[],key=days.join(),label=!days.length||days.length===7?t('Her gün'):key==='1,2,3,4,5'?t('Hafta içi'):key==='0,6'?t('Hafta sonu'):[...days].sort((a,b)=>((a+6)%7)-((b+6)%7)).map(weekdayName).join(', ');return chip(label)+chip(recurrence.times.join(', '),true);}
  if(recurrence.kind==='monthly')return chip(t('Her ay'))+chip(recurrence.days.map(day=>day===-1?t('son gün'):`${day}.`).join(', '))+chip(recurrence.times.join(', '),true);
  return chip('Cron')+chip(recurrence.expression,true);
}
function scheduleAgentLabel(template){const agent=state.agents.find(value=>value.id===template.agentId);return [agent?.name,template.provider&&providers[template.provider],template.model].filter(Boolean).join(' · ')||globalThis.AIWSI18n.text('Otomatik agent');}
function scheduleCard(item){
  const t=globalThis.AIWSI18n.text,pill=window.AIWSUI.statusPill,last=item.lastOutcome,lastTask=item.lastTaskId?state.tasks.find(value=>value.id===item.lastTaskId):null;
  // The next run reads as a date with a countdown chip under it; a run that is due waits in the queue.
  const due=item.enabled&&item.nextRunAt&&Date.parse(item.nextRunAt)<=Date.now();
  const next=!item.enabled?esc(t('Duraklatıldı')):item.nextRunAt?`<span>${esc(scheduleTime(item.nextRunAt))}</span><span class="schedule-countdown ui-chip"${due?' data-tone="needs"':''}>${esc(untilText(item.nextRunAt))}${due?` · ${esc(t('sırada'))}`:''}</span>`:esc(t('Başka çalışma yok'));
  const outcomes={created:['done',t('Görev açıldı')],skipped:['needs',t('Atlandı')],failed:['failed',t('Başarısız')]},outcome=last&&(outcomes[last.status]||['idle',last.status]);
  // A ready task that cannot start keeps the schedule skipping; its reason is the actual problem.
  const blocked=lastTask?.status==='ready'&&!lastTask.archivedAt&&lastTask.queueReason?lastTask:null;
  return globalThis.AIWSI18n.template`<article class="schedule-card ui-card${item.enabled?'':' is-disabled'}" data-schedule-id="${esc(item.id)}" data-motion-key="schedule:${esc(item.id)}"><header><input type="checkbox" class="ui-switch schedule-toggle" role="switch" data-toggle-schedule="${esc(item.id)}" ${item.enabled?'checked':''} aria-label="${esc(item.name)} · ${esc(t('Zamanlama etkin'))}" title="${esc(item.enabled?t('Zamanlamayı duraklat'):t('Zamanlamayı etkinleştir'))}"><div class="schedule-heading"><h3>${esc(item.name)}</h3><p class="schedule-rule">${recurrenceChips(item.recurrence)}<span class="ui-chip is-mono" title="${esc(t('Saat dilimi'))}">${esc(item.timezone)}</span></p></div><div class="schedule-actions"><button type="button" class="button small" data-run-schedule="${esc(item.id)}" title="Zamanlamayı değiştirmeden görevi şimdi aç">▶ Şimdi çalıştır</button><button type="button" class="button small ghost" data-edit-schedule="${esc(item.id)}">Düzenle</button></div></header><dl class="schedule-facts"><div><dt>Sonraki çalışma</dt><dd>${next}</dd></div><div><dt>Son çalışma</dt><dd>${item.lastRunAt?esc(scheduleTime(item.lastRunAt)):'—'}${lastTask?` · <button type="button" class="link-button" data-open-task="${esc(lastTask.id)}">${esc(lastTask.title)} · ${esc(statuses[lastTask.status]||lastTask.status)}</button>`:''}</dd></div><div><dt>Çalışma sayısı</dt><dd>${item.runCount}${item.maxRuns?` / ${item.maxRuns}`:''}</dd></div><div><dt>Agent</dt><dd>${esc(scheduleAgentLabel(item.task))}</dd></div></dl>${outcome?`<p class="schedule-outcome ${esc(last.status)}">${pill(outcome[0],outcome[1])}<span>${esc(last.message)}</span><time datetime="${esc(last.at)}">${esc(historyAgo(last.at))}</time></p>`:''}${blocked?`<p class="schedule-outcome blocked" role="status">${pill('needs',t('Görev başlayamıyor'))}<span>${esc(blocked.queueReason)}</span><button type="button" class="link-button" data-open-task="${esc(blocked.id)}">${esc(t('Görevi aç'))}</button></p>`:''}${item.description?`<p class="schedule-description">${esc(item.description)}</p>`:''}</article>`;
}
function renderProjectSchedules(){
  const current=project();if(!current)return;const board=$('#board');board.className='board schedules-board';
  const schedules=(state.schedules||[]).filter(item=>item.projectId===current.id).sort((a,b)=>Number(b.enabled)-Number(a.enabled)||(a.nextRunAt||'~').localeCompare(b.nextRunAt||'~')||a.name.localeCompare(b.name));
  const waiting=state.tasks.filter(item=>item.projectId===current.id&&!item.archivedAt&&scheduledWaiting(item)).sort((a,b)=>a.scheduledAt.localeCompare(b.scheduledAt));
  const t=globalThis.AIWSI18n.text,mark=`<span class="ui-icon-box library-glyph" aria-hidden="true">${window.AIWSUI.icon('clock')}</span>`;
  const intro=current.general?globalThis.AIWSI18n.template`<section class="schedules-intro ui-card">${mark}<div><h2>Genel çalışma alanı</h2><p>Projelerden ve Git’ten bağımsız işler için ortak klasör. Raporlar, hatırlatmalar, bakım ve araştırma gibi işleri burada tanımla; agentlar bu klasörde çalışır ve dosyaları çalışmalar arasında saklanır.</p><p class="history-source">${pageIcon('folder')} ${esc(current.repositoryPath)}</p></div><button type="button" class="button primary" data-action="new-schedule">+ Yeni zamanlama</button></section>`
    :globalThis.AIWSI18n.template`<section class="schedules-intro ui-card">${mark}<div><h2>Zamanlanmış ve tekrarlanan görevler</h2><p>Her çalışma zamanında bu projede Hazır durumunda yeni bir görev açılır ve uygun agent boşalınca başlar. Uygulama kapalıyken kaçırılan çalışmalar ilk açılışta yapılır.</p></div><button type="button" class="button primary" data-action="new-schedule">+ Yeni zamanlama</button></section>`;
  const list=schedules.length?`<div class="schedule-list">${schedules.map(scheduleCard).join('')}</div>`:emptyState({className:'library-empty schedules-empty',title:t('Henüz zamanlama yok.'),text:t('Bir kez, belirli aralıklarla, her gün, haftanın seçili günlerinde, her ay veya cron ifadesiyle çalışacak bir görev tanımla.'),action:t('<button type="button" class="button primary" data-action="new-schedule">Zamanlama oluştur</button>')});
  const tasks=waiting.length?globalThis.AIWSI18n.template`<section class="scheduled-tasks"><h3>Zamanı bekleyen görevler <span class="ui-chip">${waiting.length}</span></h3><ul>${waiting.map(item=>`<li><button type="button" class="scheduled-task-row ui-card is-interactive" data-open-task="${esc(item.id)}" data-motion-key="scheduled-task:${esc(item.id)}"><span class="schedule-time">${window.AIWSUI.icon('clock')} ${esc(scheduleTime(item.scheduledAt))}</span><strong>${esc(window.AIWSUI.taskTitle(item))}</strong><span class="task-status-chip ${esc(item.status)}">${esc(statuses[item.status])}</span><small>${esc(untilText(item.scheduledAt))}</small></button></li>`).join('')}</ul></section>`:'';
  // The countdowns re-render every half minute; a focused control is found again by its action and id.
  const focused=board.contains(document.activeElement)?['toggleSchedule','runSchedule','editSchedule','openTask'].find(name=>document.activeElement.dataset?.[name]):null,focusedValue=focused&&document.activeElement.dataset[focused];
  if(setHtml(board,intro+list+tasks)&&focused)[...board.querySelectorAll('button,input')].find(element=>element.dataset[focused]===focusedValue)?.focus({preventScroll:true});
  window.AIWSUI.motion.enter(board,'[data-motion-key]','data-motion-key');
}
document.addEventListener('click',async event=>{
  const target=event.target.closest('button');if(!target)return;
  if(target.dataset.action==='new-schedule')scheduleModal();
  if(target.dataset.editSchedule&&!target.disabled)scheduleModal(target.dataset.editSchedule);
  if(target.dataset.runSchedule){target.disabled=true;try{const created=await api(`/schedules/${target.dataset.runSchedule}/run`,'POST',{});toast(globalThis.AIWSI18n.template`Görev açıldı: ${created.title}`);await refresh();}catch(cause){error(cause.message);}finally{target.disabled=false;}}
  if(target.dataset.deleteSchedule){const scheduleId=target.dataset.deleteSchedule;showModal(globalThis.AIWSI18n.text('Zamanlama silinsin mi?'),globalThis.AIWSI18n.template`<form><p class="form-hint">Zamanlama silinir ve yeni görev açmaz. Daha önce açtığı görevler panoda kalır.</p>${formFooter(globalThis.AIWSI18n.text('Zamanlamayı sil'))}</form>`,async()=>{await api(`/schedules/${scheduleId}`,'DELETE');toast(globalThis.AIWSI18n.text('Zamanlama silindi'));});}
});
document.addEventListener('change',async event=>{
  const toggle=event.target.closest?.('[data-toggle-schedule]');if(!toggle)return;toggle.disabled=true;
  try{await api(`/schedules/${toggle.dataset.toggleSchedule}`,'PATCH',{enabled:toggle.checked});toast(toggle.checked?globalThis.AIWSI18n.text('Zamanlama etkinleştirildi'):globalThis.AIWSI18n.text('Zamanlama duraklatıldı'));await refresh();}
  catch(cause){toggle.checked=!toggle.checked;error(cause.message);}finally{toggle.disabled=false;}
});
// Countdowns on the schedules tab and scheduled cards move on without server pushes.
const scheduleClock=setInterval(()=>{if(document.hidden||$('#modal').open)return;if(activeScreen==='board'&&projectTab()==='schedules')renderBoard();else if(['board','overview'].includes(activeScreen)&&state.tasks.some(item=>item.scheduledAt&&['backlog','ready'].includes(item.status)))scheduleRender();},30000);
window.addEventListener('pagehide',()=>clearInterval(scheduleClock));
