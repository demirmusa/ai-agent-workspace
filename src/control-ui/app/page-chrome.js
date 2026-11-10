'use strict';
// The parts of the shell that follow the active screen: the page title, the create button and the footer count.
// The library screens draw their own (library.js).
const createButtonLabel=label=>`<span aria-hidden="true">+</span> ${label}`;
function boardTaskSummary(current){
  if(!current)return globalThis.AIWSI18n.text('Hazır olduğunda başlayalım.');
  const displayed=boardTasks().filter(item=>Boolean(item.archivedAt)===archiveView),done=displayed.filter(t=>t.status==='done').length;
  return globalThis.AIWSI18n.template`${displayed.length} ${archiveView?globalThis.AIWSI18n.text('arşivlenmiş görev'):globalThis.AIWSI18n.text('görev')} · ${done} tamamlandı${current.github?globalThis.AIWSI18n.text(' · GitHub bağlı'):globalThis.AIWSI18n.text(' · Bu cihazda saklanıyor')}`;
}
function projectTabSummary(tab,current){
  if(tab==='schedules'){const schedules=(state.schedules||[]).filter(item=>item.projectId===projectId);return globalThis.AIWSI18n.template`${schedules.length} zamanlama · ${schedules.filter(item=>item.enabled).length} etkin`;}
  if(tab==='terminal')return globalThis.AIWSI18n.text('Proje terminali');
  if(tab==='editor')return globalThis.AIWSI18n.text('Dosya editörü');
  if(tab==='settings')return current?.github?globalThis.AIWSI18n.text('Proje ayarları · GitHub bağlı'):globalThis.AIWSI18n.text('Proje ayarları · Bu cihazda saklanıyor');
  const sessions=projectSessionCache.get(projectId);return globalThis.AIWSI18n.template`${sessions?.total??sessions?.items.length??0} yerel oturum · Codex / Claude Code`;
}
function renderPageChrome(current){
  if(['agents','skills'].includes(activeScreen))return;
  const t=globalThis.AIWSI18n.text,create=$('#create-task'),count=$('#task-count'),tab=projectTab();
  $('#board').classList.remove('library-surface');
  // Project views put their tabs in the header, so they carry no summary or title there: the sidebar already marks the open project.
  setPageHeader(projectName(current)||t('Projeler'),current?'':t('Projelerini oluştur, görevlerini sıraya koy ve agentlarla birlikte çalış.'),!current);
  let label=t('Yeni görev');create.hidden=!current;count.textContent=boardTaskSummary(current);
  if(activeScreen==='board'&&current&&['editor','sessions','terminal','settings','schedules'].includes(tab)){
    if(tab==='schedules')label=t('Yeni zamanlama');
    count.textContent=projectTabSummary(tab,current);
  }
  // The tab bar takes the room of the summary here.
  if(activeScreen==='overview'){setPageHeader(t('Tüm projeler'));create.hidden=!state.projects.length||overviewTab()!=='board';}
  if(activeScreen==='dashboard'){setPageHeader(t('Dashboard'),t('Tüm projelerden toplanan iş, agent ve kullanım verileri.'));create.hidden=true;count.textContent='';}
  if(activeScreen==='workflows')setPageHeader(t('İş akışları'),t('Agentları sırayla çalıştır; geliştirme, inceleme ve dağıtımı tek akışta birleştir.'));
  if(activeScreen==='workflows'){create.hidden=false;label=t('Yeni iş akışı');}
  if(activeScreen==='settings'){setPageHeader(t('Ayarlar'),t('Sağlayıcıları, çalıştırma altyapısını ve GitHub eşitlemesini tüm projeler için tek yerden yönet.'));create.hidden=true;count.textContent=t('Ayarlar tüm projeler için geçerlidir.');}
  if(window.AIWSPlugins?.isPage(activeScreen)){const page=window.AIWSPlugins.pageInfo(activeScreen);setPageHeader(page.title,page.summary);create.hidden=true;count.textContent='';}
  setHtml(create,createButtonLabel(esc(label)));
}
// The create button makes what the active screen lists.
$('#create-task').onclick=()=>activeScreen==='agents'?agentModal():activeScreen==='skills'?skillModal():activeScreen==='workflows'?workflowModal():activeScreen==='board'&&projectTab()==='schedules'?scheduleModal():taskModal();
