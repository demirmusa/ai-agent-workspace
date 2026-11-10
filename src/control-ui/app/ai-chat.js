'use strict';
// The AI sheet's conversation column: your messages as bubbles, AI replies rendered as Markdown, entering one by one.
function aiMountChat(element){
  // The conversation column starts closed where it would cover the canvas.
  const chat=element.querySelector('#ai-chat-toggle'),showChat=open=>{element.classList.toggle('is-chat-hidden',!open);chat.setAttribute('aria-expanded',String(open));};
  showChat(!window.matchMedia?.('(max-width: 900px)')?.matches);chat.onclick=()=>showChat(element.classList.contains('is-chat-hidden'));
}
// One conversation entry; its role and time key the entrance, so a re-render animates only new messages.
function aiMessageHtml(entry){
  const t=globalThis.AIWSI18n,{icon,sparkle}=window.AIWSUI,key=esc(`${entry.role}:${entry.at||''}`);
  if(entry.role==='user')return t.template`<article class="ai-message user${entry.failed?' failed':''}" data-ai-message="${key}"><strong class="sr-only">Sen</strong><p>${esc(entry.text)}</p></article>`;
  if(entry.role==='error')return `<article class="ai-message error" data-tone="failed" data-ai-message="${key}" role="alert">${icon('triangle')}<p>${esc(entry.text)}</p></article>`;
  return t.template`<article class="ai-message assistant" data-ai-message="${key}"><span class="ai-avatar" data-tone="accent">${sparkle('accent')}</span><div class="ai-message-body"><strong class="ai-message-name">AI</strong><div class="cv-markdown">${window.AIWSAgentConsole?.markdown(entry.text)||`<p>${esc(entry.text)}</p>`}</div>${entry.drafts?t.template`<small class="ai-message-drafts" data-tone="accent">${entry.drafts} taslak önerildi</small>`:''}</div></article>`;
}
// The sheet re-renders on every streamed planner event; an entry's HTML (Markdown for AI replies) is built again only when it changed.
const aiMessageCache=new WeakMap();
function aiCachedMessageHtml(entry){const key=`${entry.role}|${entry.at}|${entry.failed?1:0}|${entry.drafts||0}|${entry.text}`,cached=aiMessageCache.get(entry);if(cached?.key===key)return cached.html;const html=aiMessageHtml(entry);aiMessageCache.set(entry,{key,html});return html;}
function renderAIChat(workspace){
  const log=workspace.element.querySelector('#ai-chat-log');if(setHtml(log,workspace.messages.map(aiCachedMessageHtml).join('')||globalThis.AIWSI18n.text('<p class="ai-chat-placeholder">İsteklerin ve AI yanıtları burada görünür.</p>')))log.scrollTop=log.scrollHeight;
  window.AIWSUI.motion.enter(log,'[data-ai-message]','data-ai-message',{stagger:40,max:4});
}
