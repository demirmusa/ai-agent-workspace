'use strict';
// Run summaries in the task information tab.
// Every run of the task, oldest first, as a collapsed entry; what the agent answered is the summary.
const openRunSummaries=new Set();
function runSummaryText(run){
  if(run.reply?.trim())return run.reply.trim();
  return taskMessages(run.taskId).filter(entry=>entry.runId===run.id&&entry.authorType==='agent'&&entry.text?.trim()).at(-1)?.text.trim()||'';
}
function runSummariesHtml(item){
  const t=globalThis.AIWSI18n.text,runs=state.runs.filter(run=>run.taskId===item.id).sort((a,b)=>Date.parse(a.startedAt)-Date.parse(b.startedAt));
  if(!runs.length)return '';
  // What the activity history already shows in full is not repeated here.
  const shown=new Set(taskEvents(item.id).filter(event=>event.type!=='terminal.output').map(event=>event.message?.trim()));
  const entries=runs.map((run,index)=>{
    const text=runSummaryText(run),usage=run.usage?.totalTokens?usageBreakdownHtml(run.usage):'',agent=run.executionSnapshot?.agent?.name,model=run.executionInfo?.model||run.executionSnapshot?.model,pull=run.pullRequest||(run.id===item.currentRunId?item.pullRequest:null);
    return globalThis.AIWSI18n.template`<details class="run-summary" data-run-summary="${esc(run.id)}" ${openRunSummaries.has(run.id)?'open':''}><summary><span class="run-summary-index">${index+1}</span><span class="run-summary-title">${esc(agent||providers[run.provider]||run.provider)}${model?` · ${esc(model)}`:''}</span>${pullRequestLink(pull,'run-summary-pull')}${window.AIWSUI.statusPill(run.status,statuses[run.status]||run.status)}<time datetime="${esc(run.startedAt)}">${esc(dateTime(run.startedAt))}</time></summary><div class="run-summary-body">${shown.has(text)&&text?'':text?`<div class="task-description-markdown cv-markdown">${window.AIWSAgentConsole?.markdown(text)||esc(text)}</div>`:`<p class="issue-empty">${esc(t('Bu çalışma için özet yok'))}</p>`}<dl class="task-meta issue-meta"><dt>${esc(t('Süre'))}</dt><dd><time data-run-timer="${esc(run.id)}"></time></dd>${executionInfoHtml(item,run)}</dl>${usage}</div></details>`;
  }).join('');
  return globalThis.AIWSI18n.template`<section class="issue-panel" aria-labelledby="issue-run-title"><header><h3 id="issue-run-title">Çalışma özetleri</h3></header><div class="run-summaries">${entries}</div></section>`;
}
document.addEventListener('toggle',event=>{const details=event.target.closest?.('[data-run-summary]');if(!details)return;if(details.open)openRunSummaries.add(details.dataset.runSummary);else openRunSummaries.delete(details.dataset.runSummary);},true);
/** The command that resumes a run's provider session in the provider's own CLI, e.g. `claude --resume <id>`. */
function sessionResumeCommand(run){
  const parts=providerResumeArgs[run?.provider];
  return run?.sessionId&&parts?parts.map(part=>part.replace('{sessionId}',run.sessionId)).join(' '):'';
}
// Copy on pointerdown: live pushes re-render the summaries between press and release, which swallows the click. Keyboard activation still arrives as a click.
for(const type of ['pointerdown','click'])document.addEventListener(type,async event=>{
  if(type==='pointerdown'?event.button!==0:event.detail!==0)return;
  const button=event.target.closest?.('[data-copy-field]');if(!button)return;
  const open=!openCopyFields.delete(button.dataset.copyKey);if(open)openCopyFields.add(button.dataset.copyKey);button.classList.toggle('is-open',open);
  if(await window.AIWSUI.copyText(button.dataset.copyField))toast(globalThis.AIWSI18n.text('Kopyalandı'));else error(globalThis.AIWSI18n.text('Panoya erişilemiyor'));
});
// One line cut with an ellipsis; a click copies it and unfolds the whole value, the tooltip shows it on hover.
const openCopyFields=new Set();
function copyField(key,value,copy=value,title=value){return `<button type="button" class="copy-field${openCopyFields.has(key)?' is-open':''}" data-copy-field="${esc(copy)}" data-copy-key="${esc(key)}" title="${esc(title)}"><code>${esc(value)}</code></button>`;}
function executionInfoHtml(item,run){
  const field=(name,value,empty)=>value?copyField(`${run?.id}:${name}`,value):`<code>${esc(empty)}</code>`;
  const info=run?.executionInfo||{},snapshot=run?.executionSnapshot;
  const provider=run?.provider||taskProvider(item),model=info.model||snapshot?.model||(!run?taskModel(item):null);
  const resume=sessionResumeCommand(run);
  const session=run?.sessionId?globalThis.AIWSI18n.template`<dt>Oturum ID</dt><dd data-execution-session>${resume?copyField(`${run.id}:session`,run.sessionId,resume,resume):copyField(`${run.id}:session`,run.sessionId)}</dd>`:'';
  return globalThis.AIWSI18n.template`${session}<dt>Model</dt><dd data-execution-model>${esc(providers[provider]||provider)} · ${esc(model||globalThis.AIWSI18n.text('Model bilgisi bekleniyor'))}${info.reasoningEffort||snapshot?.reasoningEffort||(!run&&item.reasoningEffort)?` · ${esc(info.reasoningEffort||snapshot?.reasoningEffort||item.reasoningEffort)}`:''}${model?`<small>${info.modelSource==='reported'?globalThis.AIWSI18n.text('Sağlayıcının bildirdiği model'):globalThis.AIWSI18n.text('Yapılandırılan model')}</small>`:''}</dd><dt>Branch</dt><dd data-execution-branch>${field('branch',info.detached?'Detached HEAD':info.branch,globalThis.AIWSI18n.text('Branch bilgisi yok'))}</dd><dt>Worktree</dt><dd data-execution-worktree>${field('worktree',info.worktreePath,globalThis.AIWSI18n.text('Worktree bilgisi yok'))}</dd><dt>Çalışma klasörü</dt><dd data-execution-cwd>${field('cwd',info.cwd||(!run?state.projects.find(project=>project.id===item.projectId)?.repositoryPath:''),globalThis.AIWSI18n.text('Klasör bilgisi yok'))}</dd>`;
}
