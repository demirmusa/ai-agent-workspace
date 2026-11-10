'use strict';
// Minimizing and restoring a new task draft.
let minimizedTaskDraft=null;
let draftDragMoved=false,draftButtonPosition=null;
// The minimized draft button can be dragged out of the way; a drag never counts as a click.
function makeDraftButtonDraggable(button){
  const place=(left,top)=>{
    const rect=button.getBoundingClientRect();
    left=Math.min(Math.max(0,left),Math.max(0,innerWidth-rect.width));top=Math.min(Math.max(0,top),Math.max(0,innerHeight-rect.height));
    Object.assign(button.style,{left:`${left}px`,top:`${top}px`,right:'auto',bottom:'auto'});draftButtonPosition=[left,top];
  };
  if(draftButtonPosition)place(...draftButtonPosition);
  button.style.touchAction='none';
  button.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    const rect=button.getBoundingClientRect(),startX=event.clientX,startY=event.clientY;draftDragMoved=false;
    const move=e=>{
      if(!draftDragMoved&&Math.hypot(e.clientX-startX,e.clientY-startY)<4)return;
      draftDragMoved=true;place(rect.left+e.clientX-startX,rect.top+e.clientY-startY);
    };
    const end=()=>{button.removeEventListener('pointermove',move);button.removeEventListener('pointerup',end);button.removeEventListener('pointercancel',end);
      // A drag that ends on the button fires click next; reset afterwards so keyboard activation still works.
      setTimeout(()=>{draftDragMoved=false;},0);};
    button.setPointerCapture?.(event.pointerId);
    button.addEventListener('pointermove',move);button.addEventListener('pointerup',end);button.addEventListener('pointercancel',end);
  });
}
// The one floating "continue" button, for a minimized draft or one saved before the app restarted.
function taskDraftButton(resume){
  $('#restore-task-draft')?.remove();
  const button=document.createElement('button');button.type='button';button.id='restore-task-draft';button.className='task-draft-resume';
  button.textContent=globalThis.AIWSI18n.text('Yeni görev · Devam et');button.setAttribute('aria-label',globalThis.AIWSI18n.text('Yeni görev taslağına devam et'));button.onclick=()=>{if(!draftDragMoved)resume();draftDragMoved=false;};makeDraftButtonDraggable(button);document.body.append(button);
  return button;
}
function minimizeTaskDraft(){
  const modal=$('#modal');if(!modalSession?.taskDraft||modalSession.pending)return;
  const session=modalSession,parked=parkModal();
  minimizedTaskDraft={parked,button:taskDraftButton(restoreTaskDraft)};
  modalSession=null;modal.close();restoreModalFocus(session);
}
function restoreTaskDraft(){
  if(!minimizedTaskDraft)return false;
  const modal=$('#modal'),draft=minimizedTaskDraft;
  modal.dispatchEvent(new Event('modalreset'));$('form',modal)?.dispatchEvent(new Event('modalreset'));
  draft.button.remove();minimizedTaskDraft=null;unparkModal(draft.parked,'#field-title');return true;
}
// The draft's title and description are also saved on the server while typing, so a freeze, reload, crash or
// restart of the app never loses them: the next new task editor, or the continue button shown on start, brings them back.
let savedTaskDraft=null,taskDraftSaveTimer=0,taskDraftTracking=false,taskDraftRequests=Promise.resolve();
function sendTaskDraft(method,body){taskDraftRequests=taskDraftRequests.then(()=>api('/task-draft',method,body,{quiet:true})).catch(()=>{});}
async function loadSavedTaskDraft(){
  try{savedTaskDraft=(await api('/task-draft')).draft||null;}catch{return;}
  if(savedTaskDraft&&!minimizedTaskDraft&&!modalSession?.taskDraft)taskDraftButton(resumeSavedTaskDraft);
}
function resumeSavedTaskDraft(){
  const target=savedTaskDraft?.projectId;
  if(target&&target!==projectId&&state.projects.some(item=>item.id===target))openProject(target);
  taskModal();
}
/** Fills a new task editor with the saved draft and keeps saving it; creating the task or closing the editor discards it. */
function trackTaskDraft(form,fallbackProjectId){
  const field=selector=>form.querySelector(selector);
  if(savedTaskDraft){
    field('#field-title').value=savedTaskDraft.title;field('#field-description').value=savedTaskDraft.description;
    const select=field('#field-projectId');if(select&&[...select.options].some(option=>option.value===savedTaskDraft.projectId))select.value=savedTaskDraft.projectId;
  }
  $('#restore-task-draft')?.remove();taskDraftTracking=true;
  // After the task is created or the editor is discarded, a late input/change event must not save the text again.
  const save=()=>{if(!taskDraftTracking)return;clearTimeout(taskDraftSaveTimer);taskDraftSaveTimer=setTimeout(()=>{
    if(!taskDraftTracking||!form.isConnected)return;
    const draft={projectId:field('#field-projectId')?.value||fallbackProjectId||null,title:field('#field-title').value,description:field('#field-description').value};
    savedTaskDraft=draft.title.trim()||draft.description.trim()?draft:null;sendTaskDraft('PUT',draft);
  },400);};
  form.addEventListener('input',save);form.addEventListener('change',save);
  for(const button of [$('#close-modal'),field('[data-action="close-modal"]')])button?.addEventListener('click',discardSavedTaskDraft);
  return save;
}
function discardSavedTaskDraft(){taskDraftTracking=false;clearTimeout(taskDraftSaveTimer);savedTaskDraft=null;sendTaskDraft('DELETE');}
