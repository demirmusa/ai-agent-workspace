'use strict';
// The picker's hidden native fields and trigger, and the picker as a labelled form field.
/** A provider's badge in the picker: its logo, the AI sparkle for the inherited choice, or a prompt for command providers. */
const providerBadge=value=>value===''?`<span class="ui-icon-box" aria-hidden="true">${window.AIWSUI.sparkle()}</span>`:Object.hasOwn(providers,value)&&value!=='command'?providerIcon(value):'<span class="ui-icon-box" aria-hidden="true">&gt;_</span>';
/**
 * The one provider, model and reasoning picker of every activeScreen. Hidden native fields stay the source of truth: the provider select,
 * the model choice and model input, the reasoning select and, where the picker also assigns agent profiles, the agent select. Forms
 * submit them as before; mountAgentPicker turns the trigger into one panel. `inherit` labels the empty provider choice, when the
 * activeScreen offers one; `trigger:false` leaves the trigger to the caller's own chip.
 */
function agentPickerMarkup(values={},{id='field',variant='is-field',labelledBy='',describedBy='',inherit='',command=true,custom=true,reasoning=true,agents=false,disabled=false,trigger=true}={}){
  const t=globalThis.AIWSI18n.text,off=disabled?' disabled':'',provider=values.provider||'';
  const agentField=agents?`<select id="${id}-agentId" name="agentId" aria-label="${esc(t('Agent profili'))}" data-value="${esc(values.agentId||'')}"${off}><option value="">${esc(t('Otomatik ata · uygun agent seçilir'))}</option>${state.agents.map(agent=>`<option value="${esc(agent.id)}">${esc(agent.name)}</option>`).join('')}</select>`:'';
  const button=trigger?`<button type="button" class="model-trigger ${variant}" id="${id}-model-trigger" aria-haspopup="dialog" aria-expanded="false" aria-controls="${id}-model-menu" aria-labelledby="${[labelledBy,`${id}-model-trigger`].filter(Boolean).join(' ')}"${describedBy?` aria-describedby="${describedBy}"`:''}${off}></button>`:'';
  return `${button}<span class="agent-picker-fields" hidden>${agentField}<select id="${id}-provider" name="provider" aria-label="${esc(t('Sağlayıcı'))}" data-value="${esc(provider)}"${off}>${inherit?`<option value="">${esc(inherit)}</option>`:''}${providerOptions(provider,{command,custom})}</select><select id="${id}-model-choice" aria-label="Model"${off}></select><label for="${id}-model" hidden>${esc(t('Özel model ID'))}</label><input id="${id}-model" name="model" value="${esc(values.model||'')}" placeholder="Model ID" autocomplete="off" hidden${off}>${reasoning?`<select id="${id}-reasoningEffort" name="reasoningEffort" aria-label="${esc(t('Düşünme seviyesi'))}" data-value="${esc(values.reasoningEffort||'')}"${off}></select>`:''}</span>`;
}
/** The picker as a labelled form field. */
function agentPickerField(label,values,options={}){
  const id=options.id||'field';
  return `<div class="form-field"><label for="${id}-model-trigger" id="${id}-model-label">${esc(label)}</label>${agentPickerMarkup(values,{...options,labelledBy:`${id}-model-label`})}</div>`;
}
