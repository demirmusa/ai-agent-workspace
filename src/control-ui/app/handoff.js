'use strict';
// Handing a task over to another provider.
// Who continues a task: a provider from the work settings with its model and reasoning level; the method defaults to the project setting.
const handoffDrafts=new Map();let manualHandoffTaskId=null;
function defaultHandoffProvider(previous){
  const enabled=configurableProviders.filter(provider=>providerEnabled(provider));
  return enabled.includes(state.settings.defaultProvider)&&state.settings.defaultProvider!==previous?state.settings.defaultProvider:enabled.find(provider=>provider!==previous)||enabled[0]||previous;
}
function mountHandoffNotice(item,host,run){
  let notice=host.querySelector(':scope > .handoff-notice');const request=item.handoffRequest,manual=manualHandoffTaskId===item.id;
  if(!request&&!manual){notice?.remove();return;}
  const from=request?{provider:request.provider,name:request.agentName}:{provider:run?.provider||item.provider,name:run?.executionSnapshot?.agent?.name||providers[run?.provider||item.provider]};
  const project=state.projects.find(entry=>entry.id===item.projectId),draft=handoffDrafts.get(item.id)||{provider:defaultHandoffProvider(from.provider),model:'',reasoningEffort:'',mode:project?.agentHandoffMode||'fresh'};handoffDrafts.set(item.id,draft);
  const name=from.name===from.provider?providers[from.provider]||from.provider:from.name;
  const key=`${item.id}:${request?.runId||'manual'}:${request?.resumeAt||''}`;
  if(notice?.dataset.key===key){if(notice.parentElement!==host)host.prepend(notice);return;}
  const waitText=request?.resumeAt?globalThis.AIWSI18n.template`Otomatik bekleme: ${esc(scheduleTime(request.resumeAt))} (${esc(untilText(request.resumeAt))}) geldiğinde kaldığı yerden devam eder.`:request?globalThis.AIWSI18n.text('Otomatik bekleme: kota yenilenince kaldığı yerden devam eder.'):'';
  const html=globalThis.AIWSI18n.template`<div class="handoff-notice-text"><strong>${request?globalThis.AIWSI18n.template`${esc(name)} ajanının tokenı bitti. Başka bir agentla devam edilsin mi?`:globalThis.AIWSI18n.text('Başka bir agentla devam et')}</strong>${waitText?`<small>${waitText}</small>`:''}${request?.reason?`<small>${esc(request.reason)}</small>`:''}</div><div class="handoff-notice-controls">${agentPickerMarkup({provider:draft.provider,model:draft.model,reasoningEffort:draft.reasoningEffort},{command:false,custom:false})}<select name="mode" aria-label="Yöntem" title="Temiz agent git değişikliklerine bakıp eksikleri tamamlar; geçmiş aktarımı tüm konuşmayı yeni agenta verir."><option value="fresh" ${draft.mode==='fresh'?'selected':''}>Temiz başlat</option><option value="transcript" ${draft.mode==='transcript'?'selected':''}>Geçmişi aktar</option></select><div class="handoff-notice-actions"><button type="submit" class="button primary small">Devam et</button><button type="button" class="button ghost small" data-handoff-dismiss>${request?globalThis.AIWSI18n.text('Şimdilik bekle'):globalThis.AIWSI18n.text('Vazgeç')}</button></div></div><p class="handoff-notice-error" role="alert" hidden></p>`;
  notice?.remove();notice=document.createElement('form');notice.className='handoff-notice';notice.setAttribute('aria-label',globalThis.AIWSI18n.text('Agent devri'));notice.dataset.key=key;notice.innerHTML=html;host.prepend(notice);
  const effective=()=>notice.querySelector('#field-provider').value;
  mountAgentPicker(notice);
  notice.addEventListener('change',()=>Object.assign(draft,{provider:effective(),model:notice.querySelector('#field-model').value.trim(),reasoningEffort:notice.querySelector('#field-reasoningEffort').value,mode:notice.elements.mode.value}));
  notice.addEventListener('submit',async event=>{
    event.preventDefault();const start=notice.querySelector('[type=submit]'),problem=notice.querySelector('.handoff-notice-error');start.disabled=true;problem.hidden=true;
    try{await api(`/tasks/${item.id}/handoff`,'POST',{provider:effective(),model:notice.querySelector('#field-model').value.trim()||null,reasoningEffort:notice.querySelector('#field-reasoningEffort').value||null,mode:notice.elements.mode.value});handoffDrafts.delete(item.id);if(manualHandoffTaskId===item.id)manualHandoffTaskId=null;await refresh();}
    catch(failure){problem.textContent=failure.message;problem.hidden=false;}
    finally{start.disabled=false;}
  });
}
document.addEventListener('click',async event=>{
  const item=task();if(!item)return;
  if(event.target.closest('[data-action="handoff-task"]')){manualHandoffTaskId=item.id;detailTab='console';renderDetail();return;}
  if(!event.target.closest('[data-handoff-dismiss]'))return;
  if(manualHandoffTaskId===item.id)manualHandoffTaskId=null;try{if(item.handoffRequest)await api(`/tasks/${item.id}/handoff/dismiss`,'POST',{});await refresh();}catch(failure){error(failure.message);}renderDetail();
});
