'use strict';
// Agent input requests: answering, approving and opening them, and the line each reads as elsewhere.
/** Answers an input request from anywhere in the app; an approval passes its decision through the console's answer text. */
async function answerInputRequest(questionId, answer) { await api(`/questions/${encodeURIComponent(questionId)}/answer`, 'POST', {answer}); removeRequestToast(questionId); await refresh(); }
const decideApproval = (questionId, decision, note) => answerInputRequest(questionId, window.AIWSAgentConsole.approvalAnswer(decision, note));
function openInputRequest(questionId) {
  const question = activeInputRequests().find(q => q.id === questionId);
  if (!question) return;
  const owner = state.tasks.find(task => task.id === question.taskId);
  if (!owner) return;
  projectId = owner.projectId; localStorage.setItem('aiws.project', projectId); activeScreen = 'board'; detailTab = 'console'; openTask(owner.id);
  removeRequestToast(questionId);
  afterConsoleMount(() => {
    const panel = $('#task-panel');
    if (question.source === 'terminal') $('[data-cv-action="mode-terminal"]', panel)?.click();
    const box = [...panel.querySelectorAll('.cv-question[data-question-id]')].find(box => box.dataset.questionId === questionId);
    box?.scrollIntoView?.({block:'nearest'}); box?.querySelector('textarea')?.focus();
  });
}
// One readable line of a markdown request for banners, toasts and OS notifications.
function requestExcerpt(text, limit) { const plain = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/[`*_>#|]+/g, '').replace(/^\s*[-+]\s+/gm, '').replace(/\s+/g, ' ').trim(); return plain.length > limit ? `${plain.slice(0, limit - 1).trimEnd()}…` : plain; }
function requestContext(question) { const owner = state.tasks.find(task => task.id === question.taskId), project = taskProject(owner); return {owner, project, approval:question.kind === 'approval', taskTitle:(owner&&window.AIWSUI.taskTitle(owner)) || globalThis.AIWSI18n.text('Görev'), projectName:projectName(project) || globalThis.AIWSI18n.text('Proje')}; }
document.addEventListener('click', event => {
  const target = event.target.closest('button'); if (!target) return;
  if (target.dataset.openQuestion) openInputRequest(target.dataset.openQuestion);
  if (target.hasAttribute('data-enable-notifications') && window.Notification) void Notification.requestPermission().then(() => render()).catch(() => {});
});
