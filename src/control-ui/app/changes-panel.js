'use strict';
// Git changes in the side panel.
// Git changes in the side panel: a task's work against main, or the uncommitted files of a checkout.
const changeViews=new Map();
function footerChangesOpen(){return childAgentSelection?.kind==='changes'&&!childAgentSelection.taskId;}
function changesEntry(key,path){let entry=changeViews.get(key);if(!entry){if(changeViews.size>=48)for(const old of changeViews.keys())if(old!==key&&childAgentSelection?.key!==old){changeViews.delete(old);if(changeViews.size<48)break;}entry={path,data:undefined,loading:false,error:'',at:0,open:new Set(),diffs:new Map()};changeViews.set(key,entry);}return entry;}
/** Reloads the patches of expanded rows after the list changed. */
async function refreshOpenDiffs(key,entry){
  for(const file of [...entry.open]){
    try{entry.diffs.set(file,await api(changeFileUrl(entry.path,file)));}catch(problem){entry.diffs.set(file,{error:problem.message});}
    if(childAgentSelection?.kind==='changes'&&childAgentSelection.key===key)renderChildAgent();
  }
}
/** The changes endpoint of a source with a `file` parameter appended. */
function changeFileUrl(path,file){return `${path}${path.includes('?')?'&':'?'}${new URLSearchParams({file})}`;}
async function toggleChangeDiff(selected,file){
  const entry=changesEntry(selected.key,selected.path);
  if(entry.open.delete(file)){renderChildAgent();return;}
  entry.open.add(file);
  const cached=entry.diffs.get(file);if(!cached||cached.error)entry.diffs.set(file,{loading:true});
  renderChildAgent();
  if(cached&&!cached.error)return;
  try{entry.diffs.set(file,await api(changeFileUrl(entry.path,file)));}
  catch(problem){entry.diffs.set(file,{error:problem.message});}
  if(childAgentSelection?.kind==='changes'&&childAgentSelection.key===selected.key)renderChildAgent();
}
async function openChangedFile(selected,file){
  const entry=changesEntry(selected.key,selected.path);
  try{await api(entry.path,'POST',{file,action:'open'});}catch(problem){toast(problem.message);}
}
async function loadChanges(key,path,force=false){
  const entry=changesEntry(key,path),shown=()=>childAgentSelection?.kind==='changes'&&childAgentSelection.key===key;
  if(entry.loading||!force&&Date.now()-entry.at<15000)return;
  entry.loading=true;entry.at=Date.now();if(shown())renderChildAgent();
  try{const response=await api(path);entry.data='changes' in response?response.changes:response;entry.error='';void refreshOpenDiffs(key,entry);}
  catch(problem){entry.error=problem.message;}
  finally{entry.loading=false;if(shown())renderChildAgent();if(key===`task:${selectedTaskId}`&&!$('#task-panel').hidden)renderDetail();}
}
/** The context and changes buttons beside the detail tabs. */
function taskSideTabs(item){const buttons=taskContextTab(item)+taskChangesTab(item);return buttons?`<div class="view-tabs detail-changes-tab">${buttons}</div>`:'';}
/** A task's changes move only while its agent works or its state changes, so a settled task is read once. */
function loadTaskChanges(item){
  const key=`task:${item.id}`,entry=changesEntry(key,`/tasks/${encodeURIComponent(item.id)}/changes`),version=`${item.status}:${item.currentRunId||''}`;
  if(activeRun(item)||entry.version!==version){if(!entry.loading&&Date.now()-entry.at>=15000)entry.version=version;void loadChanges(key,entry.path);}
  return entry;
}
/** The changes tab of a task; a task without a live branch has none. */
function taskChangesTab(item){
  const key=`task:${item.id}`,entry=loadTaskChanges(item);
  if(!entry.data)return '';
  const open=childAgentSelection?.kind==='changes'&&childAgentSelection.key===key;
  return globalThis.AIWSI18n.template`<button type="button" class="view-tab${open?' active':''}" data-open-changes aria-haspopup="dialog" aria-expanded="${open}" title="${esc(globalThis.AIWSI18n.text("Görevin main'e göre değişen dosyaları"))}">Değişiklikler <span class="nav-count">${entry.data.files.length}${entry.data.truncated?'+':''}</span></button>`;
}
/** Opens a changes list beside the task panel, or at the right edge; the same source again closes it. */
function openChanges({key,path,title,taskId=null,button}){
  if(childAgentSelection?.kind==='changes'&&childAgentSelection.key===key){closeChildAgent();return;}
  showSidePanel({kind:'changes',key,path,title,taskId,returnFocus:button});
  void loadChanges(key,path,true);if(taskId)renderDetail();
}
/** Merges the task branch into main only; the branch, worktree and task stay untouched. */
async function mergeChangesToMain(selected){
  const item=state.tasks.find(entry=>entry.id===selected.taskId),entry=changesEntry(selected.key,selected.path);if(!item?.worktree||entry.merging)return;
  entry.merging=true;renderChangesPanel(selected);
  try{const result=await api(`/projects/${encodeURIComponent(item.projectId)}/git/merge`,'POST',{branch:item.worktree.branch,keep:true});toast(result.status==='merged'?globalThis.AIWSI18n.text("Main'e merge edildi."):result.message||globalThis.AIWSI18n.text('Merge otomatik çözülemedi; conflictleri elle çöz.'));}
  catch(problem){error(problem.message);}
  finally{entry.merging=false;await loadChanges(selected.key,selected.path,true);if(childAgentSelection===selected)renderChangesPanel(selected);}
}
function renderChangesPanel(selected){
  const entry=changesEntry(selected.key,selected.path),data=entry.data,t=globalThis.AIWSI18n.text;
  // The task's branch was deleted (merged) while the list was open.
  if(data===null){closeChildAgent(false);return;}
  $('#child-agent-title').textContent=selected.title;$('#child-agent-status').textContent=data?globalThis.AIWSI18n.template`${data.files.length} değişen dosya`:t('Yükleniyor…');
  const pull=selected.taskId&&state.tasks.find(item=>item.id===selected.taskId)?.pullRequest;
  const source=data?`${pullRequestLink(pull)} <span title="${esc(data.root||'')}">${data.branch?`<code>${esc(data.branch)}</code> · `:''}${pull?.merged?t('Pull request değişiklikleri'):data.base&&data.base!=='HEAD'?t("main'e göre"):t('commitlenmemiş değişiklik')}</span>${window.AIWSFiles.diffStat(data)}`:'<span></span>';
  const summary=`${source}<button type="button" class="button small ghost" data-changes-refresh ${entry.loading?'disabled':''}>${t('↻ Yenile')}</button>${selected.taskId&&data?.branch?`<button type="button" class="button small" data-changes-merge ${entry.merging||entry.loading?'disabled':''} title="${esc(t("Branch'i main'e merge et; branch'i, worktree'yi ve görevi olduğu gibi bırak"))}">${entry.merging?t('Merge ediliyor…'):t("Main'e merge et")}</button>`:''}`;
  const body=entry.error&&!data?`<p class="git-result" data-tone="failed" role="alert">${esc(entry.error)}</p>`:data?window.AIWSFiles.changesHtml(data,entry):'<div class="git-skeleton" aria-hidden="true"><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span></div>';
  const host=$('#child-changes-host');
  // Another source starts from the top; the same source keeps its elements, so a background refresh never moves the reader.
  if(host.dataset.source!==selected.key||!host.querySelector('.changes-body')){host.dataset.source=selected.key;host.innerHTML='<div class="changes-summary"></div><div class="changes-body"></div>';}
  setHtml(host.querySelector('.changes-summary'),summary);
  setChangesBody(host.querySelector('.changes-body'),body);
}
/** Writes the file list only when it changed, keeping the scroll of the list and of every expanded patch. */
function setChangesBody(element,html){
  const top=element.scrollTop,patches=new Map([...element.querySelectorAll('.change-diff')].map(diff=>[diff.previousElementSibling.dataset.changePath,[diff.scrollLeft,diff.scrollTop]]));
  if(!setHtml(element,html))return;
  for(const diff of element.querySelectorAll('.change-diff')){const position=patches.get(diff.previousElementSibling.dataset.changePath);if(position)[diff.scrollLeft,diff.scrollTop]=position;}
  element.scrollTop=top;
}
document.addEventListener('click',event=>{const button=event.target.closest('[data-open-changes]'),item=task();if(!button||!item)return;openChanges({key:`task:${item.id}`,path:`/tasks/${encodeURIComponent(item.id)}/changes`,title:globalThis.AIWSI18n.text('Değişiklikler'),taskId:item.id,button});});
// An open list and the count of a working task follow the work; each source is read at most every 15 seconds.
const changesPoll=setInterval(()=>{if(document.hidden)return;const selected=childAgentSelection;if(selected?.kind==='changes')void loadChanges(selected.key,selected.path);const item=task();if(item&&!$('#task-panel').hidden)loadTaskChanges(item);},5000);
window.addEventListener('pagehide',()=>clearInterval(changesPoll));
document.addEventListener('click',event=>{
  if(!event.target.closest?.('#child-changes-host'))return;
  const selected=childAgentSelection;if(selected?.kind!=='changes')return;
  if(event.target.closest('[data-changes-refresh]')){void loadChanges(selected.key,selected.path,true);return;}
  if(event.target.closest('[data-changes-merge]')){void mergeChangesToMain(selected);return;}
  const opener=event.target.closest('[data-change-open]');
  if(opener){void openChangedFile(selected,opener.dataset.changeOpen);return;}
  const row=event.target.closest('[data-change-path]');if(row)void toggleChangeDiff(selected,row.dataset.changePath);
});
document.addEventListener('keydown',event=>{
  if(!event.target.closest?.('#child-changes-host'))return;
  const row=event.target.closest?.('[data-change-path]');if(!row||event.target!==row||event.key!=='Enter'&&event.key!==' ')return;
  const selected=childAgentSelection;if(selected?.kind!=='changes')return;event.preventDefault();void toggleChangeDiff(selected,row.dataset.changePath);
});
