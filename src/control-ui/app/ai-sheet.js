'use strict';
// The AI preparation sheet: a bottom popup that follows the selected project, its workspace element (header, canvas, dock and
// conversation column, each wired by its own file) and the update that redraws them.
// Icons the shared set lacks: a draft card's expand arrows and the conversation column toggle.
const aiExpandIcon=window.AIWSUI.icon('expand');
const aiChatIcon='<svg class="ui-icon" width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.25 2.75h7.5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H7.5l-3 2.5v-2.5h-.25a1.5 1.5 0 0 1-1.5-1.5v-5a1.5 1.5 0 0 1 1.5-1.5z"/></svg>';
// The topbar's "AI ile hazırla" button opens and closes the sheet.
$('#ai-create-task').onclick=()=>aiSheetOpen?closeAISheet():openAIWorkspace();
function aiSheet(){
  let sheet=$('#ai-sheet');if(sheet)return sheet;
  const backdrop=document.createElement('div');backdrop.id='ai-sheet-backdrop';backdrop.className='ai-sheet-backdrop';backdrop.hidden=true;backdrop.onclick=()=>closeAISheet();
  sheet=document.createElement('section');sheet.id='ai-sheet';sheet.className='ai-sheet';sheet.hidden=true;sheet.setAttribute('role','dialog');sheet.setAttribute('aria-modal','false');sheet.setAttribute('aria-labelledby','ai-sheet-title');
  // Escape inside the sheet only closes the sheet; the board's Escape would also close the task panel.
  sheet.addEventListener('keydown',event=>{if(event.key!=='Escape'||event.defaultPrevented||$('#modal').open)return;event.preventDefault();event.stopPropagation();closeAISheet();});
  $('#modal').before(backdrop,sheet);return sheet;
}
function openAIWorkspace(prefill=''){
  if(!project())return;
  if(activeScreen!=='board'||projectTab()!=='board'){activeScreen='board';selectedTaskId=null;selectedHistory=null;localStorage.setItem(`aiws.project-tab.${projectId}`,'board');}
  aiSheetOpen=true;render();
  const field=aiWorkspace(projectId).element?.querySelector('#ai-message');if(!field)return;if(prefill&&!field.value.trim())field.value=prefill;field.focus({preventScroll:true});
}
function closeAISheet(returnFocus=true){if(!aiSheetOpen)return;aiSheetOpen=false;syncAISheet();if(returnFocus&&!$('#ai-create-task').hidden)$('#ai-create-task').focus({preventScroll:true});}
// Called by render(): the sheet follows the selected project and closes where the AI button is not offered.
function syncAISheet(){
  const button=$('#ai-create-task');if(aiSheetOpen&&(button.hidden||activeScreen!=='board'||!project()))aiSheetOpen=false;
  button.classList.toggle('active',aiSheetOpen);button.setAttribute('aria-pressed',String(aiSheetOpen));
  const sheet=aiSheet(),opening=sheet.hidden&&aiSheetOpen;sheet.classList.toggle('is-fullscreen',aiFullscreen);sheet.hidden=!aiSheetOpen;{const toggle=$('#ai-fullscreen'),label=globalThis.AIWSI18n.text(aiFullscreen?'Tam ekrandan çık':'Tam ekran');if(toggle){toggle.setAttribute('aria-pressed',String(aiFullscreen));toggle.title=label;toggle.setAttribute('aria-label',label);}}$('#ai-sheet-backdrop').hidden=!aiSheetOpen;
  if(!aiSheetOpen)return;
  // Opening the sheet builds the canvas in again, top-down, like the planner drew it.
  const workspace=aiWorkspace(projectId),element=aiWorkspaceElement(workspace);if(element.parentElement!==sheet)sheet.replaceChildren(element);if(opening)workspace.replay=true;updateAIWorkspace(workspace);
}

function aiWorkspaceElement(workspace){
  if(workspace.element)return workspace.element;
  const element=document.createElement('div');element.className='ai-workspace';element.id='ai-workspace';workspace.element=element;
  const {icon,sparkle}=window.AIWSUI,t=globalThis.AIWSI18n,examples=[t.text('Ayarlar sayfasına koyu tema ekle ve testlerini yaz.'),t.text('Giriş formundaki doğrulama hatalarını düzelt.'),t.text('README dosyasını kurulum adımlarıyla güncelle.')];
  element.innerHTML=t.template`<header class="ai-sheet-header"><h2 id="ai-sheet-title"><span class="ai-mark" data-tone="accent">${sparkle('accent')}</span>AI ile hazırla <span id="ai-draft-count" class="ai-count" hidden></span></h2><small class="ai-sheet-note">Sen oluşturmadan görev açılmaz</small><div class="ai-sheet-actions"><button type="button" class="button small ghost" id="ai-discard-all">Tümünü at</button><button type="button" class="button small" id="ai-create-ready" title="Bağımlılık sırasıyla Hazır sütununda oluşturur">Hazır olarak oluştur</button><button type="button" class="button small primary" id="ai-create-all">Tümünü oluştur</button><button type="button" class="button small ghost" id="ai-reset">Yeni konuşma</button><button type="button" class="icon-button ai-sheet-icon" id="ai-fullscreen" aria-pressed="false" aria-label="Tam ekran" title="Tam ekran">${aiExpandIcon}</button><button type="button" class="icon-button ai-sheet-icon" id="ai-chat-toggle" aria-controls="ai-chat" aria-expanded="true" aria-label="Konuşma" title="Konuşma">${aiChatIcon}</button><button type="button" class="icon-button ai-sheet-icon" id="ai-close" aria-label="AI panelini kapat" title="Kapat · Esc">${icon('x')}</button></div></header><div class="ai-body"><div id="ai-stage" class="ai-stage"><div id="ai-canvas" class="ai-canvas ui-canvas"><div id="ai-draft-list" class="ai-draft-list flow-list" role="list" aria-label="Görev taslakları" hidden><svg class="flow-links" aria-hidden="true"></svg><svg class="flow-ports" aria-hidden="true"></svg></div></div><div id="ai-zoom" class="ai-zoom" role="toolbar" aria-label="Tuval görünümü" hidden><button type="button" class="button small ghost" id="ai-layout-reset" hidden>Düzeni sıfırla</button><button type="button" class="icon-button ai-zoom-button" data-ai-zoom="out" aria-label="Uzaklaştır" title="Uzaklaştır">−</button><button type="button" class="ai-zoom-level" id="ai-zoom-level" data-ai-zoom="reset" aria-label="Gerçek boyut" title="Gerçek boyut">100%</button><button type="button" class="icon-button ai-zoom-button" data-ai-zoom="in" aria-label="Yakınlaştır" title="Yakınlaştır">+</button><button type="button" class="icon-button ai-zoom-button" data-ai-zoom="fit" aria-label="Sığdır" title="Sığdır · çift tıkla">${aiExpandIcon}</button></div><div id="ai-empty" class="ai-empty" hidden><div class="ai-empty-inner ui-enter"><span class="ai-empty-mark" data-tone="accent">${sparkle('accent')}</span><h3>Ne hazırlayalım?</h3><p>Yapılacak işi anlat; AI görev taslaklarını burada adım adım kurar.</p><div class="ai-examples">${examples.map(example=>`<button type="button" class="ai-example" data-ai-example="${esc(example)}">${esc(example)}</button>`).join('')}</div></div></div><div id="ai-dock" class="ai-dock"><div id="ai-progress" class="ai-progress" role="status" hidden><ol id="ai-activity" class="ai-activity popup-menu" aria-label="AI etkinliği" hidden></ol><div class="ai-progress-pill ui-enter" data-tone="running"><span class="ui-spinner" aria-hidden="true"></span><strong id="ai-progress-label">AI taslakları hazırlıyor…</strong><span id="ai-elapsed" class="ai-elapsed" aria-hidden="true"></span><span id="ai-activity-latest" class="ai-activity-latest"></span><button type="button" class="icon-button ai-activity-toggle" id="ai-activity-toggle" aria-controls="ai-activity" aria-expanded="false" aria-label="AI etkinliği" title="AI etkinliği" hidden>${icon('chevron')}</button><button type="button" class="button small ghost" id="ai-cancel">İptal et</button></div></div><div id="ai-retry-row" class="ai-retry-row ui-enter" data-tone="failed" hidden>${icon('alert')}<span>Son mesaj yanıtlanmadı.</span><button type="button" class="button small" id="ai-retry">↻ Tekrar dene</button></div><form id="ai-composer" class="ai-composer"><label class="sr-only" for="ai-message">AI için mesajın</label><textarea id="ai-message" rows="2" placeholder="Ne geliştirmek veya düzeltmek istiyorsun? AI görevleri çıkarır; kartlar üzerinde konuşarak düzenlemeye devam edebilirsin."></textarea><div id="ai-images" class="ai-images" role="list" aria-label="Referans görseller" hidden></div><div class="ai-composer-actions"><input type="file" id="ai-image-input" multiple hidden><button type="button" class="button small ghost" id="ai-attach" aria-label="Referans dosya ekle" title="Referans dosya ekle · yapıştırabilir veya sürükleyebilirsin">+ Dosya</button><label class="ai-select-chip" id="ai-agent-chip"><select id="ai-agent" aria-label="Taslak hazırlayan agent"></select>${icon('chevron')}</label><span id="ai-model-field" class="ai-model-field">${agentPickerMarkup(workspace.choice,{id:'ai-composer-model',variant:'ai-select-chip',command:false,inherit:`${t.text('Agenttan / varsayılan')} · ${providers[defaultProvider()]}`})}</span><button type="submit" class="button primary ai-send" id="ai-send">Gönder${icon('arrow-right')}</button></div></form></div></div><aside id="ai-chat" class="ai-chat" aria-label="Konuşma"><div id="ai-chat-log" class="ai-chat-log" role="log" aria-label="AI ile görev hazırlama konuşması" tabindex="0"></div></aside></div>`;
  const $=selector=>element.querySelector(selector);
  $('#ai-fullscreen').onclick=()=>{aiFullscreen=!aiFullscreen;try{localStorage.setItem('aiws.ai-fullscreen',aiFullscreen?'1':'0');}catch{/* Storage can be disabled. */}syncAISheet();};
  $('#ai-close').onclick=()=>{window.AIWSVoice.cancel();closeAISheet();};
  $('#ai-reset').onclick=()=>{if(workspace.busy)return;workspace.messages=[];workspace.drafts=[];workspace.retry='';saveAIWorkspace(workspace);updateAIWorkspace(workspace);updateAITab();$('#ai-message').focus();};
  $('#ai-discard-all').onclick=()=>{const count=aiOpenDrafts(workspace).length;if(!count)return;workspace.drafts=workspace.drafts.filter(draft=>draft.createdTaskId);saveAIWorkspace(workspace);updateAIWorkspace(workspace);updateAITab();toast(globalThis.AIWSI18n.template`${count} taslak atıldı`);};
  $('#ai-create-all').onclick=()=>void createAllAIDrafts(workspace);
  $('#ai-create-ready').onclick=()=>void createAllAIDrafts(workspace,'ready');
  aiMountDock(workspace,element);aiMountChat(element);aiMountCanvas(workspace,element);aiBindDraftCards(workspace,$('#ai-draft-list'));
  return element;
}
function updateAIWorkspace(workspace){
  const element=workspace.element;if(!element||!element.isConnected)return;const $=selector=>element.querySelector(selector),t=globalThis.AIWSI18n,{motion}=window.AIWSUI;
  renderAIChat(workspace);
  $('#ai-agent-chip').hidden=!aiPlannerAgents(workspace.agentId).length;setAIOptions($('#ai-agent'),aiAgentOptions(workspace.agentId,t.template`Otomatik agent · ${providers[defaultProvider()]}`),workspace.agentId);
  renderAIProgress(workspace);renderAIDrafts(workspace);
  const open=aiOpenDrafts(workspace).length,count=$('#ai-draft-count');count.hidden=!open;motion.countTo(count,open||undefined);
  $('#ai-create-all').hidden=open<2;$('#ai-discard-all').hidden=!open;$('#ai-create-all').disabled=workspace.creating.size>0;$('#ai-create-ready').hidden=!open;$('#ai-create-ready').disabled=workspace.creating.size>0;$('#ai-reset').hidden=!workspace.messages.length&&!workspace.drafts.length;
  $('#ai-empty').hidden=Boolean(workspace.drafts.length||workspace.messages.length||workspace.busy);
  $('#ai-zoom').hidden=!workspace.drafts.length;$('#ai-layout-reset').hidden=!workspace.drafts.some(draft=>draft.offset);
}
