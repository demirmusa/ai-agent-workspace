'use strict';
// The agent chip on a card opens a small popup to pick the agent, provider and model; locked tasks keep the plain label and open the task.
function cardAgentLock(item){const active=activeRun(runById(item.currentRunId));return infoLocks(item,active).execution||(taskProvider(item)==='command'&&!item.agentId?globalThis.AIWSI18n.text('Komut görevleri görev ayrıntılarından düzenlenir.'):'');}
function cardAgentChip(item,run){const t=globalThis.AIWSI18n.text,level=item.reasoningEffort,content=`${providerIcon(taskProvider(item))}<span class="provider-label">${esc(taskCardLabel(item,run))}</span>${level?`<span class="card-agent-level" role="img" aria-label="${esc(`${t('Düşünme seviyesi')}: ${reasoningLabel(level)}`)}" title="${esc(`${t('Düşünme seviyesi')}: ${reasoningLabel(level)}`)}">${reasoningIcon}</span>`:''}`;if(organizeLocked(item)||cardAgentLock(item))return `<span class="provider">${content}</span>`;return `<button type="button" class="provider card-agent-button" data-card-agent="${esc(item.id)}" title="${esc(t('Agent, sağlayıcı, model ve düşünme seviyesini seç'))}" aria-haspopup="menu" aria-expanded="false">${content}<span class="card-agent-chevron" aria-hidden="true">${window.AIWSUI.icon('chevron')}</span></button>`;}
// The card chip opens the shared picker with agent profiles; the choice is saved once when the panel closes.
function cardAgentPopup(id,anchor){
  const item=state.tasks.find(value=>value.id===id);if(!item||organizeLocked(item))return;
  const lock=cardAgentLock(item);if(lock){toast(lock);return;}
  const t=globalThis.AIWSI18n.text,existing=document.querySelector('.card-agent-picker');
  if(existing){const same=existing.dataset.task===id;agentPickers.get(existing)?.close();existing.remove();if(same)return;}
  const agent=state.agents.find(value=>value.id===item.agentId),initial={agentId:item.agentId||'',provider:item.providerOverride||(!agent&&(item.currentRunId||item.externalHistory||item.historyResume)?item.provider:''),model:agent?(item.modelOverride||''):(item.model||''),reasoningEffort:item.reasoningEffort||''};
  const host=document.createElement('div');host.className='card-agent-picker';host.dataset.task=id;
  host.innerHTML=agentPickerMarkup(initial,{id:'card-agent',trigger:false,agents:true,command:false,custom:false,inherit:`${t('Agenttan / varsayılan')} · ${providers[defaultProvider()]}`});
  document.body.append(host);
  const chosenAgent=()=>state.agents.find(value=>value.id===host.querySelector('#card-agent-agentId').value);
  const picker=mountAgentPicker(host,{id:'card-agent',anchor,inheritProvider:()=>chosenAgent()?.provider||defaultProvider(),inheritModel:()=>{const selected=chosenAgent();return selected?.model?globalThis.AIWSI18n.template`Agenttan · ${selected.model}`:t('Profil veya sağlayıcı varsayılanı');},onClose:async values=>{
    // The shared popup rule fades the hidden menu out; the host leaves once that transition ends. Dropping its task lets the chip reopen meanwhile.
    delete host.dataset.task;anchor.setAttribute('aria-expanded','false');
    window.AIWSUI.motion.dismiss(host.querySelector('.popup-menu'),()=>host.remove());
    if(Object.keys(initial).every(key=>initial[key]===values[key]))return;
    try{await api(`/tasks/${item.id}`,'PATCH',{agentId:values.agentId||null,provider:values.provider||null,model:values.model||null,reasoningEffort:values.reasoningEffort||null,command:null});toast(t('Agent seçimi kaydedildi'));}
    catch(error){toast(error.message||String(error));}
  }});
  picker.open();
}
document.addEventListener('click',event=>{const target=event.target.closest('button[data-card-agent]');if(!target)return;event.preventDefault();cardAgentPopup(target.dataset.cardAgent,target);});
