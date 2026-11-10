'use strict';
// Frameless desktop window: the header hosts custom minimize/maximize/close buttons.
(()=>{
  const api=window.aiwsDesktop?.window;
  const controls=document.getElementById('window-controls');
  if(!api||!controls)return;
  document.body.classList.add('desktop-frameless');
  controls.hidden=false;
  const maxButton=document.getElementById('win-max');
  const showMaximized=maximized=>{
    maxButton.title=maxButton.ariaLabel=maximized?globalThis.AIWSI18n.text('Önceki boyut'):globalThis.AIWSI18n.text('Büyüt');
    maxButton.innerHTML=maximized
      ?'<svg width="12" height="12" viewBox="0 0 12 12"><path d="M4 4V2h6v6H8M2 4h6v6H2z" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>'
      :'<svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>';
  };
  document.getElementById('win-min').addEventListener('click',()=>void api.minimize());
  maxButton.addEventListener('click',()=>void api.toggleMaximize().then(showMaximized));
  document.getElementById('win-close').addEventListener('click',()=>void api.close());
  document.querySelector('.topbar').addEventListener('dblclick',event=>{if(event.target.closest('button,select,input,a,nav'))return;void api.toggleMaximize().then(showMaximized);});
  api.onMaximizedChange(showMaximized);
  void api.isMaximized().then(showMaximized).catch(()=>{});
})();
