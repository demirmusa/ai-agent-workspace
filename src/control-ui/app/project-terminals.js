'use strict';
// Project terminals: the workspace of a project, opening, closing, renaming and reloading terminals.
// Project terminals: plain shells and interactive agent CLIs, one xterm view per
// terminal. Views are created only when first shown and then kept, so switching
// tabs never replays a terminal's history.
const projectShells=new Map();
const shellName=/Windows/i.test(navigator.userAgent)?'PowerShell':'Shell';
const terminalVisible=id=>activeScreen==='board'&&projectId===id&&projectTab()==='terminal';
// The shell of a terminal workspace: the new terminal menu, the focused terminal's path and status, and the panes.
const terminalShellHtml=()=>globalThis.AIWSI18n.text('<header class="terminal-meta"><div class="terminal-new"><button type="button" class="terminal-new-button" data-terminal-menu aria-haspopup="menu" aria-expanded="false" title="Yeni terminal (Ctrl+Shift+T)" aria-label="Yeni terminal" aria-keyshortcuts="Control+Shift+T"><span aria-hidden="true">+</span></button><div class="terminal-menu popup-menu" role="menu" aria-label="Yeni terminal" data-terminal-menu-list hidden></div></div><div class="terminal-quick" data-terminal-quick></div><span class="terminal-cwd" data-shell-path></span><span class="terminal-status-text" data-shell-status role="status" aria-live="polite"></span><span class="terminal-meta-actions"><button type="button" class="button small danger" data-shell-close hidden title="Tüm terminalleri kapat">Tüm terminalleri kapat</button><span class="terminal-shortcuts"><button type="button" class="button small terminal-shortcuts-button" data-shortcuts-toggle aria-expanded="false" aria-label="Kısayollar" title="Kısayollar"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r=".6" fill="currentColor"/></svg></button><div class="terminal-shortcuts-pop" data-shortcuts-pop role="dialog" aria-label="Kısayollar" hidden><dl><dt><kbd>Ctrl+Shift+T</kbd></dt><dd>Yeni terminal aç</dd><dt><kbd>Ctrl+Shift+W</kbd></dt><dd>Seçili terminali kapat</dd><dt><kbd>Ctrl+PageUp</kbd> / <kbd>Ctrl+PageDown</kbd></dt><dd>Terminaller arasında geç</dd><dt><kbd>Alt+Shift+D</kbd></dt><dd>Sağa yeni terminal aç</dd><dt><kbd>F2</kbd></dt><dd>Terminali yeniden adlandır</dd></dl></div></span></span></header><div class="terminal-stage" data-terminal-stage><div class="terminal-empty" data-terminal-empty hidden></div><div class="terminal-grid" role="group" aria-label="Proje terminalleri" data-terminal-grid></div><div class="terminal-drop" data-terminal-drop hidden></div></div>');
// The pane parts of a project's own terminals, shared by its Terminal tab and the All projects Terminal tab.
const plainTerminalParts=id=>({
  close:(item,title)=>terminalPaneButton('close',`data-terminal-close="${esc(item.id)}"`,'Kapat (Ctrl+Shift+W)',`${title} terminalini kapat`),
  head:(item,title,status,multiple)=>globalThis.AIWSI18n.template`<button type="button" class="terminal-pane-title" data-terminal-title="${esc(item.id)}" title="${esc(title)} · ${esc(status.label)} · F2 yeniden adlandır${multiple?globalThis.AIWSI18n.text(' · Başlıktan sürükleyerek taşı'):''}">${terminalIcon(item.terminalKind==='agent'||item.terminalKind==='login'?item.provider:'command')}<span class="terminal-tab-title">${esc(title)}</span>${terminalDot(status,status.label)}</button><span class="terminal-pane-grip" aria-hidden="true"></span>${item.terminalKind==='agent'&&item.status==='running'&&historyProviders.includes(item.provider)?globalThis.AIWSI18n.template`${terminalPaneButton('task',`data-terminal-task="${esc(item.id)}"`,'Göreve çevir · Konuşma çalışan bir görev olarak devam eder',`${title} oturumunu göreve çevir`)}`:''}${terminalClearButton(item.id,title)}${item.terminalKind==='script'?terminalPaneButton('restart',`data-terminal-restart="${esc(item.id)}"`,'Scripti aynı terminalde yeniden çalıştır',`${title} scriptini yeniden çalıştır`):''}`,
  exit:(item,status)=>item.status==='running'?'':globalThis.AIWSI18n.template`${terminalDot(status)}<span>${item.terminalKind==='agent'?esc(providers[item.provider]):'Terminal'} kapandı · Çıkış kodu: ${item.exitCode??'?'}</span><button type="button" class="button small" data-terminal-restart="${esc(item.id)}">↻ Yeniden başlat</button><button type="button" class="button small" data-terminal-close="${esc(item.id)}">Terminali kapat</button>`,
  terminal:item=>(({load:()=>api(`/projects/${id}/terminals/${item.id}/terminal`),onImage:async file=>(await api(`/projects/${id}/terminals/${item.id}/images`,'POST',{data:await window.AIWSImages.data(file)})).path,onInput:data=>api(`/projects/${id}/terminals/${item.id}/input`,'POST',{data},{quiet:true}),onResize:size=>api(`/projects/${id}/terminals/${item.id}/resize`,'POST',size,{quiet:true}),onClear:()=>api(`/projects/${id}/terminals/${item.id}/clear`,'POST',{},{quiet:true})}))
});
function shellEntry(id){
  if(!projectShells.has(id)){
    const element=document.createElement('section');element.className='project-terminal';
    element.innerHTML=terminalShellHtml();
    const entry=Object.assign(terminalWorkspace(element,{storageKey:terminalLayoutKey(id),update:()=>updateShell(id),titles:items=>new Map([...terminalTitles(items.filter(item=>!item.taskId)),...items.filter(item=>item.taskId).map(run=>[run.id,consoleTitle(run)])]),status:item=>item.taskId?sessionStatus(item):terminalStatus(item),content:(item,host)=>{
        if(!item.taskId)return false;
        const note=host.querySelector(':scope > .session-elsewhere');
        if(projectShells.get(id)?.detailHeld.has(item.id)){if(!note){const t=globalThis.AIWSI18n.text;host.replaceChildren(sessionElsewhereCard(item.id,t('Bu terminal görev detayında açık'),t('Oturum şu an görev detayında gösteriliyor. Buraya almak ister misin?'),`<button type="button" class="button primary" data-session-to-terminal="${esc(item.id)}">${esc(t('Buraya al'))}</button>`));}return true;}
        note?.remove();return runPaneParts.content(item,host);
      },
      paneClose:(item,title)=>item.taskId?runPaneParts.close(item,title):plainTerminalParts(id).close(item,title),
      paneHead:(item,title,status,multiple)=>item.taskId?runPaneParts.head(item,title,status,multiple):plainTerminalParts(id).head(item,title,status,multiple),
      exitHtml:(item,status)=>item.taskId?runPaneParts.exit(item,status):plainTerminalParts(id).exit(item,status),
      terminal:item=>item.taskId?runTerminalOptions(item):plainTerminalParts(id).terminal(item),
      close:runId=>closeProjectTerminal(id,runId),rename:runId=>startTerminalRename(id,runId),restart:runId=>restartProjectTerminal(id,runId),toTask:runId=>convertProjectTerminal(id,runId)}),
      {loading:false,busy:false,pending:[],loaded:false,version:0,error:'',menuHtml:'',emptyHtml:'',sessions:savedProjectSessions(id),detailHeld:new Set()});projectShells.set(id,entry);
    element.addEventListener('click',event=>{
      const target=event.target.closest('button');if(!target||target.disabled)return;
      if(target.hasAttribute('data-terminal-menu'))toggleTerminalMenu(id);
      else if(target.dataset.terminalOpen){toggleTerminalMenu(id,false);const [kind,provider,account]=target.dataset.terminalOpen.split(':');if(kind==='session')openProjectSession(id,provider);else void openProjectTerminal(id,kind==='agent'||kind==='login'?{kind,provider,...(account?{account}:{})}:{kind:'shell'});}
      else if(target.dataset.sessionToTerminal)moveSessionToTerminal(id,target.dataset.sessionToTerminal);
      else if(target.hasAttribute('data-terminal-agents-refresh')){void loadTerminalAgents(true);updateShell(id);}
      else if(target.hasAttribute('data-shell-close'))void closeAllProjectTerminals(id);
    });
    element.querySelector('[data-terminal-menu-list]').addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();toggleTerminalMenu(id,false);element.querySelector('[data-terminal-menu]').focus();return;}
      window.AIWSUI.menuNavigate(event,event.currentTarget);
    });
  }return projectShells.get(id);
}
function selectProjectTerminal(id,runId,options){selectTerminal(shellEntry(id),runId,options);}
// Project terminals and the panes of task sessions share the workspace; a session item is the task's run, the only kind with a taskId.
const projectTerminalCount=entry=>entry.items.filter(item=>!item.taskId).length+entry.pending.length;
const projectSessionsKey=id=>`aiws.terminal-sessions.${id}`;
const projectSessionRuns=id=>sessionRuns().filter(run=>state.tasks.find(task=>task.id===run.taskId)?.projectId===id);
// Runs that ended while the page was closed are not reopened.
function savedProjectSessions(id){let saved=null;try{saved=JSON.parse(localStorage.getItem(projectSessionsKey(id))||'null');}catch{saved=null;}return Array.isArray(saved)?saved.filter(runId=>typeof runId==='string'&&activeRun(state.runs.find(run=>run.id===runId))):[];}
function openProjectSession(id,runId){
  const entry=shellEntry(id),run=state.runs.find(item=>item.id===runId);if(!run)return;
  entry.detailHeld.delete(runId);
  if(!entry.sessions.includes(runId)){const anchor=entry.selected,target=layoutIds(entry.layout).includes(anchor)?anchor:null;entry.sessions.push(runId);storeSessionValue(projectSessionsKey(id),JSON.stringify(entry.sessions));entry.items.push(run);entry.layout=layoutInsert(entry.layout,runId,target,terminalSplitSide(entry,target));}
  selectProjectTerminal(id,runId,{focus:true});
}
function closeProjectSession(id,runId){
  const entry=shellEntry(id);entry.detailHeld.delete(runId);entry.sessions=entry.sessions.filter(item=>item!==runId);storeSessionValue(projectSessionsKey(id),JSON.stringify(entry.sessions));forgetTerminalPane(entry,runId);updateShell(id);
  const next=entry.selected;if(next&&terminalVisible(id))requestAnimationFrame(()=>{if(entry.selected===next)entry.views.get(next)?.view?.terminal?.focus?.();});
}
// A session is open in one place: the other one shows this card, which offers to bring it over.
function sessionElsewhereCard(key,title,text,actions){const card=document.createElement('div');card.className='session-elsewhere';card.dataset.key=key;card.innerHTML=`<div class="terminal-empty-card"><h2>${esc(title)}</h2><p>${esc(text)}</p><div class="terminal-empty-actions">${actions}</div></div>`;return card;}
// Where the terminal tab holds this task's session: a pane of its running run, or an agent terminal reopened on its provider session.
function taskTerminalPlace(item){
  const entry=projectShells.get(item.projectId);if(!entry)return null;
  const run=state.runs.find(value=>value.id===item.currentRunId);
  if(activeRun(run))return entry.sessions.includes(run.id)&&!entry.detailHeld.has(run.id)?{terminalId:run.id,runId:run.id}:null;
  const ids=new Set([...(item.sessions||[]).map(value=>value.sessionId),run?.sessionId,item.historyResume?.sessionId,item.externalHistory?.sessionId].filter(Boolean).map(value=>value.toLowerCase()));
  const terminal=entry.items.find(value=>!value.taskId&&value.terminalKind==='agent'&&value.status==='running'&&value.sessionId&&ids.has(value.sessionId.toLowerCase()));
  return terminal?{terminalId:terminal.id}:null;
}
function showTerminalPane(id,terminalId){localStorage.setItem(`aiws.project-tab.${id}`,'terminal');projectId=id;selectedTaskId=null;selectedHistory=null;render();selectProjectTerminal(id,terminalId,{focus:true});}
// The pane gives up its terminal view; the task detail keeps its own.
function moveSessionToDetail(id,runId){const entry=shellEntry(id),pane=entry.views.get(runId);entry.detailHeld.add(runId);pane?.view?.destroy();if(pane){pane.view=null;pane.run=null;}render();}
function moveSessionToTerminal(id,runId){shellEntry(id).detailHeld.delete(runId);showTerminalPane(id,runId);}
// A reopened agent terminal owns the provider process: it closes and the task resumes the same session.
async function takeTerminalSessionToTask(item,terminalId){
  const entry=shellEntry(item.projectId);entry.version++;
  await api(`/projects/${item.projectId}/terminals/${terminalId}`,'DELETE');forgetTerminalPane(entry,terminalId);
  const response=await api(`/tasks/${item.id}/resume-session`,'POST',{});if(selectedTaskId===item.id)detailTab=response.run?.terminalMode==='pty'?'terminal':'console';await refresh();
}
// The task detail's side of the same choice.
function syncConsoleElsewhere(item,host){
  const place=taskTerminalPlace(item),t=globalThis.AIWSI18n.text;let note=host.querySelector(':scope > .session-elsewhere');
  host.classList.toggle('console-elsewhere',Boolean(place));
  if(!place){if(note){note.remove();for(const view of terminalViews)if(host.contains(view.element))view.resize();}return;}
  if(note?.dataset.key===place.terminalId)return;
  note?.remove();
  note=sessionElsewhereCard(place.terminalId,t('Bu oturum terminal ekranında açık'),t('Oturum şu an Terminal sekmesinde. Buraya aktarmak ister misin?'),`<button type="button" class="button primary" data-session-to-detail>${esc(t('Buraya aktar'))}</button><button type="button" class="button" data-session-show-terminal>${esc(t('Terminale git'))}</button>`);
  note.querySelector('[data-session-to-detail]').addEventListener('click',async event=>{event.currentTarget.disabled=true;if(place.runId)moveSessionToDetail(item.projectId,place.runId);else try{await takeTerminalSessionToTask(item,place.terminalId);}catch(error){toast(error.message);void loadProjectShells(item.projectId);}});
  note.querySelector('[data-session-show-terminal]').addEventListener('click',()=>showTerminalPane(item.projectId,place.terminalId));
  host.prepend(note);
}
// Keeps the session items on the runs in the state. It waits for the terminal list, as a saved layout also names the terminals still loading.
function syncProjectSessions(id,entry){
  if(!entry.loaded)return;
  const runs=entry.sessions.map(runId=>state.runs.find(run=>run.id===runId)).filter(Boolean);
  if(runs.length!==entry.sessions.length){entry.sessions=runs.map(run=>run.id);storeSessionValue(projectSessionsKey(id),JSON.stringify(entry.sessions));}
  for(const item of [...entry.items])if(item.taskId&&!entry.sessions.includes(item.id))forgetTerminalPane(entry,item.id);
  entry.items=[...entry.items.filter(item=>!item.taskId),...runs];
}
// placement docks the new terminal on a side of a pane; otherwise it opens beside the focused one. path creates it elsewhere, such as a run session reopened in its workspace.
async function openProjectTerminal(id,spec,placement=null,path=`/projects/${id}/terminals`){
  const entry=shellEntry(id);if(projectTerminalCount(entry)>=8){toast(globalThis.AIWSI18n.text('Yeni terminal açmadan önce birini kapat (proje başına en fazla 8).'));return;}
  const pending={id:`pending_${Date.now()}_${Math.random()}`,provider:spec.kind==='agent'||spec.kind==='login'?spec.provider:'command'},anchor=entry.selected;entry.pending.push(pending);entry.version++;updateShell(id);
  try{const run=await api(path,'POST',spec);if(!entry.items.some(item=>item.id===run.id))entry.items.push(run);
    if(!layoutIds(entry.layout).includes(run.id)){const target=placement?.target??(layoutIds(entry.layout).includes(anchor)?anchor:null);entry.layout=layoutInsert(entry.layout,run.id,target,placement?.side||terminalSplitSide(entry,target));}entry.loaded=true;entry.pending=entry.pending.filter(item=>item!==pending);selectProjectTerminal(id,run.id,{focus:true});return run;}
  catch(error){toast(error.message);return null;}
  finally{entry.pending=entry.pending.filter(item=>item!==pending);updateShell(id);}
}
// Closing kills the shell or agent and its process tree; the pane goes away at once.
async function closeProjectTerminal(id,runId,confirmed=false){
  const entry=shellEntry(id),target=entry.items.find(run=>run.id===runId);if(!target)return;
  if(target.taskId){closeProjectSession(id,runId);return;}
  if(!confirmed&&target.status==='running'&&!await confirmModal(globalThis.AIWSI18n.text('Terminal kapatılsın mı?'),globalThis.AIWSI18n.text('Çalışan işlemler sonlandırılır.'),{confirmLabel:globalThis.AIWSI18n.text('Terminali kapat'),danger:true}))return;
  entry.version++;forgetTerminalPane(entry,runId);updateShell(id);
  const next=entry.selected;if(next&&terminalVisible(id))requestAnimationFrame(()=>{if(entry.selected===next)entry.views.get(next)?.view?.terminal?.focus?.();});
  try{await api(`/projects/${id}/terminals/${runId}`,'DELETE');}catch(error){toast(error.message);void loadProjectShells(id);}
}
// Closes every terminal of the project after one confirmation; task sessions only leave their panes and keep running.
async function closeAllProjectTerminals(id,confirmed=false){
  const entry=shellEntry(id),ids=entry.items.filter(run=>!run.taskId).map(run=>run.id);if(!entry.items.length)return;
  if(!confirmed&&ids.length&&!await confirmModal(globalThis.AIWSI18n.text('Tüm terminaller kapatılsın mı?'),globalThis.AIWSI18n.text('Çalışan işlemler sonlandırılır.'),{confirmLabel:globalThis.AIWSI18n.text('Tümünü kapat'),danger:true}))return;
  entry.version++;for(const run of [...entry.items])forgetTerminalPane(entry,run.id);entry.sessions=[];storeSessionValue(projectSessionsKey(id),'[]');updateShell(id);
  const results=await Promise.allSettled(ids.map(runId=>api(`/projects/${id}/terminals/${runId}`,'DELETE')));
  const failed=results.find(result=>result.status==='rejected');if(failed){toast(failed.reason.message);void loadProjectShells(id);}
}
async function restartProjectTerminal(id,runId){
  const entry=shellEntry(id),run=entry.items.find(item=>item.id===runId);if(!run||run.status==='running'&&run.terminalKind!=='script'||entry.busy)return;
  entry.busy=true;entry.version++;updateShell(id);
  try{const next=await api(`/projects/${id}/terminals/${runId}/restart`,'POST',{});Object.assign(run,next);}catch(error){toast(error.message);}finally{entry.busy=false;updateShell(id);if(runId===entry.selected)entry.views.get(runId)?.view.terminal?.focus?.();}
}
// The agent's conversation continues as a running task: the terminal closes and the task opens on its terminal tab.
async function convertProjectTerminal(id,runId){
  const entry=shellEntry(id);if(entry.busy||!entry.items.some(item=>item.id===runId))return;
  entry.busy=true;updateShell(id);
  try{const response=await api(`/projects/${id}/terminals/${runId}/task`,'POST',{});entry.version++;forgetTerminalPane(entry,runId);
    localStorage.setItem(`aiws.project-tab.${id}`,'board');projectId=id;selectedTaskId=response.task.id;selectedHistory=null;detailTab=response.run?.terminalMode==='pty'?'terminal':'console';render();
    toast(response.run?globalThis.AIWSI18n.text('Oturum görev olarak devam ediyor'):globalThis.AIWSI18n.text('Oturum görev olarak sıraya alındı'));}
  catch(error){toast(error.message);}
  finally{entry.busy=false;updateShell(id);}
}
// workspace is where the pane shows: the project's Terminal tab or the All projects one.
function startTerminalRename(id,runId,workspace=shellEntry(id)){
  const entry=workspace,run=shellEntry(id).items.find(item=>item.id===runId),title=entry.element.querySelector(`[data-terminal-title="${CSS.escape(runId)}"]`);if(!run||!title)return;
  // A task session takes its name from the task.
  if(run.taskId){selectProjectTerminal(id,runId,{focus:true});return;}
  entry.renaming=runId;const input=document.createElement('input');input.className='terminal-rename';input.value=terminalTitles(shellEntry(id).items.filter(item=>!item.taskId)).get(runId)||'';input.maxLength=80;input.setAttribute('aria-label',globalThis.AIWSI18n.text('Terminal adı'));
  const label=title.querySelector('.terminal-tab-title');label.replaceChildren(input);input.focus();input.select();
  const refresh=()=>{const pane=entry.views.get(runId);if(pane)pane.head='';updateShell(id);};
  let done=false;const finish=async save=>{if(done)return;done=true;entry.renaming=null;const value=input.value.trim();if(save&&value&&value!==run.title){const previous=run.title;run.title=value;refresh();try{Object.assign(run,await api(`/projects/${id}/terminals/${runId}`,'PATCH',{title:value}));}catch(error){run.title=previous;toast(error.message);}}refresh();entry.element.querySelector(`[data-terminal-title="${CSS.escape(runId)}"]`)?.focus();};
  input.addEventListener('keydown',event=>{event.stopPropagation();if(event.key==='Enter'){event.preventDefault();void finish(true);}if(event.key==='Escape'){event.preventDefault();void finish(false);}});
  input.addEventListener('blur',()=>void finish(true));input.addEventListener('click',event=>event.stopPropagation());
}
function updateShell(id){
  const entry=shellEntry(id),element=entry.element,project=state.projects.find(item=>item.id===id)||(isGeneralProject(id)?state.generalWorkspace:undefined);
  syncProjectSessions(id,entry);
  // While only the All projects tab shows the terminals, this workspace keeps its data and draws no second set of views.
  if(allTerminalsVisible()&&!workspaceHasFloatingConsole(entry)){updateSessionTerminals();return;}
  renderTerminalPanes(entry);
  const selected=entry.items.find(item=>item.id===entry.selected);
  syncTerminalQuick(entry);
  syncTerminalMenu(entry,()=>terminalMenuHtml(terminalSessionItems(projectSessionRuns(id),entry.sessions)));
  // Sessions stay reachable once the project's terminals are at their limit.
  element.querySelector('[data-terminal-menu]').disabled=projectTerminalCount(entry)>=8&&!projectSessionRuns(id).length;
  // Path and status of the focused terminal.
  const path=selected?.workspacePath||project?.repositoryPath||'',pathElement=element.querySelector('[data-shell-path]');pathElement.textContent=path;pathElement.title=path;
  element.querySelector('[data-shell-status]').textContent=entry.error||(!entry.loaded&&entry.loading?globalThis.AIWSI18n.text('Terminal yükleniyor…'):entry.busy?globalThis.AIWSI18n.text('İşleniyor…'):entry.pending.length?globalThis.AIWSI18n.text('Terminal açılıyor…'):!selected||selected.taskId||selected.status==='running'?'':globalThis.AIWSI18n.template`Terminal kapandı · Çıkış kodu: ${selected.exitCode}`);
  const close=element.querySelector('[data-shell-close]');close.hidden=!entry.items.length;
  // Empty state
  const empty=element.querySelector('[data-terminal-empty]'),showEmpty=!entry.items.length&&!entry.pending.length&&(entry.loaded||!entry.loading);empty.hidden=!showEmpty;
  if(showEmpty){const html=terminalEmptyHtml();if(entry.emptyHtml!==html){empty.innerHTML=html;entry.emptyHtml=html;}}
}
async function loadProjectShells(id){const entry=shellEntry(id);if(entry.loading)return;entry.loading=true;const version=entry.version;if(terminalVisible(id))updateShell(id);try{const items=await api(`/projects/${id}/terminals`);if(entry.version!==version)return;const previous=new Map(entry.items.map(run=>[run.id,run]));entry.items=[...items.map(run=>{const known=previous.get(run.id);return known&&JSON.stringify(known)===JSON.stringify(run)?known:run;}),...entry.items.filter(run=>run.taskId)];for(const run of entry.items)if(run.terminalKind==='login'&&run.status!=='running'&&previous.has(run.id)&&previous.get(run.id)!==run)void loadProviderAccounts(run.provider,true);for(const runId of [...entry.views.keys()])if(!entry.items.some(run=>run.id===runId))forgetTerminalPane(entry,runId);entry.error='';entry.loaded=true;}catch(error){entry.error=error.message;}finally{entry.loading=false;if(entry.version!==version&&!entry.loaded)void loadProjectShells(id);else if(terminalVisible(id)||allTerminalsVisible()||workspaceHasFloatingConsole(entry))updateShell(id);else scheduleRender();}}
// Opening a project fetches its (in-memory) terminal list early, so the Terminal tab renders at once.
function prefetchProjectShells(id){const entry=shellEntry(id);if(!entry.loaded&&!entry.loading)void loadProjectShells(id);}
