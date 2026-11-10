'use strict';
// Agent activity: the one line a card or the timeline shows, and the activity history of a task.
// Journal entries that read as agent activity, and the one line each reads as (cached per event); cards and the timeline share them.
const activitySummaries=new Map(),activityEvent=event=>event.message&&!['terminal.output','started'].includes(event.type);
function activityLine(event){
  let summary=activitySummaries.get(event.id);
  if(summary===undefined){
    let message=event.message;
    try{const value=JSON.parse(message);message=value.item?.text||value.item?.command||value.message||value.type||message;}catch{/* Provider output may be plain text. */}
    summary=String(message).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').trim().split('\n').filter(Boolean).at(-1)?.slice(0,130)||event.type;
    if(activitySummaries.size>5000)activitySummaries.clear();activitySummaries.set(event.id,summary);
  }
  return summary;
}
/** The line a card shows under its title: the schedule, the queue reason or the latest agent activity. */
function activity(item) {
  if(scheduledWaiting(item))return `${globalThis.AIWSI18n.text(item.status==='ready'?'Zamanlandı':'Hazır olunca başlar')} · ${scheduleTime(item.scheduledAt)} (${untilText(item.scheduledAt)})`;
  if(item.status==='waiting'&&item.handoffRequest?.resumeAt)return `${globalThis.AIWSI18n.text('Kota sıfırlanması bekleniyor')} · ${scheduleTime(item.handoffRequest.resumeAt)} (${untilText(item.handoffRequest.resumeAt)})`;
  if(['ready','failed'].includes(item.status)&&item.queueReason)return typeof item.queueReason==='string'?item.queueReason:item.queueReason.message;
  const event=taskEvents(item.id).findLast(activityEvent);
  if(!event)return item.status==='ready'?globalThis.AIWSI18n.text('Uygun agent bekleniyor'):item.status==='backlog'?globalThis.AIWSI18n.text('Planlanmayı bekliyor'):statuses[item.status];
  return activityLine(event);
}
const openActivityEntries=new Set();
/** A native dialog's markdown (see promptMarkdown on the server) split into its parts; null for a plain question. */
function activityDialog(message){
  const fence=/(```|~~~)\n([\s\S]*?)\n\1/.exec(message),blocks=(fence?message.replace(fence[0],()=>'\n\n'):message).split(/\n{2,}/).map(block=>block.trim()).filter(Boolean);
  const choices=blocks.findLast(block=>/^1\. /.test(block));if(!choices)return null;
  const options=choices.split('\n').map(line=>line.replace(/^\d+\.\s*/,'').replace(/\s*[─━═]{3,}\s*/g,'').trim()).filter(line=>line&&!/^(?:type something\.?|chat about this)$/i.test(line));
  const bold=blocks.find(block=>/^\*\*[\s\S]+\*\*$/.test(block)),title=blocks.find(block=>block.startsWith('☐')),rest=blocks.filter(block=>![choices,bold,title].includes(block)),question=bold?.slice(2,-2)||'';
  // A checkbox dialog is a question the agent wrote: the parser reads its wrapped text as a command with the last row as the question.
  return title?{title:title.replace(/^☐\s*/,''),text:[...rest,fence?.[2],question].filter(Boolean).join(' ').replace(/\s*\n\s*/g,' '),command:'',options}:{title:'',text:[question,...rest].filter(Boolean).join(' '),command:fence?.[2]||'',options};
}
function activityQuestionHtml(message){
  const dialog=activityDialog(message);if(!dialog)return `<div class="task-activity-markdown task-description-markdown cv-markdown">${window.AIWSAgentConsole?.markdown(message)||esc(message)}</div>`;
  return `<div class="task-activity-question">${dialog.title?`<span class="ui-chip">${esc(dialog.title)}</span>`:''}${dialog.text?`<p>${esc(dialog.text)}</p>`:''}${dialog.command?`<pre>${esc(dialog.command)}</pre>`:''}${dialog.options.length?`<ol>${dialog.options.map(option=>`<li>${esc(option)}</li>`).join('')}</ol>`:''}</div>`;
}
/** An agent's reply as markdown; a long one starts folded to a few lines and unfolds on click. */
function activityReplyHtml(event){
  const text=event.message.trim(),body=window.AIWSAgentConsole?.markdown(text)||esc(text);
  if(text.length<=240&&text.split('\n').length<=3)return `<div class="task-activity-markdown task-description-markdown cv-markdown">${body}</div>`;
  const open=openActivityEntries.has(event.id);
  return `<div class="task-activity-markdown task-activity-fold task-description-markdown cv-markdown${open?' is-open':''}" data-activity-fold="${esc(event.id)}" role="button" tabindex="0" aria-expanded="${open}">${body}</div>`;
}
function activityBodyHtml(event){
  const message=event.message.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
  if(event.type==='question')return activityQuestionHtml(message);
  if(event.type==='reply')return activityReplyHtml({...event,message});
  return `<p>${esc(message)}</p>`;
}
/** A dialog repainted by the terminal is journaled again; a question counts once per run until it is answered. */
function withoutRepeatedQuestions(events){
  const seen=new Set();
  return events.filter(event=>{
    if(event.type==='answer'){for(const key of [...seen])if(key.startsWith(`${event.runId}|`))seen.delete(key);return true;}
    if(event.type!=='question')return true;
    const key=`${event.runId}|${event.message.replace(/[─━═]{3,}/g,'').replace(/\s+/g,' ').trim()}`;
    if(seen.has(key))return false;seen.add(key);return true;
  });
}
function toggleActivityFold(fold){const open=!openActivityEntries.delete(fold.dataset.activityFold);if(open)openActivityEntries.add(fold.dataset.activityFold);fold.classList.toggle('is-open',open);fold.setAttribute('aria-expanded',String(open));}
document.addEventListener('click',event=>{const fold=event.target.closest?.('[data-activity-fold]');if(fold&&!event.target.closest('a')&&!String(window.getSelection?.()||''))toggleActivityFold(fold);});
document.addEventListener('keydown',event=>{if(!['Enter',' '].includes(event.key)||!event.target.matches?.('[data-activity-fold]'))return;event.preventDefault();toggleActivityFold(event.target);});
function taskActivityHistoryHtml(item) {
  const all=withoutRepeatedQuestions(taskEvents(item.id).filter(event=>event.type!=='terminal.output'&&event.message).sort((a,b)=>a.createdAt<b.createdAt?-1:a.createdAt>b.createdAt?1:0));
  // Long agent runs produce thousands of entries; the newest ones are what matter here.
  const events=all.slice(-300),hidden=all.length-events.length;
  const labels={started:'Başlatıldı',completed:'Tamamlandı',failed:'Başarısız',stopped:'Durduruldu',paused:'Duraklatıldı',resumed:'Devam edildi',waiting:'Yanıt bekleniyor',question:'Soru',answer:'Yanıt',reply:'Agent yanıtı',command:'Talimat','command.queued':'Talimat sıraya alındı',continuation:'Devam turu','agent.limit':'Kota sınırı','agent.waiting':'Kota bekleniyor','agent.resume':'Kotadan devam edildi',stdout:'Agent çıktısı',stderr:'Hata çıktısı'};
  // Entries are steps on one rail; each dot takes the tone of what happened, and the time reads relative with the exact one on hover.
  const tones={started:'running',continuation:'running','agent.resume':'running','agent.limit':'waiting','agent.waiting':'waiting',answer:'done',stderr:'failed'};
  return globalThis.AIWSI18n.template`<section class="task-activity-history" aria-labelledby="task-activity-title"><h3 id="task-activity-title">İşlem geçmişi <span class="task-activity-count">${all.length}</span></h3>${hidden?globalThis.AIWSI18n.text('<p class="form-hint">Yalnız en yeni 300 kayıt gösteriliyor.</p>'):''}${events.length?globalThis.AIWSI18n.template`<ol>${events.map(event=>globalThis.AIWSI18n.template`<li data-activity-id="${esc(event.id)}" data-tone="${tones[event.type]||window.AIWSUI.tone(event.type)}"><div class="task-activity-meta"><strong>${esc(globalThis.AIWSI18n.text(labels[event.type]||event.type))}</strong>${event.runId?globalThis.AIWSI18n.template`<span class="ui-chip is-mono" title="${esc(event.runId)}">Koşum ${esc(shortId(event.runId))}</span>`:''}<time datetime="${esc(event.createdAt)}" title="${esc(dateTime(event.createdAt))}">${esc(historyAgo(event.createdAt))}</time></div>${activityBodyHtml(event)}</li>`).join('')}</ol>`:globalThis.AIWSI18n.text('<p class="form-hint">Bu görev için henüz işlem kaydı yok.</p>')}</section>`;
}
