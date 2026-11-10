/* The small context menu of file rows (copy paths, open or reveal), a popup-menu at a viewport point with keyboard navigation.
 * Creates window.AIWSFiles; files/changes.js and files/explorer.js extend it. */
(function () {
  'use strict';
  const { esc, menuNavigate } = window.AIWSUI;
  let menu = null;
  function closeMenu() {
    if (!menu) return;
    const { element, restore } = menu; menu = null; element.remove();
    document.removeEventListener('pointerdown', outside, true); window.removeEventListener('blur', closeMenu); window.removeEventListener('resize', closeMenu);
    document.removeEventListener('scroll', closeMenu, true);
    restore?.focus?.();
  }
  function outside(event) { if (menu && !menu.element.contains(event.target)) closeMenu(); }
  /** Shows a small context menu at a viewport point; each item is { label, run }. */
  function showMenu(x, y, items, restore) {
    closeMenu();
    const element = document.createElement('div');
    element.className = 'file-context-menu popup-menu'; element.setAttribute('role', 'menu');
    element.innerHTML = items.map((item, index) => `<button type="button" role="menuitem" tabindex="-1" data-menu-index="${index}">${esc(item.label)}</button>`).join('');
    // Inside an open dialog the rest of the page is inert, so the menu joins the dialog.
    (restore?.closest?.('dialog[open]') || document.body).append(element);
    const width = element.offsetWidth, height = element.offsetHeight;
    element.style.left = `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`;
    element.style.top = `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`;
    menu = { element, restore };
    element.addEventListener('click', event => {
      const button = event.target.closest('[data-menu-index]'); if (!button) return;
      const item = items[Number(button.dataset.menuIndex)]; closeMenu(); void item.run();
    });
    element.addEventListener('keydown', event => {
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); closeMenu(); return; }
      menuNavigate(event, element);
    });
    document.addEventListener('pointerdown', outside, true); window.addEventListener('blur', closeMenu); window.addEventListener('resize', closeMenu);
    document.addEventListener('scroll', closeMenu, true);
    element.querySelector('button')?.focus();
  }
  // Drag data type of an absolute path dragged from the files panel; terminals type it at the cursor.
  const absolutePathType = 'application/x-aiws-absolute-path';
  // File and folder glyphs on a 16-unit grid, shared by the explorer and the changes list.
  const folderIcon = open => `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="${open ? 'M1.5 4.5v8h11l2-5.5H4.5l-2 5.5' : 'M1.5 3.5h4.5l1.5 1.5h7v7.5h-13z'}" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>${open ? '<path d="M1.5 4.5v-1h4.5l1.5 1.5h5v2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' : ''}</svg>`;
  const fileIcon = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  /** The platform's name for showing a path in its file manager. */
  const revealLabel = () => globalThis.AIWSI18n.text(/Mac/i.test(navigator.platform || '') ? 'Finder\'da göster' : 'Dosya Gezgini\'nde göster');
  window.AIWSFiles = { showMenu, closeMenu, revealLabel, absolutePathType, folderIcon, fileIcon };
})();
