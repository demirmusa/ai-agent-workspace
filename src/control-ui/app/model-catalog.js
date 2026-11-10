'use strict';
// Model lists, labels and reasoning levels the pickers and provider settings read from the provider registry.
// Suggested models (fallbackProviderModels, from the provider registry) are used until a provider's list is refreshed in work settings; custom IDs remain supported.
// The refreshed list replaces the suggestions; it is read from the provider only when asked for. Each model carries the profile its provider knows for it.
const modelDisabled=(provider,model)=>(projectProviderSettings().disabledModels?.[provider]||[]).includes(model);
function modelChoices(provider,{all=false}={}){const refreshed=state.providerModels?.[provider]?.models;return [...(refreshed?.length?refreshed:fallbackProviderModels[provider]||[])].filter(model=>all||!modelDisabled(provider,model.id));}
const modelLabel=model=>model.name&&model.name!==model.id?`${model.name} · ${model.id}`:model.id;
// The provider registry rates known model families 1–5 for speed, quality and cost; the picker's wording is derived from those tiers here.
const modelTagline=({speed,quality})=>globalThis.AIWSI18n.text(quality>=5?'En zor işler':quality>=4?'Karmaşık işler':speed>=5||speed>=4&&quality<=2?'Hızlı ve hafif':speed>=4?'Günlük işler':'Dengeli');
/** The letter in a model's icon box: the first letter of its last word, skipping a trailing reasoning level ("gemini-3.8-flash-high" → F, "Claude Opus 5.5" → O). */
function modelInitial(model,levels=[]){const words=String(model.name||model.id).split(/[^\p{L}\p{N}]+/u).filter(word=>/^\p{L}+$/u.test(word)&&!levels.includes(word.toLowerCase()));return (words.at(-1)||String(model.id)).charAt(0).toUpperCase()||'?';}
// Reasoning levels the provider registry lists, with a short label and what each one means; unknown levels show as they are.
const reasoningLevels={minimal:['Minimum','En az düşünür, en hızlı yanıtı verir.'],low:['Düşük','Kısa düşünür, hızlı yanıt verir.'],medium:['Orta','Hız ile derinliği dengeler.'],high:['Yüksek','Zor işlerde daha derin düşünür.'],xhigh:['Çok yüksek','Çok derin düşünür, daha yavaş yanıt verir.'],max:['Maks','Sınır koymadan düşünür; en yavaş ve en kapsamlısı.']};
const reasoningLabel=level=>Object.hasOwn(reasoningLevels,level)?globalThis.AIWSI18n.text(reasoningLevels[level][0]):level;
const reasoningHint=level=>Object.hasOwn(reasoningLevels,level)?globalThis.AIWSI18n.text(reasoningLevels[level][1]):level;
// An outline bulb on AIWSUI's 16-unit icon grid marks a chosen reasoning level.
const reasoningIcon='<svg class="ui-icon" width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.75 9.6a4.25 4.25 0 1 1 4.5 0V11h-4.5z"/><path d="M6.5 13h3M7.25 14.75h1.5"/></svg>';
/** Reasoning levels a separate option sets for a model: those its provider lists for it, else the provider's own; none where the level is part of the model ID. */
function modelEfforts(provider,model){return providerReasoningInModelId.has(provider)?[]:model?.efforts||providerReasoningEfforts[provider]||[];}
/**
 * The picker's rows for a provider's models. Where the level is part of the model ID ("gemini-4-argon-high"), the variants of
 * one model share a row and the reasoning level chooses among them; a model listed with a single level stays as it is.
 */
function modelRows(provider,models){
  if(!providerReasoningInModelId.has(provider))return models.map(model=>({...model,variants:null}));
  const levels=providerReasoningEfforts[provider]||[],groups=new Map(),rows=[];
  for(const model of models){
    const [,base,suffix='']=/^(.+)-([a-z]+)$/i.exec(model.id)||[],level=suffix.toLowerCase();
    if(!levels.includes(level)){rows.push({...model,variants:null});continue;}
    let group=groups.get(base);
    if(!group){group={id:base,name:model.name?.replace(new RegExp(`[\\s(·-]*${level}\\)?$`,'i'),'')||base,variants:new Map()};groups.set(base,group);rows.push(group);}
    group.variants.set(level,model);
  }
  return rows.map(row=>{
    if(!row.variants)return row;
    if(row.variants.size===1)return {...[...row.variants.values()][0],variants:null};
    const variants=new Map(levels.filter(level=>row.variants.has(level)).map(level=>[level,row.variants.get(level)])),middle=variants.get('medium')||[...variants.values()][Math.floor((variants.size-1)/2)];
    return {id:row.id,name:row.name,profile:middle.profile,variants,fallback:middle.id};
  });
}
