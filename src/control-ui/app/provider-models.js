'use strict';
// A provider card's model summary and refreshing its model list from the provider.
// The model chips show the list task and agent forms offer; the refreshed list replaces the suggestions.
function providerModelsMarkup(provider,values=settingsValues()){
  const catalog=state.providerModels?.[provider],t=globalThis.AIWSI18n,models=modelChoices(provider,{all:true}),hidden=values.disabledModels[provider]||[],chosen=values.defaultModels[provider]||'',open=models.filter(model=>!hidden.includes(model.id)),shown=open.slice(0,8);
  return t.template`<div class="provider-models" data-provider-models="${provider}"><div class="provider-models-head"><div class="provider-models-text"><strong>Modeller</strong><small id="provider-models-status-${provider}" role="status">${catalog?t.template`Model sayısı: ${catalog.models.length} · ${esc(catalog.source)} · Son yenileme ${esc(relative(catalog.refreshedAt))}`:t.text('Önerilen model listesi kullanılıyor. Hesabındaki güncel modeller için yenile.')}</small></div><button type="button" class="button small ghost" data-provider-models-refresh="${provider}"><span class="button-glyph" aria-hidden="true">↻</span> Modelleri yenile</button></div>${models.length?t.template`<small class="provider-models-summary">${t.template`Varsayılan model: ${chosen?esc(chosen):t.text('Seçilmedi')} · ${open.length}/${models.length} model açık`}</small><div class="provider-model-chips">${shown.map(model=>`<span class="ui-chip is-mono${model.id===chosen?' is-accent':''}" title="${esc(modelLabel(model))}">${esc(model.id)}</span>`).join('')}${open.length>shown.length?`<span class="ui-chip">+${open.length-shown.length}</span>`:''}</div>`:''}<button type="button" class="button small" data-provider-models-manage="${provider}">${t.text('Modelleri yönet')}</button></div>`;
}
document.addEventListener('click',async event=>{
  const button=event.target.closest?.('[data-provider-models-refresh]');if(!button||button.disabled)return;
  const provider=button.dataset.providerModelsRefresh,status=document.querySelector(`#provider-models-status-${provider}`);
  button.disabled=true;button.classList.add('is-busy');button.setAttribute('aria-busy','true');if(status)status.textContent=globalThis.AIWSI18n.text('Modeller sağlayıcıdan okunuyor…');
  try{const catalog=await api(`/providers/${provider}/models/refresh`,'POST',{});state.providerModels={...state.providerModels,[provider]:catalog};const box=button.closest('[data-provider-models]');if(box?.isConnected){box.outerHTML=providerModelsMarkup(provider);document.querySelector(`[data-provider-models="${provider}"] .provider-model-chips`)?.classList.add('ui-enter-fade');}toast(globalThis.AIWSI18n.template`${providers[provider]}: ${catalog.models.length} model yüklendi`);}
  catch(problem){if(status?.isConnected)status.textContent=problem.message;}
  finally{button.disabled=false;button.classList.remove('is-busy');button.removeAttribute('aria-busy');}
});
