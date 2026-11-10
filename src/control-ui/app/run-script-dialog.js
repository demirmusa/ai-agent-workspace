'use strict';
// The dialog that adds or edits a run script.
function runScriptModal(current,script=null){
  const kind=script?.command!==undefined?'command':'file',text=value=>esc(globalThis.AIWSI18n.text(value)),windows=/^Win/.test(navigator.platform||'');
  showModal(globalThis.AIWSI18n.text(script?'Run scriptini düzenle':'Run scripti ekle'),`<form class="run-script-form" novalidate>
    <div class="form-field"><label for="run-script-name">${text('Script adı')}</label><input id="run-script-name" name="name" value="${esc(script?.name||'')}" maxlength="80" required autocomplete="off" placeholder="${text('ör. Geliştirme sunucusu')}"></div>
    <fieldset class="run-script-kinds"><legend>${text('Ne çalıştırılsın?')}</legend>
      <label class="run-script-kind-option"><input type="radio" name="kind" value="file" ${kind==='file'?'checked':''}><span><strong>${text('Proje scripti')}</strong><small>${text('.ps1, .sh, .bat, .cmd dosyası veya package.json npm scripti')}</small></span></label>
      <label class="run-script-kind-option"><input type="radio" name="kind" value="command" ${kind==='command'?'checked':''}><span><strong>${text('Özel komut')}</strong><small>${text('Proje klasöründe çalışan herhangi bir terminal komutu')}</small></span></label>
    </fieldset>
    <div class="form-field" data-kind-panel="file"><label for="run-script-path">${text('Script dosyası')}</label><select id="run-script-path" name="path"><option value="">${text('Script seç…')}</option>${runScriptOptions(kind==='file'&&script?runScriptValue(script):'')}</select><small id="run-script-candidates-status" role="status">${text('Proje klasörü taranıyor…')}</small></div>
    <div class="form-field" data-kind-panel="command"><label for="run-script-command">${text('Komut')}</label><input id="run-script-command" name="command" class="run-script-mono" value="${esc(script?.command||'')}" maxlength="2000" autocomplete="off" spellcheck="false" placeholder="myapp dosomething"><small>${text(windows?'PowerShell ile proje klasöründe çalışır; PATH’teki her komutu kullanabilirsin.':'Kabukta (sh) proje klasöründe çalışır; PATH’teki her komutu kullanabilirsin.')}</small></div>
    <div class="form-field"><label for="run-script-args">${text('Parametreler')} <span class="form-optional">${text('(isteğe bağlı)')}</span></label><textarea id="run-script-args" name="args" class="run-script-mono" rows="3" maxlength="1000" spellcheck="false" placeholder="--port 3000&#10;--verbose">${esc(script?.args||'')}</textarea><small>${text('Boşluk veya satırla ayır; boşluk içeren değerleri tırnak içine al.')}</small></div>
    <div class="settings-switch-row"><div class="settings-row-text"><label for="run-script-ask-args">${text('Çalıştırırken parametreleri sor')}</label><small>${text('Run’a basınca parametreler sorulur; boş bırakılırsa script parametresiz çalışır.')}</small></div><input type="checkbox" class="ui-switch" role="switch" id="run-script-ask-args" name="askArgs" ${script?.askArgs?'checked':''}></div>
    <div class="run-script-preview"><span>${text('Çalışacak komut')}</span><code id="run-script-preview"></code><small title="${esc(current.repositoryPath)}">${text('Klasör')}: ${esc(current.repositoryPath)}</small></div>
    ${formFooter(globalThis.AIWSI18n.text(script?'Kaydet':'Ekle'))}</form>`,async data=>{
    const name=String(data.get('name')||'').trim(),args=String(data.get('args')||'').trim(),isCommand=data.get('kind')==='command',command=String(data.get('command')||'').trim(),path=String(data.get('path')||'');
    if(!name)throw new Error(globalThis.AIWSI18n.text('Script adı gerekli.'));
    if(isCommand?!command:!path)throw new Error(globalThis.AIWSI18n.text(isCommand?'Çalıştırılacak komutu yaz.':'Bir script dosyası seç.'));
    const entry={id:script?.id,name,...(data.get('askArgs')?{askArgs:true}:{}),...(isCommand?{command}:runScriptChoice(path)),...(args?{args}:{})},scripts=[...(current.runScripts||[])],index=script?scripts.findIndex(item=>item.id===script.id):-1;
    if(index>=0)scripts[index]=entry;else scripts.push(entry);
    await saveRunScripts(current,scripts);toast(globalThis.AIWSI18n.text(script?'Run scripti güncellendi':'Run scripti eklendi'));
  },{description:globalThis.AIWSI18n.text('Header’daki Run butonuyla proje klasöründe yeni bir terminalde çalışır.')});
  const form=$('#modal form'),status=$('#run-script-candidates-status',form),select=$('#run-script-path',form),preview=$('#run-script-preview',form);
  const update=()=>{const isCommand=form.elements.kind.value==='command',args=form.elements.args.value.trim(),command=form.elements.command.value.trim();for(const panel of $$('[data-kind-panel]',form))panel.hidden=panel.dataset.kindPanel!==(isCommand?'command':'file');
    preview.textContent=isCommand?(command?runScriptLine({command,args}):'—'):(select.value?runScriptLine({...runScriptChoice(select.value),args}):'—');};
  form.addEventListener('input',update);form.addEventListener('change',update);update();
  const controller=new AbortController();form.addEventListener('modalreset',()=>controller.abort(),{once:true});
  api(`/projects/${current.id}/script-candidates`).then(items=>{if(controller.signal.aborted)return;const value=select.value;select.innerHTML=`<option value="">${esc(globalThis.AIWSI18n.text('Script seç…'))}</option>${runScriptOptions(value,items)}`;select.value=value;status.textContent=items.files.length||items.npm.length?globalThis.AIWSI18n.text('Script dosyaları ve npm scriptleri proje klasöründen tarandı.'):globalThis.AIWSI18n.text('Projede script dosyası bulunamadı. Özel komut ekleyebilirsin.');update();}).catch(cause=>{if(!controller.signal.aborted)status.textContent=cause.message;});
}
