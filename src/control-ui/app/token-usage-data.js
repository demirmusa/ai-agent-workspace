'use strict';
// Subscription usage data: loading it from the control server, polling and redrawing everything that shows it.
// Subscription usage: per-provider quota pills in the board footer and a dialog with one nested card per provider (reference v3).
// The minute poll reads local data only. Remote checks run per provider in parallel, so each card updates as soon as its provider
// answers: opening the dialog asks the server for a throttled check (at most every five minutes), Yenile for a forced one.
let tokenUsageData = null, tokenUsageError = '', tokenUsageLocal = null;
/** Provider ID → its running remote check ({force, again}) and the time its last remote check answered. */
const tokenUsageChecks = new Map(), tokenUsageCheckedAt = new Map();
const tokenUI = window.AIWSUI;
/** The provider a usage card belongs to: an account card names it, a provider's own card is keyed by it. */
function tokenProviderId(item) { return item.provider||item.key; }
/** Replaces one provider's cards (its own and its accounts') in place with a newer answer. */
function tokenMergeProvider(list, id, cards) {
  let placed = false;
  const merged = list.flatMap(item => tokenProviderId(item)!==id ? [item] : placed ? [] : (placed = true, cards));
  return placed ? merged : [...merged, ...cards];
}
/** Reads the local usage data; concurrent callers share one request. */
function loadTokenUsage() {
  return tokenUsageLocal ??= (async () => {
    const startedAt = Date.now();
    try {
      const data = await api('/token-usage');
      // A remote answer that arrived while this read ran is newer than what it returned for that provider.
      for (const [id,at] of tokenUsageCheckedAt) if (at>startedAt&&tokenUsageData) data.providers = tokenMergeProvider(data.providers,id,tokenUsageData.providers.filter(item => tokenProviderId(item)===id));
      tokenUsageData = data; tokenUsageError = ''; refreshUsageFields();
    }
    catch(error){tokenUsageError=globalThis.AIWSI18n.template`Kullanım bilgileri alınamadı: ${error.message}`;}
    finally{tokenUsageLocal=null;renderTokenUsage();}
  })();
}
/** Checks one provider remotely and shows its cards as soon as they arrive; a forced check asked during an automatic one runs after it. */
async function checkTokenProvider(id, force = false) {
  const running = tokenUsageChecks.get(id);
  if (running) { if (force&&!running.force) running.again = true; return; }
  const check = {force,again:false}; tokenUsageChecks.set(id,check); renderTokenUsage();
  try {
    const data = await api(`/token-usage?refresh=${force?'force':'1'}&provider=${encodeURIComponent(id)}`);
    tokenUsageData = {...tokenUsageData,providers:tokenMergeProvider(tokenUsageData?.providers||[],id,data.providers),timestamp:data.timestamp};
    tokenUsageError = ''; tokenUsageCheckedAt.set(id,Date.now()); refreshUsageFields();
  }
  catch(error){tokenUsageError=globalThis.AIWSI18n.template`Kullanım bilgileri alınamadı: ${error.message}`;}
  finally{tokenUsageChecks.delete(id);if(check.again)void checkTokenProvider(id,true);else renderTokenUsage();}
}
/** Checks every provider remotely, each on its own; force is the dialog's Yenile. */
async function checkTokenUsage(force = false) {
  if (!tokenUsageData) await loadTokenUsage();
  const ids = [...new Set((tokenUsageData?.providers||[]).map(tokenProviderId))];
  await Promise.all(ids.map(id => checkTokenProvider(id,force)));
}
/** A provider's remote check state for its refresh button: running, just answered or idle. */
function tokenCheckState(id) { return tokenUsageChecks.has(id) ? 'busy' : Date.now()-(tokenUsageCheckedAt.get(id)??0)<2500 ? 'done' : ''; }
function renderTokenUsage() {
  renderTokenFooter();
  const host = $('#token-usage-detail'); if (host && $('#modal')?.open) patchTokenUsage(host,tokenUsageData?.providers||[]);
}
const tokenUsagePoll=setInterval(()=>{if(!document.hidden)void loadTokenUsage();},60000);
const tokenUsageClock=setInterval(()=>{if(!document.hidden)renderTokenUsage();},1000);
// Hidden windows (minimized or in the tray) skip all drawing; catch up once when shown.
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void loadTokenUsage();});
window.addEventListener('pagehide',()=>{clearInterval(tokenUsagePoll);clearInterval(tokenUsageClock);});
