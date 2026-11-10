'use strict';
// The settings draft: snapshots of saved settings, edits from the form and the values sent on save.
let settingsDraft=null,settingsSaveState={status:'idle',message:''};
const cloneModelAutoMerge=map=>Object.fromEntries(Object.entries(map||{}).map(([provider,models])=>[provider,{...models}]));
function settingsSnapshot(settings=state.settings){return {taskMergeMode:settings.taskMergeMode||'pull-request',modelAutoMerge:cloneModelAutoMerge(settings.modelAutoMerge),defaultProvider:settings.defaultProvider||'codex',maxConcurrent:String(settings.maxConcurrent??3),executionMode:settings.executionMode||'native',dockerImage:settings.dockerImage||'aiws-control-worker:local',autoSyncSeconds:String(settings.autoSyncSeconds??30),githubTrigger:settings.githubTrigger||'/ai',systemPrompt:settings.systemPrompt||'',voiceProvider:settings.voiceProvider||'claude',providerArgs:Object.fromEntries(configurableProviders.map(provider=>[provider,(settings.providerArgs?.[provider]||[]).join('\n')])),disabledProviders:[...(settings.disabledProviders||[])],autoModeProviders:[...(settings.autoModeProviders||[])],defaultModels:{...(settings.defaultModels||{})},disabledModels:Object.fromEntries(Object.entries(settings.disabledModels||{}).map(([provider,list])=>[provider,[...list]])),customProviders:(settings.customProviders||[]).map(item=>({id:item.id,name:item.name,executable:item.executable,args:(item.args||[]).join('\n'),enabled:item.enabled!==false}))};}
const settingsValues=()=>{const view=projectProviderEditor();if(view)return view.providerDraft||projectProviderSnapshot();return settingsDraft||settingsSnapshot();};
const settingsDirty=()=>Boolean(settingsDraft)&&JSON.stringify(settingsDraft)!==JSON.stringify(settingsSnapshot());
function editSettings(){const view=projectProviderEditor();if(view){view.providerDraft??=projectProviderSnapshot();view.dirty=true;view.status='dirty';updateProjectSettingsState(view);return view.providerDraft;}settingsDraft??=settingsSnapshot();if(settingsSaveState.status!=='saving')settingsSaveState={status:'idle',message:''};return settingsDraft;}
function providerSettingsFromValues(values){return {defaultProvider:values.defaultProvider,providerArgs:providerArgsFromValues(values.providerArgs),disabledProviders:values.disabledProviders,autoModeProviders:values.autoModeProviders,defaultModels:values.defaultModels,disabledModels:values.disabledModels,modelAutoMerge:values.modelAutoMerge,customProviders:values.customProviders.map(item=>({...item,name:String(item.name).trim(),executable:String(item.executable).trim(),args:String(item.args).split(/\r\n|\r|\n/).filter(value=>value.trim().length)}))};}
function providerArgsFromValues(values){
  return Object.fromEntries(configurableProviders.map(provider=>{const args=String(values[provider]||'').split(/\r\n|\r|\n/).filter(value=>value.trim().length);if(args.length>64)throw new Error(globalThis.AIWSI18n.template`${providers[provider]} için en fazla 64 CLI argümanı girebilirsin.`);if(args.some(value=>value.length>4096||value.includes('\0')))throw new Error(globalThis.AIWSI18n.template`${providers[provider]} argümanları NUL içeremez ve her biri en fazla 4096 karakter olmalı.`);return [provider,args];}));
}
function settingsTabHasChanges(tab){if(!settingsDraft)return false;const before=settingsSnapshot(),fields={general:['defaultProvider','maxConcurrent','systemPrompt'],providers:['providerArgs','disabledProviders','autoModeProviders','customProviders','defaultModels','disabledModels','modelAutoMerge'],git:['taskMergeMode','autoSyncSeconds','githubTrigger'],execution:['executionMode','dockerImage'],voice:['voiceProvider']}[tab]||[];return fields.some(field=>JSON.stringify(settingsDraft[field])!==JSON.stringify(before[field]));}
function updateSettingsField(target,rerender=true){
  if(!target.closest('#settings-form,#settings-panel-providers')||target.id==='settings-system-enabled')return false;
  if(target.dataset.providerToggle){const draft=editSettings(),provider=target.dataset.providerToggle;draft.disabledProviders=target.checked?draft.disabledProviders.filter(value=>value!==provider):[...new Set([...draft.disabledProviders,provider])];if(rerender)syncProviderCard(provider);return true;}
  if(target.dataset.providerAuto){const draft=editSettings(),provider=target.dataset.providerAuto;draft.autoModeProviders=target.checked?[...new Set([...draft.autoModeProviders,provider])]:draft.autoModeProviders.filter(value=>value!==provider);return true;}
  if(target.dataset.customField){const item=editSettings().customProviders[Number(target.dataset.customIndex)];if(!item)return false;item[target.dataset.customField]=target.type==='checkbox'?target.checked:target.value;if(target.dataset.customField==='enabled'){if(rerender)target.closest('[data-custom-card]')?.classList.toggle('is-disabled',!target.checked);}else if(target.dataset.customField==='name')$(`#custom-provider-${target.dataset.customIndex}-title`).textContent=target.value||globalThis.AIWSI18n.text('Yeni sağlayıcı');return true;}
  if(target.name?.startsWith('providerArgs-')){editSettings().providerArgs[target.name.slice(13)]=target.value;return true;}
  if(['taskMergeMode','defaultProvider','maxConcurrent','executionMode','dockerImage','autoSyncSeconds','githubTrigger','systemPrompt','voiceProvider'].includes(target.name)){editSettings()[target.name]=target.value;if(target.name==='defaultProvider'&&rerender)renderProviderEditor();return true;}
  return false;
}
/** Values set without input events (autofill, scripts) still reach the draft before saving. */
function syncSettingsForm(form=$('#settings-form')){
  if(!form)return;
  for(const element of form.querySelectorAll('input,select,textarea')){
    const values=settingsValues(),index=Number(element.dataset.customIndex),custom=values.customProviders[index];let same=true;
    if(element.dataset.providerToggle)same=!values.disabledProviders.includes(element.dataset.providerToggle)===element.checked;
    else if(element.dataset.providerAuto)same=values.autoModeProviders.includes(element.dataset.providerAuto)===element.checked;
    else if(element.dataset.customField)same=!custom||(element.type==='checkbox'?custom.enabled===element.checked:custom[element.dataset.customField]===element.value);
    else if(element.name?.startsWith('providerArgs-'))same=values.providerArgs[element.name.slice(13)]===element.value;
    else if(element.name&&element.name in values)same=String(values[element.name])===element.value;
    if(!same)updateSettingsField(element,false);
  }
}
