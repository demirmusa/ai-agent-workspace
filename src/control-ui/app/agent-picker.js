'use strict';
// The agent, provider, model and reasoning picker.
const agentPickers=new WeakMap();
/**
 * Opens one panel from the picker's trigger, or from `anchor` for a chip outside the markup: agent profiles and providers on the
 * left, the provider's models with speed, quality and cost meters on the right, a custom ID, then the reasoning level when the
 * chosen model takes one. Choices are written to the native fields with change events and reported once per change as an
 * `agentpickerchange` event on the host. The panel is fixed to the viewport so a scrolling dialog never clips it; it is at least as
 * wide as its trigger and grows to fit model names. Focus follows the pointer, so one row is active for the highlight, the meters
 * and the footer at a time. `inheritProvider` names the provider an empty choice runs, `refreshOn` lists outside fields (an agent
 * select) that change it.
 */
function mountAgentPicker(host,{id='field',inheritProvider=defaultProvider,inheritModel=()=>globalThis.AIWSI18n.text('Sağlayıcı varsayılanı'),anchor=null,refreshOn=[],onClose=null}={}) {
  const t=globalThis.AIWSI18n.text,ui=window.AIWSUI,field=name=>host.querySelector(`#${id}-${name}`);
  const providerSelect=field('provider'),select=field('model-choice'),input=field('model'),reasoning=field('reasoningEffort'),agentSelect=field('agentId'),customLabel=host.querySelector(`label[for="${id}-model"]`),trigger=anchor||field('model-trigger'),menu=document.createElement('div');
  for(const element of [providerSelect,agentSelect])if(element&&element.dataset.value!==undefined){element.value=element.dataset.value;delete element.dataset.value;}
  menu.className='model-menu popup-menu';menu.id=`${id}-model-menu`;menu.tabIndex=-1;menu.hidden=true;menu.setAttribute('role','dialog');menu.setAttribute('aria-label',t('Sağlayıcı ve model'));
  menu.innerHTML=globalThis.AIWSI18n.template`<div class="model-menu-body"><div class="model-providers" role="menu" aria-label="Sağlayıcı"></div><div class="model-menu-main"><div class="model-menu-head" aria-hidden="true"><span>Model</span><span class="model-meter-heads"><span>Hız</span><span>Kalite</span><span>Maliyet</span></span></div><div class="model-menu-list" role="menu" aria-label="Model"></div><div class="model-custom" hidden><input type="text" placeholder="Model ID" aria-label="Özel model ID" autocomplete="off" spellcheck="false"></div><div class="model-reasoning" hidden><label class="model-toggle"><span class="model-toggle-icon">${reasoningIcon}</span><span class="model-toggle-text">Düşünme seviyesi</span><input type="checkbox" class="ui-switch" role="switch"></label><div class="model-levels"><div><div class="model-levels-row"><span id="${id}-model-levels-label">Seviye</span><div class="view-tabs" role="radiogroup" aria-labelledby="${id}-model-levels-label"></div></div></div></div></div></div></div><div class="model-menu-foot"><span class="model-menu-hint"></span><span class="model-menu-keys" aria-hidden="true"><kbd>↑↓</kbd><kbd>↵</kbd></span></div>`;
  if(anchor)host.append(menu);
  else{trigger.innerHTML=`<span class="model-trigger-icon"></span><span class="model-trigger-label"></span><span class="model-trigger-level" hidden>${reasoningIcon}<span></span></span><span class="model-chevron" aria-hidden="true">${ui.icon('chevron')}</span>`;trigger.after(menu);}
  const providerList=menu.querySelector('.model-providers'),list=menu.querySelector('.model-menu-list'),heads=menu.querySelector('.model-meter-heads'),custom=menu.querySelector('.model-custom'),customInput=custom.firstElementChild,section=menu.querySelector('.model-reasoning'),toggle=section.querySelector('.ui-switch'),levelsBox=section.querySelector('.model-levels'),tabs=section.querySelector('.view-tabs'),hint=menu.querySelector('.model-menu-hint');
  const [iconSlot,labelText,levelBadge]=anchor?[]:trigger.children;
  let models=[],rowsData=[],lastLevel='',iconHtml='',open=false,frame=0,mounted=false,pending=false;
  const effective=()=>providerSelect.value||inheritProvider();
  let previousProvider=effective();
  const listsModels=provider=>provider!=='command'&&!String(provider).startsWith('custom:');
  const levelMode=()=>providerReasoningInModelId.has(effective());
  const rows=()=>[...list.querySelectorAll('.model-option')],checkedRow=()=>list.querySelector('.model-option[aria-checked="true"]'),customRow=()=>list.querySelector('.model-option[data-model-value="__custom__"]');
  const sideRows=()=>[...providerList.querySelectorAll('.model-provider:not(:disabled)')],checkedSide=()=>providerList.querySelector('.model-provider[data-provider-value][aria-checked="true"]');
  const chosenRow=()=>rowsData.findIndex(item=>item.variants?[...item.variants.values()].some(model=>model.id===select.value):item.id===select.value&&select.value!=='');
  const variantLevel=()=>{const item=rowsData[chosenRow()];for(const [level,model] of item?.variants||[])if(model.id===select.value)return level;return '';};
  // Levels the chosen model takes: its variants where the level is in the ID, else what a separate option accepts for it.
  const levelsNow=()=>{const provider=effective();if(!listsModels(provider))return [];if(levelMode())return [...(rowsData[chosenRow()]?.variants?.keys()||[])];return reasoning?modelEfforts(provider,models.find(model=>model.id===input.value.trim())):[];};
  const values=()=>({...(agentSelect?{agentId:agentSelect.value}:{}),provider:providerSelect.value,model:input.value.trim(),reasoningEffort:reasoning?.value||''});
  const notify=()=>{if(pending)return;pending=true;queueMicrotask(()=>{pending=false;host.dispatchEvent(new CustomEvent('agentpickerchange',{bubbles:true,detail:values()}));});};
  const meters=profile=>`<span class="model-meters" aria-hidden="true">${['speed','quality','cost'].map(key=>`<span class="model-meter" style="--n:${Math.min(5,Math.max(1,Number(profile[key])||1))}"></span>`).join('')}</span><span class="sr-only">${esc(`${t('Hız')} ${profile.speed}/5, ${t('Kalite')} ${profile.quality}/5, ${t('Maliyet')} ${profile.cost}/5`)}</span>`;
  const row=(value,icon,name,note,extra='',mono=false,attrs='')=>`<button type="button" class="model-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-model-value="${esc(value)}"${attrs}><span class="ui-icon-box" aria-hidden="true">${icon}</span><span class="model-option-text"><span class="model-option-name"><span>${esc(name)}</span><span class="model-check" aria-hidden="true">${ui.icon('check')}</span></span>${note?`<span class="model-option-note${mono?' is-mono':''}">${esc(note)}</span>`:''}</span>${extra}</button>`;
  const side=(attrs,icon,name,note,disabled=false)=>`<button type="button" class="model-provider" role="menuitemradio" aria-checked="false" tabindex="-1" ${attrs}${disabled?' disabled':''}>${icon}<span class="model-provider-text"><span>${esc(name)}</span>${note?`<small>${esc(note)}</small>`:''}</span><span class="model-check" aria-hidden="true">${ui.icon('check')}</span></button>`;
  const describe=element=>{
    const option=element?.closest?.('.model-option'),tab=element?.closest?.('.view-tab[data-level]'),entry=element?.closest?.('.model-provider');
    if(option)return option.dataset.modelValue===''?[t('Model seçilmezse profilin veya sağlayıcının varsayılanı kullanılır.')]:option.dataset.modelValue==='__custom__'?[t("Listede olmayan bir model ID'si yaz; Enter ile uygula.")]:[option.dataset.modelValue,true];
    if(entry)return entry.dataset.agentValue!==undefined?[t('Profilin talimatları, ön bilgileri ve varsayılan skilleri kullanılır.')]:entry.dataset.providerValue===''?[t('Agent profilinin veya varsayılan sağlayıcının modeli kullanılır.')]:[t('Sağlayıcıyı seç; modelleri yanda listelenir.')];
    if(element===customInput)return [t("Listede olmayan bir model ID'si yaz; Enter ile uygula.")];
    if(tab)return [reasoningHint(tab.dataset.level)];
    if(element===toggle)return [reasoning?.value?reasoningHint(reasoning.value):t('Kapalıyken sağlayıcının kendi düşünme seviyesi kullanılır.')];
    return checkedRow()?describe(checkedRow()):[''];
  };
  const showHint=(element=document.activeElement)=>{const [text,mono=false]=describe(menu.contains(element)?element:null);hint.classList.toggle('is-mono',mono);ui.motion.swapText(hint,text);};
  // The reasoning select offers only the levels the chosen model takes; a level it does not take is cleared.
  const renderReasoning=()=>{
    if(!reasoning)return;
    const levels=levelMode()?[]:levelsNow(),current=reasoning.value||reasoning.dataset.value||'';
    reasoning.innerHTML=`<option value="">${esc(t('Sağlayıcı varsayılanı'))}</option>${levels.map(level=>`<option value="${esc(level)}">${esc(reasoningLabel(level))}</option>`).join('')}`;
    reasoning.value=levels.includes(current)?current:'';delete reasoning.dataset.value;
  };
  const sync=()=>{
    const provider=effective(),value=input.value.trim(),choice=select.value,index=chosenRow(),item=rowsData[index],byModel=levelMode();
    for(const option of rows()){
      const own=option.dataset.row!==undefined,checked=own?Number(option.dataset.row)===index:option.dataset.modelValue===choice;
      if(own&&rowsData[option.dataset.row].variants)option.dataset.modelValue=checked?choice:rowsData[option.dataset.row].fallback;
      option.setAttribute('aria-checked',String(checked));option.tabIndex=checked?0:-1;
    }
    if(!checkedRow())list.querySelector('.model-option')?.setAttribute('tabindex','0');
    for(const entry of providerList.querySelectorAll('.model-provider')){const checked=entry.dataset.agentValue!==undefined?entry.dataset.agentValue===agentSelect?.value:entry.dataset.providerValue===providerSelect.value;entry.setAttribute('aria-checked',String(checked));entry.tabIndex=checked?0:-1;}
    const note=customRow()?.querySelector('.model-option-note'),customValue=choice==='__custom__'?value:'';
    if(note){note.textContent=customValue||t('Listede olmayan bir ID');note.classList.toggle('is-mono',Boolean(customValue));}
    const levels=levelsNow(),level=byModel?variantLevel():reasoning?.value||'';
    section.hidden=byModel?levels.length<2:!levels.length;section.classList.toggle('is-model-level',byModel);
    const signature=levels.join(' ');
    if(tabs.dataset.levels!==signature){tabs.dataset.levels=signature;tabs.innerHTML=levels.map(entry=>`<button type="button" class="view-tab" role="radio" aria-checked="false" tabindex="-1" data-level="${esc(entry)}">${esc(reasoningLabel(entry))}</button>`).join('');}
    toggle.checked=Boolean(level);levelsBox.classList.toggle('is-open',byModel||Boolean(level));levelsBox.inert=!byModel&&!level;
    for(const tab of tabs.children){const active=tab.dataset.level===level;tab.classList.toggle('active',active);tab.setAttribute('aria-checked',String(active));tab.tabIndex=active?0:-1;}
    if(!anchor){
      const nextIcon=providerBadge(provider);if(nextIcon!==iconHtml){iconHtml=nextIcon;iconSlot.innerHTML=nextIcon;}
      const text=value?item?.variants?item.name:models.find(model=>model.id===value)?.name||value:inheritModel();
      if(mounted)ui.motion.swapText(labelText,text);else labelText.textContent=text;
      trigger.title=[providers[provider]||provider,value||inheritModel(),level&&reasoningLabel(level)].filter(Boolean).join(' · ');
      levelBadge.hidden=!level;levelBadge.lastElementChild.textContent=level?reasoningLabel(level):'';
    }
    mounted=true;if(open)showHint();
  };
  const render=()=>{
    const provider=effective(),inherit=inheritModel(),listed=listsModels(provider),words=providerReasoningEfforts[provider]||[];
    models=listed?modelChoices(provider):[];
    if(listed){const saved=[...state.agents.filter(item=>item.provider===provider).map(item=>item.model),...state.tasks.filter(item=>taskProvider(item)===provider).map(item=>taskModel(item)),input.value.trim()];for(const value of saved.filter(value=>value&&!modelDisabled(provider,value)))if(!models.some(model=>model.id===value))models.push({id:value});}
    rowsData=modelRows(provider,models);
    select.innerHTML=`<option value="">${esc(inherit)}</option>${models.map(model=>`<option value="${esc(model.id)}">${esc(modelLabel(model))}</option>`).join('')}<option value="__custom__">${esc(t('Özel model…'))}</option>`;
    select.value=modelDisabled(provider,input.value.trim())?'__custom__':input.value.trim();input.hidden=select.value!=='__custom__';if(customLabel)customLabel.hidden=input.hidden;
    renderReasoning();
    providerList.innerHTML=`${agentSelect&&state.agents.length?`<div class="model-menu-head" aria-hidden="true"><span>${esc(t('Agent profili'))}</span></div>${[...agentSelect.options].map(option=>{const agent=state.agents.find(item=>item.id===option.value);return side(`data-agent-value="${esc(option.value)}"`,agent?providerIcon(agent.provider):providerBadge(''),agent?agent.name:t('Otomatik'),agent?`${providers[agent.provider]||agent.provider}${agent.enabled?'':t(' (devre dışı)')}`:t('Uygun agent seçilir'));}).join('')}`:''}<div class="model-menu-head" aria-hidden="true"><span>${esc(t('Sağlayıcı'))}</span></div>${[...providerSelect.options].map(option=>{const value=option.value,builtin=Object.hasOwn(providers,value);return side(`data-provider-value="${esc(value)}"`,providerBadge(value),value===''?t('Varsayılan'):builtin?providers[value]:option.textContent.replace(t(' · özel'),''),value===''?providers[inheritProvider()]||'':option.disabled?t('Kapalı'):builtin?'':t('Özel'),option.disabled);}).join('')}`;
    const rated=rowsData.some(item=>item.profile);heads.hidden=!rated;
    list.innerHTML=listed?[row('',ui.sparkle(),inherit,t('Varsayılanı kullanır'),rated?`<span class="model-option-varies">${esc(t('Değişir'))}</span>`:''),...rowsData.map((item,index)=>row(item.variants?item.fallback:item.id,esc(modelInitial(item,words)),item.name||item.id,item.profile?modelTagline(item.profile):item.name&&item.name!==item.id?item.id:'',item.profile?meters(item.profile):'',!item.profile,` data-row="${index}"`)),row('__custom__','+',t('Özel model…'),t('Listede olmayan bir ID'))].join(''):`<p class="model-menu-empty">${esc(t('Bu sağlayıcı model seçmez; komut ayarlarıyla çalışır.'))}</p>`;
    sync();if(open)place();
  };
  const place=()=>{
    const rect=trigger.getBoundingClientRect(),margin=8,gap=6,limit=innerWidth-margin*2;
    if(!trigger.isConnected||rect.bottom<0||rect.top>innerHeight){hide(false);return;}
    menu.style.minWidth=`${Math.min(rect.width,limit)}px`;menu.style.maxWidth=`${limit}px`;menu.style.maxHeight='';
    const width=menu.offsetWidth,below=innerHeight-rect.bottom-gap-margin,above=rect.top-gap-margin,natural=menu.offsetHeight,flip=natural>below&&above>below,room=Math.min(528,Math.max(120,flip?above:below));
    menu.style.maxHeight=`${room}px`;menu.classList.toggle('is-above',flip);
    menu.style.left=`${Math.round(Math.min(Math.max(margin,rect.left),innerWidth-width-margin))}px`;
    menu.style.top=`${Math.round(flip?rect.top-gap-Math.min(natural,room):rect.bottom+gap)}px`;
  };
  const reposition=event=>{if(event?.type==='scroll'&&menu.contains(event.target))return;if(!frame)frame=requestAnimationFrame(()=>{frame=0;if(open)place();});};
  const outside=event=>{if(!menu.contains(event.target)&&!trigger.contains(event.target))hide(false);};
  const show=focusRow=>{
    if(open)return;open=true;custom.hidden=true;render();menu.hidden=false;trigger.setAttribute('aria-expanded','true');place();if(!open)return;
    const selected=checkedRow();if(selected)list.scrollTop=Math.max(0,selected.offsetTop-(list.clientHeight-selected.offsetHeight)/2);
    (focusRow?selected||rows()[0]||checkedSide():menu)?.focus({preventScroll:true});showHint();
    document.addEventListener('pointerdown',outside,true);document.addEventListener('scroll',reposition,true);addEventListener('resize',reposition);
  };
  // The shared popup-menu rule fades the menu out once it is hidden.
  function hide(returnFocus){
    if(!open)return;open=false;trigger.setAttribute('aria-expanded','false');
    document.removeEventListener('pointerdown',outside,true);document.removeEventListener('scroll',reposition,true);removeEventListener('resize',reposition);
    if(returnFocus&&trigger.isConnected)trigger.focus({preventScroll:true});
    menu.hidden=true;onClose?.(values());
  }
  const choose=value=>{
    if(value==='__custom__'){custom.hidden=false;customInput.value=select.value==='__custom__'?input.value.trim():'';place();customInput.focus();showHint(customInput);return;}
    if(select.value!==value||input.value!==value){select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));}
    hide(true);
  };
  const applyCustom=()=>{
    const value=customInput.value.trim();if(!value)return;
    if(value!=='__custom__'&&[...select.options].some(option=>option.value===value)){choose(value);return;}
    select.value='__custom__';select.dispatchEvent(new Event('change',{bubbles:true}));
    input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));hide(true);
  };
  // A provider is browsed in place: its models replace the list and the panel stays open for the model and level.
  const chooseProvider=value=>{if(providerSelect.value!==value){providerSelect.value=value;providerSelect.dispatchEvent(new Event('change',{bubbles:true}));}(checkedRow()||rows()[0])?.focus({preventScroll:true});};
  const chooseAgent=value=>{if(agentSelect.value!==value){agentSelect.value=value;agentSelect.dispatchEvent(new Event('change',{bubbles:true}));}hide(true);};
  const setLevel=level=>{
    if(levelMode()){const model=rowsData[chosenRow()]?.variants?.get(level);if(model&&select.value!==model.id){select.value=model.id;select.dispatchEvent(new Event('change',{bubbles:true}));}return;}
    if(!reasoning||reasoning.value===level)return;reasoning.value=level;reasoning.dispatchEvent(new Event('change',{bubbles:true}));
  };
  if(!anchor){
    trigger.addEventListener('click',event=>{if(open)hide(true);else show(event.detail===0);});
    trigger.addEventListener('keydown',event=>{
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();if(open)(checkedRow()||rows()[0])?.focus();else show(true);}
      else if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();hide(true);}
    });
  }
  const leave=event=>{const next=event.relatedTarget;if(open&&next&&next!==trigger&&!menu.contains(next))hide(false);};
  trigger.addEventListener('focusout',leave);menu.addEventListener('focusout',leave);
  menu.addEventListener('focusin',event=>{const option=event.target.closest?.('.model-option');if(option)for(const item of rows())item.tabIndex=item===option?0:-1;showHint(event.target);});
  menu.addEventListener('pointermove',event=>{
    if(event.pointerType==='touch'||document.activeElement===customInput)return;
    const target=event.target.closest?.('.model-option,.model-provider:not(:disabled),.model-toggle,.view-tab'),focusable=target?.matches('.model-toggle')?toggle:target;
    if(focusable&&focusable!==document.activeElement&&!focusable.closest('[inert]'))focusable.focus({preventScroll:true});
  });
  menu.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();hide(true);return;}
    if(event.target===customInput)return;
    const tab=event.target.closest?.('.view-tab');
    if(tab){const items=[...tabs.children],step={ArrowLeft:items.indexOf(tab)-1,ArrowRight:items.indexOf(tab)+1,Home:0,End:items.length-1}[event.key];if(step!==undefined){event.preventDefault();const next=items[(step+items.length)%items.length];next.focus();setLevel(next.dataset.level);}return;}
    if(providerList.contains(event.target)){if(event.key==='ArrowRight'){event.preventDefault();(checkedRow()||rows()[0])?.focus();return;}ui.menuNavigate(event,providerList,sideRows());return;}
    if(event.target!==menu&&!list.contains(event.target))return;
    if(event.key==='ArrowLeft'&&event.target!==menu){event.preventDefault();(checkedSide()||sideRows()[0])?.focus();return;}
    const items=rows();
    if(!items.includes(document.activeElement)&&(event.key==='ArrowDown'||event.key==='ArrowUp')){event.preventDefault();(checkedRow()||items[0])?.focus();return;}
    ui.menuNavigate(event,list,items);
  });
  menu.addEventListener('click',event=>{
    event.stopPropagation();
    const option=event.target.closest('.model-option'),entry=event.target.closest('.model-provider:not(:disabled)'),tab=event.target.closest('.view-tab');
    if(option)choose(option.dataset.modelValue);
    else if(entry?.dataset.agentValue!==undefined)chooseAgent(entry.dataset.agentValue);
    else if(entry)chooseProvider(entry.dataset.providerValue);
    else if(tab)setLevel(tab.dataset.level);
  });
  customInput.addEventListener('keydown',event=>{
    if(event.key==='Enter'){event.preventDefault();event.stopPropagation();applyCustom();}
    else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();custom.hidden=true;customRow()?.focus();place();}
  });
  toggle.addEventListener('change',()=>{const levels=levelsNow();setLevel(toggle.checked?(levels.includes(lastLevel)?lastLevel:levels.includes('medium')?'medium':levels[Math.floor((levels.length-1)/2)]):'');});
  // The native fields drive the panel, so a form, a test or the panel itself changes them the same way.
  const refresh=()=>{const provider=effective();if(provider!==previousProvider)input.value='';previousProvider=provider;render();notify();};
  providerSelect.addEventListener('change',refresh);
  for(const element of refreshOn)element?.addEventListener('change',refresh);
  agentSelect?.addEventListener('change',()=>{providerSelect.value='';input.value='';refresh();});
  select.addEventListener('change',()=>{const custom=select.value==='__custom__';input.value=custom?'':select.value;input.hidden=!custom;if(customLabel)customLabel.hidden=!custom;renderReasoning();sync();notify();});
  input.addEventListener('input',()=>{if(input.hidden)render();else{renderReasoning();sync();}notify();});
  reasoning?.addEventListener('change',()=>{if(reasoning.value)lastLevel=reasoning.value;sync();notify();});
  (host.closest('form')||host).addEventListener('modalreset',()=>hide(false,true));
  /** Writes values without reporting them, for a activeScreen that re-renders from its own state. */
  const set=next=>{
    if(next.agentId!==undefined&&agentSelect)agentSelect.value=next.agentId||'';
    if(next.provider!==undefined)providerSelect.value=next.provider||'';
    if(next.model!==undefined)input.value=next.model||'';
    if(next.reasoningEffort!==undefined&&reasoning){reasoning.value='';reasoning.dataset.value=next.reasoningEffort||'';}
    previousProvider=effective();render();
  };
  render();
  const picker={render,sync,set,values,open:()=>show(true),close:()=>hide(false,true),isOpen:()=>open};agentPickers.set(host,picker);return picker;
}
