/* Status tones and the shared glyphs on window.AIWSUI: outline icons, status pills, the AI sparkle and provider badges. Loaded after
 * ui/motion.js. */
(function (global) {
  'use strict';
  const { esc } = global.AIWSUI;
  // Run, task and agent statuses collapse into five tones: running|starting|resumed|queued-running → running,
  // waiting|question|needs|input → needs, completed|done|review → done, failed|incomplete|interrupted|error → failed,
  // and everything else (cancelled, stopped, closed, paused, pending, backlog, ready, unknown, history, idle) → idle.
  const toneOf = new Map(Object.entries({ running: ['completing', 'running', 'starting', 'resumed', 'queued-running'], needs: ['waiting', 'question', 'needs', 'input'], done: ['completed', 'done', 'review'], failed: ['failed', 'incomplete', 'interrupted', 'error'] }).flatMap(([name, statuses]) => statuses.map(status => [status, name])));
  const tones = ['running', 'done', 'needs', 'failed', 'idle'];
  /** Maps a run, task or agent status to its tone: running, needs, done, failed or idle. */
  const tone = status => toneOf.get(String(status ?? '').trim().toLowerCase()) || 'idle';

  // Outline icons on a 16-unit grid; spark and dot are filled. The wrench follows Feather's "tool" icon (MIT).
  const iconShapes = {
    check: '<path d="M3.5 8.5l3 3 6-7"/>',
    alert: '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.75V8.5M8 11.25h.01"/>',
    clock: '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.75V8l2.25 1.5"/>',
    triangle: '<path d="M7.13 2.5a1 1 0 0 1 1.74 0l5.48 9.75a1 1 0 0 1-.87 1.5H2.52a1 1 0 0 1-.87-1.5z"/><path d="M8 6.25v3M8 11.6h.01"/>',
    chevron: '<path d="M4 6l4 4 4-4"/>',
    search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25l3.25 3.25"/>',
    tool: '<path d="M9.8 4.2a.67.67 0 0 0 0 .93l1.07 1.07a.67.67 0 0 0 .93 0l2.51-2.51a4 4 0 0 1-5.29 5.29l-4.61 4.61a1.41 1.41 0 0 1-2-2l4.61-4.61a4 4 0 0 1 5.29-5.29z"/>',
    spark: '<path fill="currentColor" stroke="none" d="M8 1.75Q8.7 7.3 14.25 8Q8.7 8.7 8 14.25Q7.3 8.7 1.75 8Q7.3 7.3 8 1.75Z"/>',
    'arrow-right': '<path d="M3 8h10M9 4l4 4-4 4"/>',
    refresh: '<path d="M13.5 6.5A5.5 5.5 0 1 0 13.25 10M13.5 2.5v4h-4"/>',
    expand: '<path d="M9.5 2.5h4v4M13.5 2.5 9.25 6.75M6.5 13.5h-4v-4M2.5 13.5l4.25-4.25"/>',
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
    mic: '<rect x="6" y="2" width="4" height="7" rx="2"/><path d="M3.75 7.5a4.25 4.25 0 0 0 8.5 0M8 11.75v2.25M5.75 14h4.5"/>',
    pin: '<path d="M6 2.5h4M6.75 2.5v4L4.5 9h7L9.25 6.5v-4M8 9v4.5"/>',
    eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
    'eye-off': '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM2.5 13.5l11-11"/>',
    dot: '<circle cx="8" cy="8" r="3.25" fill="currentColor" stroke="none"/>',
    archive: '<rect x="2" y="3" width="12" height="3.5" rx="1"/><path d="M3.25 6.5v6.25a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V6.5M6.5 9.25h3"/>',
    plug: '<path d="M6 1.75v3M10 1.75v3M4.25 4.75h7.5v2.5a3.75 3.75 0 0 1-7.5 0zM8 11v3.25"/>'
  };
  /** Inline SVG for a named icon: 1em square, currentColor, hidden from assistive technology; unknown names give ''. */
  const icon = name => Object.hasOwn(iconShapes, name) ? `<svg class="ui-icon" width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconShapes[name]}</svg>` : '';
  const pillIcons = { running: '<span class="ui-spinner" aria-hidden="true"></span>', done: icon('check'), needs: icon('clock'), failed: icon('triangle'), idle: icon('dot') };
  /** A tinted status pill with its tone's icon (a spinner while running) and the escaped label; takes a tone or a raw status. */
  function statusPill(value, label) { const key = tones.includes(value) ? value : tone(value); return `<span class="status-pill" data-tone="${key}">${pillIcons[key]}${esc(label)}</span>`; }
  /** The four-point AI sparkle with its trailing dot; a tone, a raw status or 'accent' colours it, otherwise it takes the text colour. */
  function sparkle(value) {
    const key = !value ? '' : value === 'accent' || tones.includes(value) ? value : tone(value);
    return `<span class="ui-sparkle"${key ? ` data-tone="${key}"` : ''} aria-hidden="true"><svg width="1em" height="1em" viewBox="0 0 16 16" fill="currentColor"><path d="M6.75 1.25Q7.35 6.15 12.25 6.75Q7.35 7.35 6.75 12.25Q6.15 7.35 1.25 6.75Q6.15 6.15 6.75 1.25Z"/><circle cx="13.1" cy="13.1" r="1.3"/></svg></span>`;
  }
  /** A provider without an icon reads as the capitals of its registry name (OpenCode → Oc); a one-word name falls back to a prompt. */
  const monogram = name => { const capitals = String(name || '').match(/\p{Lu}/gu) || []; return capitals.length > 1 ? `${capitals[0]}${capitals[1].toLowerCase()}` : '>_'; };
  /** Badge for a built-in or custom provider, reading the icon path and display name from the server's provider registry. */
  function providerIcon(provider) {
    const src = global.AIWSProviderIcons?.[provider], label = global.AIWSProviderNames?.[provider] || provider;
    return src ? `<span class="provider-icon ${esc(provider)}" title="${esc(label)}" role="img" aria-label="${esc(label)}"><img src="${esc(src)}" alt="" width="18" height="18"></span>` : `<span class="provider-icon provider-fallback" aria-hidden="true">${esc(monogram(global.AIWSProviderNames?.[provider]))}</span>`;
  }

  global.AIWSUI = Object.freeze({ ...global.AIWSUI, tone, icon, statusPill, sparkle, providerIcon, providerMonogram: monogram });
})(window);
