'use strict';
// Moving cards between statuses and reordering the ready queue.
// Moves show immediately; server state arriving before the request settles keeps
// the moved status until the API confirms or refuses it.
const optimisticMoves=new Map();
// A hung request must not keep the board locked (bulkMoveBusy refuses every drag) forever.
const moveRequestTimeout=30000;
async function reorderReadyTasks(ids){
  if(!ids.length)return;
  ids.forEach((id,index)=>{const item=state.tasks.find(value=>value.id===id);if(item)item.queueOrder=index;});render();
  try{await api('/tasks/reorder','POST',{projectId,taskIds:ids});toast(globalThis.AIWSI18n.text('Hazır sırası güncellendi'));}
  catch(cause){error(cause.message);}
  finally{await refresh();}
}
const inBoardColumn=(item,status)=>status==='running'?['running','waiting','paused'].includes(item.status):item.status===status;
// Only bridge snapshots that still report the original status. Once the server
// advances the task (including an automatic start), its status wins. A state patch
// keeps the page's own records for unchanged tasks, so a record already showing the
// moved status is still waiting for its request, not advanced by the server.
function applyOptimisticMoves(){if(!optimisticMoves.size)return;for(const item of state.tasks){const move=optimisticMoves.get(item.id);if(!move||item.status===move.status)continue;if(item.status!==move.previous){optimisticMoves.delete(item.id);continue;}item.status=move.status;}}
async function moveBoardTasks(ids,status){
  if(bulkMoveBusy||!ids.length||!columns.some(column=>column.id===status))return;
  bulkMoveBusy=true;const failures=[],undo=[];let moved=0,queued=0;
  for(const id of ids){const item=state.tasks.find(item=>item.id===id);if(item&&!inBoardColumn(item,status))optimisticMoves.set(id,{status,previous:item.status});}
  applyOptimisticMoves();render();
  try{
    for(const id of ids){
      const item=state.tasks.find(item=>item.id===id);if(!item)continue;
      const move=optimisticMoves.get(id);
      try{
        if(move){const result=await api(status==='running'?`/tasks/${id}/run`:`/tasks/${id}`,status==='running'?'POST':'PATCH',status==='running'?{queueIfBusy:true}:{status},{signal:AbortSignal.timeout(moveRequestTimeout)});if(result.queued){queued++;const current=state.tasks.find(item=>item.id===id);if(current)Object.assign(current,result.task);}else if(status!=='running'&&!['running','waiting','paused','completing'].includes(move.previous))undo.push({id,status:move.previous});}
        optimisticMoves.delete(id);
        selectedBoardTasks.delete(id);moved++;
      }catch(cause){
        const pending=optimisticMoves.get(id);optimisticMoves.delete(id);const current=state.tasks.find(item=>item.id===id);if(current&&pending&&current.status===pending.status)current.status=pending.previous;
        scheduleRender();failures.push(`${item.title}: ${cause.message}`);
      }
    }
    const notices=[];
    if(queued)notices.push(globalThis.AIWSI18n.template`${queued} görev slot boşalınca başlamak üzere Hazır kuyruğuna alındı`);
    if(moved>queued)notices.push(globalThis.AIWSI18n.template`${moved-queued} görev ${status==='running'?globalThis.AIWSI18n.text('çalışma sütununa alındı'):globalThis.AIWSI18n.text('taşındı')}`);
    // A plain status move can be undone; starting a run cannot.
    if(notices.length)toast(notices.join(' · '),undo.length?undoAction(async()=>{for(const entry of undo)await api(`/tasks/${entry.id}`,'PATCH',{status:entry.status});}):undefined);
    if(failures.length)error(globalThis.AIWSI18n.template`${failures.length} görev taşınamadı. ${failures.join(' · ')}`);
  }finally{for(const id of ids)optimisticMoves.delete(id);bulkMoveBusy=false;syncBoardSelection();}
  // A slow state read must not keep every card locked after the moves finished.
  await refresh();
}
