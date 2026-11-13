'use strict';
// A terminal workspace: panes in a layout tree, one terminal view per pane.
// A terminal workspace shows its panes in a layout tree that can be split, resized and rearranged by dragging.
// The project and All projects Terminal tabs share it; options supply the parts that differ:
// storageKey, update(), titles(items), paneHead(item,title,status,multiple), exitHtml(item,status),
// terminal(item) for AIWSTerminal.create, close(runId), and optional rename(runId), restart(runId), toTask(runId), status(item)
// and content(item,host), which shows something other than a terminal in the pane when it returns true.
function terminalWorkspace(element,options){
  const layout=loadTerminalLayout(options.storageKey);
  const entry={element,items:[],selected:null,layout,savedLayout:JSON.stringify(layout),layoutKey:'',views:new Map(),renaming:null,...options};
  element.addEventListener('click',event=>{
    const shortcutsPop=element.querySelector('[data-shortcuts-pop]'),shortcutsToggle=element.querySelector('[data-shortcuts-toggle]');
    if(shortcutsPop&&!shortcutsPop.hidden&&!event.target.closest('[data-shortcuts-toggle]')&&!event.target.closest('[data-shortcuts-pop]')){shortcutsPop.hidden=true;shortcutsToggle.setAttribute('aria-expanded','false');}
    const target=event.target.closest('button');if(!target||target.disabled)return;
    if(target.hasAttribute('data-shortcuts-toggle')){shortcutsPop.hidden=!shortcutsPop.hidden;target.setAttribute('aria-expanded',String(!shortcutsPop.hidden));}
    else if(target.dataset.terminalTitle){if(entry.rename&&entry.pressedSelected&&entry.renaming!==target.dataset.terminalTitle)entry.rename(target.dataset.terminalTitle);else selectTerminal(entry,target.dataset.terminalTitle,{focus:true});}
    else if(target.dataset.terminalFloat){const pane=entry.views.get(target.dataset.terminalFloat);window.AIWSUI.floatConsole(pane.host,entry.titles(entry.items).get(target.dataset.terminalFloat));}
    else if(target.dataset.terminalClear){entry.views.get(target.dataset.terminalClear)?.view?.clear?.();}
    else if(target.dataset.terminalClose)void entry.close(target.dataset.terminalClose);
    else if(target.dataset.terminalRestart)void entry.restart?.(target.dataset.terminalRestart);
    else if(target.dataset.terminalTask)void entry.toTask?.(target.dataset.terminalTask);
  });
  element.addEventListener('dblclick',event=>{const title=event.target.closest('[data-terminal-title]');if(title)entry.rename?.(title.dataset.terminalTitle);});
  element.addEventListener('pointerdown',event=>{const pane=event.target.closest('[data-terminal-pane]');entry.pressedSelected=Boolean(pane&&pane.dataset.terminalPane===entry.selected);if(pane&&pane.dataset.terminalPane!==entry.selected)selectTerminal(entry,pane.dataset.terminalPane);},true);
  element.addEventListener('pointerdown',event=>{if(event.target.closest('.terminal-resizer'))startTerminalResize(entry,event);else if(event.target.closest('.terminal-pane-head'))startTerminalDrag(entry,event);});
  element.querySelector('[data-terminal-grid]').addEventListener('keydown',event=>{
    const title=event.target.closest('[data-terminal-title]');if(!title)return;
    if(event.key==='F2'&&entry.rename){event.preventDefault();entry.rename(title.dataset.terminalTitle);}
    else if(event.key==='Delete'){event.preventDefault();void entry.close(title.dataset.terminalTitle);}
  });
  return entry;
}
function selectTerminal(entry,runId,{focus=false}={}){
  if(!entry.items.some(run=>run.id===runId))return;
  entry.selected=runId;entry.update();
  if(focus)requestAnimationFrame(()=>{const view=entry.views.get(runId)?.view;if(view?.terminal&&runId===entry.selected)view.terminal.focus?.();});
}
function forgetTerminalPane(entry,runId){
  const view=entry.views.get(runId),tile=consoleViews.get(`tile:${runId}`);if(tile){floatingConsoles.get(tile.element)?.close();tile.controller.destroy();consoleViews.delete(`tile:${runId}`);}floatingConsoles.get(view?.host)?.close();view?.view?.destroy();view?.pane.remove();entry.views.delete(runId);
  // Focus moves to the closed pane's nearest neighbour in reading order.
  const order=layoutIds(entry.layout),index=order.indexOf(runId);
  entry.items=entry.items.filter(run=>run.id!==runId);entry.layout=layoutRemove(entry.layout,runId);
  if(entry.selected===runId)entry.selected=(index>=0?order[index+1]||order[index-1]:null)||entry.items[0]?.id||null;
}
function terminalPane(entry,run){
  let pane=entry.views.get(run.id);if(pane)return pane;
  const element=document.createElement('div');element.className='terminal-pane';element.dataset.terminalPane=run.id;element.id=`terminal-pane-${run.id}`;element.setAttribute('role','group');
  element.innerHTML=`<div class="terminal-pane-head"></div><div class="project-shell-host terminal-host"></div><div class="terminal-exit-bar" hidden></div>`;
  pane={pane:element,host:element.querySelector('.project-shell-host'),view:null,head:''};entry.views.set(run.id,pane);return pane;
}
function buildTerminalLayout(entry,node,path){
  if(node.id)return entry.views.get(node.id).pane;
  const split=document.createElement('div');split.className=`terminal-split terminal-split-${node.dir}`;
  node.children.forEach((child,index)=>{
    if(index){const handle=document.createElement('div');handle.className='terminal-resizer';handle.dataset.terminalResize=path;handle.dataset.terminalResizeIndex=String(index);handle.setAttribute('role','separator');handle.setAttribute('aria-orientation',node.dir==='row'?'vertical':'horizontal');split.append(handle);}
    split.append(buildTerminalLayout(entry,child,`${path}.${index}`));
  });
  return split;
}
function applyTerminalSizes(element,node){
  if(!node||node.id)return;
  const cells=[...element.children].filter(child=>!child.classList.contains('terminal-resizer'));
  node.children.forEach((child,index)=>{if(!cells[index])return;cells[index].style.flex=`${node.sizes[index]*1e4} 1 0`;applyTerminalSizes(cells[index],child);});
}
// The layout's DOM is rebuilt only when its shape changes: moving a pane drops the focus of its terminal.
function renderTerminalLayout(entry){
  // A saved layout can name terminals that are still loading; it is drawn once all of them are there.
  const layout=layoutIds(entry.layout).every(runId=>entry.views.has(runId))?entry.layout:null;
  const grid=entry.element.querySelector('[data-terminal-grid]'),key=JSON.stringify(layoutShape(layout));
  if(key!==entry.layoutKey){
    const focused=grid.contains(document.activeElement);entry.layoutKey=key;
    grid.replaceChildren(...(layout?[buildTerminalLayout(entry,layout,'root')]:[]));
    if(layout?.id)grid.firstElementChild.style.flex='';
    for(const pane of entry.views.values())pane.view?.resize();
    if(focused)requestAnimationFrame(()=>entry.views.get(entry.selected)?.view?.terminal?.focus?.());
  }
  applyTerminalSizes(grid.firstElementChild,layout);
}
// Brings the panes in line with entry.items: layout, focus, headers, exit bars and one terminal view per item.
function renderTerminalPanes(entry){
  for(const item of entry.items)terminalPane(entry,item);
  syncTerminalLayout(entry);
  if(!entry.selected||!entry.items.some(item=>item.id===entry.selected))entry.selected=layoutIds(entry.layout)[0]||entry.items[0]?.id||null;
  const titles=entry.titles(entry.items),multiple=entry.items.length>1;
  entry.element.querySelector('[data-terminal-stage]').classList.toggle('multiple',multiple);
  renderTerminalLayout(entry);
  for(const item of entry.items){
    const pane=entry.views.get(item.id),status=(entry.status||terminalStatus)(item),title=titles.get(item.id);
    pane.pane.classList.toggle('focused',item.id===entry.selected&&multiple);pane.pane.setAttribute('aria-label',title);
    const head=entry.paneHead(item,title,status,multiple)+terminalPaneButton('float',`data-terminal-float="${esc(item.id)}"`,globalThis.AIWSI18n.text('Konsolu açılır pencereye al'))+entry.paneClose(item,title);
    if(pane.head!==head&&entry.renaming!==item.id){const focused=pane.pane.querySelector('.terminal-pane-head').contains(document.activeElement)?document.activeElement.dataset.terminalTitle?'title':'close':null;pane.pane.querySelector('.terminal-pane-head').innerHTML=head;pane.head=head;if(focused)pane.pane.querySelector(focused==='title'?'.terminal-pane-title':'.terminal-pane-close')?.focus();}
    pane.pane.querySelector('.terminal-pane-title')?.setAttribute('aria-current',String(item.id===entry.selected));
    const exit=pane.pane.querySelector('.terminal-exit-bar'),exitHtml=entry.exitHtml(item,status);
    exit.hidden=!exitHtml;if(exit.dataset.html!==exitHtml){exit.innerHTML=exitHtml;exit.dataset.html=exitHtml;}
    if(!pane.view&&entry.content?.(item,pane.host))continue;
    if(!pane.view){pane.view=window.AIWSTerminal.create(pane.host,{run:item,...entry.terminal(item),onError:error=>toast(error.message)});pane.run=item;pane.view.resize();}
    else if(pane.run!==item||pane.status!==item.status){pane.view.update(item);pane.run=item;}
    pane.status=item.status;
  }
}
