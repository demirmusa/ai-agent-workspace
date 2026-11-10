/* Live timeline of a project's runs: one row per agent and one bar per run, placed by when the run started and ended, with dashed
 * curves from a dependency's run to its dependent's and an inline answer for a run that waits on the operator.
 * AIWSTimeline.create(host, data) appends the view to host and returns {element, update(data), destroy()}.
 *   data.rows  [{key, name, model, icon}]: one per agent; icon is an image URL or ''.
 *   data.bars  [{id, row, task, project, title, start, end, tone, label, startText, endText, request}]: one per run. start and end are
 *              epoch milliseconds and end is null while the run is open; tone is an AIWSUI tone and label its status text;
 *              project is the name to lead the title with ('' within one project); request is {id, kind: 'approval'|'question', terminal, excerpt} or null.
 *   data.links [{from, to}]: run ids, the dependency's run first.
 *   A bar without a request carries data-open-task, so the app's one task opener handles its click.
 *   data.activity(runId) → the run's latest activity lines; data.onOpen(taskId) opens a task from a request; data.onDecide(questionId, 'approve'|'deny') → Promise;
 *   data.onAnswer(questionId).
 * update() patches rows, bars and connectors by key and never rebuilds the view. While the view is attached and the page is visible,
 * one 1 Hz clock moves only bar geometry and the connectors. */
(function (global) {
  'use strict';
  const { esc, icon, statusPill, sparkle, motion, reducedMotion, menuNavigate } = global.AIWSUI;
  const t = value => global.AIWSI18n.text(value), svgNS = 'http://www.w3.org/2000/svg', easeOut = 'cubic-bezier(.16,1,.3,1)';
  const { ranges, amount, length, rowState, stack, storedRange, rangeKey, minSpan, maxSpan, zoomStep } = global.AIWSTimelineScale;
  const barTitle = bar => bar.project ? `${bar.project} · ${bar.title}` : bar.title;

  let instances = 0;
  /** Appends a live timeline of data's runs to host; returns {element, update(data), destroy()}. */
  function create(host, initial) {
    const doc = host.ownerDocument, id = `aiws-timeline-${++instances}`;
    const root = doc.createElement('section'); root.className = 'timeline ui-card'; root.setAttribute('aria-label', t('Zaman çizelgesi'));
    const counter = tone => `<button type="button" class="timeline-count" data-count="${tone}" hidden><span class="ui-dot" data-tone="${tone}"></span><span class="timeline-count-text"></span></button>`;
    const rangeTabs = ranges.map(range => `<button type="button" class="view-tab" data-range="${range.id}" aria-pressed="false">${esc(amount(range.span))}</button>`).join('')
      + `<button type="button" class="view-tab" data-range="custom" aria-pressed="false">${esc(t('Özel'))}</button>`;
    root.innerHTML = global.AIWSI18n.template`<header class="timeline-header"><div class="timeline-title">${sparkle('accent')}<strong>Agentlar</strong>${counter('running')}${counter('needs')}</div><div class="timeline-controls"><div class="timeline-zoom" role="group" aria-label="Yakınlaştırma" title="${esc(t('Ctrl + tekerlekle yakınlaştır, sürükleyerek kaydır'))}"><button type="button" class="icon-button" data-zoom="out" aria-label="${esc(t('Uzaklaştır'))}">−</button><span class="timeline-zoom-level"></span><button type="button" class="icon-button" data-zoom="in" aria-label="${esc(t('Yakınlaştır'))}">+</button></div><div class="view-tabs timeline-ranges" role="group" aria-label="Zaman aralığı">${rangeTabs}</div></div><div class="timeline-custom" hidden><label>${esc(t('Başlangıç'))}<input type="date" data-custom="from"></label><label>${esc(t('Bitiş'))}<input type="date" data-custom="to"></label></div></header><div class="timeline-body"><div class="timeline-axis" aria-hidden="true"><div class="timeline-ticks"></div><span class="ui-chip is-accent timeline-now">şimdi</span></div><div class="timeline-rows"><div class="timeline-grid" aria-hidden="true"></div><svg class="timeline-links" aria-hidden="true" focusable="false"></svg><div class="timeline-list"></div><div class="timeline-empty" hidden><strong>Bu aralıkta çalışan agent yok</strong><p>Daha geniş bir aralık seç ya da bir görev başlat.</p></div></div></div><div class="ui-tooltip timeline-tip" id="${id}-tip" role="tooltip" hidden></div>`;
    host.append(root);
    const find = selector => root.querySelector(selector);
    const body = find('.timeline-body'), ticks = find('.timeline-ticks'), grid = find('.timeline-grid'), svg = find('.timeline-links'), list = find('.timeline-list'), empty = find('.timeline-empty'), tip = find('.timeline-tip');
    // Elements by key, what each element shows (so unchanged parts are never written), and per-run layout results.
    const rowEls = new Map(), barEls = new Map(), linkEls = new Map(), rowMemo = new WeakMap(), barMemo = new WeakMap(), paths = new Map();
    const bars = new Map(), names = new Map(), lanes = new Map(), places = new Map(), centers = new Map();
    let data = initial, rangeId = storedRange(), now = Date.now(), shown = [], links = [], width = 0, layoutKey = null, unmeasured = true;
    let timer = 0, frame = 0, tipTimer = 0, tipBar = null, tipX = null, tipHtml = '', hoverBar = null, pop = null, destroyed = false;
    // custom is a fixed window (chosen dates, or zoomed and panned into the past); zoomSpan is a live window's zoomed span.
    let custom = null, zoomSpan = null, drag = null;
    const span = () => custom ? custom.to - custom.from : zoomSpan ?? ranges.find(range => range.id === rangeId)?.span;
    /** The visible window: the fixed one, else the chosen span ending now. */
    const visibleWindow = () => custom ? { from: custom.from, to: custom.to } : { from: now - span(), to: now };
    const locale = doc.documentElement.lang || undefined, dayFormat = new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short' });
    const clockFormat = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }), dayClockFormat = new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    /** A fixed window's axis names the time, adding the date once the window is long enough to cross days. */
    const fixedLabel = (value, range) => (range > 3 * 86400000 ? dayFormat : range > 12 * 3600000 ? dayClockFormat : clockFormat).format(value);
    const parseDay = (value, end) => { const date = value ? new Date(`${value}T00:00:00`) : null; return date && !Number.isNaN(+date) ? +date + (end ? 86400000 - 1 : 0) : null; };

    /** Marks the chosen range and draws its five steps back from now on the axis and the grid. */
    function renderRange() {
      const range = span(), step = range / 6, win = visibleWindow();
      const marks = [5, 4, 3, 2, 1].map(count => [`${(100 - count * 100 / 6).toFixed(3)}%`, custom ? fixedLabel(win.to - count * step, range) : `−${length(count * step)}`]);
      find('.timeline-now').hidden = Boolean(custom);
      find('.timeline-zoom-level').textContent = length(range);
      find('[data-zoom=in]').disabled = range <= minSpan; find('[data-zoom=out]').disabled = range >= maxSpan;
      find('.timeline-custom').hidden = rangeId !== 'custom';
      for (const button of root.querySelectorAll('[data-range]')) { const active = button.dataset.range === rangeId; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
      ticks.innerHTML = marks.map(([left, label]) => `<span class="timeline-tick" style="left:${left}">${esc(label)}</span>`).join('');
      grid.innerHTML = marks.map(([left]) => `<span style="left:${left}"></span>`).join('');
    }

    /** Fits the data to the range (agents into rows, overlapping runs into lanes, connectors between shown bars) and patches the DOM by key. */
    function relayout() {
      now = Date.now();
      const range = span(), { from, to } = visibleWindow(), rows = new Map(data.rows.map(row => [row.key, row])), groups = new Map();
      bars.clear(); names.clear(); lanes.clear();
      for (const row of data.rows) names.set(row.key, row.name);
      for (const bar of data.bars) {
        bars.set(bar.id, bar);
        if ((bar.end ?? now) < from || bar.start > to || !rows.has(bar.row)) continue;
        if (!groups.has(bar.row)) groups.set(bar.row, []);
        groups.get(bar.row).push(bar);
      }
      // Agents read top to bottom in the order they first worked within the range, so the chart flows down and to the right.
      const layout = [...groups].map(([key, items]) => { items.sort((a, b) => a.start - b.start); return { row: rows.get(key), bars: items, lanes: stack(items, lanes, now, range / 100) }; })
        .sort((a, b) => a.bars[0].start - b.bars[0].start || a.row.name.localeCompare(b.row.name));
      shown = layout.flatMap(entry => entry.bars);
      const visible = new Set(shown.map(bar => bar.id));
      links = data.links.filter(link => link.from !== link.to && visible.has(link.from) && visible.has(link.to));
      const key = layout.map(entry => `${entry.row.key}:${entry.bars.map(bar => `${bar.id}@${lanes.get(bar.id)}`).join(',')}`).join('|');
      const patch = () => {
        for (const [runId, element] of barEls) if (!visible.has(runId)) { if (tipBar === element) hideTip(); element.remove(); barEls.delete(runId); }
        for (const [rowKey, element] of rowEls) if (!groups.has(rowKey)) { element.remove(); rowEls.delete(rowKey); }
        let cursor = list.firstElementChild;
        for (const entry of layout) {
          const element = rowEls.get(entry.row.key) || makeRow(entry.row.key);
          if (element === cursor) cursor = cursor.nextElementSibling; else list.insertBefore(element, cursor);
          patchRow(element, entry);
        }
        patchLinks();
      };
      // Rows glide only when agents, runs or lanes changed; a plain refresh patches in place without measuring anything.
      if (key === layoutKey) patch(); else { layoutKey = key; motion.flip(list, '.timeline-row', 'data-row', patch, { className: 'ui-enter-fade' }); unmeasured = true; }
      if (unmeasured) scheduleMeasure();
      empty.hidden = layout.length > 0; root.classList.toggle('is-empty', !layout.length);
      place(); counts();
      motion.enter(root, '.timeline-bar[data-run]', 'data-run');
      motion.enter(svg, 'path', 'data-link', { className: 'ui-enter-fade' });
      refreshTip(); syncPopover();
    }
    function makeRow(key) {
      const element = doc.createElement('div'); element.className = 'timeline-row'; element.dataset.row = key; element.setAttribute('role', 'group');
      element.innerHTML = '<div class="timeline-agent"><span class="ui-icon-box"></span><span class="timeline-agent-text"><span class="timeline-agent-line"><strong class="timeline-agent-name"></strong><span class="timeline-agent-state"></span></span><small class="timeline-agent-model"></small></span></div><div class="timeline-track"></div>';
      rowEls.set(key, element); rowMemo.set(element, {});
      return element;
    }
    function patchRow(element, { row, bars: items, lanes: count }) {
      const memo = rowMemo.get(element), [tone, label] = rowState(items), state = `${tone}|${label}`, track = element.lastElementChild;
      const logo = row.icon ? `<img src="${esc(row.icon)}" alt="" width="14" height="14">` : esc(String(row.name ?? '').trim().charAt(0).toUpperCase());
      if (memo.name !== row.name) { element.querySelector('.timeline-agent-name').textContent = row.name; element.setAttribute('aria-label', row.name); memo.name = row.name; }
      if (memo.model !== row.model) { element.querySelector('.timeline-agent-model').textContent = row.model || ''; memo.model = row.model; }
      if (memo.logo !== logo) { element.querySelector('.ui-icon-box').innerHTML = logo; memo.logo = logo; }
      if (memo.state !== state) { const holder = element.querySelector('.timeline-agent-state'); holder.innerHTML = statusPill(tone, label); if (memo.state) fadeIn(holder); memo.state = state; }
      if (memo.lanes !== count) { track.style.setProperty('--lanes', String(count)); memo.lanes = count; }
      let cursor = track.firstElementChild;
      for (const bar of items) {
        while (cursor?.classList.contains('is-ghost')) cursor = cursor.nextElementSibling;
        const barElement = barEls.get(bar.id) || makeBar(bar.id);
        if (barElement === cursor) cursor = cursor.nextElementSibling; else track.insertBefore(barElement, cursor);
        patchBar(barElement, bar, lanes.get(bar.id), row.name);
      }
    }
    function makeBar(runId) {
      const element = doc.createElement('button'); element.type = 'button'; element.className = 'timeline-bar'; element.dataset.run = runId;
      barEls.set(runId, element); barMemo.set(element, {});
      return element;
    }
    function patchBar(element, bar, lane, agent) {
      const memo = barMemo.get(element), popup = Boolean(bar.request);
      const content = `${bar.project ? `<span class="timeline-bar-project">${esc(bar.project)}</span>` : ''}<span class="timeline-bar-title">${esc(bar.title)}</span>${popup ? `<span class="timeline-bar-needs">${icon('triangle')}${esc(t('Seni bekliyor'))}</span>` : ''}`;
      if (memo.tone !== bar.tone || memo.content !== content) {
        if (memo.tone && memo.tone !== bar.tone) crossfade(element);
        element.dataset.tone = bar.tone; if (memo.content !== content) element.innerHTML = content;
        memo.tone = bar.tone; memo.content = content;
      }
      const opens = popup ? '' : bar.task;
      if (memo.opens !== opens) { if (opens) element.dataset.openTask = opens; else delete element.dataset.openTask; memo.opens = opens; }
      const label = `${agent} · ${barTitle(bar)} · ${bar.label} · ${bar.startText} – ${bar.end === null ? t('şimdi') : `${bar.endText} · ${length(bar.end - bar.start)}`}`;
      if (memo.label !== label) { element.setAttribute('aria-label', label); memo.label = label; }
      if (memo.lane !== lane) { element.style.setProperty('--lane', String(lane)); memo.lane = lane; }
      if (memo.popup !== popup) {
        if (popup) { element.setAttribute('aria-haspopup', 'dialog'); element.setAttribute('aria-expanded', String(pop?.bar === element)); }
        else { element.removeAttribute('aria-haspopup'); element.removeAttribute('aria-expanded'); }
        memo.popup = popup;
      }
    }
    // A bar that changes tone fades its old look out over the new one: an opacity-only crossfade of a short-lived copy.
    function crossfade(element) {
      if (reducedMotion() || !element.isConnected || typeof element.animate !== 'function') return;
      const ghost = element.cloneNode(true);
      for (const name of ['data-run', 'data-open-task', 'aria-label', 'aria-describedby', 'aria-haspopup', 'aria-expanded']) ghost.removeAttribute(name);
      ghost.classList.remove('ui-enter', 'ui-enter-fade'); ghost.classList.add('is-ghost'); ghost.style.removeProperty('--enter-delay');
      ghost.setAttribute('aria-hidden', 'true'); ghost.tabIndex = -1; ghost.inert = true;
      element.after(ghost);
      const remove = () => ghost.remove();
      ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'forwards' }).finished.then(remove, remove);
    }
    function fadeIn(element) {
      if (!reducedMotion() && typeof element.animate === 'function') element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: easeOut });
    }

    /** Moves every shown bar to its start and end within the range, then the connectors; the 1 Hz clock runs only this. */
    function place() {
      const range = span(), { from } = visibleWindow(), least = width ? 600 / width : .6;
      places.clear();
      for (const bar of shown) {
        const element = barEls.get(bar.id); if (!element) continue;
        // Bars that began before the range stick out past the left edge, where the track clips and the mask fades them.
        const memo = barMemo.get(element), start = (bar.start - from) / range * 100, end = Math.min(((bar.end ?? now) - from) / range * 100, 100);
        const size = Math.max(end - Math.max(start, -2), least), left = Math.min(Math.max(start, -2), 100 - size), box = `${left.toFixed(3)}|${size.toFixed(3)}`;
        places.set(bar.id, [left, size]);
        if (memo.box !== box) { element.style.left = `${left.toFixed(3)}%`; element.style.width = `${size.toFixed(3)}%`; memo.box = box; }
        const clipped = start < -.05;
        if (memo.clipped !== clipped) { element.classList.toggle('is-clipped', clipped); memo.clipped = clipped; }
      }
      drawLinks();
      const open = tipBar && bars.get(tipBar.dataset.run);
      if (open && open.end === null) { const element = tip.querySelector('.timeline-tip-length'); if (element) element.textContent = length(now - open.start); }
    }
    function patchLinks() {
      const keys = new Set(links.map(link => `${link.from}>${link.to}`));
      for (const [key, path] of linkEls) if (!keys.has(key)) { path.remove(); linkEls.delete(key); paths.delete(key); }
      for (const key of keys) if (!linkEls.has(key)) { const path = doc.createElementNS(svgNS, 'path'); path.setAttribute('data-link', key); svg.append(path); linkEls.set(key, path); }
    }
    /** Draws each connector from the right end of the dependency's bar to the left end of its dependent's, leaving and arriving level. */
    function drawLinks() {
      const at = value => value.toFixed(1);
      for (const link of links) {
        const key = `${link.from}>${link.to}`, path = linkEls.get(key), a = places.get(link.from), b = places.get(link.to), y1 = centers.get(link.from), y2 = centers.get(link.to);
        if (!path) continue;
        let d = '';
        if (width && a && b && y1 !== undefined && y2 !== undefined) {
          const x1 = (a[0] + a[1]) * width / 100, x2 = b[0] * width / 100, bend = Math.max(14, Math.abs(x2 - x1) / 2);
          d = `M${at(x1)} ${at(y1)}C${at(x1 + bend)} ${at(y1)} ${at(x2 - bend)} ${at(y2)} ${at(x2)} ${at(y2)}`;
        }
        if (paths.get(key) !== d) { if (d) path.setAttribute('d', d); else path.removeAttribute('d'); paths.set(key, d); }
      }
    }
    const scheduleMeasure = () => { if (!frame && typeof global.requestAnimationFrame === 'function') frame = global.requestAnimationFrame(measure); };
    /** Reads where each bar sits vertically, once after rows or lanes change and in the frame's own layout pass, so the clock never reads layout. */
    function measure() {
      frame = 0;
      if (destroyed || !root.isConnected) return;
      width = grid.clientWidth; centers.clear(); unmeasured = false;
      for (const [runId, element] of barEls) if (element.parentElement) centers.set(runId, element.parentElement.offsetTop + element.offsetTop + element.offsetHeight / 2);
      place();
    }
    const resizer = typeof global.ResizeObserver === 'function' ? new global.ResizeObserver(() => { const next = grid.clientWidth; if (next !== width) { width = next; place(); } }) : null;
    resizer?.observe(grid);

    function counts() {
      const open = data.bars.filter(bar => bar.end === null);
      for (const button of root.querySelectorAll('[data-count]')) {
        const tone = button.dataset.count, number = open.filter(bar => bar.tone === tone).length;
        button.hidden = !number;
        if (number) motion.swapText(button.lastElementChild, tone === 'running' ? global.AIWSI18n.template`${number} çalışıyor` : global.AIWSI18n.template`${number} seni bekliyor`);
      }
    }
    // A header count takes the operator to the first such bar; a waiting one opens its request at once.
    function focusFirst(tone) {
      const bar = shown.find(item => item.end === null && item.tone === tone), element = bar && barEls.get(bar.id);
      if (!element) return;
      element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); element.focus({ preventScroll: true });
      if (bar.request) openPopover(element); else showTip(element);
    }
    function syncInputs() {
      const day = value => { const d = new Date(value); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
      find('[data-custom=from]').value = day(custom.from); find('[data-custom=to]').value = day(custom.to);
    }
    function setCustom() {
      const from = parseDay(find('[data-custom=from]').value, false), to = parseDay(find('[data-custom=to]').value, true);
      if (from === null || to === null || to <= from) return;
      custom = { from, to }; hideTip(); closePopover(false); renderRange(); relayout();
    }
    function setRange(next) {
      if (next === rangeId || (next !== 'custom' && !ranges.some(range => range.id === next))) return;
      if (next === 'custom') { if (!custom) { const to = new Date(); to.setHours(23, 59, 59, 999); custom = { from: +to - 7 * 86400000 + 1, to: +to }; } syncInputs(); }
      else custom = null;
      rangeId = next; zoomSpan = null;
      try { if (next !== 'custom') global.localStorage.setItem(rangeKey, next); } catch { /* The range is only a preference. */ }
      hideTip(); closePopover(false); renderRange(); relayout();
      if (!reducedMotion() && typeof body.animate === 'function') body.animate([{ opacity: .3 }, { opacity: 1 }], { duration: 260, easing: easeOut });
    }
    /** Shows from..to after a zoom or pan: chosen dates stay fixed, a window reaching now goes live, any other is fixed in the past. */
    function showWindow(from, to) {
      if (rangeId === 'custom') { custom = { from, to }; syncInputs(); }
      else if (to >= now) {
        const next = Math.round(to - from), preset = ranges.find(range => range.span === next);
        custom = null; zoomSpan = preset ? null : next; rangeId = preset ? preset.id : 'zoom';
      } else { custom = { from, to }; zoomSpan = null; rangeId = 'zoom'; }
      hideTip(); closePopover(false); renderRange(); relayout();
    }
    /** Scales the window by factor, keeping the time at ratio (0 left, 1 right) in place. */
    function zoom(factor, ratio) {
      const range = span(), next = Math.min(maxSpan, Math.max(minSpan, range * factor));
      if (next === range) return;
      const from = visibleWindow().from + ratio * (range - next);
      showWindow(from, from + next);
    }
    const panBy = (from, to, pixels) => { const shift = pixels / (grid.clientWidth || 1) * (to - from); showWindow(from + shift, to + shift); };

    // One tooltip serves every bar: agent, status and length, when the run started and ended, then its latest activity.
    function fillTip() {
      const bar = bars.get(tipBar.dataset.run), lines = data.activity?.(bar.id) || [];
      const html = `<p class="timeline-tip-head">${esc(names.get(bar.row) || '')} · ${esc(bar.label)} · <span class="timeline-tip-length">${esc(length((bar.end ?? Date.now()) - bar.start))}</span></p><p class="timeline-tip-title">${esc(barTitle(bar))}</p><p class="timeline-tip-time">${esc(bar.startText)} – ${esc(bar.end === null ? t('şimdi') : bar.endText)}</p>${lines.length ? `<ul class="timeline-tip-steps">${lines.map(line => `<li>${esc(line)}</li>`).join('')}</ul>` : ''}`;
      if (html !== tipHtml) { tip.innerHTML = html; tipHtml = html; }
    }
    /** Shows the tooltip under the bar near the pointer (or the bar's visible start for keyboard focus), above it when no room is left below. */
    function showTip(element, x = null) {
      clearTimeout(tipTimer); tipTimer = 0;
      if (pop || !element.isConnected || !bars.has(element.dataset.run) || (tipBar === element && !tip.hidden)) return;
      tipBar?.removeAttribute('aria-describedby');
      tipBar = element; tipX = x;
      fillTip(); tip.hidden = false; element.setAttribute('aria-describedby', tip.id);
      const box = root.getBoundingClientRect(), rect = element.getBoundingClientRect(), track = element.parentElement.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
      const ox = box.left + root.clientLeft, oy = box.top + root.clientTop, anchor = tipX ?? Math.max(rect.left, track.left) + 14;
      const below = rect.bottom - oy + 6, above = rect.top - oy - h - 6;
      tip.style.left = `${Math.round(Math.max(8, Math.min(anchor - ox - 18, root.clientWidth - w - 8)))}px`;
      tip.style.top = `${Math.round(below + h > root.clientHeight - 4 && above >= 0 ? above : below)}px`;
    }
    function hideTip() {
      clearTimeout(tipTimer); tipTimer = 0;
      if (!tipBar) return;
      tipBar.removeAttribute('aria-describedby'); tipBar = null; tip.hidden = true;
    }
    function refreshTip() { if (tipBar) { if (tipBar.isConnected && bars.has(tipBar.dataset.run)) fillTip(); else hideTip(); } }

    // A waiting run's bar opens its request: approve or deny it here, or open the task to answer a question.
    function openPopover(element) {
      closePopover(false);
      const bar = bars.get(element.dataset.run), request = bar?.request;
      if (!request) return;
      hideTip();
      const decide = request.kind === 'approval' && !request.terminal, box = doc.createElement('div');
      box.className = 'timeline-popover popup-menu'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-labelledby', `${id}-request`);
      box.innerHTML = `<p class="timeline-popover-kind">${esc(t(request.kind === 'approval' ? 'Onay gerekiyor' : 'Soru'))}</p><strong class="timeline-popover-title" id="${id}-request">${esc(barTitle(bar))}</strong><p class="timeline-popover-text">${esc(request.excerpt)}</p><p class="timeline-popover-error" role="alert" hidden></p><div class="timeline-popover-actions"><button type="button" class="button small ghost" data-timeline-action="open">${esc(t('Görevi aç'))}</button>${decide ? `<button type="button" class="button small" data-timeline-action="deny">${esc(t('Reddet'))}</button><button type="button" class="button small primary" data-timeline-action="approve">${esc(t('Onayla'))}</button>` : `<button type="button" class="button small primary" data-timeline-action="answer">${esc(t('Yanıtla'))}</button>`}</div>`;
      root.append(box);
      pop = { box, bar: element, run: bar.id, request: request.id, task: bar.task };
      element.setAttribute('aria-expanded', 'true');
      // Above the bar, ending where the bar ends, like the reference; below it when the card has no room above.
      const frameBox = root.getBoundingClientRect(), rect = element.getBoundingClientRect(), track = element.parentElement.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight;
      const ox = frameBox.left + root.clientLeft, oy = frameBox.top + root.clientTop, above = rect.top - oy - h - 8;
      box.dataset.side = above >= 4 ? 'above' : 'below';
      box.style.left = `${Math.round(Math.max(8, Math.min(Math.min(rect.right, track.right) - ox - w, root.clientWidth - w - 8)))}px`;
      box.style.top = `${Math.round(above >= 4 ? above : rect.bottom - oy + 8)}px`;
      box.addEventListener('click', onPopoverClick); box.addEventListener('keydown', onPopoverKey); box.addEventListener('focusout', onPopoverBlur);
      doc.addEventListener('pointerdown', onOutside, true);
      box.querySelector('button')?.focus();
    }
    function closePopover(restore) {
      if (!pop) return;
      const { box, bar } = pop; pop = null;
      doc.removeEventListener('pointerdown', onOutside, true);
      motion.dismiss(box, () => box.remove());
      if (bar.hasAttribute('aria-expanded')) bar.setAttribute('aria-expanded', 'false');
      if (restore && bar.isConnected) bar.focus({ preventScroll: true });
    }
    // An answered or withdrawn request closes its popover, returning focus to the bar when the popover held it.
    function syncPopover() { if (pop && (!pop.bar.isConnected || bars.get(pop.run)?.request?.id !== pop.request)) closePopover(pop.box.contains(doc.activeElement)); }
    async function onPopoverClick(event) {
      const button = event.target.closest('[data-timeline-action]');
      if (!button || !pop) return;
      const current = pop, action = button.dataset.timelineAction;
      if (action === 'open') { closePopover(false); data.onOpen?.(current.task); return; }
      if (action === 'answer') { closePopover(false); data.onAnswer?.(current.request); return; }
      const buttons = [...current.box.querySelectorAll('button')], problem = current.box.querySelector('.timeline-popover-error');
      for (const item of buttons) item.disabled = true;
      button.classList.add('is-busy'); problem.hidden = true;
      try { await data.onDecide?.(current.request, action); if (pop === current) closePopover(true); }
      catch (error) {
        if (pop !== current) return;
        problem.textContent = error?.message || t('Yanıt gönderilemedi.'); problem.hidden = false;
        for (const item of buttons) item.disabled = false;
        button.classList.remove('is-busy'); button.focus();
      }
    }
    function onPopoverKey(event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePopover(true); return; }
      if (pop) menuNavigate(event, pop.box, [...pop.box.querySelectorAll('button:not(:disabled)')]);
    }
    function onPopoverBlur(event) { if (pop && event.relatedTarget && !pop.box.contains(event.relatedTarget)) closePopover(false); }
    function onOutside(event) { if (pop && !pop.box.contains(event.target) && !pop.bar.contains(event.target)) closePopover(false); }

    root.addEventListener('change', event => { if (event.target.matches('[data-custom]')) setCustom(); });
    root.addEventListener('click', event => {
      const zooming = event.target.closest('[data-zoom]');
      if (zooming) { zoom(zooming.dataset.zoom === 'in' ? 1 / zoomStep : zoomStep, custom ? .5 : 1); return; }
      const range = event.target.closest('[data-range]');
      if (range) { setRange(range.dataset.range); return; }
      const count = event.target.closest('[data-count]');
      if (count) { focusFirst(count.dataset.count); return; }
      const element = event.target.closest('.timeline-bar[data-run]'), bar = element && bars.get(element.dataset.run);
      if (!bar) return;
      hideTip();
      if (!bar.request) return;
      if (pop?.bar === element) closePopover(true); else openPopover(element);
    });
    // Ctrl + wheel (and a trackpad pinch, which reports the same) zooms around the pointer; a sideways or Shift + wheel pans.
    body.addEventListener('wheel', event => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const box = grid.getBoundingClientRect();
        zoom(Math.exp(Math.max(-100, Math.min(100, event.deltaY)) * .004), box.width ? Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) : 1);
      } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault();
        const { from, to } = visibleWindow();
        panBy(from, to, event.deltaX || event.deltaY);
      }
    }, { passive: false });
    // Dragging the empty chart pans it; bars stay clickable.
    body.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.target.closest('.timeline-rows') || event.target.closest('.timeline-bar,.timeline-agent')) return;
      drag = { pointer: event.pointerId, x: event.clientX, ...visibleWindow() };
      body.setPointerCapture?.(event.pointerId); body.classList.add('is-panning');
    });
    body.addEventListener('pointermove', event => { if (drag?.pointer === event.pointerId && event.clientX !== drag.x) panBy(drag.from, drag.to, drag.x - event.clientX); });
    const endDrag = () => { drag = null; body.classList.remove('is-panning'); };
    body.addEventListener('pointerup', endDrag); body.addEventListener('pointercancel', endDrag);
    root.addEventListener('pointerover', event => {
      const element = event.target.closest?.('.timeline-bar[data-run]');
      if (event.pointerType === 'touch' || !element || element === hoverBar) return;
      hoverBar = element; clearTimeout(tipTimer);
      const x = event.clientX;
      tipTimer = setTimeout(() => showTip(element, x), 140);
    });
    root.addEventListener('pointerout', event => {
      const element = event.target.closest?.('.timeline-bar[data-run]');
      if (!element || element.contains(event.relatedTarget)) return;
      if (hoverBar === element) hoverBar = null;
      clearTimeout(tipTimer); tipTimer = 0;
      if (tipBar === element && doc.activeElement !== element) hideTip();
    });
    // Keyboard focus shows the tooltip at once; a pointer press focuses the bar too, but its click acts instead.
    root.addEventListener('focusin', event => { const element = event.target.closest?.('.timeline-bar[data-run]'); if (element?.matches(':focus-visible')) showTip(element); });
    root.addEventListener('focusout', event => { const element = event.target.closest?.('.timeline-bar[data-run]'); if (element && tipBar === element && hoverBar !== element) hideTip(); });
    // Escape dismisses a bar's tooltip first, before the app treats it as closing the task panel.
    root.addEventListener('keydown', event => { if (event.key === 'Escape' && !pop && tipBar && event.target === tipBar) { event.preventDefault(); hideTip(); } });

    // The clock ticks only while the view is attached and the page visible; detaching the view stops it at the next tick.
    const live = () => !destroyed && root.isConnected && !doc.hidden;
    function clock() { if (!live()) { clearInterval(timer); timer = 0; } else if (!timer) timer = setInterval(tick, 1000); }
    function tick() {
      if (!live()) { clock(); return; }
      now = Date.now();
      if (custom) return;
      if (shown.some(bar => bar.end !== null && bar.end < now - span())) relayout(); else place();
    }
    const onVisibility = () => { clock(); if (live()) tick(); };
    doc.addEventListener('visibilitychange', onVisibility);

    function update(next) {
      if (destroyed) return;
      data = next || data;
      relayout(); clock();
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true; clearInterval(timer); clearTimeout(tipTimer);
      if (frame) global.cancelAnimationFrame?.(frame);
      resizer?.disconnect(); doc.removeEventListener('visibilitychange', onVisibility); closePopover(false); root.remove();
    }
    renderRange(); relayout(); clock();
    return { element: root, update, destroy };
  }

  global.AIWSTimeline = Object.freeze({ create });
})(window);
