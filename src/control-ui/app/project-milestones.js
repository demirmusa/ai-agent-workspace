'use strict';
// Project milestones editor: GitHub's milestone list with progress, due dates, open and closed tabs and the current milestone.
let milestoneEditing=null,milestoneTab='open';
function renderProjectMilestones(current){
  const list=$('#project-milestones-list');if(!list||list.contains(document.activeElement)&&document.activeElement.matches('input,textarea'))return;
  const t=globalThis.AIWSI18n.text,tt=globalThis.AIWSI18n.template,all=sortedMilestones(current.milestones||[]),counts=milestoneCounts(current.id),currentId=currentMilestoneId(current.id);
  const open=all.filter(value=>value.state==='open'),closed=all.filter(value=>value.state==='closed'),shown=milestoneTab==='closed'?closed:open;
  for(const button of $$('[data-milestone-tab]')){const active=button.dataset.milestoneTab===milestoneTab;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));}
  setHtml($('#project-milestones-open-count'),esc(String(open.length)));setHtml($('#project-milestones-closed-count'),esc(String(closed.length)));
  setHtml($('#project-milestones-github'),current.github?`<small class="form-hint">${esc(t('GitHub eşitlemesi milestone’ları ve görevlerin milestone’unu depoyla iki yönlü eşitler.'))}</small>`:`<small class="form-hint">${esc(t('GitHub’a bağlanınca milestone’lar depodaki milestone’larla eşitlenir.'))}</small>`);
  const row=milestone=>{
    if(milestoneEditing===milestone.id)return `<div class="milestone-row is-editing" data-milestone-row="${esc(milestone.id)}"><div class="milestone-form"><input data-milestone-edit-title maxlength="255" value="${esc(milestone.title)}" aria-label="${esc(t('Milestone başlığı'))}" autocomplete="off"><input type="date" data-milestone-edit-due value="${esc(milestone.dueOn||'')}" aria-label="${esc(t('Son tarih'))}"><textarea data-milestone-edit-description rows="2" maxlength="10000" placeholder="${esc(t('Açıklama (isteğe bağlı)'))}" aria-label="${esc(t('Milestone açıklaması'))}">${esc(milestone.description)}</textarea><div class="milestone-form-actions"><button type="button" class="button small primary" data-milestone-save>${esc(t('Kaydet'))}</button><button type="button" class="button small ghost" data-milestone-cancel>${esc(t('Vazgeç'))}</button></div></div></div>`;
    const progress=counts(milestone.id),isCurrent=milestone.id===currentId;
    return `<div class="milestone-row${isCurrent?' is-current':''}" data-milestone-row="${esc(milestone.id)}"><div class="milestone-main"><div class="milestone-heading"><strong class="milestone-title">${pageIcon('milestone')}<span>${esc(milestone.title)}</span></strong>${isCurrent?`<span class="milestone-current-badge">${esc(t('Geçerli'))}</span>`:''}${milestone.github?.url?`<a class="help-link" href="${esc(safeLink(milestone.github.url))}" target="_blank" rel="noreferrer">GitHub ↗</a>`:''}</div><small class="milestone-due${milestoneOverdue(milestone)?' is-overdue':''}">${esc(milestoneDueText(milestone))}</small>${milestone.description?`<p class="milestone-description">${esc(milestone.description)}</p>`:''}</div><div class="milestone-progress"><div class="milestone-bar" style="--milestone-progress:${progress.percent}%" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.percent}" aria-label="${esc(t('Tamamlanma'))}"><span></span></div><small>${esc(tt`${progress.percent}% tamamlandı · Açık görev: ${progress.open} · Kapalı görev: ${progress.closed}`)}</small></div><div class="milestone-actions"><button type="button" class="button small ghost" data-milestone-show ${progress.total?'':'disabled'}>${esc(t('Görevleri göster'))}</button>${milestone.state==='open'?`<button type="button" class="button small ghost" data-milestone-current>${esc(isCurrent?t('Geçerliyi kaldır'):t('Geçerli yap'))}</button>`:''}<button type="button" class="button small ghost" data-milestone-edit>${esc(t('Düzenle'))}</button><button type="button" class="button small ghost" data-milestone-toggle>${esc(milestone.state==='open'?t('Kapat'):t('Yeniden aç'))}</button><button type="button" class="button small ghost danger" data-milestone-delete>${esc(t('Sil'))}</button></div></div>`;
  };
  setHtml(list,shown.map(row).join('')||`<p class="form-hint">${esc(milestoneTab==='closed'?t('Kapalı milestone yok.'):t('Açık milestone yok. Aşağıdan milestone ekle; yeni görevler geçerli milestone’a eklenir.'))}</p>`);
}
async function writeMilestone(current,request,message){
  try{const saved=await request();if(saved?.id)state.projects=state.projects.map(item=>item.id===saved.id?saved:item);milestoneEditing=null;if($('#project-milestones-list')?.contains(document.activeElement))document.activeElement.blur();if(message)toast(message);await refresh();return true;}
  catch(problem){error(problem.message);return false;}
}
async function projectMilestoneAction(target){
  const current=project();if(!current)return;const row=target.closest('[data-milestone-row]'),id=row?.dataset.milestoneRow,milestone=findMilestone(current.id,id),t=globalThis.AIWSI18n.text,path=`/projects/${current.id}/milestones`;
  if(target.matches('[data-milestone-tab]')){milestoneTab=target.dataset.milestoneTab;milestoneEditing=null;renderProjectMilestones(current);return;}
  if(target.matches('[data-milestone-create]')){
    // The fields are held here: the page may be left or rebuilt while the request runs.
    const title=$('#project-milestone-new-title'),due=$('#project-milestone-new-due'),description=$('#project-milestone-new-description');if(!title.value.trim()){title.focus();return;}
    if(await writeMilestone(current,()=>api(path,'POST',{title:title.value.trim(),dueOn:due.value||null,description:description.value}),t('Milestone eklendi'))){title.value='';due.value='';description.value='';milestoneTab='open';if(title.isConnected)title.focus();}
    return;
  }
  if(!milestone)return;
  if(target.matches('[data-milestone-edit]')){milestoneEditing=id;renderProjectMilestones(current);$('[data-milestone-edit-title]')?.focus();return;}
  if(target.matches('[data-milestone-cancel]')){milestoneEditing=null;if(row.contains(document.activeElement))document.activeElement.blur();renderProjectMilestones(current);return;}
  if(target.matches('[data-milestone-save]')){const title=$('[data-milestone-edit-title]',row).value.trim();if(!title)return;await writeMilestone(current,()=>api(`${path}/${id}`,'PATCH',{title,dueOn:$('[data-milestone-edit-due]',row).value||null,description:$('[data-milestone-edit-description]',row).value}),t('Milestone güncellendi'));return;}
  if(target.matches('[data-milestone-toggle]')){const next=milestone.state==='open'?'closed':'open';await writeMilestone(current,()=>api(`${path}/${id}`,'PATCH',{state:next}),next==='closed'?t('Milestone kapatıldı'):t('Milestone yeniden açıldı'));return;}
  if(target.matches('[data-milestone-current]')){await writeMilestone(current,()=>api(`${path}/current`,'PUT',{milestoneId:milestone.id===currentMilestoneId(current.id)?null:milestone.id}),t('Geçerli milestone güncellendi'));return;}
  if(target.matches('[data-milestone-show]')){showMilestoneTasks(current.id,milestone.id);return;}
  if(target.matches('[data-milestone-delete]')){if(!await confirmModal(t('Milestone silinsin mi?'),globalThis.AIWSI18n.template`"${milestone.title}" milestone’u silinsin mi? Görevler silinmez, yalnız bu milestone’dan çıkarılır.${current.github&&milestone.github?globalThis.AIWSI18n.text(' GitHub’daki milestone da silinir.'):''}`,{confirmLabel:t('Milestone’u sil'),danger:true}))return;await writeMilestone(current,()=>api(`${path}/${id}`,'DELETE'),t('Milestone silindi'));}
}
/** Opens the project board filtered to one milestone. */
function showMilestoneTasks(id,milestoneId){
  if(id!==projectId)openProject(id);
  try{localStorage.setItem(`aiws.project-tab.${id}`,'board');}catch{/* The tab is only a convenience. */}
  milestoneFilter=milestoneId;milestoneFilterProject=id;selectedTaskId=null;render();
}
document.addEventListener('click',event=>{const target=event.target.closest?.('[data-milestones-editor] button');if(target)void projectMilestoneAction(target);});
// Enter saves the milestone form instead of submitting the project settings form; Escape leaves the edited row.
document.addEventListener('keydown',event=>{const editor=event.target.closest?.('[data-milestones-editor]');if(!editor||event.target.tagName!=='INPUT')return;if(event.key==='Enter'){event.preventDefault();const button=event.target.closest('[data-milestone-row]')?.querySelector('[data-milestone-save]')||(event.target.closest('[data-milestone-new]')&&$('[data-milestone-create]',editor));if(button)void projectMilestoneAction(button);}else if(event.key==='Escape'&&milestoneEditing&&event.target.closest('[data-milestone-row]')){event.preventDefault();event.stopPropagation();milestoneEditing=null;event.target.blur();const current=project();if(current)renderProjectMilestones(current);}},true);
