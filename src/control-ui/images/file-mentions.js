/* Project file paths in text: "@" mentions in description editors search the project files, and a path dragged from the files panel lands at the cursor as one Markdown token. */
(function () {
  'use strict';
  // A path chosen or dropped into a description; paths with spaces or brackets stay one Markdown token.
  const mentionPath = path => /[\s()[\]]/.test(path) ? `\`${path}\`` : path;
  // Typing "@" in a description opens a project file search; the chosen path replaces "@query".
  // Tab on a folder completes "@folder/" and lists what is inside it.
  function fileMentions(cm, { api, projectId }) {
    const text = value => globalThis.AIWSI18n.text(value);
    const escape = window.AIWSUI.esc;
    let active = null, popup = null, items = [], index = 0, query = null, timer = 0, request = 0;
    const keys = {
      Up: () => move(-1), Down: () => move(1), Enter: () => choose(), Tab: () => items[index]?.type === 'directory' ? enter(items[index]) : choose(),
      Esc: () => close(), PageUp: () => move(-8), PageDown: () => move(8),
    };
    function move(step) { if (!items.length) return; index = (index + step + items.length) % items.length; draw(); }
    function open(from) {
      active = from; items = []; index = 0; query = null;
      popup = document.createElement('div'); popup.className = 'file-mention-popup popup-menu'; popup.setAttribute('role', 'listbox');
      popup.setAttribute('aria-label', text('Dosya ara'));
      // Clicking an option must not blur the editor before the choice lands.
      popup.addEventListener('mousedown', event => event.preventDefault());
      popup.addEventListener('click', event => { const option = event.target.closest('[data-mention-index]'); if (option) { index = Number(option.dataset.mentionIndex); choose(); } });
      // A modal <dialog> sits in the top layer, so the popup must live inside it to be visible.
      (cm.getWrapperElement().closest('dialog') || document.body).append(popup);
      cm.addKeyMap(keys);
      // The cursor moves past "@" when the editor operation ends.
      queueMicrotask(update);
    }
    function close() {
      if (!active) return;
      active = null; clearTimeout(timer); request++; cm.removeKeyMap(keys); popup?.remove(); popup = null;
    }
    function place() {
      if (!popup) return;
      const at = cm.cursorCoords({ line: active.line, ch: active.ch }, 'window'), height = popup.offsetHeight, width = popup.offsetWidth;
      const below = at.bottom + 4 + height <= window.innerHeight || at.top - 4 - height < 0;
      popup.style.left = `${Math.max(8, Math.min(at.left, window.innerWidth - width - 8))}px`;
      popup.style.top = `${below ? at.bottom + 4 : at.top - 4 - height}px`;
    }
    function draw(message) {
      if (!popup) return;
      popup.innerHTML = message ? `<div class="file-mention-empty">${escape(message)}</div>` : items.map((item, position) => {
        const folder = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '', slash = item.type === 'directory' ? '/' : '';
        return `<div class="file-mention-option${slash ? ' directory' : ''}" role="option" id="file-mention-${position}" data-mention-index="${position}" aria-selected="${position === index}" title="${escape(item.path + slash)}"><span>${escape(item.name + slash)}</span><small>${escape(folder)}</small></div>`;
      }).join('');
      popup.querySelector('[aria-selected=true]')?.scrollIntoView?.({ block: 'nearest' });
      place();
    }
    function search(value) {
      const project = typeof projectId === 'function' ? projectId() : projectId;
      if (!project) { items = []; draw(text('Dosya aramak için önce proje seç.')); return; }
      const current = ++request;
      if (!items.length) draw(text('Dosyalar aranıyor…'));
      api(`/projects/${encodeURIComponent(project)}/files/search?${new URLSearchParams({ q: value, limit: '50' })}`).then(result => {
        if (current !== request || !active) return;
        items = result.items; index = 0; draw(items.length ? '' : text('Eşleşen dosya yok.'));
      }).catch(error => { if (current === request && active) { items = []; draw(error.message); } });
    }
    function update() {
      if (!active) return;
      const cursor = cm.getCursor();
      if (cm.somethingSelected() || cursor.line !== active.line || cursor.ch <= active.ch || cm.getLine(active.line)[active.ch] !== '@') { close(); return; }
      const value = cm.getRange({ line: active.line, ch: active.ch + 1 }, cursor);
      if (/\s/.test(value)) { close(); return; }
      if (value === query) { place(); return; }
      query = value; clearTimeout(timer); timer = setTimeout(() => search(value), items.length ? 120 : 0);
    }
    function choose() {
      const item = items[index]; if (!item) { close(); return; }
      const from = { line: active.line, ch: active.ch }, to = cm.getCursor();
      close(); cm.replaceRange(`${mentionPath(item.type === 'directory' ? `${item.path}/` : item.path)} `, from, to, '+input'); cm.focus();
    }
    function enter(item) {
      // The search stays open on the folder, so a deep file is reached one level at a time.
      cm.replaceRange(`${item.path}/`, { line: active.line, ch: active.ch + 1 }, cm.getCursor(), '+mention');
    }
    const input = (_, change) => {
      if (active || change.origin !== '+input' || change.text.length !== 1 || change.text[0] !== '@') return;
      const before = change.from.ch ? cm.getLine(change.from.line)[change.from.ch - 1] : '';
      // Only a standalone "@" starts a mention, so e-mail addresses and handles stay plain text.
      if (!before || /[\s([{"'`]/.test(before)) open({ line: change.from.line, ch: change.from.ch });
    };
    const cursorActivity = () => update(), blur = () => close();
    cm.on('change', input); cm.on('cursorActivity', cursorActivity); cm.on('blur', blur); cm.on('scroll', cursorActivity);
    return { dispose() { close(); cm.off('change', input); cm.off('cursorActivity', cursorActivity); cm.off('blur', blur); cm.off('scroll', cursorActivity); } };
  }
  // Drag data type of a project path dragged from the files panel.
  const pathType = 'application/x-aiws-path';
  /** Inserts a project path at the editor cursor as a word of its own. */
  function insertPath(cm, path) {
    const cursor = cm.getCursor(), before = cursor.ch ? cm.getLine(cursor.line)[cursor.ch - 1] : '';
    cm.replaceSelection(`${before && !/\s/.test(before) ? ' ' : ''}${mentionPath(path)} `, 'end', '+input'); cm.focus();
  }
  Object.assign(window.AIWSImages, { fileMentions, mentionPath, insertPath, pathType });
})();
