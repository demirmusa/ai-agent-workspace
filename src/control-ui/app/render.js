'use strict';
// The top-level render: draws every part of the shell for the current state, at most once per frame for server pushes.
function renderScreen(current){
  if(['agents','skills'].includes(activeScreen)){$('#run-control').hidden=true;renderLibrary();return;}
  renderRunControl(current);
  if(current||activeScreen==='settings'||window.AIWSPlugins?.isPage(activeScreen))renderBoard();
  else{if($('#board').className!=='board')$('#board').className='board';setHtml($('#board'),welcomeHtml());}
  renderDetail();
}
function syncTaskPanelShell(){
  const panel=$('#task-panel'),detailVisible=Boolean(task()||selectedHistory)&&!panel.hidden;
  panel.setAttribute('role','dialog');panel.setAttribute('aria-modal',String(detailVisible&&!childAgentSelection));panel.setAttribute('aria-labelledby','task-detail-title');
  if(!detailVisible)sessionFullscreen=false;document.querySelector('.app-shell').classList.toggle('session-fullscreen',sessionFullscreen);
  if(!detailVisible||sessionFullscreen)finishDetailResize();applyDetailWidth();
}
function render() {
  cancelScheduledRender();lastRenderAt=performance.now();
  if(workspaceHasFloatingConsole(sessionWorkspace))updateSessionTerminals();
  for(const [key,view] of consoleViews)if(key.startsWith('task:')&&floatingConsoles.has(view.element)){const item=state.tasks.find(item=>key===`task:${item.id}`);if(item)mountTaskConsole(item,view.element.parentElement);}
  const navFrom=sidebarNavFrom();renderingShell=true;
  try{
    renderSystemControl();
    syncGitProject();
    const current=project();
    for(const item of state.projects)prefetchProjectShells(item.id);
    renderBoardToolbar(current);
    renderSidebar();
    renderRunStatus();
    renderScreen(current);
    renderNotifications();
    syncTaskPanelShell();
    updateSessionCounts();
    const historyActive=activeScreen==='board'&&Boolean(current)&&['editor','sessions','terminal','settings','schedules'].includes(projectTab());
    $('#ai-create-task').hidden=!isTaskBoardPage()&&activeScreen!=='board'||!current||historyActive;updateAITab();syncAISheet();
    renderProjectTabBar();renderFilesPanel();
    if(activeScreen==='board'&&current){if(projectTab()!=='terminal')ensureProjectSessions(current);prefetchProjectShells(projectId);}
    renderPageChrome(current);
    syncBoardSelection();
    refreshRunTimers();
    window.AIWSPlugins?.renderShell();
  }finally{renderingShell=false;}
  commitPageHeader();placeProjectTabIndicator();moveSidebarNavMark(navFrom);
}
// Server pushes can arrive many times per second while agents work. Scheduled renders draw at most once per frame and at
// least scheduledRenderGap after the previous render, so a busy stream never keeps the main thread drawing; actions call
// render() directly and are never delayed.
const scheduledRenderGap=100;
let renderFrame=null,renderTimer=null,lastRenderAt=-Infinity;
function queueRenderFrame(){renderFrame=typeof requestAnimationFrame==='function'?requestAnimationFrame(()=>{renderFrame=null;render();}):setTimeout(()=>{renderFrame=null;render();},16);}
function scheduleRender(){if(renderFrame!==null||renderTimer!==null)return;const wait=lastRenderAt+scheduledRenderGap-performance.now();if(wait>16){renderTimer=setTimeout(()=>{renderTimer=null;queueRenderFrame();},wait-16);return;}queueRenderFrame();}
function cancelScheduledRender(){clearTimeout(renderTimer);renderTimer=null;if(renderFrame===null)return;if(typeof cancelAnimationFrame==='function')cancelAnimationFrame(renderFrame);clearTimeout(renderFrame);renderFrame=null;}
window.addEventListener('pagehide',cancelScheduledRender);
// Clocks and relative times went stale while the page was hidden.
document.addEventListener('visibilitychange',()=>{if(!document.hidden)scheduleRender();});
