'use strict';
// The project Sessions tab: provider history search, import and conversion.
function projectSessionEntry(current){
  let entry=projectSessionCache.get(current.id);if(!entry||entry.repositoryPath!==current.repositoryPath){entry?.controller?.abort();entry={repositoryPath:current.repositoryPath,items:[],nextCursor:null,total:0,counts:null,warnings:[],loading:false,loaded:false,stale:false,error:'',provider:'',query:'',draft:'',sort:'recent',request:0,controller:null,converting:new Set(),expanded:new Set()};projectSessionCache.set(current.id,entry);}
  return entry;
}
// A changed search/filter/sort supersedes the in-flight request; only the newest response may land.
function ensureProjectSessions(current,{force=false,more=false,reset=false}={}){
  if(!current)return;const entry=projectSessionEntry(current);
  if(more&&(!entry.nextCursor||entry.loading||entry.stale))return;if(!reset&&!more&&(entry.loading||(!force&&entry.loaded)))return;
  entry.controller?.abort();const controller=new AbortController(),request=++entry.request;entry.controller=controller;entry.loading=true;entry.error='';if(reset)entry.stale=Boolean(entry.items.length);
  const params={limit:'30',...(force?{refresh:'1'}:{}),...(entry.provider?{provider:entry.provider}:{}),...(entry.query?{q:entry.query}:{}),...(entry.sort!=='recent'?{sort:entry.sort}:{}),...(more?{cursor:entry.nextCursor}:{})};
  void api(`/projects/${current.id}/sessions?${new URLSearchParams(params)}`,'GET',undefined,{signal:controller.signal}).then(response=>{if(projectSessionCache.get(current.id)!==entry||entry.request!==request)return;entry.items=more?[...new Map([...entry.items,...response.items].map(item=>[item.id,item])).values()]:response.items;entry.nextCursor=response.nextCursor;entry.total=typeof response.total==='number'?response.total:entry.items.length;entry.counts=response.counts||null;entry.warnings=response.warnings||[];entry.loaded=true;entry.stale=false;if(selectedHistory&&!selectedHistory.external&&selectedHistory.projectId===current.id){const selected=entry.items.find(item=>item.id===selectedHistory.id);if(selected)selectedHistory.session={...selectedHistory.session,...selected};}}).catch(error=>{if(entry.request!==request||error?.name==='AbortError')return;entry.error=error.message;entry.loaded=true;entry.stale=false;}).finally(()=>{if(entry.request!==request)return;entry.loading=false;entry.controller=null;if(activeScreen==='board'&&projectId===current.id&&projectTab()==='sessions')render();});
}
function renderProjectSessions(){
  const current=project();if(!current)return;ensureProjectSessions(current);const entry=projectSessionEntry(current),importState=historyImports.get(current.id)||{},board=$('#board');
  board.className='board project-sessions-board';let root=$('.project-sessions',board);
  if(!root||root.dataset.projectId!==current.id){board.innerHTML=globalThis.AIWSI18n.template`<section class="project-sessions" data-project-id="${esc(current.id)}"><header class="history-heading"><div><h2>Bu projenin geçmiş oturumları</h2><p>Seçtiğin klasöre ait Codex ve Claude Code konuşmaları. Görüntülemek görevi başlatmaz.</p></div><div><button type="button" class="button small" id="import-project-history"></button><button type="button" class="button small" id="refresh-project-sessions"><span class="button-glyph" aria-hidden="true">↻</span> Yenile</button></div></header><div class="history-toolbar" role="search"><label class="history-search"><span aria-hidden="true">⌕</span><input id="history-search" type="search" maxlength="200" autocomplete="off" spellcheck="false" placeholder="Başlık, ilk mesaj veya oturum kimliği ara…" aria-label="Oturumlarda ara" aria-controls="history-results"><kbd aria-hidden="true">/</kbd></label><select id="history-provider-filter" aria-label="Geçmiş oturum sağlayıcısı"></select><select id="history-sort" aria-label="Oturum sıralaması"><option value="recent">Son etkinlik</option><option value="oldest">En eski etkinlik</option><option value="created">Başlangıç zamanı</option></select></div><div data-history-import></div><p class="history-source">${pageIcon('folder')} ${esc(current.repositoryPath)}</p><div data-history-notices></div><div class="history-summary" data-history-summary role="status" aria-live="polite"></div><div id="history-results" data-history-results></div></section>`;root=$('.project-sessions',board);bindProjectSessions(root);
    // Opening the page reads the list again, so titles renamed in the provider CLI meanwhile show up.
    if(entry.loaded&&!entry.loading)ensureProjectSessions(current,{reset:true});}
  const search=$('#history-search',root);if(document.activeElement!==search&&search.value!==entry.draft)search.value=entry.draft;$('#history-sort',root).value=entry.sort;
  // The filter lists the providers whose history the server reads, in the registry's order.
  const counts=entry.counts,count=provider=>counts?` (${counts[provider]||0})`:'';setHtml($('#history-provider-filter',root),globalThis.AIWSI18n.template`<option value="">Tüm sağlayıcılar${counts?` (${historyProviders.reduce((sum,provider)=>sum+(counts[provider]||0),0)})`:''}</option>${historyProviders.map(provider=>`<option value="${esc(provider)}" ${entry.provider===provider?'selected':''}>${esc(providers[provider])}${count(provider)}</option>`).join('')}`);$('#history-provider-filter',root).value=entry.provider;
  const importButton=$('#import-project-history',root),refreshButton=$('#refresh-project-sessions',root);importButton.disabled=Boolean(importState.pending);importButton.classList.toggle('is-busy',Boolean(importState.pending));importButton.textContent=importState.pending?globalThis.AIWSI18n.text('Görevler yükleniyor…'):globalThis.AIWSI18n.text('Geçmişten görevleri yükle');importButton.title=globalThis.AIWSI18n.text('Bu klasördeki tüm kök oturumları panoya salt okunur görev olarak ekler; mevcut olanlar atlanır.');refreshButton.disabled=entry.loading&&!entry.stale;refreshButton.classList.toggle('is-busy',entry.loading);
  setHtml($('[data-history-import]',root),historyImportHtml(importState));
  setHtml($('[data-history-notices]',root),`${entry.error&&entry.items.length?globalThis.AIWSI18n.template`<p class="history-error" role="alert">${esc(entry.error)} · Yenile ile tekrar deneyebilirsin.</p>`:''}${entry.warnings.length?globalThis.AIWSI18n.template`<details class="history-warnings"><summary>Okuma bilgisi (${entry.warnings.length})</summary>${entry.warnings.map(warning=>`<p>${esc(warning)}</p>`).join('')}</details>`:''}`);
  const filtered=Boolean(entry.query||entry.provider),terms=entry.query?entry.query.split(/\s+/).filter(Boolean):[];
  setHtml($('[data-history-summary]',root),entry.loading&&(entry.stale||!entry.items.length)?`<span class="ui-spinner" aria-hidden="true"></span> ${entry.query?globalThis.AIWSI18n.text('Aranıyor…'):globalThis.AIWSI18n.text('Yerel oturumlar okunuyor…')}`:entry.loaded&&!entry.error?`${entry.query?globalThis.AIWSI18n.template`${entry.total} sonuç: “${esc(entry.query)}”`:globalThis.AIWSI18n.template`${entry.total} oturum bulundu`}${entry.items.length<entry.total?globalThis.AIWSI18n.template` · ${entry.items.length} gösteriliyor`:''}${filtered?globalThis.AIWSI18n.text(' <button type="button" class="link-button" data-history-clear>Filtreleri temizle</button>'):''}`:'');
  let results;
  if(!entry.items.length){
    const t=globalThis.AIWSI18n;
    if(entry.loading)results=`<div class="history-skeleton" aria-hidden="true">${'<div class="history-skeleton-card ui-card"><span class="skeleton"></span><div><i class="skeleton"></i><i class="skeleton"></i></div></div>'.repeat(4)}</div>`;
    else if(entry.error)results=emptyState({className:'history-empty',role:'alert',mark:window.AIWSUI.icon('triangle'),level:3,title:esc(t.text('Oturum geçmişi okunamadı.')),action:`<p class="history-error">${esc(entry.error)}</p>${t.text('<button type="button" class="button small" data-history-retry>Tekrar dene</button>')}`});
    else if(filtered)results=emptyState({className:'history-empty',mark:window.AIWSUI.icon('search'),level:3,title:esc(t.text('Eşleşen oturum bulunamadı.')),text:entry.query?t.template`“${esc(entry.query)}” başlıkta, ilk mesajda veya oturum kimliğinde geçmiyor.`:esc(t.text('Bu sağlayıcıya ait oturum yok.')),action:t.text('<button type="button" class="button small" data-history-clear>Filtreleri temizle</button>')});
    else results=emptyState({className:'history-empty',level:3,title:esc(t.text('Bu klasörde henüz oturum bulunamadı.')),text:esc(t.text('Codex veya Claude Code ile bu proje klasöründe yapılan yerel konuşmalar burada görünür.'))});
  }else{
    const context={terms,tasks:historySessionTasks(),active:historyActiveKeys(),converting:entry.converting,expanded:entry.expanded},groups=[];
    for(const item of entry.items){const label=historyDateGroup(entry.sort==='created'?item.createdAt:item.updatedAt),last=groups.at(-1);if(last?.label===label)last.items.push(item);else groups.push({label,items:[item]});}
    results=`<div class="history-session-list${entry.stale?' is-stale':''}" ${entry.stale?'aria-busy="true"':''}>${groups.map(group=>`<section class="history-group"><h3 class="history-group-heading"><span>${group.label}</span><small>${group.items.length}</small></h3><div role="list">${group.items.map(item=>historySessionNode(current.id,item,context)).join('')}</div></section>`).join('')}</div>${entry.nextCursor&&!entry.stale?`<button type="button" class="button history-more" id="more-project-sessions" ${entry.loading?'disabled':''}>${entry.loading?globalThis.AIWSI18n.text('Yükleniyor…'):globalThis.AIWSI18n.template`Daha fazla oturum yükle (${entry.total-entry.items.length})`}</button>`:''}`;
  }
  const host=$('[data-history-results]',root),focused=host.contains(document.activeElement)?{session:document.activeElement.closest('[data-history-session]')?.dataset.historySession,action:document.activeElement.dataset.historyAction}:null;
  if(setHtml(host,results)&&focused?.session){const card=host.querySelector(`[data-history-session="${CSS.escape(focused.session)}"]`);(card&&(focused.action&&card.querySelector(`[data-history-action="${CSS.escape(focused.action)}"]:not(:disabled)`)||card.querySelector('[data-history-open]')))?.focus();}
  window.AIWSUI.motion.enter(host,'[data-history-session]','data-history-session');
}
function bindProjectSessions(root){
  const current=()=>state.projects.find(item=>item.id===root.dataset.projectId),cards=()=>[...root.querySelectorAll('[data-history-open]')];
  const reload=(options={reset:true})=>{const value=current();if(!value)return;ensureProjectSessions(value,options);renderProjectSessions();};
  const applySearch=()=>{clearTimeout(historySearchTimer);const value=current();if(!value)return;const entry=projectSessionEntry(value),query=entry.draft.trim().slice(0,200);if(query===entry.query)return;entry.query=query;reload();};
  root.addEventListener('input',event=>{if(event.target.id!=='history-search')return;const value=current();if(!value)return;projectSessionEntry(value).draft=event.target.value;clearTimeout(historySearchTimer);historySearchTimer=setTimeout(applySearch,250);});
  root.addEventListener('change',event=>{const value=current();if(!value)return;const entry=projectSessionEntry(value);if(event.target.id==='history-provider-filter'){entry.provider=event.target.value;reload();}if(event.target.id==='history-sort'){entry.sort=event.target.value;reload();}});
  root.addEventListener('click',event=>{
    const value=current(),target=event.target;if(!value)return;const entry=projectSessionEntry(value);
    if(target.closest('#import-project-history')){void importProjectHistory(value);return;}
    if(target.closest('#refresh-project-sessions,[data-history-retry]')){reload({force:true,reset:true});return;}
    if(target.closest('[data-history-clear]')){clearTimeout(historySearchTimer);entry.query='';entry.draft='';entry.provider='';$('#history-search',root).value='';reload();$('#history-search',root).focus();return;}
    if(target.closest('[data-history-import-dismiss]')){historyImports.delete(value.id);renderProjectSessions();return;}
    if(target.closest('[data-history-import-board]')){localStorage.setItem(`aiws.project-tab.${value.id}`,'board');render();return;}
    if(target.closest('#more-project-sessions')){ensureProjectSessions(value,{more:true});renderProjectSessions();return;}
    const node=target.closest('[data-history-node]'),nodeSession=node&&entry.items.find(item=>item.id===node.dataset.historyNode),agentsPath=nodeSession&&historySubagentPath(value.id,nodeSession.id);
    if(nodeSession&&target.closest('[data-history-subagents]')){
      if(entry.expanded.has(nodeSession.id))entry.expanded.delete(nodeSession.id);
      else{entry.expanded.add(nodeSession.id);const known=agentSourceCache.has(agentsPath),source=ensureAgentSource(agentsPath);void(known?loadAgentTree(agentsPath):source.treeLoad).then(()=>{if(projectId===value.id&&activeScreen==='board'&&projectTab()==='sessions')renderProjectSessions();});}
      renderProjectSessions();return;
    }
    const subagent=nodeSession&&target.closest('[data-history-subagent]');
    // The parent console mounts a frame later when it opens for the first time; its subagent opens beside it once it exists.
    if(subagent){const agent=agentSourceCache.get(agentsPath)?.agentTree?.agents.find(item=>item.id===subagent.dataset.historySubagent),key=`history:${value.id}/${nodeSession.id}`;openHistorySession(value.id,nodeSession.id);if(!agent)return;afterConsoleMount(()=>openChildAgent(agent,key,agentsPath,subagent));return;}
    const card=target.closest('[data-history-session]');if(!card)return;const session=entry.items.find(item=>item.id===card.dataset.historySession);if(!session)return;const action=target.closest('[data-history-action]');
    for(const menu of root.querySelectorAll('.history-session-actions[open]'))if(!menu.contains(target))menu.open=false;
    if(target.closest('.history-session-actions>summary')||target.closest('.history-session-menu')&&!target.closest('[data-history-action]'))return;
    if(action)action.closest('details').open=false;
    if(action?.dataset.historyAction==='resume'){void resumeHistorySession(value.id,session);return;}
    if(action?.dataset.historyAction==='compact'){compactHistoryModal(value.id,session);return;}
    if(action?.dataset.historyAction==='task'){openTask(action.dataset.taskId);if(task()?.sessionContinuation&&state.runs.find(run=>run.id===task().currentRunId)?.terminalMode==='pty'){detailTab='terminal';render();}return;}
    if(action?.dataset.historyAction==='convert'){void convertHistorySession(value,session);return;}
    openHistorySession(value.id,session.id);
  });
  root.addEventListener('keydown',event=>{
    const sessionMenu=event.target.closest('.history-session-actions[open]');
    if(sessionMenu){if(event.key==='Escape'){event.preventDefault();sessionMenu.open=false;sessionMenu.querySelector('summary').focus();return;}const list=sessionMenu.querySelector('.history-session-menu');if(event.target.closest('.history-session-menu')&&window.AIWSUI.menuNavigate(event,list))return;if(event.target.matches('summary')&&event.key==='ArrowDown'){event.preventDefault();list.querySelector('[role=menuitem]:not(:disabled)')?.focus();return;}}
    if(event.target.id==='history-search'){
      if(event.key==='Enter'){event.preventDefault();applySearch();}
      else if(event.key==='Escape'&&event.target.value&&current()){event.preventDefault();event.target.value='';projectSessionEntry(current()).draft='';applySearch();}
      else if(event.key==='ArrowDown'&&cards().length){event.preventDefault();cards()[0].focus();}
      return;
    }
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||!event.target.closest('[data-history-session]')||event.target.matches('select'))return;
    const list=cards(),index=list.indexOf(event.target.closest('[data-history-session]').querySelector('[data-history-open]'));event.preventDefault();
    if(event.key==='ArrowUp'&&index<=0){$('#history-search',root).focus();return;}
    list[event.key==='Home'?0:event.key==='End'?list.length-1:Math.min(list.length-1,index+(event.key==='ArrowDown'?1:-1))]?.focus();
  });
}
async function convertHistorySession(current,session){
  const entry=projectSessionEntry(current);if(entry.converting.has(session.id))return;entry.converting.add(session.id);renderProjectSessions();
  try{const result=await api(`/projects/${current.id}/sessions/${encodeURIComponent(session.id)}/import`,'POST',{});await refresh();if(result.errors?.length)error(result.errors[0].message);else toast(result.imported?globalThis.AIWSI18n.text('Oturum göreve dönüştürüldü; Pano sekmesinde görünür.'):globalThis.AIWSI18n.text('Bu oturum zaten bir göreve bağlı.'));}
  catch(failure){error(failure.message);}
  finally{entry.converting.delete(session.id);if(projectId===current.id&&activeScreen==='board'&&projectTab()==='sessions')renderProjectSessions();}
}
async function importProjectHistory(current){
  if(historyImports.get(current.id)?.pending)return;historyImports.set(current.id,{pending:true});renderProjectSessions();
  try{const result=await api(`/projects/${current.id}/sessions/import`,'POST',{});historyImports.set(current.id,{pending:false,result});await refresh();ensureProjectSessions(current,{force:true,reset:true});}
  catch(error){historyImports.set(current.id,{pending:false,error:error.message});}
  finally{if(projectId===current.id&&activeScreen==='board'&&projectTab()==='sessions')renderProjectSessions();}
}
