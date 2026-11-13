'use strict';
// The gliding pill behind the active settings tab.
// Settings navigation: the active tab's pill glides from where it was. One measurement per change; it moves by transform only.
const settingsPillFrom=new Map();
function placeSettingsPill(nav){
  const pill=nav?.querySelector('.settings-tab-pill'),tab=nav?.querySelector('[role="tab"][aria-selected="true"]');if(!pill)return;
  pill.hidden=!tab;if(!tab||!nav.offsetParent)return;
  const top=tab.offsetTop,from=settingsPillFrom.get(nav.id);settingsPillFrom.set(nav.id,top);
  pill.style.height=`${tab.offsetHeight}px`;pill.style.transform=`translateY(${top}px)`;
  if(from!==undefined&&from!==top&&typeof pill.animate==='function'&&!window.AIWSUI.reducedMotion())pill.animate([{transform:`translateY(${from}px)`},{transform:`translateY(${top}px)`}],{duration:280,easing:'cubic-bezier(.16,1,.3,1)'});
}
