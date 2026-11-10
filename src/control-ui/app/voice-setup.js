'use strict';
// Dictation setup.
// Dictation uses the speech service of the provider chosen in the application settings (the first capable one until chosen).
window.AIWSVoice.setup({provider:()=>voiceProviders.includes(state.settings?.voiceProvider)?state.settings.voiceProvider:voiceProviders[0]||'',token:()=>token,toast:message=>toast(message)});
