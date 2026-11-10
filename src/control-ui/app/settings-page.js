'use strict';
// Work settings page: tabs, draft values and saving.
// Work settings are a page with tabs. Edits live in settingsDraft until saved, so server pushes never overwrite them.
const settingsTabIds=['general','providers','git','execution','voice','plugins'];
let settingsTab=(()=>{try{const saved=localStorage.getItem('aiws.settings-tab');return settingsTabIds.includes(saved)?saved:'general';}catch{return 'general';}})(),settingsRenderedKey='',settingsReturnScreen='board';
function settingsMarkup(values){
  const labels=settingsTabLabels();
  const icons={general:pageIcon('sliders'),providers:window.AIWSUI.icon('spark'),voice:window.AIWSUI.icon('mic'),execution:pageIcon('play'),git:pageIcon('branch'),plugins:window.AIWSUI.icon('plug')};
  return globalThis.AIWSI18n.template`<div id="settings-page" class="settings-page project-settings work-settings"><div class="settings-page-head"><button type="button" class="button small ghost settings-back" id="settings-back"><span aria-hidden="true">←</span> Geri</button></div><form id="settings-form" class="settings-form"><div class="project-settings-layout"><nav class="settings-tabs" id="work-settings-tabs" role="tablist" aria-label="Çalışma ayarları bölümleri" aria-orientation="vertical"><span class="settings-tab-pill" aria-hidden="true"></span>${settingsTabIds.map(id=>`<button type="button" class="settings-tab${settingsTab===id?' active':''}" role="tab" id="settings-tab-${id}" data-settings-tab="${id}" aria-selected="${settingsTab===id}" aria-controls="settings-panel" tabindex="${settingsTab===id?'0':'-1'}"><span class="settings-tab-icon">${icons[id]}</span><span>${esc(labels[id])}</span><span class="settings-tab-dot" aria-hidden="true"></span></button>`).join('')}</nav><div id="settings-panel" class="settings-panel" role="tabpanel" aria-labelledby="settings-tab-${settingsTab}">${settingsPanelMarkup(values)}</div></div><footer class="settings-savebar" data-state="clean"><span id="settings-save-status" class="settings-save-status save-state" role="status" aria-live="polite"></span><div class="settings-savebar-actions"><button type="button" class="button ghost" id="settings-discard">Değişiklikleri geri al</button><button type="submit" class="button primary" id="settings-save">Kaydet</button></div></footer></form></div>`;
}
function renderSettingsPage(force=false){
  const board=$('#board'),key=JSON.stringify([settingsTab,settingsDraft?'draft':settingsValues()]);
  if(force||key!==settingsRenderedKey||!$('#settings-page',board)){
    const active=document.activeElement,focusId=board.contains(active)?active.id:'',selection=focusId&&typeof active.selectionStart==='number'?[active.selectionStart,active.selectionEnd]:null;
    board.className='board settings-board';board.innerHTML=settingsMarkup(settingsValues());settingsRenderedKey=key;
    const target=focusId&&document.getElementById(focusId);if(target){target.focus({preventScroll:true});if(selection&&target.setSelectionRange)try{target.setSelectionRange(...selection);}catch{/* Number inputs have no selection. */}}
    placeSettingsPill($('#work-settings-tabs',board));
    syncZoomSetting();
    window.AIWSPlugins?.renderSettings($('#plugins-settings',board));
  }
  window.AIWSUI.motion.enter(board,'[data-motion-key]','data-motion-key',{stagger:30,max:6});
  updateSettingsDynamic();
  if(!providerDetection.result&&!providerDetection.loading&&!providerDetection.error)void detectProviders();
}
function updateSettingsDynamic(){
  const page=$('#settings-page');if(!page)return;
  const system=$('#settings-system-enabled',page);if(system){const draining=state.systemStatus==='draining';system.checked=state.settings.systemEnabled!==false;system.disabled=systemToggleBusy||!state.systemStatus;$('#settings-system-status',page).textContent=systemToggleBusy?globalThis.AIWSI18n.text('Kaydediliyor…'):draining?globalThis.AIWSI18n.text('Mevcut görevler bitince durur. Yeni görevler başlamaz.'):system.checked?globalThis.AIWSI18n.text('Sıradaki görevler otomatik başlar.'):globalThis.AIWSI18n.text('Sistem durdu. Yeni görevler başlamaz.');}
  for(const element of page.querySelectorAll('[data-provider-detect]'))if(element.dataset.providerDetect)setHtml(element,providerDetectionMarkup(element.dataset.providerDetect));
  for(const element of page.querySelectorAll('[data-provider-accounts]'))setHtml(element,providerAccountsMarkup(element.dataset.providerAccounts));
  const scan=$('#detect-providers',page);if(scan){scan.disabled=providerDetection.loading;scan.classList.toggle('is-busy',providerDetection.loading);scan.setAttribute('aria-busy',String(providerDetection.loading));const items=providerDetection.result?.providers||[];$('#provider-detect-summary',page).textContent=providerDetection.loading?globalThis.AIWSI18n.text('Bu bilgisayardaki sağlayıcılar aranıyor…'):providerDetection.error?globalThis.AIWSI18n.template`Tarama başarısız: ${providerDetection.error}`:providerDetection.result?globalThis.AIWSI18n.template`${items.filter(item=>item.installed).length}/${items.length} sağlayıcı bulundu · son tarama ${time(providerDetection.result.checkedAt)}`:'';}
  const dirty=settingsDirty(),saving=settingsSaveState.status==='saving',status=$('#settings-save-status',page);
  status.textContent=saving?globalThis.AIWSI18n.text('Kaydediliyor…'):settingsSaveState.status==='error'?settingsSaveState.message:dirty?globalThis.AIWSI18n.text('Kaydedilmemiş değişiklikler var'):settingsSaveState.status==='saved'?globalThis.AIWSI18n.text('Kaydedildi'):globalThis.AIWSI18n.text('Tüm değişiklikler kaydedildi');
  status.dataset.state=status.closest('.settings-savebar').dataset.state=saving?'saving':settingsSaveState.status==='error'?'error':dirty?'dirty':settingsSaveState.status==='saved'?'saved':'clean';
  const save=$('#settings-save',page);save.disabled=saving||!dirty;save.classList.toggle('is-busy',saving);save.setAttribute('aria-busy',String(saving));$('#settings-discard',page).hidden=!dirty||saving;
  for(const tab of page.querySelectorAll('[data-settings-tab]'))tab.classList.toggle('has-changes',dirty&&settingsTabHasChanges(tab.dataset.settingsTab));
}
async function saveSettings(){
  if(settingsSaveState.status==='saving'||!settingsDirty())return;
  const values=settingsValues(),sent=JSON.stringify(values);let body;
  try{body={...providerSettingsFromValues(values),taskMergeMode:values.taskMergeMode,maxConcurrent:Number(values.maxConcurrent),executionMode:values.executionMode,dockerImage:String(values.dockerImage).trim(),autoSyncSeconds:Number(values.autoSyncSeconds),githubTrigger:String(values.githubTrigger).trim()||'/ai',systemPrompt:String(values.systemPrompt).trim(),voiceProvider:values.voiceProvider};}
  catch(cause){settingsSaveState={status:'error',message:cause.message};updateSettingsDynamic();return;}
  settingsSaveState={status:'saving',message:''};updateSettingsDynamic();
  try{const saved=await api('/settings','PATCH',body);const customChanged=JSON.stringify((state.settings.customProviders||[]).map(item=>item.executable))!==JSON.stringify((saved.customProviders||[]).map(item=>item.executable));state.settings=saved;window.AIWSVoice?.refresh();if(JSON.stringify(settingsDraft)===sent)settingsDraft=null;settingsSaveState={status:'saved',message:''};if(customChanged)void detectProviders();await refresh();}
  catch(cause){settingsSaveState={status:'error',message:cause.message};}
  finally{if(activeScreen==='settings')renderSettingsPage();}
}
function selectSettingsTab(tab,focus=false){if(!settingsTabIds.includes(tab))return;settingsTab=tab;try{localStorage.setItem('aiws.settings-tab',tab);}catch{/* The tab is only a convenience. */}renderSettingsPage(true);if(focus)$(`#settings-tab-${tab}`)?.focus();}
document.addEventListener('click',event=>{
  const target=event.target.closest('#settings-page button,#settings-panel-providers button');if(!target)return;
  if(target.dataset.settingsTab){selectSettingsTab(target.dataset.settingsTab);return;}
  if(target.id==='settings-back'){switchScreen(settingsReturnScreen);return;}
  if(target.id==='settings-discard'){settingsDraft=null;settingsSaveState={status:'idle',message:''};renderSettingsPage(true);return;}
});
document.addEventListener('keydown',event=>{if(!event.target.matches?.('[data-settings-tab]'))return;const next=window.AIWSUI.tabStep(event,settingsTabIds,settingsTab);if(next)selectSettingsTab(next,true);});
for(const type of ['input','change'])document.addEventListener(type,event=>{if(event.target.id==='settings-system-enabled'&&type==='change'){void setSystemEnabled(event.target.checked);return;}if(event.target.id==='motion-select'){if(type==='change')window.AIWSUI.setMotionPreference(event.target.value);return;}if(updateSettingsField(event.target)&&!projectProviderEditor())updateSettingsDynamic();});
document.addEventListener('submit',event=>{if(event.target.id!=='settings-form')return;event.preventDefault();syncSettingsForm();void saveSettings();});
