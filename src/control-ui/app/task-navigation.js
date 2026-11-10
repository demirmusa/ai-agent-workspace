'use strict';
// Opening and closing the task panel, and keeping keyboard focus inside it while it is open.
function preserveFocus(callback){const active=document.activeElement,id=active?.id,value=active?.value,start=active?.selectionStart,end=active?.selectionEnd,inside=$('#task-panel').contains(active);callback();if(inside&&id){const element=document.getElementById(id);if(element){if(['TEXTAREA','INPUT'].includes(element.tagName))element.value=value;element.focus({preventScroll:true});if(typeof start==='number'&&element.setSelectionRange)element.setSelectionRange(start,end);}}}
const neverRun=item=>Boolean(item)&&!item.currentRunId&&!item.externalHistory&&!item.historyResume&&!item.sessionContinuation&&!taskRuns(item.id).length;
// A description edit still open when the panel switches to another task or closes is saved, not dropped.
function savePendingDescription(){
  const item=task(),area=document.querySelector('#info-description');if(!item||!area||infoEdit.taskId!==item.id||infoEdit.description===null)return;
  infoEdit.description=null;if(area.value!==(item.description||''))void saveTaskField(item,{description:area.value}).then(saved=>{if(!saved&&task()?.id!==item.id)error(`${item.title}: ${globalThis.AIWSI18n.text('Açıklama kaydedilemedi.')}`);});
}
function openTask(id) {if(organizeLocked(state.tasks.find(item=>item.id===id)))return;if(id!==selectedTaskId)savePendingDescription();if(!$('#task-panel').contains(document.activeElement))detailReturnFocus=document.activeElement;selectedHistory=null;selectedTaskId=id;const opened=state.tasks.find(item=>item.id===id);detailTab=neverRun(opened)||opened?.status==='done'?'info':'console'; render(); $('#close-panel')?.focus({preventScroll:true}); }
// Focus returns to what opened the panel, else to the card or session entry it showed.
function closedPanelOrigin(id,history){const key=CSS.escape(String(history?history.id:id));return document.querySelector(history?history.external?`[data-external-session="${key}"]`:`[data-history-session="${key}"] [data-history-open]`:`[data-open-task="${key}"]`);}
function closePanel() {savePendingDescription();closeAgentScreen(false);closeChildAgent(false);finishDetailResize();const closedId=selectedTaskId,closedHistory=selectedHistory;selectedTaskId=null;selectedHistory=null;sessionFullscreen=false;render();const target=detailReturnFocus?.isConnected?detailReturnFocus:closedPanelOrigin(closedId,closedHistory);target?.focus();}
// Clicking outside the open task detail panel closes it. Clicks on other cards, menus or dialogs keep their own behavior.
// Registered before the feature click handlers, so it sees the click before they re-render or open a dialog.
document.addEventListener('click',event=>{
  const panel=$('#task-panel');if(panel.hidden||!event.target.isConnected||(!task()&&!selectedHistory))return;
  if(event.target.closest('#task-panel,.agent-child-panel,.agent-screen,dialog,.popup-menu,.toast,#notifications,[data-open-task],[data-open-question],[data-git-task],[data-history-session],[data-external-session],[data-session-card],[data-refresh-live]')||$('#modal').open||window.getSelection()?.toString())return;
  closePanel();
});
document.addEventListener('click',event=>{
  const target=event.target.closest('button,[data-open-task]');if(!target)return;
  if(target.id==='close-panel'){closePanel();return;}
  if(!target.dataset.openTask)return;
  if(target.classList.contains('organize-locked')){event.preventDefault();toast(globalThis.AIWSI18n.text('AI sıralaması sürerken bu iş açılamaz.'));return;}
  // A modifier key or the card's checkbox selects the card instead of opening it.
  if(target.closest('#board')&&(event.ctrlKey||event.metaKey||event.shiftKey||event.target.closest('td.list-select,[data-select-task]'))){event.preventDefault();selectBoardTask(target.dataset.openTask,event);return;}
  openTask(target.dataset.openTask);
});
// Arrow keys move between the detail tabs; Tab stays inside the open panel (or the child agent panel above it).
document.addEventListener('keydown',event=>{
  if(event.defaultPrevented||event.target.closest('.terminal-instance'))return;
  if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)&&event.target.matches('[data-detail-tab]')){event.preventDefault();const tabs=$$('[data-detail-tab]:not(:disabled)'),index=tabs.indexOf(event.target),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next]?.click();$(`#detail-tab-${detailTab}`)?.focus();return;}
  if(event.key!=='Tab'||(!task()&&!selectedHistory)||$('#modal').open)return;
  const scope=childAgentSelection?childAgentPanel:agentScreen?.element||$('#task-panel'),focusable=focusableIn(scope);const first=focusable[0],last=focusable.at(-1);if(!first)return;
  if(event.shiftKey&&(document.activeElement===first||!scope.contains(document.activeElement))){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&(document.activeElement===last||!scope.contains(document.activeElement))){event.preventDefault();first.focus();}
});
