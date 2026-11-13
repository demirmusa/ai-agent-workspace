'use strict';
// The thin progress bar for changes that take longer than a moment; the UI never waits on them.
let pendingChanges=0,progressTimer=null;
function trackChange(delta){
  pendingChanges=Math.max(0,pendingChanges+delta);
  let bar=document.getElementById('request-progress');
  if(!pendingChanges){clearTimeout(progressTimer);progressTimer=null;if(bar)bar.hidden=true;return;}
  if(progressTimer||(bar&&!bar.hidden))return;
  progressTimer=setTimeout(()=>{progressTimer=null;if(!pendingChanges)return;if(!bar){bar=document.createElement('div');bar.id='request-progress';bar.className='request-progress';bar.setAttribute('role','progressbar');bar.setAttribute('aria-label',globalThis.AIWSI18n.text('İşleniyor…'));document.body.append(bar);}bar.hidden=false;},200);
}
window.addEventListener('pagehide',()=>{clearTimeout(progressTimer);progressTimer=null;});
