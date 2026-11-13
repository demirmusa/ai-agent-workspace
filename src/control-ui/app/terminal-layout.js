'use strict';
// The terminal layout tree.
// Every open terminal is shown at once in a layout tree: splits ({dir,children,sizes})
// with terminal ids ({id}) as leaves. Dragging a pane's header docks it beside
// another pane, swaps it with one, or docks it along an edge of the whole stage.
const terminalLayoutKey=id=>`aiws.terminal-layout.${id}`;
function layoutIds(node){return !node?[]:node.id?[node.id]:node.children.flatMap(layoutIds);}
function layoutShape(node){return !node?null:node.id?node.id:[node.dir,node.children.map(layoutShape)];}
// Drops empty branches, unwraps single children, merges same-direction splits and rescales sizes to sum to 1.
function layoutNormalize(node){
  if(!node||node.id)return node||null;
  const children=[],sizes=[];
  node.children.forEach((child,index)=>{
    const next=layoutNormalize(child),size=Number(node.sizes?.[index])>0?Number(node.sizes[index]):1;if(!next)return;
    if(!next.id&&next.dir===node.dir)next.children.forEach((grand,at)=>{children.push(grand);sizes.push(size*next.sizes[at]);});
    else{children.push(next);sizes.push(size);}
  });
  if(children.length<2)return children[0]||null;
  const total=sizes.reduce((sum,value)=>sum+value,0);return {dir:node.dir,children,sizes:sizes.map(value=>value/total)};
}
function layoutParse(value,seen=new Set()){
  if(!value||typeof value!=='object')return null;
  if(typeof value.id==='string'){if(seen.has(value.id))return null;seen.add(value.id);return {id:value.id};}
  if(!['row','column'].includes(value.dir)||!Array.isArray(value.children))return null;
  return layoutNormalize({dir:value.dir,children:value.children.map(child=>layoutParse(child,seen)),sizes:Array.isArray(value.sizes)?value.sizes:[]});
}
function layoutRemove(node,id){
  if(!node||node.id)return node?.id===id?null:node;
  return layoutNormalize({dir:node.dir,children:node.children.map(child=>layoutRemove(child,id)),sizes:node.sizes});
}
function layoutSwap(node,a,b){return !node?node:node.id?(node.id===a?{id:b}:node.id===b?{id:a}:node):{...node,children:node.children.map(child=>layoutSwap(child,a,b))};}
// Places id on a side (left, right, top, bottom) of the target pane, or of the whole layout when target is null.
function layoutInsert(node,id,target,side){
  const dir=side==='left'||side==='right'?'row':'column',before=side==='left'||side==='top',leaf={id};
  const wrap=other=>({dir,children:before?[leaf,other]:[other,leaf],sizes:[.5,.5]});
  if(!node)return leaf;
  if(!target||!layoutIds(node).includes(target)){
    if(node.id||node.dir!==dir)return wrap(node);
    const size=1/(node.children.length+1),sizes=node.sizes.map(value=>value*(1-size));
    return before?{dir,children:[leaf,...node.children],sizes:[size,...sizes]}:{dir,children:[...node.children,leaf],sizes:[...sizes,size]};
  }
  const visit=current=>{
    if(current.id)return current.id===target?wrap(current):current;
    const index=current.children.findIndex(child=>child.id===target);
    if(index>=0&&current.dir===dir){const children=[...current.children],sizes=[...current.sizes],half=sizes[index]/2,at=before?index:index+1;sizes[index]=half;children.splice(at,0,leaf);sizes.splice(at,0,half);return {dir,children,sizes};}
    return {dir:current.dir,children:current.children.map(visit),sizes:current.sizes};
  };
  return layoutNormalize(visit(node));
}
// Terminals that arrive together without a saved layout fill a grid of up to four columns.
function layoutGrid(ids){
  if(ids.length<3)return layoutNormalize({dir:'row',children:ids.map(id=>({id})),sizes:ids.map(()=>1)});
  const columns=Math.ceil(ids.length/2),rows=[ids.slice(0,columns),ids.slice(columns)];
  return layoutNormalize({dir:'column',children:rows.map(row=>({dir:'row',children:row.map(id=>({id})),sizes:row.map(()=>1)})),sizes:[1,1]});
}
function saveTerminalLayout(entry){const value=JSON.stringify(entry.layout);if(entry.savedLayout===value)return;entry.savedLayout=value;try{if(entry.layout)localStorage.setItem(entry.storageKey,value);else localStorage.removeItem(entry.storageKey);}catch{/* Storage may be disabled; the layout then lasts for this page. */}}
function loadTerminalLayout(key){try{return layoutParse(JSON.parse(localStorage.getItem(key)||'null'));}catch{return null;}}
// Keeps the layout in step with the open terminals; a new one opens beside the focused pane, along its longer side.
function syncTerminalLayout(entry){
  if(!entry.loaded&&!entry.items.length)return;
  const ids=entry.items.map(run=>run.id);let layout=entry.layout;
  for(const runId of layoutIds(layout))if(!ids.includes(runId))layout=layoutRemove(layout,runId);
  const missing=ids.filter(runId=>!layoutIds(layout).includes(runId));
  if(!layout&&missing.length>1)layout=layoutGrid(missing);
  else for(const runId of missing){const placed=layoutIds(layout),target=placed.includes(entry.selected)?entry.selected:placed.at(-1)||null;layout=layoutInsert(layout,runId,target,terminalSplitSide(entry,target));}
  entry.layout=layout;saveTerminalLayout(entry);
}
function terminalSplitSide(entry,target){
  const pane=target&&entry.views.get(target)?.pane,box=(pane?.isConnected?pane:entry.element.querySelector('[data-terminal-stage]')).getBoundingClientRect();
  return box.height>box.width*.8?'bottom':'right';
}
