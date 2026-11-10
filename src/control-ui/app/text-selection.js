'use strict';
// Selecting text never activates a control: a drag that starts or ends on a button or link can end in a click, and the
// selected text stays available for copying instead of navigating or activating that control.
document.addEventListener('click',event=>{
  if(!event.detail)return;
  const selection=window.getSelection(),target=event.target.closest('button,a,summary,label,[data-open-task],[role=button]');
  if(target&&selection&&!selection.isCollapsed&&(target.contains(selection.anchorNode)||target.contains(selection.focusNode))){
    event.preventDefault();event.stopImmediatePropagation();
  }
},true);
