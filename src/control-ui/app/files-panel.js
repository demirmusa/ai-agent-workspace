'use strict';
// The files panel.
// The files panel opens on the right like a mirror of the sidebar. One explorer per project folder
// keeps its expanded folders while switching projects; a clicked file opens in the project's editor (file-editor.js).
const projectFileViews=new Map();
// A `files` event from the server's watcher: every explorer of that project reloads the folders that changed.
function projectFilesChanged(change){for(const view of projectFileViews.values())if(view.projectId===change.projectId)view.changed(change);}
function filesPanelOpen(){return localStorage.getItem('aiws.files-panel')==='true';}
function renderFilesPanel(){
  const current=activeScreen==='board'?project():null,open=Boolean(current)&&filesPanelOpen(),panel=$('#files-panel'),toggle=$('#files-toggle'),label=globalThis.AIWSI18n.text(open?'Dosyaları gizle':'Dosyaları göster');
  toggle.hidden=!current;toggle.classList.toggle('active',open);toggle.setAttribute('aria-expanded',String(open));toggle.title=label;toggle.setAttribute('aria-label',label);
  const opening=open&&panel.hidden;$('.app-shell').classList.toggle('files-open',open);panel.hidden=!open;
  if(open){const key=projectFolderKey(current);let view=projectFileViews.get(key);if(!view){view=window.AIWSFiles.create({projectId:current.id,api,toast,onClose:()=>setFilesPanel(false),onOpen:openProjectFile,onNewFile:folder=>newProjectFileDialog(current,folder)});projectFileViews.set(key,view);}const body=$('.files-panel-body',panel);if(view.element.parentElement!==body){body.replaceChildren(view.element);view.show();}else if(opening)view.refresh();}
  placeFilesPanel();
}
// "New file": the name with its extension and the folder it goes into (prefilled with the selected folder); the new file opens in the editor.
function newProjectFileDialog(current,folder){
  const t=globalThis.AIWSI18n.text;
  showModal(t('Yeni dosya'),`<form>${field(t('Dosya adı'),'name','','text',`required maxlength="255" autofocus spellcheck="false" autocomplete="off" placeholder="${esc(t('Örn. notlar.md'))}"`)}${field(t('Klasör'),'folder',folder,'text',`list="new-file-folders" spellcheck="false" autocomplete="off" placeholder="${esc(t('Proje kök klasörü'))}"`)}<datalist id="new-file-folders"></datalist><p class="form-hint">${esc(t('Uzantıyı da yaz. Klasör proje klasörüne göredir; boş bırakırsan dosya proje kök klasörüne eklenir.'))}</p>${formFooter(t('Oluştur'))}</form>`,async data=>{
    const created=await api(`/projects/${encodeURIComponent(current.id)}/files/create`,'POST',{name:String(data.get('name')||'').trim(),folder:String(data.get('folder')||'').trim()});
    // The dialog closes before the file opens: an open dialog keeps the editor behind it as it is.
    $('#modal').close();
    await projectFileViews.get(projectFolderKey(current))?.reveal(created.path);
    toast(t('Dosya oluşturuldu'));openProjectFile(created.path);
  });
  // Typing in the folder field suggests the project's folders, so a folder can be found by part of its name.
  const input=$('#field-folder'),list=$('#new-file-folders');let asked='';
  const suggest=async()=>{const query=input.value.trim();if(query===asked)return;asked=query;try{const {items}=await api(`/projects/${encodeURIComponent(current.id)}/files/search?${new URLSearchParams({q:query,limit:'50'})}`);if(asked===query&&list.isConnected)list.innerHTML=items.filter(item=>item.type==='directory').map(item=>`<option value="${esc(item.path)}"></option>`).join('');}catch{/* Suggestions are optional. */}};
  input.addEventListener('input',()=>void suggest());void suggest();
}
function setFilesPanel(open){localStorage.setItem('aiws.files-panel',String(open));renderFilesPanel();applyDetailWidth();if(!open&&!$('#modal').open)$('#files-toggle').focus();}
$('#files-toggle').onclick=()=>setFilesPanel(!filesPanelOpen());
// A modal dialog makes the rest of the page inert, so while one is open the panel moves into the
// dialog and floats over its own column; files stay draggable into the new task form.
function placeFilesPanel(){
  const panel=$('#files-panel'),modal=$('#modal'),shell=$('.app-shell'),floating=modal.open&&!panel.hidden;
  if(floating&&panel.parentElement!==modal){panel.style.top=`${$('.topbar').getBoundingClientRect().bottom}px`;modal.append(panel);}
  else if(!floating&&panel.parentElement!==shell){panel.style.top='';shell.append(panel);}
  panel.classList.toggle('floating',floating);
}
new MutationObserver(placeFilesPanel).observe($('#modal'),{attributes:true,attributeFilter:['open']});
window.addEventListener('resize',()=>{const panel=$('#files-panel');if(panel.classList.contains('floating'))panel.style.top=`${$('.topbar').getBoundingClientRect().bottom}px`;});
// The panel is resized from its left edge, like the sidebar's right edge.
function setFilesPanelWidth(width,save=true){width=Math.round(Math.min(Math.max(width,200),Math.max(200,Math.min(640,innerWidth*.5))));document.documentElement.style.setProperty('--files-panel-width',`${width}px`);if(save)localStorage.setItem('aiws.files-panel-width',String(width));applyDetailWidth();}
if(Number(localStorage.getItem('aiws.files-panel-width')))setFilesPanelWidth(Number(localStorage.getItem('aiws.files-panel-width')),false);
$('.files-panel-resize').addEventListener('pointerdown',event=>{
  if(event.button!==0)return;event.preventDefault();const handle=event.currentTarget;handle.setPointerCapture?.(event.pointerId);document.body.classList.add('resizing-files-panel');
  const move=e=>setFilesPanelWidth(innerWidth-e.clientX),end=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);document.body.classList.remove('resizing-files-panel');};
  handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
});
$('.files-panel-resize').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();setFilesPanelWidth($('#files-panel').getBoundingClientRect().width+(event.key==='ArrowLeft'?16:-16));});
