'use strict';
// The welcome screen shown while no project exists or none is open.
/** The empty workspace: an AI sparkle tile glowing on a dotted canvas, a short pitch and the first-project action. */
function welcomeHtml(){return globalThis.AIWSI18n.template`<div class="welcome"><div class="welcome-canvas ui-canvas" aria-hidden="true"></div><div class="welcome-mark" aria-hidden="true">${window.AIWSUI.sparkle('accent')}</div><h2>Bir sonraki fikrine yer aç.</h2><p>Her proje kendi panosunu, agentlarını ve çalışma geçmişini tutar. Yerelde başla, istediğinde GitHub Projects’e bağlan.</p><button type="button" data-action="create-project" class="button primary">İlk projeyi oluştur</button><p class="welcome-note">Yerel öncelikli · Canlı agent oturumları · GitHub Projects</p></div>`;}
