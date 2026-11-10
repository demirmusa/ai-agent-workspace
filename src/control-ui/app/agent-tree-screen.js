'use strict';
// The agent hierarchy on the full screen: the canvas fills the workspace and choosing an agent opens its record in the side panel from the right.
function openAgentScreen(parentKey,path,button){
  closeAgentScreen(false);closeChildAgent(false);ensureAgentSource(path);
  const element=document.createElement('section');element.className='agent-screen';element.setAttribute('role','dialog');element.setAttribute('aria-modal','true');element.setAttribute('aria-labelledby','agent-screen-title');
  const exit=globalThis.AIWSI18n.text('Tam ekrandan çık'),close=globalThis.AIWSI18n.text('Alt agent panelini kapat');
  element.innerHTML=`<header class="panel-header"><div class="detail-heading"><h2 id="agent-screen-title">${esc(globalThis.AIWSI18n.text('Agentlar'))}</h2></div><div class="panel-actions"><button type="button" class="icon-button" data-agent-screen="exit" title="${esc(exit)}" aria-label="${esc(exit)}">${window.AIWSUI.icon('expand')}</button><button type="button" class="icon-button" data-agent-screen="close" title="${esc(close)}" aria-label="${esc(close)}">${window.AIWSUI.icon('x')}</button></div></header><div class="agent-console-host"></div>`;
  ($('#task-panel')||document.body).after(element);
  agentScreen={element,parentKey,path,returnFocus:button,controller:window.AIWSAgentConsole.agentFlow(element.querySelector('.agent-console-host'),agentTreeData(parentKey,path))};
  element.onclick=event=>{const action=event.target.closest('[data-agent-screen]')?.dataset.agentScreen;if(action==='close')closeAgentScreen();else if(action==='exit'){const {parentKey:key,path:source,returnFocus}=agentScreen;closeAgentScreen(false);openAgentTree(key,source,returnFocus);}};
  applyDetailWidth();element.querySelector('[data-agent-screen=close]').focus({preventScroll:true});
}
function renderAgentScreen(){if(agentScreen)agentScreen.controller.update(agentTreeData(agentScreen.parentKey,agentScreen.path));}
function closeAgentScreen(restoreFocus=true){
  const screen=agentScreen;if(!screen)return;agentScreen=null;
  // The record drawer belongs to the screen it opened from.
  if(childAgentSelection?.fromScreen)closeChildAgent(false);
  screen.controller.destroy();screen.element.remove();applyDetailWidth();
  if(restoreFocus)(screen.returnFocus?.isConnected?screen.returnFocus:$('#close-panel'))?.focus({preventScroll:true});
}
window.addEventListener('pagehide',()=>closeAgentScreen(false));
