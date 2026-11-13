/* The file editor of a project's Editor tab: files opened from the explorer, as tabs over one Monaco editor. Monaco does the
 * editing itself (syntax colours, line numbers, find and replace, undo); this file loads it on first use, derives its theme
 * from the AIWS tokens, and reads and saves files through the project files API. A save carries the version that was read,
 * so a file an agent or another program changed meanwhile is never overwritten without asking. */
(function () {
  'use strict';
  const t = value => globalThis.AIWSI18n.text(value);
  const { esc, icon, tabStep } = window.AIWSUI;
  const monacoBase = '/vendor/monaco/vs';
  // Monaco colour → the AIWS token it takes its value from (styles.css). Syntax colours come from Monaco's own light or dark base.
  const themeTokens = {
    'editor.background': '--ground', 'editor.foreground': '--ink', 'editorGutter.background': '--ground', 'editorCursor.foreground': '--ink-strong',
    'editorLineNumber.foreground': '--faint', 'editorLineNumber.activeForeground': '--ink', 'editor.lineHighlightBackground': '--surface', 'editor.lineHighlightBorder': '--surface',
    'editor.selectionBackground': '--terminal-selection', 'editor.inactiveSelectionBackground': '--selection', 'editorIndentGuide.background1': '--line', 'editorIndentGuide.activeBackground1': '--line-strong',
    'editorWidget.background': '--popover', 'editorWidget.foreground': '--ink', 'editorWidget.border': '--line-strong', 'editorHoverWidget.background': '--popover', 'editorHoverWidget.border': '--line-strong',
    'editorSuggestWidget.background': '--popover', 'editorSuggestWidget.border': '--line-strong', 'editorSuggestWidget.selectedBackground': '--raised',
    'input.background': '--input', 'input.foreground': '--ink', 'input.border': '--line-strong', 'inputOption.activeBorder': '--accent', 'focusBorder': '--accent',
    'list.hoverBackground': '--surface-hover', 'list.activeSelectionBackground': '--raised', 'list.activeSelectionForeground': '--ink-strong',
    'menu.background': '--popover', 'menu.foreground': '--ink', 'menu.selectionBackground': '--raised', 'menu.selectionForeground': '--ink-strong', 'menu.border': '--line-strong',
    'scrollbarSlider.background': '--line-strong', 'scrollbarSlider.hoverBackground': '--faint', 'scrollbarSlider.activeBackground': '--muted', 'editorOverviewRuler.border': '--line',
    'editorLink.activeForeground': '--link', 'editorError.foreground': '--tone-failed', 'editorWarning.foreground': '--tone-needs',
  };
  /** A token's colour as the hex Monaco expects; the browser resolves whatever notation the theme wrote it in. */
  function tokenColor(probe, token) {
    probe.style.color = `var(${token})`;
    const match = /^rgba?\(([^)]+)\)$/.exec(getComputedStyle(probe).color || '');
    if (!match) return null;
    const [red, green, blue, alpha = 1] = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if ([red, green, blue, alpha].some(Number.isNaN)) return null;
    const hex = value => Math.round(value).toString(16).padStart(2, '0');
    return `#${hex(red)}${hex(green)}${hex(blue)}${alpha < 1 ? hex(alpha * 255) : ''}`;
  }
  function applyTheme(monaco) {
    const probe = document.createElement('span'), colors = {};
    probe.hidden = true; document.body.append(probe);
    for (const [name, token] of Object.entries(themeTokens)) { const color = tokenColor(probe, token); if (color) colors[name] = color; }
    probe.remove();
    const light = String(getComputedStyle(document.documentElement).colorScheme || '').includes('light');
    monaco.editor.defineTheme('aiws', { base: light ? 'vs' : 'vs-dark', inherit: true, rules: [], colors });
    monaco.editor.setTheme('aiws');
  }
  const loadScript = path => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${monacoBase}/${path}`; script.onload = resolve; script.onerror = () => reject(new Error(t('Editör yüklenemedi.')));
    document.head.append(script);
  });
  let monacoLoading = null;
  /** Monaco, loaded with its own AMD loader the first time a file is opened; later calls share the same promise. */
  function loadMonaco() {
    monacoLoading ??= (async () => {
      if (window.monaco?.editor) return window.monaco;
      // Monaco's own texts (find widget, menus) come from the language file loaded before it; without one they are English.
      if (globalThis.AIWSI18n.language === 'tr') await loadScript('nls/lang/tr.js').catch(() => {});
      await loadScript('loader.js');
      window.require.config({ paths: { vs: monacoBase } });
      await new Promise((resolve, reject) => window.require(['vs/editor/editor.main'], resolve, () => reject(new Error(t('Editör yüklenemedi.')))));
      return window.monaco;
    })().then(monaco => {
      // A file is open on its own, without its project: only its syntax is checked, so imports do not show as errors.
      for (const name of ['typescriptDefaults', 'javascriptDefaults']) monaco.languages.typescript?.[name]?.setDiagnosticsOptions({ noSemanticValidation: true });
      applyTheme(monaco);
      // The theme switch and plugin themes change attributes of the root element.
      if (typeof MutationObserver === 'function') new MutationObserver(() => applyTheme(monaco)).observe(document.documentElement, { attributes: true });
      return monaco;
    });
    monacoLoading.catch(() => { monacoLoading = null; });
    return monacoLoading;
  }
  const megabytes = bytes => `${(bytes / 1048576).toFixed(1)} MB`;

  /**
   * `confirm(title, message, { confirmLabel, danger, alternativeLabel })` asks in the app's dialog and resolves true, 'alternative'
   * or false; `onChange` runs when the set of open files or whether any of them is unsaved changes.
   */
  function createEditor({ projectId, api, toast, error, confirm, onChange }) {
    const element = document.createElement('section');
    element.className = 'file-editor'; element.setAttribute('aria-label', t('Dosya editörü'));
    element.innerHTML = `<header class="file-editor-bar"><div class="file-editor-tabs" role="tablist" aria-label="${esc(t('Açık dosyalar'))}"></div><button type="button" class="button small primary" data-editor-save title="Ctrl+S" disabled>${esc(t('Kaydet'))}</button></header><div class="file-editor-body"><div class="file-editor-host" hidden></div><div class="file-editor-message" hidden></div><div class="file-editor-preview" hidden></div></div>`;
    const tabs = element.querySelector('.file-editor-tabs'), saveButton = element.querySelector('[data-editor-save]'), host = element.querySelector('.file-editor-host'), message = element.querySelector('.file-editor-message'), preview = element.querySelector('.file-editor-preview');
    const url = `/projects/${encodeURIComponent(projectId)}/files`, files = new Map();
    let active = '', monaco = null, editor = null, summary = '0|false';

    const dirty = file => Boolean(file.model) && file.model.getAlternativeVersionId() !== file.savedId;
    const hasUnsaved = () => [...files.values()].some(dirty);
    const read = path => api(`${url}/content?${new URLSearchParams({ path })}`);

    function drawTabs() {
      const focused = tabs.contains(document.activeElement);
      tabs.innerHTML = [...files.values()].map(file => {
        const on = file.path === active, changed = dirty(file); file.shownDirty = changed;
        return `<div class="file-editor-tab${on ? ' active' : ''}"><button type="button" class="file-editor-tab-name" role="tab" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-editor-file="${esc(file.path)}" title="${esc(file.path)}"><span>${esc(file.name)}</span>${changed ? `<span class="ui-dot" data-tone="needs" role="img" aria-label="${esc(t('Kaydedilmemiş değişiklikler'))}"></span>` : ''}</button><button type="button" class="icon-button" data-editor-close="${esc(file.path)}" title="${esc(t('Dosyayı kapat'))}" aria-label="${esc(t('Dosyayı kapat'))}: ${esc(file.name)}">${icon('x')}</button></div>`;
      }).join('');
      if (focused) tabs.querySelector('[aria-selected=true]')?.focus();
      const current = files.get(active);
      saveButton.disabled = !current || !dirty(current) || Boolean(current.saving); saveButton.classList.toggle('is-busy', Boolean(current?.saving));
      const next = `${files.size}|${hasUnsaved()}`;
      if (next !== summary) { summary = next; onChange?.(); }
    }
    /** Shows the active file: its model in the editor, or why there is nothing to edit. */
    function showActive() {
      const file = files.get(active);
      const text = !file ? '' : file.status === 'loading' ? t('Yükleniyor…') : file.status === 'error' ? file.message
        : file.status === 'large' ? `${t('Bu dosya editörde açılamayacak kadar büyük.')} ${megabytes(file.size)} / ${megabytes(file.limit)}`
        : file.status === 'binary' ? t('Bu dosya metin değil; editörde açılamaz.') : '';
      const image = file?.status === 'image';
      message.hidden = !text; host.hidden = !file || Boolean(text) || image; preview.hidden = !image;
      message.innerHTML = text ? `<p>${esc(text)}</p>${['large', 'binary'].includes(file.status) ? `<button type="button" class="button small" data-editor-launch>${esc(t('Varsayılan programla aç'))}</button>` : ''}` : '';
      if (image && preview.dataset.version !== `${file.path}|${file.version}`) {
        preview.dataset.version = `${file.path}|${file.version}`;
        preview.innerHTML = `<img src="${esc(file.image)}" alt="${esc(file.name)}"><span class="file-editor-preview-size">${esc(megabytes(file.size))}</span>`;
      } else if (!image && preview.innerHTML) { preview.replaceChildren(); delete preview.dataset.version; }
      if (!editor) return;
      if (file?.model) { if (editor.getModel() !== file.model) { editor.setModel(file.model); if (file.view) editor.restoreViewState(file.view); } }
      else if (editor.getModel()) editor.setModel(null);
    }
    function select(path, focus = false) {
      const previous = files.get(active);
      if (previous?.model && editor?.getModel() === previous.model) previous.view = editor.saveViewState();
      active = path; drawTabs(); showActive();
      const file = files.get(path);
      if (file) void revalidate(file);
      if (focus && file?.model) editor.focus();
    }
    async function ensureEditor() {
      if (editor) return;
      monaco = await loadMonaco();
      editor ??= monaco.editor.create(host, { model: null, theme: 'aiws', automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, fixedOverflowWidgets: true, fontSize: 13,
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || undefined });
    }
    /** Puts what was read from disk into the file: a model on first load, new text afterwards. */
    function accept(file, result) {
      if (result.unavailable) { file.model?.dispose(); Object.assign(file, { status: result.unavailable, size: result.size, limit: result.limit, model: null }); return; }
      // A picture is shown, not edited; its version lets revalidate pick up a new picture on disk.
      if (result.image) { file.model?.dispose(); Object.assign(file, { status: 'image', image: result.image, size: result.size, version: result.version, model: null }); return; }
      if (file.model) file.model.setValue(result.content);
      else {
        const uri = monaco.Uri.file(result.absolutePath);
        monaco.editor.getModel(uri)?.dispose();
        file.model = monaco.editor.createModel(result.content, undefined, uri);
        file.model.onDidChangeContent(() => { if (dirty(file) !== file.shownDirty) drawTabs(); });
      }
      Object.assign(file, { status: 'ready', version: result.version, savedId: file.model.getAlternativeVersionId() });
    }
    async function load(file) {
      try {
        const result = await read(file.path);
        if (!result.image) await ensureEditor();
        if (files.get(file.path) !== file) return;
        accept(file, result);
      } catch (problem) {
        if (files.get(file.path) !== file) return;
        if (file.model) { error(problem.message); return; }
        Object.assign(file, { status: 'error', message: problem.message });
      }
      drawTabs(); if (file.path === active) showActive();
    }
    /** A file without unsaved changes follows the disk: it is read again when it is shown. */
    async function revalidate(file) {
      if (!['ready', 'image'].includes(file.status) || file.saving || file.checking || dirty(file)) return;
      file.checking = true;
      try {
        const result = await read(file.path);
        if (files.get(file.path) === file && !dirty(file) && !file.saving && result.version !== file.version) { accept(file, result); drawTabs(); if (file.path === active) showActive(); }
      } catch { /* A file that is gone or unreadable keeps its text; saving reports the problem. */ }
      finally { file.checking = false; }
    }
    /** Opens a project-relative file path as a tab; a file that is already open is only selected. */
    async function open(path) {
      if (files.has(path)) { select(path, true); return; }
      const file = { path, name: path.split('/').pop(), status: 'loading', model: null };
      files.set(path, file); select(path);
      await load(file);
      if (file.path === active && file.model) editor.focus();
    }
    /** Saves a file; resolves whether its text is on disk afterwards. */
    async function save(path = active, overwrite = false) {
      const file = files.get(path);
      if (!file?.model || file.saving) return false;
      if (!dirty(file) && !overwrite) return true;
      const savedId = file.model.getAlternativeVersionId();
      file.saving = true; drawTabs();
      try {
        const result = await api(`${url}/content`, 'PUT', { path, content: file.model.getValue(), ...(overwrite ? { overwrite: true } : { version: file.version }) });
        Object.assign(file, { version: result.version, savedId });
        toast(t('Dosya kaydedildi'));
        return true;
      } catch (problem) {
        if (problem.status !== 409) { error(problem.message); return false; }
        file.saving = false;
        const answer = await confirm(t('Dosya diskte değişti'), `${file.name}: ${t('Bu dosya sen düzenlerken başka bir süreç tarafından değiştirildi. Üzerine yazarsan o değişiklikler kaybolur.')}`, { confirmLabel: t('Üzerine yaz'), danger: true, alternativeLabel: t('Diskteki sürümü yükle') });
        if (files.get(path) !== file) return false;
        if (answer === true) return save(path, true);
        if (answer === 'alternative') await load(file);
        return false;
      } finally { file.saving = false; if (files.get(path) === file) drawTabs(); }
    }
    /** Closes a tab; unsaved changes are saved or discarded only after asking. */
    async function close(path) {
      const file = files.get(path);
      if (!file) return;
      if (dirty(file)) {
        select(path);
        const answer = await confirm(t('Değişiklikler kaydedilmedi'), `${file.name}: ${t('Bu dosyadaki değişiklikler kaydedilsin mi?')}`, { confirmLabel: t('Kaydet'), alternativeLabel: t('Kaydetme') });
        if (answer === false || files.get(path) !== file || answer === true && !await save(path)) return;
      }
      if (files.get(path) !== file) return;
      const order = [...files.keys()], index = order.indexOf(path);
      files.delete(path);
      if (editor?.getModel() === file.model) editor.setModel(null);
      file.model?.dispose();
      if (active === path) select(order[index + 1] ?? order[index - 1] ?? '', true); else drawTabs();
    }

    tabs.addEventListener('click', event => {
      const closing = event.target.closest('[data-editor-close]'), tab = event.target.closest('[data-editor-file]');
      if (closing) void close(closing.dataset.editorClose); else if (tab) select(tab.dataset.editorFile, true);
    });
    tabs.addEventListener('auxclick', event => { const tab = event.button === 1 && event.target.closest('.file-editor-tab')?.querySelector('[data-editor-file]'); if (tab) { event.preventDefault(); void close(tab.dataset.editorFile); } });
    tabs.addEventListener('keydown', event => {
      if (!event.target.closest('[data-editor-file]')) return;
      const next = tabStep(event, [...files.keys()], active);
      if (next) { select(next); tabs.querySelector('[aria-selected=true]')?.focus(); }
    });
    saveButton.addEventListener('click', () => void save());
    // Ctrl+S (⌘S) saves from anywhere in the editor; Monaco leaves the key alone.
    element.addEventListener('keydown', event => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's') return;
      event.preventDefault(); event.stopPropagation(); void save();
    });
    message.addEventListener('click', event => {
      if (!event.target.closest('[data-editor-launch]') || !files.has(active)) return;
      void api(`${url}/open`, 'POST', { path: active, action: 'open' }).catch(problem => error(problem.message));
    });

    /** Called when the editor comes back on screen: the active file is checked against the disk. */
    function show() { const file = files.get(active); if (file) void revalidate(file); }
    return { element, open, show, save, close, hasFiles: () => files.size > 0, hasUnsaved };
  }
  Object.assign(window.AIWSFiles, { createEditor });
})();
