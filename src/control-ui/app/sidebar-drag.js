'use strict';
// Reordering projects in the sidebar by dragging them. Dropping on the archive header archives a project; dropping beside a project
// moves it into that project's group, archived or not, at that place.
let draggedProject=null;
const projectDropSelector='#project-list [data-project], #project-archive-toggle';
function projectDropTarget(event){return event.target.closest?.(projectDropSelector);}
function clearProjectDropMarks(...classes){for(const element of $$(classes.map(name=>`#project-list .${name}`).join(', ')))element.classList.remove(...classes);}
// The archive header takes the project as a whole; a project row takes it above or below itself.
function projectDropPlace(target,event){if(!target.dataset.project)return 'into';const box=target.getBoundingClientRect();return event.clientY>box.top+box.height/2?'after':'before';}
document.addEventListener('dragstart',event=>{const item=event.target.closest?.('#project-list [data-project]');if(!item)return;draggedProject=item.dataset.project;event.dataTransfer.setData('text/plain',draggedProject);event.dataTransfer.effectAllowed='move';item.classList.add('dragging');});
document.addEventListener('dragover',event=>{const target=projectDropTarget(event);if(!draggedProject||!target)return;event.preventDefault();clearProjectDropMarks('drop-before','drop-after','drop-into');if(target.dataset.project!==draggedProject)target.classList.add(`drop-${projectDropPlace(target,event)}`);});
document.addEventListener('dragend',()=>{draggedProject=null;clearProjectDropMarks('dragging','drop-before','drop-after','drop-into');});
document.addEventListener('drop',async event=>{
  const target=projectDropTarget(event);if(!draggedProject||!target)return;event.preventDefault();
  const moved=draggedProject,place=projectDropPlace(target,event),before=state.projects.map(item=>item.id),ids=before.filter(id=>id!==moved);draggedProject=null;
  // Dropping on the archive header only archives; the server order changes only when the project moves within the list.
  if(place==='into'){setProjectArchived(moved,true);render();return;}
  const at=ids.indexOf(target.dataset.project);if(at<0)return;ids.splice(at+(place==='after'?1:0),0,moved);
  if(isProjectArchived(target.dataset.project)!==isProjectArchived(moved))setProjectArchived(moved,isProjectArchived(target.dataset.project));
  if(ids.join()===before.join()){render();return;}
  const byId=new Map(state.projects.map(item=>[item.id,item]));state.projects=ids.map(id=>byId.get(id));render();
  try{await api('/projects/reorder','POST',{projectIds:ids});}catch(error){toast(error.message||String(error));void refresh();}
});
