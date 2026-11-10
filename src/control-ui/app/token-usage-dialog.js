'use strict';
// The subscription usage dialog.
// The dialog is built once per open and then patched in place, so the one-second countdown tick never replaces the row under the
// pointer and the waffle's cell transitions can play.
const tokenViews = new WeakMap();
/** The refresh action's content: "Yenile" with a circular arrow, a spinner while a remote check runs, then a short "✓ Güncel" once it answered. */
function tokenRefreshContent(state) { return state==='busy' ? `<span class="ui-spinner" aria-hidden="true"></span>${globalThis.AIWSI18n.text('Yenileniyor…')}` : state==='done' ? `${tokenUI.icon('check')}${globalThis.AIWSI18n.text('Güncel')}` : `${globalThis.AIWSI18n.text('Yenile')}${tokenUI.icon('refresh')}`; }
/** A shell footer: what the card shows (source, or the focused window) and the refresh action. */
function tokenShellFoot() { return `<footer class="token-shell-foot"><p class="token-foot"><span class="token-foot-key"></span><span class="token-foot-text"></span></p><button type="button" class="token-refresh" data-token-refresh>${tokenRefreshContent('')}</button></footer>`; }
/** The fixed markup of a provider or account card, filled by patchTokenCard. The 100 cells (one per percent) fill column by column;
 * --d delays each cell's colour change by its column and row, so a newly shown window sweeps in from the left. */
function tokenCardHtml(item) {
  const key = item.key;
  const cells = Array.from({length:100},(_,index)=>`<i style="--d:${Math.floor(index/4)*9+index%4*14}ms"></i>`).join('');
  return `<article class="token-shell" data-token-provider="${esc(key)}" aria-labelledby="token-title-${esc(key)}"><div class="token-card"><header class="token-card-head"><h3 class="token-card-title" id="token-title-${esc(key)}"></h3><span class="ui-chip is-mono token-account">${providerIcon(tokenProviderId(item))}<span class="token-account-name"></span></span><button type="button" class="token-pin token-visibility" data-token-hide>${tokenUI.icon('eye')}</button></header><p class="token-figure"><strong class="token-big"></strong><span class="token-big-label"></span><span class="token-used"></span></p><div class="token-waffle" role="img">${cells}</div><div class="token-legend" role="group" aria-label="${esc(globalThis.AIWSI18n.text('Kota pencereleri'))}"></div><p class="token-retry" data-tone="needs" hidden>${tokenUI.icon('clock')}<span></span></p></div>${tokenShellFoot()}</article>`;
}
function tokenRowHtml(row) { return `<div class="token-line"><button type="button" class="token-row" data-token-window="${esc(row.key)}" aria-pressed="false" style="--viz:${row.colour}"><span class="token-swatch" aria-hidden="true"></span><span class="token-row-label"></span><span class="token-row-reset"><span></span><span class="token-row-tail"></span></span><span class="token-row-value"></span></button><button type="button" class="token-pin" data-token-pin="${esc(row.key)}" aria-pressed="false">${tokenUI.icon('pin')}</button></div>`; }
/** Writes text only when it changed; animate crossfades it instead. */
function tokenPut(element, text, animate) { if (animate) tokenUI.motion.swapText(element,text); else if (element.textContent!==text) element.textContent=text; }
/** Sets or (for an empty value) removes an attribute only when it changed. */
function tokenAttr(element, name, value) { if (!value) { if (element.hasAttribute(name)) element.removeAttribute(name); } else if (element.getAttribute(name)!==value) element.setAttribute(name,value); }
/** Brings one provider card up to date, writing only what changed. It shows the hovered row's window, else the keyboard-focused
 * row's, else the first: the number rolls, the label and footer crossfade, and the waffle sweeps to that window's colour. */
function patchTokenCard(card, item) {
  const animate = card.ready, rows = tokenRows(item), keys = rows.map(row => row.key).join('\n');
  card.item = item;
  // A changed set of windows rebuilds the legend; the replaced rows can no longer be hovered or focused.
  if (card.keys!==keys) { card.keys = keys; card.hover = card.focus = null; card.legend.innerHTML = rows.map(tokenRowHtml).join(''); card.rows = new Map([...card.legend.querySelectorAll('.token-row')].map(element => [element.dataset.tokenWindow,element])); }
  const focused = rows.find(row => row.key===(card.hover??card.focus)), shown = focused||rows[0], used = tokenUsed(shown.window), remaining = tokenRemaining(shown.window), count = used??0;
  const hidden = tokenHidden(item.key), hideLabel = globalThis.AIWSI18n.text(hidden?'Altta göster':'Alttan gizle');
  tokenAttr(card.hide,'aria-pressed',String(hidden)); tokenAttr(card.hide,'aria-label',`${hideLabel}: ${item.name}`); tokenAttr(card.hide,'title',hideLabel); card.hide.innerHTML = tokenUI.icon(hidden?'eye-off':'eye');
  tokenPut(card.title,item.name);
  // A hidden provider is collapsed to its dimmed title (the server skips its quota lookup); the eye opens it again.
  if (card.element.classList.contains('is-collapsed')!==hidden) card.element.classList.toggle('is-collapsed',hidden);
  if (hidden) { card.ready = false; return; }
  tokenPut(card.account,item.account); tokenAttr(card.chip,'title',item.account);
  card.body.classList.toggle('is-focusing',Boolean(focused));
  for (const row of rows) {
    const element = card.rows.get(row.key), [, label, reset, value] = element.children, rowUsed = tokenUsed(row.window);
    tokenPut(label,row.label); tokenPut(reset.firstChild,tokenReset(row.window)); tokenPut(reset.lastChild,tokenResetIn(row.window)>0?globalThis.AIWSI18n.text(' sonra sıfırlanır'):'');
    tokenPut(value,tokenPercent(rowUsed)); tokenAttr(value,'data-tone',tokenTone(rowUsed)); tokenAttr(element,'aria-pressed',String(row===shown));
    const pin = element.nextElementSibling, pinned = tokenPinned(item.key,row.key), pinLabel = globalThis.AIWSI18n.text(pinned?'Tablodan kaldır':'Tabloda göster');
    tokenAttr(pin,'aria-pressed',String(pinned)); tokenAttr(pin,'aria-label',`${pinLabel}: ${row.label}`); tokenAttr(pin,'title',pinLabel);
    tokenAttr(element,'aria-label',`${row.label}:${rowUsed==null?globalThis.AIWSI18n.text('Kullanım verisi yok'):globalThis.AIWSI18n.template`${tokenPercent(rowUsed)} kullanıldı · ${tokenWindowDetail(row.window)}`}`);
  }
  // countTo reads null as 0; NaN makes an unknown share print "--".
  if (card.remaining!==remaining) { card.remaining = remaining; tokenUI.motion.countTo(card.big,remaining??NaN,tokenPercent); }
  tokenPut(card.label,used==null?globalThis.AIWSI18n.text('Kullanım verisi yok'):globalThis.AIWSI18n.template`kaldı · ${shown.label}`,animate);
  tokenPut(card.used,used==null?'':globalThis.AIWSI18n.template`${tokenPercent(used)} kullanıldı`,animate); tokenAttr(card.used,'data-tone',tokenTone(used));
  if (card.count!==count||card.colour!==shown.colour) { card.count = count; card.colour = shown.colour; card.waffle.style.setProperty('--cell',shown.colour); card.cells.forEach((cell,index) => cell.classList.toggle('is-used',index<count)); }
  tokenAttr(card.waffle,'aria-label',`${shown.label}: ${used==null?globalThis.AIWSI18n.text('Kullanım verisi yok'):globalThis.AIWSI18n.template`${tokenPercent(used)} kullanıldı`}`);
  // The footer complements the focused row (which already counts down) with the exact reset time, like the reference's share line.
  tokenPut(card.footKey,focused?shown.label:'',animate); tokenPut(card.footText,focused?`· ${tokenWindowDetail(shown.window,true)}`:tokenMeta(item),animate);
  const retry = item.retryAt&&new Date(item.retryAt).getTime()>Date.now() ? globalThis.AIWSI18n.template`İstek sınırı nedeniyle API yeniden denemesi: ${tokenTime(item.retryAt)}` : '';
  tokenPut(card.retry.lastElementChild,retry); if (card.retry.hidden!==!retry) card.retry.hidden = !retry;
  card.ready = true;
}
/** Hovering or focusing a legend row shows its window; leaving the legend or the row returns the card to its first window. */
function bindTokenUsage(host, view) {
  const show = (target, kind, key) => { const card = view.cards.get(target.closest('.token-shell')?.dataset.tokenProvider); if (card&&(card[kind]??null)!==key) { card[kind] = key; patchTokenCard(card,card.item); } };
  host.addEventListener('click',event => {
    if (event.target.closest('[data-token-refresh]')) void checkTokenUsage(true);
    const hide = event.target.closest('[data-token-hide]'), hideCard = hide && view.cards.get(hide.closest('.token-shell')?.dataset.tokenProvider);
    if (hideCard) { const saved = tokenToggleHidden(hideCard.item.key); patchTokenCard(hideCard,hideCard.item); renderTokenUsage(); if (!tokenHidden(hideCard.item.key)) void saved.then(() => checkTokenProvider(tokenProviderId(hideCard.item))); }
    const pin = event.target.closest('[data-token-pin]'), card = pin && view.cards.get(pin.closest('.token-shell')?.dataset.tokenProvider);
    if (card) { tokenTogglePin(card.item.key,pin.dataset.tokenPin); patchTokenCard(card,card.item); renderTokenUsage(); }
  });
  host.addEventListener('pointerover',event => { const row = event.target.closest('.token-row'); if (row) show(row,'hover',row.dataset.tokenWindow); });
  host.addEventListener('pointerout',event => { const legend = event.target.closest('.token-legend'); if (legend&&!legend.contains(event.relatedTarget)) show(legend,'hover',null); });
  host.addEventListener('focusin',event => { const row = event.target.closest('.token-row'); if (row) show(row,'focus',row.dataset.tokenWindow); });
  host.addEventListener('focusout',event => { const row = event.target.closest('.token-row'); if (row&&!row.closest('.token-legend').contains(event.relatedTarget)) show(row,'focus',null); });
}
/** Fills the open usage dialog: skeleton cards until the first answer, one empty card when nothing is known, else a card per provider. */
function patchTokenUsage(host, items) {
  let view = tokenViews.get(host);
  if (!view) { view = {list:$('.token-usage-list',host),error:$('.token-usage-error',host),cards:new Map()}; tokenViews.set(host,view); bindTokenUsage(host,view); }
  tokenPut(view.error,tokenUsageError); if (view.error.hidden!==!tokenUsageError) view.error.hidden = !tokenUsageError;
  const state = items.length ? 'cards' : tokenUsageData||tokenUsageError ? 'empty' : 'loading';
  if (view.state!==state) {
    view.state = state; view.cards.clear();
    const skeleton = '<div class="token-shell" aria-hidden="true"><div class="token-card"><div class="skeleton" style="width:45%;height:14px"></div><div class="skeleton" style="width:62%;height:26px"></div><div class="skeleton" style="height:56px"></div><div class="skeleton" style="height:14px"></div><div class="skeleton" style="width:80%;height:14px"></div></div><div class="token-shell-foot"><div class="skeleton" style="width:46%;height:12px"></div></div></div>';
    view.list.innerHTML = state==='loading' ? `${skeleton}${skeleton}<p class="sr-only" role="status">${globalThis.AIWSI18n.text('Kullanım bilgileri yükleniyor…')}</p>` : state==='empty' ? `<article class="token-shell"><div class="token-card"><p class="token-figure"><span class="token-big-label">${globalThis.AIWSI18n.text('Kullanım verisi yok')}</span></p></div>${tokenShellFoot()}</article>` : '';
  }
  let added = false;
  if (state==='cards') {
    items.forEach((item,index) => {
      let card = view.cards.get(item.key);
      if (!card) {
        const source = document.createElement('template'); source.innerHTML = tokenCardHtml(item); const element = source.content.firstElementChild, part = selector => $(selector,element);
        card = {element,body:part('.token-card'),title:part('.token-card-title'),chip:part('.token-account'),account:part('.token-account-name'),hide:part('[data-token-hide]'),big:part('.token-big'),label:part('.token-big-label'),used:part('.token-used'),waffle:part('.token-waffle'),legend:part('.token-legend'),retry:part('.token-retry'),footKey:part('.token-foot-key'),footText:part('.token-foot-text')};
        card.cells = [...card.waffle.children]; view.cards.set(item.key,card); added = true;
      }
      if (view.list.children[index]!==card.element) view.list.insertBefore(card.element,view.list.children[index]||null);
      patchTokenCard(card,item);
    });
    for (const [key,card] of view.cards) if (!items.some(item => item.key===key)) { card.element.remove(); view.cards.delete(key); }
  }
  if (added) tokenUI.motion.enter(view.list,'.token-shell','data-token-provider',{stagger:50});
  // Each card's remote check (opening the dialog or Yenile) shows a spinner until its own provider answers and then "Güncel" for a
  // moment; the quiet local poll shows neither. aria-disabled instead of disabled keeps keyboard focus on the button while it works.
  for (const button of host.querySelectorAll('[data-token-refresh]')) {
    const card = view.cards.get(button.closest('.token-shell')?.dataset.tokenProvider), refresh = card ? tokenCheckState(tokenProviderId(card.item)) : tokenUsageChecks.size ? 'busy' : '';
    if ((button.dataset.state||'')!==refresh) { button.innerHTML = tokenRefreshContent(refresh); tokenAttr(button,'data-state',refresh); tokenAttr(button,'aria-disabled',refresh==='busy'?'true':''); }
  }
}
$('#token-countdown').onclick=()=>{
  showModal(globalThis.AIWSI18n.text('Token ve kota kullanımı'),`<div id="token-usage-detail" class="token-usage"><p class="form-hint">${globalThis.AIWSI18n.text('Kalan abonelik kotası ve sağlayıcının bildirdiği sıfırlanma süresi. Veriler kontrol merkezinin çalıştığı hesaba aittir.')}</p><p class="token-usage-error" data-tone="failed" role="alert" hidden></p><div class="token-usage-list"></div></div><div class="modal-footer"><p class="form-hint">${globalThis.AIWSI18n.text('Yerel veri dakikada bir okunur; API en fazla 5 dakikada bir sorulur, Yenile hemen sorar.')}</p></div>`,undefined,{size:'wide'});
  renderTokenUsage();void checkTokenUsage();
};
