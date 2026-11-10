'use strict';
// The project Terminal tab.
function renderProjectTerminal(){const current=project();if(!current)return;const entry=shellEntry(current.id),board=$('#board');board.className='board project-terminal-board';if(entry.element.parentElement!==board)board.replaceChildren(entry.element);if(!terminalAgents.items&&!terminalAgents.loading)void loadTerminalAgents();updateShell(current.id);if(!entry.loaded)void loadProjectShells(current.id);}
// Shortcuts work everywhere on a Terminal tab, including inside a focused terminal.
function visibleTerminalWorkspace(){
  if(projectId&&terminalVisible(projectId)){const entry=projectShells.get(projectId);return entry&&{entry,open:(spec,placement)=>openProjectTerminal(projectId,spec,placement),close:runId=>closeProjectTerminal(projectId,runId)};}
  return allTerminalsVisible()?{entry:sessionTerminals(),open:openAllProjectTerminal,close:closeSessionTerminal}:null;
}
document.addEventListener('keydown',event=>{
  if($('#modal').open||event.target.closest?.('.terminal-rename'))return;
  const workspace=visibleTerminalWorkspace();if(!workspace)return;
  const {entry}=workspace,key=event.key.toLowerCase(),ids=layoutIds(entry.layout);
  let handled=true;
  if(event.ctrlKey&&event.shiftKey&&!event.altKey&&(key==='t'||event.code==='Backquote'))void workspace.open({kind:'shell'});
  else if(event.ctrlKey&&event.shiftKey&&!event.altKey&&key==='w'&&entry.selected)void workspace.close(entry.selected);
  else if(event.ctrlKey&&!event.shiftKey&&!event.altKey&&['pageup','pagedown'].includes(key)&&ids.length>1){const index=ids.indexOf(entry.selected);selectTerminal(entry,ids[(index+(key==='pagedown'?1:-1)+ids.length)%ids.length],{focus:true});}
  // Alt+Shift+D opens a new shell to the right of the focused terminal.
  else if(event.altKey&&event.shiftKey&&!event.ctrlKey&&key==='d')void workspace.open({kind:'shell'},{target:entry.selected,side:'right'});
  else handled=false;
  if(handled){event.preventDefault();event.stopPropagation();}
},true);
// Output streams live and exits are pushed; this only reconciles shells opened elsewhere. A deleted project's terminal views are released.
const projectShellTimer=setInterval(()=>{if(document.hidden)return;for(const [id,entry] of projectShells)if(state.projects.length&&!state.projects.some(item=>item.id===id)&&!isGeneralProject(id)){for(const pane of entry.views.values())pane.view?.destroy();projectShells.delete(id);}else if(activeScreen==='board'&&id===projectId&&projectTab()==='terminal'||allTerminalsVisible()||workspaceHasFloatingConsole(entry))void loadProjectShells(id);},5000);
window.addEventListener('pagehide',()=>{clearInterval(projectShellTimer);for(const entry of projectShells.values())for(const pane of entry.views.values())pane.view?.destroy();});
