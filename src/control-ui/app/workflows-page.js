'use strict';
// The workflows screen.
// A workflow card shows its agents as a connected chain of steps, like the orchestrator's agent tree.
function workflowCard(workflow){
  const t=globalThis.AIWSI18n;
  return t.template`<article class="workflow-card ui-card is-interactive${workflow.enabled?'':' is-disabled'}" data-motion-key="workflow:${esc(workflow.id)}" data-library-open="workflow:${esc(workflow.id)}"><header><span class="ui-icon-box library-glyph">${window.AIWSUI.sparkle('accent')}</span><div class="workflow-card-title"><h2>${esc(workflow.name)}</h2><p>${esc(workflow.description||t.text('Sıralı agent iş akışı'))}</p></div>${window.AIWSUI.statusPill(workflow.enabled?'done':'idle',workflow.enabled?t.text('Etkin'):t.text('Devre dışı'))}<button class="button small" data-edit-workflow="${esc(workflow.id)}">Düzenle</button></header><ol class="workflow-steps">${workflow.steps.map((step,index)=>`<li><span class="workflow-step-mark" aria-hidden="true">${index+1}</span><strong>${esc(step.name)}</strong><span>${esc(state.agents.find(agent=>agent.id===step.agentId)?.name||t.text('Agent seçilmedi'))}</span>${step.condition==='deploy_requested'?t.text('<span class="ui-chip is-accent">Dağıtım istendiğinde</span>'):''}</li>`).join('')}</ol><footer><span>${workflow.projectId?esc(state.projects.find(project=>project.id===workflow.projectId)?.name||t.text('Proje')):t.text('Tüm projeler')}</span><span>${workflow.trigger==='requested'?t.text('İstendiğinde'):t.text('Her görevde')}</span></footer></article>`;
}
function renderWorkflows() {
  const board=$('#board'),t=globalThis.AIWSI18n.text;board.className='board workflow-board';
  setHtml(board,globalThis.AIWSI18n.template`<div class="workflow-explanation"><h2>Bir işi tamamlayan agent, sıradakine devreder.</h2><p>Agentları sırayla ekle. Dağıtım adımını yalnız istendiğinde çalışacak şekilde seçebilirsin. Akışlar gerçek görev koşumlarıyla ilerler.</p></div>${state.workflows.length?`<div class="workflow-list">${state.workflows.map(workflowCard).join('')}</div>`:emptyState({className:'library-empty',title:t('İlk iş akışını oluştur.'),text:t('Örneğin frontend agentı geliştirsin, inceleme agentı kontrol etsin, dağıtım agentı sunucuya taşısın.'),action:t('<button class="button primary" data-action="new-workflow">İş akışı oluştur</button>')})}`);
  window.AIWSUI.motion.enter(board,'[data-motion-key]','data-motion-key');
}
