'use strict';
// Project labels editor.
let labelEditing=null,labelSaving=Promise.resolve();
function renderProjectLabels(current){
  const list=$('#project-labels-list');if(!list||list.contains(document.activeElement)&&document.activeElement.matches('input'))return;
  const t=globalThis.AIWSI18n.text,labels=current.labels||[],counts=new Map();
  // One pass over the tasks counts every label, instead of one pass per label.
  for(const task of state.tasks)if(task.projectId===current.id&&!task.archivedAt)for(const tag of new Set((task.tags||[]).map(tag=>tag.toLowerCase())))counts.set(tag,(counts.get(tag)||0)+1);
  const usage=name=>counts.get(name.toLowerCase())||0;
  setHtml($('#project-labels-count'),esc(labels.length?globalThis.AIWSI18n.template`Etiket sayısı: ${labels.length}`:t('Henüz etiket yok')));
  setHtml($('#project-labels-github'),current.github?t('<button type="button" class="button small" data-labels-import>↓ GitHub’dan içe aktar</button><button type="button" class="button small" data-labels-export>↑ GitHub’a aktar</button>'):`<small class="form-hint">${esc(t('GitHub’a bağlanınca etiketleri depoyla içe ve dışa aktarabilirsin.'))}</small>`);
  setHtml(list,labels.map(label=>labelEditing===label.name?`<div class="project-label-row is-editing project-label-form" data-label-row="${esc(label.name)}"><input type="color" data-label-edit-color value="#${esc(label.color)}" aria-label="${esc(t('Etiket rengi'))}"><input data-label-edit-name maxlength="50" value="${esc(label.name)}" aria-label="${esc(t('Etiket adı'))}" autocomplete="off"><input data-label-edit-description maxlength="100" value="${esc(label.description)}" placeholder="${esc(t('Açıklama (isteğe bağlı)'))}" aria-label="${esc(t('Etiket açıklaması'))}" autocomplete="off"><button type="button" class="button small primary" data-label-save>${esc(t('Kaydet'))}</button><button type="button" class="button small ghost" data-label-cancel>${esc(t('Vazgeç'))}</button></div>`:`<div class="project-label-row" data-label-row="${esc(label.name)}">${labelChip(labels,label.name)}<span class="project-label-description">${esc(label.description)}</span><small class="project-label-usage">${esc(globalThis.AIWSI18n.template`${usage(label.name)} görev`)}</small><button type="button" class="button small ghost" data-label-edit>${esc(t('Düzenle'))}</button><button type="button" class="button small ghost danger" data-label-delete>${esc(t('Sil'))}</button></div>`).join('')||`<p class="form-hint">${esc(t('Etiket ekle veya GitHub deposundaki etiketleri içe aktar.'))}</p>`);
}
/** Saves the list `change` builds from the latest saved labels (null cancels). Saves run one after another and each applies its
 * result at once, so a quick next change never builds on a list an earlier save replaced. */
function saveProjectLabels(current,change,message){
  const run=labelSaving.then(()=>writeProjectLabels(current,change((project()?.id===current.id?project():current).labels||[]),message));
  labelSaving=run.catch(()=>{});return run;
}
async function writeProjectLabels(current,labels,message){
  if(!labels)return false;
  try{const saved=await api(`/projects/${current.id}/labels`,'PUT',{labels});state.projects=state.projects.map(item=>item.id===saved.id?{...item,labels:saved.labels}:item);labelEditing=null;if($('#project-labels-list')?.contains(document.activeElement))document.activeElement.blur();if(message)toast(message);await refresh();return true;}catch(problem){error(problem.message);return false;}
}
async function projectLabelAction(target){
  const current=project();if(!current)return;const row=target.closest('[data-label-row]'),name=row?.dataset.labelRow,t=globalThis.AIWSI18n.text;
  if(target.matches('[data-label-create]')){const input=$('#project-label-new-name'),label={name:input.value.trim(),color:$('#project-label-new-color').value.slice(1),description:$('#project-label-new-description').value.trim()};if(!label.name){input.focus();return;}if(await saveProjectLabels(current,list=>{if(!findLabel(list,label.name))return [...list,label];error(t('Bu adda bir etiket zaten var.'));return null;},t('Etiket eklendi'))){input.value='';$('#project-label-new-description').value='';input.focus();}return;}
  if(target.matches('[data-label-edit]')){labelEditing=name;renderProjectLabels(current);$('[data-label-edit-name]')?.focus();return;}
  if(target.matches('[data-label-cancel]')){labelEditing=null;if(row.contains(document.activeElement))document.activeElement.blur();renderProjectLabels(current);return;}
  if(target.matches('[data-label-save]')){const next={previousName:name,name:$('[data-label-edit-name]',row).value.trim(),color:$('[data-label-edit-color]',row).value.slice(1),description:$('[data-label-edit-description]',row).value.trim()};if(!next.name)return;await saveProjectLabels(current,list=>list.map(label=>label.name===name?next:label),t('Etiket güncellendi'));return;}
  if(target.matches('[data-label-delete]')){if(!await confirmModal(t('Etiket silinsin mi?'),globalThis.AIWSI18n.template`"${name}" etiketi silinsin mi? Görevlerden de kaldırılır; GitHub deposundaki etiket korunur.`,{confirmLabel:t('Etiketi sil'),danger:true}))return;await saveProjectLabels(current,list=>list.filter(label=>label.name!==name),t('Etiket silindi'));return;}
  if(target.matches('[data-labels-import],[data-labels-export]')){const exporting=target.matches('[data-labels-export]');target.disabled=true;try{if(exporting){const result=await api(`/projects/${current.id}/labels/export`,'POST',{});toast(globalThis.AIWSI18n.template`GitHub’a aktarıldı · Yeni: ${result.created.length} · Güncellenen: ${result.updated.length}`);}else{const result=await api(`/projects/${current.id}/labels/import`,'POST',{overwrite:true});toast(globalThis.AIWSI18n.template`GitHub’dan içe aktarıldı · Yeni: ${result.added.length} · Güncellenen: ${result.updated.length}`);}await refresh();}catch(problem){error(problem.message);}finally{target.disabled=false;}}
}
document.addEventListener('click',event=>{const target=event.target.closest?.('[data-labels-editor] button');if(target)void projectLabelAction(target);});
// Enter saves the label row instead of submitting the project settings form.
document.addEventListener('keydown',event=>{const editor=event.target.closest?.('[data-labels-editor]');if(!editor||event.target.tagName!=='INPUT')return;if(event.key==='Enter'){event.preventDefault();const button=event.target.closest('[data-label-row]')?.querySelector('[data-label-save]')||(event.target.closest('[data-label-new]')&&$('[data-label-create]',editor));if(button)void projectLabelAction(button);}else if(event.key==='Escape'&&labelEditing&&event.target.closest('[data-label-row]')){event.preventDefault();event.stopPropagation();labelEditing=null;event.target.blur();const current=project();if(current)renderProjectLabels(current);}},true);
