'use strict';
// The desktop zoom level in the general settings. The main process owns and saves it; a browser has its own zoom, so the card is desktop only.
let desktopZoom=null;
function zoomSettingMarkup(){
  if(!window.aiwsDesktop?.zoom)return '';
  const t=globalThis.AIWSI18n.text;
  return `<div class="settings-card" data-motion-key="settings:general:zoom"><div class="form-field"><label id="zoom-setting-label">${esc(t('Yakınlaştırma'))}</label><div class="zoom-setting" role="group" aria-labelledby="zoom-setting-label"><button type="button" class="button small ghost zoom-setting-step" data-zoom-change="out" aria-label="${esc(t('Uzaklaştır'))}" title="${esc(t('Uzaklaştır'))}">−</button><output id="zoom-setting-level" class="zoom-setting-level" aria-live="polite"></output><button type="button" class="button small ghost zoom-setting-step" data-zoom-change="in" aria-label="${esc(t('Yakınlaştır'))}" title="${esc(t('Yakınlaştır'))}">+</button><button type="button" class="button small ghost" data-zoom-change="reset">${esc(t('%100\'e sıfırla'))}</button></div><small>${esc(t('Arayüzün boyutunu tüm pencerelerde hemen değiştirir ve yeniden başlatınca korunur.'))}</small></div></div>`;
}
function syncZoomSetting(){
  const level=$('#zoom-setting-level');if(!level||!desktopZoom)return;
  const {percent,min,max,default:initial}=desktopZoom,buttons=$('.zoom-setting').querySelectorAll('[data-zoom-change]');
  level.textContent=`${percent}%`;
  for(const button of buttons)button.disabled=percent===({out:min,in:max,reset:initial})[button.dataset.zoomChange];
}
function showDesktopZoom(state){desktopZoom=state;syncZoomSetting();}
if(window.aiwsDesktop?.zoom){
  void window.aiwsDesktop.zoom.get().then(showDesktopZoom).catch(()=>{});
  window.aiwsDesktop.zoom.onChange(showDesktopZoom);
  document.addEventListener('click',event=>{const change=event.target.closest?.('[data-zoom-change]')?.dataset.zoomChange;if(change)void window.aiwsDesktop.zoom.change(change).then(showDesktopZoom).catch(()=>{});});
}
