'use strict';
// Switching screens and opening a project's board.
function switchScreen(next) { if(next==='sessions'){showOverviewTab('sessions');return;} if(next!==activeScreen)resetBoardFilters(); if(next==='settings'&&activeScreen!=='settings')settingsReturnScreen=activeScreen; activeScreen=next; selectedTaskId=null;selectedHistory=null; render(); }
function openProject(id){resetBoardFilters();activeScreen='board';projectId=id;selectedTaskId=null;selectedHistory=null;localStorage.setItem('aiws.project',projectId);if(projectTab()!=='terminal')ensureProjectSessions(project(),{force:true});render();}
// Sidebar entries and overview lanes carry data-project.
document.addEventListener('click',event=>{const target=event.target.closest('button,[data-open-task]');if(target?.dataset.project)openProject(target.dataset.project);});
