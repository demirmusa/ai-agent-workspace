'use strict';
// Per-project provider overrides.
const projectProviderEditor=()=>activeScreen==='board'&&projectTab()==='settings'&&projectSettingsView?.projectId===project()?.id?projectSettingsView:null;
function projectProviderSnapshot(){const values=settingsSnapshot(projectProviderSettings());values.modelAutoMerge=cloneModelAutoMerge(project()?.providerSettings?.modelAutoMerge);values.defaultProviderInherited=!project()?.providerSettings?.defaultProvider;return values;}
function projectProviderOverrides(values){
  const saved=providerSettingsFromValues(values),global=projectProviderEditor()?.providerGlobalBaseline||providerSettingsFromValues(settingsSnapshot()),previous=projectProviderEditor()?.providerReset?{}:project()?.providerSettings||{},result={};
  for(const key of Object.keys(saved)){
    if(['providerArgs','defaultModels','disabledModels'].includes(key)){
      const empty=key==='defaultModels'?'':[];
      const entries=[...new Set([...Object.keys(saved[key]),...Object.keys(global[key])])].map(provider=>[provider,saved[key][provider]??empty]);
      const map=Object.fromEntries(entries.filter(([provider,value])=>provider in (previous[key]||{})||JSON.stringify(value)!==JSON.stringify(global[key][provider]??empty)));
      if(Object.keys(map).length)result[key]=map;
    }else if(key==='defaultProvider'){if(!values.defaultProviderInherited)result[key]=saved[key];}
    else if(key==='modelAutoMerge'||key in previous||JSON.stringify(saved[key])!==JSON.stringify(global[key]))result[key]=saved[key];
  }
  return result;
}
function projectProvidersMarkup(current){const values=projectSettingsView?.projectId===current.id&&projectSettingsView.providerDraft||{...settingsSnapshot(projectProviderSettings(current)),defaultProviderInherited:!current.providerSettings?.defaultProvider};return providersSettingsMarkup(values,true);}
function renderProviderEditor(){const view=projectProviderEditor();if(!view){renderSettingsPage(true);return;}const panel=$('#settings-panel-providers',view.form);panel.innerHTML=projectProvidersMarkup(project());}
