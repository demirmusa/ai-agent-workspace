'use strict';
// Agent context windows in the side panel.
// Context windows in the side panel: what each agent of a task holds in its context, read from its provider session transcript.
const contextViews=new Map(),contextWindowSizes=new Map();
function contextEntry(runId,agentId=''){const key=`${runId}|${agentId}`;let entry=contextViews.get(key);if(!entry){if(contextViews.size>=64)contextViews.delete(contextViews.keys().next().value);entry={data:null,loading:false,error:'',at:0};contextViews.set(key,entry);}return entry;}
/** Runs of a task whose provider keeps a readable transcript, newest first; follow-up runs of one provider session count once. */
function contextRuns(item){
  const seen=new Set();
  return state.runs.filter(run=>run.taskId===item.id&&historyProviders.includes(run.provider)).sort((a,b)=>String(b.startedAt).localeCompare(String(a.startedAt))).filter(run=>{const key=run.sessionId?`${run.provider}:${run.sessionId}`:run.id;if(seen.has(key))return false;seen.add(key);return true;});
}
const contextShare=snapshot=>snapshot?.window?Math.round(snapshot.used/snapshot.window*100):null;
function taskContextTab(item){
  const runs=contextRuns(item);if(!runs.length)return '';
  const open=childAgentSelection?.kind==='context'&&childAgentSelection.taskId===item.id,share=contextShare(contextViews.get(`${runs[0].id}|`)?.data?.snapshot);
  return globalThis.AIWSI18n.template`<button type="button" class="view-tab${open?' active':''}" data-open-context aria-haspopup="dialog" aria-expanded="${open}" title="${esc(globalThis.AIWSI18n.text('Agentın bağlam penceresinde neye ne kadar yer ayrıldığı'))}">Bağlam${share===null?'':` <span class="nav-count">${share}%</span>`}</button>`;
}
function openContext(item,button){
  if(childAgentSelection?.kind==='context'&&childAgentSelection.taskId===item.id){closeChildAgent();return;}
  const run=contextRuns(item)[0];if(!run)return;
  const selection={kind:'context',key:`context:${item.id}`,taskId:item.id,runId:run.id,agentId:'',returnFocus:button};
  showSidePanel(selection);void loadContext(selection);renderDetail();
}
async function loadContext(selected){
  const entry=contextEntry(selected.runId,selected.agentId),before=contextShare(entry.data?.snapshot);if(entry.loading)return;
  entry.loading=true;
  try{
    entry.data=await api(`/runs/${encodeURIComponent(selected.runId)}/context${selected.agentId?`?${new URLSearchParams({agent:selected.agentId})}`:''}`,'GET',undefined,{quiet:true});entry.error='';
    if(entry.data.snapshot?.window)contextWindowSizes.set(`${selected.runId}|${selected.agentId}`,entry.data.snapshot.window);
  }catch(problem){entry.error=problem.message;}
  finally{entry.loading=false;entry.at=Date.now();if(childAgentSelection===selected)renderContextPanel(selected);if(!selected.agentId&&before!==contextShare(entry.data?.snapshot)&&selected.taskId===selectedTaskId&&!$('#task-panel').hidden)renderDetail();}
}
function renderContextPanel(selected){
  const item=state.tasks.find(entry=>entry.id===selected.taskId);if(!item){closeChildAgent(false);return;}
  const t=globalThis.AIWSI18n.text,entry=contextEntry(selected.runId,selected.agentId),data=entry.data,run=state.runs.find(value=>value.id===selected.runId),live=Boolean(run&&['running','waiting'].includes(run.status));
  $('#child-agent-title').textContent=t('Bağlam penceresi');$('#child-agent-status').textContent=live?t('Canlı'):statuses[run?.status]||t('Bilgi bekleniyor');
  // Every session of the task is a choice; the subagents of the selected one follow it, indented under their parents.
  const agents=[];
  for(const value of contextRuns(item)){
    agents.push({id:`${value.id}|`,name:value.executionSnapshot?.agent?.name||providers[value.provider]||value.provider,provider:value.provider,detail:[value.executionInfo?.model,relative(value.startedAt)].filter(Boolean).join(' · '),depth:0,window:contextWindowSizes.get(`${value.id}|`)});
    if(value.id!==selected.runId)continue;
    const tree=(contextEntry(value.id).data||data)?.agents||[],byId=new Map(tree.map(agent=>[agent.id,agent]));
    const depth=agent=>{let level=0,current=agent;while(current?.parentId&&level<4){level++;current=byId.get(current.parentId);}return level;};
    for(const agent of tree.filter(agent=>agent.parentId&&agent.transcriptAvailable))agents.push({id:`${value.id}|${agent.id}`,name:agent.name,provider:agent.provider,detail:agent.role||statuses[agent.status]||'',depth:depth(agent),window:contextWindowSizes.get(`${value.id}|${agent.id}`)});
  }
  window.AIWSContext.render($('#child-context-host'),{snapshot:data?.snapshot||null,agents,selected:`${selected.runId}|${selected.agentId}`,loading:entry.loading||!entry.at,error:!data&&entry.error?entry.error:'',live,
    empty:t('Agentın oturum kaydı henüz bulunamadı. Agent çalışmaya başladığında bağlamı burada görünür.'),
    onSelect:id=>{const split=id.indexOf('|');selected.runId=id.slice(0,split);selected.agentId=id.slice(split+1);renderContextPanel(selected);void loadContext(selected);},
    onOpenFile:async path=>{try{await api(`/runs/${encodeURIComponent(selected.runId)}/context`,'POST',{path,agent:selected.agentId});}catch(problem){toast(problem.message);}}});
}
document.addEventListener('click',event=>{const button=event.target.closest('[data-open-context]'),item=task();if(button&&item)openContext(item,button);});
// A live agent's map follows every two seconds; a finished one is reread at most every 15 seconds.
const contextPoll=setInterval(()=>{if(document.hidden)return;const selected=childAgentSelection;if(selected?.kind!=='context')return;const run=state.runs.find(value=>value.id===selected.runId);if(run&&['running','waiting'].includes(run.status)||Date.now()-contextEntry(selected.runId,selected.agentId).at>15000)void loadContext(selected);},2000);
window.addEventListener('pagehide',()=>clearInterval(contextPoll));
