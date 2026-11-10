'use strict';
// The All projects board: the project board's status columns, with a swimlane per project under one pinned column header.
const overviewColor=id=>[...String(id)].reduce((sum,char)=>sum+char.charCodeAt(0),0)%5+1;
const projectBadge=item=>`<span class="project-icon" data-color="${overviewColor(item.id)}" aria-hidden="true">${esc(item.name.slice(0,2).toUpperCase())}</span>`;
// The latest task update of each project, rebuilt once per received state.
const projectLatest=id=>derived('projectLatest',stateVersion,()=>{const latest=new Map();for(const task of state.tasks)if(task.updatedAt>(latest.get(task.projectId)||''))latest.set(task.projectId,task.updatedAt);return latest;}).get(id)||'';
// A totals tile, shared by the dashboard and Live sessions; given attributes it is a button (a filter) rather than a plain tile.
function statTile(dot,label,value,detail,{alert=false,attributes=''}={}){const tag=attributes?'button':'div';return `<${tag}${attributes?` type="button" ${attributes}`:''} class="overview-stat${alert?' is-alert':''}"><span class="overview-stat-label"><span class="column-dot ${dot}"></span>${label}</span><strong>${value}</strong><small>${detail}</small></${tag}>`;}
const statProviders=list=>[...new Set(list)].map(provider=>`<span class="overview-stat-provider" title="${esc(providers[provider]||provider)}">${providerIcon(provider)}</span>`).join('');
// Collapsed swimlanes are remembered in this browser.
const collapsedLanes=(()=>{try{const saved=JSON.parse(localStorage.getItem('aiws.overview-collapsed')||'[]');return new Set(Array.isArray(saved)?saved:[]);}catch{return new Set();}})();
function overviewColumnHead(column,items){
  const count=items.filter(item=>column.statuses.includes(item.status)).length;
  return globalThis.AIWSI18n.template`<div class="swimlane-head-cell"><button type="button" class="column-select" data-select-column="${column.id}" aria-pressed="false" aria-label="${esc(column.name)} sütunundaki tüm görevleri seç"><span class="column-dot ${column.id}"></span>${esc(column.name)}<span class="column-count">${count}</span></button></div>`;
}
function overviewCell(item,column,items){
  const cards=columnCards(column,items.filter(task=>column.statuses.includes(task.status)));
  return `<section class="overview-column" data-board-column="${column.id}" data-lane-column="${column.id}"${column.drop===false?'':` data-drop-status="${column.id}"`} data-drop-states="${column.statuses.join(' ')}" data-drop-project="${esc(item.id)}" aria-label="${esc(item.name)} · ${esc(column.name)}">${cards.map(card).join('')}</section>`;
}
function overviewLane(item,items){
  const t=globalThis.AIWSI18n,live=items.filter(task=>activeRun(runById(task.currentRunId))).length,latest=projectLatest(item.id),collapsed=collapsedLanes.has(item.id);
  const toggle=`<button type="button" class="swimlane-toggle" data-lane-toggle="${esc(item.id)}" aria-expanded="${!collapsed}" aria-label="${esc(item.name)} · ${esc(t.text(collapsed?'Genişlet':'Daralt'))}">${window.AIWSUI.icon('arrow-right')}</button>`;
  const meta=`${live?t.template`<span class="overview-live"><span class="ui-dot is-live" data-tone="running"></span>${live} agent çalışıyor</span>`:''}<span>${t.template`${items.length} görev`}</span>${latest?`<span>${esc(relative(latest))}</span>`:''}<button type="button" class="button small ghost" data-overview-new-task="${esc(item.id)}">+ ${esc(t.text('Görev'))}</button>`;
  return `<section class="project-board-group${collapsed?' is-collapsed':''}" data-lane="${esc(item.id)}"><header class="swimlane-row"><div class="swimlane-row-inner">${toggle}<button class="project-group-link" data-project="${esc(item.id)}" title="${esc(item.repositoryPath)}">${projectBadge(item)}<span class="project-group-name"><strong>${esc(item.name)}</strong></span></button><div class="project-group-meta">${meta}</div></div></header>${collapsed?'':`<div class="project-status-grid">${columns.map(column=>overviewCell(item,column,items)).join('')}</div>`}</section>`;
}
function renderOverview(visible){
  const t=globalThis.AIWSI18n.text;if(!state.projects.length)return t('<div class="empty-search">Başlamak için ilk projeni oluştur.</div>');
  // Every project keeps its lane; a filter or the archive narrows the board to the projects with matching tasks.
  const narrowed=Boolean(query||providerFilter)||archiveView;
  const lanes=state.projects.map(item=>[item,visible.filter(task=>task.projectId===item.id)]).filter(([,items])=>!narrowed||items.length).map(([item,items])=>overviewLane(item,items)).join('');
  if(!lanes)return `<div class="empty-search">${esc(t(query||providerFilter?'Filtreye uyan görev yok.':'Arşivde görev yok.'))}</div>`;
  return `<div class="swimlane-board"><div class="swimlane-head">${columns.map(column=>overviewColumnHead(column,visible)).join('')}</div>${lanes}</div>`;
}
document.addEventListener('click',event=>{
  const toggle=event.target.closest('button[data-lane-toggle]');
  if(toggle){const id=toggle.dataset.laneToggle;if(collapsedLanes.has(id))collapsedLanes.delete(id);else collapsedLanes.add(id);try{localStorage.setItem('aiws.overview-collapsed',JSON.stringify([...collapsedLanes]));}catch{/* Storage may be disabled; the choice then lasts for this page. */}renderBoard();return;}
  const target=event.target.closest('button[data-overview-new-task]');if(!target)return;projectId=target.dataset.overviewNewTask;localStorage.setItem('aiws.project',projectId);taskModal();
});
