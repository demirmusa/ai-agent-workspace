'use strict';
// The agent hierarchy of a console and the read-only records of its subagents in the side panel.
function openChildAgent(agent,parentKey,path,button){
  const parent=consoleViews.get(parentKey);if(!parent)return;
  if(parent.snapshot.taskId&&(!task()||task().id!==parent.snapshot.taskId||$('#task-panel').hidden)){detailTab='console';openTask(parent.snapshot.taskId);parentKey=`task:${parent.snapshot.taskId}`;}
  if(sessionFullscreen){sessionFullscreen=false;render();}
  let previous=childAgentSelection;
  if(previous&&(previous.parentKey!==parentKey||previous.path!==path)){closeChildAgent(false);previous=null;}
  ensureChildAgentPanel();
  if(previous?.controller&&previous.agent.id!==agent.id){previous.controller.destroy();previous.controller=null;}
  const fromWorkflow=agent.kind==='workflow'?null:previous?.agent?.kind==='workflow'&&!previous.kind?previous.agent:previous?.fromWorkflow||null;
  childAgentSelection={...previous,kind:null,fromWorkflow,fromTree:previous?.kind==='agents'||Boolean(previous?.fromTree),agent,parentKey,path,returnFocus:previous?.returnFocus||button,controller:previous?.controller||null};childAgentPanel.hidden=false;
  const source=ensureAgentSource(path);source.selectedId=agent.kind==='workflow'?null:agent.id;if(agentScreen)childAgentSelection.fromScreen=true;const root=consoleViews.get(parentKey);if(root){root.snapshot={...root.snapshot,inspectedAgentId:agent.id};root.controller.update(root.snapshot);}
  $('#task-panel').setAttribute('aria-modal','false');renderChildAgent();applyDetailWidth();$('#close-child-agent').focus({preventScroll:true});
  if(agent.kind!=='workflow')void loadAgentTranscript(path,agent);
}
/** The agent hierarchy of a console in the side panel; choosing an agent there opens its record in the same panel. */
function openAgentTree(parentKey,path,button){
  if(childAgentSelection?.kind==='agents'&&childAgentSelection.parentKey===parentKey){closeChildAgent();return;}
  closeAgentScreen(false);
  if(sessionFullscreen){sessionFullscreen=false;render();}
  const previous=childAgentSelection&&childAgentSelection.parentKey===parentKey&&childAgentSelection.path===path?childAgentSelection:null;
  if(!previous)closeChildAgent(false);else previous.controller?.destroy();
  ensureChildAgentPanel();
  childAgentSelection={kind:'agents',agent:{id:''},parentKey,path,returnFocus:previous?.returnFocus||button,controller:null};childAgentPanel.hidden=false;
  const root=consoleViews.get(parentKey);if(root){root.snapshot={...root.snapshot,inspectedAgentId:null};root.controller.update(root.snapshot);}
  $('#task-panel').setAttribute('aria-modal','false');renderChildAgent();applyDetailWidth();$('#close-child-agent').focus({preventScroll:true});
}
/** What the agent hierarchy canvas shows, in the side panel and on the full screen alike. */
function agentTreeData(parentKey,path){return {agentTree:agentSourceCache.get(path)?.agentTree,title:false,onOpenAgent:(agent,button)=>openChildAgent(agent,parentKey,path,button)};}
function renderAgentTree(selected){
  // The canvas header carries the counts, so the panel title stays plain.
  const source=agentSourceCache.get(selected.path);
  $('#child-agent-title').textContent=globalThis.AIWSI18n.text('Agentlar');$('#child-agent-status').textContent='';
  $('.child-agent-footer>span').textContent=globalThis.AIWSI18n.text('Agent hiyerarşisi · Salt okunur');$('#child-agent-back').textContent=globalThis.AIWSI18n.text('Ana oturuma dön');
  const data=agentTreeData(selected.parentKey,selected.path);
  const host=$('#child-agent-console-host');if(!selected.controller)selected.controller=window.AIWSAgentConsole.agentFlow(host,data);else selected.controller.update(data);
  childAgentPanel.querySelector('.child-agent-notice')?.setAttribute('hidden','');$('[data-child-more]',$('.child-agent-footer'))?.remove();
}
/** A workflow in the side panel: the hierarchy canvas over its steps and their agents; choosing an agent opens its record in the same panel. */
function renderWorkflow(selected,agent){
  const tree=window.AIWSAgentConsole.workflowTree(window.AIWSAgentConsole.inferAgentTree({agentTree:agentSourceCache.get(selected.path)?.agentTree}),agent.id);
  $('#child-agent-title').textContent=agent.name;$('#child-agent-status').textContent=window.AIWSAgentConsole.statusLabel(agent.status);
  $('.child-agent-footer>span').textContent=globalThis.AIWSI18n.text('Workflow · Salt okunur');$('#child-agent-back').textContent=selected.fromTree||selected.fromScreen?globalThis.AIWSI18n.text('← Agentlar'):globalThis.AIWSI18n.text('Ana oturuma dön');
  const data={agentTree:tree||{rootId:agent.id,agents:[agent]},title:false,onOpenAgent:(child,button)=>openChildAgent(child,selected.parentKey,selected.path,button)};
  const host=$('#child-agent-console-host');if(!selected.controller)selected.controller=window.AIWSAgentConsole.agentFlow(host,data);else selected.controller.update(data);
  childAgentPanel.querySelector('.child-agent-notice')?.setAttribute('hidden','');$('[data-child-more]',$('.child-agent-footer'))?.remove();
}
let childAgentLoadingShown=null;
/** A subagent's read-only record in the side panel. */
function renderSubagent(selected){
  const source=agentSourceCache.get(selected.path),agent=source?.agentTree?.agents.find(item=>item.id===selected.agent.id)||selected.agent;selected.agent=agent;if(agent.kind==='workflow'){renderWorkflow(selected,agent);return;}
  $('.child-agent-footer>span').textContent=globalThis.AIWSI18n.text('Alt agent · Salt okunur');$('#child-agent-back').textContent=selected.fromWorkflow?globalThis.AIWSI18n.text('← Workflow'):selected.fromTree||selected.fromScreen?globalThis.AIWSI18n.text('← Agentlar'):globalThis.AIWSI18n.text('Ana oturuma dön');
  $('#child-agent-title').textContent=agent.name||globalThis.AIWSI18n.text('Alt agent');$('#child-agent-status').textContent=statuses[agent.status]||({starting:globalThis.AIWSI18n.text('Başlıyor'),completed:globalThis.AIWSI18n.text('Tamamlandı'),closed:globalThis.AIWSI18n.text('Kapatıldı'),stopped:globalThis.AIWSI18n.text('Durduruldu'),pending:globalThis.AIWSI18n.text('Başlamayı bekliyor')})[agent.status]||agent.status||globalThis.AIWSI18n.text('Bilgi bekleniyor');
  const transcript=source?.transcripts[agent.id],descendants=new Set([agent.id]);let changed=true;while(changed){changed=false;for(const item of source?.agentTree?.agents||[])if(descendants.has(item.parentId)&&!descendants.has(item.id)){descendants.add(item.id);changed=true;}}
  const data={...(transcript||{}),instanceId:`child:${selected.path}/${agent.id}`,taskId:undefined,readOnly:true,hideHistoryFooter:true,title:agent.name,provider:agent.provider,workspace:consoleViews.get(selected.parentKey)?.snapshot.workspace,terminalRun:null,runs:transcript?.runs||[],events:transcript?.events||[],messages:transcript?.messages||[],questions:[],agentTree:{rootId:agent.id,agents:(source?.agentTree?.agents||[agent]).filter(item=>descendants.has(item.id)).map(item=>({...item,parentId:item.id===agent.id?null:item.parentId}))},onOpenAgent:(child,button)=>openChildAgent(child,selected.parentKey,selected.path,button)};
  const host=$('#child-agent-console-host');if(!selected.controller)selected.controller=createAgentConsole(host,data);else selected.controller.update(data);
  let note=childAgentPanel.querySelector('.child-agent-notice');if(!note){note=document.createElement('div');note.className='history-context-note child-agent-notice';host.prepend(note);}
  const firstLoad=transcript?.loading&&!transcript.events?.length&&!transcript.messages?.length;childAgentLoadingShown||=window.AIWSAgentConsole.holdFlag(()=>{if(childAgentSelection)renderChildAgent();});
  note.textContent=transcript?.error|| (childAgentLoadingShown(firstLoad)?globalThis.AIWSI18n.text('Alt agent kayıtları yükleniyor…'):'');note.hidden=!note.textContent;
  const footer=$('.child-agent-footer');let more=$('[data-child-more]',footer);if(transcript?.nextCursor){if(!more){more=document.createElement('button');more.type='button';more.className='button small';more.dataset.childMore='true';more.textContent=globalThis.AIWSI18n.text('Önceki mesajları yükle');footer.prepend(more);}more.disabled=Boolean(transcript.loading);more.onclick=()=>void loadAgentTranscript(selected.path,agent,transcript.nextCursor,true);}else more?.remove();
}
