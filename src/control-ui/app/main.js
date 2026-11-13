'use strict';
// Starts the app once every part has loaded: the live stream, plugins after the first state, subscription usage and a task
// draft saved before a restart. The stream opens with the full state, so a state read only stands in when it is slow to
// connect: loading both would download and parse the whole state twice.
stream();
const firstStateFallback=setTimeout(()=>void refresh(),1500);
void firstState.then(()=>{clearTimeout(firstStateFallback);window.AIWSPlugins?.start(pluginBridge);});
void loadSavedTaskDraft();
void loadTokenUsage();
