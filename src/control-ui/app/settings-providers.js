'use strict';
// The providers tab of work and project settings: its markup and the provider and custom provider actions.
function providersSettingsMarkup(values,project=false){
  const t=globalThis.AIWSI18n.text,description=t('Bu bilgisayarda kurulu CLI araçları, yapılandırma klasörleri ve yerel oturum geçmişi otomatik bulunur. Kapalı sağlayıcılar yeni görevlerde ve otomatik seçimde kullanılmaz.');
  const actions=`${project?`<button type="button" class="button small ghost" id="project-providers-inherit">${esc(t('Genel sağlayıcı ayarlarına dön'))}</button>`:''}<button type="button" class="button small" id="detect-providers"><span class="button-glyph" aria-hidden="true">↻</span> ${esc(t('Yeniden tara'))}</button>`;
  return settingsPanelHeader(esc(t('Sağlayıcılar')),esc(project?`${description} ${projectSectionMeta().descriptions.providers}`:description),actions)+settingsSubtabsMarkup(project?'project-providers':'work-providers',t('Sağlayıcı ayar bölümleri'),[
    {id:'providers',label:t('Sağlayıcılar'),body:`<p class="provider-detect-summary" id="provider-detect-summary" role="status" aria-live="polite"></p><div class="provider-grid">${configurableProviders.map(provider=>builtinProviderCard(provider,values)).join('')}</div>`},
    ...(project?[]:[{id:'accounts',label:t('Hesaplar'),body:providerAccountsSectionMarkup()}]),
    {id:'custom',label:t('Özel sağlayıcılar'),description:t('Kendi CLI aracını ekle. Görev ve agent formlarında sağlayıcı olarak seçilebilir; komut sağlayıcısı gibi çalışır.'),body:`<div class="settings-subpanel-actions"><button type="button" class="button small" id="add-custom-provider">+ ${esc(t('Sağlayıcı ekle'))}</button></div><div class="provider-grid">${values.customProviders.map(customProviderCard).join('')||`<p class="settings-empty">${esc(t('Henüz özel sağlayıcı yok.'))}</p>`}</div>`}]);
}
document.addEventListener('click',event=>{
  const target=event.target.closest('#settings-page button,#settings-panel-providers button');if(!target)return;
  if(target.id==='detect-providers'){void detectProviders(true);return;}
  if(target.id==='project-providers-inherit'){const view=projectProviderEditor();view.providerDraft=settingsSnapshot();view.providerDraft.modelAutoMerge={};view.providerDraft.defaultProviderInherited=true;view.providerReset=true;view.providerGlobalBaseline=providerSettingsFromValues(settingsSnapshot());view.dirty=true;view.status='dirty';updateProjectSettingsState(view);renderProviderEditor();return;}
  if(target.dataset.providerDefault){const draft=editSettings();draft.defaultProvider=target.dataset.providerDefault;if(projectProviderEditor())draft.defaultProviderInherited=false;renderProviderEditor();$(`#provider-default-${target.dataset.providerDefault}`)?.focus();return;}
  if(target.id==='add-custom-provider'){const draft=editSettings();draft.customProviders.push({id:'',name:'',executable:'',args:'',enabled:true});renderProviderEditor();$(`#custom-provider-${draft.customProviders.length-1}-name`)?.focus();return;}
  if(target.dataset.customRemove!==undefined){editSettings().customProviders.splice(Number(target.dataset.customRemove),1);renderProviderEditor();$('#add-custom-provider')?.focus();}
});
