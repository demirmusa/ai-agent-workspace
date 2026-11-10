'use strict';
// Subscription usage numbers and their wording.
const tokenPercentFormat = new Intl.NumberFormat(globalThis.AIWSI18n.locale,{style:'percent',maximumFractionDigits:0});
// Days come from Intl so English gets "1 day" and "3 days"; hours and minutes keep the app's "sa"/"dk" abbreviations.
const tokenDayFormat = new Intl.NumberFormat(globalThis.AIWSI18n.locale,{style:'unit',unit:'day',unitDisplay:'long'});
// Legend rows take the data-viz colours in this order, so the first (default) window is the vivid one.
const tokenColours = ['--viz-4','--viz-1','--viz-5','--viz-2','--viz-3'];
/** Whole percent of a window already used, or null when the provider did not report it. */
function tokenUsed(window) { return window?.usedPercent == null ? null : Math.round(window.usedPercent); }
/** Whole percent still available: 100 minus the rounded use, so used and remaining always add up. Null when unknown. */
function tokenRemaining(window) { const used = tokenUsed(window); return used == null ? null : 100-used; }
/** A 0–100 share as a localized percent ("%24" in Turkish, "24%" in English); "--" when unknown. */
function tokenPercent(value) { return value == null || !Number.isFinite(Number(value)) ? '--' : tokenPercentFormat.format(Number(value)/100); }
/** Tone of a share used: needs from 80 %, failed from 95 %, none while there is room. */
function tokenTone(used) { return used == null ? '' : used >= 95 ? 'failed' : used >= 80 ? 'needs' : ''; }
/** Milliseconds until a window with known use resets; null when its use or reset time is unknown. */
function tokenResetIn(window) { const at = window?.usedPercent == null || !window.resetsAt ? NaN : new Date(window.resetsAt).getTime(); return Number.isFinite(at) ? at-Date.now() : null; }
/** Time left until a window resets ("3 gün 4 sa", "2 sa 14 dk", "14 dk"); "Bekleniyor" once due, '' when unknown. */
function tokenReset(window) {
  const difference = tokenResetIn(window); if (difference == null) return ''; if (difference <= 0) return globalThis.AIWSI18n.text('Bekleniyor');
  const minutes = Math.ceil(difference/60000), days = Math.floor(minutes/1440), hours = Math.floor(minutes%1440/60), mins = minutes%60;
  return days ? (hours ? globalThis.AIWSI18n.template`${tokenDayFormat.format(days)} ${hours} sa` : tokenDayFormat.format(days)) : hours ? (mins ? globalThis.AIWSI18n.template`${hours} sa ${mins} dk` : globalThis.AIWSI18n.template`${hours} sa`) : globalThis.AIWSI18n.template`${mins} dk`;
}
/** A clock time for today, otherwise a short date with the time. */
function tokenTime(value) { return dateTime(value,new Date(value).toDateString()===new Date().toDateString()?{hour:'numeric',minute:'2-digit'}:{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'}); }
/** When a window resets (time left and clock time, or only the clock time), or why that is unknown. */
function tokenWindowDetail(window, clockOnly = false) {
  const difference = tokenResetIn(window);
  return window?.usedPercent == null ? globalThis.AIWSI18n.text('Kullanım verisi yok') : difference == null ? globalThis.AIWSI18n.text('Sıfırlanma zamanı bilinmiyor') : difference <= 0 ? globalThis.AIWSI18n.text('Yenilenme bekleniyor') : clockOnly ? globalThis.AIWSI18n.template`Sıfırlanma ${tokenTime(window.resetsAt)}` : globalThis.AIWSI18n.template`${tokenReset(window)} sonra sıfırlanır · ${tokenTime(window.resetsAt)}`;
}
function tokenWindowLabel(minutes) {
  if (minutes === 300) return globalThis.AIWSI18n.text('5 saatlik kota');
  if (minutes === 1440) return globalThis.AIWSI18n.text('Günlük kota');
  if (minutes === 10080) return globalThis.AIWSI18n.text('Haftalık kota');
  if (minutes >= 40320 && minutes <= 44640) return globalThis.AIWSI18n.text('Aylık kota');
  return globalThis.AIWSI18n.template`${minutes} dakikalık kota`;
}
// Windows the provider reports; both placeholders stay when nothing is known yet.
function tokenWindows(item) {
  const known = [item.short, item.weekly].filter(window => window?.usedPercent != null);
  return known.length ? known : [item.short, item.weekly];
}
/** Legend rows of a provider card: the windows it reports, then its extra buckets (Antigravity repeats its main windows as buckets; a scoped bucket reads as its window plus what it covers). */
function tokenRows(item) {
  const rows = tokenWindows(item).map(window => ({key:window===item.weekly?'weekly':'short',label:tokenWindowLabel(window.windowMinutes),window}));
  for (const bucket of item.buckets||[]) if (!['gemini-5h','gemini-weekly'].includes(bucket.id)&&!rows.some(row => row.key===`bucket:${bucket.id}`)) rows.push({key:`bucket:${bucket.id}`,label:bucket.scope?`${tokenWindowLabel(bucket.window.windowMinutes)} (${bucket.scope})`:bucket.label,window:bucket.window});
  return rows.map((row,index) => ({...row,colour:`var(${tokenColours[index%tokenColours.length]})`}));
}
/** When the numbers were read and from where, for a card's footer. */
function tokenMeta(item) {
  return item.source==='unavailable' ? globalThis.AIWSI18n.text('Veri yok') : `${globalThis.AIWSI18n.text('Son veri:')} ${item.updatedAt?tokenTime(item.updatedAt):'--'}${item.source==='cache'?globalThis.AIWSI18n.text(' · Önbellek'):item.source==='api'?globalThis.AIWSI18n.text(' · API yanıtı'):''}${item.active?globalThis.AIWSI18n.text(' · Yakın zamanda etkin'):''}`;
}
