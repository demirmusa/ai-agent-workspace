'use strict';
// The new terminal menu and the empty state of the project Terminal tab.
// The agent CLIs found on PATH, read once and on request.
const terminalAgents={items:null,loading:null,error:''};
function loadTerminalAgents(refresh=false){
  if(terminalAgents.loading&&!refresh)return terminalAgents.loading;
  const request=terminalAgents.loading=api(`/terminal-agents${refresh?'?refresh=1':''}`).then(items=>{if(terminalAgents.loading===request){terminalAgents.items=items;terminalAgents.error='';}}).catch(error=>{if(terminalAgents.loading===request)terminalAgents.error=error.message;}).finally(()=>{if(terminalAgents.loading===request)terminalAgents.loading=null;refreshTerminalMenus();});
  return request;
}
// claude-swap can gain or lose accounts outside AIWS, so every menu open and agent search reads them again past the server's cache;
// the menu shows the last listing until the new one arrives.
function loadTerminalAccounts(){for(const provider of accountProviders)void loadProviderAccounts(provider,true);}
function refreshTerminalMenus(){for(const id of projectShells.keys())if(terminalVisible(id))updateShell(id);if(allTerminalsVisible())updateSessionTerminals();}
const toggleTerminalMenu=(id,open)=>setTerminalMenu(shellEntry(id),open);
function setTerminalMenu(entry,open){
  const menu=entry.element.querySelector('[data-terminal-menu-list]'),next=open??menu.hidden;
  if(next&&!terminalAgents.items&&!terminalAgents.loading)void loadTerminalAgents();if(next)loadTerminalAccounts();
  menu.hidden=!next;entry.element.querySelector('[data-terminal-menu]').setAttribute('aria-expanded',String(next));
  if(next){entry.update();menu.querySelector('[role="menuitem"]:not(:disabled)')?.focus();}
}
// An open menu follows the state without losing the focused item.
function syncTerminalMenu(entry,html){
  const menu=entry.element.querySelector('[data-terminal-menu-list]');if(menu.hidden)return;
  const next=html();if(entry.menuHtml===next)return;
  const focused=document.activeElement?.dataset?.terminalOpen;menu.innerHTML=next;entry.menuHtml=next;if(focused)menu.querySelector(`[data-terminal-open="${CSS.escape(focused)}"]`)?.focus();
}
document.addEventListener('pointerdown',event=>{for(const entry of [...projectShells.values(),...(sessionWorkspace?[sessionWorkspace]:[])]){const menu=entry.element.querySelector('[data-terminal-menu-list]');if(!menu.hidden&&!event.target.closest?.('.terminal-new'))setTerminalMenu(entry,false);}});
// One-click buttons beside +: a plain shell first, then every installed agent whose provider is enabled.
function syncTerminalQuick(entry){
  const quick=entry.element.querySelector('[data-terminal-quick]'),t=globalThis.AIWSI18n.text;
  const shell=`<button type="button" data-terminal-open="shell" title="${esc(`${t('Yeni terminal')}: ${shellName}`)}" aria-label="${esc(`${t('Yeni terminal')}: ${shellName}`)}">${terminalIcon('command')}</button>`;
  const html=shell+(terminalAgents.items||[]).filter(agent=>agent.available&&providerEnabled(agent.provider)).map(agent=>`<button type="button" data-terminal-open="agent:${esc(agent.provider)}" title="${esc(`${t('Yeni terminal')}: ${providers[agent.provider]}`)}" aria-label="${esc(`${t('Yeni terminal')}: ${providers[agent.provider]}`)}">${terminalIcon(agent.provider)}</button>`).join('');
  if(entry.quickHtml!==html){quick.innerHTML=html;entry.quickHtml=html;}quick.hidden=!html;
}
// sessions: the running task sessions offered in the menu; the project menu shows its own, All projects shows every project's.
// terminals: All projects also lists every project's terminals, so a hidden one can be shown again.
function terminalMenuHtml(sessions,terminals=''){
  const agents=terminalAgents.items||[],byProvider=new Map(agents.map(agent=>[agent.provider,agent]));
  const items=terminalAgentOrder.filter(provider=>byProvider.has(provider)||historyProviders.includes(provider)).map(provider=>{const agent=byProvider.get(provider),available=Boolean(agent?.available),hint=!terminalAgents.items?globalThis.AIWSI18n.text(terminalAgents.error?'Agentlar alınamadı':'Aranıyor…'):available?globalThis.AIWSI18n.text('Etkileşimli CLI'):globalThis.AIWSI18n.text('PATH üzerinde bulunamadı');return `<button type="button" role="menuitem" class="terminal-menu-item" data-terminal-open="agent:${esc(provider)}" ${available?'':'disabled aria-disabled="true"'} title="${esc(available?agent.path:agent?.reason||hint)}">${terminalIcon(provider)}<span><strong>${esc(providers[provider])}</strong><small>${esc(hint)}</small></span></button>${available?terminalAccountItems(provider):''}`;}).join('');
  return globalThis.AIWSI18n.template`<div class="terminal-menu-section">Terminal</div><button type="button" role="menuitem" class="terminal-menu-item" data-terminal-open="shell">${terminalIcon('command')}<span><strong>${shellName}</strong><small>Proje klasöründe komut satırı</small></span><kbd>Ctrl+Shift+T</kbd></button><div class="terminal-menu-section">Agentlar<button type="button" class="terminal-menu-refresh" data-terminal-agents-refresh title="Agentları yeniden ara" aria-label="Agentları yeniden ara">↻</button></div>${items}${terminals?globalThis.AIWSI18n.template`<div class="terminal-menu-section">Proje terminalleri</div>${terminals}`:''}<div class="terminal-menu-section">Çalışan görevler</div>${sessions}`;
}
// Running task sessions; picking one shows it in a pane like any other terminal. withProject names each run's project.
function terminalSessionItems(runs,open,withProject=false){
  const t=globalThis.AIWSI18n.text;
  if(!runs.length)return `<p class="terminal-menu-empty">${esc(t('Şu an çalışan oturum yok.'))}</p>`;
  return runs.map(run=>{const item=state.tasks.find(task=>task.id===run.taskId),title=consoleTitle(run);return `<button type="button" role="menuitem" class="terminal-menu-item" data-terminal-open="session:${esc(run.id)}" aria-current="${open.includes(run.id)}" title="${esc(title)}">${terminalIcon(run.provider)}<span><strong>${esc(title)}</strong><small>${esc([withProject?state.projects.find(value=>value.id===item.projectId)?.name:'',runAgentName(run)].filter(Boolean).join(' · '))}</small></span>${window.AIWSUI.statusPill(item.status,statuses[item.status]||item.status)}</button>`;}).join('');
}
/** A provider's accounts as separate items once its account manager lists several; with one account the plain agent item is enough. The default login stays the plain item. */
function terminalAccountItems(provider){
  if(!accountProviders.includes(provider))return '';
  const t=globalThis.AIWSI18n.text,accounts=providerAccountList(provider),status=providerAccountState(provider).status;if(!status?.tool.installed||accounts.length<2)return '';
  return accounts.filter(account=>!account.active).map(account=>`<button type="button" role="menuitem" class="terminal-menu-item" data-terminal-open="agent:${esc(provider)}:${esc(account.id)}" title="${esc(account.email)}">${terminalIcon(provider)}<span><strong>${esc(account.label)}</strong><small>${esc(providers[provider])} · ${esc(t('Hesap'))}</small></span></button>`).join('');
}
function terminalEmptyHtml(){
  const agents=(terminalAgents.items||[]).filter(agent=>agent.available);
  return globalThis.AIWSI18n.template`<div class="terminal-empty-card"><div class="terminal-empty-glyph" aria-hidden="true">&gt;_</div><h2>Bu projede açık terminal yok</h2><p>Proje klasöründe bir komut satırı aç ya da bir agentla doğrudan terminalden konuş.</p><div class="terminal-empty-actions"><button type="button" class="button primary" data-terminal-open="shell">${terminalIcon('command')} ${shellName}</button>${agents.map(agent=>`<button type="button" class="button" data-terminal-open="agent:${esc(agent.provider)}" title="${esc(agent.path)}">${terminalIcon(agent.provider)} ${esc(providers[agent.provider])}</button>`).join('')}</div><p class="terminal-empty-hint">${!terminalAgents.items?globalThis.AIWSI18n.text('Kurulu agentlar aranıyor…'):agents.length?globalThis.AIWSI18n.text('Kısayollar: Ctrl+Shift+T yeni shell · Ctrl+PageUp/PageDown terminaller arası · F2 yeniden adlandır · Alt+Shift+D böl'):globalThis.AIWSI18n.text('PATH üzerinde Codex veya Claude Code bulunamadı. Kurduktan sonra + menüsünden yeniden ara.')}</p></div>`;
}
