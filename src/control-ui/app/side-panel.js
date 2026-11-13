'use strict';
// The side panel beside the task panel: opening, closing and choosing what it shows.
function ensureChildAgentPanel(){
  if(childAgentPanel)return childAgentPanel;
  childAgentPanel=document.createElement('aside');childAgentPanel.id='agent-child-panel';childAgentPanel.className='agent-child-panel';childAgentPanel.setAttribute('role','dialog');childAgentPanel.setAttribute('aria-modal','true');childAgentPanel.setAttribute('aria-labelledby','child-agent-title');
  childAgentPanel.innerHTML=globalThis.AIWSI18n.text('<header class="panel-header"><div class="detail-heading"><span class="task-status-chip" id="child-agent-status"></span><h2 id="child-agent-title"></h2></div><button type="button" class="icon-button" id="close-child-agent" aria-label="Alt agent panelini kapat">×</button></header><div id="child-agent-console-host" class="agent-console-host"></div><div id="child-changes-host" class="changes-view"></div><div id="child-context-host" class="context-host"></div><footer class="modal-footer child-agent-footer"><span>Alt agent · Salt okunur</span><button type="button" class="button small" id="child-agent-back">Ana oturuma dön</button></footer>');
  $('#task-panel').after(childAgentPanel);const expand=document.createElement('button');expand.type='button';expand.className='icon-button';expand.id='child-agent-fullscreen';expand.hidden=true;expand.innerHTML=window.AIWSUI.icon('expand');expand.title=globalThis.AIWSI18n.text('Tam ekran');expand.setAttribute('aria-label',expand.title);$('#close-child-agent').before(expand);
  expand.onclick=()=>{const selected=childAgentSelection;if(selected?.kind==='agents')openAgentScreen(selected.parentKey,selected.path,selected.returnFocus);};
  $('#close-child-agent').onclick=()=>closeChildAgent();$('#child-agent-back').onclick=()=>{const selected=childAgentSelection;if(selected?.fromWorkflow&&!selected.kind)openChildAgent(selected.fromWorkflow,selected.parentKey,selected.path,selected.returnFocus);else if(selected?.fromTree&&!selected.kind&&!agentScreen)openAgentTree(selected.parentKey,selected.path,selected.returnFocus);else closeChildAgent();};
  return childAgentPanel;
}
/** Shows a changes list or a context map in the side panel beside the task panel. */
function showSidePanel(selection){
  if(sessionFullscreen){sessionFullscreen=false;render();}
  closeChildAgent(false);ensureChildAgentPanel();
  childAgentSelection=selection;childAgentPanel.hidden=false;
  $('#task-panel').setAttribute('aria-modal','false');renderChildAgent();applyDetailWidth();$('#close-child-agent').focus({preventScroll:true});
}
function closeChildAgent(restoreFocus=true){
  const selected=childAgentSelection;childAgentSelection=null;
  // Hide first: a failure while tearing the console down must never leave the panel stuck open.
  if(childAgentPanel)childAgentPanel.hidden=true;if(!selected)return;
  try{
    const source=agentSourceCache.get(selected.path);if(source)source.selectedId=null;
    selected.controller?.destroy();
    const parent=consoleViews.get(selected.parentKey);if(parent){parent.snapshot={...parent.snapshot,inspectedAgentId:null};parent.controller.update(parent.snapshot);}
  }finally{$('#task-panel').setAttribute('aria-modal',String(!$('#task-panel').hidden));applyDetailWidth();}
  if(restoreFocus)(selected.returnFocus?.isConnected?selected.returnFocus:$('#close-panel'))?.focus({preventScroll:true});
  if(selected.taskId)queueMicrotask(()=>{if(task()&&!$('#task-panel').hidden)renderDetail();});
}
function renderChildAgent(){
  const selected=childAgentSelection;if(!selected||!childAgentPanel)return;$('#child-agent-fullscreen').hidden=selected.kind!=='agents';childAgentPanel.dataset.view=['changes','context'].includes(selected.kind)?selected.kind:'agent';if(selected.kind==='changes'){renderChangesPanel(selected);return;}if(selected.kind==='context'){renderContextPanel(selected);return;}if(selected.kind==='session'){renderTaskAgentSession(selected);return;}if(selected.kind==='agents'){renderAgentTree(selected);return;}renderSubagent(selected);
}
window.addEventListener('pagehide',()=>closeChildAgent(false));
