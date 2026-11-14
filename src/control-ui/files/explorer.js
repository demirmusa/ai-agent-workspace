/* Project explorer: a VS Code style folder tree, shown as a panel on the right. A click (or Enter) on a file opens it in the project's
 * editor through `onOpen`; "New file" shows a name box inside the selected folder, VS Code style, and creates it through `onCreateFile(folder, name)`; the context menu copies paths or hands them to the OS, and a dragged row drops its project-relative path into a
 * task description or its absolute path into a terminal. */
(function () {
  'use strict';
  const t = value => globalThis.AIWSI18n.text(value);
  const { esc, copyText, icon, motion } = window.AIWSUI, { showMenu, closeMenu, revealLabel, absolutePathType, folderIcon, fileIcon, changeIndex, changeBadge, changeDot } = window.AIWSFiles;
  const chevron = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // Header actions on the same 16-unit outline grid as AIWSUI.icon: reload, and a folded box for "collapse all".
  const headerIcon = path => `<svg class="ui-icon" width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const newFileIcon = headerIcon('<path d="M9 1.75H3.75v12.5h8.5V5z"/><path d="M9 1.75V5h3.25"/><path d="M8 7.5v4.5M5.75 9.75h4.5"/>');
  const refreshIcon = headerIcon('<path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71"/><path d="M13.5 2.5v2.75h-2.75"/>'), collapseIcon = headerIcon('<rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2.5"/><path d="M5.5 8h5"/>');
  // A folder's chevron turns over this long; a redraw during the turn continues it instead of jumping (styles/file-tree.css, .file-twisty.turning).
  const turnMs = 180;
  function create({ projectId, api, toast, onClose, onOpen, onCreateFile }) {
    const element = document.createElement('section');
    element.className = 'project-files'; element.setAttribute('aria-label', t('Proje dosyaları'));
    element.innerHTML = `<header class="project-files-header"><span class="project-files-title" title=""></span><div class="project-files-actions">${onCreateFile ? `<button type="button" class="icon-button" data-files-new title="${esc(t('Yeni dosya'))}" aria-label="${esc(t('Yeni dosya'))}">${newFileIcon}</button>` : ''}<button type="button" class="icon-button" data-files-refresh title="${esc(t('Yenile'))}" aria-label="${esc(t('Dosyaları yenile'))}">${refreshIcon}</button><button type="button" class="icon-button" data-files-collapse title="${esc(t('Tüm klasörleri daralt'))}" aria-label="${esc(t('Tüm klasörleri daralt'))}">${collapseIcon}</button>${onClose ? `<button type="button" class="icon-button" data-files-close title="${esc(t('Dosyaları kapat'))}" aria-label="${esc(t('Dosyaları kapat'))}">${icon('x')}</button>` : ''}</div></header><div class="project-files-tree" role="tree" aria-label="${esc(t('Proje dosyaları'))}"></div><p class="project-files-hint">${esc(t('Bir dosyayı görev açıklamasına, terminale veya bir kartın üstüne sürükleyip bırak.'))}</p>`;
    const tree = element.querySelector('.project-files-tree'), title = element.querySelector('.project-files-title');
    const folders = new Map(); const expanded = new Set(['']);
    let root = '', selected = '', loaded = false, turned = { path: null, at: 0 }, changes = changeIndex([]);
    // The name box of a file being created: { folder, row, input, error, busy }. The same element is put back on every redraw, so typing is kept.
    let pending = null, placing = false;

    async function loadChanges() {
      try { changes = changeIndex((await api(`/projects/${encodeURIComponent(projectId)}/git/changes`)).files); }
      catch { changes = changeIndex([]);
    // The name box of a file being created: { folder, row, input, error, busy }. The same element is put back on every redraw, so typing is kept.
    let pending = null, placing = false; }
      draw();
    }

    async function load(path, force = false) {
      const current = folders.get(path);
      if (current?.loading || current?.items && !force) return;
      folders.set(path, { ...(current || {}), loading: true, error: '' }); draw();
      try {
        const result = await api(`/projects/${encodeURIComponent(projectId)}/files?${new URLSearchParams({ path })}`);
        if (!path) { root = result.root; loaded = true; }
        folders.set(path, { items: result.items, truncated: result.truncated, loading: false, error: '' });
      } catch (error) { folders.set(path, { ...(folders.get(path) || {}), loading: false, error: error.message }); }
      draw();
    }
    function rows() {
      const list = [];
      const visit = (path, depth) => {
        const folder = folders.get(path);
        if (!folder) return;
        if (folder.error && !folder.items) { list.push({ kind: 'message', depth, text: folder.error, error: true }); return; }
        if (!folder.items) { list.push({ kind: 'message', depth, text: t('Yükleniyor…') }); return; }
        const adding = pending?.folder === path;
        if (!folder.items.length && path && !adding) list.push({ kind: 'message', depth, text: t('Boş klasör') });
        // Like VS Code, the name box sits after the subfolders, where the new file will be listed.
        let boxed = !adding;
        for (const item of folder.items) {
          if (!boxed && item.type !== 'directory') { list.push({ kind: 'input', depth }); boxed = true; }
          list.push({ kind: 'item', depth, item });
          if (item.type === 'directory' && expanded.has(item.path)) visit(item.path, depth + 1);
        }
        if (!boxed) list.push({ kind: 'input', depth });
        if (folder.truncated) list.push({ kind: 'message', depth, text: t('İlk 5000 öğe gösteriliyor') });
      };
      visit('', 0);
      return list;
    }
    function draw() {
      const typing = Boolean(pending) && document.activeElement === pending.input, focused = !typing && element.contains(document.activeElement);
      const name = root ? root.split(/[\\/]/).filter(Boolean).pop() || root : '';
      title.textContent = name; title.title = root;
      const list = rows(), turning = performance.now() - turned.at < turnMs ? turned.path : null, turnDelay = Math.round(turned.at - performance.now());
      if (!selected || !list.some(row => row.item?.path === selected)) selected = list.find(row => row.item)?.item.path || '';
      placing = true;
      tree.innerHTML = list.map(row => {
        const indent = `style="--depth:${row.depth}"`;
        if (row.kind === 'input') { pending.row.style.setProperty('--depth', String(row.depth)); return '<div data-file-input-slot></div>'; }
        if (row.kind === 'message') return `<div class="file-row file-message${row.error ? ' error' : ''}" role="none" ${indent}>${esc(row.text)}</div>`;
        const item = row.item, directory = item.type === 'directory', change = directory ? changes.folders.get(item.path) : changes.paths.get(item.path), open = directory && expanded.has(item.path), turn = directory && item.path === turning;
        return `<div class="file-row${item.ignored ? ' ignored' : ''}${change ? ' changed' : ''}${item.path === selected ? ' selected' : ''}"${change ? ` data-change="${esc(change)}"` : ''} role="treeitem" ${indent} tabindex="${item.path === selected ? 0 : -1}" aria-level="${row.depth + 1}" aria-selected="${item.path === selected}"${directory ? ` aria-expanded="${open}"` : ''} draggable="true" data-file-path="${esc(item.path)}" data-file-type="${esc(item.type)}" title="${esc(item.absolutePath)}"><span class="file-twisty${directory ? '' : ' leaf'}${open ? ' open' : ''}${turn ? ' turning' : ''}"${turn ? ` style="--turn-delay:${turnDelay}ms"` : ''}>${directory ? chevron : ''}</span><span class="file-icon ${directory ? 'folder' : 'file'}">${directory ? folderIcon(open) : fileIcon}</span><span class="file-name">${esc(item.name)}</span>${directory ? (changes.folders.has(item.path) ? changeDot(changes.folders.get(item.path)) : '') : changes.paths.has(item.path) ? changeBadge(changes.paths.get(item.path)) : ''}</div>`;
      }).join('') || `<div class="file-row file-message" role="none">${esc(t('Bu klasör boş.'))}</div>`;
      // Rows that just appeared (an opened folder's children) fade in; rows already on screen stay still.
      motion.enter(tree, '[role=treeitem]', 'data-file-path', { stagger: 14, max: 12, className: 'ui-enter-fade' });
      const slot = tree.querySelector('[data-file-input-slot]');
      const boxFocus = Boolean(slot) && (typing || pending.focus);
      if (slot) slot.replaceWith(pending.row);
      placing = false;
      if (boxFocus) { pending.focus = false; pending.input.focus(); pending.row.scrollIntoView?.({ block: 'nearest' }); }
      else if (focused && selected) tree.querySelector(`[data-file-path="${CSS.escape(selected)}"]`)?.focus();
    }
    const entryOf = row => {
      const path = row.dataset.filePath, parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      return folders.get(parent)?.items?.find(item => item.path === path);
    };
    function select(row, focus = true) {
      selected = row.dataset.filePath;
      for (const other of tree.querySelectorAll('[role=treeitem]')) { const active = other === row; other.classList.toggle('selected', active); other.tabIndex = active ? 0 : -1; other.setAttribute('aria-selected', String(active)); }
      if (focus) row.focus();
    }
    function toggle(path, open = !expanded.has(path)) {
      if (open === expanded.has(path)) return;
      turned = { path, at: performance.now() };
      if (open) { expanded.add(path); void load(path); } else expanded.delete(path);
      draw();
    }
    /** The folder a new file goes into: the folder itself, or the folder that holds the file. */
    const folderOf = item => !item ? '' : item.type === 'directory' ? item.path : item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
    const selectedItem = () => { const row = selected && tree.querySelector(`[data-file-path="${CSS.escape(selected)}"]`); return row ? entryOf(row) : undefined; };
    /** Shows a file that was just created: its folders open, the file selected. */
    async function reveal(path) {
      const parts = path.split('/');
      for (let depth = 1; depth < parts.length; depth++) expanded.add(parts.slice(0, depth).join('/'));
      await Promise.all([...expanded].map(folder => load(folder, true)));
      // Selected once its folder is listed: a draw while it loads would select another row.
      selected = path; draw();
      void loadChanges();
    }
    /** "New file": a name box inside `folder` (opened if collapsed); Enter creates the file, Escape cancels, leaving the box creates a named file. */
    function startNewFile(folder) {
      if (pending) cancelNewFile();
      const row = document.createElement('div');
      row.className = 'file-row file-new';
      row.innerHTML = `<span class="file-twisty leaf"></span><span class="file-icon file">${fileIcon}</span><input class="file-new-input" type="text" maxlength="255" spellcheck="false" autocomplete="off" aria-label="${esc(t('Dosya adı'))}"><div class="file-new-error" role="alert" hidden></div>`;
      const p = pending = { folder, row, input: row.querySelector('input'), error: row.querySelector('.file-new-error'), busy: false, focus: true };
      p.input.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Enter') { event.preventDefault(); void commitNewFile(p, false); }
        else if (event.key === 'Escape') { event.preventDefault(); cancelNewFile(true); }
      });
      p.input.addEventListener('input', () => { p.error.hidden = true; row.classList.remove('invalid'); });
      p.input.addEventListener('blur', () => { if (!placing && pending === p && !p.busy) { if (p.input.value.trim()) void commitNewFile(p, true); else cancelNewFile(); } });
      for (let end = folder.indexOf('/'); end > 0; end = folder.indexOf('/', end + 1)) expanded.add(folder.slice(0, end));
      // The box takes the focus once it is on screen, which waits for a collapsed folder to load.
      if (folder && !expanded.has(folder)) toggle(folder, true); else draw();
    }
    function cancelNewFile(refocus = false) {
      pending = null; draw();
      if (refocus && selected) tree.querySelector(`[data-file-path="${CSS.escape(selected)}"]`)?.focus();
    }
    /** Creates the named file, shows it in its folder and opens it; a refused name stays in the box with the reason (on blur it is dropped). */
    async function commitNewFile(p, leaving) {
      const name = p.input.value.trim();
      if (!name) { cancelNewFile(true); return; }
      p.busy = true; p.input.readOnly = true;
      try {
        const path = await onCreateFile(p.folder, name);
        if (pending === p) pending = null;
        await reveal(path);
        onOpen?.(path);
      } catch (error) {
        p.busy = false; p.input.readOnly = false;
        if (pending !== p) return;
        if (leaving) { toast(error.message); cancelNewFile(); return; }
        p.error.textContent = error.message; p.error.hidden = false; p.row.classList.add('invalid'); p.input.focus();
      }
    }
    async function launch(item, action) {
      try { await api(`/projects/${encodeURIComponent(projectId)}/files/open`, 'POST', { path: item.path, action }); }
      catch (error) { toast(error.message); }
    }
    async function copy(value) { toast(await copyText(value) ? t('Yol kopyalandı') : t('Kopyalanamadı')); }
    function openMenu(row, x, y) {
      const item = entryOf(row); if (!item) return;
      select(row, false);
      const directory = item.type === 'directory';
      showMenu(x, y, [
        directory ? { label: revealLabel(), run: () => launch(item, 'reveal') } : { label: t('Varsayılan programla aç'), run: () => launch(item, 'open') },
        ...(directory ? [] : [{ label: revealLabel(), run: () => launch(item, 'reveal') }]),
        ...(onCreateFile ? [{ label: t('Yeni dosya…'), run: () => startNewFile(folderOf(item)) }] : []),
        { label: t('Yolu kopyala'), run: () => copy(item.absolutePath) },
        { label: t('Göreli yolu kopyala'), run: () => copy(item.path) },
      ], row);
    }

    tree.addEventListener('click', event => {
      const row = event.target.closest('[role=treeitem]'); if (!row) return;
      select(row);
      // A single click expands folders and opens files, like VS Code.
      if (row.dataset.fileType === 'directory') toggle(row.dataset.filePath); else onOpen?.(row.dataset.filePath);
    });
    // A repeated press would otherwise select the word under the pointer.
    tree.addEventListener('mousedown', event => { if (event.detail > 1) event.preventDefault(); });
    tree.addEventListener('dragstart', event => {
      const row = event.target.closest('[role=treeitem]'); if (!row || !event.dataTransfer) return;
      const images = window.AIWSImages, path = row.dataset.filePath + (row.dataset.fileType === 'directory' ? '/' : '');
      select(row, false); closeMenu();
      // Plain text lets any input take the path; the custom type marks it for description editors.
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('text/plain', images?.mentionPath ? images.mentionPath(path) : path);
      if (images?.pathType) event.dataTransfer.setData(images.pathType, path);
      // Terminals take the absolute path, so it works whatever the shell's working directory is.
      const absolute = entryOf(row)?.absolutePath;
      if (absolute) event.dataTransfer.setData(absolutePathType, absolute);
      document.body.classList.add('dragging-project-path');
    });
    tree.addEventListener('dragend', () => document.body.classList.remove('dragging-project-path'));
    tree.addEventListener('contextmenu', event => {
      const row = event.target.closest('[role=treeitem]'); if (!row) return;
      event.preventDefault(); openMenu(row, event.clientX, event.clientY);
    });
    tree.addEventListener('keydown', event => {
      const row = event.target.closest('[role=treeitem]'); if (!row) return;
      const items = [...tree.querySelectorAll('[role=treeitem]')], index = items.indexOf(row), path = row.dataset.filePath, directory = row.dataset.fileType === 'directory';
      const move = next => { if (items[next]) { event.preventDefault(); select(items[next]); } };
      if (event.key === 'ArrowDown') move(index + 1);
      else if (event.key === 'ArrowUp') move(index - 1);
      else if (event.key === 'Home') move(0);
      else if (event.key === 'End') move(items.length - 1);
      else if (event.key === 'ArrowRight') { event.preventDefault(); if (directory && !expanded.has(path)) toggle(path, true); else if (directory) move(index + 1); }
      else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (directory && expanded.has(path)) toggle(path, false);
        else if (path.includes('/')) { const parent = tree.querySelector(`[data-file-path="${CSS.escape(path.slice(0, path.lastIndexOf('/')))}"]`); if (parent) select(parent); }
      } else if ((event.key === 'Enter' || event.key === ' ') && directory) { event.preventDefault(); toggle(path); }
      else if (event.key === 'Enter') { event.preventDefault(); onOpen?.(path); }
      else if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
        event.preventDefault(); const box = row.getBoundingClientRect(); openMenu(row, box.left + 24, box.bottom);
      }
    });
    element.querySelector('[data-files-new]')?.addEventListener('click', () => startNewFile(folderOf(selectedItem())));
    element.querySelector('[data-files-refresh]').addEventListener('click', () => refresh());
    element.querySelector('[data-files-collapse]').addEventListener('click', () => { expanded.clear(); expanded.add(''); draw(); });
    element.querySelector('[data-files-close]')?.addEventListener('click', () => onClose());

    /** Reloads every open folder; collapsed folders are dropped so they load fresh when reopened. */
    function refresh() {
      for (const path of [...folders.keys()]) if (!expanded.has(path)) folders.delete(path);
      for (const path of expanded) void load(path, true);
      void loadChanges();
    }
    function show() { if (!loaded) { void load(''); void loadChanges(); } else refresh(); }
    return { element, show, refresh, reveal, refreshChanges: loadChanges };
  }
  Object.assign(window.AIWSFiles, { create });
})();
