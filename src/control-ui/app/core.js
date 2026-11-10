'use strict';
// DOM lookups, focus helpers and the shared UI helpers every view uses.
const $ = (selector, root = document) => root.querySelector(selector);
function $$(selector,root=document){return [...root.querySelectorAll(selector)];}
function focusableIn(container) {
  return [...container.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]):not([type=hidden]),textarea:not([disabled]),select:not([disabled]),summary,[tabindex="0"]')].filter(element=>{
    if(element.closest('[hidden]'))return false;
    for(let parent=element.parentElement;parent&&parent!==container;parent=parent.parentElement)if(parent.tagName==='DETAILS'&&!parent.open&&parent.firstElementChild!==element)return false;
    return !element.closest('.cv-raw')||Boolean(element.closest('.cv-show-technical'));
  });
}
const {esc,copyText,providerIcon}=window.AIWSUI;
