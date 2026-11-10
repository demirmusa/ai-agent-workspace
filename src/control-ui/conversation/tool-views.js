/* What a tool call looks like: toolView(node) gives its row (title, subject, chips, tone), what stays visible under the closed row and
 * what its opened card leads with. Each kind of work has its own view: searches group matches by file, tests show an IDE test explorer
 * with suites and failures, builds their diagnostics, edits a diff, reads numbered lines. A plugin's view (aiws.conversation.addToolView)
 * goes first and falls back on these for whatever it leaves out. Every value is escaped; plugins reach the helpers as aiws.conversation.ui. */
(function (global) {
  'use strict';
  const kit = global.AIWSConversationKit, { esc, t, baseName, markdown, stripAnsi, shellFiles, testSummary, testReport, diagnostics, searchResults, activityLabel } = kit;
  const number = value => global.AIWSUI.number(Number(value) || 0);
  const template = (parts, ...values) => global.AIWSI18n.template(parts, ...values);
  const dirName = path => { const parts = String(path ?? '').split(/[\\/]/); parts.pop(); return parts.join('/'); };

  // ── Building blocks, also offered to plugins.
  /** Small tone chips: [{ text, tone, title }]; `tone` is running, done, needs, failed, idle or accent. */
  const chips = list => (list || []).filter(chip => chip && chip.text !== undefined && chip.text !== '').map(chip => `<span class="ui-chip cv-tool-chip"${chip.tone ? ` data-tone="${esc(chip.tone)}"` : ''}${chip.title ? ` title="${esc(chip.title)}"` : ''}>${esc(chip.text)}</span>`).join('');
  /** A segmented bar of passed, failed and skipped counts; huge skipped counts from `-t` filters are capped visually so passed/failed stay legible. */
  function resultBar({ passed = 0, failed = 0, skipped = 0 } = {}) {
    const total = passed + failed + skipped; if (!total) return '';
    const active = passed + failed, skippedWeight = active > 0 && skipped > active ? Math.max(1, Math.round(active * 0.25)) : skipped;
    const segment = (count, weight, tone) => count ? `<span data-tone="${tone}" style="flex:${weight} 1 0"></span>` : '';
    return `<div class="cv-result-bar" role="img" aria-label="${esc(template`${passed} geçti, ${failed} kaldı, ${skipped} atlandı`)}">${segment(passed, passed, 'done')}${segment(failed, failed, 'failed')}${segment(skipped, skippedWeight, 'idle')}</div>`;
  }
  /** A path as its file name and quiet folder. */
  const fileName = path => `<span class="cv-path" title="${esc(path)}"><b>${esc(baseName(path))}</b>${dirName(path) ? `<small>${esc(dirName(path))}</small>` : ''}</span>`;
  /** Label and value pairs: [{ label, value, tone }]. */
  const stats = list => `<dl class="cv-stats">${(list || []).filter(item => item && item.value !== undefined && item.value !== '' && item.value !== null).map(item => `<div${item.tone ? ` data-tone="${esc(item.tone)}"` : ''}><dt>${esc(item.label)}</dt><dd>${esc(item.value)}</dd></div>`).join('')}</dl>`;
  /** An ordered progress list: [{ text, detail, state }] with state done, running, failed or pending. */
  const steps = list => `<ol class="cv-steps">${(list || []).map(step => `<li data-state="${esc(step.state || 'pending')}"><span class="cv-step-mark" aria-hidden="true"></span><span class="cv-step-text">${esc(step.text)}${step.detail ? `<small>${esc(step.detail)}</small>` : ''}</span></li>`).join('')}</ol>`;
  /** Compiler diagnostics grouped by file: the `items` of parse.diagnostics(). */
  function diagnosticList(items, limit = 200) {
    const groups = new Map(); for (const item of (items || []).slice(0, limit)) { const list = groups.get(item.file); if (list) list.push(item); else groups.set(item.file, [item]); }
    return `<div class="cv-diagnostics">${[...groups].map(([file, list]) => `<section><header>${fileName(file)}<span class="ui-chip">${number(list.length)}</span></header><ul>${list.map(item => `<li data-tone="${item.severity === 'error' ? 'failed' : 'needs'}"><code>${esc(item.line)}${item.column ? `:${esc(item.column)}` : ''}</code>${item.code ? `<span class="cv-diagnostic-code">${esc(item.code)}</span>` : ''}<span>${esc(item.message)}</span></li>`).join('')}</ul></section>`).join('')}</div>`;
  }
  /** A list of failed test names, opened to `limit`. */
  const failureList = (names, limit = 40) => names?.length ? `<ul class="cv-failures">${names.slice(0, limit).map(name => `<li data-tone="failed"><span aria-hidden="true">×</span><code title="${esc(name)}">${esc(name)}</code></li>`).join('')}${names.length > limit ? `<li class="cv-more">${esc(template`${names.length - limit} başarısız daha`)}</li>` : ''}</ul>` : '';
  /** IDE-style test explorer: scoreboard header, result bar, target projects and collapsible test suites with assertion diffs and stack traces. */
  function testExplorer(input, { compact = false, limit = 200 } = {}) {
    const report = input && input.suites ? input : typeof input === 'string' ? testReport(input) : input;
    if (!report) return '';
    if (compact) return `${resultBar(report)}${failureList(report.failures, Math.min(limit, 5))}`;
    const total = report.total || ((report.passed || 0) + (report.failed || 0) + (report.skipped || 0));
    const passRate = report.passRate ?? (total ? Math.round(((report.passed || 0) / total) * 100) : report.passed ? 100 : 0);
    const header = `<div class="cv-test-header"><span class="cv-test-badge" data-tone="${report.failed ? 'failed' : 'done'}">${report.failed ? '×' : '✓'} ${esc(`${passRate}%`)}</span>${report.passed ? `<span class="cv-test-stat" data-tone="done">✓ ${esc(template`${number(report.passed)} geçti`)}</span>` : ''}${report.failed ? `<span class="cv-test-stat" data-tone="failed">× ${esc(template`${number(report.failed)} kaldı`)}</span>` : ''}${report.skipped ? `<span class="cv-test-stat" data-tone="idle">○ ${esc(template`${number(report.skipped)} atlandı`)}</span>` : ''}${report.environment ? `<span class="ui-chip cv-tool-chip">${esc(report.environment)}</span>` : ''}${report.duration ? `<small class="cv-test-duration">${esc(report.duration)}</small>` : ''}</div>`;
    const projects = report.projects?.length ? `<div class="cv-test-projects dn-projects">${report.projects.map(project => `<div data-tone="${project.ok ? 'done' : 'failed'}"><b>${esc(project.name || t('Proje'))}</b>${project.framework ? `<small>${esc(project.framework)}</small>` : ''}<span>${esc(`${project.passed}/${project.total || (project.passed + project.failed + project.skipped)}`)}</span>${project.duration ? `<small>${esc(project.duration)}</small>` : ''}</div>`).join('')}</div>` : '';
    const suites = (report.suites || []).slice(0, 30).map(suite => {
      const tone = suite.failed || suite.ok === false ? 'failed' : suite.passed || suite.ok ? 'done' : 'idle', suiteMark = { failed: '×', done: '✓', idle: '○' }[tone], cases = suite.cases || [], total = suite.total || (suite.passed + suite.failed + suite.skipped);
      const rows = cases.slice(0, limit).map(test => {
        if (test.status === 'failed') {
          const shortLoc = test.at ? baseName(test.at) : '';
          const assertBox = test.expected !== undefined && test.actual !== undefined ? `<div class="cv-test-assert"><div data-tone="done"><dt>${esc(t('Beklenen'))}</dt><dd><code>${esc(test.expected)}</code></dd></div><div data-tone="failed"><dt>${esc(t('Gerçekleşen'))}</dt><dd><code>${esc(test.actual)}</code></dd></div></div>` : '';
          return `<details class="cv-test-case is-failed" data-tone="failed" open><summary><span class="cv-test-mark" aria-hidden="true">×</span><code title="${esc(test.fullName || test.name)}">${esc(test.name || test.fullName)}</code>${shortLoc ? `<span class="cv-test-loc">${esc(shortLoc)}</span>` : ''}${test.duration ? `<small>${esc(test.duration)}</small>` : ''}</summary><div class="cv-test-failure-body">${assertBox}${test.message ? `<pre class="cv-test-message dn-message">${esc(test.message)}</pre>` : ''}${test.at ? `<p class="cv-test-at dn-at">${esc(test.at)}</p>` : ''}${test.stack ? `<details class="cv-test-stack"><summary>${esc(t('Yığın izi'))}</summary><pre class="dn-stack">${esc(test.stack)}</pre></details>` : ''}</div></details>`;
        }
        const caseTone = test.status === 'passed' ? 'done' : 'idle', mark = test.status === 'passed' ? '✓' : '○';
        return `<div class="cv-test-case" data-tone="${caseTone}"><span class="cv-test-mark" aria-hidden="true">${mark}</span><code title="${esc(test.fullName || test.name)}">${esc(test.name || test.fullName)}</code>${test.duration ? `<small>${esc(test.duration)}</small>` : ''}</div>`;
      }).join('');
      const unlisted = suite.unlistedPassed > 0 ? `<div class="cv-test-case is-summary" data-tone="done"><span class="cv-test-mark" aria-hidden="true">✓</span><span>${esc(template`${number(suite.unlistedPassed)} geçti`)}</span></div>` : '';
      const more = cases.length > limit ? `<div class="cv-test-case is-summary"><span>${esc(template`${number(cases.length - limit)} test daha`)}</span></div>` : '';
      const unnamed = !cases.length && !unlisted ? `<div class="cv-test-case is-summary"><span>${esc(t('Çıktı bu dosyanın test adlarını içermiyor. Görmek için testleri ayrıntılı raporlayıcıyla çalıştırın (--verbose veya --reporter=verbose).'))}</span></div>` : '';
      return `<details class="cv-test-suite" data-tone="${tone}"${tone === 'failed' ? ' open' : ''}><summary class="cv-test-suite-head"><span class="cv-test-mark" aria-hidden="true">${suiteMark}</span><b class="cv-test-suite-name">${esc(suite.name)}</b>${suite.target ? `<span class="ui-chip cv-tool-chip">${esc(suite.target)}</span>` : ''}${total ? `<span class="cv-test-suite-counts">${esc(`${suite.passed}/${total}`)}</span>` : ''}${suite.duration ? `<small class="cv-test-suite-time">${esc(suite.duration)}</small>` : ''}</summary><div class="cv-test-cases dn-failures">${rows}${more}${unlisted}${unnamed}</div></details>`;
    }).join('');
    return `<div class="cv-test-explorer">${header}${resultBar(report)}${projects}${suites ? `<div class="cv-test-suites">${suites}</div>` : failureList(report.failures, limit)}</div>`;
  }
  /** Language-specific code constructs (endpoints, components, signals, IPC channels, bridges, types): [{ badge, tone, name, detail, file }]. */
  function codeMap(items, limit = 24) {
    const seen = new Set(), list = [];
    for (const item of items || []) {
      if (!item || !item.name) continue;
      const key = `${item.badge || ''}|${item.name}|${item.file || ''}`;
      if (seen.has(key)) continue;
      seen.add(key); list.push(item);
      if (list.length >= limit) break;
    }
    if (!list.length) return '';
    return `<div class="cv-code-map">${list.map(item => `<div class="cv-code-item">${item.badge ? `<span class="cv-code-kind"${item.tone ? ` data-tone="${esc(item.tone)}"` : ''}>${esc(item.badge)}</span>` : ''}<code>${esc(item.name)}</code>${item.detail ? `<span class="cv-code-detail">${esc(item.detail)}</span>` : ''}${item.file ? `<small title="${esc(item.file)}">${esc(baseName(item.file))}</small>` : ''}</div>`).join('')}</div>`;
  }
  /** Source lines with their numbers: [{ line, text }]. */
  const code = rows => `<div class="cv-code-view">${rows.map(row => `<div><i>${esc(row.line ?? '')}</i><span>${esc(row.text)}</span></div>`).join('')}</div>`;
  /** A unified diff with added and removed lines in color. */
  const diff = text => `<div class="cv-diff-view">${String(text ?? '').split('\n').slice(0, 800).map(line => { const type = /^(?:\+\+\+|---|diff |index )/.test(line) ? 'meta' : line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : line.startsWith('@@') ? 'hunk' : ''; return `<div${type ? ` data-line="${type}"` : ''}>${esc(line) || ' '}</div>`; }).join('')}</div>`;

  // ── Views of the core kinds of work.
  function highlight(text, pattern, flags) {
    let expression = null; try { expression = pattern ? new RegExp(pattern, `g${flags?.includes('-i') ? 'i' : ''}`) : null; } catch { /* A pattern of another regex dialect shows without highlighting. */ }
    if (!expression) return esc(text);
    let result = '', at = 0;
    for (const match of String(text).matchAll(expression)) { if (!match[0]) break; result += `${esc(text.slice(at, match.index))}<mark>${esc(match[0])}</mark>`; at = match.index + match[0].length; }
    return result + esc(text.slice(at));
  }
  function searchView(node) {
    const target = node.search || node.insight?.search || {}, results = searchResults(node.output), meta = node.resultMeta || {}, done = node.status !== 'running';
    const fileCount = meta.numFiles ?? results.files.filter(file => file.path).length, matchCount = meta.numLines ?? meta.numMatches ?? results.matches;
    const summary = !done ? [] : results.empty && !fileCount ? [{ text: t('Eşleşme yok'), tone: 'idle' }] : [matchCount ? { text: template`${number(matchCount)} eşleşme` } : null, fileCount ? { text: template`${number(fileCount)} dosya` } : null];
    const query = `<div class="cv-search-query">${target.pattern ? `<code class="cv-search-pattern">${esc(target.pattern)}</code>` : ''}${(target.paths || []).filter(Boolean).map(path => `<span class="ui-chip is-mono" title="${esc(path)}">${esc(baseName(path) || path)}</span>`).join('')}${(target.flags || []).map(flag => `<span class="ui-chip is-mono">${esc(flag)}</span>`).join('')}</div>`;
    const groups = results.files.map(file => `<section class="cv-search-file"><header>${file.path ? fileName(file.path) : ''}${file.count ? `<span class="ui-chip">${number(file.count)}</span>` : ''}</header>${file.matches.length ? `<div class="cv-code-view">${file.matches.map(row => `<div><i>${esc(row.line)}</i><span>${highlight(row.text, target.pattern, target.flags)}</span></div>`).join('')}</div>` : ''}</section>`).join('');
    return { chips: summary, lead: query, ...(groups ? { output: `<div class="cv-search-results">${groups}${results.truncated ? `<p class="cv-output-truncated">${esc(t('Sonuçların bir kısmı gösteriliyor.'))}</p>` : ''}</div>` } : {}), quietEmpty: done && results.empty };
  }
  function readView(node) {
    const meta = node.resultMeta || {}, rows = [];
    for (const line of stripAnsi(node.output).split('\n')) { const match = line.match(/^\s*(\d+)(?:\t|→)(.*)$/); if (match) rows.push({ line: match[1], text: match[2] }); else if (rows.length && line === '') continue; else if (!rows.length && line) return { chips: [] }; }
    const lines = meta.numLines ?? rows.length, start = meta.startLine ?? (rows[0] ? Number(rows[0].line) : 0);
    const range = lines && meta.totalLines && lines < meta.totalLines ? template`Satır ${start}–${start + lines - 1} / ${number(meta.totalLines)}` : lines ? template`${number(lines)} satır` : '';
    return { chips: [{ text: range }], ...(rows.length ? { output: code(rows.slice(0, 800)) } : {}) };
  }
  function filesView(node) {
    const files = node.files || [], added = files.reduce((sum, file) => sum + (file.added || 0), 0), removed = files.reduce((sum, file) => sum + (file.removed || 0), 0);
    return { chips: [added ? { text: `+${number(added)}`, tone: 'done' } : null, removed ? { text: `−${number(removed)}`, tone: 'failed' } : null, files.length > 1 ? { text: template`${files.length} dosya` } : null] };
  }
  function testView(node) {
    if (node.status === 'running') return { pin: true, chips: [] };
    const report = testReport(node.output);
    if (!report) return { pin: true, chips: [] };
    return { pin: true, tone: report.failed ? 'failed' : 'done', chips: [report.passed ? { text: template`${number(report.passed)} geçti`, tone: 'done' } : null, report.failed ? { text: template`${number(report.failed)} kaldı`, tone: 'failed' } : null, report.skipped ? { text: template`${number(report.skipped)} atlandı`, tone: 'idle' } : null, report.duration ? { text: report.duration } : null],
      inline: testExplorer(report, { compact: true }), lead: testExplorer(report) };
  }
  function compileView(node) {
    if (node.status === 'running') return { pin: true, chips: [] };
    const found = diagnostics(node.output); if (!found.items.length) return { pin: true, chips: [], tone: node.status === 'failed' ? 'failed' : 'done' };
    return { pin: true, tone: found.errors ? 'failed' : 'needs', chips: [found.errors ? { text: template`${number(found.errors)} hata`, tone: 'failed' } : null, found.warnings ? { text: template`${number(found.warnings)} uyarı`, tone: 'needs' } : null],
      ...(found.errors ? { inline: diagnosticList(found.items.filter(item => item.severity === 'error'), 5) } : {}), lead: diagnosticList(found.items) };
  }
  function gitView(node) {
    if (['diff', 'show'].includes(node.insight?.git) && /^(?:diff |@@|[-+]{3} )/m.test(node.output || '')) return { chips: [], output: diff(stripAnsi(node.output)) };
    const pushed = stripAnsi(node.output).match(/^\[([^\]\s]+)\s+([0-9a-f]{7,})\]/m);
    return { chips: pushed ? [{ text: pushed[2], title: pushed[1] }] : [] };
  }
  function todoView(node) {
    const todos = node.todos || [], done = todos.filter(todo => todo.status === 'completed').length;
    return { chips: todos.length ? [{ text: `${done}/${todos.length}`, tone: done === todos.length ? 'done' : 'running' }] : [], lead: steps(todos.map(todo => ({ text: todo.text, state: ({ completed: 'done', in_progress: 'running' })[todo.status] || 'pending' }))) };
  }
  function questionView(node) {
    const answers = node.resultMeta?.answers || Object.fromEntries([...String(node.output || '').matchAll(/"([^"]+)"="([^"]*)"/g)].map(match => [match[1], match[2]]));
    const list = node.questions || [], answered = list.filter(item => answers[item.question] !== undefined).length;
    return { tone: node.status === 'running' ? 'needs' : undefined, chips: [node.status === 'running' ? { text: t('Yanıtın bekleniyor'), tone: 'needs' } : answered ? { text: t('Yanıtlandı'), tone: 'done' } : null],
      lead: `<div class="cv-tool-questions">${list.map(item => { const answer = answers[item.question], chosen = String(answer ?? '').split(/,\s*/); return `<section>${item.header ? `<span class="ui-chip">${esc(item.header)}</span>` : ''}<p>${esc(item.question)}</p><ul>${(item.options || []).map(option => `<li${chosen.includes(option.label) ? ' data-selected="true"' : ''}><b>${esc(option.label)}</b>${option.description ? `<small>${esc(option.description)}</small>` : ''}</li>`).join('')}</ul>${answer !== undefined && !(item.options || []).some(option => chosen.includes(option.label)) ? `<div class="cv-answer"><strong>${esc(t('Yanıtın'))}</strong><p>${esc(answer)}</p></div>` : ''}</section>`; }).join('')}</div>` };
  }
  const planView = node => ({ chips: [], lead: `<div class="cv-markdown cv-tool-plan">${markdown(String(node.plan || '').slice(0, 20000))}</div>` });
  const CORE_VIEWS = { search: searchView, read: readView, test: testView, build: compileView, git: gitView, todo: todoView, question: questionView, plan: planView };
  function coreView(node) {
    const view = node.kind === 'files' ? filesView(node) : (CORE_VIEWS[node.view || node.insight?.kind] || (() => ({ chips: [] })))(node);
    if (node.kind === 'tool' && !(node.files && node.files.length)) {
      const extraFiles = shellFiles ? shellFiles(node) : [];
      if (extraFiles.length) view.files = extraFiles;
    }
    // A failed command says why on its last line, without opening the card.
    if (!view.inline && node.status === 'failed' && node.output) { const last = stripAnsi(node.output).split('\n').map(line => line.trim()).filter(Boolean).at(-1); if (last) view.inline = `<p class="cv-tool-failline" title="${esc(last)}">${esc(last.slice(0, 240))}</p>`; }
    return view;
  }
  /** The revision of the plugin views; a change redraws the cards. */
  const viewRevision = () => global.AIWSPlugins?.conversationRevision?.() ?? 0;
  const activityKind = node => node.kind === 'files' ? 'files' : node.icon === 'agent' ? 'agent' : node.web ? 'web' : node.view === 'search' ? 'search' : node.view === 'read' ? 'read' : node.insight?.kind;
  // Views are read on every redraw of a chat and parse output, so each is kept until its call changes.
  const viewCache = new Map();
  /** The row and card of a tool call: { title, subject, icon, tone, chips, inline, lead, output, pin, activity, quietEmpty }. */
  function toolView(node) {
    const key = `${viewRevision()}|${node.id}|${node.startedAt}|${node.status}|${node.output?.length || 0}|${node.files?.length || 0}`; let view = viewCache.get(key);
    if (!view) { if (viewCache.size >= 4000) viewCache.clear(); view = buildView(node); viewCache.set(key, view); }
    return view;
  }
  function buildView(node) {
    const core = coreView(node), plugged = global.AIWSPlugins?.conversationToolView?.(node) || null, summary = plugged?.summary || {};
    const mergedChips = (node.kind === 'files' || node.view === 'read' || (core.chips?.length && summary.chips?.length && !plugged?.detail?.includes('cv-test-explorer'))) && summary.chips ? [...(core.chips || []).filter(Boolean), ...summary.chips] : summary.chips || core.chips;
    const mergeTestBuild = (node.insight?.kind === 'test' || node.insight?.kind === 'build') && plugged?.detail && !plugged.detail.includes('cv-test-explorer') && !plugged.detail.includes('cv-diagnostics');
    const inline = mergeTestBuild && core.inline && plugged?.inline ? `${core.inline}${plugged.inline}` : plugged?.inline ?? core.inline;
    const lead = mergeTestBuild && core.lead ? `${core.lead}${plugged.detail}` : plugged?.detail ?? core.lead;
    return { ...core, title: summary.title || node.title || node.toolName || t('Araç çağrısı'), subject: summary.subject || core.subject || node.insight?.subject, icon: summary.icon, tone: summary.tone || core.tone, chips: mergedChips, inline, lead, pin: summary.pin ?? core.pin, activity: summary.activity || activityLabel(activityKind(node)), plugin: plugged?.plugin };
  }
  /** Whether a call stays in sight when a long streak of tool calls folds: test and build results and anything that failed. */
  const toolStaysVisible = node => ['failed', 'incomplete'].includes(node.status) || Boolean(toolView(node).pin);
  Object.assign(kit, { toolView, toolStaysVisible, viewRevision, baseName, viewUi: Object.freeze({ chips, resultBar, fileName, stats, steps, diagnostics: diagnosticList, failures: failureList, testExplorer, codeMap, code, diff }) });
})(globalThis);
