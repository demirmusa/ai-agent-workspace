/* Timeline node cards: a message, prompt, request exchange, tool call or output as HTML, and the folding of long tool streaks. Every
 * value is escaped or rendered by the escaping Markdown renderer; links keep safe protocols. */
(function (global) {
  'use strict';
  const kit = global.AIWSConversationKit, { esc, clock, markdown, stripAnsi, providerBox, toolIcon, activityHtml, agentInfoHtml, liveAgent, statusLabel, outputSources, safeUrl, requestHtml, toolView, toolStaysVisible, viewUi } = kit;
  const duration = node => { const ms = node.durationMs ?? Date.parse(node.finishedAt) - Date.parse(node.startedAt); return Number.isFinite(ms) && ms >= 0 ? globalThis.AIWSI18n.template`${(ms / 1000).toFixed(1)} sn` : ''; };
  /** Streaks of tool calls longer than FOLD_KEEP + 1, as first index → how many of their earliest calls fold away. */
  const FOLD_KEEP = 3;
  const toolFolds = nodes => {
    const folds = new Map(), foldable = node => (node.kind === 'tool' || node.kind === 'files') && node.icon !== 'agent' && !toolStaysVisible(node);
    for (let start = 0; start < nodes.length; start++) {
      let end = start; while (end < nodes.length && foldable(nodes[end])) end++;
      if (end - start > FOLD_KEEP + 1) folds.set(start, end - start - FOLD_KEEP);
      start = Math.max(start, end);
    }
    return folds;
  };
  function output(node) {
    const content = stripAnsi(node.output || node.text || ''), key = esc(node.key);
    return `${node.web?`<div class="cv-output cv-web-output cv-markdown">${markdown(content.slice(0,12000))}</div>`:`<pre class="cv-output">${esc(content.slice(0, 12000))}</pre>`}${content.length > 12000 ? globalThis.AIWSI18n.template`<button type="button" class="cv-text-button" data-cv-action="more" data-node="${key}">Tüm çıktıyı göster (${global.AIWSUI.number(content.length)} karakter)</button>` : ''}`;
  }
  /** One timeline node as HTML: messages, prompts, exchanges, turns, lifecycle notes, subagent launches, tool and file cards and
   *  plain output. `expanded` holds the keys of long messages the reader opened. */
  function renderNode(node, expanded) {
    const meta = `<time datetime="${esc(node.startedAt)}">${esc(clock(node.startedAt))}</time>`;
    const raw = node.raw ? `<details class="cv-raw"><summary>Ham olay</summary><pre>${esc(node.raw.slice(0, 20000))}</pre>${node.raw.length > 20000 ? globalThis.AIWSI18n.template`<button type="button" class="cv-text-button" data-cv-action="raw-more" data-node="${esc(node.key)}">Ham olayın tamamını göster</button>` : ''}</details>` : '';
    const copyButton = field => globalThis.AIWSI18n.template`<button type="button" class="cv-text-button" data-cv-action="copy" data-copy-field="${field}" data-node="${esc(node.key)}" aria-label="${field === 'command' ? globalThis.AIWSI18n.text('Komutu') : globalThis.AIWSI18n.text('İçeriği')} kopyala">Kopyala</button>`, copy = copyButton('text');
    const text = node.text || '', full = text.length > 50000 ? `<details class="cv-full-message"><summary>${globalThis.AIWSI18n.text('Tam mesaj')}</summary>${output(node)}</details>` : '';
    // Long messages start folded; the reader opens them with the button or by clicking the text.
    const folded = body => {
      const limit = node.kind === 'assistant' ? 4000 : 600, rows = node.kind === 'assistant' ? 60 : 10;
      if (text.length <= limit && text.split('\n').length <= rows) return `<div class="cv-markdown">${body}</div>`;
      const open = expanded.has(node.key);
      return `<div class="cv-markdown cv-collapsible" data-collapsed="${!open}">${body}</div><button type="button" class="cv-expand" data-cv-action="expand" data-node="${esc(node.key)}" aria-expanded="${open}">${open ? globalThis.AIWSI18n.text('Daralt') : globalThis.AIWSI18n.text('Tamamını göster')}</button>`;
    };
    const tools = `<div class="cv-message-tools">${copy}${raw}</div>`;
    if (node.kind === 'prompt') {
      // The bootstrap message only points at the prompt file, so show just that link.
      const bootstrap = /^\s*Read and follow the task instructions in (.+?prompt\.md)\.\s[\s\S]*--run (run_[\w-]+)/i.exec(text);
      const body = bootstrap ? `<div class="cv-markdown"><p>${globalThis.AIWSI18n.text('Agenta verilen talimat dosyası')} <button type="button" class="cv-file-reference cv-prompt-link" data-run-prompt="${esc(bootstrap[2])}" title="${esc(globalThis.AIWSI18n.text('Agenta verilen talimatı göster'))}">${esc(bootstrap[1])}</button></p></div>` : folded(markdown(text.slice(0, 50000)));
      return `<div class="cv-system-card"><header class="cv-message-heading"><span class="cv-message-role">${globalThis.AIWSI18n.text('Sistem')}</span><strong>${esc(node.title || globalThis.AIWSI18n.text('Talimat'))}</strong>${meta}</header>${body}${bootstrap ? '' : full + tools}</div>`;
    }
    if (node.kind === 'user') return `<div class="cv-bubble">${folded(markdown(text.slice(0, 50000)))}${full}</div><footer class="cv-message-meta"><span>${globalThis.AIWSI18n.text('Sen')}</span>${node.queued ? `<span class="cv-message-tag" title="${esc(globalThis.AIWSI18n.text('Agent bu mesajı sıradaki adımında okuyacak.'))}">${globalThis.AIWSI18n.text('Sırada')}</span>` : ''}${meta}${copy}</footer>`;
    if (node.kind === 'assistant') return `<header class="cv-message-heading">${providerBox(node.provider)}<span class="cv-message-role">Agent</span><strong>${esc(node.author || 'Agent')}</strong>${meta}</header>${folded(markdown(text.slice(0, 50000)))}${full}${tools}`;
    if (node.kind === 'exchange') {
      const question = node.question || {}, approval = question.kind === 'approval', answer = question.answer ?? node.answer, status = question.status || (answer ? 'answered' : 'pending');
      const native = question.source === 'terminal', state = status === 'pending' ? globalThis.AIWSI18n.text('Yanıtın bekleniyor') : status === 'answered' ? globalThis.AIWSI18n.text(native ? 'Terminalde yanıtlandı' : 'Yanıtlandı') : globalThis.AIWSI18n.text(native ? 'Terminalde kapandı' : 'Soru iptal edildi');
      return `<div class="cv-exchange-body" data-status="${esc(status)}"><header class="cv-exchange-heading"><span class="cv-exchange-kind">${approval ? globalThis.AIWSI18n.text('Onay istedi') : globalThis.AIWSI18n.text('Soru sordu')}</span>${global.AIWSUI.statusPill(status === 'pending' ? 'needs' : status === 'answered' ? 'done' : 'idle', state)}${meta}</header>${question.prompt ? requestHtml(question) : `<div class="cv-markdown">${markdown((node.text || '').slice(0, 20000))}</div>`}${answer ? globalThis.AIWSI18n.template`<div class="cv-answer"><strong>Yanıtın</strong>${markdown(answer)}</div>` : ''}</div>`;
    }
    if (node.kind === 'turn') return `<div class="cv-turn"><span>${esc(node.title)}</span>${meta}</div>`;
    if (node.kind === 'lifecycle') return `<div class="cv-lifecycle"><span class="cv-lifecycle-dot" aria-hidden="true"></span><span>${esc(node.title || node.text)}</span>${meta}</div>`;
    if (node.agent) {
      const agent = node.agent, live = liveAgent.includes(agent.status), head = [agent.name || node.command, agent.role, agent.model].filter(Boolean);
      return `<button type="button" class="cv-subagent" data-cv-action="agent" data-agent="${esc(agent.id)}" data-status="${esc(agent.status || 'unknown')}" title="${esc(globalThis.AIWSI18n.text(agent.kind === 'workflow' ? "Workflow'u aç" : 'Alt agentın kaydını aç'))}"><span class="cv-subagent-head">${toolIcon({ icon: 'agent', status: live ? 'running' : ['failed', 'interrupted'].includes(agent.status) ? 'failed' : 'completed' })}${head.map((part, index) => `<span${index ? '' : ' class="cv-subagent-name"'}>${esc(part)}</span>`).join('<span class="cv-subagent-sep" aria-hidden="true">·</span>')}</span>${agentInfoHtml(agent) ? `<span class="cv-agent-activity">${agentInfoHtml(agent)}</span>` : ''}</button>`;
    }
    if (node.kind === 'tool' || node.kind === 'files') {
      const view = toolView(node), nodeFiles = view.files || node.files || [];
      const files = nodeFiles.map(file => `<li><span class="cv-file-kind">${esc(({ add: '+ Yeni', update: globalThis.AIWSI18n.text('~ Değişti'), edit: globalThis.AIWSI18n.text('~ Değişti'), delete: '− Silindi', remove: '− Silindi' })[file.kind] || file.kind || globalThis.AIWSI18n.text('Dosya'))}</span><code title="${esc(file.path)}">${esc(file.path)}</code>${file.diff ? viewUi.diff(file.diff) : ''}</li>`).join('');
      const preview = node.kind === 'files' ? nodeFiles.map(file => String(file.path || '').split(/[\\/]/).at(-1)).join(', ') : String(node.preview??node.command??'').replace(/^.*?\s-Command\s+["']?/i, '').replace(/\\"/g, '"').replace(/[\r\n]+/g, ' ');
      const effectiveStatus = node.status !== 'running' && view.tone === 'failed' ? 'failed' : node.status;
      const icon = view.icon && !['running', 'failed', 'incomplete'].includes(node.status) ? `<span class="cv-tool-icon"${view.tone ? ` data-tone="${esc(view.tone)}"` : ''} aria-hidden="true">${view.icon}</span>` : toolIcon({ ...node, tone: view.tone }), subject = view.subject ? String(view.subject).replace(/[\r\n]+/g, ' ') : preview, chipRow = viewUi.chips(view.chips);
      // A view that reads the output leads the card, and the output itself steps back behind a disclosure.
      const rawOutput = Boolean(node.output && view.lead && !view.output), body = view.output || (node.output ? output(node) : '');
      const sources=node.web?outputSources(node.output):[],fields=(node.fields||[]).map((field,index)=>{const linked=sources.find(source=>source.refs.includes(field.value)),url=safeUrl(field.value)||linked?.url,label=linked?.title||field.value;return `<div class="cv-tool-field"><dt>${esc(field.label)}</dt><dd>${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`:`<span>${esc(field.value)}</span>`}${field.detail?`<small>${esc(field.detail)}</small>`:''}${copyButton(`field:${index}`)}</dd></div>`;}).join('');
      const sourceLinks=sources.length?globalThis.AIWSI18n.template`<div class="cv-tool-sources" aria-label="Sonuç kaynakları">${sources.map(source=>`<a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.title)}</a>`).join('')}</div>`:'';
      const truncation=node.outputTruncated?globalThis.AIWSI18n.template`<p class="cv-output-truncated" role="status">Kaynak kaydı sınırlı: ${global.AIWSUI.number(Number(node.retainedCharacters||node.output?.length||0))}${Number.isFinite(node.originalCharacters)?` / ${global.AIWSUI.number(Number(node.originalCharacters))}`:''} karakter gösteriliyor.</p>`:'';
      return `<details class="cv-tool-details"><summary>${icon}<span class="cv-tool-heading"><strong>${esc(view.title)}</strong>${subject ? `<span class="cv-tool-preview" title="${esc(subject.slice(0, 500))}">${esc(subject.slice(0, 180))}</span>` : ''}</span>${chipRow ? `<span class="cv-tool-chips">${chipRow}</span>` : ''}<span class="cv-tool-metrics">${esc(duration(node))}${node.exitCode !== undefined && node.exitCode !== null ? ` · exit ${esc(node.exitCode)}` : ''}</span><span class="cv-tool-status ${esc(effectiveStatus)}">${esc(statusLabel(effectiveStatus))}</span><span class="cv-disclosure" aria-hidden="true">${global.AIWSUI.icon('chevron')}</span></summary>${node.description && node.description !== view.title ? `<p class="cv-tool-description">${esc(node.description)}</p>` : ''}${view.lead ? `<div class="cv-tool-lead">${view.lead}</div>` : ''}${fields?`<dl class="cv-tool-fields">${fields}</dl>`:''}${node.command ? `<div class="cv-command-label">${node.icon === 'agent' ? 'Agent' : node.icon==='read'?globalThis.AIWSI18n.text('Dosya'):globalThis.AIWSI18n.text('Komut')} ${copyButton('command')}</div><pre class="cv-command">${esc(node.command)}</pre>` : ''}${files ? `<ul class="cv-files">${files}</ul>` : ''}${node.quietOutput || (view.quietEmpty && !body) ? '' : rawOutput ? `<details class="cv-raw-output"><summary>${globalThis.AIWSI18n.text('Tüm çıktı')}</summary>${body}${truncation}</details>` : node.output ? `<div class="cv-command-label">${node.web?globalThis.AIWSI18n.text('Sonuç'):globalThis.AIWSI18n.text('Çıktı')} ${copyButton('output')}</div>${sourceLinks}${body}${truncation}` : node.kind === 'tool' && !node.hideToolPayload && !view.lead ? `<p class="cv-tool-empty">${node.status === 'running' ? globalThis.AIWSI18n.text('Araç çıktısı bekleniyor…') : globalThis.AIWSI18n.text('Bu araç için kayıtlı çıktı yok.')}</p>` : ''}<footer class="cv-tool-footer">${meta}<span>${esc(duration(node))}</span>${node.exitCode !== undefined && node.exitCode !== null ? globalThis.AIWSI18n.template`<span>Çıkış kodu <b>${esc(node.exitCode)}</b></span>` : ''}</footer>${raw}</details>${view.inline ? `<div class="cv-tool-inline">${view.inline}</div>` : ''}`;
    }
    return `<header class="cv-output-heading"><strong>${esc(node.title || globalThis.AIWSI18n.text('Çıktı'))}</strong>${meta}${node.kind !== 'unknown' ? copy : ''}</header>${node.text ? output(node) : globalThis.AIWSI18n.text('<p class="cv-tool-empty">Ayrıntılar ham olayda saklanıyor.</p>')}${raw}`;
  }
  Object.assign(kit, { renderNode, toolFolds });
})(globalThis);
