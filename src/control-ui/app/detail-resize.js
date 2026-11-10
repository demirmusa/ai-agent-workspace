'use strict';
// Width and resizing of the task detail panel, and fitting the terminals inside it.
const terminalViews=new Set();
const detailWidthKey='aiws.detail-width';
const detailPanelSizes={min:560,sideMin:360,sideMax:720,gap:16,stackViewport:1000};
let detailPanelWidth=Number(localStorage.getItem(detailWidthKey))||null,detailResizeHandle=null,detailDrag=null,detailFitFrame=null;
// The panel's area width comes from a ResizeObserver, so a render never forces a layout to read it.
let detailAreaWidth=0,detailAreaObserved=null,detailAppliedWidth='';
function detailArea(){
  const area=$('#task-panel')?.parentElement;if(!area)return 0;
  if(detailAreaObserved!==area&&typeof ResizeObserver==='function'){detailAreaObserved=area;detailAreaWidth=area.clientWidth;new ResizeObserver(entries=>{const width=Math.round(entries.at(-1)?.contentRect?.width||0);if(width&&width!==detailAreaWidth){detailAreaWidth=width;applyDetailWidth();}}).observe(area);}
  return detailAreaObserved===area&&detailAreaWidth?detailAreaWidth:area.clientWidth;
}
function detailWidthBounds(){const viewport=window.innerWidth,area=detailArea()||viewport,stacked=viewport<=detailPanelSizes.stackViewport||area<detailPanelSizes.min+detailPanelSizes.sideMin+detailPanelSizes.gap,max=Math.max(0,area-(childAgentSelection&&!stacked?detailPanelSizes.sideMin+detailPanelSizes.gap:detailPanelSizes.gap));return {viewport,area,stacked,min:Math.min(detailPanelSizes.min,max),max,mobile:viewport<=760};}
function fitDetailTerminal(){
  if(detailFitFrame!==null)return;
  detailFitFrame=requestAnimationFrame(()=>{detailFitFrame=null;const panel=$('#task-panel');for(const view of terminalViews.values())if(panel.contains(view.element)&&!view.element.closest('[hidden]'))view.resize();});
}
function applyDetailWidth(){
  const panel=$('#task-panel'),bounds=detailWidthBounds(),width=bounds.mobile?bounds.area:Math.min(bounds.max,Math.max(bounds.min,Number.isFinite(detailPanelWidth)&&detailPanelWidth>0?detailPanelWidth:bounds.area*.6));
  const applied=`${Math.round(width)}px`,changed=applied!==detailAppliedWidth;detailAppliedWidth=applied;
  if(changed)panel.style.setProperty('--task-panel-width',applied);
  // The side panel stacks against the open task panel, or against the right edge when no task is open.
  if(childAgentPanel&&!childAgentPanel.hidden){const stacked=bounds.stacked,docked=panel.hidden||agentScreen?0:width;childAgentPanel.dataset.stacked=String(stacked);childAgentPanel.style.setProperty('--child-panel-right',`${stacked?0:Math.round(docked)}px`);childAgentPanel.style.setProperty('--child-panel-width',`${stacked?bounds.area:Math.min(detailPanelSizes.sideMax,Math.max(0,bounds.area-docked-detailPanelSizes.gap))}px`);}
  if(detailResizeHandle){detailResizeHandle.hidden=bounds.mobile||sessionFullscreen||panel.hidden;detailResizeHandle.setAttribute('aria-valuemin',String(bounds.min));detailResizeHandle.setAttribute('aria-valuemax',String(bounds.max));detailResizeHandle.setAttribute('aria-valuenow',String(Math.round(width)));detailResizeHandle.setAttribute('aria-valuetext',globalThis.AIWSI18n.template`${Math.round(width)} piksel`);}
  // Terminals refit on their own size changes; a width change is the cue to refit them together in one frame.
  if(changed)fitDetailTerminal();return width;
}
function saveDetailWidth(){try{localStorage.setItem(detailWidthKey,String(Math.round(detailPanelWidth)));}catch{/* Storage may be disabled. */}}
function finishDetailResize(){
  if(!detailDrag)return;const pointerId=detailDrag.pointerId;detailDrag=null;document.documentElement.classList.remove('resizing-task-panel');
  try{detailResizeHandle?.releasePointerCapture(pointerId);}catch{/* Capture may already have ended. */}
  saveDetailWidth();
}
function ensureDetailResizer(panel){
  if(!detailResizeHandle){
    detailResizeHandle=document.createElement('div');detailResizeHandle.id='task-panel-resizer';detailResizeHandle.className='task-panel-resizer';detailResizeHandle.tabIndex=0;detailResizeHandle.setAttribute('role','separator');detailResizeHandle.setAttribute('aria-orientation','vertical');detailResizeHandle.setAttribute('aria-label',globalThis.AIWSI18n.text('Detay panelinin genişliğini ayarla'));detailResizeHandle.setAttribute('aria-controls','task-panel');detailResizeHandle.title=globalThis.AIWSI18n.text('Genişliği ayarlamak için sürükle veya sol/sağ ok tuşlarını kullan');
    detailResizeHandle.addEventListener('pointerdown',event=>{if(event.button!==0||detailResizeHandle.hidden)return;event.preventDefault();finishDetailResize();detailDrag={pointerId:event.pointerId,startX:event.clientX,startWidth:applyDetailWidth()};detailPanelWidth=detailDrag.startWidth;detailResizeHandle.focus({preventScroll:true});document.documentElement.classList.add('resizing-task-panel');try{detailResizeHandle.setPointerCapture(event.pointerId);}catch{/* Document listeners also support hosts without pointer capture. */}});
    detailResizeHandle.addEventListener('lostpointercapture',finishDetailResize);
    detailResizeHandle.addEventListener('keydown',event=>{if(detailResizeHandle.hidden||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const bounds=detailWidthBounds(),width=applyDetailWidth(),step=event.shiftKey?80:32;detailPanelWidth=event.key==='Home'?bounds.min:event.key==='End'?bounds.max:Math.min(bounds.max,Math.max(bounds.min,width+(event.key==='ArrowLeft'?step:-step)));applyDetailWidth();saveDetailWidth();});
  }
  if(detailResizeHandle.parentElement!==panel)panel.prepend(detailResizeHandle);applyDetailWidth();
}
document.addEventListener('pointermove',event=>{if(!detailDrag||event.pointerId!==detailDrag.pointerId)return;event.preventDefault();const bounds=detailWidthBounds();detailPanelWidth=Math.min(bounds.max,Math.max(bounds.min,detailDrag.startWidth+detailDrag.startX-event.clientX));applyDetailWidth();});
document.addEventListener('pointerup',event=>{if(event.pointerId===detailDrag?.pointerId)finishDetailResize();});
document.addEventListener('pointercancel',event=>{if(event.pointerId===detailDrag?.pointerId)finishDetailResize();});
window.addEventListener('blur',finishDetailResize);
window.addEventListener('resize',()=>{finishDetailResize();applyDetailWidth();});
window.addEventListener('pagehide',()=>{finishDetailResize();if(detailFitFrame!==null)cancelAnimationFrame(detailFitFrame);detailFitFrame=null;for(const view of terminalViews)view.destroy();});
