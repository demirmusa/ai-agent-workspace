'use strict';
// Multi-selection of board cards and the bulk selection controls (move, milestone, archive, clear).
const selectedBoardTasks=new Set();
let boardSelectionAnchor=null,boardSelectionScope='',bulkMoveBusy=false,draggedIds=[],boardRenderDeferred=false,dropColumn=null,archiveView=false;
function visibleBoardTaskIds(){return [...new Set([...document.querySelectorAll('#board [data-open-task]:not(.organize-locked)')].map(element=>element.dataset.openTask))];}
// A swimlane header selects its column across every project.
const columnCardIds=header=>header.dataset.selectColumn?[...document.querySelectorAll(`#board [data-lane-column="${header.dataset.selectColumn}"]`)].flatMap(selectableIds):selectableIds(header.closest('table,section'));
const selectableIds=container=>[...container.querySelectorAll('[data-open-task]:not(.organize-locked)')].map(item=>item.dataset.openTask);
function isTaskBoardPage(){return activeScreen==='overview'&&overviewTab()==='board'||activeScreen==='board'&&projectTab()==='board';}
function syncBoardSelection(){
  const available=isTaskBoardPage(),scope=(activeScreen==='overview'?'overview':projectId)+':'+archiveView;
  const visible=new Set(available?visibleBoardTaskIds():[]);
  if(boardSelectionScope!==scope||!available){selectedBoardTasks.clear();boardSelectionAnchor=null;boardSelectionScope=scope;}
  for(const id of selectedBoardTasks)if(!visible.has(id))selectedBoardTasks.delete(id);
  for(const element of $$('#board [data-open-task]')){const selected=selectedBoardTasks.has(element.dataset.openTask);element.classList.toggle('bulk-selected',selected);element.setAttribute('aria-pressed',String(selected));}
  $('#task-selection-controls').hidden=!available||!selectedBoardTasks.size;
  $('#board').classList.toggle('has-task-selection',selectedBoardTasks.size>0);
  $('#task-selection-count').textContent=globalThis.AIWSI18n.template`${selectedBoardTasks.size} görev seçili`;
  for(const id of ['clear-task-selection','bulk-task-status','move-selected-tasks','archive-selected-tasks','bulk-task-milestone'])$('#'+id).disabled=bulkMoveBusy||!selectedBoardTasks.size;
  // Milestones belong to one project, so the board of a project offers them for the selection.
  const milestoneSelect=$('#bulk-task-milestone'),milestones=activeScreen==='board'&&projectId?projectMilestones(projectId):[];milestoneSelect.hidden=!available||!milestones.length;
  if(milestones.length){const html=milestoneOptionsHtml(projectId,'',[['',globalThis.AIWSI18n.text('Milestone’a taşı…')],['none',globalThis.AIWSI18n.text('Milestone’dan çıkar')]]);if(milestoneSelect.dataset.html!==html){milestoneSelect.innerHTML=html;milestoneSelect.dataset.html=html;}}
  $('#archive-selected-tasks').textContent=archiveView?globalThis.AIWSI18n.text('Arşivden çıkar'):globalThis.AIWSI18n.text('Seçilileri arşivle');
  $('#archive-view').setAttribute('aria-pressed',String(archiveView));
  $('#archive-view').disabled=bulkMoveBusy;
  for(const header of $$('#board [data-select-column]')){const ids=columnCardIds(header);header.setAttribute('aria-pressed',String(ids.length>0&&ids.every(id=>selectedBoardTasks.has(id))));header.disabled=bulkMoveBusy||!ids.length;}
  $('#move-selected-tasks').textContent=bulkMoveBusy?globalThis.AIWSI18n.text('Taşınıyor…'):globalThis.AIWSI18n.text('Seçilileri taşı');
}
function clearBoardSelection(){selectedBoardTasks.clear();boardSelectionAnchor=null;syncBoardSelection();}
function selectBoardTask(id,event={}){
  if(bulkMoveBusy)return;
  const ids=visibleBoardTaskIds(),anchor=ids.indexOf(boardSelectionAnchor),index=ids.indexOf(id);if(index<0)return;
  if(event.shiftKey&&anchor>=0){for(const value of ids.slice(Math.min(anchor,index),Math.max(anchor,index)+1))selectedBoardTasks.add(value);}
  else {if(selectedBoardTasks.has(id))selectedBoardTasks.delete(id);else selectedBoardTasks.add(id);boardSelectionAnchor=id;}
  syncBoardSelection();
}
function selectBoardColumn(header){
  if(bulkMoveBusy)return;
  const ids=columnCardIds(header),all=ids.every(id=>selectedBoardTasks.has(id));
  for(const id of ids){if(all)selectedBoardTasks.delete(id);else selectedBoardTasks.add(id);}
  syncBoardSelection();
}
async function archiveBoardTasks(){
  if(bulkMoveBusy||!selectedBoardTasks.size)return;
  bulkMoveBusy=true;syncBoardSelection();
  // The live stream already carries the change; refreshing must not keep the board busy.
  const taskIds=[...selectedBoardTasks],archived=!archiveView;
  try{await api('/tasks/archive','POST',{taskIds,archived});selectedBoardTasks.clear();void refresh();toast(archived?globalThis.AIWSI18n.text('Görevler arşivlendi'):globalThis.AIWSI18n.text('Görevler arşivden çıkarıldı'),undoAction(()=>api('/tasks/archive','POST',{taskIds,archived:!archived})));}
  catch(cause){error(cause.message);}
  finally{bulkMoveBusy=false;syncBoardSelection();}
}
$('#archive-selected-tasks').onclick=()=>void archiveBoardTasks();
async function moveBoardTasksToMilestone(select){
  const value=select.value;select.value='';if(!value||bulkMoveBusy||!selectedBoardTasks.size)return;
  bulkMoveBusy=true;syncBoardSelection();
  const taskIds=[...selectedBoardTasks],milestoneId=value==='none'?null:value,previous=new Map(taskIds.map(id=>[id,state.tasks.find(item=>item.id===id)?.milestoneId||null]));
  try{
    const result=await assignMilestone(projectId,taskIds,milestoneId),target=findMilestone(projectId,milestoneId);
    // Undo puts every task back into the milestone it came from.
    const groups=new Map();for(const [id,from] of previous){const list=groups.get(from)||[];list.push(id);groups.set(from,list);}
    toast(target?globalThis.AIWSI18n.template`${result.moved} görev "${target.title}" milestone’una taşındı`:globalThis.AIWSI18n.template`${result.moved} görev milestone’dan çıkarıldı`,undoAction(async()=>{for(const [from,ids] of groups)await assignMilestone(projectId,ids,from);}));
  }catch(cause){error(cause.message);}
  finally{bulkMoveBusy=false;syncBoardSelection();}
}
$('#bulk-task-milestone').onchange=event=>void moveBoardTasksToMilestone(event.target);
$('#clear-task-selection').onclick=clearBoardSelection;
$('#move-selected-tasks').onclick=()=>void moveBoardTasks([...selectedBoardTasks],$('#bulk-task-status').value);
document.addEventListener('click',event=>{const header=event.target.closest('button[data-select-column]');if(header)selectBoardColumn(header);});
