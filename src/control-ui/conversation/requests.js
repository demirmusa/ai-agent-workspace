/* Agent requests: questions and approvals. Pending ones dock above the composer with their reply form (an approval is answered by
 * its decision button, an optional note adds conditions); settled ones stay in the timeline as an exchange, or in the fallback list
 * under it when the journal holds no question event for them. Native CLI dialogs arrive parsed by the server and show their parts. */
(function (global) {
  'use strict';
  const kit = global.AIWSConversationKit, { esc, clock, markdown, enterOnce } = kit;
  // A context line the CLI marks as a warning, e.g. "⚠ … will automatically deny this request in 1:45".
  const warningPattern = /^⚠️?\s*/;
  // Native CLI dialogs arrive parsed by the server; show their parts instead of the terminal screen text.
  function requestHtml(question, fallback = question?.text) {
    const prompt = question?.prompt;
    if (!prompt || !Array.isArray(prompt.options)) return `<div class="cv-markdown cv-question-text">${markdown(String(fallback || '').slice(0, 20000))}</div>`;
    const heading = prompt.title ? `<p class="cv-native-title">${esc(prompt.title)}</p>` : '';
    const contextLines = prompt.context || [], notes = contextLines.filter(line => !warningPattern.test(line)), warnings = contextLines.filter(line => warningPattern.test(line));
    const context = notes.map(line => `<p class="cv-native-context">${esc(line)}</p>`).join('');
    const warning = warnings.map(line => `<p class="cv-native-warning">${global.AIWSUI.icon('triangle')}<span>${esc(line.replace(warningPattern, ''))}</span></p>`).join('');
    const command = prompt.command ? `<pre class="cv-code cv-native-command"><code>${esc(prompt.command)}</code></pre>` : '';
    const ask = prompt.question ? `<p class="cv-native-question">${esc(prompt.question)}</p>` : '';
    const options = prompt.options.length ? `<ol class="cv-native-options">${prompt.options.map((option, index) => `<li${option.selected ? ' data-selected="true"' : ''}><span class="cv-native-key">${index + 1}</span><span>${esc(option.label)}</span></li>`).join('')}</ol>` : '';
    return `<div class="cv-native-prompt cv-question-text">${heading}${context}${command}${warning}${ask}${options}</div>`;
  }
  /** The answer text an approval request receives for an approve or deny decision; an optional note adds conditions. */
  const approvalAnswer = (decision, note = '') => `${decision === 'deny' ? globalThis.AIWSI18n.text('Reddedildi.') : globalThis.AIWSI18n.text('Onaylandı.')}${note ? `\n\n${note}` : ''}`;
  /** Whether a pending request is a dialog of the CLI drawn in the terminal now on screen; it is read and answered there, so no card repeats it. */
  const onTerminalScreen = (question, terminalRunId) => question.status === 'pending' && question.source === 'terminal' && Boolean(terminalRunId) && question.runId === terminalRunId;
  /** The console's request dock and settled-request list. `ctx` gives root, dock, list, idSuffix and the live data, viewReadOnly,
   *  selectedAgentId and painted of its console. */
  function requestDock(ctx) {
    const { root, dock, list, idSuffix } = ctx;
    root.addEventListener('submit', async event => {
      const form = event.target.closest('form[data-cv-question]'); if (!form) return;
      event.preventDefault(); const answer = form.querySelector('textarea'), note = answer.value.trim(), buttons = [...form.querySelectorAll('button[type=submit]')], errorBox = form.querySelector('[role=alert]'), data = ctx.data;
      // An approval is answered by its decision button; the note only adds conditions to it.
      const decision = form.dataset.kind === 'approval' ? event.submitter?.value : null;
      const text = form.dataset.kind === 'approval' ? (decision ? approvalAnswer(decision, note) : '') : note;
      if (!text || ctx.viewReadOnly || ctx.selectedAgentId || !data.onAnswerQuestion || form.dataset.busy) return;
      form.dataset.busy = 'true'; for (const button of buttons) button.disabled = true; errorBox.hidden = true;
      try { await data.onAnswerQuestion(form.dataset.cvQuestion, text); form.closest('.cv-question')?.classList.add('cv-question-sent'); }
      catch (error) { errorBox.textContent = error?.message || globalThis.AIWSI18n.text('Yanıt gönderilemedi.'); errorBox.hidden = false; }
      finally { delete form.dataset.busy; for (const button of buttons) button.disabled = false; }
    });
    dock.addEventListener('keydown', event => { const form = event.target.closest?.('form[data-cv-question]'); if (form?.dataset.kind !== 'approval' && (event.ctrlKey || event.metaKey) && event.key === 'Enter' && event.target.matches('textarea')) { event.preventDefault(); form.requestSubmit(); } });
    /** Draws `questions` (exchange ids already in the timeline are left to it, dialogs on the visible terminal `terminalRunId` to it);
     *  returns whether a reply form is open. */
    function render(questions, inlineQuestions, terminalRunId) {
      const data = ctx.data, viewReadOnly = ctx.viewReadOnly, questionIds = new Set(), pendingHere = []; let answering = false;
      for (const question of questions) {
        if (data.taskId && question.taskId !== data.taskId) continue;
        if (onTerminalScreen(question, terminalRunId)) continue;
        const pending = question.status === 'pending';
        if (!pending && inlineQuestions.has(question.id)) continue;
        if (pending) pendingHere.push(question.id);
        questionIds.add(question.id);
        const host = pending ? dock : list;
        let box = [...dock.children, ...list.children].find(element => element.dataset.questionId === question.id);
        if (!box) { box = root.ownerDocument.createElement('section'); box.className = 'cv-question'; box.dataset.questionId = question.id; if (ctx.painted && pending) enterOnce(box); }
        if (box.parentNode !== host) host.append(box);
        const paused = data.runs?.find(run => run.id === question.runId)?.status === 'paused', approval = question.kind === 'approval';
        if (pending && !viewReadOnly && question.source !== 'terminal' && data.onAnswerQuestion) answering = true;
        const signature = `${question.text}:${question.kind}:${question.status}:${question.answer}:${paused}:${viewReadOnly}`;
        if (box.dataset.signature !== signature) {
          const draftValue = box.querySelector('textarea')?.value || '';
          box.dataset.kind = approval ? 'approval' : 'question'; box.classList.remove('cv-question-sent');
          const title = pending ? (approval ? globalThis.AIWSI18n.text('Onayın gerekiyor') : globalThis.AIWSI18n.text('Agent senden yanıt bekliyor')) : question.status === 'answered' ? globalThis.AIWSI18n.text(question.source === 'terminal' ? 'Terminalde yanıtlandı' : 'Yanıtlandı') : globalThis.AIWSI18n.text(question.source === 'terminal' ? 'Terminalde kapandı' : 'Soru iptal edildi');
          const form = !pending || viewReadOnly ? '' : question.source === 'terminal' ? globalThis.AIWSI18n.text('<div class="cv-question-actions"><p class="cv-question-help">Bu istek yerel CLI tarafından gösterildi. Seçenekleri terminalde inceleyip yanıtla.</p><button type="button" class="button primary small" data-cv-action="mode-terminal">Terminalde yanıtla →</button></div>') : !data.onAnswerQuestion ? '' : approval
            ? globalThis.AIWSI18n.template`<form data-cv-question="${esc(question.id)}" data-kind="approval"><label class="cv-question-note">Not ekle <small>İsteğe bağlı · onay veya retle birlikte iletilir</small><textarea id="answer-${esc(question.id)}${idSuffix}" name="answer" rows="1" placeholder="Koşul veya açıklama yaz…"></textarea></label>${paused ? globalThis.AIWSI18n.text('<p class="cv-paused-note">Agent duraklatıldı. Yanıt kaydedilir; çalışmayı Devam et ile sürdürebilirsin.</p>') : ''}<div class="cv-question-actions"><button type="submit" class="button small cv-deny" name="decision" value="deny">${global.AIWSUI.icon('x')}Reddet</button><button type="submit" class="button primary small" name="decision" value="approve">${global.AIWSUI.icon('check')}Onayla</button></div><p role="alert" hidden></p></form>`
            : globalThis.AIWSI18n.template`<form data-cv-question="${esc(question.id)}" data-kind="question"><label class="sr-only" for="answer-${esc(question.id)}${idSuffix}">Agenta yanıtın</label>${paused ? globalThis.AIWSI18n.text('<p class="cv-paused-note">Agent duraklatıldı. Yanıt kaydedilir; çalışmayı Devam et ile sürdürebilirsin.</p>') : ''}<div class="cv-prompt-input"><textarea id="answer-${esc(question.id)}${idSuffix}" name="answer" required rows="1" placeholder="Yanıtını yaz…"></textarea><div class="cv-composer-footer"><span class="cv-question-help"><kbd>Ctrl ↵</kbd> gönderir</span><button type="submit" class="button primary small">${paused ? globalThis.AIWSI18n.text('Yanıtı kaydet') : globalThis.AIWSI18n.text('Yanıtla ve devam et →')}</button></div></div><p role="alert" hidden></p></form>`;
          box.innerHTML = `<header>${global.AIWSUI.statusPill(pending ? 'needs' : question.status === 'answered' ? 'done' : 'idle', approval ? globalThis.AIWSI18n.text('Onay') : globalThis.AIWSI18n.text('Soru'))}<strong>${esc(title)}</strong><time>${esc(clock(question.createdAt))}</time></header>${requestHtml(question)}${form}${!pending && question.answer ? globalThis.AIWSI18n.template`<div class="cv-answer"><strong>Yanıtın</strong>${markdown(question.answer)}</div>` : ''}`;
          if (box.querySelector('textarea')) box.querySelector('textarea').value = draftValue;
          box.dataset.signature = signature;
        }
      }
      for (const box of [...dock.children, ...list.children]) if (!questionIds.has(box.dataset.questionId)) box.remove();
      dock.hidden = !pendingHere.length;
      return answering;
    }
    /** Settled requests by question id with what they show, for the console's new-activity count. */
    const signatures = () => new Map([...list.children].map(box => [`question:${box.dataset.questionId}`, box.dataset.signature]));
    return { render, signatures };
  }
  Object.assign(kit, { requestHtml, approvalAnswer, onTerminalScreen, requestDock });
})(globalThis);
