'use strict';
// AI draft cards: a draft's goal, outline, agent, model, priority, labels and dependencies, patched in place on every update, and
// the card controls (edit fields, open the task editor, create, discard).
const aiPlannerAgents=selected=>state.agents.filter(agent=>(agent.enabled&&agent.provider!=='command')||agent.id===selected);
function aiAgentOptions(selected,automatic){return `<option value="">${esc(automatic)}</option>`+aiPlannerAgents(selected).map(agent=>`<option value="${esc(agent.id)}">${esc(agent.name)} · ${esc(providers[agent.provider])}${agent.enabled?'':globalThis.AIWSI18n.text(' (devre dışı)')}</option>`).join('');}
function setAIOptions(select,html,value){if(select.dataset.options!==html){select.innerHTML=html;select.dataset.options=html;}if(document.activeElement!==select&&select.value!==String(value??''))select.value=String(value??'');}
// Cards show the goal (the description's first plain paragraph, else its first list item) and how many steps and acceptance criteria
// follow it; the full Markdown is edited in the task editor.
const aiPlain=line=>line.replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/^\s{0,3}(?:#{1,6}|[-*+>]|\d+[.)])\s+/,'').replace(/^\[[ xX]\]\s*/,'').replace(/[*_`~|]+/g,'').replace(/\s+/g,' ').trim();
function aiOutline(markdown){
  let summary='',first='',steps=0,criteria=0,inCriteria=false;
  for(const line of String(markdown||'').replace(/```[\s\S]*?```/g,'').split('\n')){
    const text=aiPlain(line);if(!text)continue;
    if(/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)){if(inCriteria)criteria++;else steps++;first||=text;continue;}
    if(text.length<60&&/kabul|kriter|accept|criteri|definition of done/i.test(text)){inCriteria=true;continue;}
    if(!summary&&!/^\s*#|^\s*\*\*[^*]+\*\*:?\s*$/.test(line))summary=text;
  }
  summary||=first;return {summary:summary.length>220?`${summary.slice(0,219).trimEnd()}…`:summary,steps,criteria};
}
// A draft node: the label chip with badges and hover tools above its card. Built once per mode and patched in place by updateAIDraftCard,
// so a focused select survives re-renders; turning into a created node rebuilds it and renderAIDrafts fades the new card in.
function aiDraftCard(workspace,draft){
  const created=Boolean(draft.createdTaskId);let node=workspace.cards.get(draft.key);
  if(node&&node.dataset.mode===(created?'created':'open'))return node;
  const swapped=Boolean(node),{icon,sparkle}=window.AIWSUI,t=globalThis.AIWSI18n,pickerId=`ai-model-${String(draft.key).replace(/[^\w-]/g,'_')}`;if(node){workspace.resize?.unobserve(node);node.remove();}
  node=document.createElement('article');node.className=`ai-node${created?' created':''}`;node.dataset.aiDraft=draft.key;node.dataset.mode=created?'created':'open';node.setAttribute('role','listitem');if(created)node.dataset.tone='done';
  node.innerHTML=created?t.template`<div class="ai-node-tag"><span class="ai-node-chip">${icon('check')}Oluşturuldu</span></div><div class="ai-card ui-card"><span class="ai-card-done" aria-hidden="true">${icon('check')}</span><div class="ai-card-created-text"><strong data-ai-created-title></strong><small data-ai-created-meta></small></div><button type="button" class="button small" data-ai-open-task>Görevi aç</button><button type="button" class="icon-button ai-card-icon" data-ai-dismiss aria-label="Listeden kaldır" title="Listeden kaldır">${icon('x')}</button></div>`:t.template`<div class="ai-node-tag"><span class="ai-node-chip" data-tone="accent">Görev <span data-ai-index></span></span><span class="ai-card-badges" data-ai-badges></span><span class="ai-card-tools"><button type="button" class="icon-button ai-card-icon" data-ai-expand aria-label="Görev penceresinde aç" title="Büyüt · görev penceresinde aç">${aiExpandIcon}</button><button type="button" class="icon-button ai-card-icon" data-ai-discard aria-label="Taslağı at" title="Taslağı at">${icon('x')}</button></span></div><div class="ai-card ui-card"><button type="button" class="ai-card-body" data-ai-expand title="Görev penceresinde aç"><span class="ai-card-heading">${sparkle('accent')}<strong class="ai-card-title" data-ai-title></strong></span><span class="ai-card-summary" data-ai-summary></span><span class="ai-card-outline" data-ai-outline hidden></span></button><div class="ai-card-fields"><label class="ai-select-chip" data-ai-agent-field title="Agent" hidden><span class="sr-only">Agent</span><select data-field="agentId"></select>${icon('chevron')}</label><span data-ai-model-field>${agentPickerMarkup({},{id:pickerId,variant:'ai-select-chip',inherit:`${t.text('Agenttan / varsayılan')} · ${providers[defaultProvider()]}`})}</span><label class="ai-select-chip" title="Öncelik"><span class="sr-only">Öncelik</span><select data-field="priority"></select>${icon('chevron')}</label></div><div class="ai-card-labels" data-ai-labels hidden></div><div class="ai-card-dependencies" data-ai-dependencies hidden></div><p class="ai-card-extra" data-ai-extra hidden></p><footer class="ai-card-actions"><span class="ai-card-status" data-ai-status role="status"></span><button type="button" class="button small primary" data-ai-create>Oluştur</button></footer></div>`;
  if(!created){const agentOf=()=>state.agents.find(item=>item.id===draft.values.agentId);mountAgentPicker(node.querySelector('[data-ai-model-field]'),{id:pickerId,inheritProvider:()=>agentOf()?.provider||defaultProvider(),inheritModel:()=>{const agent=agentOf();return agent?.model&&(!draft.values.provider||draft.values.provider===agent.provider)?t.template`Agenttan · ${agent.model}`:t.text('Varsayılan model');}});}
  if(swapped)node.aiSwapped=true;workspace.resize?.observe(node);workspace.cards.set(draft.key,node);return node;
}
function updateAIDraftCard(workspace,draft){
  const card=aiDraftCard(workspace,draft),values=draft.values,$=selector=>card.querySelector(selector),t=globalThis.AIWSI18n;
  // Re-renders run on every streamed event while the sheet is open, so unchanged text is left alone.
  const text=(selector,value)=>{const target=$(selector);if(target.textContent!==value)target.textContent=value;return target;};
  if(draft.createdTaskId){const created=state.tasks.find(item=>item.id===draft.createdTaskId);text('[data-ai-created-title]',(created&&window.AIWSUI.taskTitle(created))||values.title||'');text('[data-ai-created-meta]',`${localTaskKey(draft.createdTaskId)}${created?` · ${statuses[created.status]||created.status}`:''}`);$('[data-ai-open-task]').disabled=!created;return card;}
  const title=String(values.title||'').trim(),{summary,steps,criteria}=aiOutline(values.description),order=(workspace.layout?.order.includes(draft)?workspace.layout.order:workspace.drafts).filter(item=>!item.createdTaskId);
  text('[data-ai-title]',title||t.text('Başlıksız taslak'));text('[data-ai-summary]',summary).hidden=!summary;
  const outline=[steps?t.template`<span class="ui-chip">${steps} adım</span>`:'',criteria?t.template`<span class="ui-chip">${window.AIWSUI.icon('check')}${criteria} kabul kriteri</span>`:''].join('');$('[data-ai-outline]').hidden=!outline;setHtml($('[data-ai-outline]'),outline);text('[data-ai-index]',`#${order.indexOf(draft)+1}`);
  const edited=draft.edited.length;
  setHtml($('[data-ai-badges]'),`${draft.turn===workspace.turn&&workspace.turn?t.text('<span class="ai-badge" data-tone="accent">AI güncelledi</span>'):''}${edited?`<span class="ai-badge" data-tone="idle" title="${esc(`${t.template`${edited} alanı sen düzenledin`}: ${draft.edited.join(', ')}`)}">✎ ${edited}<span class="sr-only"> ${esc(t.text('alanı sen düzenledin'))}</span></span>`:''}`);
  // Only real data is shown: labels when the draft has some or the project offers them, the agent picker when agents exist.
  const labels=projectLabels(workspace.projectId),tags=values.tags||[],free=labels.filter(label=>!tags.some(tag=>tag.toLowerCase()===label.name.toLowerCase()));
  const labelHtml=tags.map(tag=>labelChip(labels,tag,`<button type="button" data-ai-remove-tag="${esc(tag)}" aria-label="${esc(t.template`${tag} etiketini kaldır`)}">×</button>`)).join('')+(free.length?`<select class="ai-card-add-label" data-ai-add-tag aria-label="${esc(t.text('Etiket ekle'))}"><option value="">${esc(t.text('+ Etiket'))}</option>${free.map(label=>`<option value="${esc(label.name)}">${esc(label.name)}</option>`).join('')}</select>`:'');
  $('[data-ai-labels]').hidden=!labelHtml;setHtml($('[data-ai-labels]'),labelHtml);
  const agents=aiPlannerAgents(values.agentId);$('[data-ai-agent-field]').hidden=!agents.length;
  if(agents.length)setAIOptions($('[data-field="agentId"]'),aiAgentOptions(values.agentId,t.text('Otomatik ata')),values.agentId);
  // The picker re-renders only when the draft's agent or choice changed, so an open panel keeps its place.
  const pickerHost=$('[data-ai-model-field]'),pickerKey=JSON.stringify([values.agentId||'',values.provider||'',values.model||'',values.reasoningEffort||'']);
  if(pickerHost.dataset.key!==pickerKey){pickerHost.dataset.key=pickerKey;agentPickers.get(pickerHost).set({provider:values.provider||'',model:values.model||'',reasoningEffort:values.reasoningEffort||''});}
  const priority=Number(values.priority??2);card.lastElementChild.dataset.priority=priority>=3?'high':priority<=1?'low':'medium';setAIOptions($('[data-field="priority"]'),[[3,'High'],[2,'Medium'],[1,'Low'],...(![1,2,3].includes(priority)?[[priority,`Custom (${priority})`]]:[])].map(([number,label])=>`<option value="${number}">${label}</option>`).join(''),priority);
  const blockers=(values.dependsOnDrafts||[]).map(key=>[key,workspace.drafts.find(item=>item.key===key)]);
  const chip=(name,value,label,title,tone)=>`<span class="ai-dependency" data-tone="${tone}"><span title="${esc(title)}">${label}</span><button type="button" data-ai-remove-dependency="${esc(JSON.stringify([name,value]))}" aria-label="${esc(t.template`${title} bağımlılığını kaldır`)}">${window.AIWSUI.icon('x')}</button></span>`;
  const chips=[...blockers.map(([key,blocker])=>chip('dependsOnDrafts',key,`<strong>${blocker?.createdTaskId?'✓':'◌'}</strong> ${esc(blocker?.values.title||key)}`,blocker?.values.title||key,blocker?.createdTaskId?'done':'idle')),...(values.dependsOn||[]).map(id=>{const existing=state.tasks.find(item=>item.id===id);return chip('dependsOn',id,`<strong>${esc(existing?.github?.issueNumber?`#${existing.github.issueNumber}`:localTaskKey(id))}</strong> ${esc(existing?.title||'')}`,existing?.title||id,'idle');}),...(values.dependencyRefs||[]).map(reference=>chip('dependencyRefs',reference,`<strong>${esc(reference)}</strong>`,reference,'idle'))];
  $('[data-ai-dependencies]').hidden=!chips.length;setHtml($('[data-ai-dependencies]'),chips.length?t.template`<span class="ai-card-label">Önce bitmeli</span>${chips.join('')}`:'');
  const workflow=state.workflows.find(item=>item.id===values.workflowId);
  const extra=[values.skillIds?.length?t.template`${values.skillIds.length} skill`:'',workflow?t.template`İş akışı: ${workflow.name}${values.workflowRequested?t.text(' · çalıştırılacak'):''}`:'',values.requestedActions?.includes('deploy')?t.text('Dağıtım istendi'):'',values.autoMerge===true?t.text('Otomatik merge'):'',values.terminalMode==='stream'?t.text('Akış arayüzü'):values.terminalMode==='pty'?t.text('Terminal arayüzü'):''].filter(Boolean);
  text('[data-ai-extra]',extra.join(' · ')).hidden=!extra.length;
  const waiting=blockers.some(([,blocker])=>blocker&&!blocker.createdTaskId),creating=workspace.creating.has(draft.key),create=$('[data-ai-create]');
  create.disabled=creating||waiting||!title;create.classList.toggle('is-busy',creating);for(const button of card.querySelectorAll('[data-ai-discard],[data-ai-expand]'))button.disabled=creating;
  text('[data-ai-status]',draft.error||(waiting?t.text('Önce bağlı olduğu taslağı oluştur.'):!title?t.text('Başlık gerekli.'):'')).classList.toggle('error',Boolean(draft.error));
  return card;
}
// Enlarging a card opens the regular new-task editor above the sheet; creating there links the task to the card.
function openAIDraftEditor(workspace,draft){
  if(draft.createdTaskId||workspace.creating.has(draft.key)||projectId!==workspace.projectId)return;
  const values=draft.values,blockers=(values.dependsOnDrafts||[]).map(key=>workspace.drafts.find(item=>item.key===key)?.createdTaskId).filter(Boolean);
  taskModal(false,'backlog',false,{fields:{title:values.title||'',description:values.description||'',agentId:values.agentId||null,providerOverride:values.provider||'',model:values.model||'',modelOverride:values.model||'',reasoningEffort:values.reasoningEffort||'',priority:Number(values.priority??2),skillIds:values.skillIds||[],workflowId:values.workflowId||null,workflowRequested:Boolean(values.workflowRequested),requestedActions:values.requestedActions||[],autoMerge:values.autoMerge??null,terminalMode:values.terminalMode||null,tags:values.tags||[],dependsOn:[...new Set([...(values.dependsOn||[]),...blockers])],dependencyRefs:values.dependencyRefs||[]},
    onCreated:created=>{if(!created?.id||draft.createdTaskId)return;draft.createdTaskId=created.id;draft.error='';saveAIWorkspace(workspace);updateAIWorkspace(workspace);updateAITab();}});
}
// The draft whose card holds target, if any.
function aiDraftOf(workspace,target){const card=target.closest('[data-ai-draft]');return card?workspace.drafts.find(item=>item.key===card.dataset.aiDraft):null;}
function aiBindDraftCards(workspace,list){
  const draftOf=target=>aiDraftOf(workspace,target);
  // Removing a draft-to-draft dependency changes the flow, so that one edit re-lays out the canvas.
  const touch=(draft,name)=>{if(!draft.edited.includes(name))draft.edited.push(name);draft.error='';saveAIWorkspace(workspace);if(name==='dependsOnDrafts')updateAIWorkspace(workspace);else updateAIDraftCard(workspace,draft);};
  list.addEventListener('change',event=>{const field=event.target,draft=draftOf(field);if(!draft||draft.createdTaskId)return;
    if(field.matches('[data-ai-add-tag]')){if(field.value)draft.values.tags=[...new Set([...(draft.values.tags||[]),field.value])];touch(draft,'tags');return;}
    const name=field.dataset.field;if(!name)return;
    draft.values[name]=name==='priority'?Number(field.value):field.value||null;
    // A new agent brings its own provider and model, like the task editor.
    if(name==='agentId'){draft.values.provider=null;draft.values.model=null;draft.values.reasoningEffort=null;}
    touch(draft,name);});
  list.addEventListener('agentpickerchange',event=>{const draft=draftOf(event.target);if(!draft||draft.createdTaskId)return;const {provider,model,reasoningEffort}=event.detail;Object.assign(draft.values,{provider:provider||null,model:model||null,reasoningEffort:reasoningEffort||null});touch(draft,'model');});
  list.onclick=event=>{const button=event.target.closest('button');
    // A click anywhere on an open card that is not one of its controls opens it like its body does.
    if(!button){const draft=!event.target.closest('select,input,textarea,a,label,.agent-picker')&&event.target.closest('.ai-card')&&draftOf(event.target);if(draft&&!draft.createdTaskId)openAIDraftEditor(workspace,draft);return;}
    const draft=draftOf(button);if(!draft)return;
    if(button.hasAttribute('data-ai-expand'))openAIDraftEditor(workspace,draft);
    if(button.hasAttribute('data-ai-create'))void createAIDraft(workspace,draft);
    if(button.hasAttribute('data-ai-discard')||button.hasAttribute('data-ai-dismiss'))discardAIDraft(workspace,draft);
    if(button.hasAttribute('data-ai-open-task')){closeAISheet(false);selectedTaskId=null;localStorage.setItem(`aiws.project-tab.${projectId}`,'board');render();openTask(draft.createdTaskId);}
    if(button.dataset.aiRemoveTag!==undefined){draft.values.tags=(draft.values.tags||[]).filter(tag=>tag!==button.dataset.aiRemoveTag);touch(draft,'tags');}
    if(button.dataset.aiRemoveDependency){const [name,value]=JSON.parse(button.dataset.aiRemoveDependency);draft.values[name]=(draft.values[name]||[]).filter(item=>item!==value);touch(draft,name);}
  };
}
