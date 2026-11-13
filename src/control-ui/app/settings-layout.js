'use strict';
// Shared building blocks of work settings and project settings, so both pages look the same.
// Every settings tab opens with one panel header; a tab with several parts splits them into sub tabs. All sub panels
// stay in the form and only the selected one is shown, so saving, drafts and validation see every field.
const settingsSubtabsSaved=(()=>{try{const saved=JSON.parse(localStorage.getItem('aiws.settings-subtabs')||'{}');return saved&&typeof saved==='object'&&!Array.isArray(saved)?saved:{};}catch{return {};}})();
/** The header at the top of a settings tab. Title, description and actions are HTML; callers escape their values. */
function settingsPanelHeader(title,description='',actions=''){return `<header class="settings-panel-header"><div><h2>${title}</h2>${description?`<p>${description}</p>`:''}</div>${actions?`<div class="settings-section-actions">${actions}</div>`:''}</header>`;}
/** Sub tabs inside a settings tab. scope names the group in ids and in the remembered choice; items are {id,label,description?,body}. */
function settingsSubtabsMarkup(scope,label,items){
  const saved=settingsSubtabsSaved[scope],active=items.some(item=>item.id===saved)?saved:items[0].id,key=id=>`${scope}-${id}`;
  const tabs=items.map(item=>`<button type="button" class="view-tab settings-subtab${item.id===active?' active':''}" role="tab" id="settings-subtab-${key(item.id)}" data-settings-subtab="${item.id}" aria-controls="settings-subpanel-${key(item.id)}" aria-selected="${item.id===active}" tabindex="${item.id===active?0:-1}">${esc(item.label)}</button>`).join('');
  const panels=items.map(item=>`<div class="settings-subpanel" id="settings-subpanel-${key(item.id)}" role="tabpanel" data-settings-subpanel="${item.id}" aria-labelledby="settings-subtab-${key(item.id)}"${item.id===active?'':' hidden'}>${item.description?`<p class="settings-subpanel-description">${esc(item.description)}</p>`:''}${item.body}</div>`).join('');
  return `<div class="settings-subtabs" data-settings-subtabs="${scope}"><div class="view-tabs settings-subtab-list" role="tablist" aria-label="${esc(label)}">${tabs}</div>${panels}</div>`;
}
const settingsSubtabButtons=group=>[...group.querySelectorAll(':scope>.settings-subtab-list>[data-settings-subtab]')];
function selectSettingsSubtab(group,id,focus=false){
  if(!group||!settingsSubtabButtons(group).some(tab=>tab.dataset.settingsSubtab===id))return;
  for(const tab of settingsSubtabButtons(group)){const active=tab.dataset.settingsSubtab===id;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;tab.classList.toggle('active',active);if(active&&focus)tab.focus();}
  for(const panel of group.querySelectorAll(':scope>[data-settings-subpanel]'))panel.hidden=panel.dataset.settingsSubpanel!==id;
  settingsSubtabsSaved[group.dataset.settingsSubtabs]=id;try{localStorage.setItem('aiws.settings-subtabs',JSON.stringify(settingsSubtabsSaved));}catch{/* The sub tab is only a convenience. */}
}
/** Shows the sub tab holding a field, so focus and validation messages never land in a hidden panel. */
function revealSettingsField(element){const panel=element?.closest?.('[data-settings-subpanel]');if(panel?.hidden)selectSettingsSubtab(panel.parentElement,panel.dataset.settingsSubpanel);}
document.addEventListener('click',event=>{const tab=event.target.closest?.('[data-settings-subtab]');if(tab)selectSettingsSubtab(tab.closest('[data-settings-subtabs]'),tab.dataset.settingsSubtab);});
document.addEventListener('keydown',event=>{const tab=event.target.closest?.('[data-settings-subtab]');if(!tab)return;const group=tab.closest('[data-settings-subtabs]'),next=window.AIWSUI.tabStep(event,settingsSubtabButtons(group).map(item=>item.dataset.settingsSubtab),tab.dataset.settingsSubtab);if(next)selectSettingsSubtab(group,next,true);});
document.addEventListener('invalid',event=>revealSettingsField(event.target),true);
