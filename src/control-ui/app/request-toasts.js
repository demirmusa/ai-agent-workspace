'use strict';
// New input requests announce themselves: a badge on the header's notifications and an in-app toast while the request is not in view,
// an OS notification while the operator is elsewhere.
const seenInputRequests = new Set();
const browserRequestNotifications = new Map();
// A request toast stays this long; its bottom line runs down over the same time.
const requestToasts = '#input-request-toasts > .input-request-toast', requestToastLife = 20000, requestToastTimers = new Map();
/** Removes a request toast: it fades out and the toasts below glide into its place. */
function removeRequestToast(questionId) {
  clearTimeout(requestToastTimers.get(questionId)); requestToastTimers.delete(questionId);
  const host = $('#input-request-toasts'), toast = [...host.children].find(item => item.dataset.questionId === questionId);
  if (toast) window.AIWSUI.motion.leave(host, '.input-request-toast', 'data-question-id', toast);
}
function requestToastHtml(question, {approval, taskTitle, projectName}) {
  const ui = window.AIWSUI;
  return globalThis.AIWSI18n.template`<header><span class="request-kind" data-kind="${approval ? 'approval' : 'question'}">${approval ? globalThis.AIWSI18n.text('Onay gerekiyor') : globalThis.AIWSI18n.text('Soru')}</span><small>${esc(projectName)}</small><button type="button" class="request-toast-close" data-dismiss-request aria-label="Bildirimi kapat">${ui.icon('x')}</button></header><strong>${esc(taskTitle)}</strong><p>${esc(requestExcerpt(question.text, 160))}</p><footer><button type="button" class="button primary small" data-open-question="${esc(question.id)}">${approval ? globalThis.AIWSI18n.text('İncele ve onayla') : globalThis.AIWSI18n.text('Yanıtla')}${ui.icon('arrow-right')}</button></footer><span class="request-toast-life" aria-hidden="true"></span>`;
}
function showRequestToast(question, context) {
  const host = $('#input-request-toasts'), item = document.createElement('section'); item.className = 'input-request-toast'; item.dataset.questionId = question.id; item.dataset.kind = context.approval ? 'approval' : 'question'; item.dataset.tone = context.approval ? 'needs' : 'running'; item.setAttribute('role', 'status'); item.style.setProperty('--toast-life', `${requestToastLife}ms`);
  item.innerHTML = requestToastHtml(question, context);
  host.append(item); window.AIWSUI.motion.enter(host, '.input-request-toast', 'data-question-id');
  // A pointer over the toast or focus inside it holds it; once both leave, its full time starts over.
  const start = () => requestToastTimers.set(question.id, setTimeout(() => removeRequestToast(question.id), requestToastLife));
  let hovered = false, focused = false;
  const hold = () => { clearTimeout(requestToastTimers.get(question.id)); const life = item.querySelector('.request-toast-life'); if (life) life.style.animationPlayState = 'paused'; };
  const release = () => { if (hovered || focused) { hold(); return; } if (!item.isConnected || item.classList.contains('is-leaving')) return; const life = item.querySelector('.request-toast-life'); if (life) { life.style.removeProperty('animation-play-state'); life.replaceWith(life.cloneNode(false)); } start(); };
  item.addEventListener('pointerenter', () => { hovered = true; hold(); }); item.addEventListener('pointerleave', () => { hovered = false; release(); });
  item.addEventListener('focusin', () => { focused = true; hold(); }); item.addEventListener('focusout', event => { if (item.contains(event.relatedTarget)) return; focused = false; release(); });
  start();
  // Leaving toasts are on their way out; only the others count towards the three shown.
  for (const extra of [...document.querySelectorAll(`${requestToasts}:not(.is-leaving)`)].slice(0, -3)) removeRequestToast(extra.dataset.questionId);
}
// OS notifications are for when the operator is elsewhere; inside the app the badge and toast suffice.
function notifyOperator(question, {approval, taskTitle, projectName}) {
  if (document.visibilityState === 'visible' && document.hasFocus?.()) return;
  const title = `${approval ? globalThis.AIWSI18n.text('Onayın gerekiyor') : globalThis.AIWSI18n.text('Agent soru soruyor')} · ${taskTitle}`.slice(0, 240), body = `${projectName} — ${requestExcerpt(question.text, 400)}`.slice(0, 1000);
  if (window.aiwsDesktop?.notifyQuestion) void window.aiwsDesktop.notifyQuestion({id:question.id,taskId:question.taskId,title,body}).catch(() => {});
  else if (window.Notification?.permission === 'granted') {
    try { const notification = new Notification(title,{body,tag:question.id}); notification.onclick = () => { window.focus(); openInputRequest(question.id); notification.close(); }; browserRequestNotifications.set(question.id, notification); } catch { /* In-app requests remain available. */ }
  }
}
/** Whether the open task already docks this request above its composer. */
const requestInView = question => selectedTaskId === question?.taskId && !$('#task-panel').hidden && document.visibilityState !== 'hidden';
function notifyInputRequests() {
  const requests = activeInputRequests(), ids = new Set(requests.map(q => q.id));
  for (const toast of [...$('#input-request-toasts').children]) if (!ids.has(toast.dataset.questionId)) removeRequestToast(toast.dataset.questionId);
  for (const [id, notification] of browserRequestNotifications) if (!ids.has(id)) { notification.close(); browserRequestNotifications.delete(id); }
  for (const question of requests) {
    if (seenInputRequests.has(question.id)) continue;
    seenInputRequests.add(question.id);
    const context = requestContext(question);
    // A toast or a badge would only repeat a request the open task already shows.
    if (!requestInView(question)) { showRequestToast(question, context); unreadRequests.add(question.id); }
    notifyOperator(question, context);
  }
  renderNotifications();
}
const unsubscribeQuestionOpen = window.aiwsDesktop?.onOpenQuestion?.(request => openInputRequest(request.questionId));
document.addEventListener('click', event => {
  const target = event.target.closest('button[data-dismiss-request]');
  if (target) removeRequestToast(target.closest('.input-request-toast')?.dataset.questionId);
});
window.addEventListener('pagehide', () => { unsubscribeQuestionOpen?.(); for (const notification of browserRequestNotifications.values()) notification.close(); for (const timer of requestToastTimers.values()) clearTimeout(timer); });
