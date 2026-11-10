'use strict';
// Copying a discovered skill to other skill folders and removing a copy.
function skillShareModal(key){
  const index=discoveredSkillIndex(),row=index?.rows.find(item=>item.key===key);if(!row)return;
  const sources=row.copies.filter(copy=>!copy.error);if(!sources.length)return;const initial=sources.find(copy=>copy.scope==='project')||sources[0];
  const locationLabel=location=>`${location.scope==='global'?globalThis.AIWSI18n.text('Global'):esc(location.label)} · ${esc(skillProviderLabels[location.provider])}`;
  showModal(globalThis.AIWSI18n.text('Skilli paylaş'),globalThis.AIWSI18n.template`<form class="skill-share-form"><p class="form-hint">Seçtiğin her hedefe skill klasörünün bir kopyası yazılır (ör. proje/.claude/skills/${esc(row.key)}). Farklı içerikli mevcut bir skill sen onaylamadan değiştirilmez.</p><div class="form-field"><label for="field-sourceId">Kaynak kopya</label><select id="field-sourceId" name="sourceId">${sources.map(copy=>`<option value="${esc(copy.id)}" ${copy.id===initial.id?'selected':''}>${locationLabel(index.locations.get(copy.locationId)||copy)} — ${esc(copy.path)}</option>`).join('')}</select></div><h3 class="form-section">Hedefler</h3><div id="skill-share-targets" class="skill-share-targets"></div><div id="skill-share-conflicts" class="skill-share-conflicts" hidden></div>${formFooter(globalThis.AIWSI18n.text('Paylaş'))}</form>`,async data=>{
    const targets=data.getAll('targets');if(!targets.length)throw new Error(globalThis.AIWSI18n.text('En az bir hedef klasör seç.'));
    const result=await api('/skill-discovery/share','POST',{sourceId:data.get('sourceId'),targets,overwrite:data.getAll('overwrite')});
    if(!result.applied){
      const conflicts=result.results.filter(item=>item.status==='conflict'),box=$('#skill-share-conflicts');box.hidden=false;
      box.innerHTML=globalThis.AIWSI18n.template`<strong>Aynı adlı farklı skill bulundu</strong>${conflicts.map(item=>{const location=index.locations.get(item.locationId),diff=item.diff||{added:[],removed:[],changed:[]};return globalThis.AIWSI18n.template`<label class="skill-conflict"><input type="checkbox" name="overwrite" value="${esc(item.locationId)}"><span><b>Üzerine yaz</b> · ${location?locationLabel(location):esc(item.locationId)}<small>${esc(item.path)}</small><small>${diff.changed.length?globalThis.AIWSI18n.template`Değişen: ${esc(diff.changed.join(', '))}. `:''}${diff.added.length?globalThis.AIWSI18n.template`Eklenecek: ${esc(diff.added.join(', '))}. `:''}${diff.removed.length?globalThis.AIWSI18n.template`Silinecek: ${esc(diff.removed.join(', '))}.`:''}</small></span></label>`;}).join('')}`;
      throw new Error(globalThis.AIWSI18n.text('Hiçbir şey kopyalanmadı. Üzerine yazmak istediğin hedefleri işaretleyip yeniden paylaş.'));
    }
    toast(globalThis.AIWSI18n.template`${result.results.filter(item=>item.status!=="unchanged").length} klasöre skill paylaşıldı`);void loadSkillDiscovery(true);
  },{size:'wide'});
  const renderTargets=()=>{
    const source=sources.find(copy=>copy.id===$('#field-sourceId').value)||initial;
    $('#skill-share-targets').innerHTML=index.columns.filter(column=>column.scope!=='plugin').map(column=>`<fieldset class="skill-share-group"><legend>${esc(column.label)}</legend>${column.locations.filter(location=>location.writable||row.copies.some(copy=>copy.locationId===location.id)).map(location=>{
      const existing=row.copies.find(copy=>copy.locationId===location.id),isSource=existing?.id===source.id,same=Boolean(existing&&(isSource||existing.fingerprint&&existing.fingerprint===source.fingerprint));
      const badge=!existing?'':isSource?globalThis.AIWSI18n.text('<span class="source-badge">Kaynak</span>'):same?globalThis.AIWSI18n.text('<span class="source-badge">Kurulu · aynı</span>'):globalThis.AIWSI18n.text('<span class="source-badge warning">Kurulu · farklı</span>');
      return `<div class="skill-share-target"><label class="checkbox-field"><input type="checkbox" name="targets" value="${esc(location.id)}" ${same||!location.writable?'disabled':''}> <span>${esc(skillProviderLabels[location.provider])} <small>${esc(location.path)}</small></span></label>${badge}${existing&&!isSource&&location.writable?globalThis.AIWSI18n.template`<button type="button" class="button small ghost danger" data-remove-discovered="${esc(existing.id)}">Kaldır</button>`:''}</div>`;
    }).join('')}</fieldset>`).join('');
    $('#skill-share-conflicts').hidden=true;$('#skill-share-conflicts').innerHTML='';
  };
  $('#field-sourceId').onchange=renderTargets;renderTargets();
}
function removeDiscoveredSkill(id){
  const copy=skillDiscovery.data?.skills.find(item=>item.id===id);if(!copy)return;
  showModal(globalThis.AIWSI18n.text('Skill kopyası kaldırılsın mı?'),globalThis.AIWSI18n.template`<form><p class="form-hint">Bu klasör diskten silinir: <code>${esc(copy.path)}</code>${copy.linkedTo?globalThis.AIWSI18n.text(' (yalnız bağlantı kaldırılır, hedef klasör korunur)'):''}. Skillin başka bir kopyası kalmıyorsa sunucu işlemi reddeder.</p>${formFooter(globalThis.AIWSI18n.text('Kopyayı kaldır'))}</form>`,async()=>{await api('/skill-discovery/remove','POST',{id});toast(globalThis.AIWSI18n.text('Skill kopyası kaldırıldı'));void loadSkillDiscovery(true);});
}
