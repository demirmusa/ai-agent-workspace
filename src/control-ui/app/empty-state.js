'use strict';
// The empty state of a page or list.
/** An empty page or list: a tile with the AI sparkle (or another mark), a heading, a note and an optional action. Callers pass translated, escaped text. */
function emptyState({className='',title,text='',action='',mark=window.AIWSUI.sparkle('accent'),level=2,role=''}){return `<div class="empty-state ${className}"${role?` role="${role}"`:''}><span class="empty-tile" aria-hidden="true">${mark}</span><h${level}>${title}</h${level}>${text?`<p>${text}</p>`:''}${action}</div>`;}
