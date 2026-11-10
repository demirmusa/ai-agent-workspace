/* Small glyphs the console's message, tool and agent cards share: the provider box, a tool's status glyph and a subagent's latest
 * step on one line. */
(function (global) {
  'use strict';
  const kit = global.AIWSConversationKit, { esc } = kit;
  /** The provider's logo in a small rounded box, or the AI sparkle when it has none: one look for agent cards, messages and toolbars. */
  const providerBox = (provider, src = (globalThis.AIWSProviderIcons || {})[provider]) => `<span class="ui-icon-box cv-provider-box"${provider ? ` data-provider="${esc(provider)}"` : ''} aria-hidden="true">${src ? `<img src="${esc(src)}" alt="">` : global.AIWSUI.sparkle('accent')}</span>`;
  /** A tool's glyph: a spinner while it runs, a warning in its tone when it failed, otherwise the glyph of its kind; '' when it has none. */
  const toolIcon = node => {
    const failedTool = ['failed', 'incomplete'].includes(node.status) || node.tone === 'failed', glyph = node.status === 'running' ? '<span class="ui-spinner"></span>' : failedTool ? global.AIWSUI.icon('triangle') : node.kind === 'files' ? '▧' : ({ terminal: '›_', shell: '›_', read: '▤', search: '⌕', agent: '↳', test: '✓', build: '⚒', lint: '≈', list: '☰', write: '✎', git: '⎇', install: '⇣', run: '▷', network: '⇄', docker: '▣', aiws: '◈', todo: '☑', question: '?', plan: '≣' })[node.icon] || '';
    const tone = node.status === 'running' ? 'running' : failedTool ? 'failed' : node.tone;
    return glyph && `<span class="cv-tool-icon"${tone ? ` data-tone="${esc(tone)}"` : ''} aria-hidden="true">${glyph}</span>`;
  };
  /** A subagent's latest tool call on one line: its glyph, what it did and the file, pattern or command it did it on. */
  const activityHtml = node => {
    const base = path => String(path || '').split(/[\\/]/).at(-1), files = (node.files || []).map(file => base(file.path)).filter(Boolean), subject = files.length ? files.join(', ') : node.icon === 'read' ? base(node.command) :String(node.command || node.preview || '').replace(/[\r\n]+/g, ' ');
    return `${toolIcon(node)}<span class="cv-agent-activity-title">${esc(node.title || '')}</span>${subject ? `<code title="${esc(files.length ? files.join(', ') : node.command || node.preview)}">${esc(subject.slice(0, 200))}</code>` : ''}`;
  };
  /** What an agent card says under its name: its latest tool call, or a workflow's current step; '' when it has neither. */
  const agentInfoHtml = agent => agent.activity ? activityHtml(agent.activity) : agent.note ? kit.esc(agent.note) : '';
  Object.assign(kit, { providerBox, toolIcon, activityHtml, agentInfoHtml });
})(globalThis);
