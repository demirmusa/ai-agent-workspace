'use strict';
// Terminal icons, status dots, statuses and titles shared by terminal panes and session lists.
function terminalIcon(provider){return provider&&provider!=='command'&&providerIconPaths[provider]?`<span class="terminal-icon ${esc(provider)}" aria-hidden="true"><img src="${esc(providerIconPaths[provider])}" alt="" width="14" height="14"></span>`:terminalMonogram(provider);}
// A provider without an icon shows the monogram of its registry name; a shell or command shows a prompt.
function terminalMonogram(provider){const mark=provider&&provider!=='command'?window.AIWSUI.providerMonogram(providers[provider]):'>_';return `<span class="terminal-icon ${mark==='>_'?'shell':'monogram'}" aria-hidden="true">${esc(mark)}</span>`;}
// Status dots in terminal headers, exit bars and session lists: a running terminal pings in the running tone, the others take theirs.
const terminalDotTones={running:'running',waiting:'needs',failed:'failed'};
function terminalDot(status,label=''){return `<span class="terminal-dot ui-dot ${status.className}${status.className==='running'?' is-live':''}" data-tone="${terminalDotTones[status.className]||'idle'}"${label?` role="img" aria-label="${esc(label)}"`:' aria-hidden="true"'}></span>`;}
// Pane header buttons: one outline icon each, so the header reads the same in every terminal list.
const terminalPaneIcons={
  task:'<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9zM9 13l2 2 4-4"/>',
  open:'<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  clear:'<path d="M20 20H9L4.5 15.5a2 2 0 0 1 0-2.8l8-8a2 2 0 0 1 2.8 0l4.2 4.2a2 2 0 0 1 0 2.8L12 18"/><path d="M8 11l6 6"/>',
  restart:'<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  float:'<rect x="3" y="9" width="12" height="12" rx="2"/><path d="M13 3h8v8M21 3l-9 9"/>',
  close:'<path d="M6 6l12 12M18 6L6 18"/>'
};
function terminalPaneButton(icon,attr,title,label=title){return `<button type="button" class="terminal-pane-close" ${attr} aria-label="${esc(label)}" title="${esc(title)}"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${terminalPaneIcons[icon]}</svg></button>`;}
// The pane header button that clears a terminal's screen.
function terminalClearButton(id,title){return terminalPaneButton('clear',`data-terminal-clear="${esc(id)}"`,globalThis.AIWSI18n.text('Terminali temizle'),`${title} ${globalThis.AIWSI18n.text('terminalini temizle')}`);}
function terminalStatus(run){return run.status==='running'?{className:'running',label:globalThis.AIWSI18n.text('Çalışıyor')}:{className:run.exitCode===0?'exited':'failed',label:globalThis.AIWSI18n.template`Kapandı · Çıkış kodu: ${run.exitCode??'?'}`};}
function terminalTitles(items){const seen=new Map();return new Map(items.map(run=>{const title=run.title||(run.terminalKind==='agent'?providers[run.provider]:'Terminal'),count=(seen.get(title)||0)+1;seen.set(title,count);return [run.id,count>1?`${title} ${count}`:title];}));}
