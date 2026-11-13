'use strict';
// Floating agent consoles over the workspace.
// Modeless members of the shared modal shell keep their live console mounted.
const floatingConsoles=new Map();
function workspaceHasFloatingConsole(entry){return Boolean(entry&&[...entry.views.values()].some(pane=>floatingConsoles.has(pane.host)||pane.host.querySelector('.floating-console-placeholder')));}
function floatingConsoleMetrics(){
  const theme=getComputedStyle(document.documentElement),read=name=>parseFloat(theme.getPropertyValue(`--floating-console-${name}`));
  return {header:read('header-height'),dockWidth:read('dock-width'),inset:read('inset'),gap:read('gap')};
}
function floatingConsoleBounds(){
  const {inset:preferred}=floatingConsoleMetrics(),inset=Math.min(preferred,innerWidth/4,innerHeight/4);
  return {left:inset,top:inset,right:innerWidth-inset,bottom:innerHeight-inset,width:innerWidth-inset*2,height:innerHeight-inset*2};
}
function constrainFloatingConsole(rect){
  const bounds=floatingConsoleBounds(),width=Math.min(rect.width,bounds.width),height=Math.min(rect.height,bounds.height);
  return {width,height,x:Math.max(bounds.left,Math.min(rect.x,bounds.right-width)),y:Math.max(bounds.top,Math.min(rect.y,bounds.bottom-height))};
}
function resizeFloatingConsole(rect,edge,dx,dy){
  const bounds=floatingConsoleBounds(),minWidth=Math.min(280,bounds.width),minHeight=Math.min(180,bounds.height);
  let left=rect.x,right=rect.x+rect.width,top=rect.y,bottom=rect.y+rect.height;
  if(edge.includes('w'))left=Math.max(bounds.left,Math.min(left+dx,right-minWidth));
  if(edge.includes('e'))right=Math.min(bounds.right,Math.max(right+dx,left+minWidth));
  if(edge.includes('n'))top=Math.max(bounds.top,Math.min(top+dy,bottom-minHeight));
  if(edge.includes('s'))bottom=Math.min(bounds.bottom,Math.max(bottom+dy,top+minHeight));
  return {x:left,y:top,width:right-left,height:bottom-top};
}
function layoutFloatingConsoleDock(){
  const docked=[...floatingConsoles.values()].filter(view=>view.minimized),bounds=floatingConsoleBounds(),metrics=floatingConsoleMetrics();
  const height=Math.min(metrics.header,bounds.height),rows=Math.max(1,Math.floor((bounds.height+metrics.gap)/(height+metrics.gap)));
  // Wrap to rows above the bottom edge; on a small viewport narrow the tiles to keep every row inside it.
  const columns=Math.max(1,Math.floor((bounds.width+metrics.gap)/(metrics.dockWidth+metrics.gap)),Math.ceil(docked.length/rows));
  const gap=Math.min(metrics.gap,bounds.width/(columns*2)),width=Math.min(metrics.dockWidth,(bounds.width-gap*(columns-1))/columns);
  docked.forEach((view,index)=>view.placeDock({x:bounds.left+(index%columns)*(width+gap),y:bounds.bottom-height-Math.floor(index/columns)*(height+metrics.gap),width,height}));
}
function createFloatingConsole(title,element){
  const existing=floatingConsoles.get(element);if(existing){existing.restore();return existing;}
  const marker=document.createElement('div');marker.className='floating-console-placeholder';marker.textContent=globalThis.AIWSI18n.text('Konsol açılır pencerede');element.before(marker);
  const panel=document.createElement('dialog');panel.className='app-modal floating-console';panel.tabIndex=-1;panel.setAttribute('aria-label',title);
  panel.innerHTML=`<header class="modal-header"><button type="button" class="floating-console-title" data-float="restore"></button><button type="button" class="icon-button" data-float="minimize">−</button><button type="button" class="icon-button" data-float="fullscreen">□</button><button type="button" class="icon-button" data-float="dock">↙</button></header><div class="floating-console-body"></div>`;
  panel.querySelector('.floating-console-title').textContent=title;
  const label=(button,text)=>{button.title=globalThis.AIWSI18n.text(text);button.setAttribute('aria-label',button.title);};
  for(const [action,text] of Object.entries({restore:'Konsolu geri aç',minimize:'Küçült',fullscreen:'Tam ekran',dock:'Konsolu yerine döndür'}))label(panel.querySelector(`[data-float="${action}"]`),text);
  const edges={n:'Üst kenar',e:'Sağ kenar',s:'Alt kenar',w:'Sol kenar',nw:'Sol üst köşe',ne:'Sağ üst köşe',sw:'Sol alt köşe',se:'Sağ alt köşe'};
  for(const [edge,name] of Object.entries(edges)){
    const handle=document.createElement('button');handle.type='button';handle.className='floating-console-edge';handle.dataset.floatResize=edge;
    label(handle,globalThis.AIWSI18n.text('Konsolu boyutlandır')+' · '+globalThis.AIWSI18n.text(name));panel.append(handle);
  }
  panel.querySelector('.floating-console-body').append(element);document.body.append(panel);panel.show();
  let rect=constrainFloatingConsole({x:16+floatingConsoles.size*24,y:innerHeight-376-floatingConsoles.size*24,width:560,height:360}),minimized=false,fullscreen=false,restoreFullscreen=false,dockRect=null,suppressClick=false,finishPointer=null;
  const fit=()=>{for(const view of terminalViews)if(element.contains(view.element))view.resize();for(const entry of projectShells.values())for(const pane of entry.views.values())if(element.contains(pane.view?.element))pane.view.resize();for(const pane of sessionWorkspace?.views.values()||[])if(element.contains(pane.view?.element))pane.view.resize();};
  const place=box=>Object.assign(panel.style,{left:`${box.x}px`,top:`${box.y}px`,width:`${box.width}px`,height:`${box.height}px`});
  const layout=()=>{
    panel.classList.toggle('is-minimized',minimized);panel.classList.toggle('is-fullscreen',fullscreen);
    panel.querySelector('.floating-console-body').hidden=minimized;
    for(const handle of panel.querySelectorAll('[data-float-resize]'))handle.hidden=minimized||fullscreen;
    panel.querySelector('[data-float="restore"]').setAttribute('aria-expanded',String(!minimized));
    panel.querySelector('[data-float="fullscreen"]').setAttribute('aria-pressed',String(fullscreen));
    const minimize=panel.querySelector('[data-float="minimize"]');minimize.textContent=minimized?'▢':'−';label(minimize,minimized?'Konsolu geri aç':'Küçült');
    if(fullscreen)place({x:0,y:0,width:innerWidth,height:innerHeight});
    else if(!minimized){rect=constrainFloatingConsole(rect);place(rect);}
    layoutFloatingConsoleDock();fit();
  };
  const api={panel,get minimized(){return minimized;},placeDock(box){dockRect=box;place(box);},restore(){
    if(minimized){rect=constrainFloatingConsole({...rect,x:dockRect.x,y:dockRect.y+dockRect.height-rect.height});fullscreen=restoreFullscreen;minimized=false;}
    layout();panel.focus({preventScroll:true});
  },close(){finishPointer?.();marker.replaceWith(element);panel.remove();window.removeEventListener('resize',layout);floatingConsoles.delete(element);layoutFloatingConsoleDock();fit();}};
  floatingConsoles.set(element,api);
  panel.addEventListener('click',event=>{
    if(suppressClick){suppressClick=false;event.preventDefault();event.stopPropagation();return;}
    const action=event.target.closest('[data-float]')?.dataset.float;
    if(minimized&&action!=='dock'&&action!=='fullscreen'){api.restore();return;}
    if(action==='minimize'){restoreFullscreen=fullscreen;minimized=true;fullscreen=false;}
    else if(action==='restore'){api.restore();return;}
    else if(action==='fullscreen'){fullscreen=!fullscreen;minimized=false;}
    else if(action==='dock'){api.close();return;}
    else return;
    layout();
  });
  panel.addEventListener('cancel',event=>event.preventDefault());
  panel.addEventListener('pointerdown',event=>{
    suppressClick=false;
    const edge=event.target.closest('[data-float-resize]')?.dataset.floatResize;
    if(event.button!==0||minimized||fullscreen||!edge&&(!event.target.closest('.modal-header')||event.target.closest('button:not(.floating-console-title)')))return;
    finishPointer?.();const start={...rect},x=event.clientX,y=event.clientY,id=event.pointerId;let dragging=false;
    const move=next=>{
      if(next.pointerId!==id)return;
      const dx=next.clientX-x,dy=next.clientY-y;
      if(!dragging&&Math.hypot(dx,dy)<4)return;
      if(!dragging){dragging=true;panel.focus({preventScroll:true});panel.setPointerCapture?.(id);}
      next.preventDefault();rect=edge?resizeFloatingConsole(start,edge,dx,dy):constrainFloatingConsole({...start,x:start.x+dx,y:start.y+dy});layout();
    };
    const end=next=>{if(next&&next.pointerId!==id)return;suppressClick=dragging;window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);if(panel.hasPointerCapture?.(id))panel.releasePointerCapture(id);finishPointer=null;};
    finishPointer=end;window.addEventListener('pointermove',move,{passive:false});window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);
  });
  panel.addEventListener('keydown',event=>{
    const edge=event.target.closest('[data-float-resize]')?.dataset.floatResize;if(!edge||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
    event.preventDefault();rect=resizeFloatingConsole(rect,edge,({ArrowRight:20,ArrowLeft:-20}[event.key]||0),({ArrowDown:20,ArrowUp:-20}[event.key]||0));layout();
  });
  window.addEventListener('resize',layout);layout();return api;
}
window.AIWSUI.configureFloatingConsole({open:(element,title)=>{for(const [root,floating] of floatingConsoles)if(root.contains(element)){floating.restore();return floating;}return showModal(title,'',null,{floating:true,element});},close:element=>floatingConsoles.get(element)?.close()});
window.addEventListener('pagehide',()=>{for(const floating of floatingConsoles.values())floating.close();});
