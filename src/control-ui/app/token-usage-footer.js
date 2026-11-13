'use strict';
// Subscription usage pills in the board footer.
// Footer choices live in the control server's settings (usageFooter), not in browser storage: the desktop app's origin changes on every launch.
function tokenFooter() { const value = state.settings?.usageFooter; return {pins:value?.pins||{},hidden:value?.hidden||[]}; }
function tokenPinned(provider, key) { return Array.isArray(tokenFooter().pins[provider]) && tokenFooter().pins[provider].includes(key); }
function tokenHidden(provider) { return tokenFooter().hidden.includes(provider); }
/** Applies a footer change to the settings at once and saves it; a failed save shows the error and restores the server's value. */
function tokenSaveFooter(change) {
  const current = tokenFooter(), next = {pins:{...current.pins},hidden:[...current.hidden]}; change(next);
  state.settings = {...state.settings,usageFooter:next};
  return api('/settings','PATCH',{usageFooter:next}).catch(cause => { error(cause.message); void refresh(); });
}
function tokenTogglePin(provider, key) {
  tokenSaveFooter(next => {
    const keys = next.pins[provider]||[], rows = keys.includes(key) ? keys.filter(item => item!==key) : [...keys,key];
    if (rows.length) next.pins[provider] = rows; else delete next.pins[provider];
  });
}
function tokenToggleHidden(provider) { return tokenSaveFooter(next => { next.hidden = next.hidden.includes(provider) ? next.hidden.filter(item => item!==provider) : [...next.hidden,provider]; }); }
/** A footer pill: provider icon (and the account of an account card), a five-step meter of the first shown window's remaining share, then each shown window's remaining percent and countdown. */
function tokenPill(item) {
  const pinned = tokenRows(item).filter(row => tokenPinned(item.key,row.key)).map(row => row.window), windows = pinned.length ? pinned : tokenWindows(item).slice(0,2), [first] = windows;
  const used = tokenUsed(first), remaining = tokenRemaining(first), steps = remaining ? Math.max(1,Math.round(remaining/20)) : 0;
  const values = windows.map(window => { const share = tokenUsed(window), left = tokenReset(window); return `<span class="token-pill-window"><b${tokenTone(share)?` data-tone="${tokenTone(share)}"`:''}>${tokenPercent(tokenRemaining(window))}</b>${left?`<span class="token-time">${esc(left)}</span>`:''}</span>`; }).join('');
  return `<span class="token-pill" data-tone="${used==null?'idle':tokenTone(used)||'done'}">${providerIcon(tokenProviderId(item))}${item.accountId?`<span class="token-pill-account" title="${esc(item.account)}">${esc(item.account)}</span>`:''}<span class="token-meter" aria-hidden="true">${[0,1,2,3,4].map(step=>`<i${step<steps?' class="is-on"':''}></i>`).join('')}</span><span class="token-pill-values">${values}</span></span>`;
}
/** The footer button: a pill per shown provider, a placeholder while nothing is known or every provider is hidden. */
function renderTokenFooter() {
  const items = tokenUsageData?.providers || [], button = $('#token-countdown'), title = tokenUsageError || globalThis.AIWSI18n.text('Kalan kısa dönem / haftalık kota · Sıfırlanmaya kalan süre');
  const shown = items.filter(item => !tokenHidden(item.key));
  setHtml(button,shown.length ? shown.map(tokenPill).join('') : items.length ? `<span class="token-pill" data-tone="idle"><span class="token-pill-values"><b>${globalThis.AIWSI18n.text('Kota')}</b></span></span>` : tokenUsageData||tokenUsageError ? '<span class="token-pill" data-tone="idle"><span class="token-pill-values"><b>--</b></span></span>' : '<span class="skeleton token-countdown-skeleton" aria-hidden="true"></span>');
  if (button.title!==title) button.title = title;
}
