'use strict';
// Finding installed provider CLIs on the control server's machine.
const providerDetection={result:null,loading:false,error:''};
async function detectProviders(refresh=false){
  if(providerDetection.loading)return;providerDetection.loading=true;providerDetection.error='';if(activeScreen==='settings')updateSettingsDynamic();
  try{providerDetection.result=await api(`/providers/detect${refresh?'?refresh=1':''}`);}catch(cause){providerDetection.error=cause.message;}
  finally{providerDetection.loading=false;if(activeScreen==='settings')updateSettingsDynamic();}
}
function providerDetectionMarkup(id){
  const item=providerDetection.result?.providers.find(entry=>entry.id===id),t=globalThis.AIWSI18n.text,pill=window.AIWSUI.statusPill;
  if(!item)return providerDetection.loading?pill('running',t('Bu bilgisayarda aranıyor…')):providerDetection.error?pill('failed',t('Tarama yapılamadı')):pill('idle',t('Henüz taranmadı'));
  const facts=[item.path?globalThis.AIWSI18n.template`<div><dt>Konum</dt><dd title="${esc(item.path)}">${esc(item.path)}</dd></div>`:'',item.home?globalThis.AIWSI18n.template`<div><dt>Yapılandırma</dt><dd title="${esc(item.home)}">${item.homeExists?globalThis.AIWSI18n.text('Bulundu'):globalThis.AIWSI18n.text('Yok')} · ${esc(item.home)}</dd></div>`:'',item.sessions!==null?globalThis.AIWSI18n.template`<div><dt>Yerel oturum</dt><dd>${item.sessions}${item.sessionsCapped?'+':''}</dd></div>`:''].join('');
  return `${item.installed?pill('done',`${t('Kurulu')}${item.version?` · ${item.version}`:''}`):pill('idle',`${t('PATH üzerinde bulunamadı')} · ${item.executable}`)}${facts?`<dl class="provider-facts">${facts}</dl>`:''}`;
}
