'use strict';
// The Terminal tab of All projects: the project Terminal tab's workspace showing the terminals of every project and the
// task sessions opened here. Project terminals stay owned by their project (project-terminals.js); this workspace shows
// them in panes of its own and sends their actions to the owner. Closing a session's pane only hides it.
const allTerminalsVisible=()=>activeScreen==='overview'&&overviewTab()==='terminal';
function terminalOwnerId(runId){for(const [id,entry] of projectShells)if(entry.items.some(item=>item.id===runId&&!item.taskId))return id;return null;}
const terminalItemProject=item=>item?.taskId?state.tasks.find(task=>task.id===item.taskId)?.projectId:terminalOwnerId(item?.id);
const saveSessionTerminals=entry=>storeSessionValue('aiws.session-terminals',JSON.stringify(entry.open));
function sessionTerminals(){
  if(sessionWorkspace)return sessionWorkspace;
  const element=document.createElement('section');element.className='project-terminal session-terminal';element.innerHTML=terminalShellHtml();
  element.querySelector('[data-terminal-grid]').setAttribute('aria-label',globalThis.AIWSI18n.text('Tüm proje terminalleri'));
  const plain=item=>plainTerminalParts(terminalOwnerId(item.id));
  const entry=terminalWorkspace(element,{storageKey:'aiws.session-terminal-layout',update:updateSessionTerminals,titles:allTerminalTitles,
    status:item=>item.taskId?sessionStatus(item):terminalStatus(item),content:(item,host)=>item.taskId?runPaneParts.content(item,host):false,
    paneClose:(item,title)=>item.taskId?runPaneParts.close(item,title):plain(item).close(item,title),
    paneHead:(item,title,status,multiple)=>item.taskId?runPaneParts.head(item,title,status,multiple):plain(item).head(item,title,status,multiple),
    exitHtml:(item,status)=>item.taskId?runPaneParts.exit(item,status):plain(item).exit(item,status),
    terminal:item=>item.taskId?runTerminalOptions(item):plain(item).terminal(item),close:closeSessionTerminal,
    rename:runId=>{const owner=terminalOwnerId(runId);if(owner)startTerminalRename(owner,runId,sessionWorkspace);else selectTerminal(sessionWorkspace,runId,{focus:true});},
    restart:runId=>{const owner=terminalOwnerId(runId);if(owner)return restartProjectTerminal(owner,runId);},
    toTask:runId=>{const owner=terminalOwnerId(runId);if(owner)return convertProjectTerminal(owner,runId);}});
  // Runs that ended while the page was closed are not reopened.
  let saved=null;try{saved=JSON.parse(localStorage.getItem('aiws.session-terminals')||'null');}catch{saved=null;}
  Object.assign(entry,{root:element,loaded:false,emptyHtml:'',menuHtml:'',open:Array.isArray(saved)?saved.filter(id=>typeof id==='string'&&activeRun(state.runs.find(run=>run.id===id))):[]});
  element.addEventListener('click',event=>{
    const target=event.target.closest('button');if(!target||target.disabled)return;
    if(target.hasAttribute('data-terminal-menu'))setTerminalMenu(entry);
    else if(target.dataset.terminalOpen){setTerminalMenu(entry,false);const [kind,provider,account]=target.dataset.terminalOpen.split(':');if(kind==='session')openSessionTerminal(provider);else void openAllProjectTerminal(kind==='agent'||kind==='login'?{kind,provider,...(account?{account}:{})}:{kind:'shell'});}
    else if(target.hasAttribute('data-terminal-agents-refresh')){void loadTerminalAgents(true);updateSessionTerminals();}
    else if(target.hasAttribute('data-shell-close'))void closeAllSessionTerminals();
  });
  element.querySelector('[data-terminal-menu-list]').addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setTerminalMenu(entry,false);element.querySelector('[data-terminal-menu]').focus();return;}
    window.AIWSUI.menuNavigate(event,event.currentTarget);
  });
  sessionWorkspace=entry;return entry;
}
// Panes name their project, as terminals of different projects sit side by side.
function allTerminalTitles(items){
  const own=new Map();for(const [,shell] of projectShells)for(const [id,title] of terminalTitles(shell.items.filter(item=>!item.taskId)))own.set(id,title);
  return new Map(items.map(item=>{const name=state.projects.find(value=>value.id===terminalItemProject(item))?.name,title=item.taskId?consoleTitle(item):own.get(item.id);return [item.id,name?`${name} · ${title}`:title];}));
}
// A new terminal opens in the focused pane's project, then the open project.
function allTerminalTarget(){
  const entry=sessionTerminals(),known=id=>state.projects.some(item=>item.id===id)?id:null;
  return known(terminalItemProject(entry.items.find(item=>item.id===entry.selected)))||known(projectId)||state.projects[0]?.id||null;
}
function allTerminalMenuHtml(){
  const target=allTerminalTarget(),t=globalThis.AIWSI18n.text;if(!target)return `<p class="terminal-menu-empty">${esc(t('Başlamak için ilk projeni oluştur.'))}</p>`;
  const projects=new Set(state.projects.map(item=>item.id)),runs=sessionRuns().filter(run=>projects.has(state.tasks.find(task=>task.id===run.taskId)?.projectId));
  return terminalMenuHtml(terminalSessionItems(runs,sessionTerminals().open,true));
}
async function openAllProjectTerminal(spec,placement=null){
  const entry=sessionTerminals(),target=allTerminalTarget();if(!target)return;
  const run=await openProjectTerminal(target,spec);if(!run)return;
  if(placement&&!layoutIds(entry.layout).includes(run.id))entry.layout=layoutInsert(entry.layout,run.id,placement.target,placement.side);
  selectTerminal(entry,run.id,{focus:true});
}
function updateSessionTerminals(){
  const entry=sessionTerminals(),element=entry.element,before=JSON.stringify(entry.open),t=globalThis.AIWSI18n;
  entry.open=entry.open.filter(id=>state.runs.some(run=>run.id===id));if(JSON.stringify(entry.open)!==before)saveSessionTerminals(entry);
  const shells=state.projects.map(item=>projectShells.get(item.id));
  entry.items=[...shells.flatMap(shell=>shell?.items.filter(item=>!item.taskId)||[]),...entry.open.map(id=>state.runs.find(run=>run.id===id))];
  for(const runId of [...entry.views.keys()])if(!entry.items.some(item=>item.id===runId)){const items=entry.items;forgetTerminalPane(entry,runId);entry.items=items;}
  // A saved layout also names terminals still loading; it is applied once every project has answered.
  entry.loaded=shells.every(shell=>shell&&(shell.loaded||shell.error));
  if(entry.loaded||entry.items.length)renderTerminalPanes(entry);
  const selected=entry.items.find(item=>item.id===entry.selected),project=state.projects.find(item=>item.id===terminalItemProject(selected));
  const path=selected?.workspacePath||project?.repositoryPath||'',pathElement=element.querySelector('[data-shell-path]');pathElement.textContent=path;pathElement.title=path;
  element.querySelector('[data-shell-status]').textContent=selected?[project?.name,(selected.taskId?sessionStatus(selected):terminalStatus(selected)).label].filter(Boolean).join(' · '):'';
  element.querySelector('[data-shell-close]').hidden=!entry.items.length;element.querySelector('[data-terminal-menu]').disabled=!state.projects.length;
  syncTerminalQuick(entry);
  syncTerminalMenu(entry,allTerminalMenuHtml);
  const empty=element.querySelector('[data-terminal-empty]'),showEmpty=!entry.items.length&&entry.loaded;empty.hidden=!showEmpty;
  if(showEmpty){const html=t.template`<div class="terminal-empty-card"><div class="terminal-empty-glyph" aria-hidden="true">&gt;_</div><h2>Açık terminal yok</h2><p>Projelerinde açtığın terminaller burada toplanır. + ile bir projede yeni terminal aç ya da canlı bir oturumu buraya getir.</p><div class="terminal-empty-actions"><button type="button" class="button" data-overview-tab="sessions">Canlı oturumlar</button></div></div>`;if(entry.emptyHtml!==html){empty.innerHTML=html;entry.emptyHtml=html;}}
}
// Opens a task session in a pane and shows the tab.
function openSessionTerminal(runId){
  const entry=sessionTerminals();if(!state.runs.some(run=>run.id===runId))return;
  if(!entry.open.includes(runId)){const placed=layoutIds(entry.layout),target=placed.includes(entry.selected)?entry.selected:placed.at(-1)||null;entry.open.push(runId);entry.layout=layoutInsert(entry.layout,runId,target,terminalSplitSide(entry,target));saveSessionTerminals(entry);}
  showOverviewTab('terminal');selectTerminal(entry,runId,{focus:true});
}
function closeSessionTerminal(runId){
  const entry=sessionTerminals(),owner=terminalOwnerId(runId);
  if(owner)return closeProjectTerminal(owner,runId);
  if(!entry.open.includes(runId))return;
  entry.open=entry.open.filter(id=>id!==runId);saveSessionTerminals(entry);forgetTerminalPane(entry,runId);updateSessionTerminals();
  const next=entry.selected;if(next)requestAnimationFrame(()=>{if(entry.selected===next)entry.views.get(next)?.view?.terminal?.focus?.();});
}
// One confirmation closes the terminals of every project; task sessions only leave their panes and keep running.
async function closeAllSessionTerminals(){
  const entry=sessionTerminals(),owners=state.projects.map(item=>item.id).filter(id=>projectShells.get(id)?.items.some(item=>!item.taskId));
  if(owners.length&&!await confirmModal(globalThis.AIWSI18n.text('Tüm terminaller kapatılsın mı?'),globalThis.AIWSI18n.text('Çalışan işlemler sonlandırılır.'),{confirmLabel:globalThis.AIWSI18n.text('Tümünü kapat'),danger:true}))return;
  for(const runId of entry.open)forgetTerminalPane(entry,runId);entry.open=[];saveSessionTerminals(entry);
  await Promise.all(owners.map(id=>closeAllProjectTerminals(id,true)));updateSessionTerminals();
}
function renderAllTerminals(){
  const entry=sessionTerminals(),board=$('#board');board.className='board project-terminal-board session-terminal-board';
  if(entry.element.parentElement!==board)board.replaceChildren(entry.element);
  if(!terminalAgents.items&&!terminalAgents.loading)void loadTerminalAgents();
  updateSessionTerminals();for(const pane of entry.views.values())pane.view?.resize();
}
window.addEventListener('pagehide',()=>{for(const pane of sessionWorkspace?.views.values()||[])pane.view?.destroy();});
