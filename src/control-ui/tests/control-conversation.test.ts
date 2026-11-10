import { afterEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { uiScriptSource, uiStylePaths } from './ui-sources.js';

const source = await uiScriptSource(path => ['translations-en.js','i18n.js','ui-common.js'].includes(path) || path.startsWith('ui/') || path.startsWith('conversation/'));
const conversationCss = (await uiStylePaths()).filter(path => path.startsWith('styles/conversation/')).map(path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')).join('\n');
const windows: Window[] = [];
function fixture(language = 'tr') {
  const window = new Window({url:'http://localhost'}); windows.push(window); window.localStorage.setItem('aiws.language',language); window.eval(source);
  const api = (window as unknown as { AIWSConversation: { normalize: (data: unknown) => any[]; inferAgentTree: (data: unknown) => any; markdown: (text: string) => string; create: (host: unknown, data: unknown) => any } }).AIWSConversation;
  const host = window.document.createElement('div'); window.document.body.append(host);
  return { window, api, host };
}
const run = { id: 'run-1', taskId: 'task-1', provider: 'codex', status: 'running', startedAt: '2026-10-16T12:23:18Z' };
let serial = 0;
const event = (message: string, type = 'stdout', second = 20) => ({ id: `event-${++serial}`, taskId: 'task-1', runId: 'run-1', type, message, createdAt: `2026-10-16T12:23:${second}Z` });
const json = (value: unknown, second = 20) => event(`${JSON.stringify(value)}\n`, 'stdout', second);
const taskData = (events: unknown[], extra = {}) => ({ taskId: 'task-1', runs: [run], events, ...extra });
afterEach(async () => { for (const window of windows.splice(0)) await window.happyDOM.close(); });

describe('structured agent conversation', () => {
  it('hides a system note that repeats an agent message', () => {
    const {api}=fixture(), text='İlk satır\nİkinci satır';
    const nodes=api.normalize(taskData([event(text,'reply',21)],{messages:[{id:'message-1',taskId:'task-1',runId:'run-1',authorType:'agent',authorName:'codex',text,createdAt:'2026-10-16T12:23:22Z'}]})).flatMap((group: any)=>group.nodes);
    expect(nodes.filter((node: any)=>node.text===text).map((node: any)=>node.kind)).toEqual(['assistant']);
  });
  it('shows a chat instruction sent to a native terminal once', () => {
    const {api}=fixture();
    const nodes=api.normalize(taskData([event('Bir soru daha','command',21),event('Sadece komut','command',22)],{runs:[{...run,terminalMode:'pty'}],messages:[{id:'message-1',taskId:'task-1',runId:'run-1',authorType:'user',authorName:'You',text:'Bir soru daha',createdAt:'2026-10-16T12:23:21Z'}]})).flatMap((group: any)=>group.nodes);
    expect(nodes.filter((node: any)=>node.text==='Bir soru daha').map((node: any)=>node.kind)).toEqual(['user']);
    expect(nodes.some((node: any)=>node.text==='Sadece komut')).toBe(true);
  });
  it('turns GitHub Copilot JSONL into messages, tools, subagents and errors without lifecycle noise', () => {
    const { api } = fixture();
    const copilotRun = { ...run, provider: 'copilot' };
    const line = (type: string, data: Record<string, unknown>, second: number, extra: Record<string, unknown> = {}) => json({ type, data, id: `${type}-${second}`, timestamp: `2026-10-16T12:23:${second}Z`, ...extra }, second);
    const events = [
      line('session.mcp_server_status_changed', { serverName: 'github-mcp-server', status: 'connected' }, 20, { ephemeral: true }), line('session.tools_updated', { model: 'claude-sonnet-5.5' }, 20, { ephemeral: true }),
      line('user.message', { content: 'Read and follow the task instructions' }, 21), line('assistant.turn_start', { turnId: '0' }, 21), line('assistant.reasoning', { reasoningId: 'r1', content: 'PRIVATE_REASONING' }, 21),
      line('assistant.message', { messageId: 'm1', content: 'Checking the repository.', toolRequests: [{ toolCallId: 'tool-1' }] }, 22),
      line('tool.execution_start', { toolCallId: 'tool-1', toolName: 'bash', arguments: { command: 'git status --short', description: 'Status' } }, 22),
      line('tool.execution_complete', { toolCallId: 'tool-1', success: true, result: { content: ' M src/app.ts' } }, 23),
      line('subagent.started', { toolCallId: 'task-1', agentName: 'explore', agentDisplayName: 'Explore agent' }, 24),
      line('assistant.message', { messageId: 'm-sub', content: 'Found the entry point.', parentToolCallId: 'task-1' }, 25),
      line('subagent.completed', { toolCallId: 'task-1', agentName: 'explore', agentDisplayName: 'Explore agent' }, 26),
      line('assistant.message_delta', { messageId: 'm2', deltaContent: 'Do' }, 27, { ephemeral: true }), line('assistant.message', { messageId: 'm2', content: 'Done.' }, 27),
      line('session.error', { errorType: 'quota', message: 'You have exceeded your monthly quota' }, 28),
      json({ type: 'result', timestamp: '2026-10-16T12:23:29Z', sessionId: 'c1296dcf-ba51-4a2f-9dda-98e25d0308d0', exitCode: 1, usage: { premiumRequests: 1 } }, 29),
    ];
    const [group] = api.normalize(taskData(events, { runs: [copilotRun] })); const nodes = group.nodes;
    expect(group.sessionId).toBe('c1296dcf-ba51-4a2f-9dda-98e25d0308d0'); expect(group.model).toBe('claude-sonnet-5.5');
    expect(nodes.filter((node: any) => node.kind === 'assistant' && !node.agentId).map((node: any) => node.text)).toEqual(['Checking the repository.', 'Done.']);
    expect(nodes.find((node: any) => node.kind === 'tool')).toMatchObject({ command: 'git status --short', output: ' M src/app.ts', status: 'completed' });
    const subagent = group.agents.find((agent: any) => agent.name === 'Explore agent'); expect(subagent).toMatchObject({ role: 'explore', status: 'completed' });
    expect(nodes.find((node: any) => node.text === 'Found the entry point.')?.agentId).toBe(subagent.id);
    expect(nodes.find((node: any) => node.kind === 'error')?.text).toBe('You have exceeded your monthly quota');
    expect(nodes.some((node: any) => node.kind === 'unknown')).toBe(false); expect(JSON.stringify(nodes)).not.toContain('PRIVATE_REASONING');
  });
  it('shows Antigravity subagent steps as agents', () => {
    const { api } = fixture();
    const step = (step_type: string, status: string, second: number, extra = {}) => json({ event: 'step_update', step_update: { step_index: 3, step_type, status, ...extra } }, second);
    const [group] = api.normalize(taskData([step('invoke_subagent', 'RUNNING', 21, { invoke_subagent: { name: 'Kodu incele' } }), step('invoke_subagent', 'DONE', 22, { invoke_subagent: { name: 'Kodu incele' } })], { runs: [{ ...run, provider: 'agy' }] }));
    expect(group.agents).toHaveLength(1); expect(group.agents[0]).toMatchObject({ name: 'Kodu incele', status: 'completed' });
  });
  it('renders markdown tables as real tables with alignment, inline code and escaped pipes', () => {
    const {api,host}=fixture();
    host.innerHTML=api.markdown('Özet:\n\n| Alan | Sayı | Not |\n|:--|--:|:-:|\n| `main` | 11 | a \\| b |\n| <b>x</b> | 2 |\n\nSon satır');
    const rows=[...host.querySelectorAll('table.cv-table tr')].map((row:any)=>[...row.children].map((cell:any)=>cell.textContent));
    expect(rows).toEqual([['Alan','Sayı','Not'],['main','11','a | b'],['<b>x</b>','2','']]);
    expect(host.querySelector('td code')?.textContent).toBe('main'); expect(host.querySelector('td b')).toBeNull();
    expect((host.querySelectorAll('th')[1] as any).getAttribute('style')).toContain('right'); expect(host.querySelector('p:last-child')?.textContent).toBe('Son satır');
    host.innerHTML=api.markdown('a | b\nbunun ayracı yok'); expect(host.querySelector('table')).toBeNull();
  });
  it('renders task attachment images for authenticated loading and keeps remote images as links', () => {
    const {api,host}=fixture();
    const id='e'.repeat(64)+'.png';
    host.innerHTML=api.markdown(`Ekran: ![hata](/api/attachments/${id}) ![](/api/attachments/../x.png) ![uzak](https://example.test/a.png) ![x" onerror="y](/api/attachments/${id})`);
    const images=[...host.querySelectorAll('img')];
    expect(images.map(img=>img.getAttribute('data-attachment-src'))).toEqual([`/api/attachments/${id}`,`/api/attachments/${id}`]);
    expect(images.every(img=>!img.hasAttribute('src')&&!img.hasAttribute('onerror'))).toBe(true);
    expect(images[0]?.getAttribute('alt')).toBe('hata');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.test/a.png');
    expect(host.textContent).toContain('![](/api/attachments/../x.png)');
  });
  it('localizes console chrome while preserving provider messages and output', () => {
    const {api,host}=fixture('en');
    const events=[json({type:'item.completed',item:{id:'reply',type:'agent_message',text:'Yeni görev: Türkçe mesaj'}}),json({type:'item.completed',item:{id:'tool',type:'command_execution',command:'echo Çalışıyor',aggregated_output:'Tamamlandı',exit_code:0,status:'completed'}})];
    api.create(host,taskData(events));
    expect(host.textContent).toContain('Yeni görev: Türkçe mesaj');
    expect(host.textContent).toContain('Tamamlandı');
    expect(host.textContent).toContain('echo Çalışıyor');
    expect(host.querySelector('textarea')?.getAttribute('placeholder')).toBe('Write instructions for the agent…');
    expect(host.textContent).toContain('Send ↗');
  });
  it('renders real wrapped web queries, source refs and typed public results without losing tool output', async () => {
    const {api,host,window}=fixture(),writeText=vi.fn().mockResolvedValue(undefined);Object.defineProperty(window.navigator,'clipboard',{configurable:true,value:{writeText}});
    const script='const r=await tools.web__run({search_query:[{q:"Codex session resume",domains:["developers.openai.com"]}],open:[{ref_id:"turn1search1"}],find:[{ref_id:"https://example.com/docs",pattern:"resume"}],response_length:"short"}); text(r); globalThis.shouldNotExecute=true;';
    const result=[{type:'text',text:'First source (https://first.example/docs)\nSecond source (https://second.example/docs)\n【turn1search1】\nA useful public excerpt about **resume**.'},{type:'input_text',text:'Additional retained public evidence. A file can mention developer and system roles.'},{type:'system',text:'PRIVATE_SYSTEM'},{type:'reasoning',text:'PRIVATE_REASONING'},{type:'text',role:'developer',text:'PRIVATE_DEVELOPER'}];
    const events=[json({type:'assistant',message:{id:'web-start',content:[{type:'tool_use',id:'web-call',name:'exec',input:{input:script}}]}}),json({type:'user',message:{content:[{type:'tool_result',tool_use_id:'web-call',content:result}]}},23)];
    const data=taskData(events),nodes=api.normalize(data)[0].nodes;expect(nodes.filter((node:any)=>node.kind==='tool')).toHaveLength(1);expect(nodes[0]).toMatchObject({title:'Web araştırması',web:true,status:'completed'});expect(nodes[0].output).toContain('Additional retained public evidence.');expect(nodes[0].output).not.toContain('PRIVATE_');api.create(host,data);expect((window as any).shouldNotExecute).toBeUndefined();
    expect(host.querySelector('.cv-tool-preview')?.textContent).toContain('Codex session resume');expect(host.querySelector('.cv-tool-fields')?.textContent).toContain('developers.openai.com');expect(host.querySelector('.cv-web-output strong')?.textContent).toBe('resume');expect(host.textContent).not.toContain('Komut / dosya');expect(host.textContent).not.toContain('◇');expect(host.textContent).not.toContain('PRIVATE_');expect(host.textContent).toContain('A file can mention developer and system roles.');expect(host.querySelector('.cv-tool-details')?.hasAttribute('open')).toBe(false);
    const source=[...host.querySelectorAll('.cv-tool-fields a')].find(link=>link.textContent==='Second source');expect(source?.getAttribute('href')).toBe('https://second.example/docs');expect(host.querySelector('.cv-tool-fields a[href="https://first.example/docs"]')).toBeNull();
    (host.querySelector('[data-copy-field="field:0"]')as any).click();await vi.waitFor(()=>expect(writeText).toHaveBeenCalledWith('Codex session resume'));
    (host.querySelector('[data-copy-field=output]')as any).click();await vi.waitFor(()=>expect(writeText).toHaveBeenCalledWith(nodes[0].output));
  });

  it('recognizes web tool aliases and safely keeps dynamic-wrapper and unknown-tool public results with source truncation', () => {
    const {api,host,window}=fixture();const events:unknown[]=[];
    for(const [index,name]of ['web.run','web__run','web / run'].entries())events.push(json({type:'assistant',message:{id:'alias'+index,content:[{type:'tool_use',id:'alias'+index,name,input:{open:[{ref_id:'https://example.com/page'+index}]}}]}}));
    events.push(json({type:'assistant',message:{id:'dynamic-web',content:[{type:'tool_use',id:'dynamic-web',name:'functions.exec',input:{input:'await tools.web__run(dynamicArgs); globalThis.unsafe=true;'}},{type:'tool_use',id:'unknown-tool',name:'project_lookup',input:{project:'alpha',limit:3,encrypted_content:'gAAAA'+('Q'.repeat(100))}}]}}));
    events.push(json({type:'user',message:{content:[{type:'tool_result',tool_use_id:'dynamic-web',content:'Actual available web result.'},{type:'tool_result',tool_use_id:'unknown-tool',content:'Actual lookup result.',truncated:true,original_characters:19000,retained_characters:16000}]}},23));
    const nodes=api.normalize(taskData(events))[0].nodes;expect(nodes.slice(0,3).every((node:any)=>node.web&&node.title==='Kaynak okuma')).toBe(true);expect(nodes.find((node:any)=>node.id==='tool:dynamic-web').output).toBe('Actual available web result.');expect(nodes.find((node:any)=>node.id==='tool:unknown-tool')).toMatchObject({fields:expect.arrayContaining([{label:'project',value:'alpha'},{label:'limit',value:'3'}]),output:'Actual lookup result.',outputTruncated:true});
    api.create(host,taskData(events));expect(host.textContent).toContain('Actual lookup result.');expect(host.querySelector('.cv-output-truncated')?.textContent).toContain('16.000 / 19.000');expect(host.innerHTML).not.toContain('gAAAA');expect((window as any).unsafe).toBeUndefined();
    const nested={records:[{type:'reasoning',text:'PRIVATE_SHALLOW'}],data:{response:{items:[{name:'Retained nested public value'},{type:'reasoning',text:'PRIVATE_NESTED'}]}}},fileText='[{"role":"system","content":"Public JSON file example"}]';
    const extra=[...events,json({type:'user',message:{content:[{type:'tool_result',tool_use_id:'unknown-tool',content:nested}]}},24),json({type:'user',message:{content:[{type:'tool_result',tool_use_id:'dynamic-web',content:fileText}]}},25)];const output=api.normalize(taskData(extra))[0].nodes;expect(output.find((node:any)=>node.id==='tool:unknown-tool').output).toContain('Retained nested public value');expect(output.find((node:any)=>node.id==='tool:unknown-tool').output).not.toContain('PRIVATE_NESTED');expect(output.find((node:any)=>node.id==='tool:dynamic-web').output).toBe(fileText);
  });

  it('follows new activity, pauses independently when scrolled up, and does not count unchanged polls as new work', () => {
    const {api,host,window}=fixture(),second=window.document.createElement('div');window.document.body.append(second);
    const initial=[json({type:'item.started',item:{id:'work',type:'command_execution',command:'npm test',status:'in_progress'}})],data=taskData(initial),first=api.create(host,data),other=api.create(second,{...data,instanceId:'child:independent'});
    const scroller=host.querySelector('.cv-scroll')!,otherScroll=second.querySelector('.cv-scroll')!;Object.defineProperties(scroller,{scrollHeight:{configurable:true,value:1000},clientHeight:{configurable:true,value:200}});Object.defineProperties(otherScroll,{scrollHeight:{configurable:true,value:1000},clientHeight:{configurable:true,value:200}});
    scroller.scrollTop=1000;scroller.dispatchEvent(new window.Event('scroll'));otherScroll.scrollTop=100;otherScroll.dispatchEvent(new window.Event('scroll'));expect(second.querySelector('.cv-unread')?.textContent).toBe('En alta in ↓');
    const completed=[...initial,json({type:'item.completed',item:{id:'work',type:'command_execution',command:'npm test',aggregated_output:'Real appended test output',status:'completed',exit_code:0}},23)];Object.defineProperty(scroller,'scrollHeight',{configurable:true,value:1300});first.update(taskData(completed));other.update(taskData(completed));expect(scroller.scrollTop).toBe(1300);expect(otherScroll.scrollTop).toBe(100);expect(second.querySelector('.cv-unread')?.textContent).toBe('Yeni işlemler (1) ↓');
    other.update(taskData(completed));expect(second.querySelector('.cv-unread')?.textContent).toBe('Yeni işlemler (1) ↓');(second.querySelector('.cv-tool-details')as any).open=true;other.update(taskData(completed));expect(otherScroll.scrollTop).toBe(100);expect(second.querySelector('.cv-unread')?.textContent).toBe('Yeni işlemler (1) ↓');
    (second.querySelector('.cv-unread')as any).click();expect(otherScroll.scrollTop).toBe(1000);expect(second.querySelector('.cv-unread')?.hasAttribute('hidden')).toBe(true);otherScroll.scrollTop=100;otherScroll.dispatchEvent(new window.Event('scroll'));expect(second.querySelector('.cv-unread')?.textContent).toBe('En alta in ↓');otherScroll.scrollTop=800;otherScroll.dispatchEvent(new window.Event('scroll'));expect(second.querySelector('.cv-unread')?.hasAttribute('hidden')).toBe(true);
  });

  it('uses the real terminal viewport for paused scrollback and resumes only from the bottom control', () => {
    const {api,host}=fixture();let publish!:(value:unknown)=>void;const dispose=vi.fn(),bottom=vi.fn(),adapter={update:vi.fn(),resize:vi.fn(),scrollToBottom:bottom,onViewportChange:(listener:typeof publish)=>{publish=listener;listener({atBottom:true,revision:'initial'});return dispose;}};
    const data=taskData([],{terminalRun:{...run,terminalMode:'pty'},onMountTerminal:vi.fn().mockReturnValue(adapter)}),view=api.create(host,data),terminal=host.querySelector('.cv-native-terminal');
    publish({atBottom:false,revision:'initial'});expect(host.querySelector('.cv-unread')?.textContent).toBe('En alta in ↓');publish({atBottom:false,revision:'appended'});expect(host.querySelector('.cv-unread')?.textContent).toBe('Yeni işlemler (1) ↓');view.update(data);publish({atBottom:false,revision:'appended'});expect(host.querySelector('.cv-unread')?.textContent).toBe('Yeni işlemler (1) ↓');expect(bottom).not.toHaveBeenCalled();expect(host.querySelector('.cv-native-terminal')).toBe(terminal);
    (host.querySelector('.cv-unread')as any).click();expect(bottom).toHaveBeenCalledTimes(1);expect(host.querySelector('.cv-unread')?.hasAttribute('hidden')).toBe(true);view.destroy();expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('unwraps recorded functions.exec literals into real commands without evaluating JavaScript', () => {
    const { api, host, window } = fixture();
    const commands = ['Get-Content "D:\\repo\\Türkçe dosya.md"', 'rg --files -g AGENTS.md'];
    const script = `globalThis.transcriptExecuted = true; const values = await Promise.all([${commands.map(command => `tools.exec_command(${JSON.stringify({ cmd: command })})`).join(',')}]); text(values);`;
    const events = [json({ type: 'assistant', message: { id: 'wrapper', content: [{ type: 'tool_use', id: 'wrapper-tool', name: 'functions.exec', input: { input: script } }] } }), json({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'wrapper-tool', content: 'AGENTS.md\nTürkçe dosya.md' }] } }, 21)];
    const node = api.normalize(taskData(events))[0].nodes.find((node: any) => node.kind === 'tool');
    expect(node).toMatchObject({ title: 'Terminal komutları', command: commands.join('\n'), status: 'completed' });
    expect((window as any).transcriptExecuted).toBeUndefined();
    api.create(host, taskData(events));
    expect(host.querySelector('.cv-command')?.textContent).toBe(commands.join('\n'));
    expect(host.querySelector('.cv-tool-preview')?.textContent).not.toContain('"input"');
    expect(host.querySelector('.cv-tool-details')?.hasAttribute('open')).toBe(false);
  });

  it('folds a long streak of tool calls behind one row and keeps the latest three visible', () => {
    const { api, host } = fixture();
    const reads = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({ type: 'tool_use', id: `read-${from + index}`, name: 'Read', input: { file_path: `D:/repo/file-${from + index}.ts` } }));
    const events = [json({ type: 'assistant', message: { id: 'tools', content: [...reads(0, 5), { type: 'tool_use', id: 'grep', name: 'Grep', input: { pattern: 'x' } }, { type: 'text', text: 'Ara mesaj' }, ...reads(10, 4)] } })];
    const view = api.create(host, taskData(events)), visible = () => [...host.querySelectorAll('article.cv-tool:not([hidden]) .cv-tool-preview')].map(node => node.textContent);
    const folds = host.querySelectorAll('.cv-tool-fold'); expect(folds).toHaveLength(1);
    expect(folds[0].textContent).toContain('3 önceki araç çağrısı'); expect(folds[0].textContent).toContain('Dosya okuma ×3');
    expect(visible()).toEqual(['D:/repo/file-3.ts', 'D:/repo/file-4.ts', 'x', 'D:/repo/file-10.ts', 'D:/repo/file-11.ts', 'D:/repo/file-12.ts', 'D:/repo/file-13.ts']);
    expect(folds[0].textContent).toContain('göster'); expect(host.querySelectorAll('.cv-fold-member')).toHaveLength(0);
    (folds[0] as any).click(); expect(visible()).toHaveLength(10); expect(host.querySelector('.cv-tool-fold')?.getAttribute('aria-expanded')).toBe('true'); expect(host.querySelector('.cv-tool-fold')).toBe(folds[0]); expect(folds[0].textContent).toContain('gizle'); expect(host.querySelectorAll('.cv-fold-member')).toHaveLength(3);
    (host.querySelector('.cv-tool-fold') as any).click(); expect(visible()).toHaveLength(7);
    view.update(taskData([...events, json({ type: 'assistant', message: { id: 'more', content: reads(20, 1) } }, 22)]));
    expect(host.querySelectorAll('.cv-tool-fold')).toHaveLength(2); expect(visible().slice(-3)).toEqual(['D:/repo/file-12.ts', 'D:/repo/file-13.ts', 'D:/repo/file-20.ts']);
  });

  it('shows patch file changes and Claude file tools as compact file activities', () => {
    const { api, host } = fixture();
    const patch = '*** Begin Patch\n*** Add File: D:/repo/new.ts\n+export const hello = true;\n*** Update File: D:/repo/main.ts\n@@\n-old\n+new\n*** End Patch';
    const events = [json({ type: 'assistant', message: { id: 'patch', content: [{ type: 'tool_use', id: 'patch-call', name: 'functions.exec', input: { input: `text(await tools.apply_patch(${JSON.stringify(patch)}));` } }, { type: 'tool_use', id: 'read-call', name: 'Read', input: { file_path: 'D:/repo/main.ts' } }] } }), json({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'patch-call', content: 'Success' }] } }, 21)];
    const nodes = api.normalize(taskData(events))[0].nodes;
    expect(nodes.find((node: any) => node.id === 'tool:patch-call')).toMatchObject({ kind: 'files', status: 'completed', files: [{ path: 'D:/repo/new.ts', kind: 'add' }, { path: 'D:/repo/main.ts', kind: 'update' }] });
    expect(nodes.find((node: any) => node.id === 'tool:read-call')).toMatchObject({ title: 'Dosya okuma', command: 'D:/repo/main.ts' });
    api.create(host, taskData(events)); expect(host.querySelector('article.cv-files summary')?.textContent).toContain('new.ts, main.ts');
    expect(host.querySelector('article.cv-files summary')?.textContent).not.toContain('apply_patch');
  });

  it('shows collaboration targets and lifecycle while withholding encrypted coordination payloads even in raw details', () => {
    const { api, host } = fixture(); const encrypted = `gAAAA${'Q'.repeat(140)}`;
    const events = [json({ type: 'assistant', message: { id: 'coord', content: [{ type: 'tool_use', id: 'coord-call', name: 'collaboration.send_message', input: { target: '/root/backend', message: encrypted } }] } }), json({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'coord-call', content: encrypted }] } }, 21)];
    const node = api.normalize(taskData(events))[0].nodes.find((node: any) => node.kind === 'tool');
    expect(node).toMatchObject({ title: 'Agent ile iletişim', command: '/root/backend', status: 'completed', raw: '', output: '' });
    api.create(host, taskData(events)); expect(host.innerHTML).not.toContain(encrypted); expect(host.querySelector('.cv-tool-preview')?.textContent).toBe('/root/backend');
    (host.querySelector('.cv-technical-toggle') as any).click(); expect(host.innerHTML).not.toContain('gAAAA');
    expect(host.querySelector('article.cv-tool .cv-raw')).toBeNull();
  });

  it('uses a readable bounded fallback for dynamic wrappers and redacts encrypted strings in diagnostic tool records', () => {
    const { api, host } = fixture();
    const events = [json({ type: 'assistant', message: { id: 'dynamic', content: [{ type: 'tool_use', id: 'dynamic-call', name: 'functions.exec', input: { input: 'await tools.exec_command({cmd: dynamicCommand}); await tools.mcp__service__lookup({input: payload});' } }, { type: 'tool_use', id: 'other-call', name: 'future_tool', input: { ciphertext: `gAAAA${'Q'.repeat(100)}` } }] } })];
    api.create(host, taskData(events));
    expect(host.querySelector('.cv-tool-preview')?.textContent).toBe('exec_command · service / lookup');
    expect(host.querySelector('.cv-timeline')?.textContent).not.toContain('dynamicCommand');
    expect(host.innerHTML).not.toContain('gAAAA');
  });

  it('bounds long console content to its pane and reserves horizontal scroll for explicit code blocks', () => {
    const { api, host, window } = fixture();
    const css = window.document.createElement('style'); css.textContent = conversationCss; window.document.head.append(css);
    const long = 'deep-directory/'.repeat(300);
    api.create(host, taskData([json({ type: 'item.completed', item: { id: 'long', type: 'command_execution', command: `rg ${long}`, aggregated_output: long, exit_code: 0 } })]));
    const computed = (selector: string) => window.getComputedStyle(host.querySelector(selector)!);
    expect(computed('.cv-scroll').overflowX).toBe('hidden'); expect(Number.parseFloat(computed('.cv-scroll').minWidth)).toBe(0);
    expect(computed('.cv-run-nodes').maxWidth).toBe('100%'); expect(Number.parseFloat(computed('.cv-tool-heading').minWidth)).toBe(0);
    expect(computed('.cv-command').whiteSpace).toBe('pre-wrap'); expect(computed('.cv-command').overflowWrap).toBe('anywhere');
    expect(host.querySelector('.cv-command')?.textContent).toBe(`rg ${long}`);
  });

  it('uses one console factory for history and live views, with explicit read-only continuation', async () => {
    const { api, window, host } = fixture(); const resume = vi.fn().mockResolvedValue(undefined), send = vi.fn().mockResolvedValue(undefined);
    expect((window as any).AIWSAgentConsole).toBe((window as any).AIWSConversation);
    const events = [json({ type: 'thread.started', thread_id: 'same-provider-session' }), json({ type: 'item.completed', item: { id: 'past', type: 'agent_message', text: 'Geçmiş gerçek yanıt.' } }, 21)];
    const data = taskData(events, { instanceId: 'task:task-1', readOnly: true, onContinue: resume, onSendMessage: send, runs: [{ ...run, status: 'history' }] });
    const console = api.create(host, data), element = console.element, oldMessage = host.querySelector('.cv-assistant');
    expect(host.querySelector('[data-agent-console]')).toBe(element); expect(resume).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(host.querySelector('.cv-composer')?.hasAttribute('hidden')).toBe(true); expect(host.querySelector('.cv-history-footer')?.hasAttribute('hidden')).toBe(false);
    (host.querySelector('[data-console-continue]') as any).click(); await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    events.push(json({ type: 'item.completed', item: { id: 'new', type: 'agent_message', text: 'Aynı oturumda yeni gerçek yanıt.' } }, 22));
    console.update({ ...data, readOnly: false, runs: [run], events: [...events, ...events] });
    expect(console.element).toBe(element); expect(host.querySelector('.cv-assistant')).toBe(oldMessage); expect(host.querySelectorAll('.cv-assistant')).toHaveLength(2);
    expect(host.querySelector('.cv-composer')?.hasAttribute('hidden')).toBe(false); expect(host.querySelector('.cv-history-footer')?.hasAttribute('hidden')).toBe(true);
    (host.querySelector('.cv-technical-toggle') as any).click(); expect(element.classList.contains('cv-show-technical')).toBe(true);
    const input = host.querySelector('[name=text]') as any; input.value = 'Yeni talimat'; input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('Yeni talimat'));
  });

  it('mounts the actual PTY once and keeps it alive while inspecting a read-only subagent', async () => {
    const { api, window, host } = fixture(); const adapter = { update: vi.fn(), resize: vi.fn(), destroy: vi.fn() }, send = vi.fn(), resume = vi.fn();
    const mount = vi.fn((_run: unknown, terminalHost: any) => { const actual = window.document.createElement('div'); actual.textContent = 'real terminal adapter'; actual.dataset.actualTerminal = 'true'; terminalHost.append(actual); return adapter; });
    const tree = { rootId: 'codex:root', agents: [{ id: 'codex:root', parentId: null, provider: 'codex', name: 'Ana agent', status: 'running' }, { id: 'codex:child', parentId: 'codex:root', provider: 'codex', name: 'Frontend', status: 'running' }] };
    const childData = { runs: [{ ...run, id: 'child-view', status: 'history', terminalMode: 'stream' }], events: [{ ...json({ type: 'item.completed', item: { id: 'child-message', type: 'agent_message', text: 'Gerçek alt agent yanıtı.' } }), runId: 'child-view' }] };
    const data = taskData([], { instanceId: 'task:task-1', agentTree: tree, terminalRun: { ...run, terminalMode: 'pty' }, onMountTerminal: mount, onSendMessage: send, onContinue: resume, onSelectAgent: vi.fn().mockResolvedValue(childData), questions: [{ id: 'pty-question', taskId: 'task-1', runId: 'run-1', text: 'Hangi sunucu?', status: 'pending', createdAt: run.startedAt }], onAnswerQuestion: vi.fn() });
    const view = api.create(host, data), terminalHost = host.querySelector('.cv-terminal-host'), terminal = host.querySelector('[data-actual-terminal]');
    view.update(data); expect(mount).toHaveBeenCalledTimes(1); expect(host.querySelector('.cv-composer')?.hasAttribute('hidden')).toBe(true);
    expect(host.querySelector('[data-cv-action=question]')?.textContent).toContain('Agent soru sordu'); (host.querySelector('[data-cv-action=question]') as any).click(); expect(host.querySelector('.cv-scroll')?.hasAttribute('hidden')).toBe(true); expect(host.querySelector('.cv-question-dock')?.hasAttribute('hidden')).toBe(false); expect(window.document.activeElement).toBe(host.querySelector('.cv-question-dock textarea')); (host.querySelector('[data-cv-action=mode-terminal]') as any).click();
    (host.querySelector('[data-agent="codex:child"]') as any).click();
    await vi.waitFor(() => expect(host.querySelector('.cv-markdown')?.textContent).toBe('Gerçek alt agent yanıtı.'));
    expect(host.querySelector('.cv-native-terminal')?.hasAttribute('hidden')).toBe(true); expect(host.querySelector('.cv-terminal-host')).toBe(terminalHost); expect(host.querySelector('[data-actual-terminal]')).toBe(terminal);
    expect(host.querySelector('.cv-composer')?.hasAttribute('hidden')).toBe(true); (host.querySelector('[data-console-continue]') as any).click(); expect(resume).not.toHaveBeenCalled();
    (host.querySelector('[data-agent="codex:root"]') as any).click(); expect(host.querySelector('.cv-native-terminal')?.hasAttribute('hidden')).toBe(false); expect(mount).toHaveBeenCalledTimes(1); expect(adapter.destroy).not.toHaveBeenCalled();
    (host.querySelector('[data-cv-action=mode-history]') as any).click(); (host.querySelector('[data-cv-action=mode-terminal]') as any).click(); expect(mount).toHaveBeenCalledTimes(1);
    view.destroy(); expect(adapter.destroy).toHaveBeenCalledTimes(1);
  });

  it('leaves a CLI dialog to the terminal showing it and keeps its card elsewhere', () => {
    const { api, host } = fixture(), adapter = { update: vi.fn(), resize: vi.fn(), destroy: vi.fn() };
    const dialog = { id: 'native', taskId: 'task-1', runId: 'run-1', kind: 'approval', source: 'terminal', status: 'pending', text: 'Do you want to proceed?', createdAt: run.startedAt, answer: null };
    const data = taskData([], { terminalRun: { ...run, terminalMode: 'pty' }, onMountTerminal: () => adapter, questions: [dialog], onAnswerQuestion: vi.fn() });
    const view = api.create(host, data), dock = () => host.querySelector('.cv-question-dock')!, button = (action: string) => host.querySelector(`[data-cv-action=${action}]`) as any;
    expect(dock().hasAttribute('hidden')).toBe(true); expect(dock().children).toHaveLength(0); expect(button('question')).toBeNull();
    // In the chat view the card leads back to the terminal, and following it clears the card again.
    button('mode-history').click();
    expect(dock().hasAttribute('hidden')).toBe(false); expect(dock().textContent).toContain('Do you want to proceed?');
    (dock().querySelector('[data-cv-action=mode-terminal]') as any).click();
    expect(dock().hasAttribute('hidden')).toBe(true); expect(dock().children).toHaveLength(0);
    // A request only AIWS can take stays answerable, and a dialog of another run is not on this screen.
    view.update({ ...data, questions: [dialog, { ...dialog, id: 'asked', source: undefined, kind: 'question', text: 'Hangi sunucu?' }, { ...dialog, id: 'older', runId: 'run-0', text: 'Older dialog' }] });
    expect([...dock().children].map((box: any) => box.dataset.questionId)).toEqual(['asked', 'older']); expect(button('question').textContent).toContain('(2)');
    view.destroy();
  });

  it('delegates an offcanvas subagent click without replacing or hiding the native parent terminal', () => {
    const { api, host, window }=fixture(),open=vi.fn(),adapter={update:vi.fn(),resize:vi.fn(),destroy:vi.fn()};
    const mount=vi.fn((_run: unknown,terminalHost: any)=>{const terminal=window.document.createElement('div');terminal.dataset.ptyProbe='true';terminalHost.append(terminal);return adapter;});
    const agentTree={rootId:'codex:root',agents:[{id:'codex:root',parentId:null,name:'Root',provider:'codex',status:'running'},{id:'codex:child',parentId:'codex:root',name:'Child',provider:'codex',status:'running'}]};
    const data=taskData([],{agentTree,terminalRun:{...run,terminalMode:'pty'},onMountTerminal:mount,onOpenAgent:open}),view=api.create(host,data),terminal=host.querySelector('[data-pty-probe]');
    const child=host.querySelector('[data-agent="codex:child"]') as any;child.click();expect(open).toHaveBeenCalledWith(expect.objectContaining({id:'codex:child'}),child);
    view.update({...data,inspectedAgentId:'codex:child'});expect(host.querySelector('.cv-native-terminal')?.hasAttribute('hidden')).toBe(false);expect(host.querySelector('[data-pty-probe]')).toBe(terminal);expect(mount).toHaveBeenCalledTimes(1);expect(adapter.destroy).not.toHaveBeenCalled();expect(child.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows each subagent card its model and its latest tool call, newest of transcript and stream', () => {
    const { api, host } = fixture('en'), open = vi.fn();
    const agentTree = { rootId: 'claude:session:root', agents: [
      { id: 'claude:session:root', parentId: null, provider: 'claude', name: 'Root', status: 'running' },
      { id: 'claude:agent:a', parentId: 'claude:session:root', provider: 'claude', name: 'Auth flow', role: 'Explore', model: 'claude-haiku-5-5', status: 'running', aliases: ['claude:tool:t1'], activity: { tool: 'Grep', input: { pattern: 'IdentityConst' }, at: '2026-10-16T12:23:10Z' } },
      { id: 'claude:agent:b', parentId: 'claude:session:root', provider: 'claude', name: 'Permissions', status: 'completed', activity: { tool: 'Read', input: { file_path: 'C:\\repo\\PermissionPolicy.cs' }, at: '2026-10-16T12:23:10Z' } },
    ] };
    const streamed = json({ type: 'assistant', parent_tool_use_id: 't1', message: { id: 'm1', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'src/AuthenticationService.cs' } }] } }, 30);
    api.create(host, taskData([streamed], { runs: [{ ...run, provider: 'claude' }], agentTree, onOpenAgent: open }));
    const first = host.querySelector('[data-agent="claude:agent:a"]') as any, second = host.querySelector('[data-agent="claude:agent:b"]') as any;
    expect(first.querySelector('.cv-agent-name small').textContent).toBe('Explore · claude-haiku-5-5');
    expect(first.querySelector('.cv-agent-activity code').textContent).toBe('AuthenticationService.cs');
    expect(first.querySelector('.cv-agent-activity .ui-spinner')).not.toBeNull();
    expect(second.querySelector('.cv-agent-activity').textContent).toContain('PermissionPolicy.cs'); expect(second.querySelector('.cv-agent-activity .ui-spinner')).toBeNull();
    expect(host.querySelector('[data-agent="claude:session:root"] .cv-agent-activity')).toBeNull();
    first.querySelector('.cv-agent-activity').click(); expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'claude:agent:a' }), first);
  });

  it('shows a subagent launch as the agent it started and keeps the hierarchy in its own panel', () => {
    const { api, host, window } = fixture('en'), open = vi.fn(), openTree = vi.fn();
    const agentTree = { rootId: 'claude:session:root', agents: [
      { id: 'claude:session:root', parentId: null, provider: 'claude', name: 'Root', status: 'running' },
      { id: 'claude:agent:a', parentId: 'claude:session:root', provider: 'claude', name: 'Agent A', role: 'general-purpose', model: 'claude-haiku-5-5', status: 'completed', aliases: ['claude:tool:t1'], activity: { tool: 'Bash', input: { command: 'echo hello' }, at: '2026-10-16T12:23:10Z' } },
    ] };
    const launch = json({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Agent A', prompt: 'do it' } }] } }, 25);
    const data = taskData([launch], { runs: [{ ...run, provider: 'claude' }], agentTree, onOpenAgent: open, onOpenAgents: openTree });
    api.create(host, data);
    const block = host.querySelector('.cv-timeline .cv-subagent') as any;
    expect([...block.querySelectorAll('.cv-subagent-head>span:not(.cv-tool-icon):not(.cv-subagent-sep)')].map((part: any) => part.textContent)).toEqual(['Agent A', 'general-purpose', 'claude-haiku-5-5']);
    expect(block.querySelector('.cv-agent-activity code').textContent).toBe('echo hello');
    block.click(); expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'claude:agent:a' }), block);
    const panel = host.querySelector('.cv-agent-panel') as any, opener = panel.querySelector('.cv-agent-open') as any;
    expect(panel.classList.contains('cv-agent-compact')).toBe(true); expect(opener.hidden).toBe(false);
    opener.click(); expect(openTree).toHaveBeenCalledWith(opener);
  });

  it('opens a Workflow launch like a subagent and draws its steps and agents on the hierarchy canvas', () => {
    const { api, host, window } = fixture('en'), open = vi.fn(), flowApi = (window as any).AIWSConversation;
    const workflow = { id: 'claude:workflow:wf_1', parentId: 'root', kind: 'workflow', provider: 'claude', name: 'build', description: 'Builds it', status: 'running', aliases: ['claude:tool:t1'], phases: [{ title: 'Temel', detail: 'First' }, { title: 'Son' }, { title: 'Bekleyen' }] };
    const member = (id: string, phase: string, status: string) => ({ id, parentId: workflow.id, provider: 'claude', name: id, role: phase, phase, status, transcriptAvailable: true });
    const agentTree = { rootId: 'root', agents: [{ id: 'root', parentId: null, provider: 'claude', name: 'Root', status: 'running' }, workflow, member('a1', 'Temel', 'completed'), member('a2', 'Son', 'running')] };
    const launch = json({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Workflow', input: { script: 'SCRIPT_BODY' } }] } }, 25);
    api.create(host, taskData([launch], { runs: [{ ...run, provider: 'claude' }], agentTree, onOpenAgent: open }));
    const block = host.querySelector('.cv-timeline .cv-subagent') as any;
    expect(block.querySelector('.cv-subagent-name').textContent).toBe('build'); expect(block.textContent).toContain('Workflow · 1/2 agent'); expect(block.textContent).toContain('Current step: Son'); expect(host.textContent).not.toContain('SCRIPT_BODY');
    block.click(); expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: workflow.id, kind: 'workflow' }), block);
    const canvas = (window as any).document.createElement('div'); host.append(canvas);
    flowApi.agentFlow(canvas, { agentTree: flowApi.workflowTree(flowApi.inferAgentTree({ agentTree }), workflow.id), onOpenAgent: open });
    expect([...canvas.querySelectorAll('.cv-flow-node')].map((node: any) => node.dataset.agentNode)).toEqual([workflow.id, `${workflow.id}:phase:0`, 'a1', `${workflow.id}:phase:1`, 'a2', `${workflow.id}:phase:2`]);
    expect(canvas.querySelector('.cv-agent-count')?.textContent).toBe('2 subagents'); expect(canvas.querySelector(`[data-agent-node="${workflow.id}:phase:0"] .cv-flow-card`).tagName).toBe('DIV');
    expect(canvas.querySelector(`[data-agent-node="${workflow.id}:phase:1"] .cv-flow-card`).dataset.status).toBe('running'); expect(canvas.querySelector(`[data-agent-node="${workflow.id}:phase:2"] .cv-flow-card`).dataset.status).toBe('pending');
    const agent = canvas.querySelector('button[data-agent="a2"]'); agent.click(); expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a2' }), agent);
  });

  it('lays the agent hierarchy out as a left-to-right tree of cards, each saying what the agent is doing, with foldable subtrees', () => {
    const { host, window } = fixture('en'), open = vi.fn(), flowApi = (window as any).AIWSConversation;
    const agent = (id: string, parentId: string | null, extra = {}) => ({ id, parentId, provider: 'claude', name: id.toUpperCase(), status: 'completed', ...extra });
    const agentTree = { rootId: 'root', agents: [agent('root', null, { name: 'Claude Code', status: 'running' }), agent('a', 'root', { role: 'Explore', model: 'claude-haiku-5-5', activity: { tool: 'Read', input: { file_path: 'src/Auth.cs' } } }), agent('b', 'root', { status: 'running' }), agent('a1', 'a', { activity: { tool: 'Bash', input: { command: 'npm test' } } })] };
    const flow = flowApi.agentFlow(host, { agentTree, onOpenAgent: open });
    const nodes = [...host.querySelectorAll('.cv-flow-node')] as any[];
    expect(nodes.map(node => node.dataset.agentNode)).toEqual(['root', 'a', 'a1', 'b']);
    // The root's children stand in a column to its right and a deeper agent one column further (fallback 272×120 cards).
    expect(nodes.map(node => [node.style.left, node.style.top])).toEqual([['0px', '67px'], ['320px', '0px'], ['640px', '0px'], ['320px', '134px']]);
    expect(host.querySelectorAll('.flow-link')).toHaveLength(3); expect(host.querySelector('.cv-agent-count')?.textContent).toBe('3 subagents'); expect(host.querySelector('.cv-agent-running')?.textContent).toBe('1 running');
    expect(host.querySelector('[data-agent-node=root] .cv-flow-card')?.tagName).toBe('DIV'); expect(host.querySelector('[data-agent-node=root]')?.textContent).toContain('2 subagent');
    const a = host.querySelector('button[data-agent="a"]') as any;
    expect(a.querySelector('.cv-agent-name small').textContent).toBe('Explore · claude-haiku-5-5'); expect(a.querySelector('.cv-agent-activity code').textContent).toBe('Auth.cs'); expect(host.querySelector('[data-agent-node=a] .cv-flow-toggle')?.textContent).toBe('1');
    expect(host.querySelector('button[data-agent="a1"] .cv-agent-activity code')?.textContent).toBe('npm test');
    a.click(); expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), a);
    (host.querySelector('[data-agent-node=a] .cv-flow-toggle') as any).click();
    expect(host.querySelector('[data-agent-node=a1]:not(.is-leaving)')).toBeNull(); expect(host.querySelector('[data-agent-node=a] .cv-flow-toggle')?.textContent).toBe('+1');
    (host.querySelector('[data-agent-node=a] .cv-flow-toggle') as any).click(); expect(host.querySelector('[data-agent-node=a1]:not(.is-leaving)')).not.toBeNull();
    flow.update({ agentTree: { ...agentTree, agents: agentTree.agents.filter(item => item.id !== 'b') }, onOpenAgent: open });
    expect([...host.querySelectorAll('.cv-flow-node:not(.is-leaving)')].map((node: any) => node.dataset.agentNode)).toEqual(['root', 'a', 'a1']);
    flow.destroy(); expect(host.querySelector('.cv-agent-flow')).toBeNull();
  });

  it('labels pending/stopped children and distinguishes an unverified immediate parent', () => {
    const { api, host } = fixture();
    const tree = { rootId: 'claude:root', agents: [
      { id: 'claude:root', parentId: null, provider: 'claude', name: 'Ana agent', status: 'running' },
      { id: 'claude:pending', parentId: 'claude:root', parentKnown: false, provider: 'claude', name: 'Bekleyen', status: 'pending' },
      { id: 'claude:stopped', parentId: 'claude:root', parentKnown: true, provider: 'claude', name: 'Durmuş', status: 'stopped' },
      { id: 'claude:nested', parentId: 'claude:pending', parentKnown: true, provider: 'claude', name: 'İç agent', status: 'running' },
    ] };
    api.create(host, taskData([], { agentTree: tree }));
    const pending = host.querySelector('[data-agent="claude:pending"]');
    expect(pending?.getAttribute('data-parent-known')).toBe('false');
    expect(pending?.textContent).toContain('Üst agent doğrulanamadı');
    expect(pending?.querySelector('.cv-agent-branch')?.textContent).toBe('?');
    expect(pending?.textContent).toContain('Başlamayı bekliyor');
    const stopped = host.querySelector('[data-agent="claude:stopped"]');
    expect(stopped?.closest('.cv-finished-agents')).not.toBeNull();
    expect(stopped?.textContent).toContain('Durduruldu');
    expect(host.querySelector('[data-agent="claude:nested"]')?.getAttribute('style')).toContain('--agent-depth: 2');
  });

  it('shows five real Codex subagents, nested children, lifecycle changes and their own output', async () => {
    const { api, host } = fixture();
    const events = [json({ type: 'thread.started', thread_id: 'root-thread' }, 19)];
    for (let index = 0; index < 5; index++) events.push(json({ type: 'item.completed', item: { id: `spawn-${index}`, type: 'collab_tool_call', tool: 'spawn_agent', sender_thread_id: 'root-thread', receiver_thread_ids: [`child-${index}`], agents_states: { [`child-${index}`]: { status: 'running', message: null } }, status: 'completed' } }, 20 + index));
    const data = taskData(events, { onSendMessage: vi.fn() }), view = api.create(host, data);
    expect(api.inferAgentTree(data).agents).toHaveLength(6); expect(host.querySelectorAll('.cv-agent-row')).toHaveLength(6);
    events.push(json({ type: 'item.completed', item: { id: 'wait', type: 'collab_tool_call', tool: 'wait', sender_thread_id: 'root-thread', receiver_thread_ids: ['child-0', 'child-1'], agents_states: { 'child-0': { status: 'completed', message: 'Child zero gerçek sonucu.' }, 'child-1': { status: 'errored', message: 'Child one gerçek hatası.' } }, status: 'completed' } }, 27));
    events.push(json({ type: 'item.completed', item: { id: 'nested', type: 'collab_tool_call', tool: 'spawn_agent', sender_thread_id: 'child-2', receiver_thread_ids: ['nested-child'], agents_states: { 'nested-child': { status: 'running', message: null } }, status: 'completed' } }, 28));
    view.update({ ...data, events: [...events, ...events] });
    const tree = api.inferAgentTree(data); expect(tree.agents).toHaveLength(7); expect(tree.agents.find((agent: any) => agent.id === 'codex:nested-child').parentId).toBe('codex:child-2');
    expect(host.querySelector('.cv-finished-agents summary')?.textContent).toBe('Biten alt agentlar (2)'); expect([...host.querySelectorAll('.cv-assistant .cv-markdown')].map(element => element.textContent)).not.toContain('Child zero gerçek sonucu.');
    (host.querySelector('[data-agent="codex:child-0"]') as any).click(); expect(host.querySelector('.cv-markdown')?.textContent).toBe('Child zero gerçek sonucu.');
    expect(host.querySelector('[data-agent="codex:child-0"]')?.getAttribute('aria-pressed')).toBe('true');
    view.update({ ...data, events: [...events, ...events] }); expect(host.querySelector('[data-agent="codex:child-0"]')?.getAttribute('aria-pressed')).toBe('true'); expect(host.querySelectorAll('.cv-assistant')).toHaveLength(1);
    expect(host.querySelector('.cv-composer')?.hasAttribute('hidden')).toBe(true);
  });

  it('resolves Claude Task/Agent aliases and SDK task lifecycle without counting Bash as an agent', () => {
    const { api, host } = fixture();
    const events = [json({ type: 'system', subtype: 'init', session_id: 'claude-root' }, 19)];
    for (let index = 0; index < 5; index++) {
      events.push(json({ type: 'assistant', message: { id: `a-${index}`, content: [{ type: 'tool_use', id: `tool-${index}`, name: index % 2 ? 'Task' : 'Agent', input: { description: `Agent ${index}`, subagent_type: 'frontend', prompt: `Gerçek iş ${index}` } }] } }, 20 + index));
      events.push(json({ type: 'system', subtype: 'task_started', task_id: `agent-${index}`, run_id: 'run-002', tool_use_id: `tool-${index}`, task_type: 'local_agent', description: `Agent ${index}`, session_id: 'claude-root' }, 25 + index));
    }
    events.push(json({ type: 'system', subtype: 'task_started', task_id: 'bash-task', task_type: 'local_bash', description: 'npm test', session_id: 'claude-root' }, 31));
    events.push(json({ type: 'assistant', parent_tool_use_id: 'tool-0', agent_id: 'agent-0', message: { id: 'child-a', content: [{ type: 'text', text: 'Yalnız agent zero çıktısı.' }] } }, 32));
    events.push(json({ type: 'system', subtype: 'task_progress', task_id: 'agent-0', run_id: 'run-002', tool_use_id: 'resumed-tool', summary: 'Gerçek ilerleme özeti.', usage: { duration_ms: 2000 }, session_id: 'claude-root' }, 33));
    events.push(json({ type: 'system', subtype: 'task_notification', task_id: 'agent-0', run_id: 'run-001', tool_use_id: 'tool-0', status: 'completed', summary: 'Eski tur sonucu.', session_id: 'claude-root' }, 34));
    const data = taskData(events, { runs: [{ ...run, provider: 'claude' }] }), tree = api.inferAgentTree(data);
    expect(tree.agents).toHaveLength(6); const agent = tree.agents.find((agent: any) => agent.aliases?.includes('claude:agent:agent-0'));
    expect(agent.status).toBe('running'); expect(agent.aliases).toContain('claude:tool:resumed-tool');
    api.create(host, data); (host.querySelector(`[data-agent="${agent.id}"]`) as any).click();
    expect(host.querySelector('.cv-timeline')?.textContent).toContain('Yalnız agent zero çıktısı.'); expect(host.querySelector('.cv-timeline')?.textContent).not.toContain('Eski tur sonucu.');
    expect(host.querySelector('.cv-agent-count')?.textContent).toContain('5 alt agent');
  });

  it('keeps console instance IDs unique and merges canonical child IDs without duplicating placeholders', () => {
    const { api, host, window } = fixture(); const second = window.document.createElement('div'); window.document.body.append(second);
    const events = [json({ type: 'system', subtype: 'init', session_id: 'claude-root' }), json({ type: 'assistant', message: { id: 'parent', content: [{ type: 'tool_use', id: 'tool', name: 'Agent', input: { description: 'Frontend' } }] } }, 21)];
    const data = taskData(events, { instanceId: 'tile:run-1', runs: [{ ...run, provider: 'claude' }] }), view = api.create(host, data); api.create(second, { ...data, instanceId: 'task:task-1' });
    const ids = [...window.document.querySelectorAll('[id]')].map(element => element.id); expect(new Set(ids).size).toBe(ids.length);
    (host.querySelector('[data-agent="claude:tool:tool"]') as any).click();
    const tree = { rootId: 'claude:session:claude-root', agents: [{ id: 'claude:session:claude-root', parentId: null, provider: 'claude', name: 'Ana agent', status: 'running' }, { id: 'claude:agent:real-id', parentId: 'claude:session:claude-root', aliases: ['claude:tool:tool'], provider: 'claude', name: 'Frontend', status: 'running' }] };
    view.update({ ...data, agentTree: tree }); expect(host.querySelectorAll('.cv-agent-row')).toHaveLength(2); expect(host.querySelector('[data-agent="claude:agent:real-id"]')?.getAttribute('aria-pressed')).toBe('true');
    const unknownAliasTree = { ...tree, agents: tree.agents.map(agent => ({ ...agent, aliases: [] })) };
    expect(api.inferAgentTree({ ...data, agentTree: unknownAliasTree }).agents).toHaveLength(2);
    expect(() => api.normalize(taskData([json({ type: 'assistant', message: { content: 'future shape' } }), json({ type: 'item.completed', item: { type: 'file_change', changes: { future: true } } }), json({ type: 'item.completed', item: { type: 'agent_message', text: { future: true } } })]))).not.toThrow();
  });
  it('turns the supplied Codex stream into messages, updated tools and file changes without raw JSON cards', () => {
    const { api, host } = fixture();
    const command = '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Get-Content readme.md"';
    const events = [
      event('Starting codex in native mode.', 'started', 18),
      json({ type: 'thread.started', thread_id: 'codex-thread' }, 19), json({ type: 'turn.started' }, 19),
      json({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '**Depoyu** inceleyip dosyayı oluşturacağım.' } }, 25),
      event(`${JSON.stringify({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command, aggregated_output: '', exit_code: null, status: 'in_progress' } })}\n${JSON.stringify({ type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: 'rg --files', status: 'in_progress' } })}\n`, 'stdout', 27),
      json({ type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: 'rg --files', aggregated_output: 'readme.md', exit_code: 0, status: 'completed' } }, 28),
      json({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command, aggregated_output: 'hello world', exit_code: 0, status: 'completed' } }, 30),
      json({ type: 'item.started', item: { id: 'item_4', type: 'file_change', changes: [{ path: 'C:\\repo\\helloworld.md', kind: 'add' }], status: 'in_progress' } }, 47),
      json({ type: 'item.completed', item: { id: 'item_4', type: 'file_change', changes: [{ path: 'C:\\repo\\helloworld.md', kind: 'add' }], status: 'completed' } }, 48),
      json({ type: 'item.completed', item: { id: 'item_7', type: 'agent_message', text: '[helloworld.md](C:/repo/helloworld.md) oluşturuldu.\n\nTüm kontroller başarılı.' } }, 57),
      json({ type: 'turn.completed', usage: { input_tokens: 90568, cached_input_tokens: 84224, output_tokens: 1007 } }, 57),
    ];
    const normalized = api.normalize(taskData(events));
    expect(normalized[0].sessionId).toBe('codex-thread');
    const tools = normalized[0].nodes.filter((node: any) => node.kind === 'tool');
    expect(tools).toHaveLength(2); expect(tools[0]).toMatchObject({ title: 'Dosya okuma', status: 'completed', output: 'hello world', exitCode: 0 });
    expect(normalized[0].nodes.filter((node: any) => node.kind === 'files')).toHaveLength(1);
    api.create(host, taskData(events));
    expect(host.querySelectorAll('.cv-tool')).toHaveLength(2); expect(host.querySelectorAll('article.cv-files')).toHaveLength(1);
    expect(host.querySelectorAll('.cv-unknown')).toHaveLength(0); expect(host.querySelectorAll('.cv-assistant')).toHaveLength(2);
    expect(host.querySelector('.cv-markdown strong')?.textContent).toBe('Depoyu');
    expect(host.querySelector('.cv-tool-details')?.hasAttribute('open')).toBe(false);
    expect(host.querySelector('.cv-tool-footer')?.textContent).toContain('3.0 sn');
    expect(host.querySelector('.cv-run-footer')?.textContent).toContain('90.568');
    expect(host.querySelector('.cv-file-reference')?.getAttribute('title')).toBe('C:/repo/helloworld.md');
    expect(host.querySelector('.cv-file-reference')?.hasAttribute('href')).toBe(false);
  });

  it('supports partial and multi-line NDJSON, repeated snapshots and subsequent turns', () => {
    const { api } = fixture();
    const object = JSON.stringify({ type: 'item.completed', item: { id: 'one', type: 'agent_message', text: 'Chunk sınırı çalışıyor.' } });
    const first = event(object.slice(0, 36), 'stdout', 20), last = event(object.slice(36), 'stdout', 21);
    expect(api.normalize(taskData([first]))[0].nodes).toHaveLength(0);
    const events = [json({ type: 'turn.started' }, 19), first, last, json({ type: 'turn.completed' }, 22), json({ type: 'turn.started' }, 24), json({ type: 'item.completed', item: { id: 'one', type: 'agent_message', text: 'İkinci tur.' } }, 25)];
    const repeated = events.map(item => ({ ...item, id: `${item.id}-replayed` }));
    const nodes = api.normalize(taskData([...events, ...events, ...repeated]))[0].nodes;
    expect(nodes.filter((node: any) => node.kind === 'assistant').map((node: any) => node.text)).toEqual(['Chunk sınırı çalışıyor.', 'İkinci tur.']);
    expect(nodes.filter((node: any) => node.kind === 'turn')).toHaveLength(2);
  });

  it('handles Claude text, tool results, final deduplication and failures', () => {
    const { api } = fixture();
    const events = [
      json({ type: 'system', session_id: 'claude-session', model: 'fixture-model' }),
      json({ type: 'assistant', message: { id: 'a1', content: [{ type: 'text', text: 'Testleri çalıştırıyorum.' }, { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } }] } }, 21),
      json({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: [{ type: 'text', text: 'Assertion failed' }] }] } }, 23),
      json({ type: 'assistant', message: { id: 'a2', content: [{ type: 'thinking', thinking: 'PRIVATE' }, { type: 'text', text: 'Bir test başarısız.' }] } }, 24),
      json({ type: 'result', is_error: false, result: 'Bir test başarısız.', usage: { input_tokens: 200, output_tokens: 20 } }, 25),
    ];
    const group = api.normalize(taskData(events, { runs: [{ ...run, provider: 'claude' }] }))[0];
    expect(group.model).toBe('fixture-model'); expect(group.sessionId).toBe('claude-session');
    expect(group.nodes.filter((node: any) => node.kind === 'tool')).toEqual([expect.objectContaining({ command: 'npm test', title: 'Testleri çalıştırma', status: 'failed', output: 'Assertion failed' })]);
    expect(group.nodes.filter((node: any) => node.kind === 'assistant')).toHaveLength(2);
    expect(group.nodes.some((node: any) => node.text?.includes('PRIVATE'))).toBe(false);
  });

  it('preserves malformed/plain output, unknown schemas and known OpenCode errors safely', () => {
    const { api, host } = fixture();
    const events = [event('plain output\n{not-json}\n'), json({ type: 'future.provider.event', data: { hello: 'world' } }, 21), json({ type: 'text', part: { id: 'part-1', text: 'OpenCode yanıtı' } }, 22), json({ type: 'error', error: { name: 'UnknownError', data: { message: 'Token refresh failed: 401' } } }, 23), event('stderr <script>alert(1)</script>', 'stderr', 24)];
    const normalized = api.normalize(taskData(events))[0];
    expect(normalized.nodes.filter((node: any) => node.kind === 'unknown')).toHaveLength(1);
    expect(normalized.nodes.filter((node: any) => node.kind === 'error').map((node: any) => node.text)).toContain('Token refresh failed: 401');
    api.create(host, taskData(events)); expect(host.querySelector('script')).toBeNull(); expect(host.textContent).toContain('{not-json}');
    expect(host.querySelector('.cv-unknown details')?.hasAttribute('open')).toBe(false);
    expect(() => api.normalize(taskData([event('{"unfinished":', 'stdout')], { runs: [{ ...run, status: 'completed' }] }))).not.toThrow();
  });

  it('renders safe markdown, blocks active/file URLs, and escapes code and raw HTML', () => {
    const { api, host } = fixture();
    host.innerHTML = api.markdown('<img src=x onerror=alert(1)>\n\n[bad](javascript:alert) [disk](file:///secret) [link](https://example.com/path)\n\n```html\n<script>alert(1)</script>\n```\n\n**bold** and `code`');
    expect(host.querySelectorAll('img,script')).toHaveLength(0); expect(host.querySelectorAll('a')).toHaveLength(1);
    expect(host.querySelector('a')?.href).toBe('https://example.com/path'); expect(host.querySelector('a')?.rel).toContain('noopener');
    expect(host.querySelector('.cv-code')?.textContent).toContain('<script>'); expect(host.querySelector('strong')?.textContent).toBe('bold');
  });

  it('turns AIWS run prompt paths into prompt viewer buttons', () => {
    const { api, host } = fixture();
    const native = String.raw`C:\Users\me\.aiws\control\runs\run_abc-1\input\prompt.md`;
    host.innerHTML = api.markdown(`Read and follow the task instructions in ${native}. When finished, run aiws control complete --run run_abc-1\n\nRead and follow the task instructions in /run/aiws/input/prompt.md. run aiws control complete --run run_docker\n\nSee /tmp/other/prompt.md and /home/x/runs/run_"x"/input/prompt.md`);
    const buttons = [...host.querySelectorAll('button[data-run-prompt]')];
    expect(buttons.map(button => button.getAttribute('data-run-prompt'))).toEqual(['run_abc-1', 'run_docker']);
    expect(buttons[0]?.textContent).toBe(native);
    expect(buttons[1]?.textContent).toBe('/run/aiws/input/prompt.md'); expect(host.textContent).toContain('/tmp/other/prompt.md');
    expect(host.querySelector('p')?.textContent).toContain('prompt.md. When finished');
  });

  it('shows the native bootstrap message as a system prompt linking only the prompt file', () => {
    const { api, host } = fixture();
    const native = String.raw`C:\Users\me\My Files\.aiws\control\runs\run_abc-1\input\prompt.md`;
    const text = `Read and follow the task instructions in ${native}. Perform the work in the current project. When finished, run aiws control complete --run run_abc-1 --summary Completed. If unsuccessful add --failed. This is a real interactive terminal.`;
    api.create(host, taskData([], { messages: [{ id: 'message-1', taskId: 'task-1', runId: 'run-1', authorType: 'user', authorName: 'Bootstrap Author', text, createdAt: '2026-10-16T12:23:21Z' }] }));
    expect(host.querySelector('.cv-message-role')?.textContent).toBe('Sistem'); expect(host.querySelector('.cv-user')).toBeNull();
    const button = host.querySelector('button[data-run-prompt]');
    expect(button?.getAttribute('data-run-prompt')).toBe('run_abc-1'); expect(button?.textContent).toBe(native);
    expect(host.textContent).toContain('Görev talimatı'); expect(host.textContent).not.toContain('Perform the work'); expect(host.textContent).not.toContain('Bootstrap Author');
  });

  it('splits the continuation notice off a user message into its own system message', () => {
    const { api } = fixture();
    const text = 'Sorun ne peki incelesene bir\n\n[AIWS] Continuation of the same session. The current run is run_x.';
    const nodes = api.normalize(taskData([], { messages: [{ id: 'm1', taskId: 'task-1', runId: 'run-1', authorType: 'user', authorName: 'You', text, createdAt: '2026-10-16T12:23:24Z' }] }))[0].nodes;
    expect(nodes.map((node: any) => [node.kind, node.text.slice(0, 12)])).toEqual([['user', 'Sorun ne pek'], ['prompt', '[AIWS] Conti']]);
  });

  it('shows prompts AIWS wrote for the agent as system messages and the user own words as bubbles', () => {
    const { api, host } = fixture();
    const merge = `Finish the requested merge. Work only in the existing task branch aiws/x.\n${'Resolve every conflict carefully.\n'.repeat(20)}`;
    const github = 'Request from @octo on GitHub issue #4 (https://github.com/o/r/issues/4):\nStatus?';
    const nodes = api.normalize(taskData([event('Auto-merging app.js\nCONFLICT (content): Merge conflict in app.js', 'worktree.merge.error', 21), event(merge, 'worktree.merge.recovery', 22), event('Recorded claude session abc.', 'session', 23)], { messages: [
      { id: 'm-user', taskId: 'task-1', runId: 'run-1', authorType: 'user', authorName: 'You', text: 'ne oldu sorun ne?', createdAt: '2026-10-16T12:23:24Z' },
      { id: 'm-github', taskId: 'task-1', runId: 'run-1', authorType: 'user', authorName: 'You', text: github, createdAt: '2026-10-16T12:23:25Z' },
    ] }))[0].nodes;
    expect(nodes.map((node: any) => [node.kind, node.title])).toEqual([['error', 'Birleştirme hatası'], ['prompt', 'Birleştirme talimatı'], ['lifecycle', undefined], ['user', undefined], ['prompt', 'GitHub isteği']]);
    api.create(host, taskData([event(merge, 'worktree.merge.recovery', 22)], { messages: [{ id: 'm-user', taskId: 'task-1', runId: 'run-1', authorType: 'user', authorName: 'You', text: 'ne oldu sorun ne?', createdAt: '2026-10-16T12:23:24Z' }] }));
    expect(host.querySelector('.cv-user .cv-bubble')?.textContent).toContain('ne oldu sorun ne?'); expect(host.querySelector('.cv-user')?.textContent).not.toContain('User');
    const card = host.querySelector('.cv-prompt .cv-system-card')!;
    expect(card.querySelector('.cv-message-role')?.textContent).toBe('Sistem'); expect(card.querySelector('strong')?.textContent).toBe('Birleştirme talimatı');
    const body = card.querySelector('.cv-collapsible') as any, toggle = card.querySelector('[data-cv-action=expand]') as any;
    expect(body.getAttribute('data-collapsed')).toBe('true'); expect(toggle.getAttribute('aria-expanded')).toBe('false');
    body.click(); expect(body.getAttribute('data-collapsed')).toBe('false'); expect(toggle.textContent).toBe('Daralt');
    toggle.click(); expect(body.getAttribute('data-collapsed')).toBe('true'); expect(toggle.textContent).toBe('Tamamını göster');
    expect(host.querySelector('.cv-user .cv-collapsible')).toBeNull();
  });

  it('keeps a folded message open across updates', () => {
    const { api, host } = fixture();
    const long = `${'Uzun kullanıcı mesajı satırı.\n'.repeat(30)}`, data = taskData([], { messages: [{ id: 'm-long', taskId: 'task-1', runId: 'run-1', authorType: 'user', text: long, createdAt: '2026-10-16T12:23:24Z' }] });
    const view = api.create(host, data); (host.querySelector('[data-cv-action=expand]') as any).click();
    view.update({ ...data, messages: [...data.messages, { id: 'm-next', taskId: 'task-1', runId: 'run-1', authorType: 'agent', text: 'Tamam.', createdAt: '2026-10-16T12:23:25Z' }] });
    expect(host.querySelector('.cv-user .cv-collapsible')?.getAttribute('data-collapsed')).toBe('false');
  });

  it('renders agent lists as real nested lists so inline code stays in the sentence', () => {
    const { api, host } = fixture();
    host.innerHTML = api.markdown('- **Tests:** vitest fails (`happy-dom` is missing) in `conversation.js`.\n- **Completion:** `aiws control complete` failed\n  1. first step\n  2. second step\n     ```bash\n     npm test\n     ```\n- [x] done\n\n> quoted\n\n## Title\n---\nSee https://example.com/a.');
    const items = [...host.querySelectorAll('ul.cv-list > li')];
    expect(items).toHaveLength(3); expect(items[0]?.querySelector('p')?.textContent).toBe('Tests: vitest fails (happy-dom is missing) in conversation.js.');
    expect([...items[1]!.querySelectorAll('ol.cv-list > li > p')].map(item => item.textContent)).toEqual(['first step', 'second step']);
    expect(items[1]?.querySelector('ol pre.cv-code code')?.textContent).toBe('npm test'); expect(items[2]?.getAttribute('data-checked')).toBe('true');
    expect(host.querySelector('blockquote')?.textContent).toBe('quoted'); expect(host.querySelector('h4.cv-h2')?.textContent).toBe('Title'); expect(host.querySelector('hr')).not.toBeNull();
    expect(host.querySelector('a[href="https://example.com/a"]')?.textContent).toBe('https://example.com/a');
  });

  it('answers a pending question in its own box instead of a second composer', () => {
    const { api, host } = fixture();
    const question = { id: 'question-1', taskId: 'task-1', runId: 'run-1', status: 'pending', text: 'Hangi sunucu?', createdAt: run.startedAt, answer: null };
    const data = taskData([], { questions: [question], onAnswerQuestion: vi.fn(), onSendMessage: vi.fn() }), view = api.create(host, data);
    expect(host.querySelector('.cv-composer')?.hasAttribute('hidden')).toBe(true); expect(host.querySelectorAll('.cv-question-dock textarea')).toHaveLength(1);
    expect(host.querySelector('.cv-question-dock .cv-prompt-input [name=answer]')).not.toBeNull();
    view.update({ ...data, questions: [{ ...question, status: 'answered', answer: 'build-host' }] });
    expect(host.querySelector('.cv-composer')?.hasAttribute('hidden')).toBe(false); expect(host.querySelector('.cv-question-dock')?.hasAttribute('hidden')).toBe(true);
  });

  it('keeps real PTY ANSI output in the terminal and copies complete structured outputs', async () => {
    const { api, host, window } = fixture(); const openTerminal = vi.fn(), writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    const pty = api.create(host, taskData([event('\u001b[32mNative CLI TUI\u001b[0m', 'stdout'), event('ANSI error', 'stderr')], { runs: [{ ...run, terminalMode: 'pty' }], onOpenTerminal: openTerminal }));
    expect(host.textContent).not.toContain('Native CLI TUI'); expect(host.querySelectorAll('.cv-output,.cv-error')).toHaveLength(0);
    (host.querySelector('[data-cv-action=terminal]') as unknown as HTMLButtonElement).click(); expect(openTerminal).toHaveBeenCalledWith('run-1'); pty.destroy();
    const output = 'full output\n'.repeat(3000);
    api.create(host, taskData([json({ type: 'item.completed', item: { id: 'copy', type: 'command_execution', command: 'npm test', aggregated_output: output, exit_code: 0 } })]));
    (host.querySelector('[data-copy-field=command]') as unknown as HTMLButtonElement).click(); await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('npm test'));
    (host.querySelector('[data-copy-field=output]') as unknown as HTMLButtonElement).click(); await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(output));
  });

  it('preserves open panels, drafts, focus and scroll; announces unread updates and keeps full outputs', async () => {
    const { api, host, window } = fixture(); const send = vi.fn().mockResolvedValue(undefined);
    const events = [json({ type: 'item.started', item: { id: 'tool', type: 'command_execution', command: 'npm test', status: 'in_progress' } })];
    const data = taskData(events, { onSendMessage: send }); const view = api.create(host, data);
    const scroller = host.querySelector('.cv-scroll')!; Object.defineProperties(scroller, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } }); scroller.scrollTop = 100;scroller.dispatchEvent(new window.Event('scroll'));
    const details = host.querySelector('.cv-tool-details') as unknown as HTMLDetailsElement; details.open = true;
    const input = host.querySelector('#task-message-input') as unknown as HTMLTextAreaElement; input.value = 'Taslak mesaj'; input.focus();
    const output = 'valid output\n'.repeat(3000);
    events.push(json({ type: 'item.completed', item: { id: 'tool', type: 'command_execution', command: 'npm test', aggregated_output: output, exit_code: 0, status: 'completed' } }, 23)); view.update({ ...data, events });
    expect(host.querySelector('.cv-tool-details')?.hasAttribute('open')).toBe(true); expect(input.value).toBe('Taslak mesaj'); expect(window.document.activeElement).toBe(input);
    expect(scroller.scrollTop).toBe(100); expect(host.querySelector('.cv-unread')?.hasAttribute('hidden')).toBe(false);
    expect(host.querySelector('pre.cv-output')?.textContent?.length).toBe(12000);
    (host.querySelector('[data-cv-action=more]') as unknown as HTMLButtonElement).click(); expect(host.querySelector('pre.cv-output')?.textContent).toBe(output);
    (host.querySelector('.cv-unread') as unknown as HTMLButtonElement).click(); expect(scroller.scrollTop).toBe(1000);
    host.querySelector('#task-message-form')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await vi.waitFor(() => expect(send).toHaveBeenCalledWith('Taslak mesaj'));
    await vi.waitFor(() => expect(input.value).toBe('')); view.destroy(); expect(host.children).toHaveLength(0);
  });

  it('answers agent-specific questions, preserves typed replies, and deduplicates task messages', async () => {
    const { api, host, window } = fixture(); const answer = vi.fn().mockRejectedValue(new Error('Connection lost'));
    const messages = [{ id: 'm1', taskId: 'task-1', runId: 'run-1', authorType: 'agent', text: 'Aynı mesaj', createdAt: run.startedAt }];
    const question = { id: 'question-1', taskId: 'task-1', runId: 'run-1', status: 'pending', text: '**Hangi** sunucu?', createdAt: run.startedAt, answer: null };
    const data = taskData([json({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'Aynı mesaj' } })], { messages: [...messages, ...messages], questions: [question], onAnswerQuestion: answer });
    const view = api.create(host, data); expect(host.querySelectorAll('.cv-assistant')).toHaveLength(1);
    const input = host.querySelector('[name=answer]') as unknown as HTMLTextAreaElement; input.value = 'build-host'; view.update(data); expect(host.querySelector('[name=answer]')).toBe(input); expect(input.value).toBe('build-host');
    host.querySelector('[data-cv-question]')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(answer).toHaveBeenCalledWith('question-1', 'build-host'));
    await vi.waitFor(() => expect(host.querySelector('.cv-question [role=alert]')?.textContent).toBe('Connection lost'));
    expect(input.value).toBe('build-host');
    view.update({ ...data, questions: [{ ...question, status: 'answered', answer: 'build-host' }] }); expect(host.querySelector('[name=answer]')).toBeNull(); expect(host.querySelector('.cv-answer')?.textContent).toContain('build-host');
  });

  it('shows a parsed native approval as its command, question and choices', () => {
    const { api, host } = fixture();
    const prompt = { title: 'PowerShell command', question: 'Do you want to proceed?', context: ['Splice organizer block into app.js', '⚠ Claude Code will automatically deny this request in 1:45'], command: 'python -I "<splice>.py" app.js', options: [{ label: 'Yes', selected: true }, { label: 'No', selected: false }] };
    const question = { id: 'question-native', taskId: 'task-1', runId: 'run-1', kind: 'approval', source: 'terminal', status: 'pending', text: '**Do you want to proceed?**', prompt, createdAt: run.startedAt, answer: null };
    api.create(host, taskData([], { questions: [question], onAnswerQuestion: vi.fn() }));
    const card = host.querySelector('.cv-question .cv-native-prompt')!;
    expect(card.querySelector('.cv-native-title')?.textContent).toBe('PowerShell command');
    expect(card.querySelector('.cv-native-command')?.textContent).toBe('python -I "<splice>.py" app.js');
    expect(card.querySelector('.cv-native-question')?.textContent).toBe('Do you want to proceed?');
    expect([...card.querySelectorAll('.cv-native-context')].map(line => line.textContent)).toEqual(['Splice organizer block into app.js']);
    expect(card.querySelector('.cv-native-warning')?.textContent).toBe('Claude Code will automatically deny this request in 1:45');
    expect([...card.querySelectorAll('.cv-native-options li')].map(item => [item.querySelector('.cv-native-key')?.textContent, item.lastElementChild?.textContent, item.hasAttribute('data-selected')])).toEqual([['1', 'Yes', true], ['2', 'No', false]]);
  });
  it('collapses subagents behind the main agent row and holds source loading notices', async () => {
    const { api, host } = fixture(), wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const events = [json({ type: 'thread.started', thread_id: 'root-thread' }, 19)];
    for (let index = 0; index < 3; index++) events.push(json({ type: 'item.completed', item: { id: `spawn-${index}`, type: 'collab_tool_call', tool: 'spawn_agent', sender_thread_id: 'root-thread', receiver_thread_ids: [`child-${index}`], agents_states: { [`child-${index}`]: { status: 'running', message: null } }, status: 'completed' } }, 20 + index));
    const data = taskData(events, { agentSource: { loading: true } }), view = api.create(host, data);
    const panel = host.querySelector('.cv-agent-panel') as any, rootRow = host.querySelector('.cv-agent-root') as any, notice = host.querySelector('.cv-agent-source') as any;
    expect(panel.classList.contains('cv-agents-collapsed')).toBe(true); expect(rootRow.getAttribute('aria-expanded')).toBe('false'); expect(rootRow.textContent).toContain('Ana agent · 3 alt agent');
    rootRow.click(); expect(panel.classList.contains('cv-agents-collapsed')).toBe(false); expect(rootRow.getAttribute('aria-expanded')).toBe('true');
    rootRow.click(); expect(panel.classList.contains('cv-agents-collapsed')).toBe(true);
    // Children are known, so a refresh poll never shows the source notice.
    expect(notice.hidden).toBe(true); await wait(700); expect(notice.hidden).toBe(true);
    const empty = { ...taskData([]), agentSource: { loading: true } }; view.update(empty);
    expect(notice.textContent).not.toContain('okunuyor'); view.update({ ...empty, agentSource: { loading: false } }); await wait(700); expect(notice.textContent).not.toContain('okunuyor');
    view.update(empty); await wait(600); expect(notice.textContent).toContain('Agent kaynakları okunuyor');
    view.update({ ...empty, agentSource: { loading: false } }); expect(notice.textContent).toContain('Agent kaynakları okunuyor');
    await wait(300); expect(notice.textContent).toContain('Agent kaynakları okunuyor'); await wait(1000); expect(notice.textContent).not.toContain('okunuyor');
    view.destroy();
  });
});
