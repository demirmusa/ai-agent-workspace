'use strict';
// Creating a project from the welcome screen and deleting the open project.
function confirmDeleteProject(){
  const current=project();if(!current)return;
  showModal(globalThis.AIWSI18n.text('Proje silinsin mi?'),globalThis.AIWSI18n.template`<form><p class="form-hint">${esc(current.name)} projesi ve yerel görev kayıtları silinir. Devam eden çalışmaları önce durdur. ${current.github?globalThis.AIWSI18n.text('GitHub issue ve Project kayıtları korunur.'):''}</p>${formFooter(globalThis.AIWSI18n.text('Projeyi sil'))}</form>`,()=>api(`/projects/${encodeURIComponent(current.id)}`,'DELETE'));
}
document.addEventListener('click',event=>{
  const action=event.target.closest('button')?.dataset.action;
  if(action==='create-project')projectModal();
  else if(action==='delete-project')confirmDeleteProject();
});
