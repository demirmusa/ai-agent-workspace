'use strict';
// Outline page icons for the settings, library, sessions and schedules pages, on AIWSUI.icon's 16-unit grid.
const pageIconShapes={
  sliders:'<path d="M2.75 5h4.5M10.75 5h2.5M2.75 11h2.5M8.75 11h4.5"/><circle cx="9" cy="5" r="1.75"/><circle cx="7" cy="11" r="1.75"/>',
  play:'<circle cx="8" cy="8" r="6.25"/><path d="M6.75 5.6v4.8L10.5 8z"/>',
  sync:'<path d="M12.9 6.4A5.1 5.1 0 0 0 3.6 4.9M3.1 9.6a5.1 5.1 0 0 0 9.3 1.5"/><path d="M3.25 2.4v2.85H6.1M12.75 13.6v-2.85H9.9"/>',
  branch:'<circle cx="4.5" cy="3.75" r="1.5"/><circle cx="4.5" cy="12.25" r="1.5"/><circle cx="11.5" cy="5.25" r="1.5"/><path d="M4.5 5.25v5.5M11.5 6.75c0 2.9-7 1.6-7 4"/>',
  terminal:'<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M5 6.5l2 1.5-2 1.5M8.75 10h2.25"/>',
  tag:'<path d="M2.75 3.75v3.3c0 .3.1.55.3.75l5.2 5.2c.4.4 1 .4 1.4 0l3.15-3.15c.4-.4.4-1 0-1.4l-5.2-5.2a1.05 1.05 0 0 0-.75-.3h-3.3a.8.8 0 0 0-.8.8z"/><circle cx="5.6" cy="5.6" r=".85" fill="currentColor" stroke="none"/>',
  milestone:'<path d="M8 1.75v2M8 10.25v4M3.25 4.25h8.25l2 2.5-2 2.5H3.25z"/>',
  folder:'<path d="M2.25 4.75c0-.55.45-1 1-1h2.8l1.3 1.5h5.4c.55 0 1 .45 1 1v5.75c0 .55-.45 1-1 1H3.25c-.55 0-1-.45-1-1z"/>'
};
const pageIcon=name=>`<svg class="ui-icon" width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${pageIconShapes[name]}</svg>`;
