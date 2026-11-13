'use strict';
// HTTP requests to the control server and the state refresh.
// The access token lives only in this tab's session storage and travels in the Authorization header, never in a URL.
let token = sessionStorage.getItem('aiws.token') || '';
// Terminal keystrokes and resizes pass `quiet`: they stream continuously and are not user actions to wait for.
async function api(path, method = 'GET', body, options = {}) {
  const tracked=method!=='GET'&&!options.quiet;
  if(tracked)trackChange(1);
  try{
    const data=await request(path,method,body,options);
    // Tasks this page creates are its own; AI notices only announce tasks created elsewhere.
    if(method==='POST'&&path==='/tasks'&&data?.id)aiOwnTasks.add(data.id);
    return data;
  }finally{if(tracked)trackChange(-1);}
}
async function request(path, method, body, options) {
  const response = await fetch(`/api${path}`, {method, ...(options.signal?{signal:options.signal}:{}), headers:{...(body !== undefined ? {'Content-Type':'application/json'} : {}),...(token ? {Authorization:`Bearer ${token}`} : {})}, ...(body !== undefined ? {body:JSON.stringify(body)} : {})});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { if(response.status === 401) showTokenDialog(); throw Object.assign(new Error(data.error || globalThis.AIWSI18n.template`İstek tamamlanamadı (${response.status})`), { status: response.status }); }
  return data;
}
// With a live stream the journal (events/messages) arrives as deltas; a refresh
// then only needs the compact state instead of megabytes of history.
// A read travels on its own connection, so it can arrive after a newer stream message. Applying it would drop what that message
// brought (a new task's card) until the record next changes, so an outdated read is repeated instead.
let appliedStateRevision=0;
const noteStateRevision=revision=>{if(typeof revision==='number'&&revision>appliedStateRevision)appliedStateRevision=revision;};
async function refresh() { try { for(let attempt=0;attempt<3;attempt++){const {revision,...data} = await api(streamLive ? '/state?journal=0' : '/state'); if(revision<appliedStateRevision)continue; noteStateRevision(revision); applyState(data); break;} connection(true); } catch (e) { connection(false); reportClientError(e, 'refresh'); error(e.message); } }
/** Sends an error with its stack trace to the server's error log (`<data dir>/logs/errors.log`); a failing report is dropped. */
function reportClientError(failure, context = '') {
  const known = failure instanceof Error;
  void api('/client-errors', 'POST', { message: known ? failure.message : String(failure?.message ?? failure), stack: known ? failure.stack || '' : '', context }, { quiet: true }).catch(() => {});
}
window.addEventListener('error', event => reportClientError(event.error || event.message, `window error ${event.filename || ''}:${event.lineno || 0}:${event.colno || 0}`));
window.addEventListener('unhandledrejection', event => reportClientError(event.reason, 'unhandled rejection'));
/** A change that reports its failure in the error banner, confirms with a toast and refreshes the state. */
async function mutate(path,method,body,message) {try {const result=await api(path,method,body); if(message) toast(message); await refresh(); return result;} catch(e) {reportClientError(e,`${method} ${path}`);error(e.message);} }
