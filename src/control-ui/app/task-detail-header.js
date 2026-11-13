'use strict';
// The task detail header: task key, run action and run controls.
let copiedTaskId=null,copiedTimer;
function taskKeyButton(item){return globalThis.AIWSI18n.template`<button type="button" id="task-key-copy" class="task-key" data-copy-task-id="${esc(item.id)}" data-copy-value="${esc(taskKey(item))}" title="Görev kodunu kopyala · ${esc(item.id)}">${esc(taskKey(item))}</button>${copiedTaskId===item.id?globalThis.AIWSI18n.text('<span class="task-key-copied" role="status">Kopyalandı</span>'):''}`;}
// Copy on pointerdown: header re-renders from live pushes can replace the button between press and release, which swallows the click. Keyboard activation still arrives as a click.
for(const type of ['pointerdown','click'])document.addEventListener(type,async event=>{if(type==='pointerdown'?event.button!==0:event.detail!==0)return;const button=event.target.closest?.('[data-copy-task-id]');if(!button)return;const id=button.dataset.copyTaskId;if(!await copyText(button.dataset.copyValue||id)){error(globalThis.AIWSI18n.text('Panoya erişilemiyor'));return;}copiedTaskId=id;clearTimeout(copiedTimer);copiedTimer=setTimeout(()=>{copiedTaskId=null;if(task())renderDetail();},1600);if(task()?.id===id)renderDetail();});
// The title in the header edits in place, so a task without a title can get one.
let titleEditTaskId=null;
function taskTitleControl(item){
  const t=globalThis.AIWSI18n.text;
  if(titleEditTaskId===item.id)return `<h2 id="task-detail-title"><input id="task-title-edit" class="detail-title-input" value="${esc(item.title||'')}" maxlength="240" autocomplete="off" spellcheck="true" aria-label="${esc(t('Görev başlığı'))}"></h2>`;
  return `<h2 id="task-detail-title" title="${esc(item.title||'')}"><button type="button" class="detail-title-button" data-edit-task-title aria-label="${esc(t('Başlığı düzenle'))}">${item.title?esc(item.title):`<span class="detail-title-empty">${esc(t('Başlık ekle'))}</span>`}</button></h2>`;
}
function closeTitleEdit(save){
  const item=task(),input=$('#task-title-edit');if(!item||!input||titleEditTaskId!==item.id)return;
  const title=input.value.trim();titleEditTaskId=null;renderDetail();
  if(save&&title!==(item.title||''))void saveTaskField(item,{title});
}
document.addEventListener('click',event=>{
  if(!event.target.closest?.('[data-edit-task-title]'))return;const item=task();if(!item)return;
  titleEditTaskId=item.id;renderDetail();const input=$('#task-title-edit');input?.focus();input?.select();
});
document.addEventListener('keydown',event=>{
  if(event.target.id!=='task-title-edit'||!['Enter','Escape'].includes(event.key))return;
  event.preventDefault();event.stopPropagation();closeTitleEdit(event.key==='Enter');
},true);
// A re-render replaces the header and hands focus back within the same task; only a focus that stayed away ends the edit.
document.addEventListener('focusout',event=>{if(event.target.id==='task-title-edit')setTimeout(()=>{if(document.activeElement?.id!=='task-title-edit')closeTitleEdit(true);},0);});
function headerRunAction(item,run,active){
  if(item.queuedContinuation&&item.status==='ready')return `<button class="button primary small header-run-action" data-action="confirm-queued-history" ${item.queuedContinuation.confirmationRequired?'':'disabled'}>${item.queuedContinuation.confirmationRequired?globalThis.AIWSI18n.text('Geçmişle yeniden başlat'):globalThis.AIWSI18n.text('Otomatik sırada')}</button>`;
  if(!item.externalHistory&&!item.externalDependency&&run&&['failed','interrupted','cancelled'].includes(run.status))return globalThis.AIWSI18n.text('<button class="button primary small header-run-action" data-run-action="restart" title="Önceki çıktı korunur; mevcut çalışma alanında aynı görev için yeni bir koşum başlatılır.">↻ Yeniden başlat</button>');
  if(!item.externalHistory&&!item.externalDependency&&!item.archivedAt&&!active){
    if(item.status==='backlog')return globalThis.AIWSI18n.text('<button class="button primary small header-run-action" data-move-task="ready" title="Görevi Hazır sütununa taşır; uygun agent boşalınca otomatik başlar.">Hazır →</button>');
    if(item.status==='review'||item.status==='failed'&&run?.status==='completed')return globalThis.AIWSI18n.text('<button class="button primary small header-run-action" data-move-task="done" title="İncelemeyi bitirir ve görevi Tamamlandı sütununa taşır.">✓ Tamamlandı</button>');
    if(['done','cancelled'].includes(item.status))return globalThis.AIWSI18n.text('<button class="button primary small header-run-action" data-archive-task title="Görevi panodan kaldırıp arşive taşır; Arşiv görünümünden geri alınabilir.">Arşivle</button>');
  }
  if(item.externalHistory||run&&!active)return '';
  const request=run?.status==='waiting'&&activeInputRequests().find(question=>question.runId===run.id);
  if(request)return `<button class="button primary small header-run-action" data-open-question="${esc(request.id)}">${request.kind==='approval'?globalThis.AIWSI18n.text('Onay bekliyor · İncele'):globalThis.AIWSI18n.text('Yanıt bekliyor · Yanıtla')}</button>`;
  const queued=item.status==='ready',disabled=active||queued||item.externalDependency||item.externalHistory,label=item.externalDependency||item.externalHistory?globalThis.AIWSI18n.text('Salt okunur'):active?(run.status==='paused'?globalThis.AIWSI18n.text('Duraklatıldı'):run.status==='waiting'?(item.handoffRequest?.runId===run.id?globalThis.AIWSI18n.text('Kota bekleniyor'):globalThis.AIWSI18n.text('Yanıt bekliyor')):globalThis.AIWSI18n.text('Çalışıyor')):queued?globalThis.AIWSI18n.text('Otomatik sırada'):globalThis.AIWSI18n.text('Agentı çalıştır');
  const explanation=queued?(item.queueReason||globalThis.AIWSI18n.text('Hazır görevler uygun agent boşaldığında otomatik başlar.')):active?globalThis.AIWSI18n.text('Bu görevin aktif bir çalışması var.'):globalThis.AIWSI18n.text('Bu görevi seçili veya uygun agentla şimdi çalıştırır. Hazır görevler otomatik başlar.');
  return `<button class="button primary small header-run-action" data-run-action="start" ${disabled?'disabled':''} title="${esc(explanation)}">${!disabled?window.AIWSUI.sparkle():''}${esc(label)}</button>`;
}
function runControls(run){const active=run&&['running','waiting','paused'].includes(run.status);return `${active&&run.status!=='paused'?globalThis.AIWSI18n.text('<button class="button small" data-run-action="pause">Ⅱ Duraklat</button>'):''}${run?.status==='paused'?globalThis.AIWSI18n.text('<button class="button small" data-run-action="resume">▷ Devam et</button>'):''}${active?globalThis.AIWSI18n.text('<button class="button small danger" data-run-action="stop">Durdur</button>'):''}`;}
// A queued continuation whose session cannot be resumed waits for consent to start over with the saved history: the console shows
// it as a notice (never a dialog over live updates), and the header button asks once more.
const dismissedQueuedFallbacks=new Set();
const queuedFallbackKey=item=>`${item.id}/${item.currentRunId}/${item.updatedAt}`;
const queuedHistoryMessage=item=>`${item.title}: ${globalThis.AIWSI18n.text('Mevcut oturum devam ettirilemiyor. Tüm kayıtlı konuşma geçmişi kopyalanarak yeni bir oturum başlatılacak.')}`;
async function startQueuedHistory(item){try{await api(`/tasks/${item.id}/run`,'POST',{allowHistoryFallback:true});await refresh();}catch(problem){error(problem.message);}}
async function confirmQueuedHistory(item){
  if(await confirmModal(globalThis.AIWSI18n.text('Geçmişle yeniden başlatılsın mı?'),queuedHistoryMessage(item),{confirmLabel:globalThis.AIWSI18n.text('Geçmişle yeniden başlat')}))await startQueuedHistory(item);
}
function mountQueuedHistoryNotice(item,host){
  let notice=host.querySelector(':scope > .queued-history-notice');
  if(!(item.status==='ready'&&item.queuedContinuation?.confirmationRequired)||dismissedQueuedFallbacks.has(queuedFallbackKey(item))){notice?.remove();return;}
  const key=queuedFallbackKey(item);if(notice?.dataset.key===key){if(notice.parentElement!==host)host.prepend(notice);return;}
  notice?.remove();notice=document.createElement('div');notice.className='handoff-notice queued-history-notice';notice.setAttribute('role','status');notice.dataset.key=key;
  notice.innerHTML=globalThis.AIWSI18n.template`<div class="handoff-notice-text"><strong>${esc(queuedHistoryMessage(item))}</strong></div><div class="handoff-notice-actions"><button type="button" class="button primary small" data-queued-history-accept>Geçmişle yeniden başlat</button><button type="button" class="button ghost small" data-queued-history-dismiss>Şimdilik bekle</button></div>`;
  host.prepend(notice);
}
document.addEventListener('click',event=>{
  const item=task();if(!item?.queuedContinuation?.confirmationRequired)return;
  if(event.target.closest('[data-action="confirm-queued-history"]'))void confirmQueuedHistory(item);
  else if(event.target.closest('[data-queued-history-accept]')){event.target.closest('button').disabled=true;void startQueuedHistory(item);}
  else if(event.target.closest('[data-queued-history-dismiss]')){dismissedQueuedFallbacks.add(queuedFallbackKey(item));renderDetail();}
});
