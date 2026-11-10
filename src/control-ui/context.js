/* Context window map: what an agent's context holds, drawn as a treemap beside the free space. Blocks are keyed by the server's
 * block IDs and kept between updates, so a live update glides each block to its new place and size (styles.css, .context-block)
 * instead of redrawing the map; numbers count to their new values. */
(function () {
  const t = value => globalThis.AIWSI18n.text(value);
  const { esc, icon, providerIcon, reducedMotion, menuNavigate, tokenCount, number, motion: { countTo } } = window.AIWSUI;
  // Kinds are laid out in this order, so the system prompt stays top left and a growing conversation fills in after it.
  const kinds = ['system', 'tools', 'memory', 'summary', 'chat', 'file', 'search', 'shell', 'tool', 'agent', 'reasoning'];
  const kindNames = () => ({ system: t('Sistem istemi'), tools: t('Araç tanımları'), memory: t('Proje belleği'), summary: t('Sıkıştırma özeti'), chat: t('Sohbet'), file: t('Dosyalar'), search: t('Arama'), shell: t('Terminal'), tool: t('Araç sonuçları'), agent: t('Alt agentlar'), reasoning: t('Düşünme') });
  const kindTags = () => ({ file: t('Dosya'), memory: t('Bellek'), tool: t('Araç'), search: t('Arama'), shell: t('Terminal'), agent: t('Agent') });
  const mapIcon = '<svg class="context-mark" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="5.5" height="13" rx="1.5" fill="currentColor"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1.5" fill="currentColor" opacity=".55"/><rect x="9" y="9" width="5.5" height="5.5" rx="1.5" fill="currentColor" opacity=".3"/></svg>';
  // Blocks leave over the same time they glide (styles.css --dur-layout).
  const leaveMs = 520, gap = 4, minUsedShare = 0.16, minBlockArea = 2400;
  const views = new WeakMap();

  /** Squarified treemap (Bruls, Huizing, van Wijk) in input order: each row is a strip along the shorter side of what is left. */
  function squarify(items, rect) {
    const total = items.reduce((sum, item) => sum + item.value, 0), out = [];
    let { x, y, w, h } = rect;
    if (!total || w <= 0 || h <= 0) return out;
    const scale = w * h / total; let row = [];
    const worst = (areas, side) => { const sum = areas.reduce((a, b) => a + b, 0); return Math.max(side * side * Math.max(...areas) / (sum * sum), sum * sum / (side * side * Math.min(...areas))); };
    const place = () => {
      const sum = row.reduce((a, entry) => a + entry.area, 0);
      if (w >= h) { const width = sum / h; let top = y; for (const entry of row) { const height = entry.area / width; out.push({ item: entry.item, x, y: top, w: width, h: height }); top += height; } x += width; w -= width; }
      else { const height = sum / w; let left = x; for (const entry of row) { const width = entry.area / height; out.push({ item: entry.item, x: left, y, w: width, h: height }); left += width; } y += height; h -= height; }
      row = [];
    };
    for (const item of items) {
      const area = item.value * scale, side = Math.min(w, h), current = row.map(entry => entry.area);
      if (row.length && worst([...current, area], side) > worst(current, side)) place();
      row.push({ item, area });
    }
    if (row.length) place();
    return out;
  }

  /** Pixel rectangles of every block and of the free space for a map of width × height. */
  function layout(snapshot, width, height, hidden = new Set()) {
    const off = id => Boolean(hidden?.has?.(id));
    const blocks = snapshot.blocks.filter(block => block.tokens > 0 && !off(block.id)), used = blocks.reduce((sum, block) => sum + block.tokens, 0);
    const showFree = Boolean(snapshot.window && !off('free'));
    const share = showFree ? Math.min(1, used / snapshot.window) : 1;
    const usedWidth = !used ? 0 : !showFree || share >= 0.97 ? width : Math.max(width * share, Math.min(width * minUsedShare, width - 80));
    // A small context still gets a readable column; the numbers above the map stay exact.
    const rects = [], pixelsPerToken = used ? usedWidth * height / used : 0;
    // Blocks too small to read join their kind's merged block.
    const readable = list => {
      const small = list.filter(block => block.merged || block.tokens * pixelsPerToken < minBlockArea), kept = list.filter(block => !small.includes(block));
      if (small.length === 1 && !small[0].merged) kept.push(small[0]);
      else if (small.length) kept.push({ id: `${list[0].kind}:+`, kind: list[0].kind, tokens: small.reduce((sum, block) => sum + block.tokens, 0), count: small.reduce((sum, block) => sum + (block.merged ? block.count : 1), 0), merged: true });
      return kept.sort((a, b) => b.tokens - a.tokens);
    };
    const groups = kinds.map(kind => blocks.filter(block => block.kind === kind)).filter(list => list.length).map(list => ({ kind: list[0].kind, blocks: readable(list), value: list.reduce((sum, block) => sum + block.tokens, 0) }));
    for (const area of squarify(groups, { x: 0, y: 0, w: usedWidth, h: height }))
      for (const cell of squarify(area.item.blocks.map(block => ({ ...block, value: block.tokens })), area)) rects.push({ block: cell.item, x: cell.x, y: cell.y, w: cell.w, h: cell.h });
    if (showFree && usedWidth < width) rects.push({ block: { id: 'free', kind: 'free', tokens: Math.max(0, snapshot.window - snapshot.used), count: 0 }, x: usedWidth, y: 0, w: width - usedWidth, h: height });
    return rects;
  }

  function snapshotItems(snapshot) {
    if (!snapshot) return [];
    // Largest first; the free space is not content, so it closes the list.
    const items = snapshot.blocks.filter(block => block.tokens > 0).sort((a, b) => b.tokens - a.tokens);
    if (snapshot.window) items.push({ id: 'free', kind: 'free', tokens: Math.max(0, snapshot.window - snapshot.used), count: 0 });
    return items;
  }

  function blockFile(block) {
    if (!block || block.merged || (block.kind !== 'file' && block.kind !== 'memory')) return '';
    return block.path || block.label || '';
  }

  function blockName(block) {
    const names = kindNames();
    if (block.kind === 'free') return t('Boş');
    if (block.merged) return globalThis.AIWSI18n.template`Diğer · ${names[block.kind] || block.kind}`;
    return block.label || names[block.kind] || block.kind;
  }
  function blockTag(block) {
    if (block.kind === 'free') return '';
    if (block.merged) return globalThis.AIWSI18n.template`${block.count} kaynak`;
    return block.label ? kindTags()[block.kind] || '' : '';
  }
  function blockTitle(block) {
    const names = kindNames(), tag = blockTag(block);
    return `${blockName(block)} · ${number(block.tokens)} token${tag ? ` · ${tag}` : ''}${block.label ? ` · ${names[block.kind] || block.kind}` : ''}`;
  }

  function frame(host) {
    let view = views.get(host);
    if (view?.root.isConnected) return view;
    host.innerHTML = globalThis.AIWSI18n.template`<section class="context-view"><header class="context-head"><div class="context-heading">${mapIcon}<strong>Bağlam</strong><div class="context-picker"><button type="button" class="context-agent" aria-haspopup="menu" aria-expanded="false"></button><div class="context-agent-menu popup-menu" role="menu" hidden></div></div></div><div class="context-total" aria-live="polite"><span class="context-used">0</span><span class="context-of"> / <span class="context-window">—</span></span><span class="context-chip context-percent" hidden></span></div></header><div class="context-badges" role="group" aria-label="Bağlam bölümleri" hidden></div><div class="context-map" role="list"></div><p class="context-empty" hidden></p><footer class="context-foot"><span class="context-state"></span><span class="context-note" title="Toplam, sağlayıcının son isteğinde bildirdiği token sayısıdır; blokların payı metin uzunluğundan tahmin edilir.">Tahmini dağılım</span></footer></section>`;
    const root = host.firstElementChild, map = root.querySelector('.context-map'), badges = root.querySelector('.context-badges');
    view = { root, map, badges, blocks: new Map(), hidden: new Set(), props: null, size: { width: 0, height: 0 } };
    views.set(host, view);
    const picker = root.querySelector('.context-agent'), menu = root.querySelector('.context-agent-menu');
    const close = (focus = false) => { menu.hidden = true; picker.setAttribute('aria-expanded', 'false'); if (focus) picker.focus(); };
    picker.addEventListener('click', () => {
      if (!menu.hidden) { close(); return; }
      menu.hidden = false; picker.setAttribute('aria-expanded', 'true');
      (menu.querySelector('[aria-checked=true]') || menu.querySelector('[role=menuitemradio]'))?.focus();
    });
    menu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; } menuNavigate(event, menu, [...menu.querySelectorAll('[role=menuitemradio]')]); });
    menu.addEventListener('click', event => { const option = event.target.closest('[data-context-option]'); if (!option) return; close(true); view.props?.onSelect?.(option.dataset.contextOption); });
    badges.addEventListener('click', event => {
      const badge = event.target.closest('[data-context-toggle]'); if (!badge) return;
      const id = badge.dataset.contextToggle;
      if (view.hidden.has(id)) view.hidden.delete(id); else view.hidden.add(id);
      badge.setAttribute('aria-pressed', String(!view.hidden.has(id)));
      if (view.props) draw(view);
    });
    map.addEventListener('click', event => {
      const block = event.target.closest('[data-file-path]');
      if (block && view.props?.onOpenFile) view.props.onOpenFile(block.dataset.filePath);
    });
    map.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const block = event.target.closest('[data-file-path]');
      if (!block || !view.props?.onOpenFile) return;
      event.preventDefault(); view.props.onOpenFile(block.dataset.filePath);
    });
    root.addEventListener('focusout', event => { if (!menu.hidden && !root.querySelector('.context-picker').contains(event.relatedTarget)) close(); });
    // A replaced view releases its document listener on the next press.
    const outside = event => { if (!root.isConnected) { document.removeEventListener('pointerdown', outside); return; } if (!menu.hidden && !root.querySelector('.context-picker').contains(event.target)) close(); };
    document.addEventListener('pointerdown', outside);
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (view.props) draw(view); }).observe(map);
    return view;
  }

  function option(entry, selected) {
    const windowChip = entry.window ? `<span class="context-chip">${esc(tokenCount(entry.window))}</span>` : '';
    return `<button type="button" class="context-agent-option" role="menuitemradio" aria-checked="${entry.id === selected}" data-context-option="${esc(entry.id)}" style="--depth:${entry.depth || 0}">${providerIcon(entry.provider)}<span class="context-agent-text"><span>${esc(entry.name)}</span>${entry.detail ? `<small>${esc(entry.detail)}</small>` : ''}</span>${windowChip}</button>`;
  }

  /** Places, sizes and labels the blocks for the map's current size; blocks no longer in the snapshot fade out. */
  function draw(view) {
    const { snapshot } = view.props, map = view.map, width = map.clientWidth, height = map.clientHeight;
    if (!snapshot || !width || !height) return;
    const rects = layout(snapshot, width, height, view.hidden), seen = new Set(), animate = !reducedMotion();
    for (const rect of rects) {
      const block = rect.block, key = block.id; seen.add(key);
      let element = view.blocks.get(key);
      const fresh = !element || element.classList.contains('is-leaving');
      if (!element) {
        element = document.createElement('div'); element.className = 'context-block'; element.setAttribute('role', 'listitem'); element.dataset.key = key;
        element.innerHTML = '<span class="context-block-name"></span><span class="context-block-size"><span class="context-block-tokens"></span><span class="context-block-tag"></span></span>';
        view.blocks.set(key, element); map.append(element);
      }
      element.classList.remove('is-leaving'); element.dataset.kind = block.kind;
      const file = view.props?.onOpenFile ? blockFile(block) : '';
      if (file) { element.dataset.filePath = file; element.tabIndex = 0; }
      else { delete element.dataset.filePath; element.removeAttribute('tabindex'); }
      const inset = gap / 2, box = { left: rect.x + inset, top: rect.y + inset, width: Math.max(0, rect.w - gap), height: Math.max(0, rect.h - gap) };
      element.style.left = `${box.left / width * 100}%`; element.style.top = `${box.top / height * 100}%`; element.style.width = `${box.width / width * 100}%`; element.style.height = `${box.height / height * 100}%`;
      // Text appears only where it fits: the name alone in a low block, nothing in a sliver.
      element.dataset.fit = box.width < 46 || box.height < 24 ? 'none' : box.height < 46 ? 'name' : 'full';
      const title = block.kind === 'free' ? globalThis.AIWSI18n.template`Boş · ${number(block.tokens)} token` : blockTitle(block);
      element.title = file ? `${title} · ${t('Varsayılan programda aç')}` : title;
      element.querySelector('.context-block-name').textContent = blockName(block);
      const tag = blockTag(block); element.querySelector('.context-block-tag').textContent = tag ? ` · ${tag}` : '';
      countTo(element.querySelector('.context-block-tokens'), block.tokens, tokenCount);
      if (fresh && animate) { element.classList.add('is-entering'); requestAnimationFrame(() => requestAnimationFrame(() => element.classList.remove('is-entering'))); }
    }
    for (const [key, element] of view.blocks) {
      if (seen.has(key) || element.classList.contains('is-leaving')) continue;
      if (!animate) { element.remove(); view.blocks.delete(key); continue; }
      element.classList.add('is-leaving');
      setTimeout(() => { if (element.classList.contains('is-leaving')) { element.remove(); if (view.blocks.get(key) === element) view.blocks.delete(key); } }, leaveMs);
    }
  }

  /**
   * Renders the context map into host. props: { snapshot, agents: [{ id, name, provider, detail, depth, window }], selected,
   * loading, error, live, empty, onSelect(id) }. Calling it again with new props updates the same map.
   */
  function renderBadges(view, snapshot) {
    const items = snapshotItems(snapshot);
    view.badges.hidden = !items.length;
    if (!items.length) { view.badges.innerHTML = ''; delete view.badges.dataset.html; return; }
    const html = items.map(block => {
      const shown = !view.hidden.has(block.id);
      const title = block.kind === 'free' ? globalThis.AIWSI18n.template`Boş · ${number(block.tokens)} token` : blockTitle(block);
      return `<button type="button" class="context-badge" data-context-toggle="${esc(block.id)}" data-kind="${esc(block.kind)}" aria-pressed="${shown}" title="${esc(title)}"><span class="context-badge-dot" aria-hidden="true"></span><span class="context-badge-name">${esc(blockName(block))}</span><span class="context-badge-tokens">${esc(tokenCount(block.tokens))}</span></button>`;
    }).join('');
    if (view.badges.dataset.html !== html) { view.badges.innerHTML = html; view.badges.dataset.html = html; }
  }

  function render(host, props) {
    const view = frame(host), { snapshot, agents = [], selected } = props, root = view.root;
    view.props = props;
    const current = agents.find(entry => entry.id === selected), picker = root.querySelector('.context-agent');
    picker.innerHTML = current ? `${providerIcon(current.provider)}<span class="context-agent-name">${esc(current.name)}</span>${snapshot?.window ? `<span class="context-chip">${esc(tokenCount(snapshot.window))}</span>` : ''}${icon('chevron')}` : `<span class="context-agent-name">${esc(t('Agent seç'))}</span>${icon('chevron')}`;
    picker.disabled = agents.length < 2;
    const menu = root.querySelector('.context-agent-menu'), options = agents.map(entry => option(entry, selected)).join('');
    if (menu.dataset.html !== options) { menu.innerHTML = options; menu.dataset.html = options; }
    const percent = root.querySelector('.context-percent'), share = snapshot?.window ? snapshot.used / snapshot.window : null;
    countTo(root.querySelector('.context-used'), snapshot?.used ?? 0, tokenCount);
    root.querySelector('.context-window').textContent = snapshot?.window ? tokenCount(snapshot.window) : '—';
    percent.hidden = share === null; if (share !== null) { countTo(percent, Math.round(share * 100), value => `${Math.round(value)}%`); percent.dataset.level = share >= 0.9 ? 'full' : share >= 0.7 ? 'high' : ''; }
    const empty = root.querySelector('.context-empty'), message = props.error || (!snapshot ? props.empty || '' : '');
    empty.textContent = message; empty.hidden = !message; view.map.hidden = Boolean(message);
    renderBadges(view, message ? null : snapshot);
    if (message) { for (const element of view.blocks.values()) element.remove(); view.blocks.clear(); }
    const state = root.querySelector('.context-state');
    const updated = snapshot?.updatedAt ? new Date(snapshot.updatedAt).toLocaleTimeString(globalThis.AIWSI18n.locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    const compactions = snapshot?.compactions ? globalThis.AIWSI18n.template` · ${snapshot.compactions} kez sıkıştırıldı` : '';
    state.innerHTML = props.loading && !snapshot ? esc(t('Bağlam okunuyor…')) : props.live ? `<span class="ui-dot is-live" data-tone="running" aria-hidden="true"></span>${esc(t('Canlı'))}${updated ? ` · ${esc(updated)}` : ''}${esc(compactions)}` : `${esc(t('Son okunan durum'))}${updated ? ` · ${esc(updated)}` : ''}${esc(compactions)}`;
    if (!message) draw(view);
  }

  window.AIWSContext = Object.freeze({ render, layout, squarify });
})();
