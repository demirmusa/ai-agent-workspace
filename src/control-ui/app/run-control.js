'use strict';
// The header Run button and its script choice.
// Header Run button: starts the selected project script in a terminal tab. The choice is remembered per project.
const runScriptKey=id=>`aiws.run-script.${id}`;
function selectedRunScript(current){const scripts=current?.runScripts||[];let saved='';try{saved=localStorage.getItem(runScriptKey(current.id))||'';}catch{/* The choice is only a convenience. */}return scripts.find(item=>item.id===saved)||scripts[0];}
function renderRunControl(current){
  const scripts=current?.runScripts||[],box=$('#run-control');box.hidden=!scripts.length||activeScreen!=='board';if(box.hidden)return;
  const select=$('#run-script-select'),selected=selectedRunScript(current),single=scripts.length===1,button=$('#run-script-button');
  setHtml(select,scripts.map(item=>`<option value="${esc(item.id)}" title="${esc(runScriptLine(item))}">${esc(item.name)}</option>`).join(''));select.value=selected.id;
  // One script needs no picker: the button names it and runs it directly.
  select.hidden=single;box.classList.toggle('single',single);
  $('#run-script-label').textContent=single?`Run '${selected.name}'`:'Run';
  button.title=`${selected.name} · ${runScriptLine(selected)}`;
}
function runSelectedScript(){
  const current=project(),script=current&&selectedRunScript(current);if(!script)return;
  if(!script.askArgs){startRunScript(current,script);return;}
  const popover=$('#run-args-popover');if(!popover.hidden){closeRunArgs();return;}openRunArgs(script);
}
// Opens the project's terminal tab and runs the script there, with the arguments when the popover asked for them.
function startRunScript(current,script,args){localStorage.setItem(`aiws.project-tab.${current.id}`,'terminal');selectedTaskId=null;selectedHistory=null;render();void openProjectTerminal(current.id,{kind:'script',scriptId:script.id,...(args===undefined?{}:{args})});}
$('#run-script-select').onchange=event=>{closeRunArgs();try{localStorage.setItem(runScriptKey(projectId),event.target.value);}catch{/* Not persisted. */}renderRunControl(project());};
$('#run-script-button').onclick=runSelectedScript;
$('#run-args-form').addEventListener('submit',event=>{event.preventDefault();const current=project(),script=current&&selectedRunScript(current);if(!script?.askArgs)return;let args,stored;if(structuredRunArgs&&runArgsScriptId===script.id){stored=Object.fromEntries([...$('#run-args-fields').querySelectorAll('[data-run-args-name]')].map(input=>[input.dataset.runArgsName,input.type==='checkbox'?input.checked:input.value]));args=Object.entries(stored).flatMap(([name,value])=>{const parameter=runArgsParameters.find(item=>item.name===name);if(parameter?.switch)return value?[`-${name}`]:[];if(value==='')return [];const text=String(value);return [`-${name}`,/[\s"]/.test(text)?`"${text.replaceAll('"','\\"')}"`:text];}).join(' ');}else{args=$('#run-args-input').value.trim();stored=args;}saveRunArgsHistory(current.id,script.id,[stored,...runArgsHistory(script.id)]).catch(()=>{/* Run history is a convenience. */});closeRunArgs();startRunScript(current,script,args);});
