'use strict';
// Planner messages and creating tasks from AI drafts.
async function sendAIMessage(workspace,message){
  message=String(message||'').trim();if(!message||workspace.busy)return;
  workspace.messages=workspace.messages.filter(entry=>!entry.failed&&entry.role!=='error');
  const history=workspace.messages.filter(entry=>['user','assistant'].includes(entry.role)).slice(-40).map(entry=>({role:entry.role,text:String(entry.text).slice(0,30000)}));
  const entry={role:'user',text:message,at:new Date().toISOString()},requestId=crypto.randomUUID(),controller=new AbortController();workspace.messages.push(entry);
  Object.assign(workspace,{busy:true,requestId,controller,startedAt:Date.now(),activity:[],retry:''});saveAIWorkspace(workspace);updateAIWorkspace(workspace);updateAITab();
  try{
    const response=await api(`/projects/${encodeURIComponent(workspace.projectId)}/draft`,'POST',{mode:'workspace',requestId,message,agentId:workspace.agentId||null,provider:workspace.choice.provider||undefined,model:workspace.choice.model||undefined,reasoningEffort:workspace.choice.reasoningEffort||undefined,messages:history,drafts:aiOpenDrafts(workspace).map(draft=>({key:draft.key,...draft.values,userEdited:draft.edited}))},{signal:controller.signal});
    if(workspace.requestId!==requestId)return;
    workspace.messages.push({role:'assistant',text:response.reply||globalThis.AIWSI18n.text('Taslak hazır.'),at:new Date().toISOString(),drafts:(response.drafts||[]).length});mergeAIDrafts(workspace,response.drafts||[]);
  }catch(cause){if(workspace.requestId!==requestId)return;entry.failed=true;workspace.retry=message;workspace.messages.push({role:'error',text:cause.message,at:new Date().toISOString()});}
  finally{if(workspace.requestId===requestId){Object.assign(workspace,{busy:false,requestId:null,controller:null});saveAIWorkspace(workspace);updateAIWorkspace(workspace);updateAITab();}}
}
function cancelAIMessage(workspace){
  if(!workspace.busy)return;const requestId=workspace.requestId,entry=workspace.messages.findLast(item=>item.role==='user');
  workspace.controller?.abort();void api(`/projects/${encodeURIComponent(workspace.projectId)}/draft/cancel`,'POST',{requestId}).catch(()=>{});
  if(entry){entry.failed=true;workspace.retry=entry.text;}workspace.messages.push({role:'error',text:globalThis.AIWSI18n.text('İstek iptal edildi. Taslaklar değişmedi.'),at:new Date().toISOString()});
  Object.assign(workspace,{busy:false,requestId:null,controller:null});saveAIWorkspace(workspace);updateAIWorkspace(workspace);updateAITab();
}
function discardAIDraft(workspace,draft){
  if(workspace.creating.has(draft.key))return;workspace.drafts=workspace.drafts.filter(item=>item!==draft);
  for(const item of workspace.drafts)if(item.values.dependsOnDrafts?.includes(draft.key)){item.values.dependsOnDrafts=item.values.dependsOnDrafts.filter(key=>key!==draft.key);if(!draft.createdTaskId&&!item.edited.includes('dependsOnDrafts'))item.edited.push('dependsOnDrafts');}
  saveAIWorkspace(workspace);updateAIWorkspace(workspace);updateAITab();
}
// Drafts join the milestone the board shows; "Hazır olarak oluştur" queues them as ready, their blockers keeping the order.
async function createAIDraft(workspace,draft,status='backlog'){
  const values=draft.values,blockers=(values.dependsOnDrafts||[]).map(key=>workspace.drafts.find(item=>item.key===key)).filter(Boolean);
  if(draft.createdTaskId||workspace.creating.has(draft.key)||!String(values.title||'').trim()||blockers.some(blocker=>!blocker.createdTaskId))return false;
  workspace.creating.add(draft.key);updateAIWorkspace(workspace);
  try{
    const created=await api('/tasks','POST',{projectId:workspace.projectId,title:String(values.title).trim(),description:values.description||'',agentId:values.agentId||null,provider:values.provider||null,model:values.model||null,reasoningEffort:values.reasoningEffort||null,skillIds:values.skillIds||[],status,priority:Number(values.priority??2),milestoneId:newTaskMilestoneId(workspace.projectId)||null,dependencyRefs:[...new Set([...(values.dependsOn||[]),...(values.dependencyRefs||[]),...blockers.map(blocker=>blocker.createdTaskId)])],autoStart:true,autoMerge:values.autoMerge??null,workflowId:values.workflowId||null,workflowRequested:Boolean(values.workflowRequested),requestedActions:values.requestedActions||[],terminalMode:values.terminalMode||null,preferNativeTerminal:!values.terminalMode&&!values.agentId&&!values.provider,tags:values.tags||[],command:null});
    draft.createdTaskId=created.id;draft.error='';toast(globalThis.AIWSI18n.text('Görev oluşturuldu'));return true;
  }catch(cause){draft.error=cause.message;return false;}
  finally{workspace.creating.delete(draft.key);saveAIWorkspace(workspace);updateAIWorkspace(workspace);updateAITab();}
}
// Flow order creates every blocker before the drafts that wait for it.
async function createAllAIDrafts(workspace,status='backlog'){if(workspace.creating.size)return;for(const draft of (workspace.layout?.order||workspace.drafts).filter(item=>!item.createdTaskId))if(!await createAIDraft(workspace,draft,status))break;}
function updateAITab(){const tab=$('#project-tab-ai-count');if(!tab)return;const workspace=projectId?aiWorkspaces.get(projectId):null,count=workspace?aiOpenDrafts(workspace).length:0,label=workspace?.busy?'●':count?String(count):'';tab.hidden=!label;tab.textContent=label;tab.classList.toggle('busy',Boolean(workspace?.busy));}
function aiWorkspaceActivity(event){const workspace=aiWorkspaces.get(event.projectId);if(!workspace?.busy||workspace.requestId!==event.requestId||typeof event.activity!=='string')return;workspace.activity=[...workspace.activity,event.activity].slice(-4);if(aiVisible(workspace))renderAIProgress(workspace);}
// The elapsed time ticks once a second only while some workspace is working; renderAIProgress starts and stops the clock.
let aiProgressTimer=0;
function aiProgressClock(){
  const working=[...aiWorkspaces.values()].some(workspace=>workspace.busy||workspace.organizing);
  if(working&&!aiProgressTimer)aiProgressTimer=setInterval(()=>{if(document.hidden)return;for(const workspace of aiWorkspaces.values())if((workspace.busy||workspace.organizing)&&aiVisible(workspace))renderAIProgress(workspace);aiProgressClock();},1000);
  else if(!working&&aiProgressTimer){clearInterval(aiProgressTimer);aiProgressTimer=0;}
}
window.addEventListener('pagehide',()=>{clearInterval(aiProgressTimer);for(const workspace of aiWorkspaces.values())workspace.controller?.abort();});

function mergeAIDrafts(workspace,proposals){
  workspace.turn++;const previous=new Map(workspace.drafts.map(draft=>[draft.key,draft])),seen=new Set(),next=[];
  for(const proposal of proposals){
    let draft=previous.get(proposal.key);if(draft?.createdTaskId||seen.has(proposal.key))draft=null;
    if(!draft)draft={key:previous.has(proposal.key)||seen.has(proposal.key)?`${proposal.key}-${crypto.randomUUID().slice(0,6)}`:proposal.key,values:{},edited:[],createdTaskId:null};
    // Fields the user touched are theirs; the AI only fills the rest. An existing draft it rewrote rings once on the canvas.
    const before=previous.get(draft.key)===draft?JSON.stringify(draft.values):null;
    for(const field of aiDraftFields)if(Object.hasOwn(proposal,field)&&!draft.edited.includes(field))draft.values[field]=proposal[field];
    if(before!==null&&before!==JSON.stringify(draft.values))draft.changed=true;
    draft.turn=workspace.turn;draft.error='';seen.add(draft.key);next.push(draft);
  }
  for(const draft of workspace.drafts)if(!seen.has(draft.key)&&(draft.createdTaskId||draft.edited.length))next.push(draft);
  workspace.drafts=next;
}
