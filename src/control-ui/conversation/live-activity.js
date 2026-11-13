/* What the agent is doing right now, above the composer of a chat, and the panels plugins pin above the timeline. Both follow the
 * nodes of the main agent; the terminal view draws its own screen and shows neither. */
(function (global) {
  'use strict';
  const kit = global.AIWSConversationKit, { esc, t, toolView, viewRevision } = kit;
  const elapsedText = since => { const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 1000)); return Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : ''; };
  /** The strip inserted before `before` in ctx.root. */
  function activityStrip(ctx, before) {
    const element = ctx.root.ownerDocument.createElement('div'); element.className = 'cv-activity'; element.hidden = true; element.setAttribute('role', 'status');
    ctx.root.insertBefore(element, before);
    let since = '', timer = null, shown = '';
    const tick = () => { const clock = element.querySelector('.cv-activity-time'); if (clock) clock.textContent = elapsedText(since); };
    const stop = () => { clearInterval(timer); timer = null; };
    function render(group, native) {
      const live = group?.status === 'running' && !native;
      const running = live ? group.nodes.filter(node => ['tool', 'files'].includes(node.kind) && node.status === 'running' && !node.agentId).at(-1) : null;
      if (!live) { element.hidden = true; shown = ''; stop(); return; }
      const view = running ? toolView(running) : null, label = view ? view.activity : t('Agent çalışıyor');
      const subject = view ? view.subject || running.preview || running.command || '' : '';
      since = running?.startedAt || group.startedAt || '';
      const html = `<span class="ui-spinner" aria-hidden="true"></span><strong>${esc(label)}</strong>${subject ? `<code title="${esc(subject)}">${esc(String(subject).replace(/[\r\n]+/g, ' ').slice(0, 200))}</code>` : ''}<span class="cv-activity-time"></span>`;
      if (html !== shown) { element.innerHTML = html; shown = html; }
      element.hidden = false; tick();
      if (!timer) timer = setInterval(tick, 1000);
    }
    return { render, destroy: stop };
  }
  /** The plugin panels inserted before `before` in ctx.root; the plugin host mounts them. */
  function insightPanels(ctx, before) {
    const element = ctx.root.ownerDocument.createElement('section'); element.className = 'cv-insights'; element.hidden = true;
    ctx.root.insertBefore(element, before);
    let signature = '';
    function render(groups, native) {
      const mount = global.AIWSPlugins?.mountConversationPanels;
      if (!mount || native) { element.hidden = true; return; }
      const nodes = groups.flatMap(group => group.nodes).filter(node => ['tool', 'files'].includes(node.kind) && !node.agentId), live = groups.at(-1)?.status === 'running';
      const next = JSON.stringify([viewRevision(), ctx.data.taskId, live, nodes.length, nodes.at(-1)?.id, nodes.map(node => `${node.status}:${node.output?.length || 0}`).join()]);
      if (next === signature) return; signature = next;
      element.hidden = !mount(element, { nodes, live, taskId: ctx.data.taskId, key: ctx.data.taskId || ctx.data.instanceId || '' });
    }
    return { render };
  }
  Object.assign(kit, { activityStrip, insightPanels });
})(globalThis);
