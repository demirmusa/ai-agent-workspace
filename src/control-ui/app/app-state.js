'use strict';
// The server state the app renders, and the navigation and selection state shared by the views.
const state = {projects:[],tasks:[],runs:[],questions:[],events:[],messages:[],workflows:[],plannerMessages:[],agents:[],skills:[],schedules:[],generalWorkspace:null,settings:{}};
let activeScreen = 'board',stateReceivedAt=Date.now();
// Agents, skills and workflows are switched off for now: their sidebar screens and task fields stay hidden unless the
// browser stores aiws.library=on.
const libraryEnabled=(()=>{try{return localStorage.getItem('aiws.library')==='on';}catch{return false;}})();
let detailTab='console', sessionFullscreen=false, sessionWorkspace=null;
let detailReturnFocus=null,selectedHistory=null,childAgentSelection=null,childAgentPanel=null,agentScreen=null;
localStorage.removeItem('aiws.detail-tab');
let projectId = new URLSearchParams(location.search).get('project') || localStorage.getItem('aiws.project'), selectedTaskId = null, view = localStorage.getItem('aiws.view') || 'board', query = '', providerFilter = '', milestoneFilter = '';
// The project whose board milestone filter has been set up; a board opened for another project starts on its current milestone.
let milestoneFilterProject = null;
