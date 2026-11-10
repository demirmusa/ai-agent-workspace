/* Agent console parts share one internal namespace, window.AIWSConversationKit, filled in load order by the conversation/*.js
 * scripts; conversation/console.js publishes the public AIWSAgentConsole API from it. This file holds the small text and timing
 * helpers every part uses. */
(function (global) {
  'use strict';
  const kit = global.AIWSConversationKit = {};
  kit.esc = value => global.AIWSUI.esc(value ?? '');
  kit.t = value => global.AIWSI18n.text(value);
  /** A short stable FNV-1a hash of any text, for keys of nodes that carry no id. */
  kit.hash = value => { let n = 2166136261; for (const c of String(value)) n = Math.imul(n ^ c.charCodeAt(0), 16777619); return (n >>> 0).toString(36); };
  /** Provider message content (a string, an array of parts or an object) as plain text. */
  kit.textOf = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => typeof part === 'string' ? part : part?.text || part?.content || '').join('\n') : value ? JSON.stringify(value, null, 2) : '';
  const clockFormat = new Intl.DateTimeFormat(global.AIWSI18n.locale, { hour: '2-digit', minute: '2-digit' });
  kit.clock = value => value && !Number.isNaN(Date.parse(value)) ? clockFormat.format(new Date(value)) : '';
  /* Loading notices flip on every poll; show one only after `delay` ms of real loading
   * and keep it at least `min` ms so it reads as a status instead of a flicker. */
  kit.holdFlag = function holdFlag(onChange, delay = 450, min = 1200) {
    let wanted = false, shown = false, since = 0, timer = null;
    const later = (ms, fn) => { clearTimeout(timer); timer = setTimeout(() => { timer = null; fn(); }, ms); };
    return Object.assign(active => {
      wanted = Boolean(active);
      if (wanted && !shown) { if (!timer) later(delay, () => { if (wanted) { shown = true; since = Date.now(); onChange(); } }); }
      else if (wanted) { clearTimeout(timer); timer = null; }
      else if (!shown) { clearTimeout(timer); timer = null; }
      else if (!timer) { const rest = min - (Date.now() - since); if (rest <= 0) shown = false; else later(rest, () => { if (!wanted) { shown = false; onChange(); } }); }
      return shown;
    }, { cancel() { clearTimeout(timer); timer = null; } });
  };
  /** Writes an attribute (null removes it) only when it changes. */
  kit.setAttr = (element, name, value) => { if (value === null) { if (element.hasAttribute(name)) element.removeAttribute(name); } else if (element.getAttribute(name) !== value) element.setAttribute(name, value); };
  /** Writes a custom property (null removes it) only when it changes. */
  kit.setProp = (element, name, value) => { if (value === null) element.style.removeProperty(name); else if (element.style.getPropertyValue(name) !== String(value)) element.style.setProperty(name, String(value)); };
  /** One staggered entrance for an element that just appeared; the class leaves when its own animation ends, so moving it later never replays it. */
  kit.enterOnce = (element, delay = 0) => global.AIWSUI.motion.once(element, delay);
})(globalThis);
