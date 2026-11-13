'use strict';
// Project labels: GitHub-style chips coloured by the label, with text that stays readable on it.
const projectLabels=projectId=>state.projects.find(project=>project.id===projectId)?.labels||[];
const findLabel=(labels,name)=>labels.find(label=>label.name.toLowerCase()===String(name).toLowerCase());
function labelChip(labels,name,extra=''){
  const label=findLabel(labels,name),color=/^[0-9a-f]{6}$/i.test(label?.color||'')?label.color:'8b949e',[r,g,b]=[0,2,4].map(index=>parseInt(color.slice(index,index+2),16));
  return `<span class="label-chip" style="--label-color:#${color};--label-text:${(r*299+g*587+b*114)/1000>150?'#1f2328':'#ffffff'}" ${label?.description?`title="${esc(label.description)}"`:''}><span>${esc(label?.name||name)}</span>${extra}</span>`;
}
