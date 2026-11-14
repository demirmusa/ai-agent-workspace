'use strict';
// The files panel.
// The files panel opens on the right like a mirror of the sidebar. One explorer per project folder
// keeps its expanded folders while switching projects; a clicked file opens in the project's editor (file-editor.js).
const projectFileViews=new Map();
function filesPanelOpen(){return localStorage.getItem('aiws.files-panel')==='true';}
function renderFilesPanel(){
  const current=activeScreen==='board'?project():null,open=Boolean(current)&&filesPanelOpen(),panel=$('#files-panel'),toggle=$('#files-toggle'),label=globalThis.AIWSI18n.text(open?'Dosyaları gizle':'Dosyaları göster');
  toggle.hidden=!current;toggle.classList.toggle('active',open);toggle.setAttribute('aria-expanded',String(open));toggle.title=label;toggle.setAttribute('aria-label',label);
  const opening=open&&panel.hidden;$('.app-shell').classList.toggle('files-open',open);panel.hidden=!open;
  if(open){const key=projectFolderKey(current);let view=projectFileViews.get(key);if(!view){view=window.AIWSFiles.create({projectId:current.id,api,toast,onClose:()=>setFilesPanel(false),onOpen:openProjectFile,onCreateFile:(folder,name)=>createProjectFile(current,folder,name)});projectFileViews.set(key,view);}const body=$('.files-panel-body',panel);if(view.element.parentElement!==body){body.replaceChildren(view.element);view.show();}else if(opening)view.refresh();}
  placeFilesPanel();
}
// "New file" is typed inline in the explorer tree; this creates the file and returns its project-relative path, which the explorer reveals and opens.
async function createProjectFile(current,folder,name){return (await api(`/projects/${encodeURIComponent(current.id)}/files/create`,'POST',{name,folder})).path;}
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
