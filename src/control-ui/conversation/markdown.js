/* Markdown for provider and user text: a small renderer that escapes everything and builds only its own tags, so agent output is
 * presentation data, never executable HTML. Links keep http(s)/mailto only and open with rel="noopener noreferrer"; AIWS prompt
 * files become viewer buttons and task attachments inline images that AIWSImages loads with the control token. */
(function (global) {
  'use strict';
  const kit = global.AIWSConversationKit, { esc } = kit;
  function inline(source) {
    const tokens = [];
    const token = html => `\u0000${tokens.push(html) - 1}\u0000`;
    let content = String(source).replace(/\u0000/g, '');
    content = content.replace(/`([^`\n]+)`/g, (_, code) => token(`<code>${esc(code)}</code>`));
    // AIWS run prompt files open in a viewer; Docker runs name the mounted path, so take the id from --run.
    const dockerRun = content.match(/--run\s+(run_[\w-]+)/)?.[1];
    content = content.replace(/(?:[A-Za-z]:)?[\\/][^\s`'"<>]*?[\\/]runs[\\/](run_[\w-]+)[\\/]input[\\/]prompt\.md|\/run\/aiws\/input\/prompt\.md/g, (path, runId) => (runId || dockerRun) ? token(`<button type="button" class="cv-file-reference cv-prompt-link" data-run-prompt="${esc(runId || dockerRun)}" title="${esc(globalThis.AIWSI18n.text('Agenta verilen talimatı göster'))}">${esc(path)}</button>`) : path);
    // Task attachments render inline; AIWSImages loads them with the control token. Remote images stay links.
    content = content.replace(/!\[([^\]\n]*)\]\((\/api\/attachments\/[a-f0-9]{64}\.(?:png|jpg|gif|webp))\)/g, (_, alt, url) => token(`<img class="cv-image" data-attachment-src="${esc(url)}" alt="${esc(alt || globalThis.AIWSI18n.text('Görsel'))}" loading="lazy">`));
    content = content.replace(/!\[([^\]\n]*)\]\((https:\/\/[^\s)]+)\)/g, (_, alt, url) => token(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(alt || globalThis.AIWSI18n.text('Görsel'))}</a>`));
    content = content.replace(/\[([^\]\n]+)\]\(([^\s]+)\)/g, (_, label, url) => {
      if (/^https?:\/\//i.test(url) || /^mailto:[^\s]+$/i.test(url)) return token(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`);
      return token(`<span class="cv-file-reference" title="${esc(url)}">${esc(label)}</span>`);
    });
    content = content.replace(/\bhttps?:\/\/[^\s<>"'`]*[^\s<>"'`).,;:!?\]]/g, url => token(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`));
    content = esc(content).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(?<!\*)\*([^*\s][^*\n]*)\*(?!\*)/g, '<em>$1</em>').replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    return content.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)] || '');
  }
  const attachmentImageLine = /^\s*!\[[^\]\n]*\]\(\/api\/attachments\/[a-f0-9]{64}\.(?:png|jpg|gif|webp)\)\s*$/;
  const listMarker =/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/, fenceOpen = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/, ruleLine = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const fenceClose = (line, fence) => new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line);
  const blockStart = line => /^\s{0,3}(?:#{1,6}\s|>|`{3,}|~{3,})/.test(line) || ruleLine.test(line);
  const codeBlock = (code, language = '') => `<pre class="cv-code"${language ? ` data-language="${esc(language)}"` : ''}><code data-language="${esc(language)}">${esc(code)}</code></pre>`;
  // Nested lists follow indentation; indented lines and fenced code continue the item above them.
  function listBlock(lines, start) {
    const stack = []; let root = null, index = start;
    const textPart = item => { const last = item.parts.at(-1); if (last?.type === 'text') return last; const part = { type: 'text', lines: [] }; item.parts.push(part); return part; };
    for (; index < lines.length; index++) {
      const line = lines[index], marker = !ruleLine.test(line) && line.match(listMarker);
      if (marker) {
        const indent = marker[1].length, ordered = /\d/.test(marker[2]);
        while (stack.length > 1 && indent < stack.at(-1).indent) stack.pop();
        let level = stack.at(-1);
        if (!level || indent >= level.indent + 2) {
          const nested = { indent, ordered, start: ordered ? parseInt(marker[2], 10) : 1, items: [] };
          if (level) level.items.at(-1).parts.push({ type: 'list', level: nested }); else root = nested;
          stack.push(nested); level = nested;
        } else if (indent < level.indent) level.indent = indent;
        const task = marker[3].match(/^\[([ xX])\]\s+(.*)$/);
        level.items.push({ checked: task ? task[1] !== ' ' : null, parts: [{ type: 'text', lines: [task ? task[2] : marker[3]] }] });
        continue;
      }
      if (!line.trim()) { let next = index + 1; while (next < lines.length && !lines[next].trim()) next++; if (next < lines.length && (listMarker.test(lines[next]) && !ruleLine.test(lines[next]) || /^\s{2,}\S/.test(lines[next]))) continue; break; }
      const item = stack.at(-1).items.at(-1), indented = /^\s{2,}\S/.test(line);
      if (!indented && (blockStart(line) || !lines[index - 1]?.trim())) break;
      const fence = line.match(fenceOpen);
      if (fence) {
        const body = [], pad = new RegExp(`^ {0,${line.match(/^\s*/)[0].length}}`);
        for (index++; index < lines.length && !fenceClose(lines[index], fence[1]); index++) body.push(lines[index].replace(pad, ''));
        item.parts.push({ type: 'html', html: codeBlock(body.join('\n'), fence[2]) }); continue;
      }
      textPart(item).lines.push(line.trim());
    }
    const render = level => {
      const tag = level.ordered ? 'ol' : 'ul';
      const items = level.items.map(item => `<li${item.checked === null ? '' : ` class="cv-task" data-checked="${item.checked}"`}>${item.checked === null ? '' : `<span class="cv-check" aria-hidden="true">${item.checked ? '✓' : ''}</span>`}${item.parts.map(part => part.type === 'text' ? `<p>${part.lines.map(inline).join('<br>')}</p>` : part.type === 'list' ? render(part.level) : part.html).join('')}</li>`).join('');
      return `<${tag} class="cv-list"${level.ordered && level.start !== 1 ? ` start="${level.start}"` : ''}>${items}</${tag}>`;
    };
    return [render(root), index];
  }
  function markdown(value) {
    const lines = String(value ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n');
    const html = []; let paragraph = [];
    // A paragraph of several attachment images only (e.g. the screenshots of an agent question) becomes a thumbnail gallery.
    const flush = () => {
      if (!paragraph.length) return;
      const gallery = paragraph.length > 1 && paragraph.every(line => attachmentImageLine.test(line));
      html.push(gallery ? `<div class="cv-image-gallery">${paragraph.map(inline).join('')}</div>` : `<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph = [];
    };
    const cells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
    const separator = row => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(row) && row.includes('-') && row.includes('|');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (line.includes('|') && index + 1 < lines.length && separator(lines[index + 1]) && cells(line).length === cells(lines[index + 1]).length) {
        flush();
        const head = cells(line), align = cells(lines[index + 1]).map(cell => /^:-+:$/.test(cell) ? 'center' : /-:$/.test(cell) ? 'right' : '');
        const body = []; index += 2;
        while (index < lines.length && lines[index].trim() && lines[index].includes('|')) body.push(cells(lines[index++]));
        index--;
        const cell = (tag, value, column) => `<${tag}${align[column] ? ` style="text-align:${align[column]}"` : ''}>${inline(value ?? '')}</${tag}>`;
        html.push(`<div class="cv-table-wrap"><table class="cv-table"><thead><tr>${head.map((value, column) => cell('th', value, column)).join('')}</tr></thead><tbody>${body.map(row => `<tr>${head.map((_, column) => cell('td', row[column], column)).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      const fence = line.match(fenceOpen);
      if (fence) {
        flush(); const body = [];
        for (index++; index < lines.length && !fenceClose(lines[index], fence[1]); index++) body.push(lines[index]);
        html.push(codeBlock(body.join('\n'), fence[2])); continue;
      }
      if (!line.trim()) { flush(); continue; }
      if (ruleLine.test(line)) { flush(); html.push('<hr>'); continue; }
      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
      if (heading) { flush(); const level = heading[1].length; html.push(`<h${Math.min(level + 2, 6)} class="cv-h${level}">${inline(heading[2])}</h${Math.min(level + 2, 6)}>`); continue; }
      if (/^\s{0,3}>/.test(line)) {
        flush(); const quoted = [];
        for (; index < lines.length && /^\s{0,3}>/.test(lines[index]); index++) quoted.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
        index--; html.push(`<blockquote>${markdown(quoted.join('\n'))}</blockquote>`); continue;
      }
      if (listMarker.test(line)) { flush(); const [list, next] = listBlock(lines, index); html.push(list); index = next - 1; continue; }
      paragraph.push(line);
    }
    flush();
    return html.join('');
  }
  Object.assign(kit, { markdown });
})(globalThis);
