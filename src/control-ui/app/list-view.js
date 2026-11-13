'use strict';
// The list view of the board and its sorting.
// List sorting is a per-device preference; with none saved the list keeps board order.
const listSortKeys=['id','title','status','milestone','agent','updated'],listStatusOrder=['backlog','ready','running','waiting','paused','failed','review','completing','done','cancelled'];
let listSort=(()=>{try{const value=JSON.parse(localStorage.getItem('aiws.list-sort'));return listSortKeys.includes(value?.key)&&['asc','desc'].includes(value.dir)?{key:value.key,dir:value.dir}:null;}catch{return null;}})();
const listCollator=new Intl.Collator(globalThis.AIWSI18n.locale,{numeric:true,sensitivity:'base'});
const taskAgentName=item=>taskAgent(item)?.name||providers[taskProvider(item)];
const taskMilestoneTitle=item=>findMilestone(item.projectId,item.milestoneId)?.title||'';
function sortListTasks(items){
  if(!listSort)return items;
  const value={id:taskKey,title:item=>item.title,status:item=>listStatusOrder.indexOf(item.status),milestone:taskMilestoneTitle,agent:taskAgentName,updated:item=>Date.parse(item.updatedAt)||0}[listSort.key],direction=listSort.dir==='desc'?-1:1;
  return items.map(item=>({item,key:value(item)})).sort((a,b)=>direction*(typeof a.key==='number'?a.key-b.key:listCollator.compare(a.key??'',b.key??''))).map(entry=>entry.item);
}
function listSortHeader(key,label){const active=listSort?.key===key,dir=active?listSort.dir:'';return `<th aria-sort="${dir==='asc'?'ascending':dir==='desc'?'descending':'none'}"><button type="button" class="list-sort ${active?'active':''}" data-sort-list="${key}">${esc(label)}<span class="sort-indicator" aria-hidden="true">${dir==='asc'?'▲':dir==='desc'?'▼':'↕'}</span></button></th>`;}
function toggleListSort(key){if(!listSortKeys.includes(key))return;listSort={key,dir:listSort?.key===key&&listSort.dir==='asc'?'desc':'asc'};try{localStorage.setItem('aiws.list-sort',JSON.stringify(listSort));}catch{/* Storage may be disabled. */}render();}
const listSelectBox='<span class="select-box" aria-hidden="true"></span>';
function taskListRow(item){
  const locked=organizeLocked(item),title=esc(window.AIWSUI.taskTitle(item));
  return `<tr data-open-task="${esc(item.id)}" tabindex="${locked?'-1':'0'}" role="button"${locked?` class="organize-locked" aria-disabled="true" aria-busy="true" style="--organize-delay:${organizeDelay(item.id)}ms"`:''} aria-label="${title}"><td class="list-select">${listSelectBox}</td><td>${esc(taskKey(item))}</td><td>${title}</td><td>${esc(statuses[item.status])}${pending(item.id).length?' · ◉':''}</td><td>${esc(taskMilestoneTitle(item)||'—')}</td><td>${esc(taskAgentName(item))}</td><td>${esc(relative(item.updatedAt))}</td></tr>`;
}
function renderTaskList(items){
  setHtml($('#board'),items.length?globalThis.AIWSI18n.template`<table class="task-list"><thead><tr><th class="list-select"><button type="button" class="column-select" data-select-column aria-pressed="false" aria-label="Tümünü seç" title="Tümünü seç">${listSelectBox}</button></th>${listSortHeader('id',globalThis.AIWSI18n.text('Görev'))}${listSortHeader('title',globalThis.AIWSI18n.text('Başlık'))}${listSortHeader('status',globalThis.AIWSI18n.text('Durum'))}${listSortHeader('milestone','Milestone')}${listSortHeader('agent',globalThis.AIWSI18n.text('Agent'))}${listSortHeader('updated',globalThis.AIWSI18n.text('Güncelleme'))}</tr></thead><tbody>${sortListTasks(items).map(taskListRow).join('')}</tbody></table>`:boardFiltered()?`<div class="empty-search">${boardNoMatchesHtml()}</div>`:globalThis.AIWSI18n.text('<div class="empty-search">Bu görünümde görev yok.</div>'));
}
document.addEventListener('click',event=>{const target=event.target.closest('button[data-sort-list]');if(target)toggleListSort(target.dataset.sortList);});
