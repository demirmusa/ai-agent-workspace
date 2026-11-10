'use strict';
// Opening the general workspace.
function openGeneralWorkspace(){const workspace=state.generalWorkspace;if(!workspace)return;activeScreen='board';projectId=workspace.id;selectedTaskId=null;selectedHistory=null;localStorage.setItem('aiws.project',projectId);if(!localStorage.getItem(`aiws.project-tab.${projectId}`))localStorage.setItem(`aiws.project-tab.${projectId}`,'schedules');render();}
