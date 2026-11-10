'use strict';
// The system on/off switch.
let systemToggleBusy=false;
function renderSystemControl(){
  const enabled=state.settings.systemEnabled!==false,draining=state.systemStatus==='draining';
  const checkbox=$('#system-enabled'),control=$('#system-control');
  checkbox.checked=enabled;checkbox.indeterminate=draining;checkbox.disabled=systemToggleBusy||!state.systemStatus;
  control.setAttribute('aria-busy',String(draining||systemToggleBusy));
  $('.ui-spinner',control).hidden=!draining&&!systemToggleBusy;
  $('#system-status').textContent=systemToggleBusy?globalThis.AIWSI18n.text('Kaydediliyor…'):draining?globalThis.AIWSI18n.text('Durduruluyor…'):enabled?globalThis.AIWSI18n.text('Sistem çalışıyor'):globalThis.AIWSI18n.text('Sistem durdu');
  control.title=draining?globalThis.AIWSI18n.text('Mevcut görevlerin tamamlanması bekleniyor. Yeni görevler başlamaz. Yeniden açmak için işaretle.'):enabled?globalThis.AIWSI18n.text('Mevcut görevleri tamamlayarak durdur'):globalThis.AIWSI18n.text('Sistemi aç ve sıradaki görevleri başlat');
  if(activeScreen==='settings')updateSettingsDynamic();
}
async function setSystemEnabled(enabled){
  if(systemToggleBusy)return;systemToggleBusy=true;renderSystemControl();
  try{await api('/settings','PATCH',{systemEnabled:enabled});await refresh();}catch(cause){error(cause.message);}finally{systemToggleBusy=false;renderSystemControl();}
}
$('#system-enabled').onchange=()=>void setSystemEnabled($('#system-enabled').checked);
