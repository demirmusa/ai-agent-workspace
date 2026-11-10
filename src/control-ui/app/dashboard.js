'use strict';
// The Dashboard page: totals, charts and analysis of the data gathered from every project, computed in the browser from the state.
const dashboardRanges=[7,14,30];
let dashboardDays=(()=>{try{const saved=Number(localStorage.getItem('aiws.dashboard-range'));return dashboardRanges.includes(saved)?saved:14;}catch{return 14;}})();
const dashboardWeek=7*864e5,dashboardLiveLimit=8,dashboardAgentLimit=6;
// A run's outcome in the activity chart.
const runOutcome=run=>activeRun(run)?'running':run.status==='completed'?'done':run.status==='failed'?'failed':'other';
const successRate=(done,failed)=>done+failed?tokenPercent(done/(done+failed)*100):'—';
const dashboardCost=usage=>usage?.costUsd==null?'—':usageCost(usage);
/** Run and task totals behind the dashboard, rebuilt once per received state and day. */
function dashboardStats(){
  const t=globalThis.AIWSI18n.text,open=state.tasks.filter(item=>!item.archivedAt&&!item.sessionContinuation),count=states=>open.filter(item=>states.includes(item.status)).length;
  const since=Date.now()-864e5,live=state.runs.filter(activeRun),recent=runsUsage(state.runs.filter(run=>new Date(run.startedAt).getTime()>=since));
  const questions=activeInputRequests().length,failed=count(['failed']),done=state.tasks.filter(item=>item.status==='done'&&new Date(item.updatedAt).getTime()>=since).length;
  const usage=recent?usageText(recent):t('kullanım yok');
  const tile=(dot,label,value,detail,alert=false)=>statTile(dot,label,value,detail,{alert});
  return `<section class="overview-stats" aria-label="${esc(t('Genel durum'))}">${[
    tile('running',t('Çalışan agent'),live.length,statProviders(live.map(run=>run.provider))||t('Şu an çalışan yok')),
    tile('needs',t('Seni bekliyor'),questions,questions?t('Soru veya onay isteği'):t('Bekleyen istek yok'),questions>0),
    tile('review',t('İncelemede'),count(['review','failed']),failed?globalThis.AIWSI18n.template`${failed} başarısız`:t('Sonuçlar onayını bekliyor'),failed>0),
    tile('ready',t('Sırada'),count(['backlog','ready']),t('Hazır ve bekleyen görevler')),
    tile('done',t('Son 24 saat'),done,globalThis.AIWSI18n.template`tamamlandı · ${usage}`)
  ].join('')}</section>`;
}
function dashboardMetrics(){
  const today=new Date();today.setHours(0,0,0,0);
  return derived('dashboardMetrics',`${stateVersion}:${today.getTime()}:${dashboardDays}`,()=>{
    const days=Array.from({length:dashboardDays},(_,index)=>{const start=new Date(today);start.setDate(today.getDate()-(dashboardDays-1-index));return {start:start.getTime(),done:0,failed:0,running:0,other:0,total:0,runs:[]};});
    const previousStart=new Date(today);previousStart.setDate(today.getDate()-2*dashboardDays+1);const previousRuns=[];
    const weekStart=Date.now()-dashboardWeek,projectOf=new Map(state.tasks.map(task=>[task.id,task.projectId])),agents=new Map(),projects=new Map(),chartRuns=[];
    const projectEntry=id=>{if(!projects.has(id))projects.set(id,{runs:[],live:0,open:0,running:0,review:0,done:0});return projects.get(id);};
    for(const run of state.runs){
      const started=Date.parse(run.startedAt),live=activeRun(run),entry=projectOf.has(run.taskId)?projectEntry(projectOf.get(run.taskId)):null;
      if(live&&entry)entry.live++;
      if(!Number.isFinite(started))continue;
      const day=started>=days[0].start?days.findLast(value=>started>=value.start):null;
      if(day){day[runOutcome(run)]++;day.total++;day.runs.push(run);chartRuns.push(run);}
      else if(started>=previousStart.getTime()&&started<days[0].start)previousRuns.push(run);
      if(started<weekStart&&!live)continue;
      const name=runAgentName(run);if(!agents.has(name))agents.set(name,{name,provider:run.provider,runs:[],done:0,failed:0,live:0});
      const agent=agents.get(name),outcome=runOutcome(run);agent.runs.push(run);if(outcome==='done')agent.done++;if(outcome==='failed')agent.failed++;if(live)agent.live++;
      if(entry&&started>=weekStart)entry.runs.push(run);
    }
    for(const task of state.tasks){
      if(task.archivedAt||task.sessionContinuation)continue;const entry=projectEntry(task.projectId);
      if(task.status==='done'){if(Date.parse(task.updatedAt)>=weekStart)entry.done++;continue;}
      if(task.status==='cancelled')continue;
      entry.open++;if(['running','waiting','paused','completing'].includes(task.status))entry.running++;if(['review','failed'].includes(task.status))entry.review++;
    }
    const outcomes=chartRuns.reduce((total,run)=>{total[runOutcome(run)]++;return total;},{done:0,failed:0,running:0,other:0});
    return {days,outcomes,chartRuns,previousRuns,chartUsage:runsUsage(chartRuns),total:chartRuns.length,agents:[...agents.values()].sort((a,b)=>b.live-a.live||b.runs.length-a.runs.length||a.name.localeCompare(b.name)),projects};
  });
}
function dashboardPanel(className,title,detail,body,action=''){return `<section class="dashboard-panel ${className}"><header class="dashboard-panel-head"><h2>${title}</h2>${detail?`<small>${detail}</small>`:''}${action}</header>${body}</section>`;}
// The change from the period before, once there is one to compare with.
function dashboardDelta(value,previous){
  if(!previous)return '';const change=Math.round((value-previous)/previous*100),t=globalThis.AIWSI18n.text;
  return `<em class="dashboard-delta" title="${esc(t('önceki döneme göre'))}">${change>0?'↑':change<0?'↓':'→'} ${esc(tokenPercent(Math.abs(change)))}</em>`;
}
function dashboardRangeControl(){return `<div class="view-tabs dashboard-range" role="group" aria-label="${esc(globalThis.AIWSI18n.text('Dönem'))}">${dashboardRanges.map(days=>`<button type="button" class="view-tab${days===dashboardDays?' active':''}" data-dashboard-range="${days}" aria-pressed="${days===dashboardDays}">${days} ${esc(globalThis.AIWSI18n.text('gün'))}</button>`).join('')}</div>`;}
function dashboardActivity(metrics){
  const t=globalThis.AIWSI18n,max=Math.max(1,...metrics.days.map(day=>day.total)),todayStart=metrics.days.at(-1).start;
  const segments=day=>['done','failed','running','other'].map(key=>day[key]?`<span class="is-${key}" style="flex-grow:${day[key]}"></span>`:'').join('');
  const bars=metrics.days.map(day=>{const date=dateTime(day.start,{day:'numeric',month:'short',weekday:'short'});return t.template`<div class="dashboard-day${day.start===todayStart?' is-today':''}" title="${esc(date)}: ${day.total} çalışma · ${day.done} tamamlandı · ${day.failed} başarısız"><span class="dashboard-track"><span class="dashboard-bar" style="height:${day.total/max*100}%">${segments(day)}</span></span><small>${new Date(day.start).getDate()}</small></div>`;}).join('');
  const usage=metrics.chartUsage,{done,failed}=metrics.outcomes;
  const before=runsUsage(metrics.previousRuns);
  const summary=[[t.text('Toplam çalışma'),metrics.total,dashboardDelta(metrics.total,metrics.previousRuns.length)],[t.text('Başarı oranı'),successRate(done,failed),''],[t.text('Toplam token'),usage?tokenCount(usage.totalTokens):'0',dashboardDelta(usage?.totalTokens||0,before?.totalTokens||0)],[t.text('Maliyet'),dashboardCost(usage),dashboardDelta(usage?.costUsd||0,before?.costUsd||0)]].map(([label,value,delta])=>`<div><small>${label}</small><strong>${esc(value)}</strong>${delta}</div>`).join('');
  const legend=[['done',t.text('Tamamlandı')],['failed',t.text('Başarısız')],['running',t.text('Çalışıyor')],['other',t.text('Durduruldu')]].map(([key,label])=>`<span><span class="dashboard-swatch is-${key}"></span>${label}</span>`).join('');
  const chart=metrics.total?`<div class="dashboard-chart" role="img" aria-label="${esc(t.template`${metrics.total} çalışma · ${dashboardDays} gün`)}">${bars}</div><div class="dashboard-legend">${legend}</div>`:`<p class="dashboard-empty">${t.text('Bu dönemde agent çalışması yok.')}</p>`;
  return dashboardPanel('dashboard-activity',t.text('Agent etkinliği'),t.text('Seçili dönem'),`<div class="dashboard-summary">${summary}</div>${chart}`);
}
// Who works on what: every live run, the ones waiting for the user first.
function dashboardLive(){
  const t=globalThis.AIWSI18n,questions=activeInputRequests(),waiting=run=>questions.some(item=>item.runId===run.id)||run.status==='waiting';
  const live=state.runs.filter(activeRun).sort((a,b)=>waiting(b)-waiting(a)||b.startedAt.localeCompare(a.startedAt));
  const rows=live.slice(0,dashboardLiveLimit).map(run=>{
    const item=state.tasks.find(task=>task.id===run.taskId),place=state.projects.find(value=>value.id===item?.projectId)?.name,question=questions.find(value=>value.runId===run.id);
    const pill=question?window.AIWSUI.statusPill('needs',t.text(question.kind==='approval'?'Onay bekliyor':'Soru soruyor')):window.AIWSUI.statusPill(run.status,statuses[run.status]||run.status);
    return `<button type="button" class="dashboard-live-row" data-open-task="${esc(run.taskId)}">${terminalIcon(run.provider)}<span class="dashboard-live-text"><strong>${esc(runAgentName(run))}</strong><span>${esc(consoleTitle(run))}</span><small>${esc(place||'')}</small></span>${pill}<time data-run-timer="${esc(run.id)}" title="${esc(t.text('Çalışma süresi'))}"></time></button>`;
  }).join('');
  const more=live.length>dashboardLiveLimit?`<button type="button" class="button small ghost" data-dashboard-sessions>${esc(t.template`+${live.length-dashboardLiveLimit} oturum daha`)}</button>`:'';
  const body=rows?`<div class="dashboard-live">${rows}</div>${more}`:`<p class="dashboard-empty">${t.text('Şu an çalışan agent yok. Bir görev başladığında burada görünür.')}</p>`;
  const action=`<button type="button" class="button small ghost" data-dashboard-sessions>${t.text('Canlı oturumlar')}</button>`;
  return dashboardPanel('dashboard-now',t.text('Şu an kim ne yapıyor'),live.length?t.template`${live.length} agent çalışıyor`:'',body,action);
}
function dashboardAgents(metrics){
  const t=globalThis.AIWSI18n,list=metrics.agents.slice(0,dashboardAgentLimit),max=Math.max(1,...list.map(agent=>agent.runs.length));
  const rows=list.map(agent=>{const usage=runsUsage(agent.runs);return t.template`<li class="dashboard-agent">${terminalIcon(agent.provider)}<span class="dashboard-agent-name"><strong>${esc(agent.name)}</strong><small>${agent.live?`<span class="ui-dot is-live" data-tone="running"></span>`:''}${agent.runs.length} çalışma · ${successRate(agent.done,agent.failed)} başarı</small></span><span class="dashboard-agent-meter"><span style="width:${agent.runs.length/max*100}%"></span></span><span class="dashboard-agent-usage"><strong>${esc(usage?tokenCount(usage.totalTokens):'0')}</strong><small>${esc(dashboardCost(usage))}</small></span></li>`;}).join('');
  const body=rows?`<ol class="dashboard-agents">${rows}</ol>`:`<p class="dashboard-empty">${t.text('Son yedi günde çalışan agent yok.')}</p>`;
  return dashboardPanel('dashboard-agent-panel',t.text('Agentlar'),t.text('Son 7 gün · token ve maliyet'),body);
}
function dashboardProjects(metrics){
  const t=globalThis.AIWSI18n,empty={runs:[],live:0,open:0,running:0,review:0,done:0};
  const items=state.projects.map(item=>({item,stats:metrics.projects.get(item.id)||empty,latest:projectLatest(item.id)})).sort((a,b)=>b.stats.live-a.stats.live||b.latest.localeCompare(a.latest));
  const number=(value,tone='')=>`<td class="is-number${value&&tone?` is-${tone}`:''}">${value||'<span class="dashboard-zero">0</span>'}</td>`;
  const rows=items.map(({item,stats,latest})=>{const usage=runsUsage(stats.runs);return `<tr><th scope="row"><button class="project-group-link" data-project="${esc(item.id)}">${projectBadge(item)}<span class="project-group-name"><strong>${esc(item.name)}</strong><small>${esc(item.repositoryPath)}</small></span></button></th>${number(stats.live,'running')}${number(stats.open)}${number(stats.review,'review')}${number(stats.done,'done')}${number(stats.runs.length)}<td class="is-number">${esc(usage?tokenCount(usage.totalTokens):'0')}<small>${esc(dashboardCost(usage))}</small></td><td class="dashboard-latest">${latest?esc(relative(latest)):'—'}</td><td class="dashboard-row-action"><button type="button" class="button small ghost" data-overview-new-task="${esc(item.id)}" title="${esc(t.text('Yeni görev'))}" aria-label="${esc(item.name)} · ${esc(t.text('Yeni görev'))}">+</button></td></tr>`;}).join('');
  const head=[t.text('Proje'),t.text('Canlı agent'),t.text('Açık görev'),t.text('İnceleme'),t.text('Biten · 7g'),t.text('Çalışma · 7g'),t.text('Token · 7g'),t.text('Son etkinlik')].map((label,index)=>`<th scope="col"${index?' class="is-number"':''}>${label}</th>`).join('');
  return dashboardPanel('dashboard-projects',t.text('Projeler'),t.template`${state.projects.length} proje`,`<div class="dashboard-table-scroll"><table class="dashboard-table"><thead><tr>${head}<th scope="col"><span class="sr-only">${t.text('İşlemler')}</span></th></tr></thead><tbody>${rows}</tbody></table></div>`);
}
function dashboardTokens(metrics){
  const t=globalThis.AIWSI18n,usage=metrics.days.map(day=>({day,usage:runsUsage(day.runs)})),max=Math.max(1,...usage.map(item=>item.usage?.totalTokens||0));
  if(!metrics.chartUsage)return dashboardPanel('dashboard-tokens',t.text('Token kullanımı'),t.text('Seçili dönem'),`<p class="dashboard-empty">${t.text('Bu dönemde agent çalışması yok.')}</p>`);
  const bars=usage.map(({day,usage:value})=>{const tokens=value?.totalTokens||0;return `<div class="dashboard-day" title="${esc(dateTime(day.start,{day:'numeric',month:'short',weekday:'short'}))}: ${esc(tokenCount(tokens))} · ${esc(dashboardCost(value))}"><span class="dashboard-track"><span class="dashboard-bar is-usage" style="height:${tokens/max*100}%"></span></span><small>${new Date(day.start).getDate()}</small></div>`;}).join('');
  return dashboardPanel('dashboard-tokens',t.text('Token kullanımı'),t.text('Seçili dönem'),`<div class="dashboard-chart is-usage" role="img" aria-label="${esc(t.text('Token kullanımı'))}">${bars}</div>`);
}
// Plain facts read from the period's runs and the open tasks; a row is left out when the data does not support it.
function dashboardInsights(metrics){
  const t=globalThis.AIWSI18n,rows=[],runs=metrics.chartRuns,projectOf=new Map(state.tasks.map(task=>[task.id,task.projectId])),nameOf=id=>state.projects.find(item=>item.id===id)?.name;
  const top=map=>[...map].sort((a,b)=>b[1]-a[1])[0];
  const busiest=metrics.days.reduce((best,day)=>day.total>best.total?day:best,metrics.days[0]);
  if(busiest.total)rows.push([t.text('En yoğun gün'),dateTime(busiest.start,{day:'numeric',month:'short',weekday:'short'}),t.template`${busiest.total} çalışma`]);
  if(runs.length)rows.push([t.text('Günlük ortalama çalışma'),(runs.length/dashboardDays).toFixed(1),'']);
  const durations=runs.filter(run=>run.finishedAt).map(run=>Math.round((Date.parse(run.finishedAt)-Date.parse(run.startedAt))/1000)).filter(value=>value>=0).sort((a,b)=>a-b);
  if(durations.length)rows.push([t.text('Medyan çalışma süresi'),clockDuration(durations[Math.floor(durations.length/2)]),'']);
  const byProject=new Map(),tokens=new Map(),failures=new Map();
  for(const run of runs){const id=projectOf.get(run.taskId);if(nameOf(id)){byProject.set(id,(byProject.get(id)||0)+1);tokens.set(id,(tokens.get(id)||0)+(run.usage?.totalTokens||0));}if(run.status==='failed'){const name=runAgentName(run);failures.set(name,(failures.get(name)||0)+1);}}
  const active=top(byProject);if(active)rows.push([t.text('En çok çalışan proje'),nameOf(active[0]),t.template`${active[1]} çalışma`]);
  const costly=top(tokens);if(costly?.[1])rows.push([t.text('En çok token kullanan proje'),nameOf(costly[0]),tokenCount(costly[1])]);
  const failing=top(failures);if(failing)rows.push([t.text('En çok hata veren agent'),failing[0],t.template`${failing[1]} başarısız`]);
  const waiting=state.tasks.filter(task=>task.status==='review'&&!task.archivedAt&&!task.sessionContinuation).sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt))[0];
  if(waiting)rows.push([t.text('En uzun süredir incelemede'),window.AIWSUI.taskTitle(waiting),relative(waiting.updatedAt),waiting.id]);
  const body=rows.length?`<dl class="dashboard-insights">${rows.map(([label,value,detail,taskId])=>`<div><dt>${esc(label)}</dt><dd>${taskId?`<button type="button" class="dashboard-insight-link" data-open-task="${esc(taskId)}">${esc(value)}</button>`:`<strong>${esc(value)}</strong>`}${detail?`<small>${esc(detail)}</small>`:''}</dd></div>`).join('')}</dl>`:`<p class="dashboard-empty">${t.text('Analiz için yeterli veri yok.')}</p>`;
  return dashboardPanel('dashboard-insight-panel',t.text('Öne çıkanlar'),t.text('Seçili dönem'),body);
}
function dashboardHeatmap(metrics){
  const t=globalThis.AIWSI18n,cells=Array.from({length:7},()=>Array(24).fill(0));
  for(const run of metrics.chartRuns){const date=new Date(run.startedAt);cells[(date.getDay()+6)%7][date.getHours()]++;}
  const max=Math.max(1,...cells.flat());
  const rows=cells.map((hours,index)=>{const day=dateTime(new Date(2024,0,1+index),{weekday:'short'});return `<span class="dashboard-heat-day">${esc(day)}</span>${hours.map((count,hour)=>`<span class="dashboard-heat-cell" style="--heat:${count?Math.round(20+count/max*80):0}%" title="${esc(day)} ${String(hour).padStart(2,'0')}:00 · ${esc(t.template`${count} çalışma`)}"></span>`).join('')}`;}).join('');
  const hours=[0,6,12,18].map(hour=>`<span style="grid-column:${hour+2}/span 6">${String(hour).padStart(2,'0')}</span>`).join('');
  return dashboardPanel('dashboard-heat-panel',t.text('Yoğunluk haritası'),t.text('Gün ve saate göre agent çalışmaları'),`<div class="dashboard-heat" role="img" aria-label="${esc(t.text('Gün ve saate göre agent çalışmaları'))}">${rows}<span></span>${hours}</div>`);
}
// Open and finished tasks by board column, then runs and tokens by provider.
function dashboardDistribution(metrics){
  const t=globalThis.AIWSI18n,items=state.tasks.filter(task=>!task.archivedAt&&!task.sessionContinuation);
  const counts=columns.map(column=>({column,count:items.filter(task=>column.statuses.includes(task.status)).length})),max=Math.max(1,...counts.map(item=>item.count));
  const tasks=items.length?`<ul class="dashboard-bars">${counts.map(({column,count})=>`<li><span class="dashboard-bars-label"><span class="column-dot ${column.id}"></span>${esc(column.name)}</span><span class="dashboard-agent-meter"><span style="width:${count/max*100}%"></span></span><strong>${count}</strong></li>`).join('')}</ul>`:`<p class="dashboard-empty">${t.text('Henüz görev yok.')}</p>`;
  const byProvider=new Map();for(const run of metrics.chartRuns){if(!byProvider.has(run.provider))byProvider.set(run.provider,[]);byProvider.get(run.provider).push(run);}
  const providerMax=Math.max(1,...[...byProvider.values()].map(list=>list.length));
  const rows=[...byProvider].sort((a,b)=>b[1].length-a[1].length).map(([provider,list])=>{const usage=runsUsage(list);return `<li><span class="dashboard-bars-label">${terminalIcon(provider)}${esc(providers[provider]||provider)}</span><span class="dashboard-agent-meter"><span style="width:${list.length/providerMax*100}%"></span></span><strong>${list.length}</strong><small>${esc(usage?tokenCount(usage.totalTokens):'0')}</small></li>`;}).join('');
  return dashboardPanel('dashboard-distribution',t.text('Görev dağılımı'),'',tasks+(rows?`<h3 class="dashboard-subhead">${t.text('Sağlayıcılar')}</h3><ul class="dashboard-bars">${rows}</ul>`:''));
}
function renderDashboard(){
  const board=$('#board'),metrics=dashboardMetrics();board.className='board dashboard-board';
  setHtml(board,`<div class="dashboard-page">${dashboardStats()}<div class="dashboard-toolbar">${dashboardRangeControl()}</div><div class="dashboard-grid">${dashboardActivity(metrics)}${dashboardLive()}${dashboardTokens(metrics)}${dashboardInsights(metrics)}${dashboardHeatmap(metrics)}${dashboardDistribution(metrics)}${dashboardProjects(metrics)}${dashboardAgents(metrics)}</div></div>`);
}
document.addEventListener('click',event=>{
  if(event.target.closest('button[data-dashboard-sessions]')){switchScreen('sessions');return;}
  const range=event.target.closest('button[data-dashboard-range]');if(!range)return;
  dashboardDays=Number(range.dataset.dashboardRange);storeSessionValue('aiws.dashboard-range',String(dashboardDays));renderBoard();
});
