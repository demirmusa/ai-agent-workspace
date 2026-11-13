'use strict';
// Run script entries: their select values, kinds, command lines and saving the project's list.
// A script file choice is one select value: a file path, or `npm:<package.json>#<script>`. Custom commands carry `command` instead.
const runScriptValue=script=>script.npmScript?`npm:${script.path}#${script.npmScript}`:script.path||'';
const runScriptOptions=(selected,candidates={files:[],npm:[]})=>{const option=(value,label)=>`<option value="${esc(value)}" ${value===selected?'selected':''}>${esc(label)}</option>`,files=[...new Set([selected&&!selected.startsWith('npm:')?selected:'',...candidates.files].filter(Boolean))],npm=candidates.npm.flatMap(item=>item.scripts.map(name=>`npm:${item.path}#${name}`));if(selected?.startsWith('npm:')&&!npm.includes(selected))npm.unshift(selected);
  return `${files.length?`<optgroup label="${esc(globalThis.AIWSI18n.text('Script dosyaları'))}">${files.map(value=>option(value,value)).join('')}</optgroup>`:''}${npm.length?`<optgroup label="npm">${npm.map(value=>{const [path,name]=value.slice(4).split('#');return option(value,`npm run ${name}${path==='package.json'?'':` (${path})`}`);}).join('')}</optgroup>`:''}`;};
const runScriptChoice=value=>{if(!value.startsWith('npm:'))return {path:value};const [path,npmScript]=value.slice(4).split('#');return {path,npmScript};};
const runScriptKind=script=>script.command!==undefined?'command':script.npmScript?'npm':'file';
const runScriptLine=script=>`${script.command??(script.npmScript?`npm run ${script.npmScript}`:script.path)}${script.args?` ${script.args.split(/\s*\n\s*/).join(' ')}`:''}`;
const saveRunScripts=(current,scripts)=>api(`/projects/${current.id}`,'PATCH',{runScripts:scripts.map(({id,name,path,npmScript,command,args,askArgs})=>({id,name,...(askArgs?{askArgs}:{}),...(command!==undefined?{command}:{path,...(npmScript?{npmScript}:{})}),...(args?{args}:{})}))});
