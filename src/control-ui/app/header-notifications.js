'use strict';
// The header's notifications: a bell whose badge counts the requests not looked at yet, and a dropdown listing every request agents
// wait for. New rows fade in and settled ones fade out while the others glide into place; the desktop notification offer sits under them.
const unreadRequests=new Set(),notificationRowContent=new WeakMap();
function notificationRowHtml(question){const {approval,taskTitle,projectName}=requestContext(question);return `<span class="request-kind" data-kind="${approval?'approval':'question'}">${approval?globalThis.AIWSI18n.text('Onay'):globalThis.AIWSI18n.text('Soru')}</span><span class="input-request-text"><strong>${esc(taskTitle)}</strong><small>${esc(projectName)} · ${esc(requestExcerpt(question.text,140))}</small></span><span class="input-request-go">${approval?globalThis.AIWSI18n.text('İncele'):globalThis.AIWSI18n.text('Yanıtla')}${window.AIWSUI.icon('arrow-right')}</span>`;}
function renderNotificationRows(requests){
  const list=$('#notifications-list'),ids=new Set(requests.map(question=>question.id)),rows=new Map();
  for(const row of list.children){if(!row.classList.contains('is-leaving'))rows.set(row.dataset.openQuestion,row);}
  for(const [id,row] of rows)if(!ids.has(id))window.AIWSUI.motion.leave(list,'.input-request-row','data-open-question',row);
  for(const question of requests){
    let row=rows.get(question.id);
    if(!row){row=document.createElement('button');row.type='button';row.className='input-request-row';row.setAttribute('role','menuitem');row.dataset.openQuestion=question.id;list.append(row);}
    const content=notificationRowHtml(question);
    if(notificationRowContent.get(row)!==content){row.innerHTML=content;notificationRowContent.set(row,content);}
  }
  window.AIWSUI.motion.enter(list,'.input-request-row:not(.is-leaving)','data-open-question',{className:'ui-enter-fade'});
}
function renderNotifications(){
  const requests=activeInputRequests(),menu=$('#notifications-menu'),foot=$('#notifications-foot'),ids=new Set(requests.map(question=>question.id));
  renderNotificationRows(requests);
  // A request stops being new once the open dropdown or its own open task has shown it.
  for(const id of unreadRequests){const question=requests.find(item=>item.id===id);if(!ids.has(id)||!menu.hidden||requestInView(question))unreadRequests.delete(id);}
  $('#notifications-empty').hidden=requests.length>0;
  const offer=!window.aiwsDesktop&&window.Notification&&Notification.permission==='default';foot.hidden=!offer;
  setHtml(foot,offer?globalThis.AIWSI18n.text('<button type="button" class="notifications-offer" role="menuitem" data-enable-notifications>Masaüstü bildirimlerini aç</button>'):'');
  const badge=$('#notifications-badge'),button=$('#notifications-button'),unread=unreadRequests.size,label=unread?globalThis.AIWSI18n.template`Bildirimler (${unread} yeni)`:globalThis.AIWSI18n.text('Bildirimler');
  badge.hidden=!unread;badge.textContent=unread>9?'9+':String(unread);button.setAttribute('aria-label',label);button.title=label;
}
function openNotifications(){
  const menu=$('#notifications-menu');menu.hidden=false;$('#notifications-button').setAttribute('aria-expanded','true');
  renderNotifications();$('[role=menuitem]',menu)?.focus({preventScroll:true});
}
function closeNotifications(returnFocus=false){
  $('#notifications-menu').hidden=true;const button=$('#notifications-button');button.setAttribute('aria-expanded','false');
  if(returnFocus)button.focus({preventScroll:true});
}
$('#notifications-button').addEventListener('click',()=>{if($('#notifications-menu').hidden)openNotifications();else closeNotifications();});
$('#notifications').addEventListener('keydown',event=>{
  const menu=$('#notifications-menu');if(menu.hidden)return;
  if(event.key==='Escape'){event.stopPropagation();closeNotifications(true);return;}
  window.AIWSUI.menuNavigate(event,menu);
});
// A click outside closes the dropdown, and so does opening a request from it; the request then takes the focus.
document.addEventListener('click',event=>{if(!$('#notifications-menu').hidden&&(!event.target.closest('#notifications')||event.target.closest('[data-open-question]')))closeNotifications();});
