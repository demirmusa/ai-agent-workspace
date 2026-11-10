/* Translate only developer-authored literals and static template segments.
 * Template substitutions are deliberately opaque: names, messages, code and
 * provider output must retain their original content and escaping.
 * Security contract: text() and template() never escape anything. template`…`
 * inserts every substitution as is, so a caller building HTML must pass each
 * value through AIWSUI.esc (or an escaping renderer such as the console's
 * Markdown) first; text() is only for literals written in this repository. */
(function (global) {
  'use strict';
  const catalog = global.AIWSTranslationsEn || {};
  let language = 'tr';
  try { if (localStorage.getItem('aiws.language') === 'en') language = 'en'; } catch { /* Storage may be disabled. */ }
  const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keys = Object.keys(catalog);
  const pattern = keys.length ? new RegExp('(?<![\\p{L}\\p{N}_])(?:' + keys.sort((a,b) => b.length-a.length).map(escapePattern).join('|') + ')(?![\\p{L}\\p{N}_])', 'gu') : null;
  const cache = new Map();
  const text = value => {
    const source = String(value);
    if (language !== 'en' || !pattern) return source;
    // Callers also translate built strings (counts, names); the cache is bounded so a long session cannot grow it without end.
    if (!cache.has(source)) { if (cache.size >= 4000) cache.clear(); cache.set(source, source.replace(pattern, match => catalog[match])); }
    return cache.get(source);
  };
  const templateCache = new WeakMap();
  const template = (parts, ...values) => {
    if (!templateCache.has(parts)) templateCache.set(parts, parts.map(text));
    return templateCache.get(parts).reduce((result, part, index) => result + part + (index < values.length ? String(values[index]) : ''), '');
  };
  // Called once, before the application renders any user or provider content.
  function localizeShell() {
    document.documentElement.lang = language;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) if (!node.parentElement?.closest('script,style')) node.textContent = text(node.textContent);
    for (const element of document.body.querySelectorAll('*')) {
      for (const attribute of ['title','aria-label','placeholder','alt']) {
        if (element.hasAttribute(attribute)) element.setAttribute(attribute, text(element.getAttribute(attribute)));
      }
    }
    // The selector lives on the settings page, which renders after the shell.
    document.addEventListener('change', event => {
      const select = event.target;
      if (select?.id !== 'language-select') return;
      const next = select.value;
      if (!['tr','en'].includes(next) || next === language) return;
      try { localStorage.setItem('aiws.language', next); } catch {
        select.value = language;
        return;
      }
      // A full reload also refreshes constant labels and third-party editors.
      // The control server owns active runs and terminals, so they keep running.
      global.location.reload();
    });
  }
  global.AIWSI18n = Object.freeze({ language, locale: language === 'en' ? 'en-US' : 'tr-TR', text, template });
  localizeShell();
})(window);
