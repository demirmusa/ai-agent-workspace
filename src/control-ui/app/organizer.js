'use strict';
// The backlog organizer run and its report.
// The organizer is an AI agent that orders the backlog against the ready queue; it never opens a board task.
const organizeSeen=new Set(),organizeShown=new Set(),organizeActivity=new Map(),organizeSnapshots=new Map();
const organizeIcon='<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="1.5" width="5" height="3.5" rx="1"/><rect x="9.5" y="6.25" width="5" height="3.5" rx="1"/><rect x="9.5" y="11" width="5" height="3.5" rx="1"/><path d="M4 5v7.75h5.5M4 8h5.5"/></svg>';
const organizeRunning=id=>state.organizations?.[id]?.status==='running';
// While the organizer runs, the tasks it reviews are locked so nobody opens or moves them under it.
const organizeLocked=item=>Boolean(item)&&!item.archivedAt&&['backlog','ready'].includes(item.status)&&organizeRunning(item.projectId);
// A stable per-task offset staggers the scan across the column; tying the
// negative delay to the clock keeps it smooth when the board re-renders.
const organizeDelay=id=>-((Date.now()+[...String(id)].reduce((sum,char)=>(sum*31+char.charCodeAt(0))%997,7)%9*260)%2400);
function organizeButton(){
  const current=state.organizations?.[projectId],busy=current?.status==='running',activity=busy?organizeActivity.get(current.requestId):'';
  const tip=busy?globalThis.AIWSI18n.text('AI işleri sıralıyor… Durdurmak için tıkla'):globalThis.AIWSI18n.text('AI ile sırala: bekleyen ve hazır işleri inceler, bağımlılıkları ve sırayı çıkarır, uygun işleri Hazır durumuna alır');
  return `<button type="button" class="icon-button organize-button${busy?' running':''}" data-organize-tasks="${busy?'cancel':'start'}" aria-label="${esc(tip)}" title="${esc(activity?`${tip}\n${activity}`:tip)}">${busy?'<span class="organize-spinner" aria-hidden="true"></span>':organizeIcon}</button>`;
}
function organizeBanner(){
  const current=state.organizations?.[projectId];if(current?.status!=='running')return '';
  const activity=organizeActivity.get(current.requestId)||globalThis.AIWSI18n.text('Bekleyen ve hazır işler inceleniyor…');
  return `<div class="organize-banner" role="status"><span class="organize-orb" aria-hidden="true"></span><div><strong>${globalThis.AIWSI18n.text('AI işleri sıralıyor')}</strong><span class="organize-activity">${esc(activity)}</span></div></div>`;
}
// The board before the run is kept so the report can show which tasks moved to Ready.
// The organizer works on the milestone the board shows ('' = every milestone, 'none' = tasks without one).
const organizeScope=()=>activeScreen==='board'?milestoneFilter:'';
const organizeInScope=(item,scope)=>!scope||(scope==='none'?!item.milestoneId:item.milestoneId===scope);
function snapshotOrganization(id,requestId,scope=organizeScope()){
  if(organizeSnapshots.has(requestId))return;
  organizeSnapshots.set(requestId,new Map(state.tasks.filter(item=>item.projectId===id&&!item.archivedAt&&['backlog','ready'].includes(item.status)&&organizeInScope(item,scope)).map(item=>[item.id,item.status])));
}
async function runTaskOrganizer(action){
  const id=projectId;if(!id)return;
  try{
    if(action==='cancel'){await api(`/projects/${encodeURIComponent(id)}/organize/cancel`,'POST',{});toast(globalThis.AIWSI18n.text('AI sıralaması durduruluyor; yapılan değişiklikler korunur.'));return;}
    const scope=organizeScope();
    if(!tasks().some(item=>item.status==='backlog'&&!item.archivedAt&&!item.externalDependency&&organizeInScope(item,scope))){toast(globalThis.AIWSI18n.text('Sıralanacak bekleyen iş yok.'));return;}
    const result=await api(`/projects/${encodeURIComponent(id)}/organize`,'POST',scope?{milestoneId:scope}:{});
    organizeSeen.add(result.requestId);snapshotOrganization(id,result.requestId,scope);state.organizations={...state.organizations,[id]:result};
    if(organizeLocked(task()))closePanel();else render();
    aiStartOrganize(id,result);
  }catch(e){toast(e.message);}
}
function organizeProgress(event){
  if(typeof event.activity!=='string')return;organizeActivity.set(event.requestId,event.activity);
  if(state.organizations?.[projectId]?.requestId!==event.requestId)return;
  const button=document.querySelector('[data-organize-tasks="cancel"]');
  if(button)button.title=`${globalThis.AIWSI18n.text('AI işleri sıralıyor… Durdurmak için tıkla')}\n${event.activity}`;
  const line=document.querySelector('.organize-banner .organize-activity');if(line)line.textContent=event.activity;
}
function organizeDuration(item){
  const ms=Date.parse(item.finishedAt)-Date.parse(item.startedAt);if(!(ms>=0))return '';
  return clockDuration(Math.round(ms/1000));
}
function organizeResult(id,item){
  const ok=item.status==='completed',before=organizeSnapshots.get(item.requestId)||new Map();organizeSnapshots.delete(item.requestId);
  const current=state.tasks.filter(task=>task.projectId===id&&!task.archivedAt),moved=current.filter(task=>before.get(task.id)==='backlog'&&task.status==='ready'),waiting=current.filter(task=>task.status==='backlog').length;
  const duration=organizeDuration(item),meta=[providers[item.provider]||item.provider,duration&&`${globalThis.AIWSI18n.text('Süre')} ${duration}`].filter(Boolean).map(esc).join(' · ');
  const hero=`<header class="organize-hero"><span class="organize-hero-icon" aria-hidden="true">${ok?organizeIcon.replace('width="15" height="15"','width="22" height="22"'):'!'}</span><div><strong>${ok?globalThis.AIWSI18n.text('Sıralama tamamlandı'):globalThis.AIWSI18n.text('Sıralama tamamlanamadı')}</strong>${meta?`<p>${meta}</p>`:''}</div></header>`;
  if(!ok)return `<div class="organize-result failed">${hero}<div class="organize-error">${esc(item.error||globalThis.AIWSI18n.text('AI sıralaması bilinmeyen bir hata ile durdu.'))}</div></div>`;
  const stat=(value,label,tone='')=>`<div class="organize-stat ${tone}"><strong>${value}</strong><span>${label}</span></div>`;
  const stats=`<div class="organize-stats">${stat(before.size,globalThis.AIWSI18n.text('İncelenen iş'))}${stat(moved.length,globalThis.AIWSI18n.text('Hazır durumuna alındı'),'accent')}${stat(waiting,globalThis.AIWSI18n.text('Bekleyende kalan'))}</div>`;
  const movedList=moved.length?`<section class="organize-section"><h3>${globalThis.AIWSI18n.text('Hazır durumuna alınan işler')}</h3><ul class="organize-moved">${moved.map(task=>`<li><span class="organize-moved-id">${esc(taskKey(task))}</span><span>${esc(window.AIWSUI.taskTitle(task))}</span></li>`).join('')}</ul></section>`:'';
  const report=`<section class="organize-section"><h3>${globalThis.AIWSI18n.text('AI raporu')}</h3><div class="cv-markdown organize-report">${window.AIWSAgentConsole?.markdown(item.report||'')||esc(item.report||'')}</div></section>`;
  return `<div class="organize-result">${hero}${stats}${movedList}${report}</div>`;
}
// Only organizations this page saw running are reported, so a reload never replays an old report.
function notifyOrganizations(){
  for(const [id,item] of Object.entries(state.organizations||{})){
    if(item.status==='running'){const fresh=!organizeSeen.has(item.requestId);organizeSeen.add(item.requestId);snapshotOrganization(id,item.requestId);if(fresh&&organizeLocked(task()))selectedTaskId=null;continue;}
    if(!organizeSeen.has(item.requestId)||organizeShown.has(item.requestId))continue;
    organizeShown.add(item.requestId);organizeActivity.delete(item.requestId);
    if(item.status==='cancelled'){organizeSnapshots.delete(item.requestId);toast(globalThis.AIWSI18n.text('AI sıralaması durduruldu; yapılan değişiklikler korunur.'));continue;}
    if($('#modal').open||aiVisibleFor(id)){organizeSnapshots.delete(item.requestId);toast(item.status==='completed'?globalThis.AIWSI18n.text('AI sıralaması tamamlandı.'):globalThis.AIWSI18n.template`AI sıralaması başarısız: ${item.error||''}`);continue;}
    const name=state.projects.find(project=>project.id===id)?.name||'';
    showModal(item.status==='completed'?globalThis.AIWSI18n.text('AI iş sıralaması'):globalThis.AIWSI18n.text('AI iş sıralaması başarısız'),organizeResult(id,item),undefined,{size:'wide',description:name});
  }
}
document.addEventListener('click',event=>{const target=event.target.closest('button[data-organize-tasks]');if(target)void runTaskOrganizer(target.dataset.organizeTasks);});
