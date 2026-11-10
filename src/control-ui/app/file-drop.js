'use strict';
// Dropping paths from the files panel onto task cards and into the task form's description.
// A path dragged from the files panel attaches to the task card it is dropped on.
let fileDropCard=null;
const draggedProjectFile=event=>!draggedIds.length&&window.AIWSImages&&event.dataTransfer?.types?.includes?.(window.AIWSImages.pathType);
function fileDropTarget(event){const card=event.target.closest?.('#board [data-open-task]'),item=card&&state.tasks.find(value=>value.id===card.dataset.openTask);return item&&!item.externalHistory&&item.projectId===project()?.id&&!card.classList.contains('organize-locked')?card:null;}
function showFileDrop(card){if(fileDropCard===card)return;fileDropCard?.classList.remove('file-drop-target');fileDropCard=card;card?.classList.add('file-drop-target');}
document.addEventListener('dragover',event=>{if(!draggedProjectFile(event))return;const card=fileDropTarget(event);showFileDrop(card);if(card){event.preventDefault();event.dataTransfer.dropEffect='copy';}});
document.addEventListener('dragleave',event=>{if(fileDropCard&&!fileDropCard.contains(event.relatedTarget))showFileDrop(null);});
document.addEventListener('drop',event=>{if(!draggedProjectFile(event))return;const card=fileDropTarget(event);showFileDrop(null);if(!card)return;event.preventDefault();void attachTaskFile(card.dataset.openTask,event.dataTransfer.getData(window.AIWSImages.pathType));});
document.addEventListener('dragend',()=>showFileDrop(null));
// A file dropped anywhere else on a task form goes into its description; inputs take the path as text.
const draggedPath=event=>window.AIWSImages&&event.dataTransfer?.types?.includes?.(window.AIWSImages.pathType)&&!event.target.closest('input,textarea,.CodeMirror,.files-panel');
$('#modal').addEventListener('dragover',event=>{if(!draggedPath(event)||!$('#modal-content .CodeMirror'))return;event.preventDefault();event.dataTransfer.dropEffect='copy';});
$('#modal').addEventListener('drop',event=>{if(!draggedPath(event))return;const editor=$('#modal-content .CodeMirror')?.CodeMirror,path=event.dataTransfer.getData(window.AIWSImages.pathType);if(!editor||!path)return;event.preventDefault();editor.setCursor(editor.lineCount(),0);window.AIWSImages.insertPath(editor,path);});
