'use strict';
// The AI provider registry received from the server.
// Built-in providers come from the server's AI provider registry (state.aiProviders); these objects are filled in place.
const providers = {command:'Command'};
const providerIconPaths={};window.AIWSProviderIcons=providerIconPaths;window.AIWSProviderNames=providers;
/** Registered built-in providers in the server's order, with their icons, models, reasoning levels and auto mode. */
let aiProviderList=[];
/** Providers whose local session history the server reads (live sessions, resume, transfer), from the server's provider registry. */
const historyProviders=[];
/** Providers whose run conversations the server reads back from their own session storage (history providers and others), from the server's provider registry. */
const transcriptProviders=[];
/** Providers whose own speech-to-text can power dictation, from the server's provider registry. */
const voiceProviders=[];
/** Providers that run several accounts side by side (see app/provider-accounts.js), from the server's provider registry. */
const accountProviders=[];
const providerResumeArgs={};
const configurableProviders=[],terminalAgentOrder=[],providerAutoModeFlags={},fallbackProviderModels={command:[]},providerReasoningEfforts={command:[]},providerReasoningInModelId=new Set(),nativeTerminalProviders=new Set();
function applyAIProviders(list){
  if(!Array.isArray(list)||!list.length||JSON.stringify(list)===JSON.stringify(aiProviderList))return;
  aiProviderList=list;
  for(const key of Object.keys(providers))delete providers[key];
  for(const key of Object.keys(providerIconPaths))delete providerIconPaths[key];
  for(const key of Object.keys(providerAutoModeFlags))delete providerAutoModeFlags[key];
  for(const key of Object.keys(providerResumeArgs))delete providerResumeArgs[key];
  nativeTerminalProviders.clear();providerReasoningInModelId.clear();
  for(const item of list){providers[item.id]=item.name;if(item.icon)providerIconPaths[item.id]=item.icon;providerAutoModeFlags[item.id]=item.autoModeLabel;providerResumeArgs[item.id]=[item.executable,...(item.resumeArgs||[])];fallbackProviderModels[item.id]=item.fallbackModels||[];providerReasoningEfforts[item.id]=item.reasoningEfforts||[];if(item.reasoningInModelId)providerReasoningInModelId.add(item.id);if(item.nativeTerminal)nativeTerminalProviders.add(item.id);}
  providers.command='Command';
  historyProviders.splice(0,Infinity,...list.filter(item=>item.history).map(item=>item.id));
  transcriptProviders.splice(0,Infinity,...list.filter(item=>item.transcript).map(item=>item.id));
  voiceProviders.splice(0,Infinity,...list.filter(item=>item.voice).map(item=>item.id));window.AIWSVoice?.refresh();
  accountProviders.splice(0,Infinity,...list.filter(item=>item.accounts).map(item=>item.id));
  configurableProviders.splice(0,Infinity,...list.map(item=>item.id));terminalAgentOrder.splice(0,Infinity,...configurableProviders);
  renderProviderFilter();
}
