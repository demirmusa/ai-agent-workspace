'use strict';
// Moving terminal panes by their headers and resizing them by their dividers.
// Moving a pane: past a few pixels the header follows the pointer and the stage previews where it lands.
function terminalDropTarget(entry,stage,source,x,y){
  const bounds=stage.getBoundingClientRect();if(x<bounds.left||x>bounds.right||y<bounds.top||y>bounds.bottom)return null;
  const part=(rect,side,fraction)=>({left:side==='right'?rect.right-rect.width*fraction:rect.left,top:side==='bottom'?rect.bottom-rect.height*fraction:rect.top,width:side==='left'||side==='right'?rect.width*fraction:rect.width,height:side==='top'||side==='bottom'?rect.height*fraction:rect.height});
  const edge=Math.min(28,bounds.width/10,bounds.height/10),outer=[['left',x-bounds.left],['right',bounds.right-x],['top',y-bounds.top],['bottom',bounds.bottom-y]].filter(([,distance])=>distance<edge).sort((a,b)=>a[1]-b[1])[0];
  if(outer)return {target:null,side:outer[0],rect:part(bounds,outer[0],.25)};
  const pane=document.elementFromPoint(x,y)?.closest?.('[data-terminal-pane]'),target=pane?.dataset.terminalPane;
  if(!pane||!stage.contains(pane)||target===source)return null;
  const rect=pane.getBoundingClientRect(),px=(x-rect.left)/rect.width,py=(y-rect.top)/rect.height;
  if(px>.3&&px<.7&&py>.3&&py<.7)return {target,side:'center',rect};
  const side=[['left',px],['right',1-px],['top',py],['bottom',1-py]].sort((a,b)=>a[1]-b[1])[0][0];
  return {target,side,rect:part(rect,side,.5)};
}
function showTerminalDrop(stage,indicator,drop){
  indicator.hidden=!drop;if(!drop)return;
  // The preview glides between drop zones by transform; its size snaps, so no layout property is animated.
  const bounds=stage.getBoundingClientRect();indicator.dataset.side=drop.side;
  Object.assign(indicator.style,{transform:`translate(${drop.rect.left-bounds.left}px,${drop.rect.top-bounds.top}px)`,width:`${drop.rect.width}px`,height:`${drop.rect.height}px`});
}
function startTerminalDrag(entry,event){
  const head=event.target.closest('.terminal-pane-head'),source=head?.closest('[data-terminal-pane]')?.dataset.terminalPane;
  if(!source||event.button!==0||entry.items.length<2||event.target.closest('.terminal-pane-close,.terminal-rename'))return;
  const stage=entry.element.querySelector('[data-terminal-stage]'),indicator=stage.querySelector('[data-terminal-drop]'),startX=event.clientX,startY=event.clientY;
  let dragging=false,drop=null;
  const move=moveEvent=>{
    if(!dragging){if(Math.hypot(moveEvent.clientX-startX,moveEvent.clientY-startY)<5)return;dragging=true;stage.classList.add('dragging');entry.views.get(source)?.pane.classList.add('drag-source');}
    moveEvent.preventDefault();drop=terminalDropTarget(entry,stage,source,moveEvent.clientX,moveEvent.clientY);showTerminalDrop(stage,indicator,drop);
  };
  const finish=commit=>{
    window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',cancel,true);window.removeEventListener('keydown',escape,true);
    indicator.hidden=true;stage.classList.remove('dragging');entry.views.get(source)?.pane.classList.remove('drag-source');
    if(!dragging||!commit||!drop||!entry.items.some(run=>run.id===source))return;
    if(drop.side==='center')entry.layout=layoutSwap(entry.layout,source,drop.target);
    else entry.layout=layoutInsert(layoutRemove(entry.layout,source),source,drop.target,drop.side);
    saveTerminalLayout(entry);selectTerminal(entry,source,{focus:true});
  };
  const up=()=>finish(true),cancel=()=>finish(false),escape=keyEvent=>{if(keyEvent.key==='Escape'){keyEvent.preventDefault();keyEvent.stopPropagation();finish(false);}};
  // The drag follows the pointer on the window: pointer capture is not delivered reliably once it crosses other panes.
  window.addEventListener('pointermove',move,true);window.addEventListener('pointerup',up,true);window.addEventListener('pointercancel',cancel,true);window.addEventListener('keydown',escape,true);
}
// Dividers between panes resize the two neighbours; each keeps a usable minimum.
function startTerminalResize(entry,event){
  const handle=event.target.closest('.terminal-resizer'),split=handle.parentElement;if(event.button!==0)return;
  const node=handle.dataset.terminalResize.split('.').slice(1).map(Number).reduce((current,index)=>current?.children?.[index],entry.layout),index=Number(handle.dataset.terminalResizeIndex);
  if(!node?.children?.[index])return;event.preventDefault();
  const row=node.dir==='row',cells=[...split.children].filter(child=>!child.classList.contains('terminal-resizer')),available=[...split.children].reduce((sum,child)=>sum-(child.classList.contains('terminal-resizer')?(row?child.offsetWidth:child.offsetHeight):0),row?split.clientWidth:split.clientHeight);
  const start=row?event.clientX:event.clientY,before=node.sizes[index-1],after=node.sizes[index],minimum=Math.min(.45*(before+after),(row?160:90)/Math.max(1,available));
  split.classList.add('resizing');try{handle.setPointerCapture?.(event.pointerId);}catch{/* Synthetic pointers cannot be captured. */}
  const move=moveEvent=>{
    const delta=((row?moveEvent.clientX:moveEvent.clientY)-start)/Math.max(1,available),next=Math.min(before+after-minimum,Math.max(minimum,before+delta));
    node.sizes[index-1]=next;node.sizes[index]=before+after-next;
    cells[index-1].style.flex=`${next*1e4} 1 0`;cells[index].style.flex=`${(before+after-next)*1e4} 1 0`;
  };
  const end=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);split.classList.remove('resizing');entry.savedLayout='';saveTerminalLayout(entry);};
  handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
}
