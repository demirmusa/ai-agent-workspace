'use strict';
// Run scripts of a project: list and editor.
// The settings page lists the scripts; adding or editing happens in a modal that saves the list at once.
function runScriptsSection(){return `<div class="run-scripts-list" id="settings-run-scripts-list"></div><div class="run-scripts-actions"><button type="button" class="button small primary" id="settings-add-run-script">+ ${esc(globalThis.AIWSI18n.text('Script ekle'))}</button></div><p class="form-hint">${esc(globalThis.AIWSI18n.text('Header’daki Run butonu seçili scripti Terminal sekmesinde, proje klasöründe yeni bir terminalde çalıştırır.'))}</p>`;}
function renderRunScriptList(current){
  const list=$('#settings-run-scripts-list');if(!list)return;const scripts=current.runScripts||[],labels={file:globalThis.AIWSI18n.text('Dosya'),npm:'npm',command:globalThis.AIWSI18n.text('Komut')};
  setHtml(list,scripts.length?scripts.map(script=>{const kind=runScriptKind(script);return `<article class="run-script-card" data-run-script-id="${esc(script.id)}"><span class="run-script-kind" data-kind="${kind}">${esc(labels[kind])}</span><div class="run-script-summary"><strong>${esc(script.name)}</strong><code title="${esc(runScriptLine(script))}">${esc(runScriptLine(script))}</code></div><div class="run-script-card-actions"><button type="button" class="button small ghost" data-edit-run-script>${esc(globalThis.AIWSI18n.text('Düzenle'))}</button><button type="button" class="button small ghost" data-remove-run-script aria-label="${esc(globalThis.AIWSI18n.text('Scripti kaldır'))}: ${esc(script.name)}" title="${esc(globalThis.AIWSI18n.text('Scripti kaldır'))}">✕</button></div></article>`;}).join(''):`<div class="run-scripts-empty"><strong>${esc(globalThis.AIWSI18n.text('Henüz run scripti yok'))}</strong><span>${esc(globalThis.AIWSI18n.text('Bir script dosyası, npm scripti veya proje klasöründe çalışacak özel bir komut ekle.'))}</span></div>`);
}
function wireRunScripts(page,current){
  const list=$('#settings-run-scripts-list',page);if(!list)return;
  const latest=()=>project()?.id===current.id?project():current;
  $('#settings-add-run-script',page).onclick=()=>runScriptModal(latest());
  list.onclick=async event=>{const card=event.target.closest('[data-run-script-id]'),button=event.target.closest('button');if(!card||!button)return;const item=latest(),script=(item.runScripts||[]).find(entry=>entry.id===card.dataset.runScriptId);if(!script)return;
    if(button.matches('[data-edit-run-script]')){runScriptModal(item,script);return;}
    button.disabled=true;try{await saveRunScripts(item,item.runScripts.filter(entry=>entry.id!==script.id));toast(globalThis.AIWSI18n.template`${script.name} kaldırıldı`);await refresh();}catch(cause){button.disabled=false;error(cause.message);}};
}
