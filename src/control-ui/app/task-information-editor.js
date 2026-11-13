'use strict';
// Inline editing of the task information tab: field saves, the description editor and the save status.
// The Bilgiler tab is the task editor: every field of the former edit dialog, each saved on its own through PATCH /tasks/:id.
let infoEdit={taskId:null,description:null,status:'',error:'',provider:null},infoStatusTimer,infoBranchesProject=null;
function infoEditorBusy(panel){const active=document.activeElement,info=panel.querySelector('.detail-information');return Boolean(info&&(info.querySelector('[data-info-editing],.model-trigger[aria-expanded="true"],[data-usage-toggle][aria-expanded="true"]')||info.contains(active)&&(active.tagName==='TEXTAREA'||active.tagName==='INPUT'&&!['checkbox','radio'].includes(active.type))));}
function infoStatusText(){return infoEdit.status==='saving'?globalThis.AIWSI18n.text('Kaydediliyor…'):infoEdit.status==='saved'?globalThis.AIWSI18n.text('Değişiklikler kaydedildi'):infoEdit.status==='error'?infoEdit.error:'';}
function showInfoStatus(){const status=document.querySelector('#info-save-status');if(!status)return;status.className=`issue-save-status ${infoEdit.status}`;status.textContent=infoStatusText();}
function enhanceTaskInformation(item){
  // Some DOM implementations keep the parser's first choice; state the rendered selection once per fresh view.
  const view=document.querySelector('.detail-information .issue-view');if(view&&!view.dataset.synced){view.dataset.synced='true';for(const select of view.querySelectorAll('select')){const chosen=select.querySelector('option[selected]');if(chosen)select.value=chosen.value;}}
  const area=document.querySelector('#info-description');
  if(area&&!area.dataset.enhanced){area.dataset.enhanced='true';window.AIWSImages?.editor(area,{api,projectId:()=>item.projectId,onError:problem=>toast(problem.message)});const editor=area.closest('form').querySelector('.CodeMirror')?.CodeMirror;if(editor)editor.focus();else{area.focus();area.setSelectionRange(area.value.length,area.value.length);}}
  const picker=document.querySelector('.detail-information [data-info-row="model"]');
  if(picker&&!agentPickers.has(picker)){const assigned=state.agents.find(value=>value.id===item.agentId),chosen=()=>picker.querySelector('#info-provider').value;mountAgentPicker(picker,{id:'info',inheritProvider:()=>assigned?.provider||defaultProvider(),inheritModel:()=>assigned?.model&&(!chosen()||chosen()===assigned.provider)?globalThis.AIWSI18n.template`Agenttan · ${assigned.model}`:globalThis.AIWSI18n.text('Profil veya sağlayıcı varsayılanı'),onClose:()=>renderDetail()});}
  const branch=document.querySelector('#info-baseBranch');if(branch&&!branch.dataset.bound){branch.dataset.bound='true';branch.addEventListener('focus',()=>void loadInfoBranches(item.projectId),{once:true});}
  // The panel outlives the info view it re-renders, so it remembers which activity entries were already shown.
  window.AIWSUI.motion.enter($('#task-panel'),'.task-activity-history li','data-activity-id');
}
async function loadInfoBranches(projectId){if(infoBranchesProject?.id===projectId)return fillInfoBranches();try{const result=await api(`/projects/${projectId}/branches`);infoBranchesProject={id:projectId,branches:result.branches||[]};fillInfoBranches();}catch{/* Free text stays available; the server validates the name. */}}
function fillInfoBranches(){const list=document.querySelector('#info-branches');if(list&&infoBranchesProject?.branches)list.innerHTML=infoBranchesProject.branches.map(branch=>`<option value="${esc(branch)}"></option>`).join('');}
async function saveTaskField(item,body){
  const pending=pendingTaskEdits.get(item.id)||{body:{},saves:0};pending.body={...pending.body,...body};pending.saves++;pendingTaskEdits.set(item.id,pending);applyPendingTaskEdits();
  infoEdit.status='saving';infoEdit.error='';showInfoStatus();
  let saved=false;
  try{
    await api(`/tasks/${item.id}`,'PATCH',body);saved=true;
    if(infoEdit.taskId===item.id){infoEdit.status='saved';clearTimeout(infoStatusTimer);infoStatusTimer=setTimeout(()=>{if(infoEdit.status!=='saved')return;infoEdit.status='';showInfoStatus();if(task())renderDetail();},2500);}
  }catch(problem){if(infoEdit.taskId===item.id){infoEdit.status='error';infoEdit.error=problem.message;}}
  finally{if(!--pending.saves)pendingTaskEdits.delete(item.id);}
  await refresh();showInfoStatus();if(!saved)renderDetail();return saved;
}
// Field saves still in flight, per task. Every applied state takes them over, so a re-render before the server confirms (the
// save status alone triggers one) or a state that left the server before the save cannot put the previous values back.
const pendingTaskEdits=new Map();
function applyPendingTaskEdits(){if(!pendingTaskEdits.size)return;for(const item of state.tasks){const pending=pendingTaskEdits.get(item.id);if(pending)Object.assign(item,pending.body);}}
function infoFieldBody(item,field){
  const name=field.dataset.infoField,value=field.value,t=globalThis.AIWSI18n.text;
  if(name==='title'){const title=value.trim();return title===item.title?null:{title};}
  if(name==='priority')return {priority:Number(value)};
  if(name==='milestoneId')return value===(item.milestoneId||'')?null:{milestoneId:value||null};
  if(name==='usageTrigger'){const root=field.closest('.usage-trigger-field'),chosen=field.matches('[data-usage-provider]');if(chosen)fillUsageWindows(root);const usageTrigger=usageTriggerFromInputs(root);if(chosen&&field.value&&!usageTrigger)return null;return JSON.stringify(usageTrigger)===JSON.stringify(item.usageTrigger||null)?null:{usageTrigger};}
  if(name==='scheduledAt'){const scheduledAt=isoFromLocal(value);return scheduledAt===(item.scheduledAt||null)?null:{scheduledAt};}
  if(name==='agentId'){infoEdit.provider=null;return {agentId:value||null,provider:null,model:null};}
  if(name==='account')return value===(item.account||'')?null:{account:value||null};
  if(name==='command'){const executable=document.querySelector('#info-executable').value.trim();let args;try{args=JSON.parse(document.querySelector('#info-args').value||'[]');}catch{throw new Error(t('Argümanları JSON dizisi olarak gir. Örnek: ["script.mjs"]'));}if(!executable||!Array.isArray(args)||args.some(entry=>typeof entry!=='string'))throw new Error(t('Program ve metinlerden oluşan bir argüman dizisi gerekli.'));infoEdit.provider=null;return {provider:'command',command:{executable,args}};}
  if(name==='terminalMode')return {terminalMode:value==='auto-native'?null:value||null,preferNativeTerminal:value==='auto-native'};
  if(name==='workflowId')return {workflowId:value||null};
  if(name==='workflowRequested')return {workflowRequested:field.checked};
  if(name==='deployRequested'){const others=(item.requestedActions||[]).filter(action=>action!=='deploy');return {requestedActions:field.checked?[...others,'deploy']:others};}
  if(name==='autoMerge')return {autoMerge:field.checked};
  if(name==='tags'){const current=item.tags||[],added=[...new Set(value.split(',').map(tag=>tag.trim()).filter(Boolean))].filter(tag=>!findLabel(current.map(name=>({name})),tag));field.value='';return added.length?{tags:[...current,...added]}:null;}
  if(name==='skillIds')return {skillIds:[...field.querySelectorAll('input[name="info-skillIds"]:checked')].map(input=>input.value)};
  if(name==='baseBranch'){const branch=value.trim();if(!branch)throw new Error(t('Kaynak branch boş bırakılamaz.'));return branch===(item.baseBranch||'')?null:{baseBranch:branch};}
  if(name==='projectId')return value===item.projectId?null:{projectId:value};
  return null;
}
async function closeDescriptionEditor(save){
  const item=task(),form=document.querySelector('#info-description-form');if(!item||!form||form.dataset.saving)return;
  if(save){const area=form.querySelector('#info-description');form.dataset.saving='true';form.querySelector('[type="submit"]').disabled=true;const saved=area.value===item.description||await saveTaskField(item,{description:area.value});delete form.dataset.saving;if(!saved){if(form.isConnected)form.querySelector('[type="submit"]').disabled=false;return;}}
  if(form.contains(document.activeElement))document.activeElement.blur();form.removeAttribute('data-info-editing');form.dispatchEvent(new Event('modalreset'));infoEdit.description=null;renderDetail();
}
// The picker saves provider, model and level together; the command provider first asks for its program.
document.addEventListener('agentpickerchange',event=>{
  const host=event.target;if(!host.closest?.('.detail-information'))return;const item=task();if(!item)return;
  const {provider,model,reasoningEffort}=event.detail;
  if(provider==='command'&&!item.command){infoEdit.provider='command';agentPickers.get(host)?.close();renderDetail();document.querySelector('#info-executable')?.focus();return;}
  infoEdit.provider=null;void saveTaskField(item,{provider:provider||null,model:model||null,reasoningEffort:reasoningEffort||null,...(provider==='command'?{}:{command:null})});
});
document.addEventListener('change',event=>{
  const field=event.target.closest?.('.detail-information [data-info-field]'),item=task();if(!field||!item)return;
  let body;try{body=infoFieldBody(item,field);}catch(problem){infoEdit.status='error';infoEdit.error=problem.message;showInfoStatus();return;}
  if(body)void saveTaskField(item,body);
});
document.addEventListener('click',event=>{
  if(!event.target.closest?.('.detail-information'))return;const item=task();if(!item)return;
  const removeTag=event.target.closest('[data-info-remove-tag]');if(removeTag){void saveTaskField(item,{tags:(item.tags||[]).filter(tag=>tag!==removeTag.dataset.infoRemoveTag)});return;}
  if(event.target.closest('[data-info-cancel-description]')){void closeDescriptionEditor(false);return;}
  if(event.target.closest('[data-info-edit-description]')&&!event.target.closest('a')&&infoEdit.description===null){infoEdit.description=item.description||'';renderDetail();}
});
document.addEventListener('submit',event=>{if(event.target.id!=='info-description-form')return;event.preventDefault();void closeDescriptionEditor(true);});
document.addEventListener('focusout',event=>{if(event.target.closest?.('.detail-information'))setTimeout(()=>{if(detailTab==='info'&&task())scheduleRender();},0);});
// Inline editors own Enter and Escape; Escape must not close the panel while a field is being edited.
document.addEventListener('keydown',event=>{
  const target=event.target;if(!target.closest?.('.detail-information'))return;
  if(target.closest('#info-description-form')){if(event.key==='Escape'){event.preventDefault();event.stopPropagation();void closeDescriptionEditor(false);}else if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();event.stopPropagation();void closeDescriptionEditor(true);}return;}
  if(target.matches('input[data-info-field]:not([type="checkbox"])')){if(event.key==='Enter'){event.preventDefault();target.blur();}if(event.key==='Escape'){event.preventDefault();event.stopPropagation();target.value=target.defaultValue;target.blur();}return;}
  if(target.matches('div[data-info-edit-description]')&&(event.key==='Enter'||event.key===' ')){event.preventDefault();const item=task();if(item){infoEdit.description=item.description||'';renderDetail();}}
},true);
