/* How a provider's tool call reads in the console: a title, the command or path it acted on, public argument fields and the public
 * part of its output. Provider transcripts are data: arguments are parsed as literals, never evaluated, and secrets, private
 * reasoning and system or developer blocks are dropped or redacted before anything is shown. */
(function (global) {
  'use strict';
  const kit = global.AIWSConversationKit, { commandInsight, stripAnsi, shellWords } = kit;
  function commandTitle(command, tool) {
    if (tool && !['Bash', 'shell', 'command_execution', 'execute'].includes(tool)) return tool;
    return commandInsight(command).title;
  }
  const redactToolText = value => String(value ?? '').replace(/gAAAA[A-Za-z0-9_-]{24,}={0,2}/g, globalThis.AIWSI18n.text('[ileti içeriği gizlendi]'));
  const privateToolBlock=value=>value&&typeof value==='object'&&(['system','developer','thinking','reasoning','image','image_url','audio'].includes(value.type)||['system','developer'].includes(value.role));
  function publicToolRaw(value){
    function clean(value,depth=0){if(depth>12||privateToolBlock(value))return undefined;if(typeof value==='string')return redactToolText(value);if(Array.isArray(value))return value.map(item=>clean(item,depth+1)).filter(item=>item!==undefined);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/^(?:authorization|password|secret|api_key|access_token|refresh_token|encrypted_content|signature|thinking|reasoning)$/i.test(key)).map(([key,item])=>[key,clean(item,depth+1)]).filter(([,item])=>item!==undefined));return value;}return JSON.stringify(clean(value),null,2)||'';
  }
  // Inspect literal arguments only. Provider transcripts are data: never eval a
  // tools.exec_command wrapper in order to show its underlying shell command.
  function literalAt(source, start) {
    const quote = source[start]; if (!['"', "'", '`'].includes(quote)) return '';
    let result = '';
    for (let index = start + 1; index < source.length; index++) {
      const char = source[index]; if (char === quote) return result;
      if (quote === '`' && char === '$' && source[index + 1] === '{') return '';
      if (char !== '\\') { result += char; continue; }
      const next = source[++index]; if (next === undefined) return '';
      if (next === 'u' && /^[\da-f]{4}$/i.test(source.slice(index + 1, index + 5))) { result += String.fromCharCode(parseInt(source.slice(index + 1, index + 5), 16)); index += 4; }
      else result += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[next] ?? next;
    }
    return '';
  }
  function staticArgument(source, start) {
    let at=start,remaining=500;
    const whitespace=()=>{while(/\s/.test(source[at]||'')&&at<source.length)at++;};
    function read(depth=0){
      whitespace();if(depth>12||--remaining<0)throw Error('Literal bound');const char=source[at];
      if(['"',"'",'`'].includes(char)){
        const begin=at++,quote=char;while(at<source.length){if(source[at]==='\\'){at+=2;continue;}if(source[at]===quote){at++;return literalAt(source,begin);}if(quote==='`'&&source.slice(at,at+2)==='${')throw Error('Dynamic template');at++;}throw Error('Incomplete string');
      }
      if(char==='{'||char==='['){const array=char==='[',value=array?[]:Object.create(null),close=array?']':'}';at++;whitespace();while(source[at]!==close){let key;if(!array){if(['"',"'"].includes(source[at]))key=read(depth+1);else{const match=source.slice(at).match(/^[A-Za-z_$][\w$]*/);if(!match)throw Error('Dynamic key');key=match[0];at+=key.length;}whitespace();if(source[at++]!==':')throw Error('Missing colon');}const next=read(depth+1);if(array)value.push(next);else value[key]=next;whitespace();if(source[at]===close)break;if(source[at++]!==',')throw Error('Missing comma');whitespace();}at++;return value;}
      const primitive=source.slice(at).match(/^(?:true\b|false\b|null\b|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?)/i);if(!primitive)throw Error('Dynamic argument');at+=primitive[0].length;return JSON.parse(primitive[0]);
    }
    try{const value=read();return value&&typeof value==='object'?value:null;}catch{return null;}
  }
  const safeUrl=value=>{try{const url=new URL(String(value));return ['http:','https:'].includes(url.protocol)?url.href:null;}catch{return null;}};
  function outputSources(value){
    const lines=String(value||'').split('\n'),sources=new Map();let active=null;
    for(let index=0;index<Math.min(lines.length,500)&&sources.size<12;index++){
      const line=lines[index],markdownLink=line.match(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/),namedLink=line.match(/^(.{2,180}?)\s*\((https?:\/\/[^\s)]+)\)/);
      for(const match of line.matchAll(/https?:\/\/[^\s<>"')\]]+/g)){
        const url=safeUrl(match[0].replace(/[.,;]+$/,''));if(!url)continue;if(sources.has(url)){active=sources.get(url);continue;}
        const title=markdownLink&&safeUrl(markdownLink[2])===url?markdownLink[1]:namedLink&&safeUrl(namedLink[2])===url?namedLink[1]:new URL(url).hostname;
        active={url,title,refs:[]};sources.set(url,active);
      }
      if(active)for(const ref of line.matchAll(/【(turn[\w]+)】/g))if(!active.refs.includes(ref[1]))active.refs.push(ref[1]);
    }return [...sources.values()];
  }
  function publicArgumentFields(input,prefix='',depth=0){
    if(!input||typeof input!=='object'||depth>2)return [];const fields=[];
    for(const [key,value]of Object.entries(input).slice(0,20)){
      if(/secret|token|authorization|password|cipher|signature|encrypted|thinking|reasoning/i.test(key)||value===null||value===undefined)continue;
      const label=prefix?`${prefix}.${key}`:key;if(typeof value==='object'){fields.push(...publicArgumentFields(value,label,depth+1));continue;}
      fields.push({label,value:redactToolText(String(value)).slice(0,1000)});if(fields.length>=16)break;
    }return fields.slice(0,16);
  }
  // Some tools return a whole result as one JSON-escaped line (literal \n and \\); show it as the text it encodes.
  function unescapeFlatOutput(value){
    if(value.includes('\n')||(value.match(/\\n/g)||[]).length<2)return value;
    try{const decoded=JSON.parse(`"${value.trim().replace(/^"|"$/g,'').replace(/(?<!\\)"/g,'\\"')}"`);return typeof decoded==='string'?decoded:value;}catch{return value;}
  }
  function publicToolOutput(value,depth=0){
    if(depth>5)return typeof value==='string'?redactToolText(value):publicToolRaw(value);
    if(typeof value==='string'){
      const trimmed=value.trim();if(trimmed.startsWith('{')){try{const parsed=JSON.parse(trimmed);if(parsed&&!parsed.role&&!parsed.type&&Array.isArray(parsed.content))return publicToolOutput(parsed.content,depth+1);}catch{/* Public file text remains text, even if it resembles a provider frame. */}}
      return redactToolText(unescapeFlatOutput(value));
    }
    if(Array.isArray(value))return value.map(part=>publicToolOutput(part,depth+1)).filter(Boolean).join('\n');
    if(value&&typeof value==='object'){
      if(privateToolBlock(value))return '';
      if(value.content)return publicToolOutput(value.content,depth+1);
      if(typeof value.text==='string')return publicToolOutput(value.text,depth+1);
      if(typeof value.output==='string')return publicToolOutput(value.output,depth+1);
      const safe=publicToolRaw(value),fields=publicArgumentFields(JSON.parse(safe||'null'));return fields.length?fields.map(field=>`${field.label}: ${field.value}`).join('\n'):safe;
    }return value===undefined||value===null?'':String(value);
  }
  /** A shell command as a row: what it does as the title (or the agent's own words for a command nothing recognizes), its subject as the preview. */
  function commandPresentation(command, { description = '', several = false } = {}) {
    const insight = commandInsight(command), said = typeof description === 'string' ? description.trim().slice(0, 200) : '';
    // A script of unrelated commands is no search or read, however its first command reads; only tests and builds speak for the whole.
    const title = several && !['test', 'build'].includes(insight.kind) ? globalThis.AIWSI18n.text('Terminal komutları') : insight.kind !== 'shell' ? insight.title : said || insight.title;
    return { title, command: redactToolText(command), preview: redactToolText(insight.subject), icon: insight.kind === 'shell' ? 'terminal' : insight.kind, insight, ...(said ? { description: said } : {}) };
  }
  /** One line of a command recorded as words: the script of `pwsh -Command …`, or the words joined. */
  function commandLine(value) {
    if (!Array.isArray(value)) return String(value ?? '');
    const flag = value.findIndex(word => /^(?:-l?c|-command|\/c)$/i.test(String(word)));
    return flag > 0 && value[flag + 1] !== undefined ? value.slice(flag + 1).join(' ') : value.join(' ');
  }
  /** Removes what providers wrap a command's output in and reads the exit code out of it. */
  function toolResult(output) {
    let text = String(output ?? ''), exitCode;
    const framed = text.match(/^(?:Chunk ID:[^\n]*\n)?(?:Script completed\n)?Wall time:? [^\n]*\n(?:Process exited with code (\d+)\n)?(?:Original token count:[^\n]*\n)?Output:\n/);
    if (framed) { text = text.slice(framed[0].length); if (framed[1] !== undefined) exitCode = Number(framed[1]); }
    const failed = text.match(/^Exit code (\d+)(?:\n|$)/);
    if (failed) exitCode = Number(failed[1]);
    return { output: text, ...(exitCode !== undefined ? { exitCode } : {}) };
  }
  /** Lines that differ between two texts as a small unified diff, with its added and removed counts. */
  function lineDiff(before, after) {
    const old = String(before ?? '').split('\n'), next = String(after ?? '').split('\n'); let start = 0;
    while (start < old.length && start < next.length && old[start] === next[start]) start++;
    let oldEnd = old.length, nextEnd = next.length;
    while (oldEnd > start && nextEnd > start && old[oldEnd - 1] === next[nextEnd - 1]) { oldEnd--; nextEnd--; }
    const removedLines = old.slice(start, oldEnd), addedLines = next.slice(start, nextEnd), middle = [];
    if (removedLines.length * addedLines.length <= 40000) {
      const table = Array.from({ length: removedLines.length + 1 }, () => new Uint16Array(addedLines.length + 1));
      for (let row = removedLines.length - 1; row >= 0; row--) for (let column = addedLines.length - 1; column >= 0; column--) table[row][column] = removedLines[row] === addedLines[column] ? table[row + 1][column + 1] + 1 : Math.max(table[row + 1][column], table[row][column + 1]);
      let row = 0, column = 0;
      while (row < removedLines.length || column < addedLines.length) {
        if (row < removedLines.length && column < addedLines.length && removedLines[row] === addedLines[column]) { middle.push(` ${removedLines[row]}`); row++; column++; }
        else if (column < addedLines.length && (row === removedLines.length || table[row][column + 1] >= table[row + 1][column])) middle.push(`+${addedLines[column++]}`);
        else middle.push(`-${removedLines[row++]}`);
      }
    } else middle.push(...removedLines.map(line => `-${line}`), ...addedLines.map(line => `+${line}`));
    const context = (lines, from, to) => lines.slice(Math.max(from, 0), to).map(line => ` ${line}`);
    return { diff: [...context(old, start - 2, start), ...middle, ...context(old, oldEnd, oldEnd + 2)].join('\n'), added: middle.filter(line => line[0] === '+').length, removed: middle.filter(line => line[0] === '-').length };
  }
  /** The file an edit tool changed, with the diff its arguments describe. */
  function editedFile(tool, value, path) {
    const kind = ['Write', 'write_file', 'create'].includes(tool) ? 'add' : 'update', content = value.content ?? value.file_text;
    if (typeof content === 'string') { const lines = content.split('\n'); return { path: String(path), kind, diff: lines.slice(0, 400).map(line => `+${line}`).join('\n'), added: lines.length, removed: 0 }; }
    const edits = Array.isArray(value.edits) ? value.edits : typeof value.old_string === 'string' ? [value] : [], parts = edits.filter(edit => typeof edit?.old_string === 'string' && typeof edit?.new_string === 'string').map(edit => lineDiff(edit.old_string, edit.new_string));
    return { path: String(path), kind, ...(parts.length ? { diff: parts.map(part => part.diff).join('\n@@\n'), added: parts.reduce((sum, part) => sum + part.added, 0), removed: parts.reduce((sum, part) => sum + part.removed, 0) } : {}) };
  }
  // Tools with a fixed name: the title their row shows.
  const NAMED_TOOLS = { ToolSearch: 'Araç yükleme', Skill: 'Skill', TaskStop: 'Arka plan işini durdurma', TaskOutput: 'Arka plan çıktısı', BashOutput: 'Arka plan çıktısı', KillShell: 'Arka plan işini durdurma', ScheduleWakeup: 'Zamanlanmış uyanış', WebFetch: 'Web sayfası okuma', NotebookEdit: 'Notebook düzenleme', view_image: 'Görsel görüntüleme', EnterPlanMode: 'Plan moduna geçiş', LS: 'Dosya listeleme', sleep: 'Bekleme' };
  function webPresentation(requests){
    const fields=[],operations=new Set();
    for(const input of requests){
      for(const [key,kind,label]of [['search_query','search',globalThis.AIWSI18n.text('Arama')],['image_query','search',globalThis.AIWSI18n.text('Görsel arama')],['open','open',globalThis.AIWSI18n.text('Kaynak')],['find','find',globalThis.AIWSI18n.text('Sayfada ara')],['click','open',globalThis.AIWSI18n.text('Bağlantı')]]){
        const values=Array.isArray(input[key])?input[key]:input[key]?[input[key]]:[];
        for(const value of values.slice(0,12)){
          const row=typeof value==='string'?{q:value,ref_id:value}:value;if(!row||typeof row!=='object')continue;operations.add(kind);
          if(row.q)fields.push({label,value:String(row.q),...(Array.isArray(row.domains)&&row.domains.length?{detail:row.domains.filter(domain=>typeof domain==='string').join(', ')}:{})});
          if(row.pattern)fields.push({label,value:String(row.pattern)});
          const ref=row.ref_id||row.url||row.ref;if(ref)fields.push({label:row.pattern?globalThis.AIWSI18n.text('Kaynak'):label,value:String(ref),...(Number.isFinite(row.lineno)?{detail:globalThis.AIWSI18n.template`Satır ${row.lineno}`}:{})});
          if(Number.isFinite(row.id))fields.push({label:globalThis.AIWSI18n.text('Bağlantı numarası'),value:String(row.id)});
        }
      }
      if(!Object.keys(input).some(key=>['search_query','image_query','open','find','click'].includes(key)))fields.push(...publicArgumentFields(input));
    }
    const title=operations.size>1?globalThis.AIWSI18n.text('Web araştırması'):operations.has('search')?globalThis.AIWSI18n.text('Web araması'):operations.has('find')?globalThis.AIWSI18n.text('Kaynakta arama'):operations.has('open')?globalThis.AIWSI18n.text('Kaynak okuma'):globalThis.AIWSI18n.text('Web aracı');
    return {title,command:'',preview:fields.filter(field=>![globalThis.AIWSI18n.text('Bağlantı numarası')].includes(field.label)).map(field=>field.value).join(' · '),fields:fields.slice(0,24).map(field=>({...field,value:redactToolText(field.value),...(field.detail?{detail:redactToolText(field.detail)}:{})})),icon:'search',web:true,hideRawInput:true};
  }
  function toolPresentation(name, input) {
    if(typeof input==='string'){try{input=JSON.parse(input);}catch{/* Custom tools may supply a non-JSON literal. */}}
    const value = input && typeof input === 'object' ? input : { input }, tool = String(name || 'Tool').split(/[.:]/).at(-1),normalizedName=String(name||'').replace(/^mcp__/,'').replace(/[\s_/.]+/g,'.').toLowerCase();
    const script = typeof value.input === 'string' ? value.input : typeof value.code === 'string' ? value.code : '';
    if(normalizedName==='web.run')return webPresentation([value]);
    if(tool==='exec'){
      const calls=[...script.matchAll(/\btools\.(?:web__run|web_run|web\.run)\s*\(/g)];
      if(calls.length){const requests=calls.map(match=>staticArgument(script,match.index+match[0].length)).filter(Boolean);return requests.length?webPresentation(requests):{title:globalThis.AIWSI18n.text('Web aracı'),command:'',preview:'',web:true,icon:'search',hideRawInput:true};}
    }
    const commands = [...script.matchAll(/(?:\b(?:cmd|command)|["'](?:cmd|command)["'])\s*:\s*(["'`])/g)].map(match => literalAt(script, match.index + match[0].length - 1)).filter(Boolean);
    if (tool === 'Workflow') return { title: globalThis.AIWSI18n.text('Workflow başlatma'), command: String(value.name || value.scriptPath || ''), icon: 'agent', hideRawInput: true };
    if (['Task', 'Agent'].includes(tool)) return { title: globalThis.AIWSI18n.text('Alt agent başlatma'), command: String(value.description || value.name || value.subagent_type || ''), icon: 'agent', hideToolPayload: true };
    const target = String(value.target || value.agent_id || value.id || '').slice(0, 160);
    if (['send_message', 'followup_task', 'send_input', 'interrupt_agent', 'close_agent', 'resume_agent', 'wait_agent', 'wait', 'list_agents', 'spawn_agent'].includes(tool)) {
      const title = ({ send_message: globalThis.AIWSI18n.text('Agent ile iletişim'), followup_task: globalThis.AIWSI18n.text('Agenta yeni görev'), send_input: globalThis.AIWSI18n.text('Agenta talimat'), interrupt_agent: globalThis.AIWSI18n.text('Agentı durdurma'), close_agent: globalThis.AIWSI18n.text('Agentı kapatma'), resume_agent: globalThis.AIWSI18n.text('Agentı sürdürme'), wait_agent: globalThis.AIWSI18n.text('Agentlar bekleniyor'), wait: globalThis.AIWSI18n.text('Agentlar bekleniyor'), list_agents: globalThis.AIWSI18n.text('Agent durumları'), spawn_agent: globalThis.AIWSI18n.text('Alt agent başlatma') })[tool];
      return { title, command: target || String(value.task_name || ''), icon: 'agent', hideToolPayload: true };
    }
    let patch = tool === 'apply_patch' ? String(value.patch || value.input || '') : '';
    if (tool === 'exec' && /\btools\.apply_patch\s*\(/.test(script)) {
      const match = script.match(/\btools\.apply_patch\s*\(\s*(["'`])/); patch = match ? literalAt(script, match.index + match[0].length - 1) : '';
    }
    if (patch) {
      const files = [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File:\s*(.+)$/gm)].map(match => ({ path: match[2].trim(), kind: ({ Add: 'add', Update: 'update', Delete: 'delete' })[match[1]] }));
      return { ...(files.length ? { kind: 'files', files } : {}), title: globalThis.AIWSI18n.text('Dosyalar düzenlendi'), command: commands.join('\n'), icon: 'files', ...(tool === 'exec' ? { wrapper: true } : {}) };
    }
    if (tool === 'TodoWrite' || tool === 'update_plan') {
      const list = Array.isArray(value.todos) ? value.todos : Array.isArray(value.plan) ? value.plan : [];
      return { title: globalThis.AIWSI18n.text('Yapılacaklar'), command: '', icon: 'todo', view: 'todo', hideToolPayload: true, todos: list.slice(0, 100).map(item => ({ text: redactToolText(String((item?.status === 'in_progress' && item?.activeForm) || item?.content || item?.step || '')), status: String(item?.status || 'pending') })), preview: redactToolText(String(list.find(item => item?.status === 'in_progress')?.activeForm || list.find(item => item?.status === 'in_progress')?.content || list.find(item => item?.status === 'in_progress')?.step || '')) };
    }
    if ((tool === 'AskUserQuestion' || tool === 'request_user_input') && Array.isArray(value.questions)) {
      const questions = value.questions.slice(0, 8).map(item => ({ question: redactToolText(String(item?.question || '')), header: redactToolText(String(item?.header || '')), options: (Array.isArray(item?.options) ? item.options : []).slice(0, 12).map(option => ({ label: redactToolText(String(option?.label || '')), description: redactToolText(String(option?.description || '')) })) }));
      return { title: globalThis.AIWSI18n.text('Sana soru sordu'), command: '', icon: 'question', view: 'question', questions, preview: questions[0]?.question || '', hideRawInput: true, quietOutput: true };
    }
    if (tool === 'ExitPlanMode') return { title: globalThis.AIWSI18n.text('Plan onayı'), command: '', icon: 'plan', view: 'plan', plan: redactToolText(String(value.plan || '')), preview: '', hideRawInput: true, quietOutput: true };
    const command = typeof value.command === 'string' ? value.command : Array.isArray(value.command) ? value.command.join(' ') : typeof value.cmd === 'string' ? value.cmd : tool === 'exec' ? commands.join('\n') : '';
    if (command) return { ...commandPresentation(command, { description: value.description, several: commands.length > 1 }), ...(tool === 'exec' ? { wrapper: true } : {}) };
    const path = value.file_path || value.notebook_path || value.path || value.filename, pattern = value.pattern || value.query;
    if (['Read', 'read_file', 'read', 'GetContent', 'view'].includes(tool)) return { title: globalThis.AIWSI18n.text('Dosya okuma'), command: String(path || ''), icon: 'read', view: 'read' };
    if (['Write', 'Edit', 'MultiEdit', 'write_file', 'edit_file', 'edit', 'create'].includes(tool)) return { kind: 'files', title: globalThis.AIWSI18n.text('Dosyalar düzenlendi'), command: '', files: path ? [editedFile(tool, value, path)] : [], icon: 'files' };
    if (['WebSearch', 'web_search'].includes(tool)) return { title: globalThis.AIWSI18n.text('Web araması'), command: [pattern, path].filter(Boolean).join(' · '), icon: 'search' };
    if (['Grep', 'Glob', 'search', 'grep', 'glob'].includes(tool)) return { title: globalThis.AIWSI18n.text('Kodda arama'), command: '', icon: 'search', view: 'search', preview: redactToolText([pattern, path].filter(Boolean).join(' · ')), search: { pattern: redactToolText(String(pattern || '')), paths: path ? [redactToolText(String(path))] : [], flags: [value.glob, value.type, value['-i'] || value.case_insensitive ? '-i' : ''].filter(Boolean).map(String) }, hideRawInput: true };
    if (tool === 'exec') {
      const names = [...new Set([...script.matchAll(/\btools\.([\w]+)\s*\(/g)].map(match => match[1].replace(/^mcp__/, '').replace(/__/g, ' / ')))];
      return { title: globalThis.AIWSI18n.text('Araç çalıştırma'), command:'',preview:names.slice(0, 3).join(' · '),icon:'tool',hideRawInput:true };
    }
    const server = /^mcp__(.+?)__(.+)$/.exec(String(name || ''));
    const title = server ? `${server[1].replace(/[_-]/g, ' ')} · ${server[2].replace(/[_-]/g, ' ')}` : NAMED_TOOLS[tool] ? globalThis.AIWSI18n.text(NAMED_TOOLS[tool]) : tool.replace(/[_-]/g, ' ');
    return { title,command:'',preview:redactToolText(String(path||pattern||value.url||value.skill||value.description||'')),fields:publicArgumentFields(value),icon:'tool' };
  }
  Object.assign(kit, { commandTitle, commandPresentation, commandLine, toolResult, lineDiff, redactToolText, publicToolRaw, publicToolOutput, webPresentation, toolPresentation, safeUrl, outputSources });
})(globalThis);
