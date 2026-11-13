'use strict';
// Task status names and which run statuses count as active.
const statuses = {backlog:globalThis.AIWSI18n.text('Bekleyen'),ready:globalThis.AIWSI18n.text('Hazır'),running:globalThis.AIWSI18n.text('Çalışıyor'),waiting:globalThis.AIWSI18n.text('Yanıt bekliyor'),paused:globalThis.AIWSI18n.text('Duraklatıldı'),review:globalThis.AIWSI18n.text('İnceleme'),completing:globalThis.AIWSI18n.text('Tamamlanıyor'),done:globalThis.AIWSI18n.text('Tamamlandı'),failed:globalThis.AIWSI18n.text('Başarısız'),cancelled:globalThis.AIWSI18n.text('İptal edildi')};
/** A run is active while it runs, waits for an answer or is paused. */
const activeRun=run=>Boolean(run)&&['running','waiting','paused'].includes(run.status);
