'use strict';
// The sidebar's archive: a collapsible group under the projects that only this browser remembers. Archiving changes where a project
// is listed and nothing else; the project, its tasks and the server never learn about it.
const projectArchiveKey='aiws.project-archive',projectArchiveCollapsedKey='aiws.project-archive-collapsed';
const archivedProjects=(()=>{try{const saved=JSON.parse(localStorage.getItem(projectArchiveKey)||'[]');return new Set(Array.isArray(saved)?saved.filter(id=>typeof id==='string'):[]);}catch{return new Set();}})();
let projectArchiveCollapsed=(()=>{try{return localStorage.getItem(projectArchiveCollapsedKey)!=='false';}catch{return true;}})();
function isProjectArchived(id){return archivedProjects.has(id);}
// Moves a project in or out of the archive; ids of projects that no longer exist are dropped on the way.
function setProjectArchived(id,archived){
  if(archived)archivedProjects.add(id);else archivedProjects.delete(id);
  const known=new Set(state.projects.map(item=>item.id));for(const entry of archivedProjects)if(!known.has(entry))archivedProjects.delete(entry);
  try{localStorage.setItem(projectArchiveKey,JSON.stringify([...archivedProjects]));}catch{/* Storage may be disabled; the archive then lasts for this page. */}
}
function toggleProjectArchive(){projectArchiveCollapsed=!projectArchiveCollapsed;try{localStorage.setItem(projectArchiveCollapsedKey,String(projectArchiveCollapsed));}catch{/* Storage may be disabled. */}renderSidebar();}
// The archive header doubles as the drop target for archiving; its list keeps the projects in the same order as the main list.
function projectArchiveHtml(items){
  const t=globalThis.AIWSI18n,ui=window.AIWSUI,label=t.text('Arşiv');
  return `<div class="project-archive"><button type="button" class="nav-item project-archive-toggle" id="project-archive-toggle" aria-expanded="${!projectArchiveCollapsed}" aria-controls="project-archive-list" title="${esc(t.text(projectArchiveCollapsed?'Genişlet':'Daralt'))}"><span class="nav-icon" aria-hidden="true">${ui.icon('archive')}</span><span class="nav-label">${esc(label)}</span><span class="nav-count">${items.length}</span><span class="project-archive-chevron" aria-hidden="true">${ui.icon('chevron')}</span></button><div class="project-archive-list" id="project-archive-list" role="group" aria-label="${esc(label)}"${projectArchiveCollapsed?' hidden':''}>${items.join('')}</div></div>`;
}
document.addEventListener('click',event=>{if(event.target.closest?.('#project-archive-toggle'))toggleProjectArchive();});
