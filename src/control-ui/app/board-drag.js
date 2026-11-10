'use strict';
// Dragging board cards between columns, within the ready queue and onto other cards as blockers.
// Ctrl (Cmd on macOS) held when the drag starts makes it a blocker drag: it only links
// cards and never changes status. A plain drag only moves cards between columns.
// The whole card is the drag source. While a drag runs the board is not
// re-rendered: replacing the source element would cancel the browser drag.
const dropPlaceholder=document.createElement('div');dropPlaceholder.className='drop-placeholder';dropPlaceholder.setAttribute('aria-hidden','true');
const dropStates=column=>(column.dataset.dropStates||'').split(' ');
function dropTarget(column){
  if(!column||!draggedIds.length)return false;
  const project=column.dataset.dropProject,items=draggedIds.map(id=>state.tasks.find(item=>item.id===id)).filter(Boolean);
  const states=dropStates(column);
  return items.length>0&&(items.some(item=>!states.includes(item.status))||reorderColumn(column))&&(!project||items.every(item=>item.projectId===project));
}
const reorderColumn=column=>column?.dataset.boardColumn==='ready';
// The ready column places the drop between cards; other columns append.
function dropBefore(column,y){
  if(!reorderColumn(column))return column.querySelector(':scope > .add-card');
  return [...column.querySelectorAll(':scope > [data-open-task]:not(.dragging)')].find(card=>{const rect=card.getBoundingClientRect();return y<rect.top+rect.height/2;})||column.querySelector(':scope > .add-card');
}
// A blocker drag dropped onto another card makes the dropped cards wait for it (dependsOn).
const reaches=(from,goal,seen=new Set())=>from===goal||(!seen.has(from)&&(seen.add(from),(state.tasks.find(item=>item.id===from)?.dependsOn||[]).some(next=>reaches(next,goal,seen))));
function blockerDrop(event){
  if(!blockerDrag)return null;
  const card=event.target.closest?.('#board [data-open-task]'),target=card&&state.tasks.find(item=>item.id===card.dataset.openTask);
  if(!target||target.externalHistory||draggedIds.includes(target.id)||card.classList.contains('organize-locked'))return null;
  const items=draggedIds.map(id=>state.tasks.find(item=>item.id===id)).filter(item=>item&&!item.externalHistory&&item.projectId===target.projectId&&!(item.dependsOn||[]).includes(target.id)&&!reaches(target.id,item.id));
  return items.length?{card,target,items}:null;
}
let blockerCard=null,blockerDrag=false;
const showBlockerDrop=card=>{if(blockerCard===card)return;blockerCard?.classList.remove('blocker-drop-target');blockerCard?.removeAttribute('data-blocker-label');blockerCard=card;if(!card)return;card.dataset.blockerLabel=globalThis.AIWSI18n.text('Bunun bitmesini bekle');card.classList.add('blocker-drop-target');};
// The links are saved one by one; a refusal stops there and says how many were linked before it.
async function dropAsBlocker({target,items}){
  let linked=0;
  try{for(const item of items){await api(`/tasks/${item.id}`,'PATCH',{dependencyRefs:[...new Set([...(item.dependsOn||[]),target.id])]});linked++;}toast(globalThis.AIWSI18n.template`${items.length} görev "${target.title}" bitene kadar bekleyecek`);}
  catch(problem){error(linked?`${linked}/${items.length} ${globalThis.AIWSI18n.text('görev bağlandı.')} ${problem.message}`:problem.message);}
  await refresh();
}
function showDropColumn(column,y){
  if(dropColumn!==column){dropColumn?.classList.remove('drag-over');dropPlaceholder.remove();dropColumn=column;if(!column)return;column.classList.add('drag-over');dropPlaceholder.textContent=globalThis.AIWSI18n.template`${draggedIds.length} görevi buraya bırak`;}
  else if(!column||(dropPlaceholder.parentElement&&!reorderColumn(column)))return;
  const before=dropBefore(column,y);if(dropPlaceholder.nextElementSibling===before&&dropPlaceholder.parentElement===column)return;
  if(before)column.insertBefore(dropPlaceholder,before);else column.append(dropPlaceholder);
}
function autoScrollDrag(event){
  for(let element=event.target instanceof Element?event.target:null;element&&element!==document.documentElement;element=element.parentElement){
    const rect=element.getBoundingClientRect(),edge=48,step=18;
    if(element.scrollWidth>element.clientWidth){if(event.clientX<rect.left+edge)element.scrollLeft-=step;else if(event.clientX>rect.right-edge)element.scrollLeft+=step;}
    if(element.scrollHeight>element.clientHeight){if(event.clientY<rect.top+edge)element.scrollTop-=step;else if(event.clientY>rect.bottom-edge)element.scrollTop+=step;}
  }
}
let boardDragSource=null;
function endBoardDrag(){
  boardDragSource?.removeEventListener('dragend',endBoardDrag);boardDragSource?.classList.remove('dragging');boardDragSource=null;
  draggedIds=[];blockerDrag=false;showBlockerDrop(null);showDropColumn(null);document.querySelectorAll('#board .dragging').forEach(item=>item.classList.remove('dragging'));
  for(const card of document.querySelectorAll('#board [data-open-task][draggable="false"]'))card.setAttribute('draggable','true');
  if(boardRenderDeferred){boardRenderDeferred=false;scheduleRender();}
}
// Alt+drag selects card text instead of moving the card.
window.addEventListener('pointerdown',event=>{endBoardDrag();const card=event.target.closest?.('#board [data-open-task][draggable]');if(card)card.setAttribute('draggable',String(!event.altKey));},true);
// Native dragstart emits pointercancel, so it must not be treated as drag completion.
window.addEventListener('pointerup',endBoardDrag,true);
window.addEventListener('blur',endBoardDrag);
document.addEventListener('visibilitychange',()=>{if(document.hidden)endBoardDrag();});
window.addEventListener('keydown',event=>{if(event.key==='Escape'&&draggedIds.length){event.preventDefault();event.stopPropagation();endBoardDrag();}},true);
document.addEventListener('dragstart',event=>{const card=event.target.closest?.('#board [data-open-task][draggable="true"]');if(!card)return;if(bulkMoveBusy){event.preventDefault();return;}const id=card.dataset.openTask;draggedIds=selectedBoardTasks.has(id)?visibleBoardTaskIds().filter(value=>selectedBoardTasks.has(value)):[id];event.dataTransfer.setData('text/plain',draggedIds.join('\n'));blockerDrag=event.ctrlKey||event.metaKey;event.dataTransfer.effectAllowed=blockerDrag?'link':'move';boardDragSource=card;card.addEventListener('dragend',endBoardDrag);for(const element of $$('#board [data-open-task]'))if(draggedIds.includes(element.dataset.openTask))element.classList.add('dragging');});
document.addEventListener('dragover',event=>{if(!draggedIds.length)return;autoScrollDrag(event);if(blockerDrag){const link=blockerDrop(event);showBlockerDrop(link?.card);if(link){event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='link';}return;}const column=event.target.closest?.('[data-drop-status]');if(dropTarget(column)){event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';showDropColumn(column,event.clientY);}else showDropColumn(null);});
document.addEventListener('dragleave',event=>{if(dropColumn&&event.relatedTarget&&!dropColumn.contains(event.relatedTarget))showDropColumn(null);});
document.addEventListener('drop',async event=>{if(!draggedIds.length)return;if(blockerDrag){const link=blockerDrop(event);if(link)event.preventDefault();endBoardDrag();if(link)await dropAsBlocker(link);return;}const column=event.target.closest?.('[data-drop-status]'),ids=draggedIds,allowed=dropTarget(column);if(allowed)event.preventDefault();
  // The new ready order is read from the cards around the placeholder before the drag state is cleared.
  const order=allowed&&reorderColumn(column)&&dropPlaceholder.parentElement===column?(()=>{const cards=[...column.querySelectorAll(':scope > [data-open-task], :scope > .drop-placeholder')].map(element=>element===dropPlaceholder?null:element.dataset.openTask).filter(id=>id===null||!ids.includes(id)),at=cards.indexOf(null),before=[...column.querySelectorAll(':scope > [data-open-task]')].map(element=>element.dataset.openTask);cards.splice(at,1,...ids);return cards.join()===before.join()?null:cards;})():null;
  endBoardDrag();if(!allowed)return;
  const states=dropStates(column);
  if(ids.some(id=>!states.includes(state.tasks.find(item=>item.id===id)?.status)))await moveBoardTasks(ids,column.dataset.dropStatus);
  if(order){const ready=order.filter(id=>state.tasks.find(item=>item.id===id)?.status==='ready');if(ready.length>1)await reorderReadyTasks(ready);}
});
document.addEventListener('dragend',endBoardDrag);
// Chromium suppresses mouse events during a native drag; one arriving with no
// button pressed means the drag ended without a dragend on this document.
document.addEventListener('mousemove',event=>{if(draggedIds.length&&!event.buttons)endBoardDrag();});
