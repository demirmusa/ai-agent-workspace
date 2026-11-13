/* Plugin themes: manifest themes and themes.register() override the tokens of styles.css for the dark and/or light mode. */
(function (global) {
  'use strict';
  const kit = global.AIWSPluginKit, host = kit.host, { THEME_KEY, THEME_CACHE_KEY, registry } = kit;
  // ── Themes: manifest themes and themes.register() override the tokens of styles.css for the dark and/or light mode.
  function activeThemeKey() { try { return localStorage.getItem(THEME_KEY) || ''; } catch { return ''; } }
  function themeEntries() { return [...registry.themes.entries()].filter(([, entry]) => entry.plugin.active).map(([themeKey, entry]) => ({ key: themeKey, ...entry })); }
  const tokenBlock = tokens => Object.entries(tokens || {}).map(([name, value]) => `--${String(name).replace(/^--/, '')}:${String(value).replace(/[;{}<>]/g, '')}`).join(';');
  /** Writes the theme's token overrides (and optional stylesheet) into the page and marks <html data-plugin-theme>. */
  function paintTheme(themeKey, css, href) {
    const root = document.documentElement;
    let style = document.getElementById('plugin-theme-style'), link = document.getElementById('plugin-theme-link');
    if (!themeKey) { delete root.dataset.pluginTheme; style?.remove(); link?.remove(); return; }
    if (!style) { style = document.createElement('style'); style.id = 'plugin-theme-style'; document.head.append(style); }
    if (style.textContent !== css) style.textContent = css;
    if (href) { if (!link) { link = document.createElement('link'); link.id = 'plugin-theme-link'; link.rel = 'stylesheet'; document.head.append(link); } if (link.getAttribute('href') !== href) link.setAttribute('href', href); } else link?.remove();
    root.dataset.pluginTheme = themeKey;
  }
  function applyActiveTheme() {
    const themeKey = activeThemeKey(), theme = themeEntries().find(item => item.key === themeKey);
    if (!theme) { paintTheme(''); try { localStorage.removeItem(THEME_CACHE_KEY); } catch { /* Only a startup shortcut. */ } return; }
    const selector = `:root[data-plugin-theme="${themeKey.replace(/"/g, '')}"]`;
    const css = `${theme.def.dark ? `${selector}:not([data-theme=light]){${tokenBlock(theme.def.dark)}}` : ''}${theme.def.light ? `${selector}[data-theme=light]{${tokenBlock(theme.def.light)}}` : ''}`;
    const href = theme.def.css ? `${theme.plugin.info.assetBase}${theme.def.css}` : '';
    paintTheme(themeKey, css, href);
    try { localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ key: themeKey, css, href })); } catch { /* Only a startup shortcut. */ }
  }
  // The last applied theme is painted at once; plugins confirm or remove it after they load.
  try { const cached = JSON.parse(localStorage.getItem(THEME_CACHE_KEY) || 'null'); if (cached?.key && cached.key === activeThemeKey()) paintTheme(cached.key, String(cached.css || ''), kit.pluginAsset(cached.href) ? cached.href : ''); } catch { /* No cached theme. */ }
  function applyTheme(themeKey) {
    try { if (themeKey) localStorage.setItem(THEME_KEY, themeKey); else localStorage.removeItem(THEME_KEY); } catch { /* The choice is only a convenience. */ }
    const root = document.documentElement; root.classList.add('theme-switching'); applyActiveTheme(); void getComputedStyle(root).color; root.classList.remove('theme-switching');
    kit.emit('theme:changed', { theme: themeKey || null, mode: root.dataset.theme });
    if (host.settingsHost?.isConnected) kit.renderSettings(host.settingsHost);
  }
  // The sidebar's dark/light switch changes data-theme; plugins hear it as theme:changed.
  function watchThemeMode() {
    if (typeof MutationObserver === 'function') new MutationObserver(() => kit.emit('theme:changed', { theme: activeThemeKey() || null, mode: document.documentElement.dataset.theme })).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  Object.assign(kit, { activeThemeKey, themeEntries, applyActiveTheme, applyTheme, watchThemeMode });
})(window);
