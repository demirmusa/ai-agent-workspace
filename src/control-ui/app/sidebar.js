'use strict';
// The sidebar: workspace views, the project list with open task counts and its archive, the library entries, collapsing, and the accent mark
// that glides to the active entry.
function openTaskCounts(){const counts=new Map();for(const t of state.tasks)if(!t.archivedAt&&!t.sessionContinuation&&!['done','cancelled'].includes(t.status))counts.set(t.projectId,(counts.get(t.projectId)||0)+1);return counts;}
function generalWorkspaceNavHtml(general,active,count){
  return `<button class="nav-item general-workspace-item ${active?'active':''}" id="workspace-nav" title="${esc(globalThis.AIWSI18n.text('Projelerden bağımsız, zamanlanmış ve tekrarlanan işler'))}" ${active?'aria-current="page"':''}><span class="project-icon" aria-hidden="true">${window.AIWSUI.icon('clock')}</span><span class="project-name">${esc(globalThis.AIWSI18n.text('Genel çalışma alanı'))}</span><span id="workspace-count" class="nav-count">${count}</span></button>`;
}
// Two markers: a blinking blue dot while an agent runs, a steady green dot while a terminal is open.
function projectStatusDotsHtml(id){
  const dot=(live,tone,text)=>`<span class="ui-dot${live?' is-live':''}" data-tone="${tone}" role="img" aria-label="${esc(text)}" title="${esc(text)}"></span>`,t=globalThis.AIWSI18n;
  const html=(projectsWithRunningAgents().has(id)?dot(true,'running',t.text('Agent çalışıyor')):'')+(projectTerminalsRunning(id)?dot(false,'done',t.text('Terminal çalışıyor')):'');
  return html?`<span class="project-dots">${html}</span>`:'';
}
function projectNavHtml(item,active,count){
  return `<button class="nav-item ${active?'active':''}" data-project="${esc(item.id)}" draggable="true" ${active?'aria-current="page"':''}><span class="project-icon" aria-hidden="true">${esc(item.name.slice(0,2).toUpperCase())}</span><span class="project-name">${esc(item.name)}</span>${projectStatusDotsHtml(item.id)}<span class="nav-count">${count}</span></button>`;
}
function renderSidebar(){
  const current=project(),counts=openTaskCounts(),general=state.generalWorkspace;
  // A project is the active entry only on its own board; other screens mark their own entry.
  const onBoard=activeScreen==='board',generalItem=general?generalWorkspaceNavHtml(general,onBoard&&Boolean(current?.general),counts.get(general.id)||0):'';
  const listed=[],archived=[];for(const item of state.projects)(isProjectArchived(item.id)?archived:listed).push(projectNavHtml(item,onBoard&&item.id===projectId,counts.get(item.id)||0));
  setHtml($('#project-list'),generalItem+listed.join('')+projectArchiveHtml(archived));
  $('#agents-count').textContent=state.agents.length; $('#skills-count').textContent=state.skills.length; $('#workflows-count').textContent=(state.workflows||[]).length;
  for(const [id,screen] of [['agents-nav','agents'],['skills-nav','skills'],['dashboard-nav','dashboard'],['overview-nav','overview'],['workflows-nav','workflows']])$('#'+id).classList.toggle('active',activeScreen===screen);
  $('#settings-button').classList.toggle('active',activeScreen==='settings');if(activeScreen==='settings')$('#settings-button').setAttribute('aria-current','page');else $('#settings-button').removeAttribute('aria-current');
}
// The accent mark beside the active sidebar entry glides from the previous entry within one list and pops in elsewhere. The old
// position is read only when navigation changes, before the render replaces the list.
let sidebarNavKey='';
const sidebarNavTarget=()=>({dashboard:'dashboard-nav',overview:'overview-nav',agents:'agents-nav',skills:'skills-nav',workflows:'workflows-nav'})[activeScreen]||(activeScreen==='board'&&project()?(project().general?'workspace-nav':`project:${projectId}`):window.AIWSPlugins?.isPage(activeScreen)?activeScreen:'');
function sidebarNavFrom(){const key=sidebarNavTarget();if(key===sidebarNavKey)return null;sidebarNavKey=key;const previous=$('.sidebar .nav-item.active');return previous?{top:previous.getBoundingClientRect().top,list:previous.parentElement}:{};}
function moveSidebarNavMark(from){
  const active=from?.list&&$('.sidebar .nav-item.active');if(!active||window.AIWSUI.reducedMotion()||typeof active.animate!=='function')return;
  const offset=from.top-active.getBoundingClientRect().top,root=getComputedStyle(document.documentElement),keyframes=from.list===active.parentElement&&offset?[{transform:`translateY(${offset}px)`},{transform:'none'}]:[{opacity:0,transform:'scaleY(.3)'},{opacity:1,transform:'none'}];
  try{active.animate(keyframes,{duration:Number.parseFloat(root.getPropertyValue('--dur-slow'))||280,easing:root.getPropertyValue('--ease-out').trim()||'ease-out',pseudoElement:'::before'});}catch{/* Without pseudo-element animation the mark simply appears. */}
}
$('#dashboard-nav').onclick=()=>switchScreen('dashboard');$('#overview-nav').onclick=()=>switchScreen('overview');$('#workflows-nav').onclick=()=>switchScreen('workflows');$('#settings-button').onclick=()=>switchScreen('settings');
$('#create-project').onclick=()=>projectModal();
$('#sidebar-toggle').onclick=()=>{const shell=$('.app-shell');shell.classList.toggle('sidebar-collapsed');const collapsed=shell.classList.contains('sidebar-collapsed');try{localStorage.setItem('aiws.sidebar-collapsed',String(collapsed));}catch{/* Storage may be disabled. */}$('#sidebar-toggle').setAttribute('aria-expanded',String(!collapsed));applyDetailWidth();};
if(localStorage.getItem('aiws.sidebar-collapsed')==='true'){$('.app-shell').classList.add('sidebar-collapsed');$('#sidebar-toggle').setAttribute('aria-expanded','false');}
document.addEventListener('click',event=>{if(event.target.closest('#workspace-nav'))openGeneralWorkspace();});
// The desktop app offers a native context menu for projects.
// A workspace row's context menu: reveal its folder, copy its path and, in the desktop app, open it in another window.
document.addEventListener('contextmenu',event=>{const item=event.target.closest?.('[data-project]');if(!item)return;event.preventDefault();const id=item.dataset.project,{showMenu,revealLabel}=window.AIWSFiles,t=globalThis.AIWSI18n,path=state.projects.find(entry=>entry.id===id)?.repositoryPath;
  showMenu(event.clientX,event.clientY,[...(window.aiwsDesktop?.openProjectWindow?[{label:t.text('Yeni pencerede aç'),run:()=>window.aiwsDesktop.openProjectWindow(id).catch(()=>{})}]:[]),
    {label:revealLabel(),run:()=>api(`/projects/${encodeURIComponent(id)}/files/open`,'POST',{path:'',action:'reveal'}).catch(error=>toast(error.message))},
    {label:t.text(isProjectArchived(id)?'Arşivden çıkar':'Arşive taşı'),run:()=>{setProjectArchived(id,!isProjectArchived(id));renderSidebar();}},
    ...(path?[{label:t.text('Proje yolunu kopyala'),run:async()=>toast(await copyText(path)?t.text('Yol kopyalandı'):t.text('Kopyalanamadı'))}]:[])],item);});
