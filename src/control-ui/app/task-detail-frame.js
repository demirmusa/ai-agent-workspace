'use strict';
// The task detail panel frame: header, tabs and the workspace that hosts the console, information or a plugin tab.
function detailFrame({title,titleControl='',status,statusKey='',time='',actions='',menu='',information,key,mount,terminalAvailable=false,taskKey='',changes='',pluginTabs=[],mountPlugin=null}){
  if(detailTab==='terminal'&&!terminalAvailable)detailTab='console';
  if(detailTab.startsWith('plugin:')&&!pluginTabs.some(tab=>tab.key===detailTab))detailTab='console';
  const panel=$('#task-panel'),frameKey=`${key}:${detailTab}`;
  const opening=panel.hidden;
  if(panel.hidden||panel.dataset.selection!==key){if(!footerChangesOpen())closeChildAgent(false);finishDetailResize();detailPanelWidth=null;localStorage.removeItem(detailWidthKey);}
  panel.hidden=false;panel.dataset.selection=key;ensureDetailResizer(panel);
  preserveFocus(()=>{
    const fsLabel=globalThis.AIWSI18n.text(sessionFullscreen?'Tam ekrandan çık':'Tam ekran');
    const header=globalThis.AIWSI18n.template`<header class="panel-header"><div class="detail-heading"><span class="task-status-chip ${esc(statusKey)}">${esc(status)}</span>${time}<span class="detail-title-line">${taskKey}${titleControl||`<h2 id="task-detail-title" title="${esc(title)}" ${title?'':'hidden'}>${esc(title)}</h2>`}</span></div><div class="panel-actions">${actions}${menu?`<details class="detail-more"><summary class="icon-button" aria-label="Diğer işlemler" title="Diğer işlemler">⋯</summary><div class="detail-more-menu popup-menu">${menu}</div></details>`:''}<button class="icon-button" data-action="fullscreen-session" aria-pressed="${sessionFullscreen}" aria-label="${esc(fsLabel)}" title="${esc(fsLabel)}">${window.AIWSUI.icon('expand')}</button><button id="close-panel" class="icon-button" aria-label="Görev panelini kapat">${window.AIWSUI.icon('x')}</button></div></header>`;
    const tabs=globalThis.AIWSI18n.template`<div class="detail-tabs"><nav class="view-tabs" role="tablist" aria-label="Detay görünümü">${[["info",globalThis.AIWSI18n.text("Bilgiler")],["console",globalThis.AIWSI18n.text("Sohbet")],["terminal","Agent Console"],...pluginTabs.map(tab=>[tab.key,esc(tab.label)])].map(([tab,label])=>`<button id="detail-tab-${esc(tab)}" class="view-tab ${detailTab===tab?"active":""}" data-detail-tab="${esc(tab)}" role="tab" aria-selected="${detailTab===tab}" ${tab==="terminal"&&!terminalAvailable?globalThis.AIWSI18n.text('disabled title="CLI terminali, bu merkezde Terminal (PTY) moduyla açılan oturumlarda kullanılabilir."'):""}>${label}</button>`).join('')}</nav>${changes}</div>`;
    // Information is only built for the visible tab; it can list hundreds of events.
    const info=detailTab==='info'?(typeof information==='function'?information():information):'';
    const workspace=`<div class="detail-workspace" role="tabpanel" aria-labelledby="detail-tab-${esc(detailTab)}">${detailTab==='info'?`<section class="detail-information">${info}</section>`:detailTab.startsWith('plugin:')?'<section class="plugin-detail-host"></section>':'<section id="agent-console-host" class="agent-console-host"></section>'}</div>`;
    const parse=html=>{const template=document.createElement('template');template.innerHTML=html;return template.content.firstElementChild;};
    if(panel.dataset.frame===frameKey&&panel.querySelector('.detail-workspace')){
      // Replace only what changed so hover, focus and scroll positions survive pushes.
      if(detailSignatures.get('header')!==header){panel.querySelector('.panel-header').replaceWith(parse(header));detailSignatures.set('header',header);}
      if(detailSignatures.get('tabs')!==tabs){panel.querySelector('.detail-tabs').replaceWith(parse(tabs));detailSignatures.set('tabs',tabs);}
      // An open inline editor keeps its DOM (and unsaved text); the info view catches up once it closes.
      if(detailTab==='info'&&detailSignatures.get('info')!==info&&!infoEditorBusy(panel)){
        const scrollTop=panel.querySelector('.detail-information').scrollTop;
        for(const target of panel.querySelectorAll('.detail-workspace form,.detail-workspace [data-info-row="model"]'))target.dispatchEvent(new Event('modalreset'));
        panel.querySelector('.detail-workspace').replaceWith(parse(workspace));detailSignatures.set('info',info);
        panel.querySelector('.detail-information').scrollTop=scrollTop;
      }
    }else{
      for(const target of panel.querySelectorAll('form,[data-info-row="model"]'))target.dispatchEvent(new Event('modalreset'));
      for(const child of [...panel.childNodes])if(child!==detailResizeHandle)child.remove();
      const content=document.createElement('template');content.innerHTML=header+tabs+workspace;
      // A rebuilt frame (another task or tab) fades its workspace in; a panel that is opening already slides in, so fading too would flicker.
      if(!opening)content.content.querySelector('.detail-workspace').classList.add('ui-enter-fade');
      panel.append(content.content);panel.dataset.frame=frameKey;
      detailSignatures.set('header',header);detailSignatures.set('tabs',tabs);detailSignatures.set('info',info);
    }
    if(detailTab.startsWith('plugin:'))mountPlugin?.(panel.querySelector('.plugin-detail-host'),detailTab);
    else if(detailTab!=='info'){
      const host=$('#agent-console-host');pendingConsoleMount=mount;
      // A console built for the first time paints a skeleton first and mounts on the next frame; a cached one (same key) moves in at once.
      if(panel.dataset.mounted!==frameKey&&consoleViews.has(key)){panel.dataset.mounted=frameKey;mount(host);}
      else if(panel.dataset.mounted!==frameKey){
        panel.dataset.mounted=frameKey;host.innerHTML=consoleSkeletonHtml();host.dataset.loading='true';
        requestAnimationFrame(()=>requestAnimationFrame(()=>{if(panel.dataset.mounted!==frameKey||!host.isConnected)return;delete host.dataset.loading;host.replaceChildren();pendingConsoleMount(host);for(const callback of consoleMountCallbacks.splice(0))callback();}));
      }else if(!host.dataset.loading)mount(host);
      // Every time the chat opens (task, tab or run changed) it starts at the latest message.
      if(panel.dataset.scrolled!==frameKey){panel.dataset.scrolled=frameKey;requestAnimationFrame(()=>{const scroll=panel.querySelector('.cv-scroll');if(scroll)scroll.scrollTop=scroll.scrollHeight;});}
    }
  });
}
const detailSignatures=new Map();
let pendingConsoleMount=null;
const consoleMountCallbacks=[];
/** Runs `callback` once the detail console is in the DOM: now, or after a first-time console replaces its skeleton. */
function afterConsoleMount(callback){if($('#agent-console-host')?.dataset.loading)consoleMountCallbacks.push(callback);else callback();}
const consoleSkeletonHtml=()=>`<div class="console-skeleton" role="status" aria-label="${esc(globalThis.AIWSI18n.text('Yükleniyor…'))}">${[62,88,45,74,56].map((width,index)=>`<div class="console-skeleton-row${index%2?' is-own':''}" style="--row:${index}"><i class="skeleton"></i><span class="skeleton" style="width:${width}%"></span></div>`).join('')}</div>`;
