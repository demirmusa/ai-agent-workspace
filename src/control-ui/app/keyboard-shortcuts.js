'use strict';
// App-wide keyboard shortcuts: Escape clears the search, the selection or closes the panel, / searches, N creates a task, Enter opens a card.
document.addEventListener('keydown',event=>{
  if(event.defaultPrevented||event.target.closest('.terminal-instance'))return;
  const editable=['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)||event.target.isContentEditable,modalOpen=$('#modal').open;
  // Escape in a filled board search clears the search first.
  if(event.key==='Escape'&&event.target.id==='search'&&event.target.value){event.preventDefault();event.target.value='';query='';renderBoard();return;}
  if(event.key==='Escape'&&!modalOpen&&!task()&&!selectedHistory&&selectedBoardTasks.size){event.preventDefault();clearBoardSelection();return;}
  if(event.key==='Escape'&&!modalOpen){event.preventDefault();if(childAgentSelection)closeChildAgent();else if(agentScreen)closeAgentScreen();else closePanel();}
  if(editable||modalOpen)return;
  // / and N work wherever the task board shows (a project board or the overview); / leaves the key alone when no search is shown.
  const search=activeScreen==='board'&&projectTab()==='sessions'?$('#history-search'):isTaskBoardPage()?$('#search'):null;
  if(event.key==='/'&&search&&!search.closest('[hidden]')){event.preventDefault();search.focus();}
  if(event.key.toLowerCase()==='n'&&project()&&isTaskBoardPage()){event.preventDefault();taskModal();}
  if(['Enter',' '].includes(event.key)&&event.target.matches('#board [data-open-task][role=button]:not(.organize-locked)')){event.preventDefault();if(event.ctrlKey||event.metaKey||event.shiftKey)selectBoardTask(event.target.dataset.openTask,event);else openTask(event.target.dataset.openTask);}
});
