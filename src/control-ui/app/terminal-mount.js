'use strict';
// Terminal endpoints of task runs.
// A task run's terminal endpoints, shared by the task panel and the Terminal tabs.
function runTerminalOptions(run){return {load:()=>api(`/runs/${run.id}/terminal`),onImage:async file=>{const image=await api(`/runs/${run.id}/images`,'POST',{data:await window.AIWSImages.data(file)});return image.path;},onInput:data=>api(`/runs/${run.id}/terminal/input`,'POST',{data},{quiet:true}),onResize:size=>api(`/runs/${run.id}/terminal/resize`,'POST',size,{quiet:true}),onClear:()=>api(`/runs/${run.id}/terminal/clear`,'POST',{},{quiet:true})};}
// The pane parts of a task run, shared by the All projects and project Terminal tabs: closing a pane only hides the session.
const runPaneParts={
  close:(run,title)=>terminalPaneButton('close',`data-terminal-close="${esc(run.id)}"`,'Paneli kapat (Ctrl+Shift+W) · Oturum çalışmaya devam eder',`${title} panelini kapat`),
  head:(run,title,status,multiple)=>{const item=state.tasks.find(task=>task.id===run.taskId),pill=item?window.AIWSUI.statusPill(item.status,statuses[item.status]||item.status):'';return globalThis.AIWSI18n.template`<button type="button" class="terminal-pane-title" data-terminal-title="${esc(run.id)}" title="${esc(title)} · ${esc(status.label)}${multiple?globalThis.AIWSI18n.text(' · Başlıktan sürükleyerek taşı'):''}">${terminalIcon(run.provider)}<span class="terminal-tab-title">${esc(title)}</span>${terminalDot(status,status.label)+pill}</button><span class="terminal-pane-grip" aria-hidden="true"></span>${terminalPaneButton('open',`data-open-task="${esc(run.taskId)}"`,'Görevi aç')}${terminalClearButton(run.id,title)}`;},
  exit:(run,status)=>activeRun(run)?'':globalThis.AIWSI18n.template`${terminalDot(status)}<span>Oturum sona erdi · ${esc(status.label)}</span><button type="button" class="button small" data-open-task="${esc(run.taskId)}">Görevi aç</button><button type="button" class="button small" data-terminal-close="${esc(run.id)}">Paneli kapat</button>`,
  // A stream run has no terminal output; its pane shows the run's agent console instead.
  content:(run,host)=>{if(run.terminalMode==='pty')return false;const item=state.tasks.find(task=>task.id===run.taskId);host.classList.add('session-console-host');if(item)mountTaskConsole(item,host,run);return true;}
};
function mountTerminal(run,host) {
  if(!host)return;let view=[...terminalViews].find(view=>view.runId===run.id&&view.element.parentElement===host);
  // The replay is fetched on demand; live chunks then continue from its end offset.
  if(!view){view=window.AIWSTerminal.create(host,{run,...runTerminalOptions(run),onError:error=>toast(error.message)});const destroy=view.destroy;view.destroy=()=>{destroy();terminalViews.delete(view);};terminalViews.add(view);}
  else view.update(run);
  return view;
}
