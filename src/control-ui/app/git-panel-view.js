'use strict';
// The footer Git chip and the Git panel markup.
function gitTaskDetails(item){
  // The overview is a snapshot; the live state has the current status.
  const live=state.tasks.find(entry=>entry.id===item?.id);
  return live?{...item,title:window.AIWSUI.taskTitle(live),status:live.status}:item;
}
function gitCurrentTask(data){return gitTaskDetails(data.branches.find(branch=>branch.name===data.currentBranch)?.task);}
function gitTaskLink(item){
  if(!item)return '';
  item=gitTaskDetails(item);
  const badge=gitMergeStalled(item)?globalThis.AIWSI18n.text('<span class="git-badge" data-tone="failed">AI conflicti çözemedi · tekrar dene veya elle çöz</span>'):gitMerging(item)?globalThis.AIWSI18n.text('<span class="git-badge" data-tone="running"><span class="ui-spinner" aria-hidden="true"></span>AI merge ediyor</span>'):'';
  return globalThis.AIWSI18n.template`<button type="button" class="git-task" data-git-task="${esc(item.id)}" title="${esc(window.AIWSUI.taskTitle(item))}"><span class="task-status-chip ${esc(item.status)}">${esc(statuses[item.status]||item.status)}</span><span>${esc(window.AIWSUI.taskTitle(item))}</span></button>${badge}`;
}
const gitTaskActive=item=>['running','waiting','paused'].includes(gitLiveStatus(item));
const gitLiveStatus=item=>state.tasks.find(entry=>entry.id===item?.id)?.status||item?.status;
// A resolver run that failed or was cancelled leaves the conflict for the user; merging again retries it.
const gitMergePending=item=>{
  const live=state.tasks.find(entry=>entry.id===item?.id);
  if(!live)return Boolean(item?.merging)&&item?.status!=='done';
  return live.status!=='done'&&!live.worktree?.mergedSha&&!live.worktree?.cleanedAt&&Boolean(live.queuedContinuation?.mergeRecovery||live.worktree?.mergeRequested);
};
const gitMergeStalled=item=>gitMergePending(item)&&['failed','cancelled'].includes(gitLiveStatus(item));
const gitMerging=item=>gitMergePending(item)&&!gitMergeStalled(item);
const gitMergeable=branch=>!branch.main&&!gitTaskActive(branch.task);
function gitCounts(ahead,behind){return `${behind?`<span class="git-count" title="${esc(globalThis.AIWSI18n.text('Çekilecek commit'))}">↓${behind}</span>`:''}${ahead?`<span class="git-count" title="${esc(globalThis.AIWSI18n.text('Gönderilecek commit'))}">↑${ahead}</span>`:''}`;}
function gitConflictList(files){return files?.length?globalThis.AIWSI18n.template`<div class="git-conflicts" role="alert"><strong>Merge conflict</strong><ul>${files.map(file=>`<li><code>${esc(file)}</code></li>`).join('')}</ul></div>`:'';}
/** The last command's result with a close button; it stays hidden while a command still runs. */
function gitResultBox(){
  const html=renderGitResult();
  return html?`<div class="git-result-box">${html}${git.busy?'':`<button type="button" class="icon-button git-result-close" data-git-dismiss aria-label="${esc(globalThis.AIWSI18n.text('Sonucu kapat'))}">${window.AIWSUI.icon('x')}</button>`}</div>`:'';
}
function renderGitResult(result=git.result){
  if(!result)return '';
  if(result.batch)return `<div class="git-batch">${result.batch.map(entry=>renderGitResult(entry)).join('')}</div>`;
  if(result.error)return `<p class="git-result" data-tone="failed" role="alert">${result.branch?`<strong>${esc(result.branch)}</strong>: `:''}${esc(result.error)}</p>`;
  if(result.status==='merged')return globalThis.AIWSI18n.template`<div class="git-result" data-tone="done" role="status"><div class="git-result-head">${window.AIWSUI.icon('check')}<span><strong>${esc(result.branch)}</strong> main'e merge edildi ve silindi.</span></div>${result.warnings?.length?`<ul class="git-result-notes">${result.warnings.map(warning=>`<li>${esc(warning)}</li>`).join('')}</ul>`:''}</div>`;
  if(!result.status&&result.warnings?.length)return `<div class="git-result" data-tone="needs" role="status"><ul class="git-result-notes">${result.warnings.map(warning=>`<li>${esc(warning)}</li>`).join('')}</ul></div>`;
  if(result.status==='resolving')return globalThis.AIWSI18n.template`<div class="git-result" data-tone="needs" role="status"><strong>${esc(result.branch)}</strong> merge conflict çıkardı. AI çözüyor; doğrulandıktan sonra main'e merge edilip silinecek. ${gitTaskLink(state.tasks.find(item=>item.id===result.taskId)||{id:result.taskId,title:result.taskId,status:'ready'})}${gitConflictList(result.conflicts)}</div>`;
  if(result.status==='conflict')return globalThis.AIWSI18n.template`<div class="git-result" data-tone="failed" role="alert"><strong>${esc(result.branch)}</strong> otomatik çözülemedi; conflictleri elle çöz.<pre>${esc(result.message||'')}</pre>${gitConflictList(result.conflicts)}</div>`;
  return '';
}
function renderGitStatus(){
  const button=$('#git-status'),current=gitProject();button.hidden=!current;if(!current)return;
  const data=git.projectId===current.id?git.data:null;
  const currentTask=data?gitCurrentTask(data):null;
  const label=data?`${esc(data.currentBranch||globalThis.AIWSI18n.text('ayrık HEAD'))}${gitCounts(data.ahead,data.behind)}${data.changes?`<span class="git-count changes" title="${esc(globalThis.AIWSI18n.text('Commitlenmemiş değişiklik'))}">●${data.changes}${data.additions||data.deletions?` +${data.additions} −${data.deletions}`:''}</span>`:''}${data.operation||data.worktrees.some(tree=>tree.conflicts.length)?'<span class="git-count danger">!</span>':''}`:esc(git.error&&git.projectId===current.id?globalThis.AIWSI18n.text('Git yok'):'Git');
  setHtml($('#git-status-label'),label);button.title=data&&currentTask?window.AIWSUI.taskTitle(currentTask):'';button.classList.toggle('busy',Boolean(git.busy));
}
function renderGit(){
  renderGitStatus();
  const panel=$('#git-panel');if(panel.hidden)return;
  const current=gitProject();if(!current){closeGitPanel();return;}
  const data=git.projectId===current.id?git.data:null,busy=git.busy,t=globalThis.AIWSI18n.text;
  const button=(command,label,title,extra='')=>`<button type="button" class="button small" data-git-command="${command}" title="${esc(title)}" ${busy?'disabled':''} ${extra}>${busy===command?t('Çalışıyor…'):label}</button>`;
  const header=globalThis.AIWSI18n.template`<header class="git-panel-header"><div><h2 id="git-panel-title"><span class="git-icon" aria-hidden="true">${$('#git-status .git-icon').innerHTML}</span> Git · ${esc(current.name)}</h2><small title="${esc(data?.repositoryPath||current.repositoryPath)}">${esc(data?.repositoryPath||current.repositoryPath)}</small></div><button type="button" class="icon-button" data-git-close aria-label="Git panelini kapat">${window.AIWSUI.icon('x')}</button></header>`;
  // Until the first answer arrives the panel shows the shape of its rows instead of an empty box.
  if(!data){setHtml(panel,`${header}<div class="git-panel-body">${git.error?`<p class="git-result" data-tone="failed" role="alert">${esc(git.error)}</p>`:`${t('<p class="sr-only" role="status">Git bilgileri yükleniyor…</p>')}<div class="git-skeleton" aria-hidden="true"><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span></div>`}</div>`);return;}
  const mergeable=data.branches.filter(branch=>gitMergeable(branch)&&!gitMerging(branch.task)),confirmingAll=git.confirm==='*';
  const mergeAll=`<button type="button" class="button small${confirmingAll?' danger':''} git-merge-all" data-git-merge-all ${busy||!mergeable.length?'disabled':''} title="${esc(t("Merge edilebilecek tüm branch'leri sırayla main'e merge et; ardından branch'leri, worktree'lerini ve uzaktaki kopyalarını sil"))}">${busy==='merge-all'?t('Merge ediliyor…'):confirmingAll?globalThis.AIWSI18n.template`Onayla: ${mergeable.length} branch'i merge et ve sil`:globalThis.AIWSI18n.template`Tümünü main'e merge et ve sil (${mergeable.length})`}</button>`;
  const toolbar=`<div class="git-toolbar">${button('fetch',t('⟳ Fetch'),t("Tüm uzak depoları getir ve silinen branch'leri temizle"))}${button('pull',globalThis.AIWSI18n.template`↓ Pull${data.behind?` (${data.behind})`:''}`,t("Geçerli branch'i yalnızca fast-forward ile güncelle"))}${button('push',globalThis.AIWSI18n.template`↑ Push${data.ahead?` (${data.ahead})`:''}`,t("Geçerli branch'i uzak depoya gönder"))}<button type="button" class="button small ghost" data-git-refresh ${git.loading?'disabled':''}>${t('↻ Yenile')}</button>${mergeAll}</div>`;
  // Uncommitted changes open as a list beside the task panel, or at the right edge.
  const diffStat=(item,worktree)=>item.changes?` <button type="button" class="git-changes-link" data-git-changes="${esc(worktree)}" title="${esc(t('Değişiklikleri göster'))}">${window.AIWSFiles.diffStat(item)||t('Değişiklikleri göster')}</button>`:'';
  const currentTask=gitCurrentTask(data);
  const summary=globalThis.AIWSI18n.template`<p class="git-summary">${currentTask?gitTaskLink(currentTask):`<strong>${esc(data.currentBranch||t('ayrık HEAD'))}</strong>`}${data.upstream?` → ${esc(data.upstream)}`:t(' · upstream yok')} · ${data.changes?globalThis.AIWSI18n.template`${data.changes} commitlenmemiş değişiklik`:t('çalışma alanı temiz')}${diffStat(data,'')} · ${data.remotes.length?esc(data.remotes.join(', ')):t('uzak depo yok')}</p>`;
  const operation=data.operation?globalThis.AIWSI18n.template`<div class="git-result" data-tone="failed" role="alert">Ana çalışma alanında yarım kalan işlem: ${esc(data.operation)}${gitConflictList(data.conflicts)}</div>`:'';
  const tabs=`<div class="git-tabs view-tabs" role="tablist">${[['commit',t('Commit'),data.changes],['branches',t("Branch'ler"),data.branches.length],['worktrees',t('Worktreeler'),data.worktrees.length]].map(([id,label,count])=>`<button type="button" role="tab" class="view-tab${git.tab===id?' active':''}" aria-selected="${git.tab===id}" data-git-tab="${id}">${label} <span class="nav-count">${count}</span></button>`).join('')}</div>`;
  // The ⋯ menu of a row; `items` are menu item buttons, and an empty list leaves no menu.
  const rowMenu=(key,items)=>{const html=items.filter(Boolean).join('');if(!html)return '';const open=git.menu===key;return `<div class="git-menu"><button type="button" class="button small ghost" data-git-menu="${esc(key)}" aria-haspopup="menu" aria-expanded="${open}" aria-label="${esc(t('Diğer işlemler'))}" title="${esc(t('Diğer işlemler'))}">⋯</button>${open?`<div class="git-menu-list popup-menu" role="menu">${html}</div>`:''}</div>`;};
  // Deleting without merging: `key` names the confirmation, and the branch and/or worktree go to the server.
  const deleteItem=(key,{branch,worktree},label,title,disabled=false)=>{const confirming=git.confirm===`delete:${key}`;return `<button type="button" role="menuitem" class="git-menu-item${confirming?' danger':''}" data-git-delete="${esc(key)}"${branch?` data-git-delete-branch="${esc(branch)}"`:''}${worktree?` data-git-delete-worktree="${esc(worktree)}"`:''} ${busy||disabled?'disabled':''} title="${esc(title)}">${busy===`delete:${key}`?t('Siliniyor…'):confirming?t('Onayla: sil'):label}</button>`;};
  const branchRow=branch=>{
    const confirming=git.confirm===branch.name,merging=busy===`merge:${branch.name}`;
    const mergeButton=!gitMergeable(branch)?'':`<button type="button" role="menuitem" class="git-menu-item${confirming?' danger':''}" data-git-merge="${esc(branch.name)}" ${busy||gitMerging(branch.task)?'disabled':''} title="${esc(t("Branch'i main'e merge et; ardından branch'i, worktree'sini ve uzaktaki kopyasını sil"))}">${merging?t('Merge ediliyor…'):confirming?t('Onayla: merge et ve sil'):t("Main'e merge et ve sil")}</button>`;
    const deleteButton=branch.main||branch.current?'':deleteItem(`branch:${branch.name}`,{branch:branch.name},branch.worktreePath?t("Branch'i ve worktree'sini sil"):t("Branch'i sil"),t('Merge etmeden sil; commitlenmemiş ve merge edilmemiş değişiklikler kaybolur. Uzaktaki kopya kalır.'),gitTaskActive(branch.task));
    const merge=rowMenu(`branch:${branch.name}`,[mergeButton,deleteButton]);
    const push=`<button type="button" class="button small ghost" data-git-push="${esc(branch.name)}" ${busy?'disabled':''} title="${esc(t("Branch'i uzak depoya gönder"))}">↑</button>`;
    const versusMain=branch.main?'':branch.mainAhead||branch.mainBehind?globalThis.AIWSI18n.template`<span class="git-meta" title="main'e göre">main: +${branch.mainAhead} / −${branch.mainBehind}</span>`:t('<span class="git-meta">main ile aynı</span>');
    return `<li class="git-row${branch.current?' current':''}"><div class="git-row-main">${branch.task?`${gitTaskLink(branch.task)}`:`<span class="git-branch-name" title="${esc(branch.name)}">${esc(branch.name)}</span>`}${branch.main?'<span class="git-badge">main</span>':''}${branch.current?t('<span class="git-badge" data-tone="accent">geçerli branch</span>'):''}${branch.worktreePath&&!branch.current?'<span class="git-badge" title="'+esc(branch.worktreePath)+'">worktree</span>':''}${branch.upstream?`<span class="git-meta" title="${esc(branch.upstream)}">${esc(branch.upstream)}${branch.gone?t(' (uzakta silinmiş)'):''}</span>${gitCounts(branch.ahead,branch.behind)}`:''}${versusMain}</div><div class="git-row-sub"><code>${esc(branch.sha)}</code> <span class="git-subject">${esc(branch.subject)}</span></div>${branch.task?.mergeError?`<p class="git-row-error">${esc(branch.task.mergeError)}</p>`:''}<div class="git-row-actions">${push}${merge}</div></li>`;
  };
  const treeMenu=tree=>{
    if(tree.main)return '';
    const active=gitTaskActive(tree.task),title=t('Merge etmeden sil; commitlenmemiş değişiklikler kaybolur.');
    return rowMenu(`tree:${tree.path}`,[deleteItem(`tree:${tree.path}`,{worktree:tree.path},t("Worktree'yi sil"),title,active),tree.branch&&tree.branch!==data.mainBranch?deleteItem(`tree+branch:${tree.path}`,{worktree:tree.path,branch:tree.branch},t("Worktree'yi ve branch'i sil"),title,active):'']);
  };
  const treeRow=tree=>`<li class="git-row"><div class="git-row-main">${tree.task?`${gitTaskLink(tree.task)}`:`<span class="git-branch-name">${esc(tree.branch||t('ayrık HEAD'))}</span>`}${tree.main?t('<span class="git-badge">ana depo</span>'):''}${tree.locked?t('<span class="git-badge">worktree kilitli</span>'):''}${tree.prunable?t('<span class="git-badge" data-tone="needs">klasör bulunamadı</span>'):''}${tree.changes?globalThis.AIWSI18n.template`<span class="git-badge" data-tone="needs">${tree.changes} commitlenmemiş değişiklik</span>`:''}${diffStat(tree,tree.main?'':tree.path)}</div><div class="git-row-sub"><code>${esc(tree.head)}</code> <span class="git-subject" title="${esc(tree.path)}">${esc(tree.path)}</span></div>${gitConflictList(tree.conflicts)}${tree.main?'':`<div class="git-row-actions">${treeMenu(tree)}</div>`}</li>`;
  // Task folders on disk: registered worktrees and leftovers. Idle ones can be deleted; branches are kept.
  const idleFolders=data.folders.filter(folder=>!folder.active);
  const folderRow=folder=>{
    const confirming=git.confirm===`folder:${folder.path}`;
    const remove=folder.active?`<span class="git-badge" data-tone="running">${t('Üzerinde çalışılıyor')}</span>`:`<button type="button" class="button small${confirming?' danger':''}" data-git-folder-delete="${esc(folder.path)}" ${busy?'disabled':''} title="${esc(t('Klasörü sil; branch silinmez'))}">${busy===`folder:${folder.path}`?t('Siliniyor…'):confirming?t('Onayla: sil'):t('Sil')}</button>`;
    return `<li class="git-row"><div class="git-row-main">${folder.task?gitTaskLink(folder.task):`<span class="git-branch-name">${esc(folder.name)}</span>`}${folder.registered?t('<span class="git-badge">worktree</span>'):t('<span class="git-badge" data-tone="needs">artık klasör</span>')}${folder.changes?globalThis.AIWSI18n.template`<span class="git-badge" data-tone="needs">${folder.changes} commitlenmemiş değişiklik</span>`:''}</div><div class="git-row-sub"><button type="button" class="git-subject git-path-link" data-git-folder-open="${esc(folder.path)}" title="${esc(t('Dosya gezgininde aç'))}">${esc(folder.path)}</button></div><div class="git-row-actions">${remove}</div></li>`;
  };
  const clearAll=`<button type="button" class="button small${git.confirm==='folders:*'?' danger':''}" data-git-folder-delete-all ${busy||!idleFolders.length?'disabled':''}>${busy==='folders:*'?t('Siliniyor…'):git.confirm==='folders:*'?globalThis.AIWSI18n.template`Onayla: ${idleFolders.length} klasörü sil`:globalThis.AIWSI18n.template`Çalışılmayanların hepsini sil (${idleFolders.length})`}</button>`;
  // A titled group inside a tab; `action` sits at the right of the title.
  const group=(title,count,body,action='')=>`<section class="git-group"><header class="git-group-header"><h3>${title} <span class="nav-count">${count}</span></h3>${action}</header>${body}</section>`;
  const worktreesTab=()=>`${group(t('Worktreeler'),data.worktrees.length,`<ul class="git-list">${data.worktrees.map(treeRow).join('')}</ul>`)}${group(t('Worktree klasörleri'),data.folders.length,`<ul class="git-list">${data.folders.map(folderRow).join('')||`<li class="git-row"><span class="git-meta">${t('Klasör yok')}</span></li>`}</ul>`,clearAll)}`;
  const commitRow=commit=>`<li class="git-row"><div class="git-row-sub"><code>${esc(commit.sha)}</code> <span class="git-subject git-commit-subject" title="${esc(commit.subject)}">${esc(commit.subject)}</span></div><div class="git-row-sub git-meta">${esc(commit.author)} · <time datetime="${esc(commit.date)}" title="${esc(new Date(commit.date).toLocaleString())}">${esc(historyAgo(commit.date))}</time></div></li>`;
  const recentCommits=()=>group(t('Son commitler'),data.commits.length,`<ul class="git-list">${data.commits.map(commitRow).join('')||`<li class="git-row"><span class="git-meta">${t('Henüz commit yok')}</span></li>`}</ul>`);
  // Commits every change of the main workspace; the typed message lives in `git.draft` so re-renders keep it.
  const commitForm=()=>`<form class="git-commit" data-git-commit-form><input type="text" name="summary" maxlength="500" required placeholder="${esc(t('Özet (gerekli)'))}" aria-label="${esc(t('Özet'))}" autocomplete="off"><textarea name="description" rows="4" placeholder="${esc(t('Açıklama'))}" aria-label="${esc(t('Açıklama'))}"></textarea><div class="git-commit-actions"><span class="git-meta">${t('Ctrl+Enter ile commitle')}</span><button type="submit" class="button small primary" ${busy||!data.changes||data.operation?'disabled':''}>${busy==='commit'?t('Commitleniyor…'):t('Commit')}</button></div></form>`;
  const list=git.tab==='commit'?`${commitForm()}${recentCommits()}`:git.tab==='branches'?`<ul class="git-list">${data.branches.map(branchRow).join('')}</ul>`:worktreesTab();
  // A replaced form loses what was typed and the caret; both come back from the draft.
  const focused=document.activeElement?.closest?.('[data-git-commit-form]')?document.activeElement:null,field=focused?.name,selection=field?[focused.selectionStart,focused.selectionEnd]:null;
  const replaced=setHtml(panel,`${header}<div class="git-panel-body">${toolbar}${summary}${operation}${gitResultBox()}${tabs}${list}</div>`);
  const form=$('[data-git-commit-form]',panel);if(!form)return;
  for(const name of ['summary','description'])if(form.elements[name].value!==git.draft[name])form.elements[name].value=git.draft[name];
  if(replaced&&field){const input=form.elements[field];input.focus();input.setSelectionRange(...selection);}
}
