/* Flow canvas on window.AIWSUI (AI drafts, agent hierarchy): a top-down tree like an org chart. A root's children stand in a row under
 * it, joined by one bus; everything deeper stacks under its parent, indented, on a rail from the parent's bottom edge. An `across`
 * layout (the agent hierarchy) reads left to right instead: every node's children stand in a column to its right. Nodes are
 * absolutely placed from their measured size, so cards keep their natural height. Gaps mirror the flow-list rules in
 * styles/flow-canvas.css. Loaded after ui/icons.js. */
(function (global) {
  'use strict';
  const { reducedMotion } = global.AIWSUI;
  // A connector starts once its nodes are mostly in (linkWait) and takes linkDraw to reach the far port, like .flow-link.is-drawing.
  const linkWait = 380, linkDraw = 720;
  const flowGap = { row: 28, level: 48, indent: 40, stack: 14 }, flowCard = [272, 120];
  /** The tree of items by their parents: a child hangs under its deepest parent (others become dashed extra links), roots are items
   *  without one. Returns `flow:false` without any edge. `arrange(sizeOf)` places every key (and `extra` placeholders after the roots,
   *  keyed `placeholder:0…`) from `sizeOf(key) → [width, height, cardTop]` into `place` and sets the total `width` and `height`. */
  function flowLayout(items, keyOf, parentsOf, extra = 0, across = false) {
    const byKey = new Map(items.map(item => [keyOf(item), item])), depth = new Map(), visiting = new Set();
    const parents = item => [...new Set(parentsOf(item))].filter(key => key !== keyOf(item) && byKey.has(key));
    // A cycle counts the revisited item as a start, so the layout always ends.
    const level = item => { const key = keyOf(item); if (depth.has(key)) return depth.get(key); if (visiting.has(key)) return 0; visiting.add(key); const value = Math.max(-1, ...parents(item).map(parent => level(byKey.get(parent)))) + 1; visiting.delete(key); depth.set(key, value); return value; };
    items.forEach(level);
    const edges = items.flatMap(item => parents(item).filter(key => depth.get(key) < depth.get(keyOf(item))).map(key => [key, keyOf(item)]));
    const layout = { flow: edges.length > 0, across, edges, tree: new Map(), order: items, keys: items.map(keyOf), place: new Map(), width: 0, height: 0, arrange: () => layout };
    if (!layout.flow) return layout;
    const children = new Map(), roots = [], above = new Map();
    for (const [parent, child] of edges) { const list = above.get(child); if (list) list.push(parent); else above.set(child, [parent]); }
    for (const item of items) {
      const key = keyOf(item), parentsAbove = above.get(key);
      if (!parentsAbove) { roots.push(key); continue; }
      const parent = parentsAbove.reduce((best, next) => depth.get(next) > depth.get(best) ? next : best); layout.tree.set(key, parent);
      if (children.has(parent)) children.get(parent).push(key); else children.set(parent, [key]);
    }
    // Depth first from each root, so a subtree stays together and enters in reading order.
    const keys = [], walk = key => { keys.push(key); for (const child of children.get(key) || []) walk(child); };
    roots.forEach(walk); layout.keys = keys; layout.order = keys.map(key => byKey.get(key));
    layout.arrange = sizeOf => {
      const size = new Map(), box = new Map(), place = layout.place; place.clear();
      const sized = key => { if (!size.has(key)) { const [width, height, top = 0] = sizeOf(key) || []; size.set(key, [width || flowCard[0], height || flowCard[1], top]); } return size.get(key); };
      const span = list => list.reduce((sum, key) => sum + box.get(key).width, 0) + flowGap.row * (list.length - 1);
      const measure = (key, row) => {
        const [width, height] = sized(key), list = children.get(key) || []; list.forEach(child => measure(child, false));
        if (!list.length) box.set(key, { width, height });
        else if (row) box.set(key, { width: Math.max(width, span(list)), height: height + flowGap.level + Math.max(...list.map(child => box.get(child).height)) });
        else box.set(key, { width: Math.max(width, flowGap.indent + Math.max(...list.map(child => box.get(child).width))), height: height + list.reduce((sum, child) => sum + flowGap.stack + box.get(child).height, 0) });
      };
      const put = (key, x, y, row) => {
        const [width, height, top] = sized(key), list = children.get(key) || [], outer = box.get(key).width;
        place.set(key, { x: row ? x + (outer - width) / 2 : x, y, width, height, top, row });
        if (row) { let left = x + (outer - span(list)) / 2; for (const child of list) { put(child, left, y + height + flowGap.level, false); left += box.get(child).width + flowGap.row; } }
        else { let below = y + height; for (const child of list) { below += flowGap.stack; put(child, x + flowGap.indent, below, false); below += box.get(child).height; } }
      };
      if (across) {
        // Left to right: a node's children form a column to its right, centred on it; roots stack top to bottom.
        const column = list => list.reduce((sum, key) => sum + box.get(key).height, 0) + flowGap.stack * (list.length - 1);
        const reach = key => { const [width] = sized(key), list = children.get(key) || []; list.forEach(reach); box.set(key, { width: list.length ? width + flowGap.level + Math.max(...list.map(child => box.get(child).width)) : width, height: Math.max(sized(key)[1], column(list)) }); };
        const lay = (key, x, y) => {
          const [width, height] = sized(key), list = children.get(key) || [], outer = box.get(key).height;
          place.set(key, { x, y: y + (outer - height) / 2, width, height, top: 0, row: false, across: true });
          let below = y + (outer - column(list)) / 2; for (const child of list) { lay(child, x + width + flowGap.level, below); below += box.get(child).height + flowGap.stack; }
        };
        let y = 0; for (const root of roots) { reach(root); lay(root, 0, y); y += box.get(root).height + flowGap.row * 2; }
        layout.width = Math.max(0, ...[...place.values()].map(at => at.x + at.width)); layout.height = Math.max(0, ...[...place.values()].map(at => at.y + at.height));
        return layout;
      }
      let x = 0;
      for (const root of roots) { measure(root, true); put(root, x, 0, true); x += box.get(root).width + flowGap.row * 2; }
      for (let index = 0; index < extra; index++) { const key = `placeholder:${index}`, [width, height] = sized(key); place.set(key, { x, y: 0, width, height, top: 0, row: true }); x += width + flowGap.row; }
      layout.width = Math.max(0, ...[...place.values()].map(at => at.x + at.width)); layout.height = Math.max(0, ...[...place.values()].map(at => at.y + at.height));
      return layout;
    };
    return layout;
  }
  /** Entrance delays for the keys `fresh(key)` accepts: a child waits until its connector has mostly grown from its parent, siblings a
   *  beat apart, so the tree builds itself top-down. A new child of a node already shown waits only for its own connector. */
  function flowDelays(layout, fresh, { sibling = 90, limit = 4200 } = {}) {
    const delays = new Map(), count = new Map(), step = linkWait + linkDraw * 0.6;
    for (const key of layout.keys) {
      if (!fresh(key)) continue;
      const parent = layout.tree.get(key), index = count.get(parent) || 0; count.set(parent, index + 1);
      const start = parent === undefined ? 0 : delays.has(parent) ? delays.get(parent) + step : linkDraw * 0.6;
      delays.set(key, Math.min(limit, Math.round(start + index * sibling)));
    }
    return delays;
  }
  /** Measures and places a flow list's nodes (`nodeOf(key)`, its card the node's last child) and sizes the list; a list without edges
   *  becomes a wrapping grid. Returns whether any node moved. */
  function placeFlow(list, layout, nodeOf) {
    if (list.dataset.layout !== (layout.flow ? 'flow' : 'grid')) list.dataset.layout = layout.flow ? 'flow' : 'grid';
    const write = (element, name, value) => { if (element.style.getPropertyValue(name) !== value) { element.style.setProperty(name, value); return true; } return false; };
    if (!layout.flow) { for (const key of layout.keys) { const node = nodeOf(key); if (node) { node.style.removeProperty('left'); node.style.removeProperty('top'); } } list.style.removeProperty('width'); list.style.removeProperty('height'); return false; }
    layout.arrange(key => { const node = nodeOf(key), card = node?.lastElementChild; return node ? [node.offsetWidth, node.offsetHeight, card && card !== node.firstElementChild ? card.offsetTop : 0] : null; });
    let moved = false;
    for (const [key, at] of layout.place) { const node = nodeOf(key); if (node) moved = write(node, 'left', `${at.x}px`) | write(node, 'top', `${at.y}px`) || moved; }
    write(list, 'width', `${layout.width}px`); write(list, 'height', `${layout.height}px`);
    return moved;
  }
  /** The connectors of a placed flow under the cards (the list's first svg) and the hollow ports on parents' bottom edges above them
   *  (its last svg): a bus from a root down to its row of children, a rail with rounded elbows into stacked children, and a dashed curve
   *  for every extra parent. Elements are keyed in `state.links`/`state.ports`, so only a new connector grows in, timed by its nodes'
   *  entrances; `state.settle` glides the existing ones to their new shape with the cards. A node moved by hand keeps the move in its
   *  `translate`, which the connector follows, mid-transition too. */
  function drawFlowLinks(list, layout, nodeOf, state) {
    if (!list || !layout) return;
    const under = list.firstElementChild, over = list.lastElementChild, ns = 'http://www.w3.org/2000/svg', animate = !reducedMotion(), base = state.settle ? 300 : 0, doc = list.ownerDocument, links = new Set(), ports = new Map();
    const round = value => Math.round(value * 10) / 10, boxes = new Map(), easing = list.classList.contains('is-easing');
    // Only a node moved by hand, or one whose move is being eased away, needs its computed translate; the others skip a style recalc.
    const offset = node => node.style.translate || easing ? String(global.getComputedStyle(node).translate || '').split(' ').map(value => parseFloat(value) || 0) : [];
    const box = key => {
      if (boxes.has(key)) return boxes.get(key);
      const at = layout.place.get(key), node = nodeOf(key); if (!at || !node) return null;
      const [dx = 0, dy = 0] = offset(node);
      const value = { ...at, x: at.x + dx, y: at.y + dy, delay: node.classList.contains('ui-enter') ? parseFloat(node.style.getPropertyValue('--enter-delay')) || 0 : -1 };
      boxes.set(key, value); return value;
    };
    if (state.settle && animate) { list.classList.add('is-gliding'); clearTimeout(state.glideTimer); state.glideTimer = setTimeout(() => list.classList.remove('is-gliding'), 340); }
    for (const [from, to] of layout.flow ? layout.edges : []) {
      const a = box(from), b = box(to); if (!a || !b) continue;
      const main = layout.tree.get(to) === from, cx = round(b.x + b.width / 2), top = round(b.y + b.top);
      let d, port;
      if (a.across) {
        // Out of the parent's right edge into the child's left edge; an extra parent's curve leans the same way.
        const px = round(a.x + a.width), py = round(a.y + a.height / 2), tx = round(b.x), ty = round(b.y + b.height / 2), mid = round(px + (tx - px) / 2), radius = Math.max(0, Math.min(8, Math.abs(ty - py) / 2, (tx - px) / 2)), side = Math.sign(ty - py);
        d = !main ? `M${px} ${py}C${round(px + Math.max(36, (tx - px) / 2))} ${py} ${round(tx - Math.max(36, (tx - px) / 2))} ${ty} ${tx} ${ty}` : Math.abs(ty - py) < 1 ? `M${px} ${py}H${tx}` : `M${px} ${py}H${mid - radius}Q${mid} ${py} ${mid} ${py + side * radius}V${ty - side * radius}Q${mid} ${ty} ${mid + radius} ${ty}H${tx}`; port = ['row', px, py];
      } else if (main && a.row) {
        const px = round(a.x + a.width / 2), py = round(a.y + a.height), mid = round(py + (top - py) / 2), radius = Math.max(0, Math.min(8, Math.abs(cx - px) / 2, (top - py) / 2)), side = Math.sign(cx - px);
        d = Math.abs(cx - px) < 1 ? `M${px} ${py}V${top}` : `M${px} ${py}V${mid - radius}Q${px} ${mid} ${px + side * radius} ${mid}H${cx - side * radius}Q${cx} ${mid} ${cx} ${mid + radius}V${top}`; port = ['row', px, py];
      } else if (main) {
        const rx = round(a.x + flowGap.indent / 2), py = round(a.y + a.height), tx = round(b.x), ty = round(top + Math.min((b.height - b.top) / 2, 24)), radius = Math.max(0, Math.min(8, tx - rx, ty - py));
        d = `M${rx} ${py}V${ty - radius}Q${rx} ${ty} ${rx + radius} ${ty}H${tx}`; port = ['rail', rx, py];
      } else {
        const px = round(a.x + a.width / 2), py = round(a.y + a.height), bend = Math.max(36, Math.abs(top - py) / 2);
        d = `M${px} ${py}C${px} ${round(py + bend)} ${cx} ${round(top - bend)} ${cx} ${top}`; port = ['row', px, py];
      }
      const key = `${from}>${to}`, delay = b.delay >= 0 ? Math.max(base, b.delay - linkDraw * 0.6) : a.delay >= 0 ? a.delay + linkWait : base; links.add(key);
      let path = state.links.get(key);
      if (!path) {
        path = doc.createElementNS(ns, 'path'); path.setAttribute('class', main ? 'flow-link' : 'flow-link is-extra'); path.setAttribute('pathLength', '1'); path.dataset.from = from; path.dataset.to = to;
        if (animate) { path.classList.add('is-drawing'); path.style.setProperty('--link-delay', `${delay}ms`); path.addEventListener('animationend', () => path.classList.remove('is-drawing'), { once: true }); }
        under.append(path); state.links.set(key, path);
      }
      if (path.getAttribute('d') !== d) { path.setAttribute('d', d); path.style.setProperty('d', `path("${d}")`); }
      const portKey = `${port[0]}:${from}`; if (!ports.has(portKey) || ports.get(portKey)[2] > delay) ports.set(portKey, [port[1], port[2], delay]);
    }
    for (const [key, path] of state.links) if (!links.has(key)) { path.remove(); state.links.delete(key); }
    for (const [key, [x, y, delay]] of ports) {
      let port = state.ports.get(key);
      if (!port) { port = doc.createElementNS(ns, 'circle'); port.setAttribute('class', 'flow-port'); port.setAttribute('r', '3.5'); if (animate) { port.classList.add('is-new'); port.style.setProperty('--link-delay', `${delay}ms`); } over.append(port); state.ports.set(key, port); }
      const at = `translate(${x}px, ${y}px)`; if (port.style.transform !== at) port.style.transform = at;
    }
    for (const [key, port] of state.ports) if (!ports.has(key)) { port.remove(); state.ports.delete(key); }
    state.settle = false;
  }

  global.AIWSUI = Object.freeze({ ...global.AIWSUI, flowLayout, flowDelays, placeFlow, drawFlowLinks });
})(window);
