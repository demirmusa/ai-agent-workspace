'use strict';
// Quota triggers start a ready task before reset or after the selected quota renews.
/** Windows a provider reports now, as quota trigger choices; the id matches the server's window id. */
function usageTriggerWindows(provider){
  const item=(tokenUsageData?.providers||[]).find(entry=>entry.key===provider);
  return item?tokenRows(item).filter(row=>row.window.usedPercent!=null||row.window.resetsAt).map(row=>({id:row.key,label:row.label,minutes:row.window.windowMinutes,resetsAt:row.window.resetsAt})):[];
}
/** The provider's windows; a saved window that is not listed stays selected, marked gone only when the provider reports other windows. */
function usageWindowOptions(provider,trigger){
  const t=globalThis.AIWSI18n.text,windows=usageTriggerWindows(provider),current=trigger?.provider===provider?trigger:null;
  const listed=current&&windows.some(item=>item.id===current.window&&item.minutes===current.windowMinutes);
  const options=windows.map(item=>`<option value="${esc(item.id)}" data-minutes="${item.minutes}" data-reset="${esc(listed&&current.window===item.id&&current.resetsAt?current.resetsAt:item.resetsAt||'')}" ${listed&&current.window===item.id?'selected':''}>${esc(item.label)}</option>`);
  if(current&&!listed)options.unshift(`<option value="${esc(current.window)}" data-minutes="${current.windowMinutes}" data-reset="${esc(current.resetsAt||'')}" selected>${windows.length?`${esc(t('Artık yok'))} · `:''}${esc(tokenWindowLabel(current.windowMinutes))}</option>`);
  return options.join('')||`<option value="" disabled selected>${esc(t(provider&&!tokenUsageData?'Kota okunuyor…':'Kota verisi yok'))}</option>`;
}
/** One-line summary of a trigger for the closed field, or the off label. */
function usageTriggerSummary(trigger){
  return trigger?usageTriggerText(trigger):globalThis.AIWSI18n.text('Kota ile tetikleme');
}
/** Quota trigger: one line that opens a popup with provider, one of its windows and the minutes before that window resets. `attrs` goes on each control. */
function usageTriggerInputs(trigger,id='field',attrs=''){
  const t=globalThis.AIWSI18n.text,off=trigger?'':' disabled';
  const fields=`<div class="usage-trigger-field popup-menu" id="${id}-usagePopup" role="dialog" popover="manual" aria-label="${esc(t('Kota tetikleyicisi'))}" hidden><select id="${id}-usageProvider" name="usageProvider" data-usage-provider ${attrs}><option value="">${esc(t('Kota ile tetikleme'))}</option>${aiProviderList.map(item=>`<option value="${esc(item.id)}" ${trigger?.provider===item.id?'selected':''}>${esc(item.name)}</option>`).join('')}</select><select id="${id}-usageWindow" name="usageWindow" data-provider="${esc(trigger?.provider||'')}" aria-label="${esc(t('Kota penceresi'))}" ${attrs}${off}>${usageWindowOptions(trigger?.provider,trigger)}</select><select id="${id}-usageMode" name="usageMode" aria-label="${esc(t('Tetikleme zamanı'))}" ${attrs}${off}><option value="before">${esc(t('Sıfırlanmadan önce'))}</option><option value="reset" ${trigger?.mode==='reset'?'selected':''}>${esc(t('Kota yenilenince'))}</option></select><span class="usage-trigger-minutes" ${trigger?.mode==='reset'?'hidden':''}><input type="number" id="${id}-usageMinutes" name="usageMinutes" min="1" max="44640" step="1" value="${trigger?.withinMinutes||60}" aria-label="${esc(t('Sıfırlanmaya kalan dakika'))}" ${attrs}${off}><span aria-hidden="true">${esc(t('dk kala'))}</span></span></div>`;
  return `<div class="usage-trigger"><button type="button" class="usage-trigger-button button ghost" data-usage-toggle aria-haspopup="dialog" aria-expanded="false" aria-controls="${id}-usagePopup" ${attrs.includes('disabled')?'disabled':''}><span class="usage-trigger-summary">${esc(usageTriggerSummary(trigger))}</span></button>${fields}</div>`;
}
/** Shows the closed field's one-line summary for the trigger the popup controls describe. */
function updateUsageSummary(field){
  const root=field.closest('.usage-trigger'),summary=root?.querySelector('.usage-trigger-summary');if(!summary)return;
  summary.textContent=usageTriggerSummary(usageTriggerFromInputs(root.querySelector('.usage-trigger-field')));
}
function placeUsagePopup(root){
  const toggle=root.querySelector('[data-usage-toggle]'),popup=root.querySelector('.usage-trigger-field'),rect=toggle.getBoundingClientRect(),margin=8,gap=4,limit=innerWidth-margin*2;
  if(!toggle.isConnected||(rect.width||rect.height)&&(rect.bottom<0||rect.top>innerHeight)){setUsagePopup(root,false);return;}
  popup.style.width=`${Math.min(Math.max(rect.width,280),limit)}px`;popup.style.maxWidth=`${limit}px`;
  const width=popup.offsetWidth||Math.min(Math.max(rect.width,280),limit),height=popup.offsetHeight,below=innerHeight-rect.bottom-gap-margin,above=rect.top-gap-margin,flip=height>below&&above>below;
  popup.classList.toggle('is-above',flip);
  popup.style.left=`${Math.round(Math.min(Math.max(margin,rect.left),innerWidth-width-margin))}px`;
  popup.style.top=`${Math.round(flip?Math.max(margin,rect.top-gap-height):rect.bottom+gap)}px`;
}
function setUsagePopup(root,open){
  const popup=root.querySelector('.usage-trigger-field'),wasOpen=!popup.hidden;popup.hidden=!open;
  /* The top layer escapes the dialog's stacking and the detail panel's containment, which would re-anchor a fixed popup. */
  if(popup.showPopover)try{if(open)popup.showPopover();else popup.hidePopover();}catch{}
  root.querySelector('[data-usage-toggle]').setAttribute('aria-expanded',String(open));
  if(open)placeUsagePopup(root);else if(wasOpen&&root.closest('.detail-information')&&detailTab==='info'&&task())scheduleRender();
}
function syncOpenUsagePopups(event){
  for(const popup of document.querySelectorAll('.usage-trigger-field:not([hidden])')){if(event?.type==='scroll'&&popup.contains(event.target))continue;placeUsagePopup(popup.closest('.usage-trigger'));}
}
document.addEventListener('scroll',syncOpenUsagePopups,true);
addEventListener('resize',syncOpenUsagePopups);
document.addEventListener('modalreset',event=>{for(const root of event.target.querySelectorAll?.('.usage-trigger')||[])setUsagePopup(root,false);});
document.addEventListener('click',event=>{
  const toggle=event.target.closest?.('[data-usage-toggle]');
  for(const root of document.querySelectorAll('.usage-trigger'))if(root!==toggle?.closest('.usage-trigger')&&!root.contains(event.target))setUsagePopup(root,false);
  if(toggle){const root=toggle.closest('.usage-trigger');setUsagePopup(root,root.querySelector('.usage-trigger-field').hidden);if(!tokenUsageData)void loadTokenUsage();}
});
document.addEventListener('keydown',event=>{
  if(event.key!=='Escape')return;
  const root=event.target.closest?.('.usage-trigger');
  if(root&&!root.querySelector('.usage-trigger-field').hidden){event.preventDefault();event.stopPropagation();setUsagePopup(root,false);root.querySelector('[data-usage-toggle]').focus();}
},true);
/** Lists the chosen provider's windows, keeping the selection while the provider stays; window and minutes need a provider. */
function fillUsageWindows(root){
  const provider=root.querySelector('[data-usage-provider]'),select=root.querySelector('[name="usageWindow"]'),minutes=root.querySelector('[name="usageMinutes"]'),option=select.options[select.selectedIndex];
  const kept=option?.value&&select.dataset.provider===provider.value?{provider:provider.value,window:option.value,windowMinutes:Number(option.dataset.minutes),resetsAt:option.dataset.reset}:null;
  select.innerHTML=usageWindowOptions(provider.value,kept);select.dataset.provider=provider.value;
  if(!provider.disabled)select.disabled=minutes.disabled=root.querySelector('[name="usageMode"]').disabled=!provider.value;
}
/** Quota data that arrives after a provider was chosen fills its windows; the window select reports it so the detail panel saves it. */
function refreshUsageFields(){
  for(const root of document.querySelectorAll('.usage-trigger-field')){const select=root.querySelector('[name="usageWindow"]'),had=select.value;fillUsageWindows(root);if(!had&&select.value)select.dispatchEvent(new Event('change',{bubbles:true}));updateUsageSummary(select);}
}
document.addEventListener('change',event=>{
  if(event.target.closest?.('.usage-trigger-field')){const root=event.target.closest('.usage-trigger-field');root.querySelector('.usage-trigger-minutes').hidden=root.querySelector('[name="usageMode"]').value==='reset';updateUsageSummary(event.target);}
  const provider=event.target.closest?.('[data-usage-provider]');if(!provider)return;
  fillUsageWindows(provider.closest('.usage-trigger-field'));updateUsageSummary(provider);if(!tokenUsageData)void loadTokenUsage();
});
/** The trigger the controls under `root` describe, or null when no provider or window is chosen. */
function usageTriggerFromInputs(root){
  const provider=root.querySelector('[data-usage-provider]').value,select=root.querySelector('[name="usageWindow"]'),option=select.options[select.selectedIndex];
  return provider&&option?.value?{provider,window:option.value,windowMinutes:Number(option.dataset.minutes),withinMinutes:Number(root.querySelector('[name="usageMinutes"]').value),...(root.querySelector('[name="usageMode"]').value==='reset'?{mode:'reset',resetsAt:option.dataset.reset}: {})}:null;
}
function usageTriggerText(trigger){
  return `${providers[trigger.provider]||trigger.provider} · ${usageTriggerWindows(trigger.provider).find(item=>item.id===trigger.window)?.label||tokenWindowLabel(trigger.windowMinutes)} · ${trigger.mode==='reset'?globalThis.AIWSI18n.text('Kota yenilenince'):`${trigger.withinMinutes} ${globalThis.AIWSI18n.text('dk kala')}`}`;
}
