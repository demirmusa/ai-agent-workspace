'use strict';
// The status columns of a project board: which statuses each column gathers, the card order in it, and its header actions.
const columns = [{id:'backlog',name:globalThis.AIWSI18n.text('Bekleyen'),statuses:['backlog']},{id:'ready',name:globalThis.AIWSI18n.text('Hazır'),statuses:['ready']},{id:'running',name:globalThis.AIWSI18n.text('Çalışma'),statuses:['running','paused']},{id:'needs',name:globalThis.AIWSI18n.text('Seni bekliyor'),statuses:['waiting','failed'],drop:false},{id:'review',name:globalThis.AIWSI18n.text('İnceleme'),statuses:['review']},{id:'done',name:globalThis.AIWSI18n.text('Tamamlandı'),statuses:['completing','done','cancelled']}];
// Ready cards run top to bottom; the server dispatches in this same order (readyQueue in service/common.ts):
// a task's priority rises to the highest priority of the unfinished tasks waiting on it, manually placed cards keep their
// positions and an unplaced card goes ahead of the first placed card with a lower priority.
function effectivePriorities(all){
  const dependents=new Map(),result=new Map(),visiting=new Set();
  for(const task of all){if(task.archivedAt||['done','cancelled'].includes(task.status))continue;for(const id of task.dependsOn||[])dependents.set(id,[...(dependents.get(id)||[]),task]);}
  const resolve=task=>{if(result.has(task.id))return result.get(task.id);if(visiting.has(task.id))return task.priority;visiting.add(task.id);let value=task.priority;for(const dependent of dependents.get(task.id)||[])value=Math.max(value,resolve(dependent));visiting.delete(task.id);result.set(task.id,value);return value;};
  all.forEach(resolve);return result;
}
function readyQueue(items){
  const priorities=effectivePriorities(state.tasks),priority=task=>priorities.get(task.id)??task.priority,ordered=[];
  const placed=items.filter(task=>task.queueOrder!=null).sort((a,b)=>a.queueOrder-b.queueOrder||a.createdAt.localeCompare(b.createdAt));
  const unplaced=items.filter(task=>task.queueOrder==null).sort((a,b)=>priority(b)-priority(a)||a.createdAt.localeCompare(b.createdAt));
  for(const task of placed){while(unplaced.length&&priority(unplaced[0])>priority(task))ordered.push(unplaced.shift());ordered.push(task);}
  return [...ordered,...unplaced];
}
// Other columns list cards in the order they entered the status: the newest sits at the bottom.
const enteredOrder=items=>[...items].sort((a,b)=>(Date.parse(a.updatedAt)||0)-(Date.parse(b.updatedAt)||0));
const completedOrder=items=>enteredOrder(items).reverse();
const columnCards=(column,items)=>column.id==='ready'?readyQueue(items):column.id==='backlog'?items:column.id==='done'?completedOrder(items):enteredOrder(items);
function boardColumnHtml(column,items){
  const cards=columnCards(column,items.filter(item=>column.statuses.includes(item.status))),canCreate=['backlog','ready'].includes(column.id),name=esc(column.name);
  return globalThis.AIWSI18n.template`<section class="column${organizeRunning(projectId)&&canCreate?' organizing':''}" data-board-column="${column.id}"${column.drop===false?'':` data-drop-status="${column.id}"`} data-drop-states="${column.statuses.join(' ')}" aria-label="${name}"><div class="column-header"><button type="button" class="column-select" data-select-column aria-pressed="false" aria-label="${name} sütunundaki tüm görevleri seç"><span class="column-dot ${column.id}"></span>${name}<span class="column-count">${cards.length}</span></button>${column.id==='backlog'?organizeButton():''}${canCreate?globalThis.AIWSI18n.template`<button class="icon-button" data-new-status="${column.id}" aria-label="${name} durumunda görev oluştur">+</button>`:''}</div>${column.id==='backlog'?organizeBanner():''}${cards.map(card).join('')}${!cards.length?(boardFiltered()?`<div class="empty-column">${boardNoMatchesHtml()}</div>`:globalThis.AIWSI18n.text('<div class="empty-column">Henüz görev yok</div>')):''}${canCreate?globalThis.AIWSI18n.template`<button class="add-card" data-new-status="${column.id}">+ Görev ekle</button>`:''}</section>`;
}
function renderBoardColumns(items){
  // "Seni bekliyor" is always shown; auto-merge projects skip review, so that column drops unless a task still sits there.
  const autoMerge=project()?.autoMerge,visibleColumns=columns.filter(column=>column.id!=='review'||!autoMerge||items.some(item=>column.statuses.includes(item.status)));
  setHtml($('#board'),visibleColumns.map(column=>boardColumnHtml(column,items)).join(''));
}
document.addEventListener('click',event=>{const target=event.target.closest('button[data-new-status]');if(target&&['backlog','ready'].includes(target.dataset.newStatus))taskModal(false,target.dataset.newStatus);});
