'use strict';
// Actions on the open task: run controls, status, archive, move, delete, fork, the run prompt and the detail tabs.
const runActionMessages={restart:'Görev yeniden başlatıldı',start:'Agent başlatıldı',pause:'Duraklatma isteği gönderildi',resume:'Agent devam ediyor',stop:'Durdurma isteği gönderildi'};
async function runTaskAction(button){
  const action=button.dataset.runAction,item=task(),runId=item?.currentRunId;if(!item)return;
  button.disabled=true;button.classList.add('is-busy');button.setAttribute('aria-busy','true');
  const path=action==='start'||action==='restart'?`/tasks/${encodeURIComponent(item.id)}/${action==='start'?'run':'restart'}`:`/runs/${encodeURIComponent(runId)}/${action}`;
  await mutate(path,'POST',{},globalThis.AIWSI18n.text(runActionMessages[action]||runActionMessages.stop));
  button.disabled=false;button.classList.remove('is-busy');button.removeAttribute('aria-busy');
}
// After a delete, focus moves to the card beside the deleted one (the button that opened the dialog is gone).
function confirmDeleteTask(){
  const item=task();if(!item)return;
  const cards=visibleBoardTaskIds(),index=cards.indexOf(item.id),neighbour=cards[index+1]??cards[index-1];
  // A task linked to an issue of this project offers to delete the issue too; checked by default.
  const issue=item.github&&!item.externalDependency?globalThis.AIWSI18n.template`<label class="checkbox-field"><input type="checkbox" name="deleteIssue" checked> GitHub issue'sunu da sil (#${esc(item.github.issueNumber)})</label><p class="form-hint">${globalThis.AIWSI18n.text('İşaretli değilse GitHub issue korunur ve aynı bağlantıda tekrar içe aktarılmaz.')}</p>`:'';
  showModal(globalThis.AIWSI18n.text('Görev silinsin mi?'),globalThis.AIWSI18n.template`<form><p class="form-hint">${esc(item.title)} görevinin yerel kaydı silinir. Aktif çalışma varsa önce Durdur düğmesini kullan. Bu görevi Blocked by olarak kullanan işlerden bağlantıyı kaldır.</p>${issue}${formFooter(globalThis.AIWSI18n.text('Görevi sil'))}</form>`,async data=>{const session=modalSession;await api(`/tasks/${encodeURIComponent(item.id)}${data.get('deleteIssue')?'?deleteIssue=true':''}`,'DELETE');if(selectedTaskId===item.id)selectedTaskId=null;await refresh();session.returnFocus=(neighbour&&document.querySelector(`#board [data-open-task="${CSS.escape(neighbour)}"]`))||document.querySelector('#board [data-open-task]')||$('#create-task');session.returnAttributes=[];});
}
function forkTaskModal(){
  const source=task();if(!source)return;
  showModal(globalThis.AIWSI18n.text('Geçmişten yeni agent'),globalThis.AIWSI18n.template`<form><p class="form-hint">Bu görevin kaydedilmiş sohbet geçmişiyle bağımsız bir görev oluşturulur. Yeni görevi başlattığında agent çalışır.</p><label class="form-field">Yeni talimat<textarea name="text" required rows="4"></textarea></label>${formFooter(globalThis.AIWSI18n.text('Fork oluştur'))}</form>`,async data=>{const fork=await api(`/tasks/${encodeURIComponent(source.id)}/fork`,'POST',{text:String(data.get('text')).trim()});selectedTaskId=fork.id;detailTab='console';await refresh();});
}
async function archiveOpenTask(button){
  const item=task();if(!item||button.disabled)return;button.disabled=true;
  try{await api('/tasks/archive','POST',{taskIds:[item.id],archived:true});toast(globalThis.AIWSI18n.text('Görev arşivlendi'),undoAction(()=>api('/tasks/archive','POST',{taskIds:[item.id],archived:false})));await refresh();}catch(problem){button.disabled=false;error(problem.message);}
}
async function showRunPrompt(runId){try{const prompt=await api(`/runs/${encodeURIComponent(runId)}/prompt`);showModal(globalThis.AIWSI18n.text('Agenta verilen talimat'),`<div class="template-preview run-prompt-preview"><pre>${esc(prompt.text)}</pre></div>`,undefined,{size:'wide',description:prompt.path});}catch(cause){error(`${globalThis.AIWSI18n.text('Talimat dosyası açılamadı')}: ${cause.message}`);}}
document.addEventListener('click',event=>{
  const target=event.target.closest('button');
  // A choice in the detail "more" menu, or a click elsewhere, closes the menu.
  for(const menu of document.querySelectorAll('.detail-more[open]'))if(!menu.contains(event.target)||event.target.closest('.detail-more-menu button'))menu.open=false;
  if(!target)return;
  if(target.dataset.runAction){void runTaskAction(target);return;}
  if(target.dataset.runPrompt){event.preventDefault();void showRunPrompt(target.dataset.runPrompt);return;}
  if(target.hasAttribute('data-archive-task')){void archiveOpenTask(target);return;}
  if(target.dataset.moveTask){const item=task();if(item&&!target.disabled)void moveBoardTasks([item.id],target.dataset.moveTask);return;}
  const tab=target.dataset.detailTab;
  if((['info','console','terminal'].includes(tab)||tab?.startsWith('plugin:'))&&!target.disabled){detailTab=tab;renderDetail();return;}
  if(target.hasAttribute('data-history-continue')&&selectedHistory){void resumeHistorySession(selectedHistory.projectId,selectedHistory.session);return;}
  const action=target.dataset.action;
  if(action==='fullscreen-session'){sessionFullscreen=!sessionFullscreen;render();}
  else if(action==='delete-task')confirmDeleteTask();
  else if(action==='fork-task')forkTaskModal();
});
// The status select saves like the other detail fields; a refused change puts the select back to the task's status.
document.addEventListener('change',event=>{
  const select=event.target,item=task();if(select.id!=='detail-status'||!item)return;
  if(select.value==='running')void mutate(`/tasks/${encodeURIComponent(item.id)}/run`,'POST',{},globalThis.AIWSI18n.text('Agent başlatıldı')).then(result=>{if(result===undefined&&select.isConnected)select.value=task()?.status??item.status;});
  else void saveTaskField(item,{status:select.value}).then(saved=>{if(!saved&&select.isConnected)select.value=task()?.status??item.status;});
});
