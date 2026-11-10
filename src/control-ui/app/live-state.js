'use strict';
// Applying server state and the live event stream.
// Consoles of deleted tasks are closed and destroyed with them.
function dropRemovedTaskConsoles(){const taskIds=new Set(state.tasks.map(task=>`task:${task.id}`)),runIds=new Set(state.runs.map(run=>`tile:${run.id}`));for(const [id,view] of consoleViews)if((id.startsWith('task:')&&!taskIds.has(id))||(id.startsWith('tile:')&&!runIds.has(id))){floatingConsoles.get(view.element)?.close();view.controller.destroy();consoleViews.delete(id);}const projectIds=new Set([...state.projects.map(item=>item.id),...(state.generalWorkspace?[state.generalWorkspace.id]:[])]);for(const [id,entry] of projectShells)if(!projectIds.has(id)){for(const runId of [...entry.views.keys()])forgetTerminalPane(entry,runId);projectShells.delete(id);}}
// The first state the page receives, from the event stream or a state read.
let resolveFirstState;const firstState=new Promise(resolve=>{resolveFirstState=resolve;});
function applyState(data,delta,{deferRender=false}={}) {
  stateReceivedAt=Date.now();stateVersion++;if('events' in data||'messages' in data)journalVersion++;
  if(data.aiProviders)applyAIProviders(data.aiProviders);
  Object.assign(state,data);
  if(data.aiProviders||data.settings)window.AIWSVoice?.refresh();
  applyOptimisticMoves();applyPendingTaskEdits();if(delta)mergeJournal(delta);
  notifyInputRequests();notifyOrganizations();aiNoticeTasks();
  if(selectedHistory&&!selectedHistory.external&&!state.projects.some(project=>project.id===selectedHistory.projectId))selectedHistory=null;
  dropRemovedTaskConsoles();
  // Run clocks count on from the moment their reported active time arrived; finished or removed runs are forgotten.
  if('runs' in data){runClockReceivedAt.clear();for(const run of state.runs)runClockReceivedAt.set(run.id,stateReceivedAt);}
  if (!state.projects.some(item => item.id === projectId) && !isGeneralProject(projectId)) projectId = state.projects[0]?.id || null;
  window.AIWSPlugins?.stateChanged();
  if(deferRender)scheduleRender();else render();
  resolveFirstState();
}
// Broadcasts after the first carry only what changed (control-server/http/state-patches.ts): whole top-level values and,
// per collection, the records that changed, the ids that went away and the new order when it changed.
function applyStatePatch(patch,delta){
  // A broadcast that changed nothing the page keeps (a timer, a save) costs no render.
  if(!patch.values&&!patch.collections&&!delta?.events?.length&&!delta?.messages?.length)return;
  const data={...patch.values};
  for(const [key,change] of Object.entries(patch.collections||{})){
    const records=new Map((state[key]||[]).map(item=>[item.id,item]));
    for(const id of change.remove||[])records.delete(id);
    for(const item of change.upsert||[])records.set(item.id,item);
    data[key]=change.order?change.order.map(id=>records.get(id)).filter(Boolean):[...records.values()];
  }
  applyState(data,delta,{deferRender:true});
}
function mergeJournal(update) {
  const merge=(current,incoming,limit)=>{if(!incoming?.length)return current;if(current.length>256&&incoming.length<=16){const tailIds=new Map();for(let i=current.length-256;i<current.length;i++)tailIds.set(current[i].id,i);if(incoming.every(item=>tailIds.has(item.id)||item.createdAt>=current.at(-1).createdAt)){let copy=null;for(const item of incoming){const idx=tailIds.get(item.id);if(idx!==undefined)Object.assign((copy||current)[idx],item);else{(copy??=[...current]).push(item);tailIds.set(item.id,copy.length-1);}}const merged=copy||current;return merged.length>limit?merged.slice(-limit):merged;}}const byId=new Map(current.map(item=>[item.id,item]));let appended=false;for(const item of incoming){const previous=byId.get(item.id);if(previous)Object.assign(previous,item);else{byId.set(item.id,item);appended=true;}}const merged=appended?[...byId.values()]:current;return merged.length>limit?merged.slice(-limit):merged;};
  const events=merge(state.events,update.events,20000),messages=merge(state.messages||[],update.messages,10000);
  if(update.events?.length||update.messages?.length)journalVersion++;
  state.events=events;state.messages=messages;
}
function applyActivityUpdate(update) {
  mergeJournal(update);stateVersion++;
  for(const patch of update.runs||[]){const run=runById(patch.id);if(run){Object.assign(run,patch);if(typeof patch.activeMs==='number')runClockReceivedAt.set(run.id,Date.now());}}
  scheduleRender();
}
let streamLive=false,streamController;
async function stream() {
  streamController?.abort(); streamController = new AbortController();
  const controller = streamController;
  while(!controller.signal.aborted) {
    try {
      const response = await fetch('/api/events',{headers:token ? {Authorization:`Bearer ${token}`} : {},signal:controller.signal});
      if (!response.ok) { if(response.status === 401) showTokenDialog(); throw new Error(globalThis.AIWSI18n.text('Canlı bağlantı kurulamadı')); }
      connection(true);
      // Search only newly received text for frame boundaries; rescanning a large
      // initial state on every network chunk is quadratic.
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', scanned = 0;
      while(true) { const {value,done} = await reader.read(); if(done) break; buffer += decoder.decode(value,{stream:true}).replace(/\r\n/g,'\n'); let split; while((split=buffer.indexOf('\n\n',Math.max(0,scanned-1))) !== -1) { const frame=buffer.slice(0,split); buffer=buffer.slice(split+2); scanned=0; const payload=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n'); if(payload) handleStreamEvent(JSON.parse(payload)); } scanned=buffer.length; }
    } catch { if(controller.signal.aborted) return; }
    streamLive=false; connection(false); await new Promise(resolve=>setTimeout(resolve,2500));
  }
}
function handleStreamEvent(event){
  if(event.type==='state'){noteStateRevision(event.revision);if(event.patch)applyStatePatch(event.patch,event.delta);else{if(!event.delta)streamLive=true;applyState(event.state,event.delta,{deferRender:true});}}
  else if(event.type==='update')applyActivityUpdate(event);
  else if(event.type==='draft')aiWorkspaceActivity(event);
  else if(event.type==='organize')organizeProgress(event);
  else if(event.type==='terminal')window.AIWSTerminal?.receive(event.runId,event.offset,event.data);
  else if(event.type==='shells')void loadProjectShells(event.projectId);
  else if(event.type==='plugins')void window.AIWSPlugins?.reload();
}
window.addEventListener('pagehide',()=>streamController?.abort());
