'use strict';
// Run parameter history of each script: kept encrypted in the server database, cached here for the synchronous renderers.
const runArgsHistoryKey=id=>`aiws.run-script-args-history.${id}`;
const runArgsCache=new Map(),runArgsPath=(projectId,scriptId)=>`/projects/${projectId}/run-script-history/${scriptId}`;
const runArgsHistory=id=>runArgsCache.get(id)||[];
function legacyRunArgsHistory(id){try{const history=JSON.parse(localStorage.getItem(runArgsHistoryKey(id))||'[]');return Array.isArray(history)?history:[];}catch{return [];}}
async function loadRunArgsHistory(projectId,scriptId){let history=[];try{history=(await api(runArgsPath(projectId,scriptId))).history||[];if(!history.length){const legacy=legacyRunArgsHistory(scriptId);if(legacy.length)history=(await api(runArgsPath(projectId,scriptId),'PUT',{history:legacy})).history;}try{localStorage.removeItem(runArgsHistoryKey(scriptId));localStorage.removeItem(`aiws.run-script-args.${scriptId}`);}catch{/* Legacy copies are optional. */}}catch{history=runArgsHistory(scriptId);}runArgsCache.set(scriptId,history);}
async function saveRunArgsHistory(projectId,scriptId,history){const result=await api(runArgsPath(projectId,scriptId),'PUT',{history});runArgsCache.set(scriptId,result.history);}
function runArgsLabel(value){if(typeof value==='string')return value||globalThis.AIWSI18n.text('Parametresiz');const entries=Object.entries(value||{}).filter(([,item])=>item!=='');return entries.length?entries.map(([key,item])=>`${key}=${item}`).join(' · '):globalThis.AIWSI18n.text('Parametresiz');}
