'use strict';
// The Live sessions tab of All projects: every live session as a card, grouped by what it needs. AIWS runs open in the
// All projects Terminal tab (all-terminals.js); provider CLI sessions started outside AIWS open read-only.
let sessionPage=null;
function storeSessionValue(key,value){try{localStorage.setItem(key,value);}catch{/* Storage may be disabled; the choice then lasts for this page. */}}
function sessionsPage(){
  if(sessionPage)return sessionPage;
  const element=document.createElement('section');element.className='session-workspace';
  element.innerHTML=globalThis.AIWSI18n.template`<header class="session-bar"><label class="search-box session-search"><span aria-hidden="true">⌕</span><input type="search" data-session-search placeholder="Oturum, proje veya agent ara…" aria-label="Oturumlarda ara"></label><span class="session-bar-total" data-session-total></span><button type="button" class="button small ghost" data-refresh-live title="Harici oturumları yenile" aria-label="Harici oturumları yenile"></button></header><div class="session-overview" data-session-overview></div>`;
  const entry={root:element,overviewHtml:'',filter:'all',query:''};
  element.querySelector('[data-session-search]').addEventListener('input',event=>{entry.query=event.target.value;updateSessionsPage();});
  const activate=card=>{const key=card.dataset.sessionCard;if(key.startsWith('external:'))openExternalSession(key.slice(9));else openSessionTerminal(key);};
  element.addEventListener('click',event=>{
    const filter=event.target.closest('[data-session-filter]');if(filter){entry.filter=filter.dataset.sessionFilter===entry.filter?'all':filter.dataset.sessionFilter;updateSessionsPage();return;}
    const card=event.target.closest('[data-session-card]');if(card&&!event.target.closest('button'))activate(card);
  });
  element.addEventListener('keydown',event=>{const card=event.target.closest?.('[data-session-card]');if(card&&event.target===card&&(event.key==='Enter'||event.key===' ')){event.preventDefault();activate(card);}});
  sessionPage=entry;return entry;
}
function updateSessionsPage(){
  const entry=sessionsPage(),root=entry.root;
  const refresh=root.querySelector('[data-refresh-live]'),glyph=liveSessions.loading?'<span class="ui-spinner" aria-hidden="true"></span>':'↻';refresh.disabled=liveSessions.loading;if(refresh.innerHTML!==glyph)refresh.innerHTML=glyph;
  const html=sessionOverviewHtml(entry,sessionEntries(),sessionTerminals().open);
  if(entry.overviewHtml===html)return;
  const host=root.querySelector('[data-session-overview]'),focused=document.activeElement?.dataset?.sessionCard??document.activeElement?.dataset?.sessionFilter;
  host.innerHTML=html;entry.overviewHtml=html;refreshRunTimers(host);
  if(focused)host.querySelector(`[data-session-card="${CSS.escape(focused)}"],[data-session-filter="${CSS.escape(focused)}"]`)?.focus();
  window.AIWSUI.motion.enter(host,'[data-session-card]','data-session-card');
}
function renderSessions(){
  const entry=sessionsPage(),board=$('#board');board.className='board project-terminal-board session-terminal-board';
  if(entry.root.parentElement!==board)board.replaceChildren(entry.root);
  updateSessionsPage();if(!liveSessions.loaded&&!liveSessions.loading)void loadLiveSessions();
}
