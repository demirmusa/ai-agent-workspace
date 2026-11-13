'use strict';
// Mounting agent consoles: one cached console per task, history session or run tile.
function createAgentConsole(host,data){return window.AIWSAgentConsole.create(host,data);}
function mountAgentConsole(host,key,data){
  let view=consoleViews.get(key);const path=data.agentSourcePath,source=path?ensureAgentSource(path):null;
  // Re-normalizing a long conversation is the most expensive render step; skip it when nothing it shows changed.
  const signature=consoleSignature(key,data,source);
  if(view)view.usedAt=++consoleUses;
  if(view&&view.signature===signature&&view.sourcePath===path){if(!floatingConsoles.has(view.element)&&view.element.parentElement!==host)host.append(view.element);view.data=data;return view;}
  const snapshot=withRootTranscript({...data,viewMode:floatingConsoles.has(view?.element)?view.snapshot.viewMode:detailTab==='terminal'?'terminal':'history',onSetView:mode=>{if(floatingConsoles.has(view?.element)){view.snapshot={...view.snapshot,viewMode:mode};view.controller.update(view.snapshot);}else{detailTab=mode==='terminal'?'terminal':'console';renderDetail();}},instanceId:key,inspectedAgentId:childAgentSelection?.parentKey===key?childAgentSelection.agent.id:null,...(source?{agentTree:source.agentTree,agentTranscripts:source.transcripts,agentSource:{loading:source.loading&&!source.loaded,error:source.error,sourceAvailable:source.sourceAvailable,warnings:source.warnings},onOpenAgent:(agent,button)=>openChildAgent(agent,key,path,button),onOpenAgents:button=>openAgentTree(key,path,button),onLoadAgentMore:(agent,cursor)=>loadAgentTranscript(path,agent,cursor,true)}:{}),onMountTerminal:(run,terminalHost)=>{const view=mountTerminal(run,terminalHost);return {...view,update:next=>view.update(next)};}},source);
  if(!view){const controller=createAgentConsole(host,snapshot);view={controller,element:controller.element};consoleViews.set(key,view);view.usedAt=++consoleUses;pruneConsoleViews();}else{if(!floatingConsoles.has(view.element)&&view.element.parentElement!==host)host.append(view.element);view.controller.update(snapshot);}view.snapshot=snapshot;view.data=data;view.sourcePath=path;view.signature=signature;return view;
}
function consoleSignature(key,data,source){
  const edge=list=>list?.length?`${list.length}|${list[0].id}|${list.at(-1).id}|${list.at(-1).status||''}`:'0';
  return JSON.stringify([key,window.AIWSPlugins?.conversationRevision?.()??0,detailTab,childAgentSelection?.parentKey===key?childAgentSelection.agent.id:null,data.title,data.workspace,data.provider,Boolean(data.readOnly),Boolean(data.composerDisabled),data.composerHint||'',Boolean(data.onContinue),Boolean(data.onSendMessage),Boolean(data.onInterrupt),Boolean(data.onDeliverNow),data.terminalRun?.id||null,data.terminalRun?.status||null,
    (data.runs||[]).map(run=>[run.id,run.status,run.sessionId,run.terminalMode,run.finishedAt,run.executionInfo?.model,run.executionSnapshot?.agent?.name]),edge(data.events),edge(data.messages),(data.questions||[]).map(question=>[question.id,question.status,question.answer]),
    source?[source.revision||0,source.loading,source.error,source.sourceAvailable]:null]);
}
// Consoles stay cached so reopening a task keeps its scroll and draft; past this many, the least recently shown detached ones are destroyed.
const consoleCacheLimit=16;let consoleUses=0;
function pruneConsoleViews(){
  if(consoleViews.size<=consoleCacheLimit)return;
  const idle=[...consoleViews].filter(([key,view])=>!view.element.isConnected&&!floatingConsoles.has(view.element)&&childAgentSelection?.parentKey!==key).sort((a,b)=>a[1].usedAt-b[1].usedAt);
  for(const [key,view] of idle.slice(0,consoleViews.size-consoleCacheLimit)){consoleViews.delete(key);view.controller.destroy();}
}
