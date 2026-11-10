'use strict';
// AI preparation workspaces per project: drafts and planner messages that live only in this browser until the user creates them,
// the tasks the canvas mirrors (terminal-created tasks, the organizer's review) and the open/fullscreen state of the sheet.
const aiDraftFields=['title','description','priority','agentId','provider','model','terminalMode','tags','skillIds','workflowId','workflowRequested','requestedActions','autoMerge','dependsOn','dependencyRefs','dependsOnDrafts'];
const aiWorkspaces=new Map();
let aiSheetOpen=false,aiFullscreen=false;try{aiFullscreen=localStorage.getItem('aiws.ai-fullscreen')==='1';}catch{/* Storage can be disabled. */}
function aiWorkspace(id){
  let workspace=aiWorkspaces.get(id);if(workspace)return workspace;
  let saved={};try{saved=JSON.parse(localStorage.getItem(`aiws.ai-workspace.${id}`)||'{}')||{};}catch{saved={};}
  workspace={projectId:id,messages:Array.isArray(saved.messages)?saved.messages:[],drafts:Array.isArray(saved.drafts)?saved.drafts.filter(draft=>draft?.key&&draft.values).map(draft=>({...draft,edited:Array.isArray(draft.edited)?draft.edited:[]})):[],agentId:saved.agentId||'',choice:saved.choice&&typeof saved.choice==='object'?saved.choice:{},retry:saved.retry||'',turn:saved.turn||0,busy:false,organizing:null,requestId:null,controller:null,startedAt:0,activity:[],activityOpen:false,creating:new Set(),element:null,cards:new Map(),skeletons:[],layout:null,layoutKey:'',links:new Map(),ports:new Map(),linkFrame:0,linksSettle:false,resize:null,camera:null,free:true,focusKey:'',easeTimer:0};
  aiWorkspaces.set(id,workspace);return workspace;
}
function saveAIWorkspace(workspace){try{localStorage.setItem(`aiws.ai-workspace.${workspace.projectId}`,JSON.stringify({messages:workspace.messages.slice(-80),drafts:workspace.drafts.filter(draft=>!draft.mirror).map(({key,values,edited,createdTaskId,turn,offset})=>({key,values,edited,createdTaskId,turn,offset})),agentId:workspace.agentId,choice:workspace.choice,retry:workspace.retry,turn:workspace.turn}));}catch{/* Storage can be full or disabled; the in-memory workspace keeps working. */}}
const aiVisibleFor=id=>aiSheetOpen&&projectId===id;
const aiVisible=workspace=>aiSheetOpen&&projectId===workspace.projectId&&Boolean(workspace.element?.isConnected);
const aiOpenDrafts=workspace=>workspace.drafts.filter(draft=>!draft.createdTaskId);
// Tasks this page opened itself; every other new task (a terminal agent running `aiws control tasks create`, the organizer) joins the canvas.
const aiOwnTasks=new Set(),aiKnownTasks=new Map();let aiNoticeTimer=0;
// A mirror node is a task the sheet did not draft: a created node whose dependencies follow the board's own, never saved with the workspace.
function aiMirrorTasks(workspace,tasks){
  for(const item of tasks)if(!workspace.drafts.some(draft=>draft.createdTaskId===item.id))workspace.drafts.push({key:`task:${item.id}`,values:{title:item.title},edited:[],createdTaskId:item.id,mirror:true,turn:0});
  const nodes=new Map(workspace.drafts.filter(draft=>draft.createdTaskId).map(draft=>[draft.createdTaskId,draft.key]));
  for(const draft of workspace.drafts)if(draft.mirror){const task=state.tasks.find(item=>item.id===draft.createdTaskId);if(!task||task.archivedAt){draft.gone=true;continue;}draft.values.title=task.title;draft.values.dependsOnDrafts=(task.dependsOn||[]).map(id=>nodes.get(id)).filter(Boolean);}
  workspace.drafts=workspace.drafts.filter(draft=>!draft.gone);
}
const aiOrganizeTasks=projectId=>state.tasks.filter(item=>item.projectId===projectId&&!item.archivedAt&&['backlog','ready'].includes(item.status));
// Starting the organizer opens the sheet: every task it reviews is laid out at once, then the nodes regroup as the organizer records dependencies.
function aiStartOrganize(id,organization){
  const workspace=aiWorkspace(id);workspace.organizing={requestId:organization.requestId,startedAt:Date.now()};
  workspace.drafts=workspace.drafts.filter(draft=>!draft.mirror);aiMirrorTasks(workspace,aiOrganizeTasks(id));
  if(projectId===id)openAIWorkspace();else updateAIWorkspace(workspace);
}
function aiSyncOrganize(){
  for(const workspace of aiWorkspaces.values()){
    if(!workspace.organizing)continue;const current=state.organizations?.[workspace.projectId],running=current?.requestId===workspace.organizing.requestId&&current.status==='running';
    aiMirrorTasks(workspace,aiOrganizeTasks(workspace.projectId));if(!running)workspace.organizing=null;
    updateAIWorkspace(workspace);
  }
}
// New tasks are told apart after a beat so a task this page created is not mistaken for one an agent opened.
function aiNoticeTasks(){
  const fresh=new Map();
  for(const project of state.projects)if(!aiKnownTasks.has(project.id))aiKnownTasks.set(project.id,new Set(state.tasks.filter(task=>task.projectId===project.id).map(task=>task.id)));
  for(const item of state.tasks){const known=aiKnownTasks.get(item.projectId);
    if(known&&!known.has(item.id)){known.add(item.id);if(!fresh.has(item.projectId))fresh.set(item.projectId,[]);fresh.get(item.projectId).push(item.id);}}
  aiSyncOrganize();if(!fresh.size)return;
  setTimeout(()=>{for(const [id,ids] of fresh){
    const tasks=ids.filter(taskId=>!aiOwnTasks.has(taskId)).map(taskId=>state.tasks.find(item=>item.id===taskId)).filter(item=>item&&!item.archivedAt&&item.status==='backlog');if(!tasks.length)continue;
    const workspace=aiWorkspace(id);if(workspace.organizing)continue;aiMirrorTasks(workspace,tasks);
    if(projectId===id&&activeScreen==='board'&&projectTab()==='board'&&!$('#modal').open){toast(globalThis.AIWSI18n.template`${tasks.length} görev terminalden açıldı`);if(aiSheetOpen)updateAIWorkspace(workspace);else openAIWorkspace();}
    else updateAIWorkspace(workspace);
  }},700);
}
