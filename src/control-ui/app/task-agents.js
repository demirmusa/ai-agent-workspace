'use strict';
// Agents that worked on a task.
// Agents that worked on a task, oldest first. Runs continuing the same provider session stay one agent;
// a handoff, another provider, another agent profile or a new provider session starts the next one.
function taskAgentGroups(item){
  const groups=[];
  for(const run of state.runs.filter(run=>run.taskId===item.id).sort((a,b)=>a.startedAt.localeCompare(b.startedAt))){
    const last=groups.at(-1),previous=last?.runs.at(-1),agentId=run.executionSnapshot?.agent?.id||null;
    const sameSession=previous&&(run.historyResume?.sessionId?run.historyResume.sessionId===previous.sessionId||last.runs.some(entry=>entry.sessionId===run.historyResume.sessionId):!run.sessionId||!previous.sessionId||run.sessionId===previous.sessionId);
    const continues=last&&!run.handoff&&run.provider===previous.provider&&(run.historyResume||agentId===last.agentId)&&sameSession;
    if(continues)last.runs.push(run);else groups.push({key:run.id,agentId,runs:[run]});
  }
  for(const group of groups){const first=group.runs[0],latest=group.runs.at(-1);Object.assign(group,{provider:first.provider,name:first.executionSnapshot?.agent?.name||latest.executionSnapshot?.agent?.name||providers[first.provider]||first.provider,status:latest.status,startedAt:first.startedAt,finishedAt:latest.finishedAt,model:latest.executionInfo?.model||latest.executionSnapshot?.model||'',handoff:first.handoff||null});}
  return groups;
}
// Agent sessions read the same labels as the console's agent list.
const runStatusLabel=status=>window.AIWSAgentConsole.statusLabel(status);
/** Lists every agent of a task once there is more than one; the latest stays in the console, earlier ones open beside it. */
function mountTaskAgentSessions(item,host,groups){
  let section=host.querySelector(':scope > .task-agent-sessions');
  if(groups.length<2){section?.remove();return;}
  if(!section){section=document.createElement('section');section.className='task-agent-sessions';section.setAttribute('aria-label',globalThis.AIWSI18n.text('Bu görevde çalışan agentlar'));}
  const inspected=childAgentSelection?.kind==='session'&&childAgentSelection.taskId===item.id?childAgentSelection.groupKey:null;
  const rows=groups.map((group,index)=>{const latest=index===groups.length-1,selected=inspected?group.key===inspected:latest,icon=providerIconPaths[group.provider];
    const detail=[providers[group.provider]||group.provider,group.model,group.runs.length>1?globalThis.AIWSI18n.template`${group.runs.length} çalıştırma kaydı`:'',group.handoff?(group.handoff.mode==='transcript'?globalThis.AIWSI18n.text('Oturum kopyalanarak devralındı'):globalThis.AIWSI18n.text('Temiz agent olarak devralındı')):'',latest?globalThis.AIWSI18n.text('Güncel'):''].filter(Boolean).join(' · ');
    return `<button type="button" class="task-agent-row" data-task-agent-session="${esc(group.key)}" data-status="${esc(group.status)}" aria-pressed="${selected}"${latest?' data-latest="true"':''}><span class="task-agent-index">${index+1}</span>${icon?`<img class="task-agent-icon" src="${esc(icon)}" alt="">`:''}<span class="task-agent-name"><strong>${esc(group.name)}</strong><small>${esc(detail)}</small></span><span class="task-agent-status">${esc(runStatusLabel(group.status))}</span><time datetime="${esc(group.startedAt)}">${esc(dateTime(group.startedAt,{dateStyle:'short',timeStyle:'short'}))}</time></button>`;}).join('');
  const html=globalThis.AIWSI18n.template`<header><strong>Agent oturumları</strong><span>${groups.length} agent · en sonuncusu aşağıda açık</span></header><div class="task-agent-list">${rows}</div>`;
  if(section.dataset.html!==html){section.innerHTML=html;section.dataset.html=html;}
  if(section.parentElement!==host)host.prepend(section);
}
document.addEventListener('click',event=>{const row=event.target.closest('[data-task-agent-session]');if(!row)return;const item=task();if(!item)return;if(row.dataset.latest==='true'){if(childAgentSelection?.kind==='session')closeChildAgent();return;}openTaskAgentSession(item,row.dataset.taskAgentSession,row);});
function openTaskAgentSession(item,groupKey,button){
  if(sessionFullscreen){sessionFullscreen=false;render();}
  let previous=childAgentSelection;
  if(previous&&!(previous.kind==='session'&&previous.taskId===item.id)){closeChildAgent(false);previous=null;}
  ensureChildAgentPanel();
  if(previous?.controller&&previous.groupKey!==groupKey){previous.controller.destroy();previous.controller=null;}
  childAgentSelection={kind:'session',taskId:item.id,groupKey,agent:{id:groupKey},parentKey:`task:${item.id}`,returnFocus:previous?.returnFocus||button,controller:previous?.controller||null};childAgentPanel.hidden=false;
  $('#task-panel').setAttribute('aria-modal','false');renderChildAgent();applyDetailWidth();$('#close-child-agent').focus({preventScroll:true});
  renderDetail();
}
/** An earlier agent of the task, read only. Its records are gathered (and native transcripts fetched) only once it is opened. */
function renderTaskAgentSession(selected){
  const item=state.tasks.find(entry=>entry.id===selected.taskId),groups=item?taskAgentGroups(item):[],group=groups.find(entry=>entry.key===selected.groupKey);
  if(!item||!group){closeChildAgent(false);return;}
  const ids=new Set(group.runs.map(run=>run.id)),index=groups.indexOf(group);
  $('#child-agent-title').textContent=globalThis.AIWSI18n.template`${index+1}. agent · ${group.name}`;$('#child-agent-status').textContent=runStatusLabel(group.status);
  $('.child-agent-footer>span').textContent=globalThis.AIWSI18n.text('Önceki agent oturumu · Salt okunur');
  const data=withPastRunTranscripts({instanceId:`session:${item.id}/${group.key}`,taskId:undefined,readOnly:true,hideHistoryFooter:true,title:group.name,provider:group.provider,workspace:state.projects.find(project=>project.id===item.projectId)?.repositoryPath,terminalRun:null,runs:group.runs,events:taskEvents(item.id).filter(event=>ids.has(event.runId)),messages:taskMessages(item.id).filter(message=>ids.has(message.runId)),questions:state.questions.filter(question=>ids.has(question.runId))},item);
  const host=$('#child-agent-console-host');if(!selected.controller)selected.controller=createAgentConsole(host,data);else selected.controller.update(data);
  let note=childAgentPanel.querySelector('.child-agent-notice');if(!note){note=document.createElement('div');note.className='history-context-note child-agent-notice';host.prepend(note);}
  const loading=group.runs.map(run=>runTranscriptRecords(run)).filter(Boolean),failed=loading.find(entry=>entry.error);
  note.textContent=failed?.error||(loading.some(entry=>entry.loading)?globalThis.AIWSI18n.text('Agent kayıtları yükleniyor…'):group.handoff?globalThis.AIWSI18n.template`${group.handoff.fromAgentName} ajanından devralındı${group.handoff.reason?` · ${group.handoff.reason}`:''}`:'');note.hidden=!note.textContent;
  $('[data-child-more]',$('.child-agent-footer'))?.remove();
}
