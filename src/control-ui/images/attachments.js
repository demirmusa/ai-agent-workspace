/* Task attachments: reading a file for upload, the large-file warning bar, and attachment images that load through fetch with the
 * control token (rendered descriptions mark them with data-attachment-src). Creates window.AIWSImages; the other images/*.js
 * scripts extend it. */
(function () {
  'use strict';
  async function data(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(globalThis.AIWSI18n.text('Dosya okunamadı.')));
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(file);
    });
  }
  // Files have no size limit; anything above this only raises a warning bar.
  const warnBytes = 10 * 1024 * 1024;
  const isImage = name => /\.(png|jpe?g|gif|webp)$/i.test(name);
  /** Shows a dismissible warning bar before `host` when any of `files` exceeds 10 MiB. */
  function warnLarge(files, host) {
    host.parentNode?.querySelector(':scope > .upload-warning')?.remove();
    const large = [...files].filter(file => file.size > warnBytes);
    if (!large.length) return;
    const bar = document.createElement('div'); bar.className = 'error-banner upload-warning'; bar.setAttribute('role', 'alert'); bar.dataset.tone = 'needs';
    const text = document.createElement('span'); text.className = 'error-banner-text';
    text.textContent = `${large.map(file => file.name).join(', ')} · ` + globalThis.AIWSI18n.text('Dosya 10 MiB’den büyük. Yükleme sürebilir.');
    const close = document.createElement('button'); close.type = 'button'; close.className = 'button small ghost'; close.textContent = globalThis.AIWSI18n.text('Kapat');
    close.onclick = () => bar.remove(); bar.append(text, close); host.before(bar);
  }
  function authHeaders() {
    const token = sessionStorage.getItem('aiws.token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
  // Rendered descriptions mark attachments with data-attachment-src; the API needs the
  // bearer token, so images load through fetch. Object URLs are shared per image ID.
  const loaded = new Map();
  function hydrate(root) {
    const images = root.matches?.('img[data-attachment-src]') ? [root] : [...(root.querySelectorAll?.('img[data-attachment-src]') || [])];
    for (const img of images) {
      const source = img.dataset.attachmentSrc; img.removeAttribute('data-attachment-src');
      if (!/^\/api\/attachments\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(source || '')) continue;
      if (!loaded.has(source)) loaded.set(source, fetch(source, { headers: authHeaders() }).then(response => {
        if (!response.ok) throw new Error(globalThis.AIWSI18n.text('Görsel yüklenemedi.')); return response.blob();
      }).then(blob => URL.createObjectURL(blob)).catch(error => { loaded.delete(source); throw error; }));
      loaded.get(source).then(url => { img.src = url; }).catch(() => { img.alt = globalThis.AIWSI18n.text('Görsel yüklenemedi'); });
    }
  }
  if (typeof MutationObserver === 'function' && document.documentElement) {
    new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) hydrate(node); })
      .observe(document.documentElement, { childList: true, subtree: true });
  }
  window.AIWSImages = { data, isImage, warnLarge, hydrate, authHeaders };
})();
