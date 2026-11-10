'use strict';
// The one modal shell every dialog opens in: its session, focus handling, the files toggle borrowed by its header, parking a dialog
// under another, the one yes/no question, and dismissing it (a form with unsaved input asks first).
let modalSession=null;
let filesTogglePlaceholder=null;
function placeFilesToggleInModal(enabled,header){
  const toggle=$('#files-toggle');if(!toggle)return;
  if(!enabled){if(filesTogglePlaceholder){filesTogglePlaceholder.replaceWith(toggle);filesTogglePlaceholder=null;}return;}
  if(!filesTogglePlaceholder){filesTogglePlaceholder=document.createComment('files-toggle');toggle.before(filesTogglePlaceholder);}
  if(header)header.insertBefore(toggle,$('#close-modal',header));
}
function showModal(title,body,submit,options={}) {
  if(options.floating)return createFloatingConsole(title,options.element);
  placeFilesToggleInModal(false);
  const modal=$('#modal'),previous=modalSession,returnFocus=modal.open?previous?.returnFocus:document.activeElement;
  modal.dispatchEvent(new Event('modalreset'));
  $('form',modal)?.dispatchEvent(new Event('modalreset'));
  const returnAttributes=modal.open?previous?.returnAttributes:[...(returnFocus?.attributes||[])].filter(attribute=>attribute.name.startsWith('data-')).map(attribute=>[attribute.name,attribute.value]);
  const session={returnFocus,returnAttributes,pending:false};modalSession=session;
  modal.className=options.className?`app-modal ${options.className}`:'app-modal';modal.dataset.size=options.size||'standard';modal.setAttribute('aria-labelledby','modal-title');
  modal.removeAttribute('aria-describedby');
  const source=document.createElement('template');source.innerHTML=body;
  const form=$('form',source.content),frame=form||document.createElement('div');frame.classList.add('modal-frame');
  const footer=$('.modal-footer',source.content)||document.createElement('footer');footer.classList.add('modal-footer');
  const formError=$('.form-error',source.content);if(formError)footer.prepend(formError);
  footer.remove();
  if(!$('.modal-footer-right',footer)){const actions=document.createElement('div');actions.className='modal-footer-right';const close=document.createElement('button');close.type='button';close.className='button ghost';close.dataset.action='close-modal';close.textContent=globalThis.AIWSI18n.text('Kapat');actions.append(close);for(const button of [...footer.querySelectorAll('button')])actions.append(button);footer.append(actions);}
  const scroll=document.createElement('div');scroll.className='modal-body';scroll.id='modal-scroll-body';
  if(form)scroll.append(...form.childNodes);else scroll.append(...source.content.childNodes);
  frame.append(scroll,footer);
  const header=document.createElement('header');header.className='modal-header';header.innerHTML=globalThis.AIWSI18n.template`<div class="modal-heading"><h2 id="modal-title">${esc(title)}</h2>${options.description?`<p id="modal-description">${esc(options.description)}</p>`:''}</div><button type="button" class="icon-button" id="close-modal" aria-label="Pencereyi kapat">×</button>`;
  if(modal.classList.contains('task-editor-modal'))placeFilesToggleInModal(true,header);
  if(options.description)modal.setAttribute('aria-describedby','modal-description');
  $('#modal-content').replaceChildren(header,frame);$('#close-modal').onclick=()=>void requestModalClose('button');
  if(form&&submit)form.onsubmit=async event=>{event.preventDefault();if(session.pending||$('[type=submit]',form)?.disabled)return;const button=$('[type=submit]',form);session.pending=true;if(button){button.disabled=true;button.classList.add('is-busy');}frame.setAttribute('aria-busy','true');try{await submit(new FormData(form),form);if(modalSession===session){modal.close();await refresh();}}catch(cause){if(modalSession===session){const target=$('.form-error',footer);if(target)target.textContent=cause.message;else error(cause.message);}}finally{session.pending=false;frame.removeAttribute('aria-busy');if(button){button.disabled=false;button.classList.remove('is-busy');}}};
  // A form without a submit handler must never navigate the page away.
  else if(form)form.onsubmit=event=>event.preventDefault();
  // Typed input makes a dialog dirty: a backdrop click then keeps it, and Escape or × asks before discarding. A search box holds no work, and a
  // change the page fires itself (a default filled in once data arrives) is not the user's.
  if(form&&submit)for(const type of ['input','change'])form.addEventListener(type,event=>{if(event.target.type!=='search'&&(event.isTrusted||type==='input'))session.dirty=true;});
  if(!modal.open)modal.showModal();
  ($('[autofocus]',scroll)||$('input:not([type=hidden]),textarea,select',scroll)||$('[data-action="close-modal"]',footer)||$('#close-modal')).focus();
}
function restoreModalFocus(session){const active=document.activeElement;if(active&&active!==document.body&&!$('#modal').contains(active))return;const target=session?.returnFocus?.isConnected?session.returnFocus:session?.returnFocus?.id?document.getElementById(session.returnFocus.id):session?.returnAttributes?.length?$$('button').find(button=>session.returnAttributes.every(([name,value])=>button.getAttribute(name)===value)):null;target?.focus({preventScroll:true});}
$('#modal').addEventListener('close',()=>{if($('#modal').open||!modalSession)return;const session=modalSession;if(session.answer){session.answer(false);if(modalSession!==session)return;}placeFilesToggleInModal(false);modalSession=null;$('#modal').dispatchEvent(new Event('modalreset'));$('#modal form')?.dispatchEvent(new Event('modalreset'));restoreModalFocus(session);});
/** Moves the open dialog out of the way, still connected (a shadow root isolates its field IDs) so its async work keeps running. */
function parkModal(){
  const modal=$('#modal'),content=$('#modal-content'),focus=document.activeElement;
  // The borrowed files toggle goes back to the top bar first: inside the shadow root the page could not find it any more.
  placeFilesToggleInModal(false);
  const selection=typeof focus?.selectionStart==='number'?[focus.selectionStart,focus.selectionEnd,focus.selectionDirection]:null;
  const scrollPositions=[...content.querySelectorAll('.modal-body')].map(element=>[element,element.scrollTop]);
  const storage=document.createElement('div');storage.hidden=true;document.body.append(storage);
  const parkedContent=storage.attachShadow({mode:'open'});parkedContent.append(...content.childNodes);
  return {session:modalSession,storage,parkedContent,focus,selection,scrollPositions,className:modal.className,size:modal.dataset.size,describedBy:modal.getAttribute('aria-describedby')};
}
/** Puts a parked dialog back with its session, scroll positions and focus. */
function unparkModal(parked,fallbackFocus='[autofocus],input:not([type=hidden]),textarea,select'){
  const modal=$('#modal');
  $('#modal-content').replaceChildren(...parked.parkedContent.childNodes);parked.storage.remove();
  modalSession=parked.session;modal.className=parked.className;modal.dataset.size=parked.size;if(parked.describedBy)modal.setAttribute('aria-describedby',parked.describedBy);else modal.removeAttribute('aria-describedby');
  if(modal.classList.contains('task-editor-modal'))placeFilesToggleInModal(true,$('.modal-header',modal));
  if(!modal.open)modal.showModal();
  $('form',modal)?.dispatchEvent(new Event('modalresume'));
  for(const [element,top] of parked.scrollPositions)element.scrollTop=top;
  const focus=parked.focus?.isConnected&&modal.contains(parked.focus)?parked.focus:$(fallbackFocus,modal);focus?.focus({preventScroll:true});
  if(focus===parked.focus&&parked.selection)focus.setSelectionRange?.(...parked.selection);
}
/** The one yes/no question, in the modal frame; resolves true only on the confirm button. Asked over an open dialog, that
 * dialog is parked meanwhile and comes back unchanged whatever the answer. `alternativeLabel` adds a second way to go on
 * (save / don't save), which resolves 'alternative'. */
function confirmModal(title,message,{confirmLabel,danger=false,alternativeLabel}={}){
  const modal=$('#modal'),parked=modal.open&&modalSession?parkModal():null;
  return new Promise(resolve=>{
    showModal(title,`<form><p class="form-hint">${esc(message)}</p>${formFooter(esc(confirmLabel||globalThis.AIWSI18n.text('Onayla')),alternativeLabel?`<button type="button" class="button" data-confirm-alternative>${esc(alternativeLabel)}</button>`:'')}</form>`);
    const session=modalSession,form=$('#modal form'),confirm=$('[type=submit]',form);
    $('[data-confirm-alternative]',form)?.addEventListener('click',()=>session.answer?.('alternative'));
    confirm.classList.toggle('primary',!danger);confirm.classList.toggle('danger',danger);if(!danger)confirm.focus();
    session.answer=value=>{session.answer=null;if(parked)unparkModal(parked);else if(modalSession===session)modal.close();resolve(value);};
    form.onsubmit=event=>{event.preventDefault();session.answer?.(true);};
  });
}
/** Closes the dialog the way the user asked: a question answers no, a task draft minimizes on Escape or a backdrop click (it is saved anyway), and a dirty
 * form ignores the backdrop and asks before Escape or × discard it. "Vazgeç" (`cancel`) is an explicit discard. */
async function requestModalClose(reason){
  const modal=$('#modal'),session=modalSession;
  if(session?.answer){session.answer(false);return;}
  if(session?.taskDraft&&['escape','backdrop'].includes(reason)){minimizeTaskDraft();return;}
  if(session?.dirty&&!session.taskDraft&&!session.pending&&reason!=='cancel'){
    if(reason==='backdrop')return;
    const t=globalThis.AIWSI18n.text;
    if(!await confirmModal(t('Değişiklikler kaydedilmedi'),t('Kaydedilmemiş değişiklikler silinsin mi?'),{confirmLabel:t('Değişiklikleri sil'),danger:true}))return;
  }
  if(modalSession===session)modal.close();
}
$('#modal').addEventListener('cancel',event=>{event.preventDefault();void requestModalClose('escape');});
$('#modal').addEventListener('keydown',event=>{
  if(event.defaultPrevented)return;
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();void requestModalClose('escape');return;}
  if(event.key!=='Tab')return;
  const focusable=focusableIn($('#modal'));
  const first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&(document.activeElement===first||!$('#modal').contains(document.activeElement))){event.preventDefault();last?.focus();}else if(!event.shiftKey&&(document.activeElement===last||!$('#modal').contains(document.activeElement))){event.preventDefault();first?.focus();}
});
// A click on the backdrop lands on the dialog itself outside its box.
$('#modal').addEventListener('click',event=>{if(event.target===$('#modal')) {const rect=event.target.getBoundingClientRect(); if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)void requestModalClose('backdrop');}});
document.addEventListener('click',event=>{if(event.target.closest('button[data-action="close-modal"]'))void requestModalClose('cancel');});
