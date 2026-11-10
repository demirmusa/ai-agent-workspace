'use strict';
// The part of the app plugins may use (see plugins.js and src/assets/agent-skills/aiws-plugin-development); plugins start after the first state.
// Members call through at use time, so the bridge never holds a function before the script that defines it has loaded.
const pluginBridge={api:(...args)=>api(...args),state:()=>state,screen:()=>activeScreen,project:()=>project(),task:()=>task(),projectTab:()=>projectTab(),render:()=>render(),toast:message=>toast(message),error:message=>error(message),showModal:(...args)=>showModal(...args),formFooter:(...args)=>formFooter(...args),closeModal:()=>$('#modal').close(),switchScreen:next=>switchScreen(next),markdown:text=>window.AIWSAgentConsole?.markdown(text)||esc(text),
  openProject:id=>{projectId=id;localStorage.setItem('aiws.project',id);switchScreen('board');},
  openTask:id=>{const item=state.tasks.find(entry=>entry.id===id);if(!item)return;if(item.projectId!==projectId){projectId=item.projectId;localStorage.setItem('aiws.project',projectId);}activeScreen='board';openTask(id);},
  selectProjectTab:tab=>{localStorage.setItem(`aiws.project-tab.${projectId}`,tab);activeScreen='board';selectedTaskId=null;selectedHistory=null;render();}};
