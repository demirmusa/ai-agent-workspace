'use strict';
// The footer Git panel: loading, commands, merges and folder cleanup.
// Footer Git panel: branches, worktrees and their tasks, remote commands and "merge into main and delete".
const git={projectId:null,data:null,error:'',busy:'',tab:'commit',draft:{summary:'',description:''},result:null,confirm:null,menu:null,confirmTimer:null,loading:false};
function gitProject(){const current=activeScreen==='board'?project():null;return current?.general?null:current;}
async function loadGit(){
  const current=gitProject();if(!current||git.loading)return;
  git.loading=true;gitLastLoad=Date.now();
  try{const data=await api(`/projects/${encodeURIComponent(current.id)}/git`);if(gitProject()?.id===current.id){git.data=data;git.error='';projectFileViews.get(`${current.id}|${current.repositoryPath}`)?.refreshChanges();}}
  catch(cause){if(gitProject()?.id===current.id){git.data=null;git.error=cause.message;}}
  // A project switch while this request ran was skipped by the loading guard; the new project loads now.
  finally{git.loading=false;renderGit();if(!$('#git-panel').hidden&&gitProject()&&gitProject().id!==current.id)void loadGit();}
}
function placeGitPanel(){const panel=$('#git-panel'),footer=$('.board-footer').getBoundingClientRect();panel.style.left=`${Math.max(8,footer.left+8)}px`;panel.style.bottom=`${Math.max(8,innerHeight-footer.top+6)}px`;}
function openGitPanel(){const panel=$('#git-panel');panel.hidden=false;$('#git-status').setAttribute('aria-expanded','true');placeGitPanel();renderGit();void loadGit();($('[data-git-command]',panel)||$('[data-git-close]',panel))?.focus();}
function closeGitPanel(focus=false){const panel=$('#git-panel');if(panel.hidden)return;panel.hidden=true;$('#git-status').setAttribute('aria-expanded','false');git.confirm=null;git.menu=null;if(focus)$('#git-status').focus();}
/** Merges every branch that can be merged, one after another; a conflict or failure does not stop the rest. */
async function mergeAllGit(){
  const current=gitProject();if(!current||git.busy||!git.data)return;
  const branches=git.data.branches.filter(branch=>gitMergeable(branch)&&!gitMerging(branch.task)).map(branch=>branch.name);if(!branches.length)return;
  git.busy='merge-all';git.result={batch:[]};renderGit();
  try{for(const branch of branches){let result;try{result=await api(`/projects/${encodeURIComponent(current.id)}/git/merge`,'POST',{branch});}catch(cause){result={branch,error:cause.message};}git.result={batch:[...git.result.batch,result]};renderGit();}}
  finally{git.busy='';await loadGit();}
}
async function deleteGitFolders(kind,body){
  const current=gitProject();if(!current||git.busy)return;
  git.busy=kind;git.result=null;renderGit();
  try{const result=await api(`/projects/${encodeURIComponent(current.id)}/git/folders/delete`,'POST',body);
    if(result.errors.length)git.result={batch:result.errors.map(entry=>({branch:entry.path,error:entry.error}))};else toast(globalThis.AIWSI18n.template`${result.removed.length} klasör silindi.`);}
  catch(cause){git.result={error:cause.message};}
  finally{git.busy='';await loadGit();}
}
async function runGit(kind,path,body={}){
  const current=gitProject();if(!current||git.busy)return;
  git.busy=kind;git.result=null;renderGit();
  try{const result=await api(`/projects/${encodeURIComponent(current.id)}/git/${path}`,'POST',body);git.result=result;if(result.message&&!result.status)toast(result.message);}
  catch(cause){git.result={error:cause.message};}
  finally{git.busy='';await loadGit();}
}
/** Commits the main workspace with the drafted summary and description; a success clears the draft. */
async function commitGit(){
  const summary=git.draft.summary.trim();if(!summary||git.busy||!git.data?.changes)return;
  await runGit('commit','commit',{summary,description:git.draft.description});
  if(!git.result?.error){git.draft={summary:'',description:''};git.result=null;renderGit();}
}
$('#git-status').onclick=()=>{if($('#git-panel').hidden)openGitPanel();else closeGitPanel();};
$('#git-panel').addEventListener('click',event=>{
  const target=event.target.closest('button');if(!target)return;
  if(target.hasAttribute('data-git-close')){closeGitPanel(true);return;}
  if(target.hasAttribute('data-git-dismiss')){git.result=null;renderGit();return;}
  if(target.hasAttribute('data-git-refresh')){void loadGit();return;}
  if(target.dataset.gitMenu){const name=target.dataset.gitMenu;git.menu=git.menu===name?null:name;git.confirm=null;clearTimeout(git.confirmTimer);renderGit();return;}
  if(target.dataset.gitTab){git.tab=target.dataset.gitTab;renderGit();return;}
  if(target.dataset.gitFolderOpen){const current=gitProject();if(current)api(`/projects/${encodeURIComponent(current.id)}/git/folders/open`,'POST',{path:target.dataset.gitFolderOpen}).catch(cause=>toast(cause.message));return;}
  if(target.dataset.gitFolderDelete||target.hasAttribute('data-git-folder-delete-all')){
    const all=target.hasAttribute('data-git-folder-delete-all'),path=target.dataset.gitFolderDelete,key=all?'folders:*':`folder:${path}`;clearTimeout(git.confirmTimer);
    // Deleting is permanent, so it takes a second, deliberate click.
    if(git.confirm!==key){git.confirm=key;git.confirmTimer=setTimeout(()=>{git.confirm=null;renderGit();},5000);renderGit();return;}
    git.confirm=null;void deleteGitFolders(key,all?{all:true}:{path});return;
  }
  if(target.dataset.gitCommand){void runGit(target.dataset.gitCommand,target.dataset.gitCommand);return;}
  if(target.dataset.gitPush){void runGit('push','push',{branch:target.dataset.gitPush});return;}
  if(target.hasAttribute('data-git-changes')){const current=gitProject(),worktree=target.dataset.gitChanges,tree=git.data?.worktrees.find(entry=>worktree?entry.path===worktree:entry.main);if(!current)return;openChanges({key:`git:${current.id}:${worktree}`,path:`/projects/${encodeURIComponent(current.id)}/git/changes${worktree?`?${new URLSearchParams({worktree})}`:''}`,title:globalThis.AIWSI18n.template`Değişiklikler · ${tree?.branch||git.data?.currentBranch||current.name}`,button:$('#git-status')});return;}
  if(target.hasAttribute('data-git-merge-all')){
    clearTimeout(git.confirmTimer);
    if(git.confirm!=='*'){git.confirm='*';git.menu=null;git.confirmTimer=setTimeout(()=>{git.confirm=null;renderGit();},5000);renderGit();return;}
    git.confirm=null;void mergeAllGit();return;
  }
  if(target.dataset.gitTask){const owner=state.tasks.find(item=>item.id===target.dataset.gitTask);if(!owner)return;closeGitPanel();if(owner.projectId!==projectId){projectId=owner.projectId;localStorage.setItem('aiws.project',projectId);}activeScreen='board';openTask(owner.id);return;}
  if(target.dataset.gitDelete){
    const key=target.dataset.gitDelete;clearTimeout(git.confirmTimer);
    // Deleting discards unmerged commits and uncommitted changes, so it takes a second, deliberate click.
    if(git.confirm!==`delete:${key}`){git.confirm=`delete:${key}`;git.confirmTimer=setTimeout(()=>{git.confirm=null;renderGit();},5000);renderGit();return;}
    const body={};if(target.dataset.gitDeleteBranch)body.branch=target.dataset.gitDeleteBranch;if(target.dataset.gitDeleteWorktree)body.worktree=target.dataset.gitDeleteWorktree;
    git.confirm=null;git.menu=null;void runGit(`delete:${key}`,'delete',body);return;
  }
  if(target.dataset.gitMerge){
    const branch=target.dataset.gitMerge;clearTimeout(git.confirmTimer);
    // Merging deletes the branch, so it takes a second, deliberate click.
    if(git.confirm!==branch){git.confirm=branch;git.confirmTimer=setTimeout(()=>{git.confirm=null;renderGit();},5000);renderGit();return;}
    git.confirm=null;git.menu=null;void runGit(`merge:${branch}`,'merge',{branch});
  }
});
$('#git-panel').addEventListener('input',event=>{const field=event.target;if(field.closest('[data-git-commit-form]')&&field.name in git.draft)git.draft[field.name]=field.value;});
$('#git-panel').addEventListener('submit',event=>{if(!event.target.matches('[data-git-commit-form]'))return;event.preventDefault();void commitGit();});
$('#git-panel').addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&event.target.closest('[data-git-commit-form]')){event.preventDefault();event.target.closest('form').requestSubmit();}});
document.addEventListener('click',async event=>{
  const target=event.target.closest('[data-task-merge]');if(!target)return;
  const item=state.tasks.find(entry=>entry.id===target.dataset.taskMerge);if(!item?.worktree||target.disabled)return;
  // The branch goes into the project's main branch; in pull request mode through the task's pull request.
  const t=globalThis.AIWSI18n,owner=state.projects.find(entry=>entry.id===item.projectId),main=item.worktree.mainBranch||owner?.mainBranch||'main',pullRequest=(owner?.taskMergeMode||state.settings.taskMergeMode||'pull-request')==='pull-request';
  if(!await confirmModal(t.text('Branch merge edilsin mi?'),`${item.worktree.branch} → ${main} · ${pullRequest?t.text('Pull request ile merge edilip branch silinecek.'):t.text('Merge edilip branch silinecek.')}`,{confirmLabel:t.text('Merge et ve sil')}))return;
  target.disabled=true;
  try{const result=await api(`/projects/${encodeURIComponent(item.projectId)}/git/merge`,'POST',{branch:item.worktree.branch});toast(result.status==='merged'?`${item.worktree.branch} → ${main} · ${t.text('Merge edildi ve branch silindi.')}`:result.status==='resolving'?globalThis.AIWSI18n.text('Merge conflict çıktı; AI çözüyor.'):result.message||globalThis.AIWSI18n.text('Merge otomatik çözülemedi; conflictleri elle çöz.'));await refresh();}
  catch(problem){error(problem.message);target.disabled=false;}
});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('#git-panel').hidden&&!$('#modal').open&&!event.target.closest?.('#agent-child-panel')){event.preventDefault();closeGitPanel(true);}});
document.addEventListener('pointerdown',event=>{if(!$('#git-panel').hidden&&!event.target.closest('#git-panel,#git-status,#agent-child-panel'))closeGitPanel();else if(git.menu&&!event.target.closest('.git-menu')){git.menu=null;git.confirm=null;renderGit();}});
window.addEventListener('resize',()=>{if(!$('#git-panel').hidden)placeGitPanel();});
// Git is read in the background so the footer chip stays current: every 5 seconds while the panel is open,
// every 30 seconds otherwise, and again when the window comes back. The server reads Git asynchronously and
// the loading guard skips a tick while the previous read still runs, so nothing waits on it.
let gitLastLoad=0;
const gitPoll=setInterval(()=>{if(document.hidden||!gitProject()||git.loading)return;if(!$('#git-panel').hidden||Date.now()-gitLastLoad>=30000)void loadGit();},5000);
const gitWake=()=>{if(!document.hidden&&gitProject()&&Date.now()-gitLastLoad>=5000)void loadGit();};
document.addEventListener('visibilitychange',gitWake);window.addEventListener('focus',gitWake);
window.addEventListener('pagehide',()=>clearInterval(gitPoll));
function syncGitProject(){const current=gitProject();if((current?.id||null)===git.projectId){renderGitStatus();return;}git.projectId=current?.id||null;git.data=null;git.error='';git.result=null;renderGit();if(current)void loadGit();}
