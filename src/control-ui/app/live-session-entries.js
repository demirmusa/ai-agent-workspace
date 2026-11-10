'use strict';
// Live session entries: grouping, filtering and the card markup.
function sessionStatus(run){return activeRun(run)?{className:run.status==='running'?'running':'waiting',label:statuses[run.status]}:{className:run.status==='failed'?'failed':'exited',label:statuses[run.status]||run.status};}
// Sessions group by what they need from the user: an answer, nothing (working), or nothing known.
const sessionGroups=[{state:'needs',label:'Seni bekliyor',dot:'needs'},{state:'running',label:'Çalışıyor',dot:'running'},{state:'other',label:'Duraklatılan ve durumu bilinmeyen',dot:''}];
function sessionEntries(){
  const t=globalThis.AIWSI18n.text,questions=activeInputRequests();
  const runs=sessionRuns().map(run=>{
    const item=state.tasks.find(task=>task.id===run.taskId),project=state.projects.find(value=>value.id===item?.projectId),question=questions.find(value=>value.runId===run.id);
    const group=question||run.status==='waiting'?'needs':run.status==='paused'?'other':'running';
    return {key:run.id,run,item,project,question,group,provider:run.provider,title:consoleTitle(run),place:project?.name||'',agent:runAgentName(run),
      tone:group==='other'?'idle':group,label:question?t(question.kind==='approval'?'Onay bekliyor':'Soru soruyor'):statuses[run.status]};
  });
  const external=externalSessions().map(item=>{
    const group=item.activity==='working'?'running':item.activity==='idle'?'needs':'other';
    return {key:`external:${item.id}`,external:item,group,provider:item.provider,title:item.title||t('Adsız oturum'),place:item.projectName||item.cwd.split(/[\\/]/).filter(Boolean).at(-1)||item.cwd,agent:providers[item.provider],
      tone:group==='other'?'idle':group,label:group==='running'?t('Çalışıyor'):group==='needs'?t('Girdi bekliyor'):t('Durum bilinmiyor')};
  });
  return [...runs,...external];
}
const sessionMatches=(entry,value)=>!value||[entry.title,entry.place,entry.agent].some(text=>String(text||'').toLocaleLowerCase().includes(value));
// The latest ended run of each task that finished in the last day.
function recentSessionRuns(){const since=Date.now()-864e5,seen=new Set();return state.runs.filter(run=>!activeRun(run)&&run.finishedAt&&Date.parse(run.finishedAt)>=since).sort((a,b)=>b.finishedAt.localeCompare(a.finishedAt)).filter(run=>!seen.has(run.taskId)&&seen.add(run.taskId)).slice(0,8);}
function sessionCard(entry,open){
  const t=globalThis.AIWSI18n,run=entry.run,external=entry.external,arrow=window.AIWSUI.icon('arrow-right');
  const body=entry.question?`<p class="session-card-question">${window.AIWSUI.icon('clock')}<span>${esc(entry.question.text)}</span></p>`:external?`<p class="session-card-activity is-path" title="${esc(external.cwd)}">${esc(external.cwd)}</p>`:`<p class="session-card-activity">${esc(entry.item?activity(entry.item):statuses[run.status])}</p>`;
  const foot=external?t.template`<span class="ui-chip">Harici · Salt okunur</span><time title="${esc(dateTime(external.updatedAt))}">${esc(relative(external.updatedAt))}</time><span class="session-card-action">Konuşmayı izle ${arrow}</span>`
    :t.template`<time data-run-timer="${esc(run.id)}" title="Çalışma süresi"></time>${open?t.text('<span class="ui-chip is-accent">Terminalde açık</span>'):''}<span class="session-card-action">${open?t.text('Terminale git'):t.text('Terminalde aç')} ${arrow}</span><button type="button" class="button small ghost" data-open-task="${esc(run.taskId)}">Görevi aç</button>`;
  return `<article class="session-card ui-card is-interactive${open?' is-open':''}" role="button" tabindex="0" data-tone="${entry.tone}" data-session-card="${esc(entry.key)}" aria-label="${esc(entry.title)}, ${esc(entry.label)}"><header class="session-card-head">${terminalIcon(entry.provider)}<span class="session-card-title"><strong>${esc(entry.title)}</strong><small>${esc([entry.place,entry.agent].filter(Boolean).join(' · '))}</small></span>${window.AIWSUI.statusPill(entry.tone,entry.label)}</header>${body}<footer class="session-card-foot">${foot}</footer></article>`;
}
function sessionOverviewHtml(entry,entries,open){
  const t=globalThis.AIWSI18n,value=entry.query.trim().toLocaleLowerCase(),count=group=>entries.filter(item=>item.group===group).length,externalCount=entries.filter(item=>item.external).length;
  const filter=(name,dot,label,amount,detail,alert=false)=>statTile(dot,label,amount,detail,{alert,attributes:`data-session-filter="${name}" aria-pressed="${entry.filter===name}"`});
  const scanning=liveSessions.loading&&!liveSessions.loaded?t.text('Harici oturumlar aranıyor…'):'';
  const stats=`<section class="overview-stats session-stats" aria-label="${esc(t.text('Oturum filtreleri'))}">${[
    filter('all','ready',t.text('Tüm canlı oturumlar'),entries.length,statProviders(entries.map(item=>item.provider))||scanning||t.text('Şu an oturum yok')),
    filter('needs','needs',t.text('Seni bekliyor'),count('needs'),count('needs')?t.text('Soru, onay veya girdi bekliyor'):t.text('Bekleyen oturum yok'),count('needs')>0),
    filter('running','running',t.text('Çalışıyor'),count('running'),t.text('Agent şu an çalışıyor')),
    filter('external','review',t.text('Harici CLI'),externalCount,scanning||t.text('AIWS dışında açılan, salt okunur'))
  ].join('')}</section>`;
  const visible=entries.filter(item=>sessionMatches(item,value)&&(entry.filter==='all'||(entry.filter==='external'?item.external:item.group===entry.filter)));
  const grid=items=>`<div class="session-grid">${items.map(item=>sessionCard(item,Boolean(item.run&&open.includes(item.run.id)))).join('')}</div>`;
  const groups=entry.filter==='all'?sessionGroups.map(group=>({...group,items:visible.filter(item=>item.group===group.state)})).filter(group=>group.items.length).map(group=>`<section class="session-group" aria-label="${esc(t.text(group.label))}"><h2>${group.dot?`<span class="column-dot ${group.dot}"></span>`:''}${t.text(group.label)}<span>${group.items.length}</span></h2>${grid(group.items)}</section>`).join(''):visible.length?grid(visible):'';
  const recent=entry.filter==='all'?recentSessionRuns().filter(run=>sessionMatches({title:consoleTitle(run),agent:providers[run.provider]},value)):[];
  const recentHtml=recent.length?t.template`<section class="session-group" aria-label="Bugün biten"><h2><span class="column-dot done"></span>Bugün biten<span>${recent.length}</span></h2><div class="session-recent">${recent.map(run=>{const status=sessionStatus(run),item=state.tasks.find(task=>task.id===run.taskId),place=state.projects.find(project=>project.id===item?.projectId)?.name;return `<button type="button" class="session-recent-row" data-open-task="${esc(run.taskId)}">${terminalIcon(run.provider)}<span class="session-card-title"><strong>${esc(consoleTitle(run))}</strong><small>${esc([place,runAgentName(run)].filter(Boolean).join(' · '))}</small></span>${window.AIWSUI.statusPill(run.status,status.label)}<time data-run-timer="${esc(run.id)}"></time></button>`;}).join('')}</div></section>`:'';
  const empty=!entries.length&&!recent.length?t.template`<div class="session-empty"><div class="terminal-empty-glyph" aria-hidden="true">&gt;_</div><h2>Çalışan oturum yok</h2><p>Bir agent görevi başladığında ya da Codex veya Claude Code terminalinde bir oturum açtığında burada görünür.</p></div>`
    :!groups&&!recentHtml?`<p class="session-filter-empty">${value?t.text('Aramaya uyan oturum yok.'):t.text('Bu filtrede oturum yok.')}</p>`:'';
  const notices=`${liveSessions.error?`<p class="history-error" role="alert">${esc(liveSessions.error)}</p>`:''}${liveSessions.warnings.length?t.template`<details class="history-warnings"><summary>Harici oturum keşfi</summary>${liveSessions.warnings.map(warning=>`<p>${esc(warning)}</p>`).join('')}</details>`:''}`;
  return stats+notices+groups+recentHtml+empty;
}
function sessionRuns(){return state.runs.filter(activeRun).sort((a,b)=>b.startedAt.localeCompare(a.startedAt));}
