'use strict';
// The #board area: routes it to the page or view that fills it and keeps each column's scroll position across renders.
let boardScrollContext='';
const boardPageClasses=['session-board','workflow-board','project-sessions-board','project-terminal-board','project-editor-board','project-settings-board','settings-board','schedules-board','session-terminal-board','dashboard-board'];
/** Renders the task views: the overview, the timeline, the list or the status columns. */
function renderTaskViews(){
  const board=$('#board'),timeline=view==='timeline'&&window.AIWSTimeline,overview=activeScreen==='overview',list=view==='list'&&!timeline;
  board.classList.toggle('overview-board',overview&&!timeline&&!list);board.classList.remove(...boardPageClasses);
  if(timeline){renderTimeline();return;}
  const items=filteredBoardTasks();
  if(list)renderTaskList(items);
  else if(overview)setHtml(board,renderOverview(items));
  else renderBoardColumns(items);
}
function renderBoardPage(){
  const tab=activeScreen==='board'?projectTab():'';
  if(tab==='editor'){renderProjectEditor();return;}
  if(tab==='terminal'){renderProjectTerminal();return;}
  if(tab==='sessions'){renderProjectSessions();return;}
  if(tab==='settings'){renderProjectSettings();return;}
  if(tab==='schedules'){renderProjectSchedules();return;}
  if(activeScreen==='overview'&&overviewTab()==='sessions'){renderSessions();return;}if(activeScreen==='overview'&&overviewTab()==='terminal'){renderAllTerminals();return;}if(activeScreen==='dashboard'){renderDashboard();return;}if(activeScreen==='workflows'){renderWorkflows();return;}if(activeScreen==='settings'){renderSettingsPage();return;}
  // Plugin pages and project tabs render into the board through the plugin host (plugins.js), which marks the board while they show.
  $('#board').classList.remove('plugin-page-board');
  if(window.AIWSPlugins?.isPage(activeScreen)){window.AIWSPlugins.renderPage($('#board'),activeScreen);return;}
  if(tab.startsWith('plugin:')){window.AIWSPlugins?.renderProjectTab($('#board'),tab,project());return;}
  // Replacing the source card would cancel a running drag; the board renders once the drag ends.
  if(draggedIds.length){boardRenderDeferred=true;return;}
  renderTaskViews();
}
function renderBoard() {
  const scrollContext=[activeScreen,overviewTab(),projectId,projectTab(),view,archiveView].join('\u0000');
  const scrollKey=element=>[element.dataset.boardColumn,element.dataset.dropProject,element.dataset.dropStatus].join('\u0000');
  const columnSelector='[data-board-column],.overview-column';
  // Replacing card markup also replaces the scrollable columns, including when only selection changes.
  const columnScroll=new Map(boardScrollContext===scrollContext?[...$('#board').querySelectorAll(columnSelector)].map(element=>[scrollKey(element),[element.scrollLeft,element.scrollTop]]):[]);
  boardScrollContext=scrollContext;
  try{renderBoardPage();}
  finally{
    syncBoardSelection();
    if(columnScroll.size)for(const element of $('#board').querySelectorAll(columnSelector)){
      const position=columnScroll.get(scrollKey(element));
      if(position){element.scrollLeft=position[0];element.scrollTop=position[1];}
    }
  }
}
