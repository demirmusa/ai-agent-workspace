'use strict';
// The board toolbar: view tabs, archive toggle, search, agent and milestone filters and GitHub sync.
// The toolbar's view tabs (#board-view, #list-view, #timeline-view); the choice is remembered on this device.
const boardViews=['board','list','timeline'];
function renderProviderFilter(){
  const select=document.querySelector('#provider-filter');if(!select)return;const selected=select.value;
  select.innerHTML=`<option value="">${esc(globalThis.AIWSI18n.text('Tüm agentlar'))}</option>${Object.entries(providers).map(([value,label])=>`<option value="${esc(value)}">${esc(value==='command'?globalThis.AIWSI18n.text('Komut'):label)}</option>`).join('')}`;
  select.value=Object.hasOwn(providers,selected)?selected:'';
}
/** Clears the board filters; the next board render picks the project's current milestone again unless showAll keeps every milestone shown. */
function resetBoardFilters({showAll=false}={}){query='';providerFilter='';milestoneFilter='';milestoneFilterProject=showAll?projectId:null;const search=$('#search'),provider=$('#provider-filter'),milestone=$('#milestone-filter');if(search)search.value='';if(provider)provider.value='';if(milestone)milestone.value='';}
// The milestone filter lists the project's milestones and starts on the current one when a board opens; a milestone that no longer exists drops out of the filter.
function renderMilestoneFilter(current){
  const select=$('#milestone-filter');if(!select)return;const milestones=activeScreen==='board'&&current?projectMilestones(current.id):[];select.hidden=!milestones.length;
  if(activeScreen==='board'&&current&&milestoneFilterProject!==current.id){milestoneFilterProject=current.id;milestoneFilter=currentMilestoneId(current.id);}
  if(milestoneFilter&&milestoneFilter!=='none'&&!milestones.some(value=>value.id===milestoneFilter))milestoneFilter='';
  const t=globalThis.AIWSI18n.text,html=milestoneOptionsHtml(current?.id,milestoneFilter,[['',t('Tüm milestone’lar')],['none',t('Milestone yok')]]);
  if(select.dataset.html!==html){select.innerHTML=html;select.dataset.html=html;}select.value=milestoneFilter;
}
// An empty column or list under a search or agent filter says nothing matched and offers to clear the filters.
const boardFiltered=()=>Boolean(query||providerFilter||activeScreen==='board'&&milestoneFilter);
const boardNoMatchesHtml=()=>globalThis.AIWSI18n.text('Eşleşen görev yok <button type="button" class="button small ghost" data-clear-board-filters>Filtreleri temizle</button>');
document.addEventListener('click',event=>{if(!event.target.closest('button[data-clear-board-filters]'))return;resetBoardFilters({showAll:true});renderBoard();$('#search')?.focus();});
function renderBoardToolbar(current){
  $('#board-toolbar').hidden=!isTaskBoardPage()||(activeScreen==='board'&&!current);
  renderMilestoneFilter(current);
  $('#sync-button').hidden=!current?.github; $('#sync-status').hidden=!current?.github; if(current){const sync=syncStatus(current);$('#sync-status').textContent=sync.text;$('#sync-status').title=sync.title;}
  // A saved timeline view shows the board when the timeline script is unavailable.
  const shownView=view==='timeline'&&!window.AIWSTimeline?'board':view;$('#timeline-view').hidden=!window.AIWSTimeline;
  for(const name of boardViews){const tab=$(`#${name}-view`);tab.classList.toggle('active',shownView===name);tab.setAttribute('aria-pressed',String(shownView===name));}
}
for(const name of boardViews)$(`#${name}-view`).onclick=()=>{view=name;try{localStorage.setItem('aiws.view',view);}catch{/* Storage may be disabled. */}render();};
$('#archive-view').onclick=()=>{if(bulkMoveBusy)return;archiveView=!archiveView;render();};
$('#search').oninput=event=>{query=event.target.value;renderBoard();}; $('#provider-filter').onchange=event=>{providerFilter=event.target.value;renderBoard();}; $('#milestone-filter').onchange=event=>{milestoneFilter=event.target.value;renderBoard();};
$('#sync-button').onclick=()=>void syncProject($('#sync-button'));
