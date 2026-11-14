'use strict';
// The project Editor tab: files clicked in the files panel open in the content area, in the Monaco editor of files/editor.js.
// One editor per project folder keeps its open files and their unsaved changes while switching tabs and projects.
const projectEditors=new Map();
/** A project's folder; a project moved to another folder gets a fresh explorer and editor. */
const projectFolderKey=current=>`${current.id}|${current.repositoryPath}`;
function projectEditor(current=project()){return current?projectEditors.get(projectFolderKey(current)):undefined;}
function renderProjectEditor(){
  const view=projectEditor(),board=$('#board');if(!view)return;
  board.className='board project-editor-board';
  if(view.element.parentElement!==board){board.replaceChildren(view.element);view.show();}
}
/** Opens a project-relative file in the current project's editor and shows the Editor tab. An open dialog keeps the page behind it as it is. */
function openProjectFile(path){
  const current=project();if(!current||$('#modal').open)return;
  let view=projectEditor(current);
  if(!view){view=window.AIWSFiles.createEditor({projectId:current.id,api,toast,error,confirm:confirmModal,onChange:scheduleRender,onReveal:path=>revealProjectFile(current,path)});projectEditors.set(projectFolderKey(current),view);}
  void view.open(path);
  localStorage.setItem(`aiws.project-tab.${current.id}`,'editor');selectedTaskId=null;selectedHistory=null;render();
}
/** Opens the files panel on the project's file and selects it there. */
function revealProjectFile(current,path){if(!filesPanelOpen())setFilesPanel(true);void projectFileViews.get(projectFolderKey(current))?.reveal(path);}
// Leaving the page would drop unsaved editor changes, so the browser asks first.
window.addEventListener('beforeunload',event=>{if([...projectEditors.values()].some(view=>view.hasUnsaved()))event.preventDefault();});
