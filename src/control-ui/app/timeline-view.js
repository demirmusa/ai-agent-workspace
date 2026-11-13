'use strict';
// The timeline view.
// Timeline view: one row per agent (its profile, else its provider and model) and one bar per run of the tasks the toolbar shows,
// within the longest range. AIWSTimeline keeps its DOM between renders; this gathers the data and hands it the app's actions.
let timelineView=null;
function renderTimeline(){
  const t=globalThis.AIWSI18n.text,needle=searchFold(query),clock=value=>dateTime(value,{hour:'2-digit',minute:'2-digit'});
  const shown=new Map(boardTasks().filter(item=>taskMatchesQuery(item,needle)).map(item=>[item.id,item]));
  const runs=state.runs.filter(run=>shown.has(run.taskId)&&(!providerFilter||run.provider===providerFilter)).sort((a,b)=>a.startedAt.localeCompare(b.startedAt));
  const allProjects=activeScreen==='overview',requests=new Map(activeInputRequests().map(question=>[question.runId,question])),byTask=groupByTask(runs),rows=new Map();
  const bars=runs.map(run=>{
    const item=shown.get(run.taskId),agent=run.executionSnapshot?.agent,model=run.executionInfo?.model||run.executionSnapshot?.model||'',row=agent?`agent:${agent.id}`:`provider:${run.provider}:${model}`,request=requests.get(run.id);
    rows.set(row,{key:row,name:agent?state.agents.find(value=>value.id===agent.id)?.name||agent.name:providers[run.provider]||run.provider,model:model||(agent?providers[run.provider]||run.provider:t('Varsayılan model')),icon:providerIconPaths[run.provider]||''});
    return {id:run.id,row,task:item.id,project:allProjects?projectName(taskProject(item)):'',title:item.title,start:Date.parse(run.startedAt),end:run.finishedAt?Date.parse(run.finishedAt):null,tone:request?'needs':window.AIWSUI.tone(run.status),label:request?t('Seni bekliyor'):runStatusLabel(run.status),startText:clock(run.startedAt),endText:run.finishedAt?clock(run.finishedAt):'',request:request?{id:request.id,kind:request.kind==='approval'?'approval':'question',terminal:request.source==='terminal',excerpt:requestExcerpt(request.text,180)}:null};
  });
  // A dependency joins the blocking task's last run started before the dependent task's latest run.
  const links=[...byTask.values()].flatMap(list=>{const run=list.at(-1);return (shown.get(run.taskId).dependsOn||[]).map(id=>byTask.get(id)?.findLast(source=>source.startedAt<=run.startedAt)).filter(Boolean).map(source=>({from:source.id,to:run.id}));});
  const data={rows:[...rows.values()],bars,links,onOpen:openTask,onAnswer:openInputRequest,onDecide:decideApproval,activity:runId=>{const run=runById(runId),events=run?taskEvents(run.taskId):[],lines=[];for(let index=events.length-1;index>=0&&lines.length<3;index--){const event=events[index];if(event.runId!==runId||!activityEvent(event))continue;const line=activityLine(event);if(line!==lines[0])lines.unshift(line);}return lines;}};
  const board=$('#board');
  if(!timelineView){board.replaceChildren();timelineView=window.AIWSTimeline.create(board,data);}
  else{if(timelineView.element.parentNode!==board)board.replaceChildren(timelineView.element);timelineView.update(data);}
}
