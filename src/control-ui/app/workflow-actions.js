'use strict';
// Creating, editing and deleting workflows from the workflows page and the workflow editor.
document.addEventListener('click',event=>{
  const target=event.target.closest('button');if(!target)return;
  if(target.dataset.deleteWorkflow){const id=target.dataset.deleteWorkflow;showModal(globalThis.AIWSI18n.text('İş akışı silinsin mi?'),globalThis.AIWSI18n.template`<form><p class="form-hint">Kullanımdaki iş akışları sunucu tarafından korunur.</p>${formFooter(globalThis.AIWSI18n.text('İş akışını sil'))}</form>`,()=>api(`/workflows/${encodeURIComponent(id)}`,'DELETE'));}
  if(target.dataset.action==='new-workflow')workflowModal();
  if(target.dataset.editWorkflow)workflowModal(target.dataset.editWorkflow);
});
