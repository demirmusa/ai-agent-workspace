'use strict';
// Provider transcripts of task runs.
// A native terminal run journals only its lifecycle; its conversation lives in the provider transcript.
// Ended runs other than the live one are read once, completely, and kept for the session.
function runTranscriptRecords(run){
  if(run.terminalMode!=='pty'||!transcriptProviders.includes(run.provider)||['running','waiting','paused'].includes(run.status))return null;
  let entry=runTranscriptCache.get(run.id);
  if(!entry){if(runTranscriptCache.size>=64)runTranscriptCache.delete(runTranscriptCache.keys().next().value);entry={events:[],messages:[],loading:true,error:''};runTranscriptCache.set(run.id,entry);void loadRunTranscript(run,entry);}
  return entry;
}
async function loadRunTranscript(run,entry){
  try{
    const path=`/runs/${run.id}/agents`,tree=await api(path),root=tree.agentTree?.agents.find(agent=>agent.id===tree.agentTree.rootId);
    let cursor=null,pages=0;
    if(root?.transcriptAvailable)do{const page=await api(`${path}/${encodeURIComponent(root.id)}/transcript?${new URLSearchParams({limit:'200',...(cursor?{cursor}:{})})}`);entry.events.push(...page.events);entry.messages.push(...page.messages);cursor=page.nextCursor;}while(cursor&&++pages<200);
  }catch(problem){entry.error=problem.message;}
  finally{entry.loading=false;if(selectedTaskId===run.taskId&&detailTab!=='info')renderDetail();else if(childAgentSelection?.kind==='session')renderChildAgent();}
}
/** Whether a past run of the console's task is still reading its transcript; the chat waits behind a skeleton until it has. */
const pastRunTranscriptsLoading=data=>data.runs.some(run=>run.taskId===data.taskId&&run.id!==data.terminalRun?.id&&runTranscriptRecords(run)?.loading);
// Records of a resumed or copied session that predate this run belong to an earlier run.
const runWindow=(run,items)=>{const start=Date.parse(run.startedAt)-5000;return Number.isFinite(start)?items.filter(item=>!(Date.parse(item.createdAt)<start)):items;};
function withPastRunTranscripts(data,item){
  const live=data.terminalRun?.id,events=[],messages=[],loaded=new Set();
  for(const run of data.runs){
    if(run.taskId!==item.id||run.id===live)continue;const entry=runTranscriptRecords(run);if(!entry||entry.loading||entry.error)continue;
    loaded.add(run.id);events.push(...runWindow(run,entry.events).map(event=>({...event,runId:run.id,taskId:item.id})));messages.push(...runWindow(run,entry.messages).map(message=>({...message,runId:run.id,taskId:item.id})));
  }
  if(!loaded.size)return data;
  const unique=(base,extra)=>{const ids=new Set(base.map(entry=>entry.id));return [...base,...extra.filter(entry=>!ids.has(entry.id)&&ids.add(entry.id))];};
  return {...data,runs:data.runs.map(run=>loaded.has(run.id)?{...run,terminalMode:'stream'}:run),events:unique(data.events,events),messages:unique(data.messages,messages)};
}
function withRootTranscript(snapshot,source){
  const transcript=source?.transcripts[source.agentTree?.rootId],run=snapshot.terminalRun;
  if(!run||!transcript)return snapshot;
  const merge=(base,extra)=>{const ids=new Set((base||[]).map(item=>item.id));return [...(base||[]),...runWindow(run,extra||[]).filter(item=>!ids.has(item.id)&&ids.add(item.id)).map(item=>({...item,runId:run.id,taskId:snapshot.taskId}))];};
  return {...snapshot,runs:(snapshot.runs||[]).map(item=>item.id===run.id?{...item,terminalMode:'stream'}:item),events:merge(snapshot.events,transcript.events),messages:merge(snapshot.messages,transcript.messages)};
}
