/* The task description editor: EasyMDE with file and image upload, "@" file mentions, dropped project paths, thumbnails of uploaded images and a DOMPurify-sanitized preview. */
(function () {
  'use strict';
  const { data, isImage, warnLarge, hydrate, authHeaders, fileMentions, insertPath, pathType } = window.AIWSImages;
  function editor(textarea, { api, onError, projectId }) {
    if (!window.EasyMDE || !window.DOMPurify) return;
    const form = textarea.form;
    let pending = 0, disposed = false, lastError = '';
    const blobs = new Set();
    const status = document.createElement('small'); status.role = 'status';
    status.textContent = globalThis.AIWSI18n.text('Dosya veya görsel yapıştır, sürükle ya da Dosya düğmesini kullan.');
    textarea.after(status);
    // Any file type uploads; an image becomes an inline picture, other files a link.
    const picker = document.createElement('input'); picker.type = 'file'; picker.multiple = true; picker.hidden = true; textarea.after(picker);
    const upload = file => {
      const project = typeof projectId === 'function' ? projectId() : projectId;
      return data(file).then(value => api('/attachments', 'POST', { data: value, name: file.name, ...(project ? { projectId: project } : {}) }));
    };
    const addFiles = files => {
      warnLarge(files, status);
      for (const file of files) {
        pending++; lastError = ''; status.textContent = globalThis.AIWSI18n.text('Dosya yükleniyor…');
        upload(file).then(saved => {
          if (disposed) return;
          const label = file.name.replace(/[[\]]/g, '');
          instance.codemirror.replaceSelection(`${isImage(saved.url) || /^image\//.test(file.type) ? '!' : ''}[${label}](${saved.url})
`);
        }).catch(error => { if (!disposed) { lastError = error.message; onError(error); } }).finally(() => {
          pending--; if (!disposed) status.textContent = pending ? globalThis.AIWSI18n.text('Dosya yükleniyor…') : (lastError || globalThis.AIWSI18n.text('Dosyalar kaydedildi. Yapıştırmaya devam edebilirsin.'));
        });
      }
    };
    picker.addEventListener('change', () => { addFiles([...picker.files]); picker.value = ''; });
    const options = {
      element: textarea, forceSync: true, spellChecker: false, status: false,
      autoDownloadFontAwesome: false, minHeight: '160px', maxHeight: '360px',
      uploadImage: true, imagePathAbsolute: true, errorCallback: () => {},
      toolbar: [
        { name: 'bold', action: window.EasyMDE.toggleBold, text: 'B', title: globalThis.AIWSI18n.text('Kalın') },
        { name: 'italic', action: window.EasyMDE.toggleItalic, text: 'I', title: globalThis.AIWSI18n.text('İtalik') },
        { name: 'heading', action: window.EasyMDE.toggleHeadingSmaller, text: 'H', title: globalThis.AIWSI18n.text('Başlık') },
        '|', { name: 'unordered-list', action: window.EasyMDE.toggleUnorderedList, text: '≡', title: globalThis.AIWSI18n.text('Liste') },
        { name: 'link', action: window.EasyMDE.drawLink, text: '↗', title: globalThis.AIWSI18n.text('Bağlantı') },
        { name: 'upload-file', action: () => picker.click(), text: globalThis.AIWSI18n.text('Dosya'), title: globalThis.AIWSI18n.text('Dosya yükle') },
        { name: 'upload-image', action: window.EasyMDE.drawUploadedImage, text: globalThis.AIWSI18n.text('Resim'), title: globalThis.AIWSI18n.text('Görsel yükle') },
        '|', { name: 'preview', action: window.EasyMDE.togglePreview, text: globalThis.AIWSI18n.text('Önizle'), title: globalThis.AIWSI18n.text('Önizleme'), noDisable: true },
      ],
      imageUploadFunction(file, success, failure) {
        pending++; lastError = ''; status.textContent = globalThis.AIWSI18n.text('Görsel yükleniyor…'); warnLarge([file], status);
        // A project-scoped upload is stored in that repository's ignored .aiws folder.
        upload(file).then(image => {
          if (!disposed) success(image.url);
        }).catch(error => { if (!disposed) { lastError = error.message; failure(error.message); onError(error); } }).finally(() => {
          pending--; if (!disposed) status.textContent = pending ? globalThis.AIWSI18n.text('Görsel yükleniyor…') : (lastError || globalThis.AIWSI18n.text('Görseller kaydedildi. Yapıştırmaya devam edebilirsin.'));
        });
      },
      previewRender(markdown, preview) {
        // No raw HTML or event handlers from task / issue descriptions reach the DOM.
        for (const url of blobs) URL.revokeObjectURL(url); blobs.clear();
        preview.innerHTML = window.DOMPurify.sanitize(instance.markdown(markdown));
        for (const img of preview.querySelectorAll('img')) {
          const source = img.getAttribute('src'); img.removeAttribute('src');
          if (!/^\/api\/attachments\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(source || '')) continue;
          fetch(source, { headers: authHeaders() }).then(response => {
            if (!response.ok) throw new Error(globalThis.AIWSI18n.text('Görsel yüklenemedi.')); return response.blob();
          }).then(blob => { if (!disposed && img.isConnected) { const url = URL.createObjectURL(blob); blobs.add(url); img.src = url; } }).catch(() => { img.alt = globalThis.AIWSI18n.text('Görsel yüklenemedi'); });
        }
        // EasyMDE writes any non-null result into the preview; null keeps the DOM built above.
        return null;
      },
    };
    const instance = new window.EasyMDE(options);
    instance.codemirror.getInputField().setAttribute('aria-label', globalThis.AIWSI18n.text('Görev açıklaması'));
    const mentions = fileMentions(instance.codemirror, { api, projectId });
    // A path dragged from the project files panel lands where it is dropped. Capturing on the
    // wrapper runs before EasyMDE's drop handler, which only uploads dropped images.
    const wrapper = instance.codemirror.getWrapperElement();
    const dropPath = event => {
      const others = [...(event.dataTransfer?.files || [])].filter(file => !file.type.startsWith('image/'));
      if (others.length) { event.preventDefault(); event.stopPropagation(); addFiles(others); return; }
      const path = event.dataTransfer?.getData(pathType); if (!path) return;
      event.preventDefault(); event.stopPropagation();
      const cm = instance.codemirror;
      cm.setCursor(cm.coordsChar({ left: event.clientX, top: event.clientY }, 'window'));
      insertPath(cm, path);
    };
    wrapper.addEventListener('drop', dropPath, true);
    // Uploaded images show as thumbnails below the editor while the Markdown keeps their links.
    const gallery = document.createElement('div'); gallery.className = 'description-images';
    status.before(gallery);
    let shown = '';
    const thumbnails = () => {
      const sources = [...new Set([...instance.value().matchAll(/!\[[^\]]*\]\((\/api\/attachments\/[a-f0-9]{64}\.(?:png|jpg|gif|webp))\)/g)].map(match => match[1]))];
      if (disposed || sources.join() === shown) return;
      shown = sources.join(); gallery.replaceChildren(...sources.map(source => {
        const img = document.createElement('img'); img.dataset.attachmentSrc = source; img.alt = globalThis.AIWSI18n.text('Görsel'); hydrate(img); return img;
      }));
    };
    instance.codemirror.on('change', thumbnails); thumbnails();
    const sync = () => { if (textarea.value !== instance.value()) instance.value(textarea.value); };
    textarea.addEventListener('input', sync);
    const refresh = () => instance.codemirror.refresh();
    form.addEventListener('modalresume', refresh);
    const guard = event => { if (pending) { event.preventDefault(); event.stopImmediatePropagation(); onError(new Error(globalThis.AIWSI18n.text('Görsel yüklemesinin bitmesini bekle.'))); } };
    form.addEventListener('submit', guard, true);
    // A minimized draft is parked outside the dialog. Only its own form's
    // lifecycle may dispose it; other dialogs reuse the same modal element.
    form.addEventListener('modalreset', () => {
      disposed = true; form.removeEventListener('submit', guard, true); textarea.removeEventListener('input', sync);
      mentions.dispose(); wrapper.removeEventListener('drop', dropPath, true);
      form.removeEventListener('modalresume', refresh);
      instance.codemirror.off('change', thumbnails); instance.toTextArea(); status.remove(); picker.remove(); gallery.remove(); for (const url of blobs) URL.revokeObjectURL(url);
    }, { once: true });
    return instance;
  }
  Object.assign(window.AIWSImages, { editor });
})();
