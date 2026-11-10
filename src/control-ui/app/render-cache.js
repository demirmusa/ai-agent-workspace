'use strict';
// Skips DOM writes whose markup did not change.
const htmlCache=new WeakMap();
function setHtml(element,html){const cached=htmlCache.get(element);if(cached&&cached.html===html&&cached.first===element.firstChild&&cached.last===element.lastChild)return false;element.innerHTML=html;htmlCache.set(element,{html,first:element.firstChild,last:element.lastChild});return true;}
