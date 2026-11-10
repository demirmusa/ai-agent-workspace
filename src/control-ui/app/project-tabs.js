'use strict';
// Project view tabs.
const projectTabs=['board','editor','terminal','schedules','sessions','settings'];
// The editor tab exists only while the project has files open in it.
function projectTab(){const tab=projectId?localStorage.getItem(`aiws.project-tab.${projectId}`):null;if(tab==='settings'&&isGeneralProject(projectId)||tab==='editor'&&!projectEditor()?.hasFiles())return 'board';return projectTabs.includes(tab)||window.AIWSPlugins?.hasProjectTab(tab)?tab:'board';}
for(const tab of projectTabs)$(`#project-tab-${tab}`).onclick=()=>{localStorage.setItem(`aiws.project-tab.${projectId}`,tab);selectedTaskId=null;selectedHistory=null;render();};
// The All projects tabs share the tab bar; the choice is remembered in this browser.
const overviewTabs=['board','sessions','terminal'];
function overviewTab(){let tab=null;try{tab=localStorage.getItem('aiws.overview-tab');}catch{/* Storage may be disabled. */}return overviewTabs.includes(tab)?tab:'board';}
function showOverviewTab(tab){storeSessionValue('aiws.overview-tab',tab);if(activeScreen!=='overview')resetBoardFilters();activeScreen='overview';selectedTaskId=null;selectedHistory=null;render();}
for(const tab of overviewTabs)$(`#overview-tab-${tab}`).onclick=()=>showOverviewTab(tab);
document.addEventListener('click',event=>{const target=event.target.closest('button[data-overview-tab]');if(target)showOverviewTab(target.dataset.overviewTab);});
$('#project-view-tabs').onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const tabs=$$('#project-view-tabs [role=tab]').filter(tab=>!tab.closest('[hidden]')),index=tabs.indexOf(document.activeElement),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].focus();tabs[next].click();};
