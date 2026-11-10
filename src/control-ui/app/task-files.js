'use strict';
// Files attached to task cards.
const clipIcon='<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 4.5l-5 5a1.5 1.5 0 002 2l5.5-5.5a3 3 0 00-4-4L3.5 7.5a4.5 4.5 0 006.5 6.5l4-4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
/** Files dropped onto a card from the files panel; each chip shows the name and can be detached. */
function cardFiles(item){return `<div class="card-files" aria-label="${esc(globalThis.AIWSI18n.text('Ekli dosyalar'))}">${item.attachedFiles.map(path=>{const name=path.replace(/\/$/,'').split('/').pop()+(path.endsWith('/')?'/':'');return `<span class="card-file" title="${esc(path)}">${clipIcon}<span class="card-file-name">${esc(name)}</span><button type="button" class="card-file-remove" data-detach-file="${esc(path)}" data-file-task="${esc(item.id)}" title="${esc(globalThis.AIWSI18n.text('Dosyayı görevden çıkar'))}" aria-label="${esc(globalThis.AIWSI18n.text('Dosyayı görevden çıkar'))}: ${esc(path)}">×</button></span>`;}).join('')}</div>`;}
async function setTaskFiles(id,files,message){await mutate(`/tasks/${id}`,'PATCH',{attachedFiles:files},message);}
async function attachTaskFile(id,path){
  const item=state.tasks.find(value=>value.id===id),files=item?.attachedFiles||[];if(!item||!path)return;
  if(files.includes(path)){toast(globalThis.AIWSI18n.text('Dosya bu göreve zaten ekli.'));return;}
  if(files.length>=50){error(globalThis.AIWSI18n.text('Bir göreve en fazla 50 dosya eklenebilir.'));return;}
  await setTaskFiles(id,[...files,path],globalThis.AIWSI18n.text('Dosya göreve eklendi'));
}
document.addEventListener('click',event=>{
  const target=event.target.closest('button[data-detach-file]');if(!target)return;event.preventDefault();
  const item=state.tasks.find(value=>value.id===target.dataset.fileTask);
  if(item)void setTaskFiles(item.id,(item.attachedFiles||[]).filter(path=>path!==target.dataset.detachFile),globalThis.AIWSI18n.text('Dosya görevden çıkarıldı'));
});
