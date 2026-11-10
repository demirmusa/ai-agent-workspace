'use strict';
// The AI sheet's dock floating over the canvas: the first-open hint, the planner's progress and retry row, and the composer with
// reference files and the planner agent, provider and model.
function aiMountDock(workspace,element){
  const $=selector=>element.querySelector(selector),composer=$('#ai-composer'),message=$('#ai-message'),{icon,reducedMotion}=window.AIWSUI,t=globalThis.AIWSI18n;
  let sent=0;
  // Reference images upload to the project's attachment store; the message carries them as Markdown so drafts can keep them.
  const images=[],tray=$('#ai-images'),picker=$('#ai-image-input'),drawImages=()=>{tray.hidden=!images.length;tray.innerHTML=images.map((image,index)=>`<span class="ai-image-chip" role="listitem" data-tone="${image.error?'failed':'idle'}"><span>${esc(image.name)}${image.pending?'…':''}</span><button type="button" data-ai-remove-image="${index}" aria-label="${esc(globalThis.AIWSI18n.text('Görseli kaldır'))}">${icon('x')}</button></span>`).join('');};
  const addImages=files=>{window.AIWSImages.warnLarge(files,tray);for(const file of files){const image={name:file.name||'image',image:file.type.startsWith('image/'),pending:true};images.push(image);drawImages();
    window.AIWSImages.data(file).then(data=>api('/attachments','POST',{data,name:file.name,projectId:workspace.projectId})).then(uploaded=>{image.url=uploaded.url;}).catch(cause=>{image.error=true;toast(cause.message);images.splice(images.indexOf(image),1);}).finally(()=>{image.pending=false;drawImages();});}};
  $('#ai-attach').onclick=()=>picker.click();picker.onchange=()=>{addImages([...picker.files]);picker.value='';};
  tray.onclick=event=>{const button=event.target.closest('[data-ai-remove-image]');if(button){images.splice(Number(button.dataset.aiRemoveImage),1);drawImages();}};
  composer.addEventListener('paste',event=>{const files=[...(event.clipboardData?.files||[])];if(files.length){event.preventDefault();addImages(files);}});
  composer.addEventListener('dragover',event=>{if(event.dataTransfer?.types?.includes('Files'))event.preventDefault();});
  composer.addEventListener('drop',event=>{const files=[...(event.dataTransfer?.files||[])];if(files.length){event.preventDefault();addImages(files);}});
  composer.onsubmit=event=>{event.preventDefault();window.AIWSVoice.cancel();if(images.some(image=>image.pending))return;const typed=message.value.trim(),text=[typed,...images.filter(image=>image.url).map(image=>`${image.image?'!':''}[${image.name}](${image.url})`)].filter(Boolean).join('\n\n');if(!typed&&!images.length||workspace.busy)return;images.length=0;drawImages();
    // The sent text blurs away before the field clears, so the placeholder fades back in for the next message.
    const turn=++sent,clear=()=>{if(turn!==sent)return;message.classList.remove('is-sent');if(message.value.trim()===typed)message.value='';};
    if(reducedMotion())clear();else{message.classList.add('is-sent');setTimeout(clear,180);}
    void sendAIMessage(workspace,text);};
  message.onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();composer.requestSubmit();}};
  $('#ai-agent').onchange=event=>{workspace.agentId=event.target.value;saveAIWorkspace(workspace);};
  // The provider, model and reasoning level picked here run the next planning turn; empty fields fall back to the agent.
  const modelHost=$('#ai-model-field');
  mountAgentPicker(modelHost,{id:'ai-composer-model',inheritProvider:()=>state.agents.find(item=>item.id===workspace.agentId)?.provider||defaultProvider(),inheritModel:()=>{const agent=state.agents.find(item=>item.id===workspace.agentId);return agent?.model&&(!workspace.choice.provider||workspace.choice.provider===agent.provider)?t.template`Agenttan · ${agent.model}`:t.text('Varsayılan model');}});
  modelHost.addEventListener('agentpickerchange',event=>{const {provider,model,reasoningEffort}=event.detail;workspace.choice={provider:provider||'',model:model||'',reasoningEffort:reasoningEffort||''};saveAIWorkspace(workspace);});
  $('#ai-cancel').onclick=()=>{if(workspace.organizing)void runTaskOrganizer('cancel');else cancelAIMessage(workspace);};
  $('#ai-activity-toggle').onclick=()=>{workspace.activityOpen=!workspace.activityOpen;renderAIProgress(workspace);};
  $('#ai-retry').onclick=()=>{if(workspace.retry)void sendAIMessage(workspace,workspace.retry);};
  $('#ai-empty').onclick=event=>{const example=event.target.closest('[data-ai-example]');if(example){message.value=example.dataset.aiExample;message.focus();}};
  // The dock floats over the canvas, which keeps that much room under its last row.
  if(typeof ResizeObserver==='function'){const stage=$('#ai-stage'),dock=$('#ai-dock');new ResizeObserver(()=>stage.style.setProperty('--ai-dock-space',`${dock.offsetHeight+30}px`)).observe(dock);}
}
// The status pill shows the newest planner step and crossfades to the next one; its toggle opens the last few steps above it.
function renderAIProgress(workspace){
  const element=workspace.element;if(!element)return;const $=selector=>element.querySelector(selector),t=globalThis.AIWSI18n;
  const organizing=Boolean(workspace.organizing),working=workspace.busy||organizing;
  $('#ai-progress').hidden=!working;$('#ai-send').disabled=working;$('#ai-send').classList.toggle('is-busy',workspace.busy);$('#ai-reset').disabled=working;
  $('#ai-retry-row').hidden=working||!workspace.retry;
  aiProgressClock();if(!working)return;const seconds=Math.max(0,Math.floor((Date.now()-(organizing?workspace.organizing.startedAt:workspace.startedAt))/1000)),label=t.template`${seconds} sn`;if($('#ai-elapsed').textContent!==label)$('#ai-elapsed').textContent=label;
  const title=t.text(organizing?'Taskları işliyorum…':'AI taslakları hazırlıyor…');if($('#ai-progress-label').textContent!==title)$('#ai-progress-label').textContent=title;
  const lines=organizing?[organizeActivity.get(workspace.organizing.requestId)||t.text('Bekleyen ve hazır işler inceleniyor…')]:workspace.activity.length?workspace.activity:[t.text('Proje bağlamı okunuyor; ilk yanıt birkaç saniye sürebilir.')],open=workspace.activityOpen&&lines.length>1,toggle=$('#ai-activity-toggle');
  window.AIWSUI.motion.swapText($('#ai-activity-latest'),lines.at(-1));toggle.hidden=lines.length<2;toggle.setAttribute('aria-expanded',String(open));$('#ai-activity').hidden=!open;
  setHtml($('#ai-activity'),lines.map(line=>`<li>${esc(line)}</li>`).join(''));
}
