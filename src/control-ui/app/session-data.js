'use strict';
// Session data: console, transcript and history caches, the polled live provider sessions and the session counts.
const consoleViews=new Map();
const runClockReceivedAt=new Map();
const projectSessionCache=new Map();
const historyTranscriptCache=new Map();
const agentSourceCache=new Map();
const runTranscriptCache=new Map();
const liveSessions={items:[],managedTitles:{},warnings:[],loading:false,loaded:false,error:''};
const historyImports=new Map();
let historySearchTimer=null;
const sessionKey=item=>`${item.provider}:${item.sessionId}`;
function consoleTitle(run){return liveSessions.managedTitles[run?.id]||(t=>t&&window.AIWSUI.taskTitle(t))(state.tasks.find(item=>item.id===run?.taskId))||run?.id||'';}
/** Provider sessions found on this machine that no active AIWS run manages, one per session. */
function externalSessions(){const managed=new Set(state.runs.filter(activeRun).map(sessionKey));return [...new Map(liveSessions.items.filter(item=>!managed.has(sessionKey(item))).map(item=>[sessionKey(item),item])).values()];}
const liveSessionsVisible=()=>activeScreen==='overview'&&overviewTab()==='sessions';
function updateSessionCounts(){const managed=state.runs.filter(activeRun).length,total=managed+externalSessions().length;$('#sessions-count').textContent=String(total);const label=$('[data-session-total]');if(label)label.textContent=globalThis.AIWSI18n.template`${total} aktif oturum`;}
function historySourcePath(selection){return selection.external?`/live-sessions/${encodeURIComponent(selection.id)}`:`/projects/${encodeURIComponent(selection.projectId)}/sessions/${encodeURIComponent(selection.id)}`;}
// Managed consoles take the provider's session title once the live session list names it.
function retitleManagedConsoles(){for(const view of consoleViews.values()){const managed=view.snapshot?.runs?.findLast(run=>liveSessions.managedTitles[run.id]);if(managed){view.snapshot={...view.snapshot,title:consoleTitle(managed)};if(view.element.isConnected)view.controller.update(view.snapshot);}}}
async function loadLiveSessions(){
  if(liveSessions.loading)return;liveSessions.loading=true;
  try{
    const response=await api('/live-sessions');Object.assign(liveSessions,response,{loaded:true,error:''});retitleManagedConsoles();
    if(selectedHistory?.external){const current=liveSessions.items.find(item=>item.id===selectedHistory.id);if(current)selectedHistory.session={...selectedHistory.session,...current};else selectedHistory.session={...selectedHistory.session,active:false};renderDetail();}
    if(task()?.currentRunId&&detailTab==='console')$('#task-detail-title').textContent=consoleTitle(runById(task().currentRunId));
  }
  catch(error){liveSessions.error=error.message;liveSessions.loaded=true;}
  finally{liveSessions.loading=false;updateSessionCounts();if(liveSessionsVisible())updateSessionsPage();}
}
// External provider sessions have no AIWS terminal; they open read-only in the task panel.
function openExternalSession(id){const session=liveSessions.items.find(item=>item.id===id);if(!session)return;detailReturnFocus=document.activeElement;selectedTaskId=null;selectedHistory={external:true,projectId:session.projectId,id,session,events:[],messages:[],nextCursor:null,loading:false,error:'',warnings:[]};detailTab='console';render();$('#close-panel')?.focus({preventScroll:true});void loadSelectedHistory();}
// While a view shows live provider sessions, their list and the open external history are polled.
function pollLiveSessions(){
  if(document.hidden)return;const current=task();
  if(liveSessionsVisible()||selectedHistory?.external||current?.externalHistory||current&&activeRun(current)&&historyProviders.includes(runById(current.currentRunId)?.provider))void loadLiveSessions();
  if(selectedHistory?.external&&selectedHistory.session.active!==false)void loadSelectedHistory(true);
  if(current?.externalHistory&&activeRun(current))taskHistory(current,true,true);
}
const liveSessionsTimer=setInterval(pollLiveSessions,2000);
document.addEventListener('click',event=>{
  const target=event.target.closest('button,[data-open-task]');if(!target)return;
  if(target.dataset.externalSession)openExternalSession(target.dataset.externalSession);
  else if(target.hasAttribute('data-refresh-live'))void loadLiveSessions();
});
window.addEventListener('pagehide',()=>{clearInterval(liveSessionsTimer);for(const view of consoleViews.values())view.controller.destroy();consoleViews.clear();});
