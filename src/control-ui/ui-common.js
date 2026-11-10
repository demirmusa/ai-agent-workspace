/* Small helpers every control center script shares: HTML escaping, clipboard copy, popup menu and tab keyboard navigation, task
 * titles, token counts and the floating console hand-off. Loaded right after i18n.js; ui/icons.js, ui/motion.js, ui/flow.js and
 * ui/pan-zoom.js extend window.AIWSUI right after it, before every other UI script. */
(function (global) {
  'use strict';
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  /** Escapes text for HTML content and attribute values. */
  const esc = (value = '') => String(value).replace(/[&<>"']/g, char => entities[char]);
  /** Copies text to the clipboard, falling back to a hidden textarea where the Clipboard API is refused; resolves whether it worked. */
  async function copyText(value) {
    try { await Promise.race([navigator.clipboard.writeText(value), new Promise((_, reject) => setTimeout(reject, 1500))]); return true; }
    catch {
      const area = document.createElement('textarea'); area.value = value; area.setAttribute('readonly', ''); area.className = 'sr-only';
      const focused = document.activeElement; document.body.append(area); area.focus(); area.select();
      let copied = false; try { copied = document.execCommand('copy'); } catch { copied = false; }
      area.remove(); focused?.focus?.(); return copied;
    }
  }
  /** Arrow keys, Home and End move focus between a popup menu's enabled items; returns whether the key was handled. */
  function menuNavigate(event, menu, items = [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')]) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return false;
    event.preventDefault();
    if (!items.length) return true;
    const index = items.indexOf(document.activeElement);
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    return true;
  }
  /** A token count in short form: 950, 41.5K, 1.2M. */
  const tokenCount = value => value >= 1e6 ? `${(value / 1e6).toFixed(1).replace(/\.0$/, '')}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1).replace(/\.0$/, '')}K` : String(Math.round(value));
  /** Arrow, Home and End keys over a tab list: the id to select next, or null for any other key. */
  function tabStep(event, ids, current) {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return null;
    event.preventDefault();
    const index = ids.indexOf(current);
    return ids[event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + ids.length) % ids.length];
  }
  /** A number in the interface locale; one formatter serves every call (Number#toLocaleString builds one each time). */
  const numberFormat = new Intl.NumberFormat(global.AIWSI18n?.locale);
  const number = value => numberFormat.format(value);
  /** Title shown for a task; an empty title falls back to the first 50 characters of its description. Descriptions are
   * cleaned once each: boards ask for the same titles on every render. */
  const descriptionTitles = new Map();
  function taskTitle(task) {
    if (task.title) return task.title;
    const description = String(task.description || ''), cached = descriptionTitles.get(description);
    if (cached !== undefined) return cached;
    if (descriptionTitles.size > 2000) descriptionTitles.clear();
    const title = descriptionTitle(description); descriptionTitles.set(description, title); return title;
  }
  function descriptionTitle(description) { const flat = description.replace(/!?\[[^\]]*\]\([^)]*\)|\/api\/attachments\/\S*|[A-Za-z]:[\\/]\S+\.(?:png|jpe?g|gif|webp|bmp|svg|pdf|zip|txt|md|json|log)\b/gi, ' ').replace(/\s+/g, ' ').trim(); return flat.length > 50 ? `${flat.slice(0, 50)}...` : flat; }

  // The app shell owns floating windows; consoles hand themselves over through these without knowing the shell.
  let floatingConsoleHandlers = {};
  const configureFloatingConsole = handlers => { floatingConsoleHandlers = handlers; };
  const floatConsole = (element, title) => floatingConsoleHandlers.open?.(element, title);
  const closeFloatingConsole = element => floatingConsoleHandlers.close?.(element);

  global.AIWSUI = Object.freeze({ configureFloatingConsole, floatConsole, closeFloatingConsole, esc, taskTitle, copyText, menuNavigate, tabStep, tokenCount, number });
})(window);
