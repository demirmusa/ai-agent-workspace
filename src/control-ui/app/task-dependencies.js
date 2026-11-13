'use strict';
// The Blocked by search of the task information tab.
let infoDependencyResults=[],infoSearchTimer,infoSearchController,infoSearchSequence=0;
// Search results carry the full task id as their code; show the same short key the task header uses.
const dependencyResultKey=result=>result.issueNumber?`#${result.issueNumber}`:result.id?localTaskKey(result.id):result.code||result.reference;
async function infoDependencySearch(item){
  const input=document.querySelector('#info-blocked-search'),results=document.querySelector('#info-blocked-results'),label=document.querySelector('#info-blocked-state');if(!input)return;
  const q=input.value.trim();infoSearchController?.abort();const sequence=++infoSearchSequence;
  if(!q){results.hidden=true;input.setAttribute('aria-expanded','false');label.textContent='';return;}
  infoSearchController=new AbortController();label.textContent=globalThis.AIWSI18n.text('Aranıyor…');
  try{
    const response=await api(`/tasks/search?${new URLSearchParams({projectId:item.projectId,q,limit:'20',excludeTaskId:item.id})}`,'GET',undefined,{signal:infoSearchController.signal});if(sequence!==infoSearchSequence||!input.isConnected)return;
    infoDependencyResults=(response.items||[]).filter(result=>!(item.dependsOn||[]).includes(result.id));
    results.innerHTML=infoDependencyResults.length?infoDependencyResults.map((result,index)=>`<button type="button" role="option" data-info-dependency-result="${index}"><span class="dependency-result-text"><strong>${esc(result.title)}</strong><small><span class="dependency-reference" title="${esc(result.id||result.reference)}">${esc(dependencyResultKey(result))}</span><span>${esc(statuses[result.status]||result.status)}${result.remote?' · GitHub issue':''}</span></small></span><span aria-hidden="true">+</span></button>`).join(''):globalThis.AIWSI18n.text('<p>Eşleşen iş bulunamadı.</p>');
    results.hidden=false;input.setAttribute('aria-expanded','true');label.textContent=infoDependencyResults.length?globalThis.AIWSI18n.template`${infoDependencyResults.length} sonuç`:globalThis.AIWSI18n.text('Sonuç yok');
  }catch(problem){if(problem.name==='AbortError'||sequence!==infoSearchSequence)return;label.textContent=problem.message;results.hidden=true;}
}
function addInfoDependency(item,result){const input=document.querySelector('#info-blocked-search');if(input){input.value='';input.blur();}infoDependencyResults=[];void saveTaskField(item,{dependencyRefs:[...new Set([...(item.dependsOn||[]),result.id||result.reference])]});}
document.addEventListener('input',event=>{if(event.target.id!=='info-blocked-search')return;const item=task();clearTimeout(infoSearchTimer);infoSearchController?.abort();infoSearchSequence++;infoSearchTimer=setTimeout(()=>{if(item&&task()?.id===item.id)void infoDependencySearch(item);},250);});
document.addEventListener('click',event=>{
  if(!event.target.closest?.('.detail-information'))return;const item=task();if(!item)return;
  const remove=event.target.closest('[data-info-remove-dependency]');if(remove){void saveTaskField(item,{dependencyRefs:(item.dependsOn||[]).filter(id=>id!==remove.dataset.infoRemoveDependency)});return;}
  const result=event.target.closest('[data-info-dependency-result]');if(result){const chosen=infoDependencyResults[Number(result.dataset.infoDependencyResult)];if(chosen)addInfoDependency(item,chosen);return;}
});
document.addEventListener('keydown',event=>{
  const target=event.target;
  if(target.id==='info-blocked-search'){if(event.key==='Escape'){event.preventDefault();event.stopPropagation();document.querySelector('#info-blocked-results').hidden=true;target.setAttribute('aria-expanded','false');}if(event.key==='Enter'){event.preventDefault();const item=task();if(item&&infoDependencyResults.length===1&&!document.querySelector('#info-blocked-results').hidden)addInfoDependency(item,infoDependencyResults[0]);else if(item){clearTimeout(infoSearchTimer);void infoDependencySearch(item);}}return;}
},true);
