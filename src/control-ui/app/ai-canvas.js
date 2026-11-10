'use strict';
// The AI drafts canvas: flow layout, camera, connectors and pointer input (pan, zoom, dragging cards, hover focus).
// The canvas flow is a top-down tree: drafts without a blocker on the canvas lead, the drafts waiting on one stand in a row under it and
// later steps stack under theirs; every draft hangs under its deepest blocker and other blockers get a dashed link. With no
// draft-to-draft dependency the canvas is a wrapping grid. While the planner works, skeletons stand in the next places.
function aiFlowLayout(workspace){
  const skeletons=workspace.busy?(workspace.drafts.length?1:2):0;
  // The layout object is extended, not copied: placing it writes its size back onto itself.
  return Object.assign(window.AIWSUI.flowLayout(workspace.drafts,draft=>draft.key,draft=>draft.values.dependsOnDrafts||[],skeletons),{skeletons});
}
// Nodes keep their elements and only move; the layout key changes when nodes, their mode or their places do, which glides moved nodes
// (FLIP), enters new ones in flow order and redraws the connectors.
function renderAIDrafts(workspace){
  const list=workspace.element.querySelector('#ai-draft-list'),layout=aiFlowLayout(workspace),{motion,reducedMotion}=window.AIWSUI;workspace.layout=layout;
  const replay=workspace.replay&&workspace.cards.size>0&&!reducedMotion();delete workspace.replay;
  if(replay){workspace.layoutKey='';motion.forget(list);for(const element of [...workspace.links.values(),...workspace.ports.values()])element.remove();workspace.links.clear();workspace.ports.clear();}
  const key=[layout.flow?'flow':'grid',layout.skeletons,...layout.order.map(draft=>`${draft.key}:${draft.createdTaskId?1:0}:${layout.place.get(draft.key)||''}`)].join('|');
  const render=()=>{
    const nodes=new Map(workspace.drafts.map(draft=>[draft.key,updateAIDraftCard(workspace,draft)]));
    for(const [draftKey,node] of workspace.cards)if(!nodes.has(draftKey)){workspace.resize?.unobserve(node);node.remove();workspace.cards.delete(draftKey);}
    while(workspace.skeletons.length<layout.skeletons)workspace.skeletons.push(aiSkeleton(workspace.skeletons.length));
    for(const skeleton of workspace.skeletons.splice(layout.skeletons))skeleton.remove();
    // Items move only when out of order: re-inserting a node would restart its entrance and drop the focus inside it.
    const items=[...layout.order.map(draft=>nodes.get(draft.key)),...workspace.skeletons];let cursor=list.firstElementChild.nextSibling;
    for(const draft of workspace.drafts)aiPlaceNode(nodes.get(draft.key),draft);
    for(const item of items){if(item===cursor)cursor=cursor.nextSibling;else list.insertBefore(item,cursor);}
    list.hidden=!items.length;window.AIWSUI.placeFlow(list,layout,key=>aiNodeOf(workspace,key));
  };
  if(key===workspace.layoutKey)render();
  else{
    // Existing connectors glide to their new shape with the moving nodes; new ones wait until the nodes settle.
    const settle=layout.flow&&workspace.cards.size>0&&aiVisible(workspace)&&!reducedMotion();workspace.layoutKey=key;workspace.settle=settle;
    // New cards rise one after another: a draft waits until the connector from its blocker has mostly grown, unrelated ones a beat apart.
    const first=!workspace.cards.size,known=new Set(replay?[]:workspace.cards.keys()),delays=layout.flow?window.AIWSUI.flowDelays(layout,draftKey=>!known.has(draftKey)):null;
    motion.flip(list,'[data-ai-draft]','data-ai-draft',render,{delays,stagger:Math.max(110,Math.min(220,Math.floor(2400/Math.max(1,layout.order.length)))),max:60});
    if(workspace.free)aiFitView(workspace,!first&&aiVisible(workspace));
    drawAILinks(workspace);
  }
  const visible=aiVisible(workspace),animate=visible&&!reducedMotion();
  for(const draft of workspace.drafts){const node=workspace.cards.get(draft.key);
    if(node.aiSwapped){delete node.aiSwapped;if(animate)node.lastElementChild.animate?.([{opacity:0,transform:'scale(.98)'},{opacity:1,transform:'none'}],{duration:260,easing:'ease-out'});}
    // A draft the planner rewrote rings once, as soon as it can be seen.
    if(draft.changed&&visible){delete draft.changed;if(animate&&!node.classList.contains('ui-enter'))node.lastElementChild.animate?.([{opacity:0},{opacity:1,offset:.25},{opacity:0}],{duration:1100,easing:'ease-out',pseudoElement:'::before'});}
  }
}
// A placeholder node with a shimmer while the planner works; each one fades in a beat after the previous.
function aiSkeleton(index){const node=document.createElement('div');node.className='ai-node ai-skeleton ui-enter-fade';node.setAttribute('aria-hidden','true');node.style.setProperty('--enter-delay',`${120+index*180}ms`);node.innerHTML='<div class="ai-node-tag"><span class="skeleton ai-skeleton-chip"></span></div><div class="ai-card ui-card"><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span><span class="ai-skeleton-chips"><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span></span></div>';return node;}
// A card moved by hand keeps its grid place and slides by its own offset, which the connectors follow.
function aiPlaceNode(node,draft){const value=draft.offset?`${draft.offset[0]}px ${draft.offset[1]}px`:'';if(node&&node.style.translate!==value)node.style.translate=value;}
// Fits the drafts into the canvas above the dock without enlarging past 100%; a tall tree keeps at least 80% and starts at the top,
// the rest a pan away. Fitting hands the view back to following the drafts.
function aiFitView(workspace,ease){
  const element=workspace.element,camera=workspace.camera;if(!element||!camera)return;workspace.free=true;
  const canvas=element.querySelector('#ai-canvas'),list=element.querySelector('#ai-draft-list'),placed=workspace.layout?.flow&&workspace.layout.width,width=placed?workspace.layout.width:list.offsetWidth,height=placed?workspace.layout.height:list.offsetHeight;if(list.hidden||!width||!height||!canvas.clientWidth)return;
  const style=getComputedStyle(canvas),top=parseFloat(style.paddingTop)||0,side=parseFloat(style.paddingLeft)||0,roomX=canvas.clientWidth-side*2,roomY=canvas.clientHeight-top-(parseFloat(style.paddingBottom)||0);
  const scale=Math.max(.3,Math.min(1,roomX/width,Math.max(.8,roomY/height))),view={scale,x:canvas.clientWidth/2-list.offsetLeft-scale*width/2,y:top+Math.max(0,(roomY-scale*height)/2)-list.offsetTop};
  if(ease)aiEase(workspace,()=>camera.set(view));else camera.set(view);
}
// Eases the next camera or card move instead of jumping; connectors are redrawn every frame while cards slide.
function aiEase(workspace,move){
  const list=workspace.element?.querySelector('#ai-draft-list');if(!list||window.AIWSUI.reducedMotion()){move();aiScheduleLinks(workspace);return;}
  list.classList.add('is-easing');move();clearTimeout(workspace.easeTimer);workspace.easeTimer=setTimeout(()=>list.classList.remove('is-easing'),460);
  // One frame loop per workspace: a second ease while one runs only extends it.
  const running=workspace.easeUntil>performance.now();workspace.easeUntil=performance.now()+460;if(running)return;
  const frame=()=>{drawAILinks(workspace);if(performance.now()<workspace.easeUntil)requestAnimationFrame(frame);};requestAnimationFrame(frame);
}
// Lights the connectors of the hovered node and its neighbours; the rest of the canvas dims while it does.
function aiFocusLinks(workspace,key){
  if(workspace.focusKey===key)return;workspace.focusKey=key;const list=workspace.element?.querySelector('#ai-draft-list');if(!list)return;
  const near=new Set([key]);for(const [edge,path] of workspace.links){const ends=edge.split('>'),on=Boolean(key)&&ends.includes(key);path.classList.toggle('is-active',on);if(on)for(const end of ends)near.add(end);}
  const linked=near.size>1;list.classList.toggle('has-focus',linked);for(const [cardKey,node] of workspace.cards)node.classList.toggle('is-near',linked&&near.has(cardKey));
}
// A draft node or a planner skeleton by its layout key.
const aiNodeOf=(workspace,key)=>workspace.cards.get(key)||workspace.skeletons[Number(/^placeholder:(\d+)$/.exec(key)?.[1]??-1)];
// A card that changed size places the canvas again; moved cards and their connectors glide to the new places.
function aiScheduleLinks(workspace){if(!workspace.linkFrame)workspace.linkFrame=requestAnimationFrame(()=>{workspace.linkFrame=0;const list=workspace.element?.querySelector('#ai-draft-list');if(!list||!workspace.layout)return;if(window.AIWSUI.placeFlow(list,workspace.layout,key=>aiNodeOf(workspace,key))&&aiVisible(workspace))workspace.settle=true;drawAILinks(workspace);});}
function drawAILinks(workspace){if(workspace.layout)window.AIWSUI.drawFlowLinks(workspace.element?.querySelector('#ai-draft-list'),workspace.layout,key=>aiNodeOf(workspace,key),workspace);}
function aiMountCanvas(workspace,element){
  const $=selector=>element.querySelector(selector),list=$('#ai-draft-list'),draftOf=target=>aiDraftOf(workspace,target);
  // Any size change of the cards or the canvas re-measures the connectors and keeps a fitted view fitted.
  if(typeof ResizeObserver==='function'){workspace.resize=new ResizeObserver(()=>{aiScheduleLinks(workspace);if(workspace.free)aiFitView(workspace,false);});workspace.resize.observe(list);workspace.resize.observe($('#ai-canvas'));}
  // The canvas is a board: the wheel zooms around the pointer, dragging empty canvas (or with the middle button) pans, and the dots
  // follow the camera. Until the person moves the view it keeps fitting the drafts.
  const canvas=$('#ai-canvas'),zoomLevel=$('#ai-zoom-level');
  workspace.camera=window.AIWSUI.panZoom(canvas,{min:.3,max:2,canPan:event=>!event.target.closest('.ai-node'),onUser:()=>{workspace.free=false;},
    point:event=>{const box=canvas.getBoundingClientRect();return [event.clientX-box.left-list.offsetLeft,event.clientY-box.top-list.offsetTop];},
    apply:({x,y,scale})=>{list.style.transform=`translate(${x}px,${y}px) scale(${scale})`;canvas.style.backgroundPosition=`${list.offsetLeft+x}px ${list.offsetTop+y}px`;canvas.style.backgroundSize=`${18*scale}px ${18*scale}px`;zoomLevel.textContent=`${Math.round(scale*100)}%`;}});
  canvas.addEventListener('dblclick',event=>{if(!event.target.closest('.ai-node'))aiFitView(workspace,true);});
  $('#ai-zoom').onclick=event=>{const action=event.target.closest('[data-ai-zoom]')?.dataset.aiZoom;if(!action)return;if(action==='fit'){aiFitView(workspace,true);return;}
    const camera=workspace.camera,cx=canvas.clientWidth/2-list.offsetLeft,cy=canvas.clientHeight/2-list.offsetTop;workspace.free=false;
    aiEase(workspace,()=>camera.zoom(action==='reset'?1/camera.view.scale:action==='in'?1.25:.8,cx,cy));};
  $('#ai-layout-reset').onclick=()=>{aiEase(workspace,()=>{for(const draft of workspace.drafts){delete draft.offset;const node=workspace.cards.get(draft.key);if(node)aiPlaceNode(node,draft);}});saveAIWorkspace(workspace);updateAIWorkspace(workspace);};
  // A card dragged by its body or edge moves on its own and keeps the move; the click that ends a drag does not open it.
  let moving=null,dragged=false;
  list.addEventListener('pointerdown',event=>{dragged=false;
    const node=event.button===0&&!event.target.closest('select,input,textarea,a,label,button:not(.ai-card-body),.agent-picker')?event.target.closest('[data-ai-draft]'):null,draft=node&&draftOf(node);if(!draft)return;
    const [x=0,y=0]=draft.offset||[];moving={id:event.pointerId,node,draft,startX:event.clientX,startY:event.clientY,x,y,active:false};});
  list.addEventListener('pointermove',event=>{if(moving?.id!==event.pointerId)return;const dx=event.clientX-moving.startX,dy=event.clientY-moving.startY,scale=workspace.camera.view.scale;
    if(!moving.active){if(Math.hypot(dx,dy)<4)return;moving.active=true;moving.node.setPointerCapture?.(event.pointerId);moving.node.classList.add('is-dragging');}
    moving.draft.offset=[Math.round(moving.x+dx/scale),Math.round(moving.y+dy/scale)];aiPlaceNode(moving.node,moving.draft);drawAILinks(workspace);});
  const drop=event=>{if(moving?.id!==event.pointerId)return;if(moving.active){dragged=true;moving.node.classList.remove('is-dragging');saveAIWorkspace(workspace);$('#ai-layout-reset').hidden=false;}moving=null;};
  list.addEventListener('pointerup',drop);list.addEventListener('pointercancel',drop);
  list.addEventListener('click',event=>{if(!dragged)return;dragged=false;event.preventDefault();event.stopImmediatePropagation();},true);
  // Hovering a node lights its connectors and neighbours and dims the rest.
  list.addEventListener('pointerover',event=>aiFocusLinks(workspace,event.target.closest('[data-ai-draft]')?.dataset.aiDraft||''));
  list.addEventListener('pointerleave',()=>aiFocusLinks(workspace,''));
}
