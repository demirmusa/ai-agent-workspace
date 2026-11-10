/* Git change markers and the changed-files list: a status letter like VS Code, line counts and an expandable colored patch per file. */
(function () {
  'use strict';
  const t = value => globalThis.AIWSI18n.text(value);
  const { esc } = window.AIWSUI, { fileIcon } = window.AIWSFiles;
  // Git change markers, shared by the explorer and the changes list: a letter on the right like VS Code.
  const changeLetters = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflicted: 'C' };
  const changeLabel = status => ({ modified: t('Değiştirildi'), added: t('Eklendi'), deleted: t('Silindi'), renamed: t('Yeniden adlandırıldı'), untracked: t('Yeni dosya'), conflicted: t('Conflict var') })[status] || status;
  const changeBadge = status => `<span class="file-change" data-change="${esc(status)}" title="${esc(changeLabel(status))}" aria-label="${esc(changeLabel(status))}">${changeLetters[status] || '•'}</span>`;
  const changeDot = status => `<span class="file-change-dot" data-change="${esc(status)}" title="${esc(t('İçinde değişiklik var'))}" aria-label="${esc(t('İçinde değişiklik var'))}"></span>`;
  const diffStat = (item, title = '') => item.additions || item.deletions ? `<span class="git-diffstat"${title ? ` title="${esc(title)}"` : ''}><span class="add">+${item.additions}</span> <span class="del">−${item.deletions}</span></span>` : '';
  // A folder takes the most pressing state among its changed children.
  const changeRank = ['conflicted', 'deleted', 'modified', 'renamed', 'added', 'untracked'];
  /** Per-path status of changed files and of every folder above them. */
  function changeIndex(files) {
    const paths = new Map(), folders = new Map();
    for (const file of files || []) {
      paths.set(file.path, file.status);
      const parts = file.path.split('/');
      for (let index = 1; index < parts.length; index++) {
        const folder = parts.slice(0, index).join('/'), current = folders.get(folder);
        if (!current || changeRank.indexOf(file.status) < changeRank.indexOf(current)) folders.set(folder, file.status);
      }
    }
    return { paths, folders };
  }
  /** One patch as colored lines; headers before the first hunk are dropped. */
  function diffHtml(entry) {
    if (!entry || entry.loading) return `<p class="changes-empty">${esc(t('Yükleniyor…'))}</p>`;
    if (entry.error) return `<p class="git-result" data-tone="failed" role="alert">${esc(entry.error)}</p>`;
    const lines = entry.diff.split('\n'), start = lines.findIndex(line => line.startsWith('@@'));
    if (start < 0) return `<p class="changes-empty">${esc(t('Gösterilecek metin farkı yok.'))}</p>`;
    if (lines.at(-1) === '') lines.pop();
    const body = lines.slice(start).map(line => `<span class="diff-line ${line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : ''}">${esc(line) || ' '}</span>`).join('');
    return `<pre class="change-diff-body">${body}</pre>${entry.truncated ? `<p class="changes-empty">${esc(t('Fark kısaltıldı.'))}</p>` : ''}`;
  }
  /** Changed files as a flat list: name, folder, line counts and the status letter. `view` holds the expanded rows and their loaded patches. */
  function changesHtml(data, view = { open: new Set(), diffs: new Map() }) {
    if (!data.files.length) return `<p class="changes-empty">${esc(t('Değişiklik yok.'))}</p>`;
    const rows = data.files.map(file => {
      const slash = file.path.lastIndexOf('/'), name = file.path.slice(slash + 1), folder = slash < 0 ? '' : file.path.slice(0, slash);
      const title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path, open = view.open.has(file.path);
      const openable = data.root && file.status !== 'deleted';
      return `<li class="change-item"><div class="change-row" role="button" data-change="${esc(file.status)}" data-change-path="${esc(file.path)}" title="${esc(title)}" tabindex="0" aria-expanded="${open}"><span class="file-icon file">${fileIcon}</span><span class="change-name">${esc(name)}</span><span class="change-folder">${esc(folder)}</span>${file.binary ? `<span class="git-meta">${esc(t('ikili dosya'))}</span>` : diffStat(file)}${openable ? `<button type="button" class="icon-button small" data-change-open="${esc(file.path)}" title="${esc(t('Varsayılan programla aç'))}" aria-label="${esc(t('Varsayılan programla aç'))}">↗</button>` : ''}${changeBadge(file.status)}</div>${open ? `<div class="change-diff">${diffHtml(view.diffs.get(file.path))}</div>` : ''}</li>`;
    }).join('');
    return `<ul class="changes-list">${rows}</ul>${data.truncated ? `<p class="changes-empty">${esc(t('İlk 2000 dosya gösteriliyor'))}</p>` : ''}`;
  }
  Object.assign(window.AIWSFiles, { changesHtml, diffStat, changeIndex, changeBadge, changeDot });
})();
