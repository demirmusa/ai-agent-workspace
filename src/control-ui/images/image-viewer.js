/* Clicking a loaded attachment opens it full size in the shared modal with wheel zoom and drag panning; the app shell (app/*) supplies showModal. */
(function () {
  'use strict';
  let openModal = null;
  const viewable = 'img.cv-image, .description-images img, .editor-preview img';
  function view(source, alt) {
    const text = value => globalThis.AIWSI18n.text(value), escape = window.AIWSUI.esc;
    openModal(alt || text('Görsel'), `<div class="image-viewer"><div class="image-viewer-stage"><img src="${escape(source)}" alt="${escape(alt || '')}" draggable="false"></div><div class="modal-footer"><span class="form-hint">${escape(text('Tekerlekle yakınlaştır, sürükleyerek gez, çift tıklayarak sığdır.'))}</span><div class="image-viewer-tools"><button type="button" class="button small ghost" data-zoom="out" aria-label="${escape(text('Uzaklaştır'))}">−</button><button type="button" class="button small ghost" data-zoom="fit" aria-label="${escape(text('Sığdır'))}">100%</button><button type="button" class="button small ghost" data-zoom="in" aria-label="${escape(text('Yakınlaştır'))}">+</button></div></div></div>`, undefined, { size: 'full', className: 'image-viewer-modal' });
    const root = document.querySelector('#modal .image-viewer'), stage = root.querySelector('.image-viewer-stage'), img = stage.querySelector('img'), label = root.querySelector('[data-zoom=fit]');
    const center = event => { const box = stage.getBoundingClientRect(); return [event.clientX - box.left - box.width / 2, event.clientY - box.top - box.height / 2]; };
    const view = window.AIWSUI.panZoom(stage, { point: center, apply: ({ x, y, scale }) => { img.style.transform = `translate(${x}px,${y}px) scale(${scale})`; label.textContent = `${Math.round(scale * 100)}%`; stage.classList.toggle('zoomed', scale > 1); } });
    const fit = () => view.set({ x: 0, y: 0, scale: 1 });
    stage.addEventListener('dblclick', fit);
    // The listener lives on the viewer itself: #modal is reused by every dialog and would collect one per opened image.
    root.addEventListener('click', event => {
      const action = event.target.closest('[data-zoom]')?.dataset.zoom; if (!action) return;
      if (action === 'fit') fit(); else view.zoom(action === 'in' ? 1.5 : 1 / 1.5);
    });
    fit();
  }
  document.addEventListener('click', event => {
    const img = event.target.closest?.(viewable);
    if (!img || !openModal || !img.src.startsWith('blob:') || event.target.closest('#modal')) return;
    view(img.src, img.alt);
  });
  /** Shows thumbnails of pasted images in `container`; clicking one opens it full size. Replaces the container's previous strip and returns its remover. */
  function pastePreview(container, files) {
    container.querySelector(':scope > .image-paste-preview')?.__remove?.();
    const text = value => globalThis.AIWSI18n.text(value), escape = window.AIWSUI?.esc || (value => value);
    const urls = files.map(file => URL.createObjectURL(file)), strip = document.createElement('div');
    strip.className = 'image-paste-preview';
    strip.innerHTML = urls.map((url, index) => `<button type="button" class="image-paste-thumb" data-index="${index}" title="${escape(text('Tam ekran aç'))}"><img src="${escape(url)}" alt="${escape(files[index].name || '')}"></button>`).join('') + `<button type="button" class="image-paste-close" aria-label="${escape(text('Kapat'))}">×</button>`;
    const remove = strip.__remove = () => { strip.remove(); urls.forEach(url => URL.revokeObjectURL(url)); };
    strip.addEventListener('pointerdown', event => event.stopPropagation());
    strip.addEventListener('mousedown', event => event.preventDefault());
    strip.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      if (event.target.closest('.image-paste-close')) return remove();
      const thumb = event.target.closest('.image-paste-thumb');
      if (thumb && openModal) view(urls[thumb.dataset.index], files[thumb.dataset.index].name);
    });
    container.append(strip);
    return remove;
  }
  /** Gives the image viewer the app's modal opener; app/image-setup.js calls it once. */
  function configureViewer(show) { openModal = show; }
  Object.assign(window.AIWSImages, { configureViewer, pastePreview });
})();
