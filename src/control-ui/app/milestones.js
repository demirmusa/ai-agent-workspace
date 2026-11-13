'use strict';
// Project milestones as on GitHub: their order, progress and due dates, and the markup the board, task detail and editors share.
const projectMilestones=projectId=>state.projects.find(project=>project.id===projectId)?.milestones||[];
const findMilestone=(projectId,id)=>id?projectMilestones(projectId).find(milestone=>milestone.id===id):undefined;
const currentMilestoneId=projectId=>{const project=state.projects.find(value=>value.id===projectId),current=findMilestone(projectId,project?.currentMilestoneId);return current?.state==='open'?current.id:'';};
/** The milestone a new task of the project joins: the board's milestone filter when it picks an open milestone (or "no milestone") of the selected project, else the current one. */
const newTaskMilestoneId=targetId=>{if(targetId===projectId&&activeScreen==='board'&&milestoneFilter){if(milestoneFilter==='none')return '';if(findMilestone(targetId,milestoneFilter)?.state==='open')return milestoneFilter;}return currentMilestoneId(targetId);};
/** GitHub's order: open milestones first, each group by closest due date (undated last), then by title. */
function sortedMilestones(list){return [...list].sort((a,b)=>(a.state==='open'?0:1)-(b.state==='open'?0:1)||(a.dueOn===b.dueOn?0:!a.dueOn?1:!b.dueOn?-1:a.dueOn.localeCompare(b.dueOn))||a.title.localeCompare(b.title));}
/** Open and closed tasks of every milestone of a project, counted in one pass; done and cancelled tasks are closed, as their issues are. */
function milestoneCounts(projectId){
  const counts=new Map();
  for(const item of state.tasks){if(item.projectId!==projectId||!item.milestoneId||item.sessionContinuation)continue;const entry=counts.get(item.milestoneId)||{open:0,closed:0};if(['done','cancelled'].includes(item.status))entry.closed++;else entry.open++;counts.set(item.milestoneId,entry);}
  return id=>{const entry=counts.get(id)||{open:0,closed:0},total=entry.open+entry.closed;return {...entry,total,percent:total?Math.round(entry.closed/total*100):0};};
}
const milestoneDay=date=>new Date(`${date}T00:00:00`);
const milestoneOverdue=milestone=>milestone.state==='open'&&Boolean(milestone.dueOn)&&milestoneDay(milestone.dueOn)<new Date(new Date().toDateString());
/** "Due by …", "Past due by …" or "Closed …", as GitHub writes under a milestone. */
function milestoneDueText(milestone){
  const t=globalThis.AIWSI18n.template,day=value=>dateTime(value,{year:'numeric',month:'short',day:'numeric'});
  if(milestone.state==='closed')return milestone.closedAt?t`Kapandı · ${day(milestone.closedAt)}`:globalThis.AIWSI18n.text('Kapandı');
  if(!milestone.dueOn)return globalThis.AIWSI18n.text('Son tarih yok');
  return milestoneOverdue(milestone)?t`Gecikti · ${day(milestoneDay(milestone.dueOn))}`:t`Son tarih · ${day(milestoneDay(milestone.dueOn))}`;
}
/** Options of a milestone select: the leading [value, label] choices (by default none), the open milestones, and closed ones in their own group. */
function milestoneOptionsHtml(projectId,selected,leading=[['',globalThis.AIWSI18n.text('Milestone yok')]]){
  const t=globalThis.AIWSI18n.text,option=milestone=>`<option value="${esc(milestone.id)}" ${milestone.id===selected?'selected':''}>${esc(milestone.title)}${milestone.id===currentMilestoneId(projectId)?` · ${esc(t('geçerli'))}`:''}</option>`;
  const list=sortedMilestones(projectMilestones(projectId)),open=list.filter(value=>value.state==='open'),closed=list.filter(value=>value.state==='closed');
  return `${leading.map(([value,label])=>`<option value="${esc(value)}" ${value===(selected||'')?'selected':''}>${esc(label)}</option>`).join('')}${open.map(option).join('')}${closed.length?`<optgroup label="${esc(t('Kapalı milestone’lar'))}">${closed.map(option).join('')}</optgroup>`:''}`;
}
/** The milestone a board card belongs to, as a small flag. */
function milestoneCardChip(item){
  const milestone=findMilestone(item.projectId,item.milestoneId);if(!milestone)return '';
  return `<span class="milestone-chip${milestone.state==='closed'?' is-closed':''}${milestoneOverdue(milestone)?' is-overdue':''}" title="${esc(`${globalThis.AIWSI18n.text('Milestone')} · ${milestone.title} · ${milestoneDueText(milestone)}`)}">${pageIcon('milestone')}<span>${esc(milestone.title)}</span></span>`;
}
/** Moves tasks to a milestone (null takes them out) through one request. */
async function assignMilestone(projectId,taskIds,milestoneId){const result=await api(`/projects/${projectId}/milestones/assign`,'POST',{taskIds,milestoneId});await refresh();return result;}
