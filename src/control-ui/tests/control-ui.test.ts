import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { Window } from 'happy-dom';
import { readFile, mkdtemp, mkdir, writeFile, rm, utimes, appendFile } from 'node:fs/promises';
import { closeWindow, runUiScripts, uiScriptSource, uiStyleSource, isAppScript } from './ui-sources.js';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { seedCodexAgentFamily } from '../../control-server/tests/helpers/agent-history-fixture.js';
import { ControlGitHub } from '../../control-server/github.js';
import { startControlServer, type RunningControlServer } from '../../control-server/server.js';
import { aiProviders, type ProviderAccountsStatus } from '../../control-server/ai-providers/index.js';
import type { ProcessEvidence } from '../../control-server/live-sessions.js';

describe('control center renderer with the real local API', () => {
  let window: Window;
  let server: RunningControlServer;
  let directory: string;
  let nativeEvidence: ProcessEvidence;
  const element = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const result = window.document.querySelector(selector);
    if (!result) throw new Error(`Missing UI element: ${selector}`);
    return result as unknown as T;
  };
  const click = (selector: string): void => element(selector).click();
  const selectTask = (id: string): void => { element(`[data-open-task="${id}"]`).dispatchEvent(new window.MouseEvent('click',{bubbles:true,ctrlKey:true}) as unknown as Event); };
  const input = (selector: string, value: string): void => { (element(selector) as HTMLInputElement).value = value; };
  const edit = (selector: string, value: string): void => { const target = element<HTMLInputElement>(selector); target.value = value; for (const type of ['input', 'change']) target.dispatchEvent(new window.Event(type, { bubbles: true }) as unknown as Event); };
  const submit = (selector: string): void => { element(selector).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event); };
  const wait = (assertion: () => void): Promise<void> => vi.waitFor(assertion, { timeout: 10_000, interval: 25 });
  // Answers the app's confirmation dialog (confirmModal) with its confirm button.
  const confirmDialog = async (): Promise<void> => { await wait(() => expect(element('#modal').hasAttribute('open')).toBe(true)); submit('#modal form'); };
  const typeDraft = (selector: string, value: string): void => { const field = element<HTMLInputElement>(selector); field.value = value; field.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event); };
  const sendAI = (message: string): void => { input('#ai-message', message); submit('#ai-composer'); };
  // Inline Bilgiler fields save on change, as a browser does on select or blur.
  const commit = (selector: string, value?: string): void => { const field = element<HTMLInputElement>(selector); if (value !== undefined) field.value = value; field.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event); };

  const assertModalShell = (): void => {
    const modal=element('#modal'),frame=element('#modal .modal-frame'),body=element('#modal .modal-body'),footer=element('#modal .modal-footer');
    expect(modal.hasAttribute('open')).toBe(true);expect(modal.classList.contains('app-modal')).toBe(true);expect(modal.getAttribute('aria-labelledby')).toBe('modal-title');
    expect(window.document.querySelectorAll('#modal .modal-header')).toHaveLength(1);expect(window.document.querySelectorAll('#modal .modal-body')).toHaveLength(1);expect(window.document.querySelectorAll('#modal .modal-footer')).toHaveLength(1);
    expect(element('#modal .modal-header').parentElement?.id).toBe('modal-content');expect(frame.parentElement?.id).toBe('modal-content');expect(body.parentElement).toBe(frame);expect(footer.parentElement).toBe(frame);
    expect(body.querySelector('.modal-footer')).toBeNull();expect(element('#close-modal').getAttribute('aria-label')).toBe('Pencereyi kapat');expect(footer.querySelector('[data-action="close-modal"]')).not.toBeNull();
    const form=frame.tagName==='FORM'?frame:null;if(form){expect(form).toBe(frame);expect([...form.children]).toEqual([body,footer]);expect(footer.querySelector('button[type="submit"]')?.closest('form')).toBe(form);expect(footer.querySelector('.form-error')).not.toBeNull();}
  };

  // Runs project terminals through the PTY host built from source with the installed node-pty.
  async function usePtyHelper(): Promise<void> {
    const nodePty=createRequire(import.meta.url).resolve('node-pty');
    const windowsHelperPath=join(directory,'windows-launch.mjs');await writeFile(windowsHelperPath,ts.transpileModule(await readFile(new URL('../../control-server/windows-launch.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
    const helperSource=(await readFile(new URL('../../control-server/pty-host.ts',import.meta.url),'utf8')).replace("from 'node-pty'",`from '${pathToFileURL(nodePty).href}'`).replace("from './windows-launch.js'",`from '${pathToFileURL(windowsHelperPath).href}'`);
    const helperPath=join(directory,'pty-host.mjs');await writeFile(helperPath,ts.transpileModule(helperSource,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
    vi.stubEnv('AIWS_CONTROL_PTY_HELPER',helperPath);
  }

  async function createProject(): Promise<void> {
    click('#create-project'); input('#field-name', 'Renderer QA'); input('#field-repositoryPath', directory); submit('#modal form');
    await wait(() => expect(element('#breadcrumb-project').textContent).toBe('Renderer QA'));
  }
  it('dismisses top errors after ten seconds and gives replacement errors a fresh timeout', () => {
    vi.useFakeTimers();
    const schedule = vi.spyOn(window, 'setTimeout').mockImplementation(globalThis.setTimeout as any);
    const cancel = vi.spyOn(window, 'clearTimeout').mockImplementation(globalThis.clearTimeout as any);
    try {
      window.eval('error("First failure")');
      expect(element('#error-banner').hidden).toBe(false);
      vi.advanceTimersByTime(9_999);
      expect(element('#error-banner').hidden).toBe(false);
      window.eval('error("Replacement failure")');
      vi.advanceTimersByTime(1);
      expect(element('#error-banner').hidden).toBe(false);
      expect(element('#error-banner').textContent).toContain('Replacement failure');
      vi.advanceTimersByTime(9_998);
      expect(element('#error-banner').hidden).toBe(false);
      vi.advanceTimersByTime(1);
      expect(element('#error-banner').hidden).toBe(true);

      window.eval('error("Close manually")');
      click('#dismiss-error');
      expect(element('#error-banner').hidden).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      window.eval('error("Leaving the page")');
      window.dispatchEvent(new window.Event('pagehide'));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      schedule.mockRestore();
      cancel.mockRestore();
      vi.useRealTimers();
    }
  });
  it('shows completing tasks in the Done column without counting them as completed', async () => {
    await createProject();
    const project = server.service.snapshot().projects[0]!;
    const task = server.service.createTask({ projectId: project.id, title: 'Waiting for merge and cleanup', status: 'completing' });
    await wait(() => {
      const card = element(`[data-board-column="done"] [data-open-task="${task.id}"]`);
      expect(card.querySelector('.task-status-chip')?.textContent).toBe('Tamamlanıyor');
      expect(element('#task-count').textContent).toContain('0 tamamlandı');
    });
    expect(window.eval("AIWSUI.tone('completing')")).toBe('running');
    click('#overview-nav');
    expect(element(`.project-board-group [data-open-task="${task.id}"] .task-status-chip`).textContent).toBe('Tamamlanıyor');
  });

  it('selects column headers and archives selected completed and unfinished tasks without changing their status', async () => {
    await createProject();
    const project=server.service.snapshot().projects[0]!;
    const done=server.service.createTask({projectId:project.id,title:'Finished one',status:'done'});
    const otherDone=server.service.createTask({projectId:project.id,title:'Finished two',status:'done'});
    const unfinished=server.service.createTask({projectId:project.id,title:'Unfinished'});
    await wait(()=>expect(window.document.querySelectorAll('#board [data-open-task]')).toHaveLength(3));
    click('[data-drop-status="done"] [data-select-column]');
    expect(element('#task-selection-count').textContent).toBe('2 görev seçili');
    expect(element('[data-drop-status="done"] [data-select-column]').getAttribute('aria-pressed')).toBe('true');
    click('[data-drop-status="done"] [data-select-column]');
    expect(element('#task-selection-count').textContent).toBe('0 görev seçili');
    click('[data-drop-status="done"] [data-select-column]');click('#archive-selected-tasks');
    await wait(()=>expect(server.service.task(done.id).archivedAt).toBeTruthy());
    await wait(()=>expect(window.document.querySelectorAll('#board [data-open-task]')).toHaveLength(1));
    expect(server.service.task(done.id).status).toBe('done');expect(server.service.task(otherDone.id).status).toBe('done');
    await wait(()=>expect(element<HTMLButtonElement>('#archive-view').disabled).toBe(false));
    selectTask(unfinished.id);click('#archive-selected-tasks');
    await wait(()=>expect(server.service.task(unfinished.id).archivedAt).toBeTruthy());
    await wait(()=>expect(element<HTMLButtonElement>('#archive-selected-tasks').disabled).toBe(true));
    await wait(()=>expect(element<HTMLButtonElement>('#archive-view').disabled).toBe(false));
    click('#archive-view');
    await wait(()=>expect(window.document.querySelectorAll('#board [data-open-task]')).toHaveLength(3));
    expect(element(`[data-open-task="${done.id}"]`).textContent).toContain('Tamamlandı');
    expect(element(`[data-open-task="${unfinished.id}"]`).textContent).toContain('Bekleyen');
    selectTask(done.id);selectTask(unfinished.id);click('#archive-selected-tasks');
    await wait(()=>expect(server.service.task(unfinished.id).archivedAt).toBeUndefined());
    await wait(()=>expect(window.document.querySelectorAll('#board [data-open-task]')).toHaveLength(1));
    expect(server.service.task(otherDone.id).archivedAt).toBeTruthy();
    expect(server.service.task(done.id).status).toBe('done');
    await wait(()=>expect(element<HTMLButtonElement>('#archive-view').disabled).toBe(false));
    click('#list-view');click('[data-select-column]');
    expect(element('#task-selection-count').textContent).toBe('1 görev seçili');
    click('#archive-view');expect(element('#task-selection-count').textContent).toBe('0 görev seçili');
    expect(window.document.querySelectorAll('#board [data-open-task]')).toHaveLength(2);
  });
  it('multi-selects board cards with their checkboxes, without a modifier key, and archives them together', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;
    const first=server.service.createTask({projectId:project.id,title:'First'});
    const second=server.service.createTask({projectId:project.id,title:'Second',status:'ready'});
    const kept=server.service.createTask({projectId:project.id,title:'Kept'});
    await wait(()=>expect(window.document.querySelectorAll('#board [data-open-task]')).toHaveLength(3));
    click(`[data-open-task="${first.id}"] [data-select-task]`);click(`[data-open-task="${second.id}"] [data-select-task]`);
    expect(element('#task-selection-count').textContent).toBe('2 görev seçili');
    expect(element('#task-panel').hidden).toBe(true);
    expect(element('#board').classList.contains('has-task-selection')).toBe(true);
    expect(element(`[data-open-task="${first.id}"]`).getAttribute('aria-pressed')).toBe('true');
    click(`[data-open-task="${first.id}"] [data-select-task]`);expect(element('#task-selection-count').textContent).toBe('1 görev seçili');
    click(`[data-open-task="${first.id}"] [data-select-task]`);click('#archive-selected-tasks');
    await wait(()=>expect(server.service.task(first.id).archivedAt).toBeTruthy());
    expect(server.service.task(second.id).archivedAt).toBeTruthy();expect(server.service.task(kept.id).archivedAt).toBeUndefined();
    await wait(()=>expect(window.document.querySelectorAll('#board [data-open-task]')).toHaveLength(1));
    expect(element('#board').classList.contains('has-task-selection')).toBe(false);
  });
  it('limits header selection to visible tasks and retains selection when archiving fails', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;
    const visible=server.service.createTask({projectId:project.id,title:'Matching finished',status:'done'});
    const hidden=server.service.createTask({projectId:project.id,title:'Hidden finished',status:'done'});
    await wait(()=>expect(window.document.querySelectorAll('#board [data-open-task]')).toHaveLength(2));
    input('#search','Matching');element('#search').dispatchEvent(new window.Event('input',{bubbles:true}) as unknown as Event);
    click('[data-drop-status="done"] [data-select-column]');expect(element('#task-selection-count').textContent).toBe('1 görev seçili');
    const failure=vi.spyOn(server.service,'setTasksArchived').mockImplementationOnce(()=>{throw new Error('Archive unavailable');});
    click('#archive-selected-tasks');
    await wait(()=>expect(element('#error-banner').textContent).toContain('Archive unavailable'));
    await wait(()=>expect(element<HTMLButtonElement>('#archive-selected-tasks').disabled).toBe(false));
    expect(element('#task-selection-count').textContent).toBe('1 görev seçili');
    expect(server.service.task(visible.id).archivedAt).toBeUndefined();failure.mockRestore();
    click('#archive-selected-tasks');await wait(()=>expect(server.service.task(visible.id).archivedAt).toBeTruthy());
    await wait(()=>expect(element<HTMLButtonElement>('#archive-view').disabled).toBe(false));
    expect(server.service.task(hidden.id).archivedAt).toBeUndefined();
    click('#overview-nav');click('#archive-view');
    await wait(()=>expect(window.document.querySelectorAll('#board [data-open-task]')).toHaveLength(1));
    expect(element(`[data-open-task="${visible.id}"]`).textContent).toContain('Tamamlandı');
    click('.swimlane-head-cell:last-child [data-select-column]');expect(element('#task-selection-count').textContent).toBe('1 görev seçili');
  });
  /** Monaco itself is not loaded in tests: a stand-in with the same calls records the model the editor shows. */
  const installMonacoStub=():void=>{window.eval(`(()=>{const models=new Map(),stub=window.monacoStub={themes:[],editor:null};
      class Model{constructor(value,uri){this.value=value;this.uri=uri;this.id=1;this.listeners=[];}getValue(){return this.value;}setValue(value){this.value=value;this.id++;for(const listener of this.listeners)listener();}getAlternativeVersionId(){return this.id;}onDidChangeContent(listener){this.listeners.push(listener);}dispose(){models.delete(this.uri);}}
      window.monaco={Uri:{file:path=>path},languages:{},editor:{defineTheme:(name,data)=>stub.themes.push({name,...data}),setTheme(){},getModel:uri=>models.get(uri),createModel(value,language,uri){const model=new Model(value,uri);models.set(uri,model);return model;},
        create(host,options){stub.options=options;return stub.editor={model:null,setModel(model){this.model=model;},getModel(){return this.model;},saveViewState(){return {};},restoreViewState(){},focus(){}};}}};})()`);};
  it('opens a file from the files panel in the Monaco editor tab and saves, keeps or reconciles its changes', async () => {
    const notes=join(directory,'notes.md'),onDisk=()=>readFile(notes,'utf8');
    await writeFile(notes,'first\n');await writeFile(join(directory,'other.txt'),'other');await writeFile(join(directory,'image.bin'),Buffer.from([0,1,2,3]));await mkdir(join(directory,'docs'));await writeFile(join(directory,'photo.png'),Buffer.from([0x89,0x50,0x4e,0x47]));
    await createProject();installMonacoStub();
    const shown=():string|undefined=>window.eval('monacoStub.editor?.model?.getValue()') as string|undefined;
    const type=(value:string):void=>{window.eval(`monacoStub.editor.model.setValue(${JSON.stringify(value)})`);};
    const openTabs=()=>[...window.document.querySelectorAll('.file-editor [data-editor-file]')].map(tab=>tab.getAttribute('data-editor-file'));
    const dirtyDots=()=>window.document.querySelectorAll('.file-editor-tab .ui-dot').length;
    click('#files-toggle');await wait(()=>expect(element('[data-file-path="notes.md"]')).toBeTruthy());
    expect(element('#project-tab-editor').hidden).toBe(true);
    click('[data-file-path="notes.md"]');
    await wait(()=>expect(shown()).toBe('first\n'));
    expect(element('#project-tab-editor').hidden).toBe(false);expect(element('#project-tab-editor').getAttribute('aria-selected')).toBe('true');
    expect(element('#board').classList.contains('project-editor-board')).toBe(true);expect(element('#board .file-editor .file-editor-host').hidden).toBe(false);
    expect(window.eval('monacoStub.themes.at(-1).name')).toBe('aiws');expect(window.eval('monacoStub.options.theme')).toBe('aiws');
    expect(element<HTMLButtonElement>('[data-editor-save]').disabled).toBe(true);
    // The same file opens once; another file gets its own tab.
    click('[data-file-path="notes.md"]');expect(openTabs()).toEqual(['notes.md']);
    click('[data-file-path="other.txt"]');await wait(()=>expect(shown()).toBe('other'));expect(openTabs()).toEqual(['notes.md','other.txt']);
    click('[data-editor-file="notes.md"]');expect(shown()).toBe('first\n');
    // An edit marks the tab and the project tab; Ctrl+S writes it to the file.
    type('first\nmine\n');
    await wait(()=>expect(dirtyDots()).toBe(1));await wait(()=>expect(element('#project-tab-editor').querySelector('.ui-dot')).not.toBeNull());
    expect(element<HTMLButtonElement>('[data-editor-save]').disabled).toBe(false);expect(await onDisk()).toBe('first\n');
    element('.file-editor-host').dispatchEvent(new window.KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true}) as unknown as Event);
    await wait(async()=>expect(await onDisk()).toBe('first\nmine\n'));
    await wait(()=>expect(dirtyDots()).toBe(0));await wait(()=>expect(element('#project-tab-editor').querySelector('.ui-dot')).toBeNull());
    expect(await readFile(join(directory,'other.txt'),'utf8')).toBe('other');
    // A file changed on disk meanwhile is not overwritten: the dialog offers the disk version or an explicit overwrite.
    type('mine again');await writeFile(notes,'written by an agent');
    click('[data-editor-save]');
    await wait(()=>expect(element('#modal-title').textContent).toBe('Dosya diskte değişti'));assertModalShell();
    expect(await onDisk()).toBe('written by an agent');
    click('[data-confirm-alternative]');
    await wait(()=>expect(shown()).toBe('written by an agent'));await wait(()=>expect(dirtyDots()).toBe(0));expect(element('#modal').hasAttribute('open')).toBe(false);
    type('mine wins');await writeFile(notes,'agent again');
    click('[data-editor-save]');await wait(()=>{expect(element('#modal').hasAttribute('open')).toBe(true);expect(element('#modal-title').textContent).toBe('Dosya diskte değişti');});submit('#modal form');
    await wait(async()=>expect(await onDisk()).toBe('mine wins'));await wait(()=>expect(dirtyDots()).toBe(0));
    // Unsaved changes survive leaving the tab, and closing the file asks first.
    type('unsaved');await wait(()=>expect(dirtyDots()).toBe(1));
    click('#project-tab-board');expect(window.document.querySelector('#board .file-editor')).toBeNull();
    click('#project-tab-editor');expect(shown()).toBe('unsaved');
    click('[data-editor-close="notes.md"]');await wait(()=>{expect(element('#modal').hasAttribute('open')).toBe(true);expect(element('#modal-title').textContent).toBe('Değişiklikler kaydedilmedi');});
    click('#close-modal');await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));
    expect(openTabs()).toEqual(['notes.md','other.txt']);expect(shown()).toBe('unsaved');
    click('[data-editor-close="notes.md"]');await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(true));submit('#modal form');
    await wait(async()=>expect(await onDisk()).toBe('unsaved'));await wait(()=>expect(openTabs()).toEqual(['other.txt']));expect(shown()).toBe('other');
    // A file that is not text shows why instead of an editor.
    click('[data-file-path="image.bin"]');
    await wait(()=>expect(element('.file-editor-message').textContent).toContain('Bu dosya metin değil'));expect(element('.file-editor-host').hidden).toBe(true);expect(element('[data-editor-launch]')).toBeTruthy();
    // A picture is shown in the editor area instead of a text editor.
    click('[data-file-path="photo.png"]');
    await wait(()=>expect(element<HTMLImageElement>('.file-editor-preview img').getAttribute('src')).toBe(`data:image/png;base64,${Buffer.from([0x89,0x50,0x4e,0x47]).toString('base64')}`));
    expect(element('.file-editor-host').hidden).toBe(true);expect(element('.file-editor-message').hidden).toBe(true);
    // "New file" takes the name with its extension and a folder, creates the file there and opens it.
    click('[data-files-new]');await wait(()=>expect(element('#modal-title').textContent).toBe('Yeni dosya'));assertModalShell();
    expect(element<HTMLInputElement>('#field-folder').value).toBe('');
    input('#field-name','todo.ts');input('#field-folder','docs');submit('#modal form');
    await wait(async()=>expect(await readFile(join(directory,'docs','todo.ts'),'utf8')).toBe(''));
    await wait(()=>expect(openTabs()).toContain('docs/todo.ts'));await wait(()=>expect(element('[data-file-path="docs/todo.ts"]')).toBeTruthy());
    click('[data-files-new]');await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(true));expect(element<HTMLInputElement>('#field-folder').value).toBe('docs');
    input('#field-name','todo.ts');submit('#modal form');await wait(()=>expect(element('#modal .form-error').textContent).toContain('already exists'));click('#close-modal');
    await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));
    click('[data-editor-close="docs/todo.ts"]');click('[data-editor-close="photo.png"]');
    click('[data-editor-close="image.bin"]');click('[data-editor-close="other.txt"]');
    await wait(()=>expect(element('#project-tab-editor').hidden).toBe(true));expect(element('#project-tab-board').getAttribute('aria-selected')).toBe('true');
  });
  it('closes, copies, reveals and pins editor tabs from their context menu', async () => {
    for(const name of ['a.txt','b.txt','c.txt','d.txt'])await writeFile(join(directory,name),name);
    await createProject();installMonacoStub();
    const writeText=vi.fn().mockResolvedValue(undefined);Object.defineProperty(window.navigator,'clipboard',{configurable:true,value:{writeText}});
    const openTabs=()=>[...window.document.querySelectorAll('.file-editor [data-editor-file]')].map(tab=>tab.getAttribute('data-editor-file'));
    const menu=(path:string)=>{element(`[data-editor-file="${path}"]`).dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:20,clientY:20}) as unknown as Event);
      return [...window.document.querySelectorAll<HTMLButtonElement>('.file-context-menu button')].map(button=>({label:button.textContent,disabled:button.disabled}));};
    const choose=(label:string)=>{const button=[...window.document.querySelectorAll<HTMLButtonElement>('.file-context-menu button')].find(item=>item.textContent===label);expect(button).toBeTruthy();button!.click();};
    click('#files-toggle');await wait(()=>expect(element('[data-file-path="d.txt"]')).toBeTruthy());
    for(const name of ['a.txt','b.txt','c.txt','d.txt']){click(`[data-file-path="${name}"]`);await wait(()=>expect(window.eval('monacoStub.editor?.model?.getValue()')).toBe(name));}
    expect(menu('d.txt')).toEqual([{label:'Kapat',disabled:false},{label:'Diğerlerini kapat',disabled:false},{label:'Sağdakileri kapat',disabled:true},{label:'Kaydedilenleri kapat',disabled:false},{label:'Tümünü kapat',disabled:false},
      {label:'Yolu kopyala',disabled:false},{label:'Göreli yolu kopyala',disabled:false},{label:"Dosya Gezgini'nde göster",disabled:false},{label:'Gezgin görünümünde göster',disabled:false},{label:'Sabitle',disabled:false}]);
    expect(window.document.querySelectorAll('.file-context-menu [role=separator]')).toHaveLength(3);
    choose('Göreli yolu kopyala');await wait(()=>expect(writeText).toHaveBeenLastCalledWith('d.txt'));expect(window.document.querySelector('.file-context-menu')).toBeNull();
    menu('d.txt');choose('Yolu kopyala');await wait(()=>expect(writeText).toHaveBeenLastCalledWith(join(directory,'d.txt')));
    // A pinned tab moves to the front, keeps a pin button instead of close, and survives bulk closes.
    menu('c.txt');choose('Sabitle');expect(openTabs()).toEqual(['c.txt','a.txt','b.txt','d.txt']);
    expect(element('[data-editor-unpin="c.txt"]')).toBeTruthy();expect(window.document.querySelector('[data-editor-close="c.txt"]')).toBeNull();
    menu('a.txt');choose('Sağdakileri kapat');await wait(()=>expect(openTabs()).toEqual(['c.txt','a.txt']));
    menu('a.txt');choose('Diğerlerini kapat');expect(openTabs()).toEqual(['c.txt','a.txt']);
    // An unsaved tab is kept by "Close saved".
    click('[data-file-path="b.txt"]');await wait(()=>expect(openTabs()).toEqual(['c.txt','a.txt','b.txt']));await wait(()=>expect(window.eval('monacoStub.editor?.model?.getValue()')).toBe('b.txt'));
    window.eval('monacoStub.editor.model.setValue("changed")');await wait(()=>expect(window.document.querySelectorAll('.file-editor-tab .ui-dot')).toHaveLength(1));
    menu('a.txt');choose('Kaydedilenleri kapat');await wait(()=>expect(openTabs()).toEqual(['c.txt','b.txt']));
    // "Reveal in explorer view" selects the file in the files panel, opening the panel if needed.
    click('[data-files-close]');await wait(()=>expect(element('#files-panel').hidden).toBe(true));
    menu('c.txt');choose('Gezgin görünümünde göster');await wait(()=>expect(element('[data-file-path="c.txt"]').classList.contains('selected')).toBe(true));expect(element('#files-panel').hidden).toBe(false);
    menu('c.txt');choose('Sabitlemeyi kaldır');expect(element('[data-editor-close="c.txt"]')).toBeTruthy();
    // "Close all" still asks about unsaved changes; cancelling keeps the file open.
    menu('c.txt');choose('Tümünü kapat');await wait(()=>expect(element('#modal-title').textContent).toBe('Değişiklikler kaydedilmedi'));
    click('#close-modal');await wait(()=>expect(openTabs()).toEqual(['b.txt']));expect(await readFile(join(directory,'b.txt'),'utf8')).toBe('b.txt');
  });
  it('shows project files in a right-hand panel as a tree with path and open actions in the context menu', async () => {
    await mkdir(join(directory,'src','nested'),{recursive:true});await writeFile(join(directory,'src','nested','deep.txt'),'x');await writeFile(join(directory,'README.md'),'x');
    await createProject();const project=server.service.snapshot().projects[0]!;
    expect(element('#files-panel').hidden).toBe(true);expect(element('#files-toggle').hidden).toBe(false);
    click('#files-toggle');
    await wait(()=>expect(element('[data-file-path="src"]').getAttribute('aria-expanded')).toBe('false'));
    expect(element('#files-panel').hidden).toBe(false);expect(element('#files-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(element('.app-shell').classList.contains('files-open')).toBe(true);expect(element('[data-file-path="README.md"]').getAttribute('draggable')).toBe('true');
    const names=[...window.document.querySelectorAll('.project-files-tree [role=treeitem]')].map(row=>row.getAttribute('data-file-path'));
    expect(names.indexOf('src')).toBeLessThan(names.indexOf('README.md'));
    click('[data-file-path="src"]');await wait(()=>expect(element('[data-file-path="src/nested"]')).toBeTruthy());
    click('[data-file-path="src/nested"]');await wait(()=>expect(element('[data-file-path="src/nested/deep.txt"]').getAttribute('aria-level')).toBe('3'));
    click('[data-file-path="src/nested/deep.txt"]');expect(element('[data-file-path="src/nested/deep.txt"]').classList.contains('selected')).toBe(true);expect(window.document.querySelector('#modal[open]')).toBeNull();
    element('[data-file-path="src/nested/deep.txt"]').dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:20,clientY:20}) as unknown as Event);
    expect([...window.document.querySelectorAll('.file-context-menu button')].map(button=>button.textContent)).toEqual(['Varsayılan programla aç',"Dosya Gezgini'nde göster",'Yeni dosya…','Yolu kopyala','Göreli yolu kopyala']);
    window.document.body.dispatchEvent(new window.Event('pointerdown',{bubbles:true}) as unknown as Event);expect(window.document.querySelector('.file-context-menu')).toBeNull();
    element('[data-file-path="src"]').dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:20,clientY:20}) as unknown as Event);
    expect([...window.document.querySelectorAll('.file-context-menu button')].map(button=>button.textContent)).toEqual(["Dosya Gezgini'nde göster",'Yeni dosya…','Yolu kopyala','Göreli yolu kopyala']);
    window.document.body.dispatchEvent(new window.Event('pointerdown',{bubbles:true}) as unknown as Event);
    element(`[data-project="${project.id}"]`).dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:20,clientY:20}) as unknown as Event);
    expect([...window.document.querySelectorAll('.file-context-menu button')].map(button=>button.textContent)).toEqual(["Dosya Gezgini'nde göster",'Arşive taşı','Proje yolunu kopyala']);
    window.document.body.dispatchEvent(new window.Event('pointerdown',{bubbles:true}) as unknown as Event);
    await expect(window.eval(`api('/projects/${project.id}/files?path=..')`)).rejects.toThrow(/inside the project/);
    click('[data-files-collapse]');expect(window.document.querySelector('[data-file-path="src/nested"]')).toBeNull();
    click('#create-task');await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(true));
    await wait(()=>expect(element('#files-panel').parentElement?.id).toBe('modal'));expect(element('#files-panel').classList.contains('floating')).toBe(true);
    const css=await uiStyleSource();expect(css).toContain('.app-shell.files-open~#modal{inset:0 var(--files-panel-width) 0 0;margin:auto;');expect(css).not.toContain('margin-right:calc(var(--files-panel-width) + 24px)');
    element<HTMLButtonElement>('#close-modal').click();
    await wait(()=>expect(element('#files-panel').parentElement?.classList.contains('app-shell')).toBe(true));
    click('[data-files-close]');expect(element('#files-panel').hidden).toBe(true);expect(element('.app-shell').classList.contains('files-open')).toBe(false);
  });
  it('updates Git merge badges from live tasks despite a stale Git snapshot', async () => {
    await createProject(); await createTask('Merge work');
    const task = server.service.store.state.tasks[0]!;
    const snapshot = { id: task.id, title: task.title, status: 'review', merging: true };
    const live = (fields: object) => window.eval(`applyState({tasks:${JSON.stringify([{ ...task, status: 'review', ...fields }])}})`);
    const merging = () => badge().includes('AI merge ediyor');
    const badge = () => window.eval(`gitTaskLink(${JSON.stringify(snapshot)})`);
    live({ worktree: { mergeRequested: true } });
    expect(merging()).toBe(true); expect(badge()).toContain('AI merge ediyor');
    live({ worktree: {} });
    expect(merging()).toBe(false); expect(badge()).not.toContain('AI merge ediyor');
    live({ status: 'done', worktree: { mergeRequested: true } });
    expect(merging()).toBe(false);
    live({ worktree: { mergeRequested: true, mergedSha: 'abc' } });
    expect(merging()).toBe(false);
    live({ status: 'running', queuedContinuation: { mergeRecovery: true } });
    expect(merging()).toBe(true);
    live({ status: 'failed', worktree: { mergeRequested: true } });
    expect(merging()).toBe(false); expect(badge()).toContain('AI conflicti çözemedi');
  });
  it('shows the project Git state in the footer and merges a branch into main from the Git panel', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@localhost');
    // The control data lives in this folder; ignoring it leaves the commit below only the note.
    await writeFile(join(directory, 'base.txt'), 'base\n'); await writeFile(join(directory, '.gitignore'), 'data/\n'); git('add', 'base.txt', '.gitignore'); git('commit', '-m', 'Initial');
    git('switch', '-c', 'feature'); await writeFile(join(directory, 'feature.txt'), 'feature\n'); git('add', 'feature.txt'); git('commit', '-m', 'Add feature'); git('switch', 'main'); git('branch', 'spare');
    expect(element('#git-status').hidden).toBe(true);
    await createProject();
    await wait(() => expect(element('#git-status').hidden).toBe(false));
    // Git is read in the background, so the chip names the branch before the panel opens.
    await wait(() => expect(element('#git-status-label').textContent).toContain('main'));
    await writeFile(join(directory, 'note.txt'), 'note\n');
    click('#git-status');
    expect(element('#git-panel').hidden).toBe(false); expect(element('#git-status').getAttribute('aria-expanded')).toBe('true');
    // The commit tab comes first and commits every change with the summary and description.
    await wait(() => expect(element('#git-panel .git-summary').textContent).toContain('1 commitlenmemiş değişiklik'));
    expect(element('[data-git-tab="commit"]').getAttribute('aria-selected')).toBe('true');
    typeDraft('[data-git-commit-form] [name="summary"]', 'Add note');
    window.eval('renderGit()');
    expect(element<HTMLInputElement>('[data-git-commit-form] [name="summary"]').value).toBe('Add note');
    typeDraft('[data-git-commit-form] [name="description"]', 'Longer body');
    submit('[data-git-commit-form]');
    await wait(() => expect(element('#git-panel .git-summary').textContent).toContain('çalışma alanı temiz'));
    expect(git('log', '-1', '--format=%s|%b')).toBe('Add note|Longer body');
    expect(element<HTMLInputElement>('[data-git-commit-form] [name="summary"]').value).toBe('');
    // The newest commits of HEAD are listed under the form.
    await wait(() => expect(element('#git-panel .git-group').textContent).toContain('Add note'));
    expect(element('#git-panel .git-group').textContent).toContain('Initial');
    click('[data-git-tab="branches"]');
    await wait(() => expect(element('#git-panel').textContent).toContain('Add feature'));
    expect(element('#git-status-label').textContent).toContain('main');
    expect(element('#git-panel').textContent).toContain('main: +1 / −1');
    expect(element('#git-panel').textContent).toContain('uzak depo yok');
    expect(window.document.querySelector('[data-git-merge="feature"]')).toBeNull();
    click('[data-git-menu="branch:spare"]');
    click('[data-git-delete="branch:spare"]');
    expect(element('[data-git-delete="branch:spare"]').textContent).toBe('Onayla: sil');
    click('[data-git-delete="branch:spare"]');
    await wait(() => expect(git('branch', '--list', 'spare')).toBe(''));
    await wait(() => expect(window.document.querySelector('[data-git-menu="branch:spare"]')).toBeNull());
    click('[data-git-menu="branch:feature"]');
    click('[data-git-merge="feature"]');
    expect(element('[data-git-merge="feature"]').textContent).toBe('Onayla: merge et ve sil');
    expect(git('branch', '--list', 'feature')).toContain('feature');
    click('[data-git-merge="feature"]');
    await wait(() => expect(element('#git-panel .git-result').textContent).toContain("main'e merge edildi ve silindi."));
    expect(git('branch', '--list', 'feature')).toBe('');
    expect(await readFile(join(directory, 'feature.txt'), 'utf8')).toContain('feature');
    await wait(() => expect(window.document.querySelector('[data-git-merge="feature"]')).toBeNull());
    click('[data-git-tab="worktrees"]');
    expect(element('#git-panel').textContent).toContain('ana depo');
    // Task folders are a group of the worktree tab, not a tab of their own.
    expect(window.document.querySelector('[data-git-tab="folders"]')).toBeNull();
    expect(element('#git-panel').textContent).toContain('Worktree klasörleri');
    click('[data-git-command="push"]');
    await wait(() => expect(element('#git-panel .git-result').textContent).toContain('no remote'));
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event);
    expect(element('#git-panel').hidden).toBe(true);
  });
  it('shows the current Git task title and opens its task from the summary and branch list', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@localhost');
    await writeFile(join(directory, 'base.txt'), 'base\n'); git('add', 'base.txt'); git('commit', '-m', 'Initial');
    await createProject();
    const project = server.service.snapshot().projects[0]!;
    const task = server.service.createTask({ projectId: project.id, title: 'Git <task> & title' });
    const branch = `aiws/${task.id}`;
    git('switch', '-c', branch);
    await wait(() => expect(window.document.querySelector(`[data-open-task="${task.id}"]`)).not.toBeNull());
    click('#git-status');
    await wait(() => expect(element('.git-summary [data-git-task]').textContent).toContain(task.title));
    expect(element('#git-status-label').textContent).toContain(branch);
    expect(element('#git-status').title).toBe(task.title);
    expect(element('.git-summary').textContent).not.toContain(branch);
    expect(window.document.querySelector('.git-summary task')).toBeNull();

    // A stale Git overview must use the latest task title from live state.
    window.eval(`applyState({tasks:${JSON.stringify([{ ...task, title: 'Renamed Git task' }])}});renderGit()`);
    expect(element('.git-summary [data-git-task]').textContent).toContain('Renamed Git task');
    expect(element('#git-status').title).toBe('Renamed Git task');
    click('.git-summary [data-git-task]');
    expect(element('#git-panel').hidden).toBe(true);
    expect(element('#task-panel').hidden).toBe(false);
    expect(window.eval('selectedTaskId')).toBe(task.id);
    click('#close-panel');
    click('#git-status');
    await wait(() => expect(window.document.querySelector('[data-git-tab="branches"]')).not.toBeNull());
    click('[data-git-tab="branches"]');
    await wait(() => expect(window.document.querySelector('.git-row [data-git-task]')).not.toBeNull());
    click('.git-row [data-git-task]');
    expect(element('#task-panel').hidden).toBe(false);
    expect(window.eval('selectedTaskId')).toBe(task.id);

    click('#close-panel');
    git('switch', 'main');
    click('#git-status');
    await wait(() => expect(element('.git-summary strong').textContent).toBe('main'));
    expect(element('#git-status-label').textContent).toContain('main');
    expect(window.document.querySelector('.git-summary [data-git-task]')).toBeNull();
  });
  it('merges every branch from the Git panel and lists uncommitted changes in the side panel', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@localhost');
    await writeFile(join(directory, 'base.txt'), 'base\n'); git('add', 'base.txt'); git('commit', '-m', 'Initial');
    for (const name of ['one', 'two']) { git('switch', '-c', `feature-${name}`); await writeFile(join(directory, `${name}.txt`), `${name}\n`); git('add', `${name}.txt`); git('commit', '-m', `Add ${name}`); git('switch', 'main'); }
    await createProject();
    click('#git-status');
    await wait(() => expect(window.document.querySelector('[data-git-tab="branches"]')).not.toBeNull());
    click('[data-git-tab="branches"]');
    await wait(() => expect(element('#git-panel').textContent).toContain('Add two'));
    click('[data-git-merge-all]');
    expect(element('[data-git-merge-all]').textContent).toBe("Onayla: 2 branch'i merge et ve sil");
    click('[data-git-merge-all]');
    await wait(() => expect(window.document.querySelectorAll('#git-panel .git-batch .git-result[data-tone="done"]')).toHaveLength(2));
    expect(git('branch', '--list', 'feature-*')).toBe('');
    await writeFile(join(directory, 'base.txt'), 'changed\n');
    click('[data-git-refresh]');
    await wait(() => expect(element('.git-changes-link').textContent).toContain('+1'));
    click('.git-changes-link');
    // The Git panel stays open beside the changes list.
    expect(element('#git-panel').hidden).toBe(false);
    const side = element('#agent-child-panel');
    expect(side.hidden).toBe(false); expect(side.dataset.view).toBe('changes'); expect(side.style.getPropertyValue('--child-panel-right')).toBe('0px');
    await wait(() => expect(element('#child-changes-host [data-change-path="base.txt"] .file-change').textContent).toBe('M'));
    expect(element('#child-agent-title').textContent).toBe('Değişiklikler · main');
    element('#close-child-agent').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event);
    expect(side.hidden).toBe(true);
  });
  it('shows a changes tab for a task branch and lists its files in the side panel beside the task', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@localhost');
    await writeFile(join(directory, 'base.txt'), 'base\n'); git('add', 'base.txt'); git('commit', '-m', 'Initial');
    git('switch', '-c', 'task-work'); await mkdir(join(directory, 'src')); await writeFile(join(directory, 'src', 'work.txt'), 'work\n'); git('add', 'src/work.txt'); git('commit', '-m', 'Work'); git('switch', 'main');
    await createProject(); await createTask('Branch work');
    Object.assign(server.service.store.state.tasks[0]!, { taskBranch: 'task-work' }); server.service.emit('change', server.service.snapshot());
    if (element('#task-panel').hidden) click('.task-card');
    await wait(() => expect(element('#task-panel .detail-tabs [data-open-changes]').textContent).toBe('Değişiklikler 1'));
    click('[data-open-changes]');
    const side = element('#agent-child-panel');
    expect(side.hidden).toBe(false); expect(side.dataset.view).toBe('changes');
    expect(side.style.getPropertyValue('--child-panel-right')).toBe(element('#task-panel').style.getPropertyValue('--task-panel-width'));
    await wait(() => expect(element('#child-changes-host [data-change-path="src/work.txt"] .file-change').textContent).toBe('A'));
    expect(element('#child-changes-host .changes-summary').textContent).toContain("task-work · main'e göre");
    const workspace = element('#task-panel').parentElement!;
    Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true });
    for (const area of [1200, 936, 900, 680, 1200]) {
      Object.defineProperty(workspace, 'clientWidth', { value: area, configurable: true });
      window.dispatchEvent(new window.Event('resize'));
      const stacked = side.dataset.stacked === 'true';
      expect(stacked).toBe(area < 936);
      const right = Number.parseInt(side.style.getPropertyValue('--child-panel-right'));
      const width = Number.parseInt(side.style.getPropertyValue('--child-panel-width'));
      expect(right + width).toBeLessThanOrEqual(area);
      if (stacked) { expect(right).toBe(0); expect(width).toBe(area); }
      else {
        expect(right).toBeGreaterThanOrEqual(560);
        expect(width).toBeGreaterThanOrEqual(360);
      }
    }
    click('[data-open-changes]');
    expect(side.hidden).toBe(true);
  });
  it('keeps the scroll of the changes list and its open patches across refreshes', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@localhost');
    await writeFile(join(directory, 'base.txt'), 'base\n'); git('add', 'base.txt'); git('commit', '-m', 'Initial');
    git('switch', '-c', 'task-work'); await writeFile(join(directory, 'work.txt'), 'one\n'); git('add', 'work.txt'); git('commit', '-m', 'Work'); git('switch', 'main');
    await createProject(); await createTask('Scrolled changes');
    Object.assign(server.service.store.state.tasks[0]!, { taskBranch: 'task-work' }); server.service.emit('change', server.service.snapshot());
    if (element('#task-panel').hidden) click('.task-card');
    await wait(() => expect(element('#task-panel .detail-tabs [data-open-changes]')).toBeTruthy());
    click('[data-open-changes]');
    await wait(() => expect(element('#child-changes-host [data-change-path="work.txt"]')).toBeTruthy());
    click('#child-changes-host [data-change-path="work.txt"]');
    await wait(() => expect(element('#child-changes-host .change-diff').textContent).toContain('+one'));
    const body = element('#child-changes-host .changes-body');
    await wait(() => expect((element('[data-changes-refresh]') as HTMLButtonElement).disabled).toBe(false));
    body.scrollTop = 120; element('#child-changes-host .change-diff').scrollTop = 40;
    // An unchanged refresh leaves the list alone, even while the refresh button toggles.
    const row = element('#child-changes-host [data-change-path="work.txt"]');
    click('[data-changes-refresh]');
    await wait(() => expect((element('[data-changes-refresh]') as HTMLButtonElement).disabled).toBe(true));
    await wait(() => expect((element('[data-changes-refresh]') as HTMLButtonElement).disabled).toBe(false));
    expect(element('#child-changes-host [data-change-path="work.txt"]')).toBe(row);
    // New work rewrites the rows but not the reader's place.
    git('switch', 'task-work'); await writeFile(join(directory, 'work.txt'), 'one\ntwo\n'); git('add', 'work.txt'); git('commit', '-m', 'More'); git('switch', 'main');
    click('[data-changes-refresh]');
    await wait(() => expect(element('#child-changes-host .change-diff').textContent).toContain('+two'));
    expect(element('#child-changes-host .changes-body')).toBe(body);
    expect(body.scrollTop).toBe(120);
    expect(element('#child-changes-host .change-diff').scrollTop).toBe(40);
  });
  it('opens the context window of a task agent beside the task and maps it next to the free space', async () => {
    await createProject(); await createTask('Context work');
    const sessionId = randomUUID(), at = new Date().toISOString(), folder = join(directory, 'claude-history', 'projects', directory.replace(/[^a-zA-Z0-9]/g, '-'));
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${sessionId}.jsonl`), [
      { type: 'user', sessionId, cwd: directory, timestamp: at, message: { role: 'user', content: 'Fix checkout' } },
      { type: 'assistant', sessionId, cwd: directory, timestamp: at, message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: join(directory, 'payment.ts') } }], usage: { input_tokens: 5, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0, output_tokens: 20 } } },
      { type: 'user', sessionId, cwd: directory, timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(8000) }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const task = server.service.store.state.tasks[0]!;
    server.service.store.state.runs.push({ id: 'run_context', taskId: task.id, provider: 'claude', sessionId, status: 'completed', startedAt: at, finishedAt: at, exitCode: 0, executionMode: 'native', pendingCommands: [], continuation: 0, terminalMode: 'stream', workspacePath: directory } as never);
    task.currentRunId = 'run_context'; server.service.emit('change', server.service.snapshot());
    if (element('#task-panel').hidden) click('.task-card');
    await wait(() => expect(element('#task-panel .detail-tabs [data-open-context]').textContent).toBe('Bağlam'));
    click('[data-open-context]');
    const side = element('#agent-child-panel');
    expect(side.hidden).toBe(false); expect(side.dataset.view).toBe('context');
    await wait(() => expect(element('#child-context-host .context-window').textContent).toBe('200K'));
    expect(element('#child-context-host .context-agent-name').textContent).toBe('Claude Code');
    expect(element('#child-agent-title').textContent).toBe('Bağlam penceresi');
    // The button shows the share once the map has been read.
    await wait(() => expect(element('#task-panel [data-open-context] .nav-count').textContent).toMatch(/^\d+%$/));
    const snapshot = (await (await fetch(new URL('/api/runs/run_context/context', server.url), undefined)).json()).snapshot;
    const rects = (window as unknown as { AIWSContext: { layout: (snapshot: unknown, width: number, height: number) => any[] } }).AIWSContext.layout(snapshot, 600, 400), free = rects.find((rect: { block: { id: string } }) => rect.block.id === 'free');
    expect(free.x).toBeGreaterThan(0); expect(free.x + free.w).toBeCloseTo(600);
    expect(rects.filter((rect: { block: { id: string } }) => rect.block.id !== 'free').every((rect: { x: number; w: number; h: number }) => rect.x + rect.w <= free.x + 0.01 && rect.h > 0)).toBe(true);
    const host = element('#child-context-host'), map = element('#child-context-host .context-map');
    Object.defineProperty(map, 'clientWidth', { configurable: true, value: 600 });
    Object.defineProperty(map, 'clientHeight', { configurable: true, value: 400 });
    let openedPath = '';
    const openSpy = vi.spyOn(server.service, 'openRunContextFile').mockImplementation(async (_runId, input: any) => { openedPath = String(input?.path ?? ''); return { ok: true }; });
    const ctx = (window as unknown as { AIWSContext: { render: (host: Element, props: unknown) => void; layout: (snapshot: unknown, width: number, height: number, hidden?: Set<string>) => any[] } }).AIWSContext;
    ctx.render(host, { snapshot, agents: [{ id: 'run_context|', name: 'Claude Code', provider: 'claude', window: 200000 }], selected: 'run_context|', live: false, onOpenFile: (path: string) => server.service.openRunContextFile('run_context', { path }) });
    const badgeTokens = [...window.document.querySelectorAll('#child-context-host .context-badge')].map(badge => badge.getAttribute('data-context-toggle')).filter(id => id !== 'free').map(id => snapshot.blocks.find((block: { id: string }) => block.id === id).tokens);
    expect(badgeTokens.length).toBeGreaterThan(1); expect(badgeTokens).toEqual([...badgeTokens].sort((a, b) => b - a));
    const freeBadge = element('#child-context-host [data-context-toggle="free"]');
    expect(freeBadge.getAttribute('aria-pressed')).toBe('true');
    click('#child-context-host [data-context-toggle="free"]');
    expect(freeBadge.getAttribute('aria-pressed')).toBe('false');
    const withoutFree = ctx.layout(snapshot, 600, 400, new Set(['free']));
    expect(withoutFree.some((rect: { block: { id: string } }) => rect.block.id === 'free')).toBe(false);
    expect(Math.max(...withoutFree.map((rect: { x: number; w: number }) => rect.x + rect.w))).toBeCloseTo(600);
    click('#child-context-host .context-block[data-key="file:payment.ts"]');
    await wait(() => expect(openedPath).toBe(join(directory, 'payment.ts')));
    openSpy.mockRestore();
    click('[data-open-context]');
    expect(side.hidden).toBe(true);
  });
  it('opens token quota details from the footer, refreshes data and preserves keyboard shortcuts', async () => {
    await mkdir(join(directory,'.windows-ai-token-viewer'),{recursive:true});
    await writeFile(join(directory,'.windows-ai-token-viewer','usage-cache.json'),JSON.stringify({codex:{updated_at:new Date().toISOString(),value:{rate_limit:{primary_window:{used_percent:24,reset_at:Math.floor(Date.now()/1000)+3600},secondary_window:{used_percent:63,reset_at:Math.floor(Date.now()/1000)+86400}}}},claude:{updated_at:new Date().toISOString(),value:{five_hour:{utilization:4},seven_day:{utilization:27},buckets:[{id:'weekly_scoped:fable',label:'Weekly (Fable)',scope:'Fable',window:{usedPercent:30,resetsAt:new Date(Date.now()+86400000).toISOString(),windowMinutes:10080}}]}}}));
    expect(element('#token-countdown').getAttribute('aria-haspopup')).toBe('dialog');
    click('#token-countdown');await wait(()=>expect(element('#token-usage-detail').textContent).toContain('%24'));
    expect(element('#token-countdown').textContent).toMatch(/%76.*%37/);
    expect(element('#token-usage-detail').textContent).toContain('OpenAI Codex');
    expect(element('#token-usage-detail').textContent).toContain('Haftalık kota (Fable)');
    expect(element('#token-usage-detail').textContent).toContain('Kullanım verisi yok');
    await wait(()=>expect(element('[data-token-refresh]').hasAttribute('aria-disabled')).toBe(false));
    click('[data-token-refresh]');expect(element('[data-token-refresh]').getAttribute('aria-disabled')).toBe('true');
    await wait(()=>expect(element('[data-token-refresh]').textContent).toBe('Güncel'));
    click('#close-modal');expect(element('#modal').hasAttribute('open')).toBe(false);
    await createProject();await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));element('#create-task').dispatchEvent(new window.KeyboardEvent('keydown',{key:'n',bubbles:true}));
    expect(element('#modal').hasAttribute('open')).toBe(true);expect(window.document.querySelector('#field-title')).not.toBeNull();
  });
  it('filters task model dropdowns by provider and inherited agent, clears stale choices and saves the selection', async () => {
    const agent=server.service.catalog.createAgent({name:'Claude profile',provider:'claude',model:'sonnet'});
    await createProject();click('#create-task');
    const change=(selector:string,value:string)=>{input(selector,value);element(selector).dispatchEvent(new window.Event('change',{bubbles:true}) as unknown as Event);};
    const options=()=>[...element<HTMLSelectElement>('#field-model-choice').options].map(option=>option.value);
    expect(element('#field-model-choice').tagName).toBe('SELECT');
    expect(options()).toContain('gpt-6.1-sol');expect(options()).not.toContain('claude-sonnet-5-5');
    change('#field-model-choice','gpt-6.1-sol');expect(element<HTMLInputElement>('#field-model').value).toBe('gpt-6.1-sol');
    change('#field-provider','claude');expect(options()).toContain('claude-sonnet-5-5');expect(options()).not.toContain('gpt-6.1-sol');expect(element<HTMLInputElement>('#field-model').value).toBe('');
    change('#field-agentId',agent.id);expect(element('#field-model-choice').textContent).toContain('Agenttan · sonnet');expect(options()).toContain('claude-opus-5-5');
    change('#field-model-choice','claude-opus-5-5');input('#field-title','Selected model');submit('#modal form');
    await wait(()=>expect(server.service.snapshot().tasks).toHaveLength(1));
    expect(server.service.snapshot().tasks[0]).toMatchObject({agentId:agent.id,modelOverride:'claude-opus-5-5'});
  });
  it('supports custom agent model IDs, preserves saved IDs and updates provider model lists', async () => {
    click('#agents-nav');click('#create-task');
    const change=(selector:string,value:string)=>{input(selector,value);element(selector).dispatchEvent(new window.Event('change',{bubbles:true}) as unknown as Event);};
    change('#field-provider','opencode');
    expect(element('#field-model-choice').textContent).toContain('openai/gpt-5');
    change('#field-model-choice','__custom__');expect(element<HTMLInputElement>('#field-model').hidden).toBe(false);
    input('#field-model','gateway/private-model');input('#field-name','Custom model profile');submit('#modal form');
    await wait(()=>expect(server.service.snapshot().agents).toHaveLength(1));
    const agent=server.service.snapshot().agents[0]!;expect(agent.model).toBe('gateway/private-model');
    await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));click(`[data-edit-agent="${agent.id}"]`);
    expect(element<HTMLSelectElement>('#field-model-choice').value).toBe('gateway/private-model');
    change('#field-provider','claude');expect(element<HTMLInputElement>('#field-model').value).toBe('');expect(element('#field-model-choice').textContent).not.toContain('gateway/private-model');
    change('#field-model-choice','claude-haiku-5-5');submit('#modal form');
    await wait(()=>expect(server.service.snapshot().agents[0]).toMatchObject({provider:'claude',model:'claude-haiku-5-5'}));
  });
  it('uses the one provider, model and reasoning picker on every screen', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;const item=server.service.createTask({projectId:project.id,title:'Shared picker'});
    await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(1));
    // Every screen opens the same panel: providers beside the model list, the reasoning section below it.
    const panel=(trigger:string)=>{const button=element(trigger);expect(button.classList.contains('model-trigger')).toBe(true);button.click();const menu=element(`#${button.getAttribute('aria-controls')}`);expect(menu.hidden).toBe(false);for(const part of ['.model-providers','.model-menu-list','.model-reasoning'])expect(menu.querySelector(part),part).not.toBeNull();return menu;};
    const closeModal=async()=>{click('#close-modal');await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));};
    click('#create-task');panel('#field-model-trigger');await closeModal();
    click('#agents-nav');click('#create-task');panel('#field-model-trigger');await closeModal();
    click('[data-project]');click('#project-tab-schedules');click('[data-action="new-schedule"]');panel('.schedule-composer-bar .model-trigger');await closeModal();
    click('#project-tab-board');await wait(()=>expect(window.document.querySelector(`[data-card-agent="${item.id}"]`)).not.toBeNull());
    click(`[data-card-agent="${item.id}"]`);for(const part of ['.model-providers','.model-menu-list','.model-reasoning'])expect(element(`.card-agent-picker .model-menu ${part}`)).toBeTruthy();click(`[data-card-agent="${item.id}"]`);expect(window.document.querySelector('.card-agent-picker')).toBeNull();
    click(`[data-open-task="${item.id}"]`);click('[data-detail-tab="info"]');panel('#info-model-trigger');
  });
  it('shows the reasoning level only for models that take one and picks Antigravity levels as model variants', async () => {
    server.service.store.state.providerModels={codex:{models:[{id:'gpt-6.1-sol',efforts:['low','high']},{id:'gpt-plain',efforts:[]}],refreshedAt:new Date().toISOString(),source:'test'}};server.service.emit('change',server.service.snapshot());
    await createProject();click('#create-task');
    const menu=()=>element('#field-model-menu'),level=()=>element('#field-model-menu .model-reasoning');
    click('#field-model-trigger');click('#field-model-menu [data-provider-value="codex"]');
    click('#field-model-menu .model-option[data-model-value="gpt-6.1-sol"]');expect(element<HTMLInputElement>('#field-model').value).toBe('gpt-6.1-sol');
    expect([...element<HTMLSelectElement>('#field-reasoningEffort').options].map(option=>option.value)).toEqual(['','low','high']);expect(level().hidden).toBe(false);
    edit('#field-reasoningEffort','high');click('#field-model-trigger');click('#field-model-menu .model-option[data-model-value="gpt-plain"]');
    expect(element<HTMLSelectElement>('#field-reasoningEffort').value).toBe('');expect(level().hidden).toBe(true);
    // Antigravity names one model per level: one row per model, and the level chooses the variant.
    click('#field-model-trigger');click('#field-model-menu [data-provider-value="agy"]');
    const names=[...menu().querySelectorAll('.model-option-name>span:first-child')].map(node=>node.textContent);
    expect(names).toContain('gemini-4-argon');expect(names).not.toContain('gemini-4-argon-high');expect(names).toContain('gpt-oss-120b-medium');
    click('#field-model-menu .model-option[data-model-value="gemini-4-argon-medium"]');expect(element<HTMLInputElement>('#field-model').value).toBe('gemini-4-argon-medium');
    click('#field-model-trigger');expect(level().hidden).toBe(false);expect(level().classList.contains('is-model-level')).toBe(true);
    expect([...level().querySelectorAll('.view-tab')].map(tab=>(tab as HTMLElement).dataset.level)).toEqual(['low','medium','high']);
    click('#field-model-menu .view-tab[data-level="high"]');expect(element<HTMLInputElement>('#field-model').value).toBe('gemini-4-argon-high');expect(element<HTMLSelectElement>('#field-reasoningEffort').value).toBe('');
    expect(element('#field-model-trigger .model-trigger-level').hidden).toBe(false);
    click('#field-model-menu .model-option[data-model-value="gpt-oss-120b-medium"]');click('#field-model-trigger');expect(level().hidden).toBe(true);
    input('#field-title','Antigravity level');submit('#modal form');
    await wait(()=>expect(server.service.snapshot().tasks[0]).toMatchObject({provider:'agy',model:'gpt-oss-120b-medium'}));expect(server.service.snapshot().tasks[0]!.reasoningEffort).toBeUndefined();
  });
  it('shows checked, draining and unchecked system states and toggles the real API', async () => {
    const checkbox = () => element<HTMLInputElement>('#system-enabled');
    expect(checkbox().checked).toBe(true);
    click('#system-enabled');
    await wait(() => expect(server.service.snapshot().settings.systemEnabled).toBe(false));
    await wait(() => expect(element('#system-status').textContent).toBe('Sistem durdu'));
    expect(checkbox().checked).toBe(false);
    click('#system-enabled');
    await wait(() => expect(server.service.snapshot().settings.systemEnabled).toBe(true));
    await wait(() => expect(checkbox().disabled).toBe(false));
    const project = server.service.createProject({ name: 'Drain UI', repositoryPath: directory });
    const task = server.service.createTask({ projectId: project.id, title: 'Working', provider: 'command', command: { executable: process.execPath, args: ['-e', 'process.stdin.resume();setTimeout(()=>process.exit(0),1500)'] } });
    const run = server.service.startTask(task.id);
    await wait(() => expect(checkbox().checked).toBe(true));
    click('#system-enabled');
    await wait(() => expect(element('#system-status').textContent).toBe('Durduruluyor…'));
    expect(checkbox().indeterminate).toBe(true);
    expect(element('#system-control').getAttribute('aria-busy')).toBe('true');
    expect(element<HTMLElement>('#system-control .ui-spinner').hidden).toBe(false);
    await wait(() => expect(element('#system-status').textContent).toBe('Sistem durdu'));
    expect(server.service.run(run.id).status).toBe('completed');
    expect(checkbox().indeterminate).toBe(false);
    expect(checkbox().checked).toBe(false);
    expect(element<HTMLElement>('#system-control .ui-spinner').hidden).toBe(true);
  });
  it('shows titles on the timeline, zooms it and opens the shared task detail from a bar', async () => {
    const project = server.service.createProject({ name: 'Timeline QA', repositoryPath: directory });
    const task = server.service.createTask({ projectId: project.id, title: 'Timeline work', provider: 'command', command: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } });
    const run = server.service.startTask(task.id);
    await wait(() => expect(server.service.run(run.id).status).toBe('completed'));
    await wait(() => expect(window.eval(`state.runs.some(run=>run.id==='${run.id}'&&run.finishedAt)`)).toBe(true));
    window.eval(`openProject('${project.id}')`);
    click('#timeline-view');
    const bar = `.timeline-bar[data-run="${run.id}"]`;
    await wait(() => expect(element(bar).textContent).toBe('Timeline work'));
    expect(element(bar).dataset.openTask).toBe(task.id);
    // The click stays open past the document's outside-click handler, in the panel the board uses.
    click(bar);
    await wait(() => expect(element('#task-detail-title').textContent).toBe('Timeline work'));
    expect(element('#task-panel').hidden).toBe(false);
    expect(window.document.querySelector('#task-panel .detail-project')).toBeNull();
    click('#close-panel');
    await wait(() => expect(element('#task-panel').hidden).toBe(true));
    const before = element('.timeline-zoom-level').textContent;
    click('[data-zoom=in]');
    await wait(() => expect(element('.timeline-zoom-level').textContent).not.toBe(before));
    expect(element('.timeline-now').hidden).toBe(false);
    click('[data-zoom=out]');
    await wait(() => expect(element('.timeline-zoom-level').textContent).toBe(before));
    expect(element('[data-range].active').dataset.range).toBeTruthy();
    window.eval(`switchScreen('overview')`);
    await wait(() => expect(element(bar).textContent).toBe('Timeline QATimeline work'));
    expect(element(`${bar} .timeline-bar-project`).textContent).toBe('Timeline QA');
    click('#board-view');
  });
  async function createTask(title = 'Implement renderer flow'): Promise<void> {
    click('#create-task'); input('#field-title', title); input('#field-description', 'Verify actual API persistence and streaming.'); submit('#modal form');
    await wait(() => expect(window.document.querySelectorAll('.task-card')).toHaveLength(1));
    await wait(() => expect(element('#modal').hasAttribute('open')).toBe(false));
    click('[data-open-task]');
  }
  // A console built for the first time mounts on the frame after its skeleton.
  const consoleMounted = () => wait(() => expect(window.document.querySelector('#agent-console-host:not([data-loading]) [data-aiws-conversation]')).not.toBeNull());
  it('keeps a terminal run chat behind the skeleton until its transcript is read', async () => {
    await createProject(); await createTask();
    window.eval(`(()=>{
      const realApi=api,gate=new Promise(resolve=>{window.__openTranscript=resolve;});
      window.api=async (path,...rest)=>{
        if(path==='/runs/pty-run/agents')return {agentTree:{rootId:'root',agents:[{id:'root',transcriptAvailable:true}]},sourceAvailable:true,warnings:[]};
        if(path.startsWith('/runs/pty-run/agents/root/transcript')){await gate;return {runs:[],events:[],messages:[{id:'loaded-message',authorType:'user',authorName:'You',text:'Okunan sohbet',createdAt:new Date().toISOString()}],nextCursor:null};}
        return realApi(path,...rest);
      };
      window.__ptyRun={id:'pty-run',taskId:state.tasks[0].id,provider:historyProviders[0],terminalMode:'pty',status:'running',startedAt:new Date(Date.now()-60000).toISOString(),events:[]};
      window.__mountPty=()=>{if(!state.runs.includes(window.__ptyRun))state.runs.push(window.__ptyRun);detailTab='console';mountTaskConsole({...state.tasks[0],currentRunId:'pty-run'},window.__ptyHost);};
      window.__ptyHost=document.createElement('div');document.body.append(window.__ptyHost);window.__mountPty();
    })()`);
    const host = (window as any).__ptyHost as HTMLElement;
    expect(host.querySelector('.console-skeleton')).not.toBeNull();
    expect(host.querySelector('[data-aiws-conversation]')).toBeNull();
    (window as any).__openTranscript();
    await wait(() => expect(window.eval(`rootTranscriptPending('/runs/pty-run/agents',()=>{})`)).toBe(false));
    window.eval('__mountPty()');
    expect(host.querySelector('.console-skeleton')).toBeNull();
    await wait(() => expect(host.textContent).toContain('Okunan sohbet'));
  });
  it('lets plugins extend the shell, pages, project tabs, task editor, task detail, cards, themes and the plugins settings page', async () => {
    await createProject();
    await wait(() => expect(window.eval('typeof AIWSPlugins.list')).toBe('function'));
    window.eval(`AIWSPlugins.activate({id:'acme.ui'},{activate(aiws){
      const id=aiws.plugin.id;window.__pluginAiws=aiws;
      aiws.sidebar.addItem({id:'stats',label:{tr:'İstatistik',en:'Stats'},icon:'check',page:'stats',badge:()=>7});
      aiws.pages.register({id:'stats',title:'İstatistik sayfası',summary:'Eklenti özeti',render(container){container.innerHTML=aiws.ui.html\`<p id="plugin-page-body">\${'<b>kaçış</b>'}</p>\`;return {update(){window.__pageUpdates=(window.__pageUpdates||0)+1;},unmount(){window.__pageUnmounted=true;}};}});
      aiws.topbar.addButton({id:'ping',label:'Ping',onClick:()=>aiws.ui.toast('pong')});
      aiws.projectTabs.add({id:'notes',label:'Notlar',render(container,ctx){container.innerHTML='<p id="plugin-tab-body">'+aiws.ui.esc(ctx.project.name)+'</p>';}});
      aiws.taskForm.addSection({id:'estimate',title:'Tahmin',placement:'main',render(container,ctx){container.innerHTML='<input id="plugin-estimate" value="'+(ctx.data.estimate??'')+'">';return {validate:()=>container.querySelector('#plugin-estimate').value==='x'?'Sayı gir':null,collect:()=>({estimate:Number(container.querySelector('#plugin-estimate').value)})};}});
      aiws.taskForm.addSection({id:'risk',title:'Risk',render(container){container.innerHTML='<select id="plugin-risk"><option value="high">high</option></select>';},collect:container=>({risk:container.querySelector('#plugin-risk').value})});
      aiws.taskCard.addBadge({id:'estimate',render:task=>task.pluginData?.[id]?.estimate?{text:task.pluginData[id].estimate+' SP',tone:'accent'}:null});
      aiws.taskDetail.addSection({id:'plan',title:'Plan',placement:'sidebar',render(container,ctx){container.innerHTML='<p id="plugin-detail-section">'+ctx.data.estimate+'</p>';return {update(next){container.querySelector('p').textContent=String(next.data.estimate);}};}});
      aiws.taskDetail.addTab({id:'checks',label:'Kontroller',render(container,ctx){container.innerHTML='<p id="plugin-detail-tab">'+aiws.ui.esc(ctx.task.title)+'</p>';}});
      aiws.taskDetail.addAction({id:'mark',label:'İşaretle',run:ctx=>{window.__actionTask=ctx.task.id;}});
      aiws.themes.register({id:'night',name:'Gece',dark:{surface:'#101010',accent:'#ff00aa'},light:{accent:'#aa0055'}});
      aiws.events.on('task:created',({task})=>{window.__createdTitle=task.title;});
    }})`);
    await wait(() => expect(element('#plugin-nav').hidden).toBe(false));
    expect(element('#plugin-nav-label').hidden).toBe(false);
    expect(element('[data-plugin-nav="acme.ui/stats"]').textContent).toContain('İstatistik');
    expect(element('[data-plugin-nav="acme.ui/stats"] .nav-count').textContent).toBe('7');
    expect(element('[data-plugin-topbar="acme.ui/ping"]').textContent).toBe('Ping');

    click('[data-plugin-nav="acme.ui/stats"]');
    await wait(() => expect(element('#plugin-page-body').innerHTML).toBe('&lt;b&gt;kaçış&lt;/b&gt;'));
    expect(element('#breadcrumb-project').textContent).toBe('İstatistik sayfası');
    expect(element('[data-plugin-nav="acme.ui/stats"]').classList.contains('active')).toBe(true);
    expect(element('#board').classList.contains('plugin-page-board')).toBe(true);
    window.eval('render()'); expect(window.eval('window.__pageUpdates')).toBeGreaterThan(0);

    click(`[data-project="${server.service.snapshot().projects[0]!.id}"]`);
    await wait(() => expect(window.eval('window.__pageUnmounted')).toBe(true));
    click('[data-plugin-project-tab="plugin:acme.ui/notes"]');
    await wait(() => expect(element('#plugin-tab-body').textContent).toBe('Renderer QA'));
    expect(element('[data-plugin-project-tab="plugin:acme.ui/notes"]').getAttribute('aria-selected')).toBe('true');
    expect(element('#project-tab-board').getAttribute('aria-selected')).toBe('false');
    click('#project-tab-board');

    click('#create-task');
    await wait(() => expect(element('#modal').hasAttribute('open')).toBe(true));
    expect(element('[data-plugin-slot="task-form-main"] #plugin-estimate')).toBeTruthy();
    expect(element('#task-tab-plugin-acme-ui-risk').textContent).toContain('Risk');
    expect(element('#task-options-plugin-acme-ui-risk #plugin-risk')).toBeTruthy();
    input('#field-title', 'Plugin task'); input('#plugin-estimate', 'x'); submit('#modal form');
    await wait(() => expect(element('#modal .form-error').textContent).toContain('Tahmin: Sayı gir'));
    input('#plugin-estimate', '5'); submit('#modal form');
    await wait(() => expect(server.service.snapshot().tasks).toHaveLength(1));
    expect(server.service.snapshot().tasks[0]!.pluginData).toEqual({ 'acme.ui': { estimate: 5, risk: 'high' } });
    await wait(() => expect(element('.task-card .plugin-card-badge').textContent).toBe('5 SP'));
    expect(element('.task-card .plugin-card-badge').getAttribute('data-tone')).toBe('accent');
    await wait(() => expect(window.eval('window.__createdTitle')).toBe('Plugin task'));

    click('[data-open-task]'); click('#detail-tab-info');
    await wait(() => expect(element('[data-plugin-slot="task-detail-sidebar"] #plugin-detail-section').textContent).toBe('5'));
    const task = server.service.snapshot().tasks[0]!;
    await window.eval(`window.__pluginAiws.tasks.setData('${task.id}',{estimate:8,risk:'high'})`);
    await wait(() => expect(element('#plugin-detail-section').textContent).toBe('8'));
    click('[data-plugin-task-action="acme.ui/mark"]'); expect(window.eval('window.__actionTask')).toBe(task.id);
    click('[data-detail-tab="plugin:acme.ui/checks"]');
    await wait(() => expect(element('#plugin-detail-tab').textContent).toBe('Plugin task'));

    window.eval(`window.__pluginAiws.themes.apply('night')`);
    expect(window.document.documentElement.dataset.pluginTheme).toBe('acme.ui/night');
    expect(element('#plugin-theme-style').textContent).toContain('--surface:#101010');
    expect(element('#plugin-theme-style').textContent).toContain('[data-theme=light]{--accent:#aa0055}');

    window.eval(`AIWSPlugins.deactivate('acme.ui')`);
    await wait(() => expect(element('#plugin-nav').hidden).toBe(true));
    expect(window.document.querySelector('[data-plugin-topbar]')).toBeNull();
    expect(window.document.querySelector('[data-detail-tab="plugin:acme.ui/checks"]')).toBeNull();
    expect(window.document.documentElement.dataset.pluginTheme).toBeUndefined();

    click('#settings-button'); click('#settings-tab-plugins');
    await wait(() => expect(element('#plugins-settings [data-plugin-skill-install]').textContent).toContain('Skill’i yükle'));
    expect(element('#plugin-install-path')).toBeTruthy();
    // Only the plugins that ship with AIWS remain: they say so and offer no way to remove them.
    await wait(() => expect(window.document.querySelectorAll('#plugins-settings .plugin-card')).toHaveLength(4));
    expect(element('#plugins-settings').textContent).toContain('Yerleşik');
    expect(window.document.querySelector('#plugins-settings [data-plugin-uninstall]')).toBeNull();
  });

  it('keeps the real Markdown editor usable across draft minimization and other dialogs', async () => {
    window.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} }) as any;
    window.Range.prototype.getClientRects = () => [] as any;
    for (const path of ['../../node_modules/easymde/dist/easymde.min.js', '../../node_modules/dompurify/dist/purify.min.js', '../images/attachments.js', '../images/file-mentions.js', '../images/markdown-editor.js', '../images/image-viewer.js', '../images/paste-path.js']) window.eval(await readFile(new URL(path, import.meta.url), 'utf8'));
    await createProject();click('#create-task');input('#field-title','Markdown draft');
    const form=element('#task-editor-form'),cm=(element('.CodeMirror') as any).CodeMirror;
    cm.setValue('Initial **description**');cm.setCursor(0,7);
    const refresh=vi.spyOn(cm,'refresh');
    for(let cycle=0;cycle<3;cycle++){
      const cursor=cm.getCursor(),value=cm.getValue();
      element('#modal').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}) as unknown as Event);
      if(cycle){click('#create-project');click('#close-modal');}
      click('#restore-task-draft');
      expect(element('#task-editor-form')).toBe(form);
      expect(window.document.querySelectorAll('.EasyMDEContainer')).toHaveLength(1);
      expect((element('.CodeMirror') as any).CodeMirror).toBe(cm);
      expect(refresh).toHaveBeenCalledTimes(cycle+1);expect(cm.getCursor()).toEqual(cursor);
      expect(cm.getValue()).toBe(value);
      cm.replaceSelection(` edit${cycle}`);
      expect(element<HTMLTextAreaElement>('#field-description').value).toBe(cm.getValue());
    }
    const description=cm.getValue();submit('#task-editor-form');
    await wait(()=>expect(server.service.snapshot().tasks[0]?.description).toBe(description));
    await wait(()=>expect(window.document.querySelector('.EasyMDEContainer')).toBeNull());
    click('#create-task');expect((element('.CodeMirror') as any).CodeMirror.getValue()).toBe('');click('#close-modal');
  });
  it('shows the full task activity history across runs in chronological order and updates it live', async () => {
    await createProject();await createTask('Activity history');click('[data-detail-tab="info"]');
    expect(element('.task-activity-history').textContent).toContain('henüz işlem kaydı yok');
    expect(element('.detail-information').textContent).not.toContain('Son işlem');
    const task=server.service.snapshot().tasks[0]!;
    const event=(id:string,taskId:string,type:string,message:string,createdAt:string,runId:string|null)=>({id,taskId,type,message,createdAt,runId});
    const first=event('first',task.id,'started','First run started','2026-10-15T10:00:00Z','run_first');
    const second=event('second',task.id,'completed','Full result\n'+ 'detail '.repeat(40)+'<img src=x onerror=alert(1)>','2026-10-15T11:00:00Z','run_first');
    const third=event('third',task.id,'started','Second run started','2026-10-16T10:00:00Z','run_second');
    server.service.store.state.events.push(third,first,second,event('other','another-task','failed','Unrelated task','2026-10-16T11:00:00Z',null),event('terminal',task.id,'terminal.output','Raw terminal control stream','2026-10-16T11:00:00Z','run_second'));
    server.service.updateTask(task.id,{priority:3});
    await wait(()=>expect(window.document.querySelectorAll('.task-activity-history li')).toHaveLength(3));
    expect([...window.document.querySelectorAll('.task-activity-history li')].map(row=>row.getAttribute('data-activity-id'))).toEqual(['first','second','third']);
    expect(element('[data-activity-id="second"] p').textContent).toBe(second.message);
    expect(window.document.querySelector('.task-activity-history img')).toBeNull();
    expect(element('.task-activity-history').textContent).not.toContain('Unrelated task');
    expect(element('.task-activity-history').textContent).not.toContain('Raw terminal');
    expect(element('[data-activity-id="first"] time').getAttribute('datetime')).toBe(first.createdAt);
    expect(element('[data-activity-id="third"] .task-activity-meta').textContent).toContain('SECOND');
    element('.detail-information').scrollTop=120;
    server.service.store.state.events.push(event('fourth',task.id,'paused','Paused second run','2026-10-16T12:00:00Z','run_second'));
    server.service.updateTask(task.id,{priority:2});
    await wait(()=>expect(window.document.querySelectorAll('.task-activity-history li')).toHaveLength(4));
    expect(element('.detail-information').scrollTop).toBe(120);
    click('[data-detail-tab="console"]');click('[data-detail-tab="info"]');
    expect(window.document.querySelectorAll('.task-activity-history li')).toHaveLength(4);
  });
  it('closes a finished task with its reply or completion summary, not the agent\'s last chat line', async () => {
    await createProject();await createTask('Final status');click('[data-detail-tab="info"]');
    const task=server.service.snapshot().tasks[0]!,state=server.service.store.state as any,createdAt=new Date().toISOString();
    const message=(id:string,authorType:string,text:string,runId:string)=>({id,taskId:task.id,authorType,text,runId,createdAt});
    const completed=(id:string,text:string,runId:string)=>({id,taskId:task.id,type:'completed',message:text,createdAt,runId});
    const finalStatus=()=>window.document.querySelector('.task-final-status .task-description')?.textContent?.trim();
    const refresh=(priority:number)=>{state.tasks.find((item:any)=>item.id===task.id).status='done';server.service.updateTask(task.id,{priority});};
    state.messages.push(message('m1','agent','Önce videoları inceleyeyim.','run_exit'),message('m2','system','Execution completed.','run_exit'));
    state.events.push(completed('e1','Provider finished. Review the workspace and results.','run_exit'));
    refresh(1);
    await wait(()=>expect(finalStatus()).toBe('Önce videoları inceleyeyim.'));
    state.messages.push(message('m3','agent','Yine ilk mesaj.','run_summary'),message('m4','system','Özet metni','run_summary'));
    state.events.push(completed('e2','Özet metni','run_summary'));
    refresh(2);
    await wait(()=>expect(finalStatus()).toBe('Özet metni'));
    state.runs.push({...structuredClone(state.runs[0]??{}),id:'run_reply',taskId:task.id,provider:'claude',status:'completed',startedAt:createdAt,reply:'Ajanın yanıtı'});
    state.messages.push(message('m5','system','Başka özet','run_reply'));
    state.events.push(completed('e3','Başka özet','run_reply'));
    refresh(3);
    await wait(()=>expect(finalStatus()).toBe('Ajanın yanıtı'));
  });
  it('shows task information without repeats: title edit, folded settings, usage chart, replies and dialogs', async () => {
    await createProject();await createTask('Info polish');click('[data-detail-tab="info"]');
    const task=server.service.snapshot().tasks[0]!,at=new Date().toISOString(),dialog=(rule:string)=>'☐ Kurulum\n\n```\nSunucuya kurayım mı?\n```\n\n1. Kur (Önerilen)\n2. Kurma\n3. Type something. '+rule+'\n4. Chat about this',reply='# Sonuç\n'+'satır\n'.repeat(10);
    expect(element('[data-info-more]').hasAttribute('open')).toBe(false);expect(element('[data-info-more] #info-scheduledAt')).not.toBeNull();expect(element('[data-info-more] #info-tags')).not.toBeNull();
    server.service.store.state.runs.push({id:'run_info',taskId:task.id,provider:'codex',status:'completed',startedAt:at,finishedAt:at,exitCode:0,executionMode:'native',pendingCommands:[],continuation:0,terminalMode:'stream',reply:reply.trim(),executionInfo:{model:'gpt-6.1-sol',cwd:'C:/very/long/path'},usage:{inputTokens:1000000,outputTokens:100000,cacheReadTokens:500000,cacheWriteTokens:0,totalTokens:1100000,costUsd:null,recordedAt:at}} as never);
    for(const [id,type,message] of [['q1','question',dialog('───')],['q2','question',dialog('─────')],['r1','reply',reply.trim()]])server.service.store.state.events.push({id,taskId:task.id,runId:'run_info',type,message,createdAt:at} as never);
    server.service.emit('change',server.service.snapshot());
    await wait(()=>expect(window.document.querySelectorAll('.issue-panel .usage-breakdown-bar').length).toBeGreaterThan(0));
    const usagePanel=element('#issue-usage-title').closest('.issue-panel')!;
    expect(usagePanel.querySelector('.context-map')).toBeNull();
    expect([...usagePanel.querySelectorAll('.usage-breakdown-row[data-kind]')].map(row=>row.getAttribute('data-kind'))).toEqual(['input','cache-read','output']);
    expect(usagePanel.querySelector<HTMLElement>('[data-kind=output] .usage-breakdown-bar i')!.style.width).toMatch(/^9\.09/);
    expect(element('#issue-usage-title').closest('.issue-panel')!.textContent).not.toContain('$');
    expect(element('[data-activity-id="q1"] .task-activity-question').textContent).toContain('Sunucuya kurayım mı?');expect(element('[data-activity-id="q1"]').textContent).not.toContain('Type something');
    expect(window.document.querySelector('[data-activity-id="q2"]')).toBeNull();
    const fold=element('[data-activity-fold="r1"]');expect(fold.querySelector('h1,h2,h3,h4')).not.toBeNull();expect(fold.classList.contains('is-open')).toBe(false);
    expect(element('[data-run-summary="run_info"] .run-summary-body').querySelector('.cv-markdown')).toBeNull();    expect(element('[data-execution-cwd] .copy-field').getAttribute('title')).toBe('C:/very/long/path');
    click('#task-detail-title button');const input=element<HTMLInputElement>('#task-title-edit');input.value='Yeni başlık';input.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}) as unknown as Event);
    await wait(()=>expect(server.service.task(task.id).title).toBe('Yeni başlık'));
  });
  it('keeps the Files toggle clickable inside the new task dialog without dismissing the draft', async () => {
    await createProject();click('#create-task');
    const toggle=element<HTMLButtonElement>('#files-toggle');
    expect(toggle.closest('.modal-header')).toBe(element('.modal-header'));
    click('#files-toggle');
    await wait(()=>expect(element('#files-panel').hidden).toBe(false));
    expect(element('#modal').hasAttribute('open')).toBe(true);
    expect(element('#task-editor-form')).toBeTruthy();
    element<HTMLButtonElement>('#close-modal').click();
    expect(toggle.parentElement).toBe(element('.topbar-right'));
  });
  it('minimizes a new task on outside click and resumes the same draft after using another dialog', async () => {
    await createProject();click('#create-task');input('#field-title','Unfinished task');input('#field-description','Keep this description');
    const form=element('#task-editor-form');(element('#task-advanced') as HTMLDetailsElement).open=true;input('#field-priority','3');
    element('#field-description').focus();element<HTMLTextAreaElement>('#field-description').setSelectionRange(3,7);element('#task-editor-scroll').scrollTop=120;
    element('#modal').dispatchEvent(new window.MouseEvent('click',{bubbles:true,clientX:-10,clientY:-10}) as unknown as Event);
    expect(element('#modal').hasAttribute('open')).toBe(false);expect(element('#restore-task-draft').textContent).toContain('Devam et');expect(server.service.snapshot().tasks).toHaveLength(0);
    click('#create-project');expect(element('#modal h2').textContent).toBe('Yeni proje');click('#close-modal');click('#restore-task-draft');
    expect(element('#task-editor-form')).toBe(form);expect(element<HTMLInputElement>('#field-title').value).toBe('Unfinished task');expect(element<HTMLTextAreaElement>('#field-description').value).toBe('Keep this description');expect(element<HTMLDetailsElement>('#task-advanced').open).toBe(true);expect(element<HTMLSelectElement>('#field-priority').value).toBe('3');expect(window.document.activeElement).toBe(element('#field-description'));
    expect(element<HTMLTextAreaElement>('#field-description').selectionStart).toBe(3);expect(element<HTMLTextAreaElement>('#field-description').selectionEnd).toBe(7);expect(element('#task-editor-scroll').scrollTop).toBe(120);
    element('#modal').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}) as unknown as Event);click('#create-task');expect(element('#task-editor-form')).toBe(form);
    submit('#task-editor-form');await wait(()=>expect(server.service.snapshot().tasks).toHaveLength(1));await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));
    expect(server.service.snapshot().tasks[0]).toMatchObject({title:'Unfinished task',description:'Keep this description',priority:3});expect(window.document.querySelector('#restore-task-draft')).toBeNull();
    click('#create-task');expect(element<HTMLInputElement>('#field-title').value).toBe('');click('[data-action="close-modal"]');expect(window.document.querySelector('#restore-task-draft')).toBeNull();
  });
  it('saves the typed new task on the server so a reload or restart resumes it', async () => {
    await createProject();click('#create-task');edit('#field-title','Crash safe');edit('#field-description','Typed before the freeze');
    await wait(()=>expect(server.service.taskDraft.get()).toMatchObject({title:'Crash safe',description:'Typed before the freeze'}));
    // A reload drops the editor and every in-page draft; only the server copy remains.
    element<HTMLDialogElement>('#modal').close();window.eval('savedTaskDraft=null;void loadSavedTaskDraft();');
    await wait(()=>expect(element('#restore-task-draft').textContent).toContain('Devam et'));
    click('#restore-task-draft');
    expect(element<HTMLInputElement>('#field-title').value).toBe('Crash safe');expect(element<HTMLTextAreaElement>('#field-description').value).toBe('Typed before the freeze');expect(window.document.querySelector('#restore-task-draft')).toBeNull();
    submit('#task-editor-form');await wait(()=>expect(server.service.snapshot().tasks).toHaveLength(1));
    await wait(()=>expect(server.service.taskDraft.get()).toBeNull());
    click('#create-task');expect(element<HTMLInputElement>('#field-title').value).toBe('');edit('#field-title','Thrown away');
    await wait(()=>expect(server.service.taskDraft.get()).toMatchObject({title:'Thrown away'}));
    click('#close-modal');await wait(()=>expect(server.service.taskDraft.get()).toBeNull());
  });
  it('closes creation without opening task details and only offers create-another for new tasks', async () => {
    await createProject();click('#create-task');
    expect(element<HTMLInputElement>('#task-create-another').checked).toBe(false);
    expect(element('#task-create-another').closest('.modal-footer')).not.toBeNull();
    input('#field-title','Created quietly');submit('#task-editor-form');
    await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));
    await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(1));
    expect(element('#task-panel').hidden).toBe(true);
    click('[data-open-task]');expect(window.document.querySelector('[data-action="edit-task"]')).toBeNull();click('[data-detail-tab="info"]');
    expect(element('#modal').hasAttribute('open')).toBe(false);
    commit('#info-title','Edited quietly');
    await wait(()=>expect(server.service.snapshot().tasks[0]?.title).toBe('Edited quietly'));
    expect(element('#task-panel').hidden).toBe(false);await wait(()=>expect(element('#task-detail-title').textContent).toBe('Edited quietly'));
  });
  it('edits every task field inline from the Bilgiler tab and persists each through the API', async () => {
    await withLibrary();
    const skill=server.service.catalog.createSkill({name:'Inline skill',content:'# Skill',files:[]});const agent=server.service.catalog.createAgent({name:'Inline agent',provider:'claude',model:'sonnet'});
    await createProject();const project=server.service.snapshot().projects[0]!;const workflow=server.service.workflows.create({name:'Inline workflow',steps:[{id:'one',name:'Implement',agentId:agent.id,instructions:'',condition:'always'}]});
    await createTask('Inline fields');const id=server.service.snapshot().tasks[0]!.id,saved=()=>server.service.task(id);
    click('[data-detail-tab="info"]');
    for(const selector of ['#info-title','#info-priority','#detail-status','#info-agentId','#info-model-trigger','#info-provider','#info-model-choice','#info-tags','#info-blocked-search','#info-workflowId','#info-workflowRequested','#info-baseBranch','#info-deployRequested','#info-autoMerge','input[name="info-skillIds"]'])expect(window.document.querySelector(selector),selector).not.toBeNull();
    expect(element('.issue-sidebar').textContent).toContain('Ayrıntılar');expect(element('.issue-timestamps').textContent).toContain(id);
    // The interface comes from the run itself; the info tab no longer offers a picker.
    expect(window.document.querySelector('#info-terminalMode')).toBeNull();
    commit('#info-tags','frontend, polish');await wait(()=>expect(saved().tags).toEqual(['frontend','polish']));
    // Tags become project labels and show as removable chips.
    await wait(()=>expect(server.service.project(project.id).labels?.map(label=>label.name)).toEqual(['frontend','polish']));
    await wait(()=>expect(element('[data-info-row="tags"] .label-chips').textContent).toContain('polish'));
    commit('#info-tags','Frontend, deploy');await wait(()=>expect(saved().tags).toEqual(['frontend','polish','deploy']));
    await wait(()=>expect(window.document.querySelector('[data-info-remove-tag="deploy"]')).not.toBeNull());click('[data-info-remove-tag="deploy"]');await wait(()=>expect(saved().tags).toEqual(['frontend','polish']));
    commit('#info-provider','claude');await wait(()=>expect(saved().providerOverride).toBe('claude'));
    await wait(()=>expect([...element<HTMLSelectElement>('#info-model-choice').options].map(option=>option.value)).toContain('claude-opus-5-5'));commit('#info-model-choice','claude-opus-5-5');await wait(()=>expect(saved().model).toBe('claude-opus-5-5'));
    await wait(()=>expect(element<HTMLInputElement>('#info-model').value).toBe('claude-opus-5-5'));commit('#info-reasoningEffort','high');await wait(()=>expect(saved()).toMatchObject({model:'claude-opus-5-5',reasoningEffort:'high'}));
    commit('#info-model-choice','__custom__');expect(element<HTMLInputElement>('#info-model').hidden).toBe(false);edit('#info-model','gateway/custom');await wait(()=>expect(saved().model).toBe('gateway/custom'));
    commit('#info-agentId',agent.id);await wait(()=>expect(saved()).toMatchObject({agentId:agent.id,provider:'claude'}));expect(saved().providerOverride).toBeUndefined();
    await wait(()=>expect(element('#info-model-choice option[value=""]').textContent).toContain('sonnet'));
    element<HTMLInputElement>(`input[name="info-skillIds"][value="${skill.id}"]`).checked=true;commit(`input[name="info-skillIds"][value="${skill.id}"]`);await wait(()=>expect(saved().skillIds).toEqual([skill.id]));
    commit('#info-workflowId',workflow.id);await wait(()=>expect(saved().workflowId).toBe(workflow.id));
    element<HTMLInputElement>('#info-workflowRequested').checked=true;commit('#info-workflowRequested');await wait(()=>expect(saved().workflowRequested).toBe(true));
    element<HTMLInputElement>('#info-deployRequested').checked=true;commit('#info-deployRequested');await wait(()=>expect(saved().requestedActions).toEqual(['deploy']));
    element<HTMLInputElement>('#info-autoMerge').checked=true;commit('#info-autoMerge');await wait(()=>expect(saved().autoMerge).toBe(true));
    commit('#info-priority','1');await wait(()=>expect(saved().priority).toBe(1));
    commit('#detail-status','review');await wait(()=>expect(saved().status).toBe('review'));commit('#detail-status','backlog');await wait(()=>expect(saved().status).toBe('backlog'));
    commit('#info-baseBranch','');await wait(()=>expect(element('#info-save-status').textContent).toContain('boş bırakılamaz'));
    // A task with a description may have an empty title; cards then show a description excerpt.
    commit('#info-title','');await wait(()=>expect(saved().title).toBe(''));
    // The description editor survives live updates and saves only on explicit save.
    click('[data-info-edit-description]');input('#info-description','## Inline description\n\nAccepted');server.service.updateTask(id,{priority:2});await wait(()=>expect(saved().priority).toBe(2));
    await new Promise(resolve=>setTimeout(resolve,100));expect(element<HTMLTextAreaElement>('#info-description').value).toBe('## Inline description\n\nAccepted');
    element('#info-description').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}) as unknown as Event);
    await wait(()=>expect(saved().description).toBe('## Inline description\n\nAccepted'));await wait(()=>expect(element('.task-description h4').textContent).toBe('Inline description'));
    click('[data-info-edit-description]');input('#info-description','Discard me');element('#info-description').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}) as unknown as Event);
    expect(element('#task-panel').hidden).toBe(false);await wait(()=>expect(window.document.querySelector('#info-description')).toBeNull());expect(saved().description).toBe('## Inline description\n\nAccepted');
    commit('#info-provider','command');await wait(()=>expect(window.document.querySelector('#info-executable')).not.toBeNull());expect(saved().provider).toBe('claude');
    input('#info-args','["-e","process.exit(0)"]');commit('#info-executable',process.execPath);await wait(()=>expect(saved()).toMatchObject({provider:'command',command:{executable:process.execPath,args:['-e','process.exit(0)']}}));
    expect(project.id).toBe(saved().projectId);
  },30000);

  it('creates a task with Ctrl+Enter while preserving validation and ordinary Enter', async () => {
    await createProject();click('#create-task');
    const keydown=(selector:string,options:KeyboardEventInit={})=>{
      const event=new window.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true,...options});
      element(selector).dispatchEvent(event as unknown as Event);return event;
    };
    const create=vi.spyOn(server.service,'createTask');
    expect(keydown('#field-title').defaultPrevented).toBe(true);
    // The title is optional, so an empty form reaches the server, which rejects it without a description.
    await wait(()=>expect(element('.form-error').textContent).toContain('description'));
    expect(server.service.snapshot().tasks).toHaveLength(0);expect(element('#modal').hasAttribute('open')).toBe(true);create.mockClear();
    input('#field-title','Keyboard task');input('#field-description','First line\nSecond line');
    expect(keydown('#field-description',{ctrlKey:false}).defaultPrevented).toBe(false);
    expect(keydown('#field-description',{isComposing:true}).defaultPrevented).toBe(false);
    expect(keydown('#field-description',{repeat:true}).defaultPrevented).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(keydown('#field-description').defaultPrevented).toBe(true);
    keydown('#field-description');
    await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));
    expect(create).toHaveBeenCalledTimes(1);
    expect(server.service.snapshot().tasks).toHaveLength(1);
    expect(server.service.snapshot().tasks[0]).toMatchObject({title:'Keyboard task',description:'First line\nSecond line'});
  });

  it('resets the entire editor after successful creation and supports consecutive tasks until unchecked', async () => {
    await createProject();click('#create-task');
    element<HTMLInputElement>('#task-create-another').checked=true;
    input('#field-title','First task');input('#field-description','First description');
    input('#field-tags','frontend');input('#field-priority','3');
    element('#task-advanced').setAttribute('open','');
    submit('#task-editor-form');submit('#task-editor-form');
    await wait(()=>expect(element<HTMLInputElement>('#field-title').value).toBe(''));
    expect(server.service.snapshot().tasks).toHaveLength(1);
    expect(element('#modal').hasAttribute('open')).toBe(true);
    expect(element('#task-panel').hidden).toBe(true);
    expect(element<HTMLInputElement>('#task-create-another').checked).toBe(true);
    expect(element<HTMLInputElement>('#field-description').value).toBe('');
    expect(element<HTMLInputElement>('#field-tags').value).toBe('');
    expect(element<HTMLSelectElement>('#field-priority').value).toBe('2');
    expect(element('#task-advanced').hasAttribute('open')).toBe(false);
    expect(window.document.activeElement).toBe(element('#field-description'));
    input('#field-title','Second task');submit('#task-editor-form');
    await wait(()=>expect(element<HTMLInputElement>('#field-title').value).toBe(''));
    expect(server.service.snapshot().tasks).toHaveLength(2);
    input('#field-title','Last task');element<HTMLInputElement>('#task-create-another').checked=false;
    submit('#task-editor-form');
    await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));
    expect(server.service.snapshot().tasks.map(task=>task.title).sort()).toEqual(['First task','Last task','Second task']);
    expect(element('#task-panel').hidden).toBe(true);
    click('#create-task');expect(element<HTMLInputElement>('#task-create-another').checked).toBe(false);
  });

  it('preserves the create-another draft and checkbox when saving fails', async () => {
    await createProject();click('#create-task');
    element<HTMLInputElement>('#task-create-another').checked=true;
    input('#field-title','Keep this draft');input('#field-description','Keep description');
    const create=vi.spyOn(server.service,'createTask').mockImplementationOnce(()=>{throw new Error('Creation failed');});
    submit('#task-editor-form');
    await wait(()=>expect(element('.form-error').textContent).toContain('Creation failed'));
    expect(element('#modal').hasAttribute('open')).toBe(true);
    expect(element<HTMLInputElement>('#field-title').value).toBe('Keep this draft');
    expect(element<HTMLInputElement>('#field-description').value).toBe('Keep description');
    expect(element<HTMLInputElement>('#task-create-another').checked).toBe(true);
    expect(server.service.snapshot().tasks).toHaveLength(0);
    create.mockRestore();submit('#task-editor-form');
    await wait(()=>expect(element<HTMLInputElement>('#field-title').value).toBe(''));
    expect(server.service.snapshot().tasks).toHaveLength(1);
  });

  it('defaults new tasks to the project source branch and saves an explicit source selection', async () => {
    click('#create-project'); input('#field-name', 'Branch project'); input('#field-repositoryPath', directory);
    expect(element<HTMLInputElement>('#field-defaultBranch').value).toBe('main');
    input('#field-defaultBranch', 'release'); submit('#modal form');
    await wait(() => expect(element('#breadcrumb-project').textContent).toBe('Branch project'));
    expect(server.service.snapshot().projects[0]?.defaultBranch).toBe('release');
    click('#create-task'); expect(element<HTMLInputElement>('#field-baseBranch').value).toBe('release');
    input('#field-title', 'Selected source'); input('#field-baseBranch', 'feature/source'); submit('#modal form');
    await wait(() => expect(server.service.snapshot().tasks).toHaveLength(1));
    expect(server.service.snapshot().tasks[0]?.baseBranch).toBe('feature/source');
    await wait(() => expect(element('#modal').hasAttribute('open')).toBe(false));
  });

  it('walks the new project steps, reviews the choices and creates the project with starter labels', async () => {
    click('#create-project'); expect(element('#new-project-tab-general').getAttribute('aria-selected')).toBe('true'); expect(element<HTMLButtonElement>('#new-project-back').disabled).toBe(true);
    submit('#modal form'); await wait(() => expect(element('.form-error').textContent).not.toBe('')); expect(server.service.snapshot().projects).toHaveLength(0);
    input('#field-name', 'Wizard project'); input('#field-repositoryPath', directory);
    click('#new-project-next'); expect(element('#new-project-panel-git').hidden).toBe(false); expect(element('#new-project-panel-general').hidden).toBe(true); expect(element('#new-project-tab-general').classList.contains('is-complete')).toBe(true);
    click('#new-project-tab-labels'); click('#new-project-label-presets'); input('#new-project-label-name', 'frontend'); click('#new-project-label-add');
    expect(element('#new-project-labels-list').textContent).toContain('frontend'); expect(element('#new-project-labels-list').textContent).toContain('bug');
    click('#new-project-next'); expect(element('#new-project-panel-review').hidden).toBe(false); expect(element<HTMLButtonElement>('#new-project-next').hidden).toBe(true);
    expect(element('#new-project-summary').textContent).toContain('Wizard project'); expect(element('#new-project-summary').textContent).toContain(directory); expect(element('#new-project-summary').textContent).toContain('Yerel proje');
    click('[data-new-project-edit="general"]'); expect(element('#new-project-panel-general').hidden).toBe(false);
    submit('#modal form'); await wait(() => expect(server.service.snapshot().projects).toHaveLength(1));
    expect(server.service.snapshot().projects[0]?.labels?.map(label => label.name)).toEqual(['bug', 'enhancement', 'documentation', 'question', 'frontend']);
    await wait(() => expect(element('#modal').hasAttribute('open')).toBe(false));
  });

  it('keeps an in-flight AI workspace request alive across views and dialogs without creating tasks', async () => {
    await createProject();let resolveDraft!: (value: unknown) => void;
    const draft=vi.spyOn(server.service,'draft').mockImplementation(()=>new Promise(resolve=>{resolveDraft=resolve;}) as never);
    click('#ai-create-task');expect(element('#ai-sheet').hidden).toBe(false);expect(element('#ai-workspace').closest('#ai-sheet')).not.toBeNull();expect(element('#ai-workspace').closest('#board')).toBeNull();expect(element('#ai-create-task').getAttribute('aria-pressed')).toBe('true');
    expect(element('#ai-draft-list').hidden).toBe(true);expect(element('#ai-empty').hidden).toBe(false);expect(element('#ai-empty').textContent).toContain('Ne hazırlayalım?');expect(window.document.activeElement?.id).toBe('ai-message');expect(element('#board').childElementCount).toBeGreaterThan(0);
    const css=await uiStyleSource();expect(css).toContain('#ai-attach{margin-right:auto}');expect(css).not.toContain('.ai-send{margin-left:auto}');
    sendAI('Prepare my task');await wait(()=>expect(draft).toHaveBeenCalledTimes(1));
    expect(draft.mock.calls[0]![1]).toMatchObject({mode:'workspace',message:'Prepare my task',messages:[],drafts:[]});
    expect(element('#ai-progress').hidden).toBe(false);expect(element<HTMLButtonElement>('#ai-send').disabled).toBe(true);expect(element('#ai-chat-log').textContent).toContain('Prepare my task');
    element('#ai-message').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}) as unknown as Event);expect(element('#ai-sheet').hidden).toBe(true);expect(element('#ai-create-task').getAttribute('aria-pressed')).toBe('false');expect(element('#project-tab-ai-count').textContent).toBe('●');
    click('#create-project');input('#modal #field-description','Separate project description');
    resolveDraft({reply:'Draft ready while away',drafts:[{key:'d1',title:'Prepared task',description:'## Goal\n- **AI** task description',status:'backlog',dependsOn:[],dependsOnDrafts:[]}]});
    await wait(()=>expect(element('#project-tab-ai-count').textContent).toBe('1'));expect(element<HTMLTextAreaElement>('#modal #field-description').value).toBe('Separate project description');click('#close-modal');
    click('#ai-create-task');expect(element('#ai-chat-log').textContent).toContain('Draft ready while away');expect(element('[data-ai-draft="d1"] [data-ai-title]').textContent).toBe('Prepared task');expect(element('[data-ai-draft="d1"] [data-ai-summary]').textContent).toBe('AI task description');
    expect(element('#ai-draft-list').hidden).toBe(false);expect(element('#ai-progress').hidden).toBe(true);expect(element<HTMLButtonElement>('#ai-send').disabled).toBe(false);expect(server.service.snapshot().tasks).toHaveLength(0);
    click('#project-tab-terminal');expect(element('#ai-sheet').hidden).toBe(true);expect(element('#ai-create-task').hidden).toBe(true);
  });
  it('opens the prompt file named by a run bootstrap message', async () => {
    const project=server.service.createProject({name:'Prompt',repositoryPath:directory}),task=server.service.createTask({projectId:project.id,title:'Prompt view',provider:'claude'}),inputDirectory=join(directory,'prompt-input');
    await mkdir(inputDirectory);await writeFile(join(inputDirectory,'prompt.md'),'Task:\n<b>PROMPT_BODY</b>');
    server.service.store.state.runs.push({id:'run_prompt_ui',taskId:task.id,provider:'claude',status:'completed',startedAt:new Date().toISOString(),executionMode:'native',pendingCommands:[],continuation:0,terminalMode:'pty',inputDirectory} as never);
    const host=window.document.createElement('div');host.innerHTML=(window as any).AIWSConversation.markdown(`Read and follow the task instructions in ${join(inputDirectory,'..','runs','run_prompt_ui','input','prompt.md')}.`);window.document.body.append(host);
    (host.querySelector('button[data-run-prompt]') as unknown as HTMLButtonElement).click();
    await wait(()=>expect(element('#modal .run-prompt-preview pre').textContent).toBe('Task:\n<b>PROMPT_BODY</b>'));
    expect(element('#modal-title').textContent).toBe('Agenta verilen talimat');expect(element('#modal-description').textContent).toBe(join(inputDirectory,'prompt.md'));expect(window.document.querySelector('#modal b')).toBeNull();
  });

  let requestsInFlight = 0;
  const pageIdle = (): boolean => requestsInFlight === 0;
  // The app starts in English; these tests read the Turkish source texts unless a test asks for English.
  async function mountRenderer(options: Record<string,string> = {}): Promise<void> {
    const preferences={'aiws.language':'tr',...options};
    window = new Window({ url: server.url, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
    // Node's fetch accepts only its own AbortSignal, so the page's happy-dom signal is relayed to a native one.
    // Requests are counted until their body is read, so closeWindow can let the page finish before closing it.
    window.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
      const page = init?.signal, native = new AbortController();
      if (page?.aborted) native.abort(page.reason); else page?.addEventListener('abort', () => native.abort(page.reason), { once: true });
      requestsInFlight++;
      try {
        const response = await fetch(new URL(String(path), server.url), { ...init, signal: native.signal });
        if (path === '/api/events') return response;
        const body = await response.arrayBuffer();
        return new Response(response.status === 204 || response.status === 304 ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
      } finally { requestsInFlight--; }
    }) as unknown as Window['fetch'];
    window.document.write(await readFile(new URL('../index.html', import.meta.url), 'utf8'));
    // The interface defaults to English; these tests read the Turkish source texts unless they ask for English.
    for(const [name,value] of Object.entries({'aiws.language':'tr',...preferences}))window.localStorage.setItem(name,value);
    await runUiScripts(window);
    await wait(() => expect(element('#connection-label').textContent).toBe(preferences['aiws.language']==='en'?'Control center connected':'Kontrol merkezi bağlı'));
  }
  async function remountRenderer(preferences: Record<string,string> = {}): Promise<void> {
    await closeWindow(window, pageIdle);await mountRenderer(preferences);
  }
  // Agents, skills and workflows are off by default; tests of those features turn the library back on.
  const withLibrary = () => remountRenderer({'aiws.library':'on'});
  beforeEach(async () => {
    nativeEvidence={processes:[],owners:{}};
    directory = await mkdtemp(join(tmpdir(), 'aiws-ui-test-'));
    await mkdir(join(directory,'codex-history'),{recursive:true});await mkdir(join(directory,'claude-history'),{recursive:true});
    server = await startControlServer({ host: '127.0.0.1', port: 0, dataDir: join(directory, 'data'),tokenUsage:{home:directory,codexDir:join(directory,'codex-history'),claudeDir:join(directory,'claude-history')},history:{codexHome:join(directory,"codex-history"),claudeHome:join(directory,"claude-history")},skills:{home:join(directory,"skills-home")},liveSessions:{evidence:async()=>nativeEvidence},providerDetection:{home:directory,probe:async(executable:string)=>executable==='codex'?{path:join(directory,'bin','codex.cmd'),version:'codex-cli 9.9.9'}:{path:null,version:null}} });
    await mountRenderer();
  });
  afterEach(async () => {
    await closeWindow(window, pageIdle);
    await server.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('renders English forms and board labels while preserving Turkish task content', async () => {
    await closeWindow(window, pageIdle);
    await mountRenderer({'aiws.language':'en'});
    expect(window.document.documentElement.lang).toBe('en');
    expect(element('#settings-button').getAttribute('aria-label')).toBe('Settings');
    expect(element('#overview-nav').textContent).toContain('All projects');
    expect(element('#search').getAttribute('placeholder')).toBe('Search tasks…');
    expect(element('#create-project').getAttribute('aria-label')).toBe('New project');
    await createProject();
    const choose=vi.fn().mockResolvedValue({canceled:true});
    (window as unknown as {aiwsDesktop:unknown}).aiwsDesktop={chooseDirectory:choose};
    click('#project-tab-settings');expect(element('#settings-tab-general').textContent).toContain('General');click('#settings-choose-repository-folder');
    await wait(()=>expect(choose).toHaveBeenCalledWith({defaultPath:directory,language:'en'}));
    await wait(()=>expect(element<HTMLButtonElement>('#settings-choose-repository-folder').disabled).toBe(false));
    click('#project-tab-board');
    click('#create-task');
    expect(element('#modal h2').textContent).toBe('New task · Renderer QA');
    expect(element('#close-modal').getAttribute('aria-label')).toBe('Close dialog');
    expect(element('#field-title').getAttribute('placeholder')).toBe('If left empty, the first 50 characters of the description are used');
    input('#field-title','Yeni görev'); input('#field-description','Açıklama: Türkçe içerik'); submit('#modal form');
    await wait(()=>expect(element('.task-card h3').textContent).toBe('Yeni görev'));
    expect(element('.task-card .card-description').textContent).toBe('Açıklama: Türkçe içerik');
    expect(element('.task-status-chip').textContent).toBe('Backlog');
    expect(server.service.snapshot().tasks[0]?.description).toBe('Açıklama: Türkçe içerik');
    click('#settings-button');
    expect(element('#modal').hasAttribute('open')).toBe(false);
    expect(element('#breadcrumb-project').textContent).toBe('Settings');
    expect(element('#settings-page').textContent).toContain('Default provider');
    expect(element('#settings-tab-providers').textContent).toContain('Providers');
    click('#token-countdown');
    await wait(()=>expect(element('#token-usage-detail').textContent).toContain('No usage data'));
    expect(element('#modal h2').textContent).toBe('Token and quota usage');
  });


  it('creates tasks in the selected backlog or ready column and hides other creation buttons', async () => {
    await createProject();
    // Keep ready tasks queued so persistence can be checked without starting a provider.
    server.service.catalog.createAgent({name:'Unavailable worker',provider:'codex',enabled:false});
    for(const status of ['running','review','done']) {
      expect(window.document.querySelector(`[data-drop-status="${status}"] [data-new-status]`)).toBeNull();
    }
    for(const status of ['backlog','ready']) {
      for(const button of ['.column-header [data-new-status]','.add-card']) {
        click(`[data-drop-status="${status}"] ${button}`);
        expect(element<HTMLSelectElement>('#field-status').value).toBe(status);
        const title=`${status} from ${button}`;
        input('#field-title',title);submit('#modal form');
        await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));
        await wait(()=>expect(server.service.snapshot().tasks.find(task=>task.title===title)?.status).toBe(status));
      }
    }
    click('#create-task');expect(element<HTMLSelectElement>('#field-status').value).toBe('backlog');click('#close-modal');
  });

  it('keeps every status column header sticky while each column scrolls, even for empty columns', async () => {
    await createProject();
    for(const status of ['backlog','ready','running','review','done']) {
      const column=element(`[data-drop-status="${status}"]`);
      expect(column.parentElement?.id).toBe('board');expect(column.classList.contains('column')).toBe(true);
      expect(column.firstElementChild?.classList.contains('column-header')).toBe(true);
    }
    const css=await uiStyleSource(),board=css.match(/\.board:has\(>\.column\)\{[^}]*\}/)?.[0]??'';
    expect(board).toContain('overflow-y:hidden');expect(board).toContain('display:grid');expect(board).toContain('align-items:stretch');
    // Columns fill the board height and scroll their own cards, so every header stays visible.
    expect(board).toContain('grid-template-rows:minmax(0,1fr)');expect(css).toContain('.board>.column{width:auto;max-width:none;min-height:0;margin-top:14px;padding-top:0;overflow-y:auto}');
    expect(css).toContain('.board>.column>.column-header{position:sticky;top:0;z-index:2;background:var(--column);margin:0 -6px');
  });

  it('gathers tasks that wait on the user in their own column and drops review for auto-merge projects', async () => {
    await createProject();
    const projectId=server.service.snapshot().projects[0]!.id;
    // The column stays visible even while it is empty.
    expect(window.document.querySelectorAll('[data-board-column="needs"] [data-open-task]')).toHaveLength(0);
    expect(element('[data-board-column="needs"]')).toBeTruthy();
    const asking=server.service.createTask({projectId,title:'Asked a question'}),failed=server.service.createTask({projectId,title:'Broke down',status:'failed'});
    Object.assign(server.service.store.state.tasks.find(task=>task.id===asking.id)!,{status:'waiting'});
    server.service.emit('change',server.service.snapshot());
    await wait(()=>expect(window.document.querySelectorAll('[data-board-column="needs"] [data-open-task]')).toHaveLength(2));
    for(const id of [asking.id,failed.id])expect(window.document.querySelector(`[data-board-column="running"] [data-open-task="${id}"]`)).toBeNull();
    // Nothing can be moved into the waiting column by hand; only the agent puts tasks there.
    expect(element('[data-board-column="needs"]').hasAttribute('data-drop-status')).toBe(false);
    expect(element('[data-board-column="needs"] .column-header').textContent).toContain('Seni bekliyor');
    expect(window.document.querySelector('[data-board-column="review"]')).not.toBeNull();
    server.service.updateProject(projectId,{autoMerge:true});server.service.emit('change',server.service.snapshot());
    await wait(()=>expect(window.document.querySelector('[data-board-column="review"]')).toBeNull());
    const reviewed=server.service.createTask({projectId,title:'Merge failed',status:'review'});server.service.emit('change',server.service.snapshot());
    await wait(()=>expect(window.document.querySelector(`[data-board-column="review"] [data-open-task="${reviewed.id}"]`)).not.toBeNull());
  });

  it('starts the AI task organizer from the backlog header and shows its report once it finishes', async () => {
    await createProject();
    const header='[data-drop-status="backlog"] .column-header',button=()=>element(`${header} [data-organize-tasks]`);
    expect(button().getAttribute('title')).toContain('AI ile sırala');expect(button().getAttribute('aria-label')).toBe(button().getAttribute('title'));expect(button().querySelector('svg')).not.toBeNull();
    for(const status of ['ready','running','review','done'])expect(window.document.querySelector(`[data-drop-status="${status}"] [data-organize-tasks]`)).toBeNull();
    const organize=vi.spyOn(server.service,'organize');
    button().click();
    await wait(()=>expect(element('#toast').textContent).toBe('Sıralanacak bekleyen iş yok.'));expect(organize).not.toHaveBeenCalled();
    const projectId=server.service.snapshot().projects[0]!.id;server.service.createTask({projectId,title:'Backlog work'});
    await wait(()=>expect(window.document.querySelector('[data-drop-status="backlog"] [data-open-task]')).not.toBeNull());
    organize.mockImplementation(()=>({requestId:'organize_ui',status:'running',provider:'codex',startedAt:new Date().toISOString()}));
    button().click();
    await wait(()=>expect(button().dataset.organizeTasks).toBe('cancel'));
    expect(organize).toHaveBeenCalledWith(projectId,{});expect(button().getAttribute('title')).toContain('Durdurmak için tıkla');
    expect(server.service.snapshot().tasks).toHaveLength(1);
    const locked=element('[data-drop-status="backlog"] [data-open-task]');
    expect(locked.classList.contains('organize-locked')).toBe(true);expect(locked.getAttribute('aria-disabled')).toBe('true');expect(locked.hasAttribute('draggable')).toBe(false);
    expect(element('[data-drop-status="backlog"]').classList.contains('organizing')).toBe(true);expect(element('[data-drop-status="backlog"] .organize-banner').textContent).toContain('AI işleri sıralıyor');
    await wait(()=>expect(element('#ai-sheet').hidden).toBe(false));expect(element('#ai-progress-label').textContent).toBe('Taskları işliyorum…');
    await wait(()=>expect(element('#ai-sheet [data-ai-draft]').classList.contains('created')).toBe(true));
    click('#ai-close');
    locked.click();
    await wait(()=>expect(element('#toast').textContent).toBe('AI sıralaması sürerken bu iş açılamaz.'));expect(element('#task-panel').hidden).toBe(true);
    window.eval(`applyState({organizations:{${JSON.stringify(projectId)}:{requestId:'organize_ui',status:'completed',provider:'codex',startedAt:'',finishedAt:'',report:'Sıra: task_backlog_work'}}})`);
    await wait(()=>expect(element('#modal h2').textContent).toBe('AI iş sıralaması'));
    expect(element('#modal .organize-report').textContent).toContain('task_backlog_work');expect(button().dataset.organizeTasks).toBe('start');
    expect(element('#modal .organize-hero').textContent).toContain('Sıralama tamamlandı');
    expect([...window.document.querySelectorAll('#modal .organize-stat strong')].map(item=>item.textContent)).toEqual(['1','0','1']);
    expect(element('[data-drop-status="backlog"] [data-open-task]').classList.contains('organize-locked')).toBe(false);
    click('#close-modal');window.eval(`applyState({organizations:{${JSON.stringify(projectId)}:{requestId:'organize_ui',status:'completed',provider:'codex',startedAt:'',report:'again'}}})`);
    expect(element('#modal').hasAttribute('open')).toBe(false);
  });

  it('saves project worktree settings from scanned branches and the task Auto merge checkbox beside AI prepare', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, windowsHide: true, stdio: 'pipe' });
    git('init', '-b', 'main');git('-c','user.name=Test','-c','user.email=test@localhost','commit','--allow-empty','-m','Initial');git('branch','develop');
    click('#settings-button');expect(window.document.querySelector('input[name="useWorktree"]')).toBeNull();expect(window.document.querySelector('#field-mainBranch')).toBeNull();
    await createProject();
    expect(server.service.snapshot().projects[0]?.useWorktree).toBe(true);
    click('#project-tab-settings');click('#settings-tab-git');expect(element('#settings-panel-git').hidden).toBe(false);
    await wait(()=>expect(element<HTMLSelectElement>('#settings-field-mainBranch').options.length).toBe(2));
    expect([...element<HTMLSelectElement>('#settings-field-mainBranch').options].map(option=>option.value)).toEqual(['develop','main']);
    const enabled=element<HTMLInputElement>('input[name="useWorktree"]');enabled.checked=true;
    input('#settings-field-mainBranch','develop');submit('#project-settings-form');
    await wait(()=>expect(server.service.snapshot().projects[0]).toMatchObject({useWorktree:true,mainBranch:'develop'}));
    expect(element('#modal').hasAttribute('open')).toBe(false);
    click('#project-tab-board');click('#project-tab-settings');await wait(()=>expect(element<HTMLSelectElement>('#settings-field-mainBranch').value).toBe('develop'));expect(element<HTMLInputElement>('input[name="useWorktree"]').checked).toBe(true);expect(element('#settings-panel-git').hidden).toBe(false);
    git('branch','release');click('#settings-refresh-project-branches');await wait(()=>expect(element<HTMLSelectElement>('#settings-field-mainBranch').options.length).toBe(3));click('#project-tab-board');
    click('#create-task');input('#field-title','Auto merge from header');
    const checkbox=element<HTMLInputElement>('.modal-header input[name="autoMerge"]');
    expect(checkbox.closest('.modal-header')?.querySelector('#task-open-ai')).not.toBeNull();
    checkbox.checked=true;checkbox.dispatchEvent(new window.Event('change',{bubbles:true}));
    expect(element<HTMLInputElement>('input[name="autoMergeInherit"]').checked).toBe(false);
    submit('#modal form');await wait(()=>expect(server.service.snapshot().tasks[0]?.autoMerge).toBe(true));
    await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));
    click('[data-open-task]');click('[data-detail-tab="info"]');
    expect(element<HTMLInputElement>('#info-autoMerge').checked).toBe(true);
    element<HTMLInputElement>('#info-autoMerge').checked=false;commit('#info-autoMerge');await wait(()=>expect(server.service.snapshot().tasks[0]?.autoMerge).toBe(false));
    await wait(()=>expect(element<HTMLSelectElement>('#info-baseBranch').value).toBe(server.service.snapshot().tasks[0]!.baseBranch));
  });

  it('offers a working restart action after a failed task and keeps the previous run', async () => {
    await createProject(); await createTask('Recover terminal failure');
    const task = server.service.snapshot().tasks[0]!;
    server.service.updateTask(task.id, { provider: 'command', command: { executable: process.execPath, args: ['-e', 'process.exit(7)'] } });
    const original = server.service.startTask(task.id);
    await wait(() => expect(server.service.run(original.id).status).toBe('failed'));
    await wait(() => expect(element('[data-run-action="restart"]').textContent).toContain('Yeniden başlat'));
    click('[data-run-action="restart"]');
    await wait(() => expect(server.service.snapshot().runs).toHaveLength(2));
    expect(server.service.task(task.id).currentRunId).not.toBe(original.id);
    expect(server.service.run(original.id).exitCode).toBe(7);
  });

  it('lists every agent of a task, keeps the latest in the console and opens earlier ones read only beside it', async () => {
    await createProject(); await createTask('Multi agent work');
    const task=server.service.snapshot().tasks[0]!,started=Date.now();
    const at=(offset:number)=>new Date(started+offset).toISOString();
    const base={taskId:task.id,executionMode:'native',pendingCommands:[],continuation:0,terminalMode:'stream'} as const;
    server.service.store.state.runs.push({...base,id:'run_first_agent',provider:'claude',status:'cancelled',startedAt:at(-60_000),finishedAt:at(-30_000),exitCode:130,sessionId:'claude-session'} as never,
      {...base,id:'run_second_agent',provider:'codex',status:'running',startedAt:at(-20_000),finishedAt:null,exitCode:null,handoff:{fromRunId:'run_first_agent',fromProvider:'claude',fromAgentName:'claude',mode:'fresh',reason:'5-hour limit reached'}} as never);
    const message=(id:string,runId:string,text:string,offset:number)=>({id,taskId:task.id,runId,agentId:null,authorType:'agent',authorName:'Agent',text,createdAt:at(offset)});
    server.service.store.state.messages.push(message('m1','run_first_agent','FIRST_AGENT_WORK',-50_000) as never,message('m2','run_second_agent','SECOND_AGENT_WORK',-10_000) as never);
    Object.assign(server.service.store.state.tasks[0]!,{currentRunId:'run_second_agent',status:'running',provider:'codex'});
    server.service.emit('change',server.service.snapshot());click('#detail-tab-console');
    await wait(()=>expect(window.document.querySelectorAll('#task-panel .task-agent-row')).toHaveLength(2));
    const rows=[...window.document.querySelectorAll('#task-panel .task-agent-row')];
    expect(rows[0]!.getAttribute('aria-pressed')).toBe('false');expect(rows[1]!.getAttribute('aria-pressed')).toBe('true');
    expect(rows[1]!.textContent).toContain('Temiz agent olarak devralındı');
    await wait(()=>expect(element('#task-panel .cv-timeline').textContent).toContain('SECOND_AGENT_WORK'));
    expect(element('#task-panel .cv-timeline').textContent).not.toContain('FIRST_AGENT_WORK');
    const root=element('#task-panel [data-agent-console]');
    click('#task-panel [data-task-agent-session="run_first_agent"]');
    await wait(()=>expect(element('#agent-child-panel .cv-timeline').textContent).toContain('FIRST_AGENT_WORK'));
    expect(element('#agent-child-panel .cv-timeline').textContent).not.toContain('SECOND_AGENT_WORK');
    expect(element('#child-agent-title').textContent).toContain('1. agent');
    expect(element<HTMLFormElement>('#agent-child-panel .cv-composer').hidden).toBe(true);
    expect(element('#task-panel [data-task-agent-session="run_first_agent"]').getAttribute('aria-pressed')).toBe('true');
    expect(element('#task-panel [data-agent-console]')).toBe(root);
    click('#close-child-agent');expect(element<HTMLElement>('#agent-child-panel').hidden).toBe(true);
    await wait(()=>expect(element('#task-panel [data-task-agent-session="run_second_agent"]').getAttribute('aria-pressed')).toBe('true'));
  });

  it('asks which agent continues after a usage limit and hands the task off with the project method', async () => {
    await createProject(); await createTask('Out of tokens');
    const task=server.service.snapshot().tasks[0]!,project=server.service.snapshot().projects[0]!;
    server.service.updateProject(project.id,{agentHandoffMode:'transcript'});
    server.service.store.state.runs.push({id:'run_exhausted',taskId:task.id,provider:'claude',status:'waiting',startedAt:new Date().toISOString(),finishedAt:null,exitCode:null,executionMode:'native',pendingCommands:[],continuation:0,terminalMode:'stream'} as never);
    Object.assign(server.service.store.state.tasks[0]!,{currentRunId:'run_exhausted',status:'waiting',provider:'claude',handoffRequest:{runId:'run_exhausted',provider:'claude',agentName:'claude',reason:'Claude AI usage limit reached',detectedAt:new Date().toISOString(),resetsAt:new Date(Date.now()+300_000).toISOString(),resumeAt:new Date(Date.now()+360_000).toISOString()}});
    server.service.updateTask(task.id,{status:'waiting'});await window.eval('refresh()');click('#detail-tab-console');
    await wait(()=>expect(element('#task-panel .handoff-notice').textContent).toContain('Claude Code ajanının tokenı bitti'));
    expect(element('#task-panel .handoff-notice').textContent).toContain('Otomatik bekleme:');
    expect(element('#task-panel .handoff-notice').textContent).toContain('Claude AI usage limit reached');
    expect(element<HTMLSelectElement>('#task-panel #field-provider').value).toBe('codex');expect(element('#task-panel .handoff-notice .model-trigger')).toBeTruthy();
    expect(element<HTMLSelectElement>('#task-panel [name=mode]').value).toBe('transcript');
    const handoff=vi.spyOn(server.service,'handoffTask').mockImplementation(async id=>{delete server.service.store.state.tasks[0]!.handoffRequest;server.service.updateTask(id,{status:'waiting'});return {task:server.service.task(id),run:server.service.run('run_exhausted')};});
    click('#task-panel .handoff-notice [type=submit]');
    await wait(()=>expect(handoff).toHaveBeenCalledWith(task.id,{provider:'codex',model:null,reasoningEffort:null,mode:'transcript'}));
    await wait(()=>expect(window.document.querySelector('#task-panel .handoff-notice')).toBeNull());
    click('#close-panel');click('#project-tab-settings');click('#settings-tab-git');
    expect(element<HTMLSelectElement>('#settings-field-agentHandoffMode').value).toBe('transcript');
  });

  it('shows run model, effort, branch and worktree independently of later profile changes', async () => {
    await createProject(); await createTask('Execution details');
    const task=server.service.snapshot().tasks[0]!;
    const agent=server.service.catalog.createAgent({name:'Original agent',provider:'codex',model:'future-model'});
    const run: import('../../control-server/types.js').Run={id:'execution-details',taskId:task.id,status:'running',provider:'codex',startedAt:new Date().toISOString(),finishedAt:null,exitCode:null,executionMode:'native',pendingCommands:[],continuation:0,
      executionSnapshot:{agent:{...agent,model:'gpt-6.1-sol'},skills:[],provider:'codex',model:'gpt-6.1-sol',instructions:'',context:'',task:{title:task.title,description:''},createdAt:new Date().toISOString()},
      executionInfo:{model:'gpt-6.1-sol',modelSource:'reported',reasoningEffort:'medium',branch:'feature/<details>',worktreePath:directory,cwd:directory}};
    server.service.store.state.runs.push(run);Object.assign(server.service.store.state.tasks[0]!,{currentRunId:run.id,status:'running',agentId:agent.id});
    server.service.emit('change',server.service.snapshot());
    click('#detail-tab-info');
    await wait(()=>expect(element('[data-execution-model]').textContent).toContain('gpt-6.1-sol'));
    expect(element('[data-execution-model]').textContent).toContain('gpt-6.1-sol · medium');
    expect(element('[data-execution-model]').textContent).not.toContain('future-model');
    expect(element('[data-execution-branch]').textContent).toBe('feature/<details>');
    expect(element('[data-execution-branch]').querySelector('details')).toBeNull();
    expect(element('[data-execution-worktree]').textContent).toBe(directory);
    expect(element('[data-execution-cwd]').textContent).toBe(directory);
    run.executionInfo={cwd:directory};delete run.executionSnapshot;
    server.service.emit('change',server.service.snapshot());
    await wait(()=>expect(element('[data-execution-model]').textContent).toContain('Model bilgisi bekleniyor'));
    expect(element('[data-execution-branch]').textContent).toBe('Branch bilgisi yok');
  });

  it('uses the same fixed header, scrolling body, and footer for every application modal family', async () => {
    click('#create-project');assertModalShell();expect(element('#modal input[name="projectAutoMerge"]').closest('.modal-body')).not.toBeNull();click('#close-modal');await createProject();
    click('#project-tab-settings');click('#settings-tab-danger');click('[data-action="delete-project"]');assertModalShell();expect(window.document.activeElement?.textContent).toBe('Vazgeç');click('#close-modal');click('#project-tab-board');
    click('#create-task');assertModalShell();expect(element('#modal').getAttribute('data-size')).toBe('wide');click('#close-modal');await createTask('Modal task');click('.panel-actions [data-action="delete-task"]');assertModalShell();click('#close-modal');click('#close-panel');
    window.eval('showTokenDialog()');assertModalShell();expect(window.document.activeElement?.id).toBe('field-token');click('#close-modal');
    const agent=server.service.catalog.createAgent({name:'Modal agent',provider:'codex'}),skill=server.service.catalog.createSkill({name:'Modal skill',content:'# Skill instructions',files:[]});const workflow=server.service.workflows.create({name:'Modal workflow',steps:[{id:'first',name:'Implement',agentId:agent.id,instructions:'Do the task',condition:'always'}]});
    click('#agents-nav');click('#create-task');assertModalShell();click('#close-modal');await wait(()=>expect(window.document.querySelector('[data-edit-agent="'+agent.id+'"]')).not.toBeNull());click('[data-edit-agent="'+agent.id+'"]');assertModalShell();click('[data-delete-agent]');assertModalShell();click('#close-modal');
    click('[data-agent-library="templates"]');await wait(()=>expect(window.document.querySelector('[data-preview-template]')).not.toBeNull());element('[data-preview-template]').focus();click('[data-preview-template]');assertModalShell();expect(element('.modal-footer').textContent).toContain('Kapat');click('#clone-agent-template');assertModalShell();expect(window.document.activeElement?.id).toBe('field-name');click('#close-modal');
    click('#skills-nav');click('#create-task');assertModalShell();input('#field-content','# Long editor\n'+('Useful instructions\n'.repeat(1000)));expect(element('#field-content').closest('.modal-body')).not.toBeNull();click('#close-modal');click('[data-edit-skill="'+skill.id+'"]');assertModalShell();click('[data-delete-skill]');assertModalShell();click('#close-modal');click('[data-action="import-skill-folder"]');assertModalShell();click('#close-modal');
    click('#workflows-nav');click('#create-task');assertModalShell();click('#close-modal');click('[data-edit-workflow="'+workflow.id+'"]');assertModalShell();click('[data-delete-workflow]');assertModalShell();click('#close-modal');
    const css=await uiStyleSource();expect(css).toContain('.app-modal .modal-body{flex:1;min-height:0;overflow-y:auto');expect(css).toContain('.app-modal .modal-footer{display:flex;flex:none');expect(css).toContain('.app-modal[data-size=wide]');
  });
  it('asks before Escape discards typed input, keeps the dialog on a backdrop click, and undoes an archive from the toast', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;const done=server.service.createTask({projectId:project.id,title:'Finished work',status:'done'});
    await wait(()=>expect(window.document.querySelector(`[data-open-task="${done.id}"]`)).not.toBeNull());click(`[data-open-task="${done.id}"]`);
    click('[data-action="fork-task"]');const escape=()=>element('#modal textarea[name="text"]').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}) as unknown as Event);
    escape();expect(element('#modal').hasAttribute('open')).toBe(false);
    click('[data-action="fork-task"]');typeDraft('#modal textarea[name="text"]','Keep this instruction');
    element('#modal').dispatchEvent(new window.MouseEvent('click',{bubbles:true,clientX:-10,clientY:-10}) as unknown as Event);expect(element('#modal textarea[name="text"]')).toBeTruthy();
    escape();expect(element('#modal').textContent).toContain('Kaydedilmemiş değişiklikler silinsin mi?');
    click('#modal [data-action="close-modal"]');expect(element<HTMLTextAreaElement>('#modal textarea[name="text"]').value).toBe('Keep this instruction');expect(element('#modal').hasAttribute('open')).toBe(true);
    escape();submit('#modal form');await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));expect(server.service.snapshot().tasks).toHaveLength(1);
    click(`[data-open-task="${done.id}"]`);await wait(()=>expect(window.document.querySelector('[data-archive-task]')).not.toBeNull());click('[data-archive-task]');
    await wait(()=>expect(server.service.task(done.id).archivedAt).toBeTruthy());await wait(()=>expect(element('#toast .toast-action').textContent).toBe('Geri al'));
    click('#toast .toast-action');await wait(()=>expect(server.service.task(done.id).archivedAt).toBeFalsy());
  });
  it('keeps modal validation and drafts, restores focus, traps keyboard navigation, and ignores a stale pending submit after replacement', async () => {
    element('#create-project').focus();click('#create-project');assertModalShell();input('#field-name','Keep project draft');input('#field-repositoryPath',join(directory,'missing-folder'));submit('#modal form');await wait(()=>expect(element('.form-error').textContent).toMatch(/exist|directory/i));expect(element<HTMLInputElement>('#field-name').value).toBe('Keep project draft');expect(element('.form-error').closest('.modal-footer')).not.toBeNull();expect(element('#modal .modal-frame').hasAttribute('aria-busy')).toBe(false);
    const first=element('#close-modal'),last=element('.modal-footer button[type="submit"]');last.focus();last.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}) as unknown as Event);expect(window.document.activeElement).toBe(first);first.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}) as unknown as Event);expect(window.document.activeElement).toBe(last);
    first.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}) as unknown as Event);expect(element('#modal').hasAttribute('open')).toBe(false);expect(window.document.activeElement?.id).toBe('create-project');
    click('#create-project');input('#field-name','Pending project');input('#field-repositoryPath',directory);const transport=window.fetch;let finish!:()=>void,requests=0;vi.spyOn(window,'fetch').mockImplementation((async(path: string | URL | Request,init?: RequestInit)=>{if(String(path)==='/api/projects'&&init?.method==='POST'){requests++;await new Promise<void>(resolve=>finish=resolve);}return transport(path as never,init as never);}) as never);
    submit('#modal form');await wait(()=>expect(requests).toBe(1));expect(element<HTMLButtonElement>('.modal-footer button[type="submit"]').disabled).toBe(true);expect(element('#modal .modal-frame').getAttribute('aria-busy')).toBe('true');submit('#modal form');expect(requests).toBe(1);
    click('#close-modal');click('#create-project');input('#field-name','New popup draft');finish();await wait(()=>expect(server.service.snapshot().projects.map(project=>project.name)).toContain('Pending project'));expect(element('#modal .modal-frame').hasAttribute('aria-busy')).toBe(false);await new Promise(resolve=>setTimeout(resolve,50));expect(element('#modal').hasAttribute('open')).toBe(true);expect(element<HTMLInputElement>('#field-name').value).toBe('New popup draft');
    const backdrop=new window.MouseEvent('click',{bubbles:true,clientX:-1,clientY:-1});element('#modal').dispatchEvent(backdrop as unknown as Event);expect(element('#modal').hasAttribute('open')).toBe(false);
  });

  it('does not steal a composer draft focus when the post-save state refresh returns after the modal closes', async () => {
    await createProject();const transport=window.fetch;let afterTaskSave=false,release!:()=>void,returned=false;
    vi.spyOn(window,'fetch').mockImplementation((async(path: string | URL | Request,init?:RequestInit)=>{
      const response=await transport(path as never,init as never);
      if(String(path)==='/api/tasks'&&init?.method==='POST')afterTaskSave=true;
      if(String(path).startsWith('/api/state')&&afterTaskSave&&!release){const buffered=await response.text();await new Promise<void>(resolve=>release=resolve);returned=true;return new window.Response(buffered,{status:response.status,headers:response.headers});}
      return response;
    }) as never);
    await createTask('Late refresh focus');await wait(()=>expect(release).toBeTypeOf('function'));click('#detail-tab-console');await consoleMounted();const composer=element<HTMLTextAreaElement>('#task-message-input');composer.value='Keep typing while the refresh completes';composer.focus();composer.setSelectionRange(5,11);release();await wait(()=>expect(returned).toBe(true));await new Promise(resolve=>setTimeout(resolve,50));
    expect(window.document.activeElement).toBe(composer);expect(composer.value).toBe('Keep typing while the refresh completes');expect(composer.selectionStart).toBe(5);expect(composer.selectionEnd).toBe(11);
  });


  it('uses a native folder picker without editable paths, preserves cancellation drafts, and saves only the selected directory', async () => {
    const selected=join(directory,'picked-native');await mkdir(selected);const choose=vi.fn().mockResolvedValueOnce({canceled:true}).mockResolvedValueOnce({canceled:false,path:selected});(window as unknown as {aiwsDesktop:unknown}).aiwsDesktop={chooseDirectory:choose};
    click('#create-project');assertModalShell();expect(element<HTMLInputElement>('#field-repositoryPath').type).toBe('hidden');input('#field-name','Custom project title');input('#field-description','Keep my context');click('#choose-repository-folder');await wait(()=>expect(choose).toHaveBeenCalledTimes(1));await wait(()=>expect(element<HTMLButtonElement>('#choose-repository-folder').disabled).toBe(false));expect(element<HTMLInputElement>('#field-repositoryPath').value).toBe('');expect(element<HTMLInputElement>('#field-name').value).toBe('Custom project title');expect(element<HTMLTextAreaElement>('#field-description').value).toBe('Keep my context');
    click('#choose-repository-folder');await wait(()=>expect(element('#repository-selected-path').textContent).toBe(selected));expect(element<HTMLInputElement>('#field-repositoryPath').value).toBe(selected);expect(element<HTMLInputElement>('#field-name').value).toBe('Custom project title');submit('#modal form');await wait(()=>expect(server.service.snapshot().projects[0]?.repositoryPath).toBe(selected));
    await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));click('#project-tab-settings');choose.mockResolvedValueOnce({canceled:false,path:directory});input('#settings-field-name','');click('#settings-choose-repository-folder');await wait(()=>expect(element<HTMLInputElement>('#settings-field-name').value).toBe(directory.split(/[\\/]/).at(-1)));expect(element('#project-settings-save-state').textContent).toBe('Kaydedilmemiş değişiklikler');expect(choose).toHaveBeenLastCalledWith({defaultPath:selected,language:'tr'});
  });
  it('renders safe readable task Markdown under a fixed header and places state-aware run actions before Edit', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;const title='Very long title '+('abcdefghij'.repeat(35)),task=server.service.createTask({projectId:project.id,title:title.slice(0,240),description:'# Acceptance\n\n- **Build** successfully\n- Review [unsafe](javascript:alert(1))\n\n~~~js\nconst example = 1;\n~~~\n\n<img src=x onerror=alert(1)>',provider:'command',command:{executable:process.execPath,args:['-e','setTimeout(()=>console.log("done"),1000)']}});
    await wait(()=>expect(window.document.querySelector('.task-card')).not.toBeNull());click('.task-card');expect(element('[data-detail-tab="info"]').getAttribute('aria-selected')).toBe('true');const header=element('#task-panel>.panel-header'),body=element('.detail-workspace');expect(header.contains(element('#task-detail-title'))).toBe(true);expect(body.contains(header)).toBe(false);expect(element('.task-description h3.cv-h1').textContent).toBe('Acceptance');expect(element('.task-description strong').textContent).toBe('Build');expect(window.document.querySelectorAll('.task-description ul>li')).toHaveLength(2);expect(window.document.querySelector('.task-description img')).toBeNull();expect(window.document.querySelector('.task-description a[href^="javascript:"]')).toBeNull();expect(element('.task-description').textContent).toContain('<img src=x onerror=alert(1)>');
    const key=element('#task-detail-title').previousElementSibling as HTMLElement;expect(key.classList.contains('task-key')).toBe(true);expect(key.textContent).toBe(`AIWS-${task.id.replace(/^[a-z]+[_-]/i,'').slice(0,6).toUpperCase()}`);
    const writeText=vi.fn().mockResolvedValue(undefined);Object.defineProperty(window.navigator,'clipboard',{configurable:true,value:{writeText}});
    click('.task-key');await wait(()=>expect(writeText).toHaveBeenCalledWith(key.textContent));await wait(()=>expect(element('.task-key-copied').textContent).toBe('Kopyalandı'));
    const actions=[...element('.panel-actions').children];expect(window.document.querySelector('[data-action="edit-task"]')).toBeNull();expect(actions.indexOf(element('.header-run-action'))).toBeLessThan(actions.indexOf(element('.panel-actions .detail-more')));expect(element('.header-run-action').getAttribute('data-run-action')).toBeNull();expect(element('.header-run-action').textContent).toContain('Hazır');click('.header-run-action');await wait(()=>expect(server.service.snapshot().runs[0]?.status).toBe('running'));await wait(()=>expect(element('.header-run-action').textContent).toBe('Çalışıyor'));expect(element<HTMLButtonElement>('.header-run-action').disabled).toBe(true);await wait(()=>expect(server.service.snapshot().runs[0]?.status).toBe('completed'));await wait(()=>expect(element('.header-run-action').getAttribute('data-move-task')).toBe('done'));click('.header-run-action');await wait(()=>expect(server.service.snapshot().tasks.find(item=>item.id===task.id)?.status).toBe('done'));await wait(()=>expect(element('.panel-actions>.header-run-action').hasAttribute('data-archive-task')).toBe(true));expect(element('.header-run-action').textContent).toBe('Arşivle');expect(window.document.querySelector('.detail-header-timer')).toBeNull();click('.header-run-action');await wait(()=>expect(server.service.snapshot().tasks.find(item=>item.id===task.id)?.archivedAt).toBeTruthy());await wait(()=>expect(window.document.querySelector('.header-run-action')).toBeNull());expect(server.service.snapshot().runs).toHaveLength(1);
    const queued=server.service.createTask({projectId:project.id,title:'Queued task',status:'ready'});await wait(()=>expect(window.document.querySelector('[data-open-task="'+queued.id+'"]')).not.toBeNull());click('[data-open-task="'+queued.id+'"]');await wait(()=>expect(element('.header-run-action').textContent).toBe('Otomatik sırada'));expect(element<HTMLButtonElement>('.header-run-action').disabled).toBe(true);expect(element('.header-run-action').getAttribute('title')).toMatch(/otomatik|agent|Agent/);
    const css=await uiStyleSource();expect(css).toContain('.task-panel>.panel-header{flex:none;');expect(css).toContain('.panel-actions{display:flex;');expect(css).toContain('.task-panel>.detail-workspace{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}');
  });


  it('browses actual server folders when the desktop backend is remote and keeps selection inside the project form', async () => {
    vi.stubEnv('AIWS_CONTROL_BROWSE_ROOTS',directory);const chosen=join(directory,'server-workspace');await mkdir(chosen);(window as unknown as {aiwsDesktop:unknown}).aiwsDesktop={chooseDirectory:vi.fn().mockResolvedValue({canceled:false,unsupported:true,reason:'remote-backend'})};
    click('#create-project');input('#field-description','Remote project draft');click('#choose-repository-folder');await wait(()=>expect(element('#server-folder-browser').textContent).toContain('Erişilebilir kökler'));await wait(()=>expect(window.document.querySelector('[data-folder-entry]')).not.toBeNull());expect(element('#repository-picker-note').textContent).toContain('Uzak kontrol');assertModalShell();click('[data-folder-entry="0"]');await wait(()=>expect(element('.folder-browser-list').textContent).toContain('server-workspace'));
    const folder=[...window.document.querySelectorAll('[data-folder-entry]')].find(button=>button.textContent?.includes('server-workspace'))!;(folder as unknown as HTMLElement).click();await wait(()=>expect(element('.folder-navigation').textContent).toContain(chosen));click('[data-folder-select]');expect(element('#server-folder-browser').hidden).toBe(true);expect(element<HTMLInputElement>('#field-name').value).toBe('server-workspace');expect(element<HTMLInputElement>('#field-repositoryPath').value).toBe(chosen);expect(element<HTMLTextAreaElement>('#field-description').value).toBe('Remote project draft');submit('#modal form');await wait(()=>expect(server.service.snapshot().projects[0]?.repositoryPath).toBe(chosen));
  });
  it('loads only matching local provider history, pages public messages without writes, and explicitly resumes the original Codex session', async () => {
    const factory=(window as unknown as {AIWSAgentConsole:{create:Function}}).AIWSAgentConsole;const createConsole=vi.fn((host:unknown,data:unknown)=>factory.create(host,data));(window as unknown as {AIWSAgentConsole:unknown}).AIWSAgentConsole={...factory,create:createConsole};
    const codexFolder=join(directory,'codex-history','sessions'),claudeFolder=join(directory,'claude-history','projects','fixture'),otherCwd=join(directory,'other-workspace');await mkdir(codexFolder,{recursive:true});await mkdir(claudeFolder,{recursive:true});await mkdir(otherCwd);
    const timestamp='2026-10-16T11:00:00.000Z',sessionId='11111111-1111-4111-8111-111111111111',claudeId='22222222-2222-4222-8222-222222222222';
    const rows=[{type:'session_meta',timestamp,payload:{id:sessionId,cwd:directory}},{type:'event_msg',timestamp,payload:{type:'user_message',message:'Remember the previous Codex task'}},{type:'response_item',timestamp,payload:{type:'reasoning',encrypted_content:'PRIVATE_REASONING_NEVER_RENDER'}}];
    for(let index=0;index<105;index++)rows.push({type:'response_item',timestamp,payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Public remembered response '+index}]}} as never);
    const historyPath=join(codexFolder,'rollout-target.jsonl');await writeFile(historyPath,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');await utimes(historyPath,new Date('2026-10-16T12:00:00Z'),new Date('2026-10-16T12:00:00Z'));
    for(let index=0;index<31;index++){const id='33333333-3333-4333-8333-'+String(index).padStart(12,'0');await writeFile(join(codexFolder,'rollout-'+index+'.jsonl'),JSON.stringify({type:'session_meta',timestamp,payload:{id,cwd:directory}})+'\n'+JSON.stringify({type:'event_msg',timestamp,payload:{type:'user_message',message:'Older Codex conversation '+index}})+'\n');await utimes(join(codexFolder,'rollout-'+index+'.jsonl'),new Date(timestamp),new Date(timestamp));}
    await writeFile(join(codexFolder,'rollout-other.jsonl'),JSON.stringify({type:'session_meta',timestamp,payload:{id:'44444444-4444-4444-8444-444444444444',cwd:otherCwd}})+'\n'+JSON.stringify({type:'event_msg',timestamp,payload:{type:'user_message',message:'Different repository private title'}})+'\n');
    await writeFile(join(claudeFolder,'claude.jsonl'),[{type:'user',sessionId:claudeId,cwd:directory,timestamp,message:{content:'Previous Claude task'}},{type:'assistant',sessionId:claudeId,cwd:directory,timestamp,message:{id:'assistant1',content:[{type:'text',text:'Claude remembered response'},{type:'thinking',thinking:'PRIVATE_THINKING_NEVER_RENDER'}]}}].map(row=>JSON.stringify(row)).join('\n')+'\n');
    await createProject();const project=server.service.snapshot().projects[0]!;click('#project-tab-sessions');await wait(()=>expect(window.document.querySelectorAll('.history-session-card')).toHaveLength(30));expect(element('#board').textContent).not.toContain('Different repository');expect(server.service.snapshot().tasks).toHaveLength(0);expect(server.service.snapshot().runs).toHaveLength(0);click('#more-project-sessions');await wait(()=>expect(window.document.querySelectorAll('.history-session-card')).toHaveLength(33));
    input('#history-provider-filter','claude');element('#history-provider-filter').dispatchEvent(new window.Event('change',{bubbles:true}) as unknown as Event);await wait(()=>expect(window.document.querySelectorAll('.history-session-card')).toHaveLength(1));click('.history-session-card');await wait(()=>expect(element('#agent-console-host').textContent).toContain('Claude remembered response'));expect(element('#modal').hasAttribute('open')).toBe(false);expect(element('#task-panel').getAttribute('aria-modal')).toBe('true');expect(element('#agent-console-host').querySelector('[data-agent-console]')).not.toBeNull();expect(element('#agent-console-host').textContent).not.toContain('PRIVATE_THINKING');expect(element('#agent-console-host .cv-node').classList.contains('cv-user')).toBe(true);expect(element<HTMLFormElement>('#agent-console-host .cv-composer').hidden).toBe(true);click('#close-panel');expect(server.service.snapshot().tasks).toHaveLength(0);
    input('#history-provider-filter','codex');element('#history-provider-filter').dispatchEvent(new window.Event('change',{bubbles:true}) as unknown as Event);await wait(()=>expect(window.document.querySelectorAll('.history-session-card')).toHaveLength(30));const target=[...window.document.querySelectorAll('.history-session-card')].find(button=>button.textContent?.includes('Remember the previous Codex task'))!;(target as unknown as HTMLElement).click();await wait(()=>expect(element('#agent-console-host').textContent).toContain('Public remembered response 0'));expect(element('#agent-console-host').textContent).toContain('Remember the previous Codex task');expect(element('#agent-console-host').textContent).not.toContain('PRIVATE_REASONING');expect(element('#history-detail-more').hidden).toBe(false);expect(window.document.querySelectorAll('#agent-console-host > .history-context-note')).toHaveLength(1);expect(window.document.querySelectorAll('#history-detail-more')).toHaveLength(1);click('#history-detail-more');await wait(()=>expect(element('#agent-console-host').textContent).toContain('Public remembered response 104'));expect(window.document.querySelectorAll('#agent-console-host > .history-context-note')).toHaveLength(1);expect(window.document.querySelector('#history-detail-more')).toBeNull();expect(server.service.snapshot().tasks).toHaveLength(0);expect(server.service.snapshot().events).toHaveLength(0);
    const bin=join(directory,'resume-bin'),proof=join(directory,'resume-proof.json');await mkdir(bin);const script='let input="";process.stdin.on("data",part=>input+=part);process.stdin.on("end",()=>{require("node:fs").writeFileSync('+JSON.stringify(proof)+',JSON.stringify({args:process.argv.slice(2),input,codexHome:process.env.CODEX_HOME}));console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",id:"continued",text:"Original session continued"}}))});';
    if(process.platform==='win32'){const shim=join(bin,'resume.cjs');await writeFile(shim,script);await writeFile(join(bin,'codex.cmd'),'@echo off\r\n"'+process.execPath+'" "'+shim+'" %*\r\n');}else await writeFile(join(bin,'codex'),'#!/usr/bin/env node\n'+script,{mode:0o755});vi.stubEnv('PATH',bin+delimiter+(process.env.PATH||''));
    click('[data-console-continue]');assertModalShell();expect(server.service.snapshot().tasks).toHaveLength(0);input('#history-resume-message','Continue only with the next verification');input('#modal select[name="terminalMode"]','stream');submit('#modal form');await wait(()=>expect(server.service.snapshot().runs[0]?.status).toBe('completed'));await wait(()=>expect(element('#task-panel').textContent).toContain('Original session continued'));expect(element('#task-panel .cv-timeline').textContent).toContain('Public remembered response 104');expect(element('#task-panel .cv-timeline').textContent).toContain('Remember the previous Codex task');expect(element('#task-panel .cv-timeline').textContent).toContain('Geçmiş oturum');expect(server.service.snapshot().events.some(event=>event.message.includes('Public remembered response'))).toBe(false);const result=JSON.parse(await readFile(proof,'utf8'));expect(result.args.slice(0,2)).toEqual(['exec','resume']);expect(result.args).toContain(sessionId);expect(result.input).toContain('Continue only with the next verification');expect(result.codexHome).toBe(join(directory,'codex-history'));expect(createConsole.mock.calls.some(call=>(call[1] as {readOnly?:boolean}).readOnly===true)).toBe(true);expect(createConsole.mock.calls.some(call=>Boolean((call[1] as {taskId?:string}).taskId))).toBe(true);expect(server.service.snapshot().tasks).toHaveLength(1);expect(server.service.snapshot().tasks[0]?.historyResume).toMatchObject({provider:'codex',sessionId});expect(window.localStorage.getItem('aiws.project-tab.'+project.id)).toBe('sessions');expect(server.service.snapshot().tasks[0]?.sessionContinuation).toBe(true);
    const publicMessages=()=>[...window.document.querySelectorAll('#task-panel .cv-assistant>.cv-markdown')].map(node=>node.textContent?.trim());expect(publicMessages().filter(text=>text==='Original session continued')).toHaveLength(1);expect(publicMessages().filter(text=>text==='Public remembered response 0')).toHaveLength(1);
    await appendFile(historyPath,JSON.stringify({type:'response_item',timestamp:new Date().toISOString(),payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Original session continued'}]}})+'\n');await closeWindow(window, pageIdle);await mountRenderer();await wait(()=>expect(window.document.querySelector('[data-project="'+project.id+'"]')).not.toBeNull());click('[data-project="'+project.id+'"]');click('#project-tab-sessions');await wait(()=>expect(window.document.querySelector('[data-history-action="task"]')).not.toBeNull());expect(element('[data-history-action="task"]').textContent).toBe('Oturumu aç');expect(window.document.querySelector('.history-badge.linked')).toBeNull();click('[data-history-action="task"]');await wait(()=>expect(element('.history-context-note').textContent).toContain('birlikte gösteriliyor'));await wait(()=>expect(window.document.querySelector('[data-history-more]')).not.toBeNull());click('[data-history-more]');await wait(()=>expect(publicMessages()).toContain('Public remembered response 104'));expect(publicMessages().filter(text=>text==='Original session continued')).toHaveLength(1);expect(publicMessages().filter(text=>text==='Public remembered response 0')).toHaveLength(1);const freshTask=server.service.snapshot().tasks[0]!;server.service.updateTask(freshTask.id,{priority:3});await new Promise(resolve=>setTimeout(resolve,300));expect(window.document.querySelector('.task-card')).toBeNull();expect(publicMessages().filter(text=>text==='Original session continued')).toHaveLength(1);

    expect(window.document.querySelector('[data-run-action="start"]')).toBeNull();const send=vi.spyOn(server.service,'sendTaskMessage');input('#task-message-input','Apply only the next instruction');submit('#task-message-form');submit('#task-message-form');await wait(()=>expect(server.service.snapshot().runs).toHaveLength(2));await wait(()=>expect(server.service.snapshot().runs[1]?.status).toBe('completed'));expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0]?.[1]).toMatchObject({text:'Apply only the next instruction',continueSession:true});expect(server.service.snapshot().tasks).toHaveLength(1);expect(server.service.snapshot().runs[1]?.taskId).toBe(freshTask.id);expect(server.service.snapshot().runs[1]?.sessionId).toBe(sessionId);expect(JSON.parse(await readFile(proof,'utf8')).args).toContain(sessionId);expect(JSON.parse(await readFile(proof,'utf8')).input).toContain('Apply only the next instruction');await wait(()=>expect(element<HTMLTextAreaElement>('#task-message-input').value).toBe(''));
    send.mockRejectedValueOnce(new Error('The original session cannot be verified'));input('#task-message-input','Keep this failed continuation draft');submit('#task-message-form');await wait(()=>expect(element('.cv-send-error').textContent).toContain('cannot be verified'));expect(element<HTMLTextAreaElement>('#task-message-input').value).toBe('Keep this failed continuation draft');expect(server.service.snapshot().runs).toHaveLength(2);expect(server.service.snapshot().tasks).toHaveLength(1);
  },20000);


  it('loads continued task history from the task worktree without a missing-session warning', async () => {
    await createProject();
    const workspace = join(directory, 'continued-worktree'); await mkdir(workspace);
    const family = seedCodexAgentFamily(join(directory, 'codex-history'), workspace);
    const project = server.service.snapshot().projects[0]!;
    const pointer = await server.service.history.findSession({ ...project, repositoryPath: workspace }, 'codex', family.rootId);
    const task = server.service.createTask({ projectId: project.id, title: 'Continued task', provider: 'codex' });
    const stored = server.service.task(task.id);
    stored.worktree = { path: workspace, repositoryPath: directory, branch: 'task', mainBranch: 'main' };
    stored.historyResume = { provider: 'codex', sessionId: family.rootId, sourceId: pointer!.session.id, initialMessage: 'Continue' };
    stored.createdAt = new Date(Date.now() + 10_000).toISOString();
    await window.eval('refresh()');
    click(`[data-open-task="${task.id}"]`);
    await wait(() => expect(element('#task-panel .cv-timeline').textContent).toContain('ROOT_PUBLIC_ONLY'));
    expect(element('#task-panel .history-context-note').textContent).not.toContain('Session not found');
  });

  it('leaves out the earlier session section of a continued task when none of its records predate the task', async () => {
    await createProject();
    const workspace = join(directory, 'continued-worktree'); await mkdir(workspace);
    const family = seedCodexAgentFamily(join(directory, 'codex-history'), workspace);
    const project = server.service.snapshot().projects[0]!;
    const pointer = await server.service.history.findSession({ ...project, repositoryPath: workspace }, 'codex', family.rootId);
    const task = server.service.createTask({ projectId: project.id, title: 'Continued task', provider: 'codex' });
    const stored = server.service.task(task.id);
    stored.worktree = { path: workspace, repositoryPath: directory, branch: 'task', mainBranch: 'main' };
    stored.historyResume = { provider: 'codex', sessionId: family.rootId, sourceId: pointer!.session.id, initialMessage: 'Continue' };
    stored.createdAt = '2000-01-01T00:00:00.000Z';
    await window.eval('refresh()');
    click(`[data-open-task="${task.id}"]`);
    await wait(() => expect(element('#task-panel .history-context-note').textContent).toContain('Önceki oturum ve yeni çalışma birlikte gösteriliyor.'));
    expect(element('#task-panel .cv-timeline').textContent).not.toContain('ROOT_PUBLIC_ONLY');
    expect([...window.document.querySelectorAll('#task-panel .cv-run-header')].map(header => header.textContent)).not.toContainEqual(expect.stringContaining('Geçmiş oturum'));
  });

  it('shows history loading errors and retry/empty states while retaining the project-scoped tab preference', async () => {
    const read=vi.spyOn(server.service.history,'list').mockRejectedValueOnce(new Error('History folder temporarily unavailable'));
    await createProject();const first=server.service.snapshot().projects[0]!;click('#project-tab-sessions');await wait(()=>expect(element('.history-error').textContent).toContain('temporarily unavailable'));expect(server.service.snapshot().tasks).toHaveLength(0);read.mockRestore();click('#refresh-project-sessions');await wait(()=>expect(element('.history-empty').textContent).toContain('henüz oturum bulunamadı'));expect(window.localStorage.getItem('aiws.project-tab.'+first.id)).toBe('sessions');
    const other=join(directory,'second-project');await mkdir(other);const second=server.service.createProject({name:'Second project',repositoryPath:other});await wait(()=>expect(window.document.querySelector('[data-project="'+second.id+'"]')).not.toBeNull());click('[data-project="'+second.id+'"]');expect(element('#project-tab-board').getAttribute('aria-selected')).toBe('true');click('[data-project="'+first.id+'"]');expect(element('#project-tab-sessions').getAttribute('aria-selected')).toBe('true');element('#project-tab-sessions').focus();element('#project-tab-sessions').dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}) as unknown as Event);expect(element('#project-tab-schedules').getAttribute('aria-selected')).toBe('true');expect(server.service.snapshot().runs).toHaveLength(0);
  });


  it('searches every project session on the server with debounce, filters, date groups, keyboard navigation and single-session conversion', async () => {
    const folder=join(directory,'codex-history','sessions'),claudeFolder=join(directory,'claude-history','projects','fixture');await mkdir(folder,{recursive:true});await mkdir(claudeFolder,{recursive:true});const old=new Date('2020-01-02T10:00:00Z'),recent=new Date();
    for(let index=0;index<34;index++){const id='77777777-7777-4777-8777-'+String(index).padStart(12,'0'),path=join(folder,'rollout-'+index+'.jsonl');await writeFile(path,[{type:'session_meta',timestamp:'2020-01-02T09:00:00Z',payload:{id,cwd:directory}},{type:'event_msg',timestamp:'2020-01-02T09:00:01Z',payload:{type:'user_message',message:index%10===3?'Fix the needle parser '+index:'Ordinary request '+index}},{type:'event_msg',payload:{type:'task_complete'}}].map(row=>JSON.stringify(row)).join('\n')+'\n');await utimes(path,index<3?recent:old,index<3?recent:old);}
    const claudeId='88888888-8888-4888-8888-888888888888',claudePath=join(claudeFolder,'claude.jsonl');await writeFile(claudePath,JSON.stringify({type:'user',sessionId:claudeId,cwd:directory,timestamp:'2020-01-02T09:00:00Z',message:{content:'Claude needle follow-up'}})+'\n');await utimes(claudePath,old,old);
    await createProject();click('#project-tab-sessions');await wait(()=>expect(window.document.querySelectorAll('.history-session-card')).toHaveLength(30));
    expect([...window.document.querySelectorAll('.history-group-heading span')].map(node=>node.textContent)).toEqual(['Bugün','Daha eski']);expect(element('[data-history-summary]').textContent).toContain('35 oturum bulundu');expect(element('[data-history-summary]').textContent).toContain('30 gösteriliyor');expect(element('#more-project-sessions').textContent).toContain('(5)');expect(element('.history-session-card time').getAttribute('title')).toBeTruthy();
    const list=vi.spyOn(server.service.history,'list');const search=element<HTMLInputElement>('#history-search');search.focus();
    for(const value of ['n','ne','needle']){search.value=value;search.dispatchEvent(new window.Event('input',{bubbles:true}) as unknown as Event);}
    await wait(()=>expect(window.document.querySelectorAll('.history-session-card')).toHaveLength(5));expect(list).toHaveBeenCalledTimes(1);expect(list.mock.calls[0]?.[1]).toMatchObject({q:'needle'});expect(element('[data-history-summary]').textContent).toContain('5 sonuç');expect(window.document.querySelector('#more-project-sessions')).toBeNull();expect(element('.history-session-card mark').textContent?.toLowerCase()).toBe('needle');expect(window.document.activeElement).toBe(search);
    expect(element('#history-provider-filter').textContent).toContain('Claude Code (1)');input('#history-provider-filter','claude');element('#history-provider-filter').dispatchEvent(new window.Event('change',{bubbles:true}) as unknown as Event);await wait(()=>expect(window.document.querySelectorAll('.history-session-card')).toHaveLength(1));expect(element('.history-session-card').textContent).toContain('Claude needle follow-up');
    search.value='no such conversation';search.dispatchEvent(new window.Event('input',{bubbles:true}) as unknown as Event);search.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}) as unknown as Event);await wait(()=>expect(element('.history-empty').textContent).toContain('Eşleşen oturum bulunamadı'));
    click('.history-empty [data-history-clear]');await wait(()=>expect(window.document.querySelectorAll('.history-session-card')).toHaveLength(30));expect(search.value).toBe('');expect(element<HTMLSelectElement>('#history-provider-filter').value).toBe('');
    input('#history-sort','oldest');element('#history-sort').dispatchEvent(new window.Event('change',{bubbles:true}) as unknown as Event);await wait(()=>expect(window.document.querySelector('.history-group-heading span')?.textContent).toBe('Daha eski'));
    input('#history-sort','recent');element('#history-sort').dispatchEvent(new window.Event('change',{bubbles:true}) as unknown as Event);await wait(()=>expect(window.document.querySelector('.history-group-heading span')?.textContent).toBe('Bugün'));
    search.focus();search.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}) as unknown as Event);const opens=[...window.document.querySelectorAll('[data-history-open]')];expect(window.document.activeElement).toBe(opens[0]);
    opens[0]!.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}) as unknown as Event);expect(window.document.activeElement).toBe(opens[1]);opens[1]!.dispatchEvent(new window.KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}) as unknown as Event);expect(window.document.activeElement).toBe(opens.at(-1));opens.at(-1)!.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}) as unknown as Event);expect(window.document.activeElement).toBe(opens[0]);opens[0]!.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}) as unknown as Event);expect(window.document.activeElement).toBe(search);
    (opens[0] as unknown as HTMLElement).click();await wait(()=>expect(element('#task-panel').hidden).toBe(false));await wait(()=>expect(element('[data-history-session].selected')).not.toBeNull());click('#close-panel');expect(server.service.snapshot().tasks).toHaveLength(0);
    const card=element('.history-session-card'),sourceId=card.dataset.historySession!;(card.querySelector('[data-history-action="convert"]') as unknown as HTMLElement).click();await wait(()=>expect(server.service.snapshot().tasks).toHaveLength(1));expect(server.service.snapshot().tasks[0]?.externalHistory?.sourceId).toBe(sourceId);expect(server.service.snapshot().runs).toHaveLength(0);
    await wait(()=>expect(element(`[data-history-session="${sourceId}"]`).textContent).toContain('Görev olarak ekli'));const open=element(`[data-history-session="${sourceId}"] [data-history-action="task"]`);expect(open.dataset.taskId).toBe(server.service.snapshot().tasks[0]!.id);open.click();await wait(()=>expect(element('#task-detail-title').textContent).toContain(server.service.snapshot().tasks[0]!.title));
  },20000);

  async function loadFloatingConsoleStyles(): Promise<void> {
    const style=window.document.createElement('style');style.textContent=await uiStyleSource();window.document.head.append(style);
  }
  function dragFloating(target: HTMLElement, dx: number, dy: number): void {
    target.dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true,button:0,clientX:100,clientY:100,pointerId:1}) as unknown as Event);
    window.dispatchEvent(new window.PointerEvent('pointermove',{clientX:100+dx,clientY:100+dy,pointerId:1,cancelable:true}) as unknown as Event);
    window.dispatchEvent(new window.PointerEvent('pointerup',{pointerId:1}) as unknown as Event);
    target.click();
  }

  it('keeps a floating task console alive across navigation, updates, resize and minimize', async () => {
    await loadFloatingConsoleStyles();
    await createProject();await createTask('Floating console task');click('#detail-tab-console');await consoleMounted();
    const task=server.service.snapshot().tasks[0]!;
    const root=element('#task-panel [data-agent-console]');
    const draft=element<HTMLTextAreaElement>('#task-message-input');draft.value='Keep this draft';
    click('#task-panel [data-cv-action="float"]');
    const panel=element('.floating-console');expect(window.getComputedStyle(panel.querySelector('.modal-header')!).height).toBe('30px');expect(panel.classList.contains('app-modal')).toBe(true);expect(panel.hasAttribute('open')).toBe(true);expect(panel.contains(root)).toBe(true);
    click('#close-panel');click('#settings-button');
    expect(root.isConnected).toBe(true);expect(panel.contains(root)).toBe(true);
    server.service.postMessage(task.id,{text:'Floating live update',authorType:'user'});
    await wait(()=>expect(root.textContent).toContain('Floating live update'));
    const handle=element('[data-float-resize="e"]');const width=parseFloat(panel.style.width);
    handle.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}) as unknown as Event);
    expect(parseFloat(panel.style.width)).toBe(width+20);
    const beforeLeft=parseFloat(panel.style.left),beforeTop=parseFloat(panel.style.top);
    const title=element('[data-float="restore"]');
    title.dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true,button:0,clientX:20,clientY:20,pointerId:1}) as unknown as Event);
    panel.dispatchEvent(new window.PointerEvent('pointermove',{bubbles:true,clientX:50,clientY:10,pointerId:1}) as unknown as Event);
    panel.dispatchEvent(new window.PointerEvent('pointerup',{bubbles:true,pointerId:1}) as unknown as Event);
    expect(parseFloat(panel.style.left)).toBe(beforeLeft+30);expect(parseFloat(panel.style.top)).toBe(beforeTop-10);
    title.click();
    const saved={width:panel.style.width,height:panel.style.height,left:panel.style.left,top:panel.style.top};
    click('[data-float="minimize"]');expect(element('.floating-console-body').hidden).toBe(true);
    const header=element('.floating-console .modal-header');
    header.dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:2}) as unknown as Event);
    header.dispatchEvent(new window.PointerEvent('pointerup',{bubbles:true,pointerId:2}) as unknown as Event);header.click();
    expect(panel.style.width).toBe(saved.width);expect(panel.style.height).toBe(saved.height);
    expect(parseFloat(panel.style.left)).toBe(8);expect(parseFloat(panel.style.top)+parseFloat(panel.style.height)).toBe(window.innerHeight-8);
    const restored={left:panel.style.left,top:panel.style.top};
    click('[data-float="fullscreen"]');expect(panel.style.width).toBe(`${window.innerWidth}px`);
    click('[data-float="fullscreen"]');expect(panel.style.width).toBe(saved.width);expect(panel.style.left).toBe(restored.left);expect(panel.style.top).toBe(restored.top);
    click('[data-float="dock"]');expect(window.document.querySelector('.floating-console')).toBeNull();
    window.eval(`openTask(${JSON.stringify(task.id)})`);click('#detail-tab-console');
    expect(element('#task-panel [data-agent-console]')).toBe(root);expect(draft.value).toBe('Keep this draft');
  });

  it('resizes floating consoles from every edge and corner while keeping the opposite edges fixed and staying on screen', async () => {
    await loadFloatingConsoleStyles();Object.defineProperty(window,'innerWidth',{value:1200,configurable:true});Object.defineProperty(window,'innerHeight',{value:900,configurable:true});
    const geometry=(panel:HTMLElement)=>({x:parseFloat(panel.style.left),y:parseFloat(panel.style.top),width:parseFloat(panel.style.width),height:parseFloat(panel.style.height)});
    for(const edge of ['n','e','s','w','nw','ne','sw','se']){
      const host=window.document.createElement('div');window.document.body.append(host);
      const popup=(window as any).AIWSUI.floatConsole(host,'Resize '+edge),panel=popup.panel as HTMLElement;
      dragFloating(panel.querySelector('.floating-console-title')!,300,-250);
      const before=geometry(panel),handle=panel.querySelector(`[data-float-resize="${edge}"]`)!;
      const dx=edge.includes('w')?-60:edge.includes('e')?60:0,dy=edge.includes('n')?-40:edge.includes('s')?40:0;
      dragFloating(handle,dx,dy);const after=geometry(panel);
      expect(after.width).toBe(before.width+(dx?60:0));expect(after.height).toBe(before.height+(dy?40:0));
      expect(after.x).toBe(before.x+(edge.includes('w')?dx:0));expect(after.y).toBe(before.y+(edge.includes('n')?dy:0));
      if(edge.includes('w'))expect(after.x+after.width).toBe(before.x+before.width);
      if(edge.includes('n'))expect(after.y+after.height).toBe(before.y+before.height);
      dragFloating(handle,dx*100,dy*100);const bounded=geometry(panel);
      expect(bounded.x).toBeGreaterThanOrEqual(8);expect(bounded.y).toBeGreaterThanOrEqual(8);
      expect(bounded.x+bounded.width).toBeLessThanOrEqual(1192);expect(bounded.y+bounded.height).toBeLessThanOrEqual(892);
      expect(panel.querySelector('.floating-console-resize')).toBeNull();popup.close();host.remove();
    }
  });

  it('stacks minimized consoles from the bottom left into rows and restores their saved size with a title click', async () => {
    await loadFloatingConsoleStyles();Object.defineProperty(window,'innerWidth',{value:620,configurable:true});Object.defineProperty(window,'innerHeight',{value:900,configurable:true});
    const popups:any[]=[];
    for(let index=0;index<8;index++){
      const host=window.document.createElement('div');window.document.body.append(host);const popup=(window as any).AIWSUI.floatConsole(host,'Dock '+index);popups.push(popup);
      popup.panel.querySelector('[data-float="minimize"]').click();
    }
    const panels=popups.map(popup=>popup.panel as HTMLElement);
    expect(panels[0]!.style.left).toBe('8px');expect(panels[0]!.style.top).toBe('862px');expect(panels[0]!.style.height).toBe('30px');
    expect(panels[1]!.style.left).toBe('276px');expect(panels[1]!.style.top).toBe('862px');
    expect(panels[2]!.style.left).toBe('8px');expect(panels[2]!.style.top).toBe('824px');
    const title=panels[0]!.querySelector('.floating-console-title')!;
    title.dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true,button:0,clientX:10,clientY:870,pointerId:3}) as unknown as Event);
    window.dispatchEvent(new window.PointerEvent('pointermove',{clientX:11,clientY:870,pointerId:3}) as unknown as Event);
    title.dispatchEvent(new window.PointerEvent('pointerup',{bubbles:true,pointerId:3}) as unknown as Event);title.click();
    expect(panels[0]!.classList.contains('is-minimized')).toBe(false);expect(panels[0]!.style.width).toBe('560px');expect(panels[0]!.style.height).toBe('360px');expect(panels[0]!.style.top).toBe('532px');
    expect(panels[1]!.style.left).toBe('8px');
    panels[0]!.querySelector<HTMLButtonElement>('[data-float="minimize"]')!.click();
    Object.defineProperty(window,'innerWidth',{value:320,configurable:true});Object.defineProperty(window,'innerHeight',{value:180,configurable:true});window.dispatchEvent(new window.Event('resize'));
    const occupied=new Set();
    for(const panel of panels){
      const x=parseFloat(panel.style.left),y=parseFloat(panel.style.top),width=parseFloat(panel.style.width),height=parseFloat(panel.style.height);
      expect(x).toBeGreaterThanOrEqual(0);expect(y).toBeGreaterThanOrEqual(0);expect(x+width).toBeLessThanOrEqual(320);expect(y+height).toBeLessThanOrEqual(180);
      expect(occupied.has(`${x},${y}`)).toBe(false);occupied.add(`${x},${y}`);
    }
    popups[0].close();expect(panels[1]!.style.left).toBe('8px');
    for(const popup of popups.slice(1))popup.close();
  });

  it('defaults to the app conversation with a separate CLI tab and preserves the console and focus on SSE', async () => {
    await closeWindow(window, pageIdle);await mountRenderer({'aiws.detail-tab':'activity','aiws.task-detail-layout':'horizontal','aiws.task-detail-tab':'obsolete'});await createProject();await createTask('Unified console task');expect(element('#detail-tab-info').getAttribute('aria-selected')).toBe('true');click('#detail-tab-console');await consoleMounted();
    expect([...window.document.querySelectorAll('#task-panel [data-detail-tab]')].map(tab=>tab.textContent)).toEqual(['Bilgiler','Sohbet','Agent Console']);expect(window.document.querySelector('#task-panel [data-detail-tab="activity"]')).toBeNull();expect(window.document.querySelector('[data-action="inline-session"]')).toBeNull();expect(element('#task-panel').getAttribute('role')).toBe('dialog');expect(element('#task-panel').getAttribute('aria-modal')).toBe('true');const root=element('#task-panel [data-agent-console]');const composer=element<HTMLTextAreaElement>('#task-panel #task-message-input');composer.value='Focused user draft';composer.focus();composer.setSelectionRange(4,10);
    const task=server.service.snapshot().tasks[0]!;server.service.postMessage(task.id,{text:'Agent update during editing',authorType:'user'});await wait(()=>expect(element('#task-panel .cv-timeline').textContent).toContain('Agent update during editing'));expect(element('#task-panel [data-agent-console]')).toBe(root);expect(window.document.activeElement).toBe(composer);expect(composer.selectionStart).toBe(4);expect(composer.selectionEnd).toBe(10);
    click('[data-detail-tab="info"]');expect(window.document.querySelector('#agent-console-host')).toBeNull();expect(element('.detail-information').textContent).toContain('Açıklama');click('[data-detail-tab="console"]');expect(element('[data-agent-console]')).toBe(root);expect(element<HTMLTextAreaElement>('#task-message-input').value).toBe('Focused user draft');
    const focusFixture=window.document.createElement('div');focusFixture.innerHTML='<button id="visible-console-tail">Visible action</button><details><summary>Collapsed tools</summary><button id="collapsed-tool-action">Hidden tool action</button></details><div hidden><button>Hidden child action</button></div><div class="cv-raw"><button>Hidden technical action</button></div>';root.append(focusFixture);const collapsedSummary=focusFixture.querySelector('summary')!;collapsedSummary.focus();collapsedSummary.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}) as unknown as Event);expect(window.document.activeElement).toBe(element('#task-panel-resizer'));expect(window.document.activeElement?.id).not.toBe('collapsed-tool-action');focusFixture.remove();
    Object.defineProperty(window,'innerWidth',{value:1600,writable:true,configurable:true});window.dispatchEvent(new window.Event('resize'));const panel=element('#task-panel'),handle=element('#task-panel-resizer'),width=()=>Number.parseInt(panel.style.getPropertyValue('--task-panel-width'));expect(width()).toBe(960);expect(handle.getAttribute('role')).toBe('separator');
    const resizeKey=(key:string)=>handle.dispatchEvent(new window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}) as unknown as Event),pointer=(target:HTMLElement|Window['document'],type:string,clientX:number)=>target.dispatchEvent(new window.PointerEvent(type,{pointerId:7,button:0,clientX,bubbles:true,cancelable:true}) as unknown as Event);
    resizeKey('ArrowLeft');expect(width()).toBe(992);resizeKey('Home');expect(width()).toBe(560);pointer(handle,'pointerdown',1000);pointer(window.document,'pointermove',800);expect(width()).toBe(760);expect(element('[data-agent-console]')).toBe(root);server.service.postMessage(task.id,{text:'Update while resizing',authorType:'user'});await wait(()=>expect(element('.cv-timeline').textContent).toContain('Update while resizing'));expect(element('#task-panel-resizer')).toBe(handle);pointer(window.document,'pointermove',700);expect(width()).toBe(860);pointer(window.document,'pointerup',700);expect(window.localStorage.getItem('aiws.detail-width')).toBe('860');expect(window.document.documentElement.classList.contains('resizing-task-panel')).toBe(false);
    resizeKey('End');expect(width()).toBe(1584);Object.defineProperty(window,'innerWidth',{value:1000});window.dispatchEvent(new window.Event('resize'));expect(width()).toBe(984);Object.defineProperty(window,'innerWidth',{value:600});window.dispatchEvent(new window.Event('resize'));expect(width()).toBe(600);expect(handle.hidden).toBe(true);Object.defineProperty(window,'innerWidth',{value:1600});window.dispatchEvent(new window.Event('resize'));expect(width()).toBe(1584);resizeKey('Home');pointer(handle,'pointerdown',1000);pointer(window.document,'pointermove',900);click('#close-panel');expect(window.document.documentElement.classList.contains('resizing-task-panel')).toBe(false);const storedWidth=window.localStorage.getItem('aiws.detail-width')!;pointer(window.document,'pointermove',100);expect(window.localStorage.getItem('aiws.detail-width')).toBe(storedWidth);// Every open starts again from the default width.
    click('.task-card');expect(width()).toBe(960);expect(window.localStorage.getItem('aiws.detail-width')).toBeNull();
    await remountRenderer({'aiws.detail-width':storedWidth});click('.task-card');expect(element('#task-panel').style.getPropertyValue('--task-panel-width')).not.toBe('660px');expect(window.localStorage.getItem('aiws.detail-width')).toBeNull();
    const app=await uiScriptSource(isAppScript),css=await uiStyleSource();expect(app).not.toContain('inline-session');expect(css).not.toContain('inline-session');expect(app.match(/AIWSAgentConsole\.create\(/g)).toHaveLength(1);expect(window.document.querySelector('.task-card .provider-icon.codex img')?.getAttribute('src')).toBe('/icons/codex.svg');
  });


  it('leaves the task interface to the profile or the PTY default and keeps the agent profile terminal choice', async () => {
    await createProject();click('#create-task');expect(window.document.querySelector('#field-terminalMode')).toBeNull();input('#field-title','Native preference');submit('#modal form');await wait(()=>expect(server.service.snapshot().tasks).toHaveLength(1));const first=server.service.snapshot().tasks[0]!;expect(first.terminalMode).toBeUndefined();expect(server.service.snapshot().runs).toHaveLength(0);
    await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));const legacy=server.service.catalog.createAgent({name:'Explicit stream profile',provider:'codex',terminalMode:'stream'});await wait(()=>expect(element('#agents-count').textContent).toBe('1'));click('#create-task');input('#field-title','Keep explicit profile stream');input('#field-agentId',legacy.id);element('#field-agentId').dispatchEvent(new window.Event('change',{bubbles:true}) as unknown as Event);submit('#modal form');await wait(()=>expect(server.service.snapshot().tasks).toHaveLength(2));expect(server.service.snapshot().tasks[1]).toMatchObject({agentId:legacy.id});expect(server.service.snapshot().tasks[1]?.terminalMode).toBeUndefined();expect(server.service.snapshot().agents[0]?.terminalMode).toBe('stream');
    await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));click('#agents-nav');click('#create-task');expect(element<HTMLSelectElement>('#field-terminalMode').value).toBe('pty');input('#field-provider','command');element('#field-provider').dispatchEvent(new window.Event('change',{bubbles:true}) as unknown as Event);expect(element<HTMLSelectElement>('#field-terminalMode').value).toBe('stream');input('#field-terminalMode','pty');element('#field-terminalMode').dispatchEvent(new window.Event('change',{bubbles:true}) as unknown as Event);input('#field-provider','codex');element('#field-provider').dispatchEvent(new window.Event('change',{bubbles:true}) as unknown as Event);expect(element<HTMLSelectElement>('#field-terminalMode').value).toBe('pty');click('#close-modal');click('[data-edit-agent="'+legacy.id+'"]');expect(element<HTMLSelectElement>('#field-terminalMode').value).toBe('stream');
  });


  it('shows five actual provider subagents in history and live consoles, lazily polls child output, and never sends root input to a child', async () => {
    const family=seedCodexAgentFamily(join(directory,'codex-history'),directory),{rootId,childIds}=family;
    await appendFile(family.children[0]!.path,[{type:'response_item',timestamp:new Date().toISOString(),ordinal:13,payload:{type:'custom_tool_call',call_id:'public-web-call',name:'exec',input:'text(await tools.web__run({search_query:[{q:"PUBLIC_WEB_QUERY_EVIDENCE",domains:["example.com"]}]}));'}},{type:'response_item',timestamp:new Date().toISOString(),ordinal:14,payload:{type:'custom_tool_call_output',call_id:'public-web-call',output:[{type:'input_text',text:'Actual API public source (https://example.com/evidence)\nRetained source excerpt.'}]}}].map(row=>JSON.stringify(row)).join('\n')+'\n');
    const transcripts=vi.spyOn(server.service.agentGraph,'transcript');await createProject();click('#project-tab-sessions');await wait(()=>expect(window.document.querySelectorAll('.history-session-card')).toHaveLength(1));click('.history-session-card');await wait(()=>expect(element('.cv-agent-count').textContent).toContain('5 alt agent'));expect(window.document.querySelectorAll('.cv-agent-row')).toHaveLength(6);expect(transcripts).not.toHaveBeenCalled();expect(element('[data-agent="codex:'+childIds[4]+'"]').style.getPropertyValue('--agent-depth')).toBe('0');expect(element('#agent-console-host .cv-timeline').textContent).not.toContain('CHILD_PUBLIC_1');expect(element('#agent-console-host .cv-timeline').textContent).toContain('ROOT_PUBLIC_ONLY');
    const parentConsole=element('#task-panel [data-agent-console]');click('#task-panel [data-agent="codex:'+childIds[0]+'"]');await wait(()=>expect(element('#agent-child-panel .cv-timeline').textContent).toContain('CHILD_PUBLIC_1'));expect(transcripts).toHaveBeenCalled();expect(element('#agent-child-panel .cv-timeline').textContent).not.toContain('FORKED_PARENT_CONTEXT_MUST_NOT_APPEAR');expect(element('#agent-child-panel .cv-timeline').textContent).not.toContain('PRIVATE_REASONING');expect(element<HTMLFormElement>('#agent-child-panel .cv-composer').hidden).toBe(true);expect(element<HTMLElement>('#agent-child-panel .cv-history-footer').hidden).toBe(true);expect(element('#task-panel [data-agent-console]')).toBe(parentConsole);expect(element('#task-panel .cv-timeline').textContent).toContain('ROOT_PUBLIC_ONLY');expect(element('#task-panel .cv-timeline').textContent).not.toContain('CHILD_PUBLIC_1');expect(server.service.snapshot().tasks).toHaveLength(0);
    expect(element('#agent-child-panel .cv-tool-preview').textContent).toContain('PUBLIC_WEB_QUERY_EVIDENCE');expect(element('#agent-child-panel .cv-web-output').textContent).toContain('Retained source excerpt.');expect(element<HTMLElement>('#agent-child-panel .child-agent-notice').hidden).toBe(true);expect(element('#agent-child-panel').textContent).not.toContain('Ana oturum açık kalır.');expect(element('#agent-child-panel').textContent).not.toContain('◇');expect(element('#agent-child-panel .cv-tool-sources a').getAttribute('href')).toBe('https://example.com/evidence');
    await appendFile(family.children[0]!.path,JSON.stringify({type:'response_item',timestamp:new Date().toISOString(),ordinal:13,payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Worker 1 live progress after selection'}]}})+'\n');await wait(()=>expect(element('#agent-child-panel .cv-timeline').textContent).toContain('Worker 1 live progress after selection'));expect(element('#task-panel [data-agent="codex:'+childIds[0]+'"]').getAttribute('aria-pressed')).toBe('true');
    click('#agent-child-panel [data-agent="codex:'+childIds[4]+'"]');await wait(()=>expect(element('#agent-child-panel .cv-timeline').textContent).toContain('CHILD_PUBLIC_5'));expect(window.document.querySelectorAll('#agent-child-panel')).toHaveLength(1);expect(element('#task-panel [data-agent-console]')).toBe(parentConsole);click('#close-child-agent');expect(element<HTMLElement>('#agent-child-panel').hidden).toBe(true);expect(window.document.activeElement).toBe(element('#task-panel [data-agent="codex:'+childIds[0]+'"]'));
    const bin=join(directory,'tree-provider-bin');await mkdir(bin);const code='process.stdin.resume();process.stdin.on("end",()=>{console.log(JSON.stringify({type:"thread.started",thread_id:'+JSON.stringify(rootId)+'}));console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",id:"root_live",text:"Root live coordination"}}));setInterval(()=>{},1000)});';if(process.platform==='win32'){const shim=join(bin,'codex-tree.cjs');await writeFile(shim,code);await writeFile(join(bin,'codex.cmd'),'@echo off\r\n"'+process.execPath+'" "'+shim+'" %*\r\n');}else await writeFile(join(bin,'codex'),'#!/usr/bin/env node\n'+code,{mode:0o755});vi.stubEnv('PATH',bin+delimiter+(process.env.PATH||''));
    click('#task-panel [data-console-continue]');input('#history-resume-message','Keep coordinating the workers');input('#modal select[name="terminalMode"]','stream');submit('#modal form');await wait(()=>expect(element('#task-panel .cv-timeline').textContent).toContain('Root live coordination'));await wait(()=>expect(element('#task-panel .cv-agent-count').textContent).toContain('5 alt agent'));expect(window.document.querySelectorAll('#task-panel .cv-agent-row')).toHaveLength(6);const run=server.service.snapshot().runs[0]!;expect(run.sessionId).toBe(rootId);input('#task-message-input','Keep root draft');const liveRoot=element('#task-panel [data-agent-console]');click('#task-panel [data-agent="codex:'+childIds[1]+'"]');await wait(()=>expect(element('#agent-child-panel .cv-timeline').textContent).toContain('CHILD_PUBLIC_2'));expect(element<HTMLFormElement>('#agent-child-panel .cv-composer').hidden).toBe(true);const beforeMessages=server.service.snapshot().messages.length,beforeCommands=[...server.service.snapshot().runs[0]!.pendingCommands];submit('#agent-child-panel .cv-composer');await new Promise(resolve=>setTimeout(resolve,50));expect(server.service.snapshot().messages).toHaveLength(beforeMessages);expect(server.service.snapshot().runs[0]?.pendingCommands).toEqual(beforeCommands);expect(element('#task-panel [data-agent-console]')).toBe(liveRoot);expect(element<HTMLTextAreaElement>('#task-message-input').value).toBe('Keep root draft');expect(element<HTMLFormElement>('#task-panel .cv-composer').hidden).toBe(false);click('#close-child-agent');await server.service.stop(run.id);
  },20000);

  it('shows independently running provider sessions in the shared read-only console and updates native titles without creating tasks', async () => {
    const home=join(directory,'codex-history'),family=seedCodexAgentFamily(home,directory);await mkdir(join(home,'thread-writer-locks'),{recursive:true});const lock=join(home,'thread-writer-locks',family.rootId+'.lock');await writeFile(lock,'');await writeFile(join(home,'session_index.jsonl'),JSON.stringify({id:family.rootId,thread_name:'Native CLI session name'})+'\n');nativeEvidence={processes:[{pid:50001,name:'codex.exe',command:'codex'}],owners:{[lock]:[50001]}};
    await createProject();const before=JSON.stringify(server.service.snapshot());click('#overview-nav');click('#overview-tab-sessions');await wait(()=>expect(window.document.querySelectorAll('[data-session-card^="external:"]')).toHaveLength(1));expect(element('[data-session-overview]').textContent).toContain('Native CLI session name');expect(element('[data-session-filter="external"] strong').textContent).toBe('1');expect(element('#sessions-count').textContent).toBe('1');expect(element('[data-session-total]').textContent).toBe('1 aktif oturum');expect(window.document.querySelectorAll('.session-terminal [data-terminal-pane]')).toHaveLength(0);click('[data-session-card^="external:"]');await wait(()=>expect(element('.cv-timeline').textContent).toContain('ROOT_PUBLIC_ONLY'));await wait(()=>expect(element('.cv-agent-count').textContent).toContain('5 alt agent'));const root=element('[data-agent-console]');expect(window.document.querySelectorAll('#agent-console-host > .history-context-note')).toHaveLength(1);expect(element('#task-detail-title').textContent).toBe('Native CLI session name');expect(element<HTMLElement>('.cv-composer').hidden).toBe(true);expect(element<HTMLElement>('[data-console-continue]').hidden).toBe(true);expect(window.document.querySelector('[data-run-action]')).toBeNull();expect(element('#modal').hasAttribute('open')).toBe(false);click('[data-detail-tab="info"]');expect(element('.detail-information').textContent).toContain('kendi sağlayıcı penceresinde');expect(window.document.querySelector('[data-history-continue]')).toBeNull();click('[data-detail-tab="console"]');expect(element('[data-agent-console]')).toBe(root);
    click('#task-panel [data-agent="codex:'+family.childIds[0]+'"]');await wait(()=>expect(element('#agent-child-panel .cv-timeline').textContent).toContain('CHILD_PUBLIC_1'));expect(element('#agent-child-panel .cv-timeline').textContent).not.toContain('PRIVATE_REASONING');expect(element('#task-panel [data-agent-console]')).toBe(root);click('#close-child-agent');await appendFile(family.rootPath,JSON.stringify({type:'response_item',timestamp:new Date().toISOString(),payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'External root live update'}]}})+'\n');await appendFile(join(home,'session_index.jsonl'),JSON.stringify({id:family.rootId,thread_name:'Renamed in native Codex'})+'\n');server.service.liveSessions.invalidate();click('[data-refresh-live]');await wait(()=>expect(element('#task-detail-title').textContent).toBe('Renamed in native Codex'));await wait(()=>expect(element('#task-panel .cv-timeline').textContent).toContain('External root live update'));expect(element('#task-panel [data-agent-console]')).toBe(root);expect(element('#task-panel .cv-console-heading strong').textContent).toBe('Renamed in native Codex');expect(element('[data-session-overview]').textContent).toContain('Renamed in native Codex');expect(window.document.querySelectorAll('#agent-console-host > .history-context-note')).toHaveLength(1);expect(element('#agent-console-host > .history-context-note').textContent).toContain('Harici canlı oturum · Salt okunur');expect(JSON.stringify(server.service.snapshot())).toBe(before);
    nativeEvidence={processes:[],owners:{}};server.service.liveSessions.invalidate();click('[data-refresh-live]');await wait(()=>expect(window.document.querySelectorAll('[data-session-card^="external:"]')).toHaveLength(0));await wait(()=>expect(element('#task-panel').textContent).toContain('Harici oturum kapandı'));expect(element('.cv-timeline').textContent).toContain('External root live update');expect(server.service.snapshot().tasks).toHaveLength(0);
  },20000);

  it('opens subagents in one adjacent read-only offcanvas, clamps without saving the parent width, and closes the innermost pane first', async () => {
    const family=seedCodexAgentFamily(join(directory,'codex-history'),directory);await createProject();click('#project-tab-sessions');await wait(()=>expect(window.document.querySelector('.history-session-card')).not.toBeNull());click('.history-session-card');await wait(()=>expect(element('#task-panel .cv-agent-count').textContent).toContain('5 alt agent'));
    Object.defineProperty(window,'innerWidth',{value:1600,writable:true,configurable:true});window.dispatchEvent(new window.Event('resize'));const parent=element('#task-panel'),root=element('#task-panel [data-agent-console]'),handle=element('#task-panel-resizer');handle.dispatchEvent(new window.KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}) as unknown as Event);expect(parent.style.getPropertyValue('--task-panel-width')).toBe('1584px');const preference=window.localStorage.getItem('aiws.detail-width');
    const opener=element('#task-panel [data-agent="codex:'+family.childIds[0]+'"]');opener.click();await wait(()=>expect(element('#agent-child-panel .cv-timeline').textContent).toContain('CHILD_PUBLIC_1'));const child=element('#agent-child-panel'),childRoot=element('#agent-child-panel [data-agent-console]');expect(child.parentElement).toBe(parent.parentElement);expect(parent.contains(child)).toBe(false);expect(child.style.getPropertyValue('--child-panel-right')).toBe('1224px');expect(child.style.getPropertyValue('--child-panel-width')).toBe('360px');expect(parent.style.getPropertyValue('--task-panel-width')).toBe('1224px');expect(window.localStorage.getItem('aiws.detail-width')).toBe(preference);expect(element('#task-panel [data-agent-console]')).toBe(root);expect(element('#task-panel .cv-timeline').textContent).not.toContain('CHILD_PUBLIC_1');
    click('#agent-child-panel [data-agent="codex:'+family.childIds[4]+'"]');await wait(()=>expect(element('#agent-child-panel .cv-timeline').textContent).toContain('CHILD_PUBLIC_5'));expect(window.document.querySelectorAll('#agent-child-panel')).toHaveLength(1);expect(element('#agent-child-panel [data-agent-console]')).not.toBe(childRoot);expect(element<HTMLFormElement>('#agent-child-panel .cv-composer').hidden).toBe(true);expect(element<HTMLElement>('#agent-child-panel .cv-history-footer').hidden).toBe(true);
    Object.defineProperty(window,'innerWidth',{value:600});window.dispatchEvent(new window.Event('resize'));expect(child.dataset.stacked).toBe('true');expect(child.style.getPropertyValue('--child-panel-width')).toBe('600px');expect(child.style.getPropertyValue('--child-panel-right')).toBe('0px');expect(element('#task-panel [data-agent-console]')).toBe(root);
    element('#close-child-agent').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}) as unknown as Event);expect(child.hidden).toBe(true);expect(parent.hidden).toBe(false);expect(window.document.activeElement).toBe(opener);Object.defineProperty(window,'innerWidth',{value:1600});window.dispatchEvent(new window.Event('resize'));expect(parent.style.getPropertyValue('--task-panel-width')).toBe('1584px');expect(window.localStorage.getItem('aiws.detail-width')).toBe(preference);
    const read=server.service.agentGraph.transcript.bind(server.service.agentGraph);let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);vi.spyOn(server.service.agentGraph,'transcript').mockImplementationOnce(async(...args)=>{await gate;return read(...args);});opener.click();click('#close-panel');expect(parent.hidden).toBe(true);expect(child.hidden).toBe(true);release();await new Promise(resolve=>setTimeout(resolve,100));expect(child.hidden).toBe(true);expect(parent.hidden).toBe(true);expect(server.service.snapshot().tasks).toHaveLength(0);
  },20000);

  it('imports every project root once from the history toolbar and keeps source-linked task consoles honest', async () => {
    const home=join(directory,'codex-history'),folder=join(home,'sessions');await mkdir(folder,{recursive:true});const timestamp='2026-10-15T12:00:00Z';
    for(let index=0;index<32;index++){const sessionId='66666666-6666-4666-8666-'+String(index).padStart(12,'0');await writeFile(join(folder,'rollout-'+index+'.jsonl'),[{type:'session_meta',timestamp,payload:{id:sessionId,cwd:directory}},{type:'event_msg',timestamp,payload:{type:'user_message',message:'Original user request '+index}},{type:'response_item',timestamp,payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Finished source '+index}]}},{type:'event_msg',timestamp,payload:{type:'task_complete'}}].map(row=>JSON.stringify(row)).join('\n')+'\n');}
    await writeFile(join(home,'session_index.jsonl'),JSON.stringify({id:'66666666-6666-4666-8666-000000000000',thread_name:'Canonical imported console'})+'\n');await createProject();click('#project-tab-sessions');await wait(()=>expect(window.document.querySelectorAll('.history-session-card')).toHaveLength(30));expect(server.service.snapshot().tasks).toHaveLength(0);click('#import-project-history');expect(element<HTMLButtonElement>('#import-project-history').disabled).toBe(true);click('#import-project-history');await wait(()=>expect(server.service.snapshot().tasks).toHaveLength(32));await wait(()=>expect(element('.history-import-status').textContent).toContain('32 görev eklendi'));expect(server.service.snapshot().runs).toHaveLength(0);expect(server.service.snapshot().tasks.every(task=>task.status==='done')).toBe(true);const imported=server.service.snapshot().tasks.find(task=>task.title==='Canonical imported console')!;expect(imported.description).toBe('Original user request 0');expect(imported.currentRunId).toBeNull();click('#import-project-history');await wait(()=>expect(element('.history-import-status').textContent).toContain('32 mevcut oturum atlandı'));expect(server.service.snapshot().tasks).toHaveLength(32);click('#project-tab-board');await wait(()=>expect(window.document.querySelector('[data-open-task="'+imported.id+'"]')).not.toBeNull());click('[data-open-task="'+imported.id+'"]');click('[data-detail-tab="console"]');await wait(()=>expect(element('.cv-timeline').textContent).toContain('Finished source 0'));expect(element('[data-agent-console]')).not.toBeNull();expect(window.document.querySelector('[data-run-action="start"]')).toBeNull();expect(element('#task-panel').textContent).not.toContain('Yeniden çalıştır');expect(server.service.snapshot().runs).toHaveLength(0);
  },20000);

  it('opens a wide task editor with only Title, Description and the agent choice outside collapsed advanced settings and preserves legacy priority', async () => {
    await createProject();click('#create-task');
    expect(element('#task-advanced').hasAttribute('open')).toBe(false);
    expect(window.document.querySelector('#task-ai-intake')).toBeNull();expect(window.document.querySelector('#task-ai-message')).toBeNull();expect(element('#task-open-ai').hidden).toBe(false);
    expect(element('#field-title').closest('#task-advanced')).toBeNull();expect(element('#field-description').closest('#task-advanced')).toBeNull();
    expect(element('#field-agentId').closest('#task-execution')).not.toBeNull();expect(element('#field-agentId').closest('#task-advanced')).toBeNull();
    for(const selector of ['#field-priority','#blocked-by-search','#field-status','#field-usageProvider','#field-tags','#field-baseBranch'])expect(element(selector).closest('#task-advanced')).not.toBeNull();
    expect(element('.modal-header').closest('.task-editor-scroll')).toBeNull();expect(element('.modal-footer').closest('.task-editor-scroll')).toBeNull();
    expect(element('#modal').classList.contains('task-editor-modal')).toBe(true);
    expect([...element<HTMLSelectElement>('#field-priority').options].map(option=>[option.text,option.value])).toEqual([['High','3'],['Medium','2'],['Low','1']]);
    expect(element<HTMLSelectElement>('#field-priority').value).toBe('2');expect(window.document.querySelector('#field-dependsOn')).toBeNull();
    input('#field-title','Minimal task');submit('#task-editor-form');await wait(()=>expect(server.service.snapshot().tasks).toHaveLength(1));
    const task=server.service.snapshot().tasks[0]!;expect(task.priority).toBe(2);await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));server.service.updateTask(task.id,{priority:-22,title:'Legacy task'});await wait(()=>expect(element('.task-card h3').textContent).toBe('Legacy task'));
    click(`[data-open-task="${task.id}"]`);click('[data-detail-tab="info"]');await wait(()=>expect(element<HTMLSelectElement>('#info-priority').value).toBe('-22'));expect(element('#info-priority').textContent).toContain('Custom (-22)');
    commit('#info-title','Keep legacy priority');await wait(()=>expect(server.service.task(task.id).title).toBe('Keep legacy priority'));expect(server.service.task(task.id).priority).toBe(-22);
    commit('#info-priority','3');await wait(()=>expect(server.service.task(task.id).priority).toBe(3));
    const css=await uiStyleSource();expect(css).toContain('.task-editor-scroll{');expect(css).toContain('width:min(900px');
  },15000);
  it('splits advanced options into tabs without nested groups and preserves values through draft restore and save', async () => {
    await createProject();click('#create-task');
    expect(window.document.querySelector('.task-option-group')).toBeNull();expect(window.document.querySelector('.ready-explainer')).toBeNull();
    expect([...window.document.querySelectorAll('[data-task-option-tab]')].map(tab=>tab.getAttribute('data-task-option-tab'))).toEqual(['planning','triggers','labels','git']);
    for(const [selector,id] of [['#field-priority','planning'],['#field-status','planning'],['#blocked-by-search','planning'],['#field-scheduledAt','triggers'],['#field-usageProvider','triggers'],['#field-tags','labels'],['#field-baseBranch','git']]){
      expect(element(selector!).closest('.task-option-panel')?.id).toBe(`task-options-${id}`);
    }
    for(const selector of ['#field-workflowId','input[name="deployRequested"]','input[name="skillIds"]'])expect(window.document.querySelector(selector),selector).toBeNull();
    expect(element('#field-title').closest('.form-field')?.nextElementSibling?.id).toBe('task-execution');expect(element('#field-agentId').closest('#task-execution')).not.toBeNull();
    (element('#task-advanced') as HTMLDetailsElement).open=true;
    expect(element('#task-options-planning').hidden).toBe(false);expect(element('#task-options-labels').hidden).toBe(true);
    click('#task-tab-labels');expect(element('#task-options-labels').hidden).toBe(false);expect(element('#task-options-planning').hidden).toBe(true);expect(element('#task-tab-labels').getAttribute('aria-selected')).toBe('true');
    element('#task-tab-labels').dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}) as unknown as Event);expect(element('#task-options-git').hidden).toBe(false);
    input('#field-title','Compact settings');input('#field-priority','3');
    input('#field-tags','frontend, polish');element('#field-tags').dispatchEvent(new window.Event('input',{bubbles:true}) as unknown as Event);
    expect(element('#task-tab-labels .task-option-count').textContent).toBe('2');expect(element('#task-tab-planning .task-option-count').textContent).toBe('');
    element('#modal').dispatchEvent(new window.MouseEvent('click',{bubbles:true,clientX:-10,clientY:-10}) as unknown as Event);
    click('#restore-task-draft');expect(element('#task-options-git').hidden).toBe(false);
    expect(element<HTMLSelectElement>('#field-priority').value).toBe('3');
    submit('#task-editor-form');await wait(()=>expect(server.service.snapshot().tasks).toHaveLength(1));
    expect(server.service.snapshot().tasks[0]).toMatchObject({title:'Compact settings',priority:3,tags:['frontend','polish'],status:'backlog'});
  });
  it('sets and edits a quota trigger from the task editor and the detail panel', async () => {
    await mkdir(join(directory,'.windows-ai-token-viewer'),{recursive:true});
    const now=Math.floor(Date.now()/1000);
    await writeFile(join(directory,'.windows-ai-token-viewer','usage-cache.json'),JSON.stringify({codex:{updated_at:new Date().toISOString(),value:{rate_limit:{primary_window:{used_percent:24,limit_window_seconds:18000,reset_at:now+3600},secondary_window:{used_percent:63,limit_window_seconds:604800,reset_at:now+86400}}}}}));
    // The server read usage before this cache existed and keeps that scan for five seconds; check codex alone as the usage dialog does.
    await window.eval("checkTokenProvider('codex')");
    const css=await uiStyleSource();expect(css).toContain('.usage-trigger-field{position:fixed;');
    await createProject();click('#create-task');input('#field-title','Spend leftover tokens');edit('#field-status','ready');
    const modalToggle=element('#modal [data-usage-toggle]'),modalPopup=element<HTMLElement>('#field-usagePopup');
    modalToggle.getBoundingClientRect=()=>({left:120,top:700,right:320,bottom:732,width:200,height:32,x:120,y:700,toJSON(){}}) as DOMRect;
    Object.defineProperty(modalPopup,'offsetHeight',{configurable:true,value:130});Object.defineProperty(modalPopup,'offsetWidth',{configurable:true,value:280});
    click('#modal [data-usage-toggle]');expect(modalPopup.hidden).toBe(false);expect(modalPopup.classList.contains('is-above')).toBe(true);
    expect(Number.parseInt(modalPopup.style.top,10)).toBe(566);expect(Number.parseInt(modalPopup.style.left,10)).toBe(120);
    expect(element<HTMLSelectElement>('#field-usageWindow').disabled).toBe(true);
    edit('#field-usageProvider','codex');
    await wait(()=>expect(element<HTMLSelectElement>('#field-usageWindow').options.length).toBeGreaterThan(1));
    expect(element<HTMLSelectElement>('#field-usageWindow').disabled).toBe(false);expect(element('#task-tab-triggers .task-option-count').textContent).toBe('1');
    edit('#field-usageWindow','weekly');input('#field-usageMinutes','90');
    submit('#task-editor-form');
    await wait(()=>expect(server.service.snapshot().tasks[0]?.usageTrigger).toEqual({provider:'codex',window:'weekly',windowMinutes:10080,withinMinutes:90}));
    const id=server.service.snapshot().tasks[0]!.id;
    await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));
    // The dialog closes before the board receives the new task.
    await wait(()=>expect(window.document.querySelector(`[data-open-task="${id}"]`)).not.toBeNull());
    click(`[data-open-task="${id}"]`);click('[data-detail-tab="info"]');
    await wait(()=>expect(element<HTMLSelectElement>('#info-usageProvider').value).toBe('codex'));
    const infoToggle=element('.detail-information [data-usage-toggle]'),infoPopup=element<HTMLElement>('#info-usagePopup');
    infoToggle.getBoundingClientRect=()=>({left:860,top:240,right:1010,bottom:272,width:150,height:32,x:860,y:240,toJSON(){}}) as DOMRect;
    Object.defineProperty(infoPopup,'offsetHeight',{configurable:true,value:130});Object.defineProperty(infoPopup,'offsetWidth',{configurable:true,value:280});
    click('.detail-information [data-usage-toggle]');expect(infoPopup.hidden).toBe(false);
    expect(Number.parseInt(infoPopup.style.left,10)+280).toBeLessThanOrEqual(window.innerWidth-8);
    expect(element<HTMLSelectElement>('#info-usageWindow').value).toBe('weekly');expect(element<HTMLInputElement>('#info-usageMinutes').value).toBe('90');
    commit('#info-usageMinutes','30');await wait(()=>expect(server.service.task(id).usageTrigger?.withinMinutes).toBe(30));
    expect(element<HTMLElement>('#info-usagePopup').hidden).toBe(false);
    commit('#info-usageWindow','short');await wait(()=>expect(server.service.task(id).usageTrigger).toMatchObject({window:'short',windowMinutes:300,withinMinutes:30}));
    commit('#info-usageMode','reset');
    await wait(()=>expect(server.service.task(id).usageTrigger).toMatchObject({mode:'reset',resetsAt:new Date((now+3600)*1000).toISOString()}));
    expect(element<HTMLElement>('#info-usagePopup .usage-trigger-minutes').hidden).toBe(true);
    expect(element('.detail-information .usage-trigger-summary').textContent).toContain('Kota yenilenince');
    commit('#info-usageMode','before');await wait(()=>expect(server.service.task(id).usageTrigger?.mode).toBeUndefined());
    commit('#info-usageProvider','');await wait(()=>expect(server.service.task(id).usageTrigger).toBeUndefined());
  });
  it('hides the agent library, skills and workflows until the library is turned on', async () => {
    expect(element('.library-nav').hidden).toBe(true);
    await createProject();await createTask('Plain task');click('[data-detail-tab="info"]');
    for(const selector of ['#info-agentId','input[name="info-skillIds"]','#info-workflowId','#info-deployRequested','#issue-workflow-title','#info-terminalMode'])expect(window.document.querySelector(selector),selector).toBeNull();
    expect(element('#issue-git-title').textContent).toBe('Git');expect(element('#issue-git-title').closest('.issue-panel')?.querySelector('#info-baseBranch')).not.toBeNull();
    const agent=server.service.catalog.createAgent({name:'Visible agent',provider:'codex'});server.service.workflows.create({name:'Visible workflow',steps:[{id:'one',name:'Implement',agentId:agent.id,instructions:'',condition:'always'}]});
    await wait(()=>expect(window.document.querySelector('#info-agentId')).not.toBeNull());
    expect(window.document.querySelector('#issue-workflow-title')).toBeNull();
    await withLibrary();expect(element('.library-nav').hidden).toBe(false);
    click(`[data-open-task="${server.service.snapshot().tasks[0]!.id}"]`);click('[data-detail-tab="info"]');
    await wait(()=>expect(element('#issue-workflow-title').closest('.issue-panel')?.querySelector('#info-workflowId')).not.toBeNull());
    expect(element('#issue-workflow-title').closest('.issue-panel')?.querySelector('#info-baseBranch')).toBeNull();
    const id=server.service.snapshot().tasks[0]!.id;server.service.updateTask(id,{provider:'command',agentId:null,command:{executable:process.execPath,args:['-e','setTimeout(()=>{},200)']},terminalMode:'stream'});
    const run=server.service.startTask(id);await wait(()=>expect(element(`#issue-run-title`).closest('.issue-panel')?.querySelector(`[data-run-summary="${run.id}"]`)).not.toBeNull());await server.service.stop(run.id);
  });
  it('refreshes provider models only on request and offers them in model pickers', async () => {
    const list=vi.spyOn(server.service.providerModels,'list').mockResolvedValue({models:[{id:'claude-next-1',name:'Next 1'}],refreshedAt:new Date().toISOString(),source:'Claude Code model catalog'});
    await createProject();expect(list).not.toHaveBeenCalled();
    click('#settings-button');click('#settings-tab-providers');expect(element('[data-provider-models="claude"]').textContent).toContain('Önerilen model listesi');
    click('[data-provider-models-refresh="claude"]');
    await wait(()=>expect(element('[data-provider-models="claude"]').textContent).toContain('Claude Code model catalog'));
    expect(list).toHaveBeenCalledTimes(1);expect(list).toHaveBeenCalledWith('claude');expect(server.service.snapshot().providerModels?.claude?.models).toEqual([{id:'claude-next-1',name:'Next 1'}]);
    click('#agents-nav');click('#create-task');const field=element<HTMLSelectElement>('#field-provider');field.value='claude';field.dispatchEvent(new window.Event('change',{bubbles:true}) as unknown as Event);
    const options=[...element<HTMLSelectElement>('#field-model-choice').options];expect(options.map(option=>option.value)).toContain('claude-next-1');expect(options.map(option=>option.value)).not.toContain('claude-opus-5-5');
    expect(options.find(option=>option.value==='claude-next-1')?.textContent).toBe('Next 1 · claude-next-1');expect(list).toHaveBeenCalledTimes(1);
  });
  it('edits project provider overrides and model merge preferences independently from global settings', async () => {
    server.service.store.state.providerModels={codex:{models:[{id:'strong'},{id:'weak'}],refreshedAt:new Date().toISOString(),source:'test'}};
    await createProject();const project=server.service.snapshot().projects[0]!;
    click('#settings-button');click('#settings-tab-providers');click('[data-provider-models-manage="codex"]');
    click('[name="modelAutoMerge"][value="strong"]');submit('#modal form');
    await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));click('#settings-save');
    await wait(()=>expect(server.service.snapshot().settings.modelAutoMerge?.codex?.strong).toBe(true));
    click('#settings-back');click('#project-tab-settings');click('#settings-tab-providers');
    click('#provider-default-claude');expect(element('[data-provider-card="claude"] .default-badge')).not.toBeNull();expect(window.document.querySelector('[name^="providerEnv-"]')).toBeNull();
    edit('#provider-args-claude','--verbose');
    server.service.updateSettings({defaultModels:{codex:'new-global'}});
    await wait(()=>expect(window.eval('projectProviderSnapshot().defaultModels.codex')).toBe('new-global'));
    click('[data-provider-models-manage="codex"]');
    expect(element<HTMLInputElement>('[name="modelAutoMerge"][value="strong"]').checked).toBe(true);
    click('[name="modelAutoMerge"][value="strong"]');click('[name="modelAutoMerge"][value="weak"]');submit('#modal form');
    await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));
    expect(element('[data-provider-card="claude"] .default-badge')).not.toBeNull();submit('#project-settings-form');
    await wait(()=>expect(server.service.project(project.id).providerSettings).toMatchObject({defaultProvider:'claude',providerArgs:{claude:['--verbose']},modelAutoMerge:{codex:{strong:false,weak:true}}}));
    expect(server.service.project(project.id).providerSettings?.defaultModels?.codex).toBeUndefined();
    expect(server.service.snapshot().settings.defaultProvider).toBe('codex');expect(server.service.snapshot().settings.modelAutoMerge?.codex?.strong).toBe(true);
    await wait(()=>expect(element('#project-settings-save-state').textContent).toBe('Tüm değişiklikler kaydedildi'));
    click('[data-provider-models-manage="codex"]');click('[data-reset-model-merge]');
    expect(element<HTMLInputElement>('[name="modelAutoMerge"][value="strong"]').checked).toBe(true);
    expect(element<HTMLInputElement>('[name="modelAutoMerge"][value="weak"]').checked).toBe(false);
    submit('#modal form');await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));submit('#project-settings-form');
    await wait(()=>expect(server.service.project(project.id).providerSettings?.modelAutoMerge?.codex).toBeUndefined());
    await wait(()=>expect(element('#project-settings-save-state').textContent).toBe('Tüm değişiklikler kaydedildi'));
    click('#project-providers-inherit');submit('#project-settings-form');
    await wait(()=>expect(server.service.project(project.id).providerSettings?.defaultProvider).toBeUndefined());
    expect(server.service.project(project.id).providerSettings?.modelAutoMerge?.codex?.strong).toBeUndefined();
    await wait(()=>expect(element('#project-settings-save-state').textContent).toBe('Tüm değişiklikler kaydedildi'));
    click('#provider-default-codex');submit('#project-settings-form');
    await wait(()=>expect(server.service.project(project.id).providerSettings?.defaultProvider).toBe('codex'));
    server.service.updateSettings({defaultProvider:'claude'});
    expect(server.service.createTask({projectId:project.id,title:'Explicit project default stays'}).provider).toBe('codex');
  });
  it('keeps disabled models out of new pickers even when other tasks and agents used them', async () => {
    server.service.store.state.providerModels={codex:{models:[{id:'gpt-6-luna',name:'GPT-6-Luna'},{id:'gpt-6.1-sol',name:'GPT-6.1-Sol'}],refreshedAt:new Date().toISOString(),source:'test'}};
    await createProject();const project=server.service.snapshot().projects[0]!;
    server.service.catalog.createAgent({name:'Old Luna profile',provider:'codex',model:'gpt-6-luna'});
    server.service.createTask({projectId:project.id,title:'Old Luna task',provider:'codex',model:'gpt-6-luna'});
    server.service.updateSettings({disabledModels:{codex:['gpt-6-luna']}});
    await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(1));
    click('#create-task');click('#field-model-trigger');
    expect(window.document.querySelector('#field-model-menu [data-model-value="gpt-6-luna"]')).toBeNull();
    expect([...element<HTMLSelectElement>('#field-model-choice').options].map(option=>option.value)).not.toContain('gpt-6-luna');
    expect(element('#field-model-menu').textContent).toContain('GPT-6.1-Sol');click('#close-modal');
    click('#agents-nav');click('#create-task');click('#field-model-trigger');
    expect(window.document.querySelector('#field-model-menu [data-model-value="gpt-6-luna"]')).toBeNull();click('#close-modal');
    click('#settings-button');click('#settings-tab-providers');
    expect(window.document.querySelector('[name^="providerEnv-"]')).toBeNull();
    click('[data-provider-models-manage="codex"]');
    expect(element<HTMLInputElement>('[name="enabledModel"][value="gpt-6-luna"]').checked).toBe(false);
    expect(element('[name="modelAutoMerge"]').tagName).toBe('INPUT');
    expect(window.document.querySelector('.provider-models-form select')).toBeNull();
  });
  it('toggles all provider models from the no-default row and saves the selection', async () => {
    server.service.store.state.providerModels={codex:{models:[{id:'gpt-6.1-sol'},{id:'gpt-plain'}],refreshedAt:new Date().toISOString(),source:'test'}};
    server.service.store.state.settings.disabledModels={codex:['gpt-plain']};
    delete server.service.store.state.settings.defaultModels?.codex;
    server.service.emit('change',server.service.snapshot());
    await createProject();click('#settings-button');click('#settings-tab-providers');click('[data-provider-models-manage="codex"]');
    const master=element<HTMLInputElement>('[data-toggle-all-models]');
    expect(master.checked).toBe(false);
    expect(master.closest('.provider-model-row')?.textContent).toContain('Sağlayıcı varsayılanı');
    master.click();expect(element<HTMLInputElement>('[name="enabledModel"][value="gpt-6.1-sol"]').checked).toBe(true);expect(element<HTMLInputElement>('[name="enabledModel"][value="gpt-plain"]').checked).toBe(true);
    element<HTMLInputElement>('[name="enabledModel"][value="gpt-plain"]').click();expect(master.checked).toBe(false);master.click();expect(element<HTMLInputElement>('[name="enabledModel"][value="gpt-plain"]').checked).toBe(true);
    master.click();expect(element<HTMLInputElement>('[name="enabledModel"][value="gpt-6.1-sol"]').checked).toBe(false);expect(element<HTMLInputElement>('[name="enabledModel"][value="gpt-plain"]').checked).toBe(false);
    expect(element<HTMLInputElement>('[name="defaultModel"][value=""]').checked).toBe(true);
    click('[name="defaultModel"][value="gpt-plain"]');
    expect(element<HTMLInputElement>('[name="enabledModel"][value="gpt-plain"]').checked).toBe(true);
    click('[name="enabledModel"][value="gpt-plain"]');
    expect(element<HTMLInputElement>('[name="defaultModel"][value=""]').checked).toBe(true);
    submit('#modal form');await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));
    expect(element('#settings-save-status').textContent).toBe('Kaydedilmemiş değişiklikler var');
    expect(element('#error-banner').textContent).toBe('');
    submit('#settings-form');await wait(()=>expect(element('#settings-save-status').textContent).toBe('Kaydedildi'));
    expect(server.service.snapshot().settings.disabledModels?.codex).toEqual(['gpt-6.1-sol','gpt-plain']);
    click('#settings-back');click('#create-task');click('#field-model-trigger');
    expect(window.document.querySelector('#field-model-menu [data-model-value="gpt-plain"]')).toBeNull();
    expect(window.document.querySelector('#field-model-menu [data-model-value="gpt-6.1-sol"]')).toBeNull();
  });
  it('manages project labels on their settings page and keeps task labels in step', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;const task=server.service.createTask({projectId:project.id,title:'Labelled',tags:['bug']});
    click('#project-tab-settings');click('#settings-tab-tracking');click('#settings-subtab-project-tracking-labels');expect(element('#settings-panel-tracking').hidden).toBe(false);expect(element('#settings-subpanel-project-tracking-labels').hidden).toBe(false);
    await wait(()=>expect(element('#project-labels-list').textContent).toContain('bug'));expect(element('#project-labels-github').textContent).toContain('GitHub’a bağlanınca');
    input('#project-label-new-name','feature');input('#project-label-new-description','New work');click('[data-label-create]');
    await wait(()=>expect(server.service.project(project.id).labels?.map(label=>label.name)).toEqual(['bug','feature']));expect(server.service.project(project.id).labels?.[1]).toMatchObject({color:'0075ca',description:'New work'});
    expect(element('#project-settings-save-state').textContent).toBe('');
    await wait(()=>expect(window.document.querySelector('[data-label-row="bug"] [data-label-edit]')).not.toBeNull());click('[data-label-row="bug"] [data-label-edit]');input('[data-label-edit-name]','defect');click('[data-label-save]');
    await wait(()=>expect(server.service.task(task.id).tags).toEqual(['defect']));
    await wait(()=>expect(window.document.querySelector('[data-label-row="defect"] [data-label-delete]')).not.toBeNull());click('[data-label-row="defect"] [data-label-delete]');await confirmDialog();
    await wait(()=>expect(server.service.task(task.id).tags).toEqual([]));expect(server.service.project(project.id).labels?.map(label=>label.name)).toEqual(['feature']);
  });
  it('manages milestones in project settings, creates tasks in the current milestone and moves tasks between milestones', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;
    click('#project-tab-settings');click('#settings-tab-tracking');click('#settings-subtab-project-tracking-milestones');expect(element('#settings-panel-tracking').hidden).toBe(false);expect(element('#settings-subpanel-project-tracking-labels').hidden).toBe(true);
    input('#project-milestone-new-title','Sprint 1');input('#project-milestone-new-due','2026-12-01');click('[data-milestone-create]');
    await wait(()=>expect(server.service.project(project.id).milestones?.map(milestone=>milestone.title)).toEqual(['Sprint 1']));
    input('#project-milestone-new-title','Sprint 2');click('[data-milestone-create]');
    await wait(()=>expect(server.service.project(project.id).milestones).toHaveLength(2));expect(element('#project-settings-save-state').textContent).toBe('');
    const [first,second]=server.service.project(project.id).milestones!;expect(server.service.project(project.id).currentMilestoneId).toBe(first!.id);
    await wait(()=>expect(element(`[data-milestone-row="${first!.id}"]`).textContent).toContain('Geçerli'));
    click('#project-tab-board');click('#create-task');expect(element<HTMLSelectElement>('#field-milestoneId').value).toBe(first!.id);
    input('#field-title','Milestone task');submit('#modal form');
    await wait(()=>expect(server.service.snapshot().tasks.find(task=>task.title==='Milestone task')?.milestoneId).toBe(first!.id));
    const task=server.service.snapshot().tasks.find(item=>item.title==='Milestone task')!;
    await wait(()=>expect(element(`[data-open-task="${task.id}"] .milestone-chip`).textContent).toContain('Sprint 1'));
    // The board filters by milestone, and a selection moves to another milestone at once.
    edit('#milestone-filter',second!.id);await wait(()=>expect(window.document.querySelector(`[data-open-task="${task.id}"]`)).toBeNull());
    edit('#milestone-filter','');await wait(()=>expect(window.document.querySelector(`[data-open-task="${task.id}"]`)).not.toBeNull());
    click(`[data-open-task="${task.id}"] [data-select-task]`);await wait(()=>expect(element('#bulk-task-milestone').hidden).toBe(false));
    edit('#bulk-task-milestone',second!.id);await wait(()=>expect(server.service.task(task.id).milestoneId).toBe(second!.id));
    await wait(()=>expect(element(`[data-open-task="${task.id}"] .milestone-chip`).textContent).toContain('Sprint 2'));click(`[data-open-task="${task.id}"]`);click('[data-detail-tab="info"]');expect(element<HTMLSelectElement>('#info-milestoneId').value).toBe(second!.id);
    commit('#info-milestoneId','');await wait(()=>expect(server.service.task(task.id).milestoneId).toBeUndefined());
    // Closing the current milestone makes the next open one current.
    click('#close-panel');click('#project-tab-settings');click('#settings-tab-tracking');click('#settings-subtab-project-tracking-milestones');click(`[data-milestone-row="${first!.id}"] [data-milestone-toggle]`);
    await wait(()=>expect(server.service.project(project.id).currentMilestoneId).toBe(second!.id));expect(server.service.project(project.id).milestones![0]!.state).toBe('closed');
    // Opening the board starts on the current milestone; clearing the filters shows every milestone.
    // The board picks its filter when it opens, so the renderer must have received the new current milestone first.
    await wait(()=>expect(window.eval(`state.projects.find(item=>item.id===${JSON.stringify(project.id)})?.currentMilestoneId`)).toBe(second!.id));
    click('#project-tab-board');click(`[data-project="${project.id}"]`);await wait(()=>expect(element<HTMLSelectElement>('#milestone-filter').value).toBe(second!.id));
    expect(window.document.querySelector(`[data-open-task="${task.id}"]`)).toBeNull();
    click('[data-clear-board-filters]');await wait(()=>expect(element<HTMLSelectElement>('#milestone-filter').value).toBe(''));
    await wait(()=>expect(window.document.querySelector(`[data-open-task="${task.id}"]`)).not.toBeNull());
  });
  it('debounces issue ID search on the actual server and imports remote Blocked by only on Save', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;server.service.updateProject(project.id,{github:{repository:'owner/repo',owner:'owner',number:1}});
    vi.spyOn(ControlGitHub.prototype,'lookupIssue').mockResolvedValue({number:77,title:'Existing issue blocker',body:'Remote issue',url:'https://github.com/owner/repo/issues/77',state:'open',nodeId:'I_77'});
    const search=vi.spyOn(server.service,'searchTasks');click('#create-task');input('#field-title','Wait for external issue');
    for(const value of ['#7','#77']){input('#blocked-by-search',value);element('#blocked-by-search').dispatchEvent(new window.Event('input',{bubbles:true}) as unknown as Event);}
    expect(search).not.toHaveBeenCalled();await wait(()=>expect(element('#blocked-by-results').textContent).toContain('Existing issue blocker'));
    expect(search).toHaveBeenCalledTimes(1);expect(search.mock.calls[0]?.[0]).toMatchObject({projectId:project.id,q:'#77'});expect(server.service.snapshot().tasks).toHaveLength(0);
    click('[data-dependency-result="0"]');expect(element<HTMLInputElement>('input[name="dependencyRefs"]').value).toBe('#77');expect(server.service.snapshot().tasks).toHaveLength(0);
    submit('#task-editor-form');await wait(()=>expect(server.service.snapshot().tasks).toHaveLength(2));const child=server.service.snapshot().tasks.find(task=>task.title==='Wait for external issue')!;expect(server.service.task(child.dependsOn[0]!).github?.issueNumber).toBe(77);expect(child.status).toBe('backlog');
    await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));
    // The dialog closes before the board receives the new task.
    await wait(()=>expect(window.document.querySelector(`[data-open-task="${child.id}"]`)).not.toBeNull());click(`[data-open-task="${child.id}"]`);click('[data-detail-tab="info"]');const blocker=child.dependsOn[0]!;
    expect(element('[data-info-row="blocked"]').textContent).toContain('Existing issue blocker');click(`[data-info-remove-dependency="${blocker}"]`);await wait(()=>expect(server.service.task(child.id).dependsOn).toEqual([]));
    await wait(()=>expect(element('[data-info-row="blocked"]').textContent).not.toContain('Existing issue blocker'));
    input('#info-blocked-search','#77');element('#info-blocked-search').dispatchEvent(new window.Event('input',{bubbles:true}) as unknown as Event);
    await wait(()=>expect(element('#info-blocked-results').textContent).toContain('Existing issue blocker'));expect(element('#info-blocked-results .dependency-reference').textContent).toBe('#77');click('[data-info-dependency-result="0"]');await wait(()=>expect(server.service.task(child.id).dependsOn).toEqual([blocker]));
  });
  it('preserves board column scroll when opening, updating and closing task details', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;
    const tasks=Array.from({length:12},(_,index)=>server.service.createTask({projectId:project.id,title:`Scroll task ${index}`}));
    server.service.createTask({projectId:project.id,title:'Ready scroll task',status:'ready'});
    await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(13));
    const backlog=()=>element('[data-board-column="backlog"]'),ready=()=>element('[data-board-column="ready"]');
    backlog().scrollTop=640;ready().scrollTop=80;
    const assertScroll=()=>{expect(backlog().scrollTop).toBe(640);expect(ready().scrollTop).toBe(80);};
    click(`[data-open-task="${tasks[10]!.id}"]`);assertScroll();
    expect(element(`[data-open-task="${tasks[10]!.id}"]`).classList.contains('selected')).toBe(true);
    server.service.updateTask(tasks[0]!.id,{title:'Updated while details are open'});
    await wait(()=>expect(backlog().textContent).toContain('Updated while details are open'));assertScroll();
    click('#close-panel');assertScroll();
    click(`[data-open-task="${tasks[11]!.id}"]`);assertScroll();
    click('#close-panel');assertScroll();
  });
  it('uses the default offcanvas with focus restore, Escape, backdrop, edit/delete, and removes the task only after confirmed deletion', async () => {
    await createProject();await createTask('Offcanvas task');click('#close-panel');element('.task-card').focus();click('.task-card');
    expect(element('#task-panel').getAttribute('role')).toBe('dialog');expect(element('#task-panel').getAttribute('aria-modal')).toBe('true');expect(element('.app-shell').classList.contains('inline-session')).toBe(false);
    element('#close-panel').focus();element('#close-panel').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}) as unknown as Event);
    click('#close-panel');expect(element('#task-panel').hidden).toBe(true);expect(window.document.activeElement?.classList.contains('task-card')).toBe(true);
    click('.task-card');element('#task-panel').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}) as unknown as Event);expect(element('#task-panel').hidden).toBe(true);
    click('.task-card');expect(window.document.querySelector('[data-action="inline-session"]')).toBeNull();expect([...window.document.querySelectorAll('#task-panel [data-detail-tab]')].map(tab=>tab.textContent)).toEqual(['Bilgiler','Sohbet','Agent Console']);
    expect(window.document.querySelector('[data-action="edit-task"]')).toBeNull();click('[data-detail-tab="info"]');expect(element<HTMLInputElement>('#info-title').value).toBe('Offcanvas task');
    // Escape inside an inline field reverts that field instead of closing the panel.
    element<HTMLInputElement>('#info-title').value='Discarded title';element('#info-title').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}) as unknown as Event);
    expect(element('#task-panel').hidden).toBe(false);expect(element<HTMLInputElement>('#info-title').value).toBe('Offcanvas task');
    click('.panel-actions [data-action="delete-task"]');expect(element('#modal').textContent).toContain('Blocked by');expect(server.service.snapshot().tasks).toHaveLength(1);submit('#modal form');
    await wait(()=>expect(server.service.snapshot().tasks).toHaveLength(0));await wait(()=>expect(window.document.querySelector('.task-card')).toBeNull());expect(element('#task-panel').hidden).toBe(true);expect(element('#modal').hasAttribute('open')).toBe(false);
    const css=await uiStyleSource();expect(css).toContain('width:var(--task-panel-width,60%);min-width:560px');
  });
  it('deletes a referenced task and drops it from the Blocked by list of its dependents', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;const blocker=server.service.createTask({projectId:project.id,title:'Referenced blocker'});const child=server.service.createTask({projectId:project.id,title:'Dependent task',dependsOn:[blocker.id]});
    await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(2));click('[data-open-task="'+blocker.id+'"]');click('[data-action="delete-task"]');submit('#modal form');
    await wait(()=>expect(server.service.snapshot().tasks).toHaveLength(1));expect(server.service.task(child.id).dependsOn).toEqual([]);await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(1));
  });
  it('offers to delete the linked GitHub issue with the task, checked by default', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;const linked=server.service.createTask({projectId:project.id,title:'Linked issue task'});server.service.task(linked.id).github={issueNumber:42,issueId:'I_42'};const kept=server.service.createTask({projectId:project.id,title:'Kept issue task'});server.service.task(kept.id).github={issueNumber:43,issueId:'I_43'};
    const remove=vi.spyOn(ControlGitHub.prototype,'deleteIssue').mockResolvedValue();
    await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(2));click('[data-open-task="'+linked.id+'"]');click('[data-action="delete-task"]');
    expect(element<HTMLInputElement>('#modal [name="deleteIssue"]').checked).toBe(true);expect(element('#modal').textContent).toContain('#42');submit('#modal form');
    await wait(()=>expect(remove).toHaveBeenCalledTimes(1));expect(remove.mock.calls[0]?.[1]).toMatchObject({issueNumber:42,issueId:'I_42'});
    await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(1));click('[data-open-task="'+kept.id+'"]');click('[data-action="delete-task"]');element<HTMLInputElement>('#modal [name="deleteIssue"]').checked=false;submit('#modal form');
    await wait(()=>expect(server.service.snapshot().tasks).toHaveLength(0));expect(remove).toHaveBeenCalledTimes(1);remove.mockRestore();
  });
  it('downloads all GitHub issues from project settings without a GitHub Project connection', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;
    vi.spyOn(ControlGitHub.prototype,'repositorySlug').mockResolvedValue('owner/repo');
    const issues=vi.spyOn(ControlGitHub.prototype,'issues').mockResolvedValue([{number:5,node_id:'I_5',title:'Remote bug',body:'From GitHub',html_url:'https://github.com/owner/repo/issues/5',state:'open',labels:[]}]);
    click('#project-tab-settings');click('#settings-tab-git');click('#settings-subtab-project-git-github');
    const button=element<HTMLButtonElement>('#project-settings-download-issues');expect(button.hidden).toBe(false);expect(element('#project-settings-sync').hidden).toBe(true);click('#project-settings-download-issues');
    await wait(()=>expect(server.service.snapshot().tasks.map(task=>[task.projectId,task.title,task.github?.issueNumber])).toEqual([[project.id,'Remote bug',5]]));expect(issues).toHaveBeenCalledWith('owner/repo');
    await wait(()=>expect(button.disabled).toBe(false));
  });
  it('shows Blocked by on the card and focuses the blinking blocker card when clicked', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;const blocker=server.service.createTask({projectId:project.id,title:'Card blocker'});const child=server.service.createTask({projectId:project.id,title:'Card dependent',dependsOn:[blocker.id]});
    await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(2));
    const chip=element(`[data-open-task="${child.id}"] [data-focus-task="${blocker.id}"]`);expect(chip.textContent).toMatch(/^AIWS-/);expect(chip.title).toContain('Card blocker');expect(window.document.querySelector(`[data-open-task="${blocker.id}"] .card-blocked`)).toBeNull();
    click(`[data-open-task="${child.id}"] [data-focus-task="${blocker.id}"]`);const target=element(`[data-open-task="${blocker.id}"]`);
    expect(target.classList.contains('focus-blink')).toBe(true);expect(window.document.activeElement).toBe(target);expect(element('#task-panel').hidden).toBe(true);
  });
  it('opens the shared agent picker from the card agent chip and saves the chosen provider and model', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;const item=server.service.createTask({projectId:project.id,title:'Pick an agent'});
    // Profiles are listed only once at least one exists.
    server.service.catalog.createAgent({name:'Card profile',provider:'claude'});await wait(()=>expect(element('#agents-count').textContent).toBe('1'));
    await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(1));
    click(`[data-card-agent="${item.id}"]`);expect(element('#modal').hasAttribute('open')).toBe(false);expect(element('#task-panel').hidden).toBe(true);expect(element('.card-agent-picker .model-menu').classList.contains('popup-menu')).toBe(true);
    expect(element('.card-agent-picker .model-providers').textContent).toContain('Agent profili');
    click('.card-agent-picker [data-provider-value="codex"]');expect(window.document.querySelector('.card-agent-picker')).not.toBeNull();expect(server.service.snapshot().tasks[0]!.providerOverride).toBeUndefined();
    const value=element('.card-agent-picker .model-option[data-row]').dataset.modelValue!;click(`.card-agent-picker .model-option[data-model-value="${value}"]`);
    await wait(()=>expect(server.service.snapshot().tasks[0]).toMatchObject({provider:'codex',model:value}));
    expect(window.document.querySelector('.card-agent-picker')).toBeNull();
  });
  it('previews a bundled community template and creates an editable attributed profile only on Save', async () => {
    click('#agents-nav');click('[data-agent-library="templates"]');await wait(()=>expect(window.document.querySelectorAll('.template-card').length).toBeGreaterThan(100));expect(server.service.snapshot().agents).toHaveLength(0);
    input('#agent-template-search','.NET');element('#agent-template-search').dispatchEvent(new window.Event('input',{bubbles:true}) as unknown as Event);expect(window.document.querySelectorAll('.template-card').length).toBeGreaterThan(0);expect(element('#board').textContent).toContain('MIT');
    click('[data-preview-template]');expect(element('.template-preview pre').textContent?.length).toBeGreaterThan(100);expect(element('.template-preview').textContent).toContain('Revizyon:');click('#clone-agent-template');expect(server.service.snapshot().agents).toHaveLength(0);expect(element<HTMLInputElement>('#field-provider').value).toBe('codex');input('#field-name','My .NET specialist');input('#field-provider','codex');input('#field-instructions','User customized template instructions');submit('#modal form');
    await wait(()=>expect(server.service.snapshot().agents).toHaveLength(1));const agent=server.service.snapshot().agents[0]!;expect(agent.name).toBe('My .NET specialist');expect(agent.provider).toBe('codex');expect(agent.instructions).toBe('User customized template instructions');expect(agent.templateSource?.license).toBe('MIT');click('[data-agent-library="mine"]');expect(element('.library-list').textContent).toContain('My .NET specialist');
  });


  it('keeps user edits while AI refines workspace drafts, offers retry, and creates only on explicit action', async () => {
    await createProject();const profile=server.service.catalog.createAgent({name:'Draft profile',provider:'codex',instructions:'Keep useful context',context:'Project context',skillIds:[],enabled:true});
    let resolveDraft!: (value: unknown) => void;const draft=vi.spyOn(server.service,'draft').mockImplementation(()=>new Promise(resolve=>{resolveDraft=resolve;}) as never);
    await wait(()=>expect(element('#agents-count').textContent).toBe('1'));click('#ai-create-task');sendAI('Prepare a frontend task');await wait(()=>expect(draft).toHaveBeenCalledTimes(1));
    resolveDraft({reply:'First proposal',drafts:[{key:'d1',title:'AI title',description:'AI criteria',status:'backlog',priority:2,dependsOn:[],dependsOnDrafts:[]}]});
    await wait(()=>expect(element('[data-ai-draft="d1"] [data-ai-title]').textContent).toBe('AI title'));
    expect(element('[data-ai-draft="d1"] [data-ai-agent-field]').hidden).toBe(false);expect(element('[data-ai-draft="d1"] [data-ai-labels]').hidden).toBe(true);expect(element('[data-ai-draft="d1"] [data-ai-dependencies]').hidden).toBe(true);expect(element('[data-ai-draft="d1"] [data-ai-extra]').hidden).toBe(true);
    expect(element<HTMLSelectElement>('[data-ai-draft="d1"] [id$="-model-choice"]').options.length).toBeGreaterThan(1);expect(element('[data-ai-draft="d1"] .model-trigger').classList.contains('ai-select-chip')).toBe(true);
    edit('[data-ai-draft="d1"] [data-field="priority"]','1');expect(element('[data-ai-draft="d1"] [data-ai-badges]').textContent).toContain('1');
    sendAI('Make it high priority with Claude');await wait(()=>expect(draft).toHaveBeenCalledTimes(2));
    expect(draft.mock.calls[1]![1]).toMatchObject({mode:'workspace',messages:[{role:'user',text:'Prepare a frontend task'},{role:'assistant',text:'First proposal'}],drafts:[{key:'d1',title:'AI title',description:'AI criteria',priority:1,userEdited:['priority']}]});
    resolveDraft({reply:'Refined',drafts:[{key:'d1',title:'AI title 2',description:'AI criteria 2',status:'backlog',priority:3,agentId:profile.id,provider:'claude',model:'my-model',tags:['frontend'],dependsOn:[],dependsOnDrafts:[]}]});
    await wait(()=>expect(element('[data-ai-draft="d1"] [data-ai-title]').textContent).toBe('AI title 2'));
    expect(element<HTMLSelectElement>('[data-ai-draft="d1"] [data-field="priority"]').value).toBe('1');expect(element<HTMLSelectElement>('[data-ai-draft="d1"] [data-field="agentId"]').value).toBe(profile.id);
    expect(element<HTMLInputElement>('[data-ai-draft="d1"] input[name="model"]').value).toBe('my-model');expect(element('[data-ai-draft="d1"] .model-trigger').title).toContain('Claude Code');expect(element('[data-ai-draft="d1"] [data-ai-labels]').textContent).toContain('frontend');
    expect(element('[data-ai-draft="d1"] [data-ai-badges]').textContent).toContain('AI güncelledi');expect(server.service.snapshot().tasks).toHaveLength(0);expect(server.service.snapshot().runs).toHaveLength(0);
    draft.mockRejectedValueOnce(new Error('Provider is temporarily unavailable'));sendAI('Refine again');await wait(()=>expect(element('#ai-chat-log').textContent).toContain('temporarily unavailable'));
    expect(element('#ai-retry-row').hidden).toBe(false);expect(element('.ai-message.user.failed').textContent).toContain('Refine again');expect(element('[data-ai-draft="d1"] [data-ai-title]').textContent).toBe('AI title 2');expect(server.service.snapshot().tasks).toHaveLength(0);
    draft.mockResolvedValueOnce({reply:'Retried',drafts:[{key:'d1',title:'Retried title',description:'Retried description',priority:2,status:'backlog',dependsOn:[],dependsOnDrafts:[]}]} as never);click('#ai-retry');
    await wait(()=>expect(element('#ai-chat-log').textContent).toContain('Retried'));expect((draft.mock.calls.at(-1)![1] as {message:string}).message).toBe('Refine again');expect(element('#ai-chat-log').textContent).not.toContain('temporarily unavailable');expect(element('#ai-retry-row').hidden).toBe(true);
    expect(element('[data-ai-draft="d1"] [data-ai-title]').textContent).toBe('Retried title');expect(element<HTMLSelectElement>('[data-ai-draft="d1"] [data-field="priority"]').value).toBe('1');
    click('[data-ai-draft="d1"] [data-ai-remove-tag="frontend"]');expect(element('[data-ai-draft="d1"] [data-ai-labels]').hidden).toBe(true);
    click('[data-ai-draft="d1"] [data-ai-create]');await wait(()=>expect(server.service.snapshot().tasks).toHaveLength(1));
    expect(server.service.snapshot().tasks[0]).toMatchObject({title:'Retried title',description:'Retried description',priority:1,status:'backlog',agentId:profile.id,tags:[]});
    await wait(()=>expect(element('[data-ai-draft="d1"]').classList.contains('created')).toBe(true));expect(element('#project-tab-ai-count').hidden).toBe(true);expect(server.service.snapshot().runs).toHaveLength(0);
    expect(window.document.querySelector('[data-ai-draft="d1"] [data-ai-create]')).toBeNull();expect(element('[data-ai-draft="d1"]').textContent).toContain('Retried title');
  });
  it('creates AI drafts as ready in dependency order inside the milestone the board filter shows', async () => {
    await createProject();const project=server.service.snapshot().projects.find(value=>value.name==='Renderer QA')!;
    server.service.createMilestone(project.id,{title:'Sprint 1',current:true});const sprint2=server.service.createMilestone(project.id,{title:'Sprint 2'}).milestones!.find(value=>value.title==='Sprint 2')!;
    await wait(()=>expect(element('#milestone-filter').textContent).toContain('Sprint 2'));edit('#milestone-filter',sprint2.id);
    vi.spyOn(server.service,'draft').mockResolvedValueOnce({reply:'Two tasks',drafts:[{key:'api',title:'Build API',description:'API work',status:'backlog',dependsOn:[],dependsOnDrafts:[]},{key:'ui',title:'Build UI',description:'UI work',status:'backlog',dependsOn:[],dependsOnDrafts:['api']}]} as never);
    click('#ai-create-task');sendAI('Split the feature');await wait(()=>expect(window.document.querySelectorAll('[data-ai-draft]')).toHaveLength(2));
    expect(element('#ai-create-ready').hidden).toBe(false);click('#ai-create-ready');await wait(()=>expect(server.service.snapshot().tasks).toHaveLength(2));
    const tasks=server.service.snapshot().tasks,api=tasks.find(task=>task.title==='Build API')!,ui=tasks.find(task=>task.title==='Build UI')!;
    expect(ui.dependsOn).toEqual([api.id]);expect(tasks.every(task=>task.milestoneId===sprint2.id)).toBe(true);expect(ui.status).toBe('ready');
  });
  it('discards drafts without creating anything, creates dependent drafts in order, and cancels a running request', async () => {
    await createProject();const draft=vi.spyOn(server.service,'draft').mockResolvedValueOnce({reply:'Three tasks',drafts:[{key:'api',title:'Build API',description:'API work',status:'backlog',dependsOn:[],dependsOnDrafts:[]},{key:'ui',title:'Build UI',description:'UI work',status:'backlog',dependsOn:[],dependsOnDrafts:['api']},{key:'docs',title:'Write docs',description:'Docs',status:'backlog',dependsOn:[],dependsOnDrafts:[]}]} as never);
    click('#ai-create-task');sendAI('Split the feature');await wait(()=>expect(window.document.querySelectorAll('[data-ai-draft]')).toHaveLength(3));
    expect(element<HTMLButtonElement>('[data-ai-draft="ui"] [data-ai-create]').disabled).toBe(true);expect(element('[data-ai-draft="ui"] [data-ai-dependencies]').textContent).toContain('Build API');expect(element('#ai-draft-count').textContent).toBe('3');
    expect(element('[data-ai-draft="api"] [data-ai-agent-field]').hidden).toBe(true);expect(element('[data-ai-draft="ui"] [data-ai-status]').textContent).toContain('Önce bağlı olduğu taslağı oluştur');
    click('[data-ai-draft="docs"] [data-ai-discard]');expect(window.document.querySelector('[data-ai-draft="docs"]')).toBeNull();await new Promise(resolve=>setTimeout(resolve,50));expect(server.service.snapshot().tasks).toHaveLength(0);
    click('#ai-create-all');await wait(()=>expect(server.service.snapshot().tasks).toHaveLength(2));
    const tasks=server.service.snapshot().tasks,api=tasks.find(task=>task.title==='Build API')!,ui=tasks.find(task=>task.title==='Build UI')!;expect(ui.dependsOn).toEqual([api.id]);expect(tasks.every(task=>task.status==='backlog')).toBe(true);
    let resolveDraft!: (value: unknown) => void;draft.mockImplementationOnce(()=>new Promise(resolve=>{resolveDraft=resolve;}) as never);const cancel=vi.spyOn(server.service,'cancelDraft');
    sendAI('Add another task');await wait(()=>expect(draft).toHaveBeenCalledTimes(2));const requestId=(draft.mock.calls[1]![1] as {requestId:string}).requestId;expect(requestId).toBeTruthy();
    click('#ai-cancel');await wait(()=>expect(cancel).toHaveBeenCalledWith(expect.any(String),{requestId}));expect(element('#ai-progress').hidden).toBe(true);expect(element('#ai-chat-log').textContent).toContain('İstek iptal edildi');expect(element('#ai-retry-row').hidden).toBe(false);
    resolveDraft({reply:'Too late',drafts:[{key:'late',title:'Late draft',description:'Should be ignored',status:'backlog',dependsOn:[],dependsOnDrafts:[]}]});await new Promise(resolve=>setTimeout(resolve,100));
    expect(window.document.querySelector('[data-ai-draft="late"]')).toBeNull();expect(element('#ai-chat-log').textContent).not.toContain('Too late');expect(server.service.snapshot().tasks).toHaveLength(2);
    click('#ai-reset');expect(window.document.querySelectorAll('[data-ai-draft]')).toHaveLength(0);expect(element('#ai-draft-list').hidden).toBe(true);expect(element('#ai-empty').hidden).toBe(false);expect(element('#ai-empty').textContent).toContain('Ne hazırlayalım?');expect(server.service.snapshot().tasks).toHaveLength(2);
  });
  it('opens an AI draft card in the regular task editor above the sheet and links the created task to the card', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;server.service.setProjectLabels(project.id,{labels:[{name:'bug',color:'d73a4a',description:''},{name:'frontend',color:'1d76db',description:''}]});
    // The labels reach the page through the event stream; the draft card offers them only once they have arrived.
    await wait(()=>expect(window.eval(`state.projects.find(item=>item.id===${JSON.stringify(project.id)})?.labels?.length`)).toBe(2));
    vi.spyOn(server.service,'draft').mockResolvedValueOnce({reply:'One task',drafts:[{key:'one',title:'Merged task',description:'## Goal\nDo both things.',status:'backlog',priority:3,tags:['bug'],dependsOn:[],dependsOnDrafts:[]}]} as never);
    click('#ai-create-task');sendAI('Tümünü tek task olarak aç');await wait(()=>expect(window.document.querySelector('[data-ai-draft="one"]')).not.toBeNull());
    expect(element('[data-ai-draft="one"] [data-ai-agent-field]').hidden).toBe(true);expect(element('[data-ai-draft="one"] [data-ai-labels]').textContent).toContain('bug');
    edit('[data-ai-draft="one"] [data-ai-add-tag]','frontend');expect(element('[data-ai-draft="one"] [data-ai-labels]').textContent).toContain('frontend');expect(window.document.querySelector('[data-ai-draft="one"] [data-ai-add-tag]')).toBeNull();
    click('[data-ai-draft="one"] .ai-card-body');
    expect(element('#modal').hasAttribute('open')).toBe(true);expect(element('#ai-sheet').hidden).toBe(false);expect(element('[data-ai-draft="one"]').isConnected).toBe(true);
    expect(element<HTMLInputElement>('#field-title').value).toBe('Merged task');expect(element<HTMLTextAreaElement>('#field-description').value).toBe('## Goal\nDo both things.');expect(element<HTMLSelectElement>('#field-priority').value).toBe('3');expect(element<HTMLInputElement>('#field-tags').value).toBe('bug, frontend');
    expect(window.document.querySelector('#task-create-another')).toBeNull();expect(element('#task-open-ai').hidden).toBe(true);expect(element('#modal').textContent).toContain('AI taslağından dolduruldu');
    element('#field-title').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}) as unknown as Event);expect(element('#modal').hasAttribute('open')).toBe(false);expect(window.document.querySelector('#restore-task-draft')).toBeNull();expect(element('#ai-sheet').hidden).toBe(false);
    click('[data-ai-draft="one"] [data-ai-expand]');input('#field-title','Edited in the editor');submit('#modal form');
    await wait(()=>expect(server.service.snapshot().tasks).toHaveLength(1));expect(server.service.snapshot().tasks[0]).toMatchObject({title:'Edited in the editor',priority:3,tags:['bug','frontend']});
    await wait(()=>expect(element('[data-ai-draft="one"]').classList.contains('created')).toBe(true));expect(element('#ai-sheet').hidden).toBe(false);await wait(()=>expect(element('[data-ai-draft="one"]').textContent).toContain('Edited in the editor'));
  });
  it('opens the AI workspace from the plain task editor with the typed idea and keeps drafts per project after reload', async () => {
    await createProject();click('#create-task');input('#field-title','Rough idea');input('#field-description','More detail');click('#task-open-ai');
    expect(element('#modal').hasAttribute('open')).toBe(false);expect(element('#ai-sheet').hidden).toBe(false);expect(element<HTMLTextAreaElement>('#ai-message').value).toBe('Rough idea\n\nMore detail');expect(server.service.snapshot().tasks).toHaveLength(0);
    vi.spyOn(server.service,'draft').mockResolvedValueOnce({reply:'Kept',drafts:[{key:'keep',title:'Kept draft',description:'Survives reload',status:'backlog',dependsOn:[],dependsOnDrafts:[]}]} as never);submit('#ai-composer');
    await wait(()=>expect(window.document.querySelector('[data-ai-draft="keep"]')).not.toBeNull());edit('[data-ai-draft="keep"] [data-field="priority"]','3');
    const saved=window.localStorage.getItem(`aiws.ai-workspace.${server.service.snapshot().projects[0]!.id}`)!;expect(JSON.parse(saved)).toMatchObject({drafts:[{key:'keep',edited:['priority'],values:{title:'Kept draft',priority:3}}]});
    await closeWindow(window, pageIdle);await mountRenderer({[`aiws.ai-workspace.${server.service.snapshot().projects[0]!.id}`]:saved,'aiws.project':server.service.snapshot().projects[0]!.id});
    await wait(()=>expect(element('#ai-create-task').hidden).toBe(false));click('#ai-create-task');expect(element<HTMLSelectElement>('[data-ai-draft="keep"] [data-field="priority"]').value).toBe('3');expect(element('#ai-chat-log').textContent).toContain('Kept');expect(server.service.snapshot().tasks).toHaveLength(0);
  });
  it('preserves the mounted conversation and composer across SSE while rendering real provider command/file messages', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;
    const output=[{type:'item.started',item:{id:'cmd1',type:'command_execution',command:'npm run build',status:'in_progress'}},{type:'item.completed',item:{id:'cmd1',type:'command_execution',command:'npm run build',aggregated_output:'Build passed',exit_code:0,status:'completed'}},{type:'item.completed',item:{id:'file1',type:'file_change',changes:[{path:'src/example.ts',kind:'add'}]}},{type:'item.completed',item:{id:'msg1',type:'agent_message',text:'**Ready** for review.'}}];
    const task=server.service.createTask({projectId:project.id,title:'Rich session',provider:'command',terminalMode:'stream',command:{executable:process.execPath,args:['-e','console.log('+JSON.stringify(output.map(value=>JSON.stringify(value)).join('\n'))+')']}});
    await wait(()=>expect(window.document.querySelector('.task-card')).not.toBeNull());click('.task-card');click('#detail-tab-console');await consoleMounted();const root=element('[data-aiws-conversation]');const composer=element<HTMLTextAreaElement>('#task-message-input');composer.value='Keep my draft';server.service.startTask(server.service.snapshot().tasks[0]!.id);
    await wait(()=>expect(element('.cv-timeline').textContent).toContain('npm run build'));await wait(()=>expect(server.service.snapshot().runs[0]?.status).toBe('completed'));
    expect(element('[data-aiws-conversation]')).toBe(root);expect(element('#task-message-input')).toBe(composer);expect(composer.value).toBe('Keep my draft');expect(window.document.querySelectorAll('.cv-tool')).toHaveLength(1);expect(element('.cv-files').textContent).toContain('src/example.ts');expect(element('.cv-markdown strong').textContent).toBe('Ready');
    await wait(()=>expect(element('#task-message-form [type=submit]').textContent).toBe('Geçmişle yeni oturum'));expect(composer.disabled).toBe(false);expect(element('#task-message-form [type=submit]').getAttribute('title')).toContain('token');expect(server.service.snapshot().messages.filter(message=>message.text==='Keep my draft')).toHaveLength(0);expect(element('[data-aiws-conversation]')).toBe(root);expect(composer.value).toBe('Keep my draft');
  });


  it('turns the composer button into Resume for a finished session and drops the header session buttons', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;
    const source=server.service.createTask({projectId:project.id,title:'Resume source',description:'Original objective',provider:'codex'});
    const at=new Date().toISOString();server.service.store.state.runs.push({id:'resume-old',taskId:source.id,provider:'codex',status:'completed',startedAt:at,finishedAt:at,exitCode:0,executionMode:'native',continuation:0,pendingCommands:[]});server.service.task(source.id).currentRunId='resume-old';server.service.task(source.id).status='done';
    await wait(()=>expect(window.document.querySelector(`[data-open-task="${source.id}"]`)).not.toBeNull());click(`[data-open-task="${source.id}"]`);click('#detail-tab-console');
    await wait(()=>expect(element('#task-message-form [type=submit]').textContent).toBe('Devam ettir'));
    expect(element<HTMLTextAreaElement>('#task-message-input').required).toBe(false);
    expect(window.document.querySelector('[data-action="transfer-session"],[data-action="resume-session"]')).toBeNull();
  });

  it('ignores a stale server search after a newer query and keeps local task ID selection explicit', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;const oldTask=server.service.createTask({projectId:project.id,title:'Old blocker'}),newTask=server.service.createTask({projectId:project.id,title:'Newest blocker'});await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(2));
    const original=server.service.searchTasks.bind(server.service);let finishOld!:()=>void;const search=vi.spyOn(server.service,'searchTasks').mockImplementation(async request=>{if(request.q==='Old'){await new Promise<void>(resolve=>finishOld=resolve);}return original(request);});click('#create-task');
    input('#blocked-by-search','Old');element('#blocked-by-search').dispatchEvent(new window.Event('input',{bubbles:true}) as unknown as Event);await wait(()=>expect(search).toHaveBeenCalledTimes(1));
    input('#blocked-by-search',newTask.id);element('#blocked-by-search').dispatchEvent(new window.Event('input',{bubbles:true}) as unknown as Event);await wait(()=>expect(element('#blocked-by-results').textContent).toContain('Newest blocker'));finishOld();await new Promise(resolve=>setTimeout(resolve,50));expect(element('#blocked-by-results').textContent).not.toContain('Old blocker');
    // Results show the short task key instead of the full id, which stays available as a tooltip.
    expect(element('#blocked-by-results .dependency-reference').textContent).toBe(`AIWS-${newTask.id.replace(/^task_/,'').slice(0,6).toUpperCase()}`);expect(element('#blocked-by-results .dependency-reference').getAttribute('title')).toBe(newTask.id);
    click('[data-dependency-result="0"]');expect(element<HTMLInputElement>('input[name="dependencyRefs"]').value).toBe(newTask.id);expect(server.service.snapshot().tasks).toHaveLength(2);expect(server.service.task(oldTask.id).status).toBe('backlog');
  });

  it('creates a project and task, edits them, switches views, and persists state', async () => {
    await createProject(); await createTask();
    expect(element('#task-panel').hidden).toBe(false);
    expect(element('#task-panel h2').textContent).toBe('Implement renderer flow');
    click('[data-detail-tab="info"]'); commit('#info-title', 'Updated task');
    await wait(() => expect(element('.task-card h3').textContent).toBe('Updated task'));
    click('#list-view'); expect(element('.task-list').textContent).toContain('Updated task');
    click('#board-view'); expect(element('.task-card').textContent).toContain('Updated task');
    expect(server.service.snapshot().projects[0]?.name).toBe('Renderer QA');
    await wait(() => expect(server.service.snapshot().tasks[0]?.title).toBe('Updated task'));
    click('#project-tab-settings'); input('#settings-field-description', 'Project settings edited in UI'); submit('#project-settings-form');
    await wait(() => expect(server.service.snapshot().projects[0]?.description).toBe('Project settings edited in UI'));
    await wait(() => expect(element('#project-settings-save-state').textContent).toBe('Tüm değişiklikler kaydedildi'));
    expect(element<HTMLTextAreaElement>('#settings-field-description').value).toBe('Project settings edited in UI');
  });
  it('uses the top bar as the only header and puts the project tabs, including settings, into it', async () => {
    for(const selector of ['#project-title','#project-description','#source-badge','.project-heading','#project-settings'])expect(window.document.querySelector(selector)).toBeNull();
    expect(element('#page-summary').hidden).toBe(false);expect(element('#page-summary').textContent).toContain('Projelerini oluştur');
    await createProject();
    expect(element('#project-view-tabs').closest('.topbar')).not.toBeNull();expect(element('#create-task').closest('.topbar')).not.toBeNull();
    expect(element('#page-summary').hidden).toBe(true);expect(element('.topbar').textContent).not.toContain('Yerel proje');
    expect(element('#breadcrumb').hidden).toBe(true);expect(element('.topbar').textContent).not.toContain('Çalışma alanı');
    const tabs=[...window.document.querySelectorAll('#project-view-tabs [role="tab"]')].filter(tab=>!tab.closest('[hidden]'));
    expect(tabs.map(tab=>tab.textContent)).toEqual(['Pano','Terminal','Zamanlanmış görevler','Oturumlar','Proje ayarları']);
    expect(tabs.map(tab=>tab.getAttribute('aria-selected'))).toEqual(['true','false','false','false','false']);
    element('#project-tab-board').focus();element('#project-view-tabs').dispatchEvent(new window.KeyboardEvent('keydown',{key:'End',bubbles:true}) as unknown as Event);
    expect(element('#project-tab-settings').getAttribute('aria-selected')).toBe('true');expect(element('#project-tab-settings').tabIndex).toBe(0);expect(element('#project-tab-board').tabIndex).toBe(-1);
    expect(element('#modal').hasAttribute('open')).toBe(false);expect(element('#board').querySelector('#project-settings-form')).not.toBeNull();
    expect(element('#board-toolbar').hidden).toBe(true);expect(element('#create-task').hidden).toBe(false);
    click('#overview-nav');expect(element('#breadcrumb-project').textContent).toBe('Tüm projeler');expect(element('#breadcrumb').hidden).toBe(false);expect(element('#page-summary').hidden).toBe(true);expect(element('#project-view-tabs').hidden).toBe(false);expect(element('#overview-tab-board').getAttribute('aria-selected')).toBe('true');expect(element('#project-tab-board').hidden).toBe(true);
    click('#workflows-nav');expect(element('#breadcrumb-project').textContent).toBe('İş akışları');expect(element('#page-summary').textContent).toContain('Agentları sırayla çalıştır');
    click('#agents-nav');expect(element('#breadcrumb-project').textContent).toBe('Agentlar');expect(element('#page-summary').hidden).toBe(false);
  });
  it('shows board view controls only on task board pages across navigation and rerenders', async () => {
    expect(element('#board-toolbar').hidden).toBe(true);
    await createProject();
    const project=server.service.snapshot().projects[0]!;
    const assertToolbar=(visible:boolean)=>{
      expect(element('#board-toolbar').hidden).toBe(!visible);
      for(const id of ['board-view','list-view','timeline-view'])expect(Boolean(element('#'+id).closest('[hidden]'))).toBe(!visible);
    };
    assertToolbar(true);
    for(const tab of ['terminal','schedules','sessions','settings']){
      click('#project-tab-'+tab);assertToolbar(false);
      window.eval('render()');assertToolbar(false);
      click('#project-tab-board');assertToolbar(true);
    }
    click('#list-view');
    for(const nav of ['dashboard-nav','workflows-nav','agents-nav','skills-nav','settings-button']){
      click('#'+nav);assertToolbar(false);
      window.eval('render()');assertToolbar(false);
      click('[data-project="'+project.id+'"]');assertToolbar(true);
      expect(element('#list-view').getAttribute('aria-pressed')).toBe('true');
    }
    click('#overview-nav');assertToolbar(true);
    // The list tab swaps the overview lanes for the task list on the all-projects page.
    expect(element('#board').classList.contains('overview-board')).toBe(false);
    click('#board-view');expect(element('#board').classList.contains('overview-board')).toBe(true);
    click('#list-view');expect(element('#board').classList.contains('overview-board')).toBe(false);
  });
  it('shows PR settings globally and per project with PR enabled by default', async () => {
    click('#settings-button');click('#settings-tab-git');
    expect(element<HTMLSelectElement>('#field-taskMergeMode').value).toBe('pull-request');
    expect(element('label[for="field-taskMergeMode"]').textContent).toContain('Pull request (PR)');
    input('#field-taskMergeMode','branch');submit('#settings-form');
    await wait(()=>expect(server.service.snapshot().settings.taskMergeMode).toBe('branch'));
    await createProject();click('#project-tab-settings');click('#settings-tab-git');
    const select=element<HTMLSelectElement>('#field-taskMergeMode');
    expect(select.value).toBe('');
    expect(select.selectedOptions[0]?.textContent).toContain('Genel ayarı kullan · Doğrudan branch merge');
    input('#field-taskMergeMode','pull-request');submit('#project-settings-form');
    await wait(()=>expect(server.service.snapshot().projects[0]?.taskMergeMode).toBe('pull-request'));
    await wait(()=>expect(element('#project-settings-save-state').textContent).toBe('Tüm değişiklikler kaydedildi'));
    input('#field-taskMergeMode','');submit('#project-settings-form');
    await wait(()=>expect(server.service.snapshot().projects[0]?.taskMergeMode).toBeNull());
  });
  it('edits project settings on a tabbed page, saves through the API and keeps drafts across server pushes', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;
    window.localStorage.removeItem('aiws.project-settings-section');click('#project-tab-settings');
    const sections=[...window.document.querySelectorAll('#project-settings-tabs [role="tab"]')];
    expect(sections.map(tab=>tab.id)).toEqual(['settings-tab-general','settings-tab-providers','settings-tab-git','settings-tab-execution','settings-tab-tracking','settings-tab-danger']);

    expect(element('#settings-panel-general').hidden).toBe(false);expect(element('#settings-panel-git').hidden).toBe(true);
    expect(element('#settings-panel-general').getAttribute('aria-labelledby')).toBe('settings-tab-general');
    element('#settings-tab-general').focus();element('#project-settings-tabs').dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}) as unknown as Event);element('#project-settings-tabs').dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}) as unknown as Event);
    expect(element('#settings-tab-git').getAttribute('aria-selected')).toBe('true');expect(window.document.activeElement?.id).toBe('settings-tab-git');expect(element('#settings-panel-git').hidden).toBe(false);expect(element('#settings-panel-general').hidden).toBe(true);
    expect(element('#settings-panel-git').querySelector('input[name="projectAutoMerge"]')).not.toBeNull();expect(element('#settings-panel-git').querySelector('#settings-subpanel-project-git-github #settings-detect-repository')).not.toBeNull();expect([...element('#settings-panel-git').querySelectorAll('[data-settings-subtab]')].map(tab=>tab.textContent)).toEqual(['Branch ve birleştirme','Worktree','GitHub']);expect(element('#settings-panel-danger').querySelector('[data-action="delete-project"]')).not.toBeNull();
    input('#field-taskMergeMode','pull-request');
    click('#settings-tab-general');
    const description=element<HTMLTextAreaElement>('#settings-field-description'),name=element<HTMLInputElement>('#settings-field-name');expect(name.value).toBe('Renderer QA');
    description.value='Draft description in progress';description.dispatchEvent(new window.Event('input',{bubbles:true}) as unknown as Event);
    expect(element('#project-settings-save-state').textContent).toBe('Kaydedilmemiş değişiklikler');
    server.service.updateProject(project.id,{name:'Renamed elsewhere'});
    await wait(()=>expect(element('#breadcrumb-project').textContent).toBe('Renamed elsewhere'));
    await new Promise(resolve=>setTimeout(resolve,50));
    expect(element<HTMLTextAreaElement>('#settings-field-description')).toBe(description);expect(description.value).toBe('Draft description in progress');expect(name.value).toBe('Renderer QA');expect(element('#project-settings-save-state').textContent).toBe('Kaydedilmemiş değişiklikler');
    name.value='Saved from settings page';submit('#project-settings-form');
    await wait(()=>expect(server.service.snapshot().projects[0]).toMatchObject({name:'Saved from settings page',description:'Draft description in progress',taskMergeMode:'pull-request'}));
    await wait(()=>expect(element('#project-settings-save-state').textContent).toBe('Tüm değişiklikler kaydedildi'));
    expect(element('#breadcrumb-project').textContent).toBe('Saved from settings page');expect(element<HTMLInputElement>('#settings-field-name')).not.toBe(name);expect(element<HTMLInputElement>('#settings-field-name').value).toBe('Saved from settings page');expect(element('#settings-panel-general').hidden).toBe(false);
    server.service.updateProject(project.id,{description:'Clean form follows the server'});
    await wait(()=>expect(element<HTMLTextAreaElement>('#settings-field-description').value).toBe('Clean form follows the server'));
    element<HTMLInputElement>('#settings-field-name').value='';submit('#project-settings-form');
    expect(window.document.activeElement?.id).toBe('settings-field-name');expect(server.service.snapshot().projects[0]?.name).toBe('Saved from settings page');
  });
  it('keeps card titles and descriptions selectable without opening the task, and Alt+drag selects instead of moving', async () => {
    await createProject();await createTask('Copy this task title');click('#close-panel');
    const card=element('.task-card');expect(card.getAttribute('draggable')).toBe('true');expect(card.getAttribute('role')).toBe('button');
    expect(element('.task-drag-handle').hasAttribute('draggable')).toBe(false);
    element('.task-card h3').dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true,altKey:true}) as unknown as Event);expect(card.getAttribute('draggable')).toBe('false');
    window.document.dispatchEvent(new window.PointerEvent('pointerup',{bubbles:true}) as unknown as Event);expect(card.getAttribute('draggable')).toBe('true');
    const style=window.document.createElement('style');style.textContent=await uiStyleSource();window.document.head.append(style);
    for(const selector of ['.task-card h3','.card-description','#breadcrumb-project']){
      const text=element(selector),range=window.document.createRange();range.selectNodeContents(text);
      const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
      expect(selection.toString()).toBe(text.textContent);
      expect(window.getComputedStyle(text).getPropertyValue('user-select')).toBe(selector==='#breadcrumb-project'?'text':'none');
      const clickEvent=new window.MouseEvent('click',{bubbles:true,cancelable:true,detail:1});
      text.dispatchEvent(clickEvent as unknown as Event);
      expect(element('#task-panel').hidden).toBe(true);
      if(selector!== '#breadcrumb-project')expect(clickEvent.defaultPrevented).toBe(true);
    }
    window.getSelection()!.removeAllRanges();click('.task-card');expect(element('#task-panel').hidden).toBe(false);
  });

  it('selects a range, drags selected tasks together, and preserves an unselected task', async () => {
    await createProject();const projectId=server.service.snapshot().projects[0]!.id;
    const items=['First','Second','Third'].map(title=>server.service.createTask({projectId,title}));
    await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(3));
    expect(window.document.querySelector('#toggle-task-selection')).toBeNull();expect(window.document.querySelector('#select-visible-tasks')).toBeNull();
    selectTask(items[0]!.id);
    element(`[data-open-task="${items[1]!.id}"]`).dispatchEvent(new window.MouseEvent('click',{bubbles:true,shiftKey:true}) as unknown as Event);
    expect(element('#task-selection-count').textContent).toBe('2 görev seçili');expect(element('#task-panel').hidden).toBe(true);
    const drag=new window.Event('dragstart',{bubbles:true});const transfer={setData:vi.fn(),effectAllowed:''};Object.defineProperty(drag,'dataTransfer',{value:transfer});
    element(`[data-open-task="${items[0]!.id}"] [data-task-drag]`).dispatchEvent(drag as unknown as Event);
    expect(transfer.setData).toHaveBeenCalledWith('text/plain',`${items[0]!.id}\n${items[1]!.id}`);
    element('[data-drop-status="review"]').dispatchEvent(new window.Event('drop',{bubbles:true,cancelable:true}) as unknown as Event);
    await wait(()=>expect(items.slice(0,2).map(item=>server.service.task(item.id).status)).toEqual(['review','review']));
    expect(server.service.task(items[2]!.id).status).toBe('backlog');
    await wait(()=>expect(element('#task-selection-count').textContent).toBe('0 görev seçili'));
  });

  const dragEvent=(type:string,target:Element):Event=>{const event=new window.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{setData:vi.fn(),effectAllowed:'',dropEffect:''}});target.dispatchEvent(event as unknown as Event);return event as unknown as Event;};
  it('drags a ready card back to the backlog column', async () => {
    await createProject();const projectId=server.service.snapshot().projects[0]!.id;
    const item=server.service.createTask({projectId,title:'Back to backlog',status:'ready'});
    await wait(()=>expect(window.document.querySelector(`[data-drop-status="ready"] [data-open-task="${item.id}"]`)).not.toBeNull());
    dragEvent('dragstart',element(`[data-open-task="${item.id}"]`));dragEvent('dragover',element('[data-drop-status="backlog"]'));dragEvent('drop',element('[data-drop-status="backlog"]'));
    await wait(()=>expect(server.service.snapshot().tasks.find(task=>task.id===item.id)?.status).toBe('backlog'));
  });

  it('archives sidebar projects by dragging them under the collapsible archive without touching the project', async () => {
    await createProject();const first=server.service.snapshot().projects[0]!;const other=join(directory,'archived-project');await mkdir(other);const second=server.service.createProject({name:'Archived project',repositoryPath:other});
    await wait(()=>expect(window.document.querySelector(`[data-project="${second.id}"]`)).not.toBeNull());
    expect(element('#project-archive-toggle').getAttribute('aria-expanded')).toBe('false');expect(element('#project-archive-list').hidden).toBe(true);
    dragEvent('dragstart',element(`[data-project="${second.id}"]`));dragEvent('dragover',element('#project-archive-toggle'));expect(element('#project-archive-toggle').classList.contains('drop-into')).toBe(true);dragEvent('drop',element('#project-archive-toggle'));dragEvent('dragend',element('#project-list'));
    expect(window.document.querySelector(`#project-archive-list [data-project="${second.id}"]`)).not.toBeNull();expect(element('#project-archive-toggle .nav-count').textContent).toBe('1');expect(window.localStorage.getItem('aiws.project-archive')).toBe(JSON.stringify([second.id]));
    expect(server.service.snapshot().projects.find(item=>item.id===second.id)).toEqual(second);
    click('#project-archive-toggle');expect(element('#project-archive-toggle').getAttribute('aria-expanded')).toBe('true');expect(element('#project-archive-list').hidden).toBe(false);
    dragEvent('dragstart',element(`[data-project="${second.id}"]`));element(`[data-project="${first.id}"]`).dispatchEvent(Object.assign(new window.Event('drop',{bubbles:true,cancelable:true}),{clientY:-100}) as unknown as Event);
    await wait(()=>expect(server.service.snapshot().projects.map(item=>item.id)).toEqual([second.id,first.id]));expect(window.document.querySelector(`#project-archive-list [data-project="${second.id}"]`)).toBeNull();
    element(`[data-project="${first.id}"]`).dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:20,clientY:20}) as unknown as Event);
    [...window.document.querySelectorAll<HTMLButtonElement>('.file-context-menu button')].find(button=>button.textContent==='Arşive taşı')!.click();
    expect(window.document.querySelector(`#project-archive-list [data-project="${first.id}"]`)).not.toBeNull();
  });

  it('links blockers only with Ctrl+drag and moves status only with a plain drag', async () => {
    await createProject();const projectId=server.service.snapshot().projects[0]!.id;
    const blocker=server.service.createTask({projectId,title:'Drop target'});const child=server.service.createTask({projectId,title:'Dragged task'});
    await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(2));
    const transfer={setData:vi.fn(),effectAllowed:'',dropEffect:''};
    const fire=(type:string,target:Element,ctrlKey=false)=>{const event=new window.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:transfer});Object.defineProperty(event,'ctrlKey',{value:ctrlKey});target.dispatchEvent(event as unknown as Event);return event;};
    const target=element(`[data-open-task="${blocker.id}"]`);
    fire('dragstart',element(`[data-open-task="${child.id}"]`));expect(transfer.effectAllowed).toBe('move');
    expect(fire('dragover',target).defaultPrevented).toBe(false);expect(target.classList.contains('blocker-drop-target')).toBe(false);
    expect(fire('dragover',element('[data-drop-status="review"]')).defaultPrevented).toBe(true);expect(element('[data-drop-status="review"]').classList.contains('drag-over')).toBe(true);
    fire('dragend',element(`[data-open-task="${child.id}"]`));
    fire('dragstart',element(`[data-open-task="${child.id}"]`),true);expect(transfer.effectAllowed).toBe('link');
    expect(fire('dragover',element('[data-drop-status="review"]')).defaultPrevented).toBe(false);expect(window.document.querySelector('.drag-over')).toBeNull();
    expect(fire('dragover',target).defaultPrevented).toBe(true);expect(transfer.dropEffect).toBe('link');
    expect(target.classList.contains('blocker-drop-target')).toBe(true);expect(target.dataset.blockerLabel).toBe('Bunun bitmesini bekle');
    fire('drop',target);await wait(()=>expect(server.service.task(child.id).dependsOn).toEqual([blocker.id]));
    expect(server.service.task(child.id).status).toBe(server.service.task(blocker.id).status);
  });

  it('keeps a new card on the board when a state read older than the live stream arrives', async () => {
    await createProject();const projectId=server.service.snapshot().projects[0]!.id;
    const transport=window.fetch;let reads=0,release:(()=>void)|undefined;
    const spy=vi.spyOn(window,'fetch').mockImplementation((async(path: string | URL | Request,init?: RequestInit)=>{
      const response=await transport(path as never,init as never);
      // The first read is answered by the server now and reaches the page only after the new task's stream message.
      if(String(path).startsWith('/api/state')&&!reads++)await new Promise<void>(resolve=>release=resolve);
      return response;
    }) as never);
    try{
      const refreshed=window.eval('refresh()') as Promise<void>;
      await wait(()=>expect(release).toBeDefined());
      const created=server.service.createTask({projectId,title:'Created during a read',status:'backlog'});
      await wait(()=>expect(window.document.querySelector(`[data-open-task="${created.id}"]`)).not.toBeNull());
      release!();await refreshed;
      expect(window.eval('state.tasks.map(item=>item.id)')).toContain(created.id);
      await wait(()=>expect(window.document.querySelector(`[data-open-task="${created.id}"]`)).not.toBeNull());
      expect(reads).toBe(2);
    }finally{release?.();spy.mockRestore();}
  });

  it('accepts automatic starts during a pending ready move and unlocks dragging before refresh finishes', async () => {
    await createProject();const projectId=server.service.snapshot().projects[0]!.id;
    const blocker=server.service.createTask({projectId,title:'Prerequisite'});
    const task=server.service.createTask({projectId,title:'Automatically started',dependsOn:[blocker.id],provider:'command',terminalMode:'stream',command:{executable:process.execPath,args:['-e','setInterval(()=>{},1000)']}});
    const other=server.service.createTask({projectId,title:'Still draggable'});
    await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(3));
    const transport=window.fetch;let releaseMove:(()=>void)|undefined,releaseRefresh:(()=>void)|undefined;
    vi.spyOn(window,'fetch').mockImplementation((async(path: string | URL | Request,init?: RequestInit)=>{
      if(String(path)===`/api/tasks/${task.id}`&&init?.method==='PATCH'){
        const response=await transport(path as never,init as never);
        await new Promise<void>(resolve=>releaseMove=resolve);return response;
      }
      if(String(path).startsWith('/api/state'))await new Promise<void>(resolve=>releaseRefresh=resolve);
      return transport(path as never,init as never);
    }) as never);
    try{
      selectTask(task.id);input('#bulk-task-status','ready');click('#move-selected-tasks');
      await wait(()=>expect(server.service.task(task.id).queueReason).toContain('dependencies'));
      server.service.updateTask(blocker.id,{status:'done'});
      await wait(()=>expect(server.service.task(task.id).status).toBe('running'));
      await wait(()=>expect(element(`[data-open-task="${task.id}"]`).closest('[data-drop-status]')?.getAttribute('data-drop-status')).toBe('running'));
      click(`[data-open-task="${task.id}"]`);click('[data-detail-tab="info"]');
      expect(element<HTMLSelectElement>('#detail-status').value).toBe('running');
      releaseMove!();await wait(()=>expect(releaseRefresh).toBeDefined());
      const card=element(`[data-open-task="${other.id}"]`);
      expect(dragEvent('dragstart',card).defaultPrevented).toBe(false);
      expect(card.classList.contains('dragging')).toBe(true);dragEvent('dragend',card);
    }finally{releaseMove?.();releaseRefresh?.();await server.service.stop(server.service.task(task.id).currentRunId!);}
  });

  it.each(['Escape','blur','pointerdown','pointerup','hidden','detached source'])('recovers board updates after a lost dragend on %s', async recovery => {
    await createProject();const projectId=server.service.snapshot().projects[0]!.id;
    const task=server.service.createTask({projectId,title:'Interrupted drag'});
    await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(1));
    click('.task-card');click('[data-detail-tab="info"]');
    const card=element('.task-card');dragEvent('dragstart',card);dragEvent('dragover',element('[data-drop-status="ready"]'));
    card.dispatchEvent(new window.PointerEvent('pointercancel',{bubbles:true}) as unknown as Event);
    expect(card.classList.contains('dragging')).toBe(true);
    server.service.updateTask(task.id,{title:'Updated during drag',status:'review'});
    await wait(()=>expect(element<HTMLSelectElement>('#detail-status').value).toBe('review'));
    expect(card.textContent).toContain('Interrupted drag');
    if(recovery==='Escape')window.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}) as unknown as Event);
    else if(recovery==='hidden'){Object.defineProperty(window.document,'hidden',{configurable:true,value:true});window.document.dispatchEvent(new window.Event('visibilitychange'));}
    else if(recovery==='detached source'){card.remove();dragEvent('dragend',card);}
    else window.dispatchEvent(new window.Event(recovery,{bubbles:true}));
    await wait(()=>expect(element('[data-drop-status="review"]').textContent).toContain('Updated during drag'));
    expect(window.document.querySelector('.drop-placeholder,.drag-over,.blocker-drop-target,.task-card.dragging')).toBeNull();
    expect(card.classList.contains('dragging')).toBe(false);
    const next=element('.task-card');dragEvent('dragstart',next);expect(next.classList.contains('dragging')).toBe(true);dragEvent('dragend',next);
  });

  it('drags whole cards with a drop indicator, holds board renders mid-drag and rolls back refused moves', async () => {
    await createProject();const projectId=server.service.snapshot().projects[0]!.id;
    const item=server.service.createTask({projectId,title:'Drag me'});
    await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(1));
    const card=element(`[data-open-task="${item.id}"]`);
    dragEvent('dragstart',card);expect(card.classList.contains('dragging')).toBe(true);
    expect(dragEvent('dragover',card).defaultPrevented).toBe(false);expect(window.document.querySelector('.drop-placeholder')).toBeNull();
    expect(dragEvent('dragover',element('[data-drop-status="review"] .empty-column')).defaultPrevented).toBe(true);
    expect(element('[data-drop-status="review"] .drop-placeholder').textContent).toBe('1 görevi buraya bırak');
    expect(element('[data-drop-status="review"]').classList.contains('drag-over')).toBe(true);
    dragEvent('dragover',element('[data-drop-status="ready"]'));
    expect(window.document.querySelectorAll('.drop-placeholder')).toHaveLength(1);expect(element('[data-drop-status="review"]').classList.contains('drag-over')).toBe(false);
    server.service.updateTask(item.id,{title:'Renamed while dragging'});
    await new Promise(resolve=>setTimeout(resolve,300));
    expect(card.isConnected).toBe(true);expect(element('.task-card h3').textContent).toBe('Drag me');
    dragEvent('dragend',card);
    await wait(()=>expect(element('.task-card h3').textContent).toBe('Renamed while dragging'));
    expect(window.document.querySelector('.drop-placeholder')).toBeNull();expect(window.document.querySelector('.drag-over')).toBeNull();
    const transport=window.fetch;let release:(()=>void)|undefined;
    vi.spyOn(window,'fetch').mockImplementation((async(path: string | URL | Request,init?: RequestInit)=>{
      if(String(path)===`/api/tasks/${item.id}`&&init?.method==='PATCH'){await new Promise<void>(resolve=>release=resolve);return new window.Response(JSON.stringify({error:'Move refused'}),{status:409,headers:{'Content-Type':'application/json'}});}
      return transport(path as never,init as never);
    }) as never);
    dragEvent('dragstart',element(`[data-open-task="${item.id}"]`));dragEvent('drop',element('[data-drop-status="review"]'));
    expect(element('[data-drop-status="review"]').textContent).toContain('Renamed while dragging');
    await wait(()=>expect(release).toBeDefined());release!();
    await wait(()=>expect(element('#error-banner').textContent).toContain('Move refused'));
    await wait(()=>expect(element('[data-drop-status="backlog"]').textContent).toContain('Renamed while dragging'));
    expect(element('[data-drop-status="review"]').textContent).not.toContain('Renamed while dragging');expect(server.service.task(item.id).status).toBe('backlog');
  });
  it('moves tasks by dropping them on overview columns of the same project only', async () => {
    await createProject();const projectId=server.service.snapshot().projects[0]!.id;
    const other=server.service.createProject({name:'Other workspace',repositoryPath:directory});
    const item=server.service.createTask({projectId,title:'Overview drag'});server.service.createTask({projectId:other.id,title:'Other lane'});
    click('#overview-nav');await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(2));
    dragEvent('dragstart',element(`[data-open-task="${item.id}"]`));
    expect(dragEvent('dragover',element(`[data-drop-project="${other.id}"][data-drop-status="review"]`)).defaultPrevented).toBe(false);

    expect(dragEvent('dragover',element(`[data-drop-project="${projectId}"][data-drop-status="review"]`)).defaultPrevented).toBe(true);
    dragEvent('drop',element(`[data-drop-project="${projectId}"][data-drop-status="review"]`));
    await wait(()=>expect(server.service.task(item.id).status).toBe('review'));
    await wait(()=>expect(element(`[data-drop-project="${projectId}"][data-drop-status="review"]`).textContent).toContain('Overview drag'));
  });
  it('gives every project a swimlane on the all projects board and summarises them on the dashboard page', async () => {
    await createProject();const projectId=server.service.snapshot().projects[0]!.id;
    const quiet=server.service.createProject({name:'Quiet workspace',repositoryPath:directory});
    server.service.createTask({projectId,title:'Needs review',status:'review'});server.service.createTask({projectId,title:'Next up',status:'ready'});
    click('#overview-nav');await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(2));
    expect(window.document.querySelectorAll('.swimlane-head [data-select-column]')).toHaveLength(6);expect(window.document.querySelectorAll('.overview-stat')).toHaveLength(0);expect(window.document.querySelector('.dashboard-grid')).toBeNull();
    expect(window.document.querySelectorAll('.project-board-group')).toHaveLength(2);expect(window.document.querySelector(`[data-drop-project="${projectId}"][data-drop-status="review"] [data-open-task]`)).not.toBeNull();
    click(`[data-lane-toggle="${quiet.id}"]`);expect(window.document.querySelector(`[data-drop-project="${quiet.id}"]`)).toBeNull();click(`[data-lane-toggle="${quiet.id}"]`);expect(window.document.querySelector(`[data-drop-project="${quiet.id}"]`)).not.toBeNull();
    click('#dashboard-nav');expect(element('#dashboard-nav').classList.contains('active')).toBe(true);expect(window.document.querySelectorAll('.overview-stat')).toHaveLength(5);expect(window.document.querySelectorAll('.dashboard-table tbody tr')).toHaveLength(2);expect(element(`.dashboard-projects [data-project="${quiet.id}"]`).textContent).toContain('Quiet workspace');
    expect(element('.dashboard-now').textContent).toContain('Şu an çalışan agent yok');
    const reviewTask=server.service.snapshot().tasks.find(task=>task.title==='Needs review')!,at=new Date().toISOString(),usage={inputTokens:1000,outputTokens:500,cacheReadTokens:0,cacheWriteTokens:0,totalTokens:1500,costUsd:0.25,recordedAt:at};
    for(const [id,status] of [['run_dashboard_done','completed'],['run_dashboard_failed','failed']])server.service.store.state.runs.push({id,taskId:reviewTask.id,provider:'claude',status,startedAt:at,finishedAt:at,exitCode:status==='completed'?0:1,executionMode:'native',pendingCommands:[],continuation:0,terminalMode:'stream',usage} as never);
    server.service.emit('change',server.service.snapshot());
    await wait(()=>expect(element('.dashboard-summary').textContent).toContain('3K'));expect(window.document.querySelectorAll('.dashboard-heat-cell')).toHaveLength(168);expect(element('.dashboard-insights').textContent).toContain('2 çalışma');expect(element('.dashboard-insights').textContent).toContain('1 başarısız');expect(element('.dashboard-summary').textContent).toContain('%50');expect(element('.dashboard-summary').textContent).toContain('$0.500');
    expect(window.document.querySelectorAll('.dashboard-activity .dashboard-day')).toHaveLength(14);expect(element('.dashboard-day.is-today').getAttribute('title')).toContain('2 çalışma · 1 tamamlandı · 1 başarısız');
    expect(element('.dashboard-agent').textContent).toContain('2 çalışma');expect(element(`.dashboard-projects tbody tr:first-child [data-project="${projectId}"]`)).not.toBeNull();click('[data-dashboard-range="7"]');expect(window.document.querySelectorAll('.dashboard-activity .dashboard-day')).toHaveLength(7);click('[data-dashboard-range="14"]');click('#overview-nav');expect(element(`[data-open-task="${reviewTask.id}"] .card-usage`).textContent).toBe('3K token · $0.500');server.service.store.state.runs[0]!.usage={...usage,cacheReadTokens:300,costUsd:null};server.service.store.state.runs[1]!.usage={...usage,costUsd:null};server.service.emit('change',server.service.snapshot());await wait(()=>expect(element(`[data-open-task="${reviewTask.id}"] .card-usage`).textContent).toBe('3K token'));
    click(`[data-open-task="${reviewTask.id}"]`);click('[data-detail-tab="info"]');
    await wait(()=>expect(element('#issue-usage-title').closest('.issue-panel')?.textContent).toContain('2 çalışma'));
    const breakdown=[...element('#issue-usage-title').closest('.issue-panel')!.querySelectorAll('.usage-breakdown-row')].map(row=>row.textContent);
    expect(breakdown).toEqual([`Toplam token${(3000).toLocaleString((window as any).AIWSI18n.locale)}%100`,`Girdi${(2000).toLocaleString((window as any).AIWSI18n.locale)}%67`,'Önbellek okuma300%10',`Çıktı${(1000).toLocaleString((window as any).AIWSI18n.locale)}%33`]);
    expect(element(`[data-run-summary="run_dashboard_done"] .usage-breakdown`).textContent).toContain('Önbellek okuma300');
    click('#dashboard-nav');
    click(`.dashboard-projects [data-overview-new-task="${quiet.id}"]`);
    expect(element('#modal').hasAttribute('open')).toBe(true);expect(element<HTMLSelectElement>('#field-projectId').value).toBe(quiet.id);
  });
  it('sorts the list view from its headers, toggles direction and remembers the choice', async () => {
    await createProject();const projectId=server.service.snapshot().projects[0]!.id;
    server.service.createTask({projectId,title:'Bravo',status:'review'});server.service.createTask({projectId,title:'alpha'});server.service.createTask({projectId,title:'Charlie',status:'ready'});
    await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(3));click('#list-view');
    const titles=()=>[...window.document.querySelectorAll('#board tbody tr')].map(row=>row.children[2]!.textContent);
    const sortState=(key:string)=>element(`[data-sort-list="${key}"]`).closest('th')!.getAttribute('aria-sort');
    expect(titles()).toEqual(['Bravo','alpha','Charlie']);expect(sortState('title')).toBe('none');
    click('[data-sort-list="title"]');expect(titles()).toEqual(['alpha','Bravo','Charlie']);expect(sortState('title')).toBe('ascending');
    click('[data-sort-list="title"]');expect(titles()).toEqual(['Charlie','Bravo','alpha']);expect(sortState('title')).toBe('descending');
    click('[data-sort-list="status"]');expect(titles()).toEqual(['alpha','Charlie','Bravo']);expect(sortState('status')).toBe('ascending');expect(sortState('title')).toBe('none');
    expect(JSON.parse(window.localStorage.getItem('aiws.list-sort')!)).toEqual({key:'status',dir:'asc'});
    expect(element('#task-panel').hidden).toBe(true);
    click('th.list-select [data-select-column]');expect(element('#task-selection-count').textContent).toBe('3 görev seçili');expect(titles()).toEqual(['alpha','Charlie','Bravo']);
    click('[data-select-column]');expect(element('#task-selection-count').textContent).toBe('0 görev seçili');
    await closeWindow(window, pageIdle);
    await mountRenderer({'aiws.view':'list','aiws.list-sort':JSON.stringify({key:'status',dir:'desc'})});
    await wait(()=>expect(titles()).toEqual(['Bravo','Charlie','alpha']));expect(sortState('status')).toBe('descending');
    click('[data-sort-list="updated"]');expect(sortState('updated')).toBe('ascending');expect(JSON.parse(window.localStorage.getItem('aiws.list-sort')!)).toEqual({key:'updated',dir:'asc'});
  });

  it('supports keyboard selection in list view and prunes filtered or other-project selections', async () => {
    await createProject();const projectId=server.service.snapshot().projects[0]!.id;
    const first=server.service.createTask({projectId,title:'Visible task'});const second=server.service.createTask({projectId,title:'Other task'});
    await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(2));click('#list-view');
    element(`tr[data-open-task="${first.id}"]`).dispatchEvent(new window.KeyboardEvent('keydown',{key:' ',ctrlKey:true,bubbles:true,cancelable:true}) as unknown as Event);
    expect(element(`tr[data-open-task="${first.id}"]`).getAttribute('aria-pressed')).toBe('true');
    selectTask(second.id);expect(element('#task-selection-count').textContent).toBe('2 görev seçili');
    input('#search','Visible');element('#search').dispatchEvent(new window.Event('input',{bubbles:true}) as unknown as Event);
    expect(element('#task-selection-count').textContent).toBe('1 görev seçili');
    input('#bulk-task-status','done');click('#move-selected-tasks');
    await wait(()=>expect(server.service.task(first.id).status).toBe('done'));
    await wait(()=>expect(element<HTMLButtonElement>('#move-selected-tasks').disabled).toBe(true));
    selectTask(first.id);
    const other=server.service.createProject({name:'Other project',repositoryPath:directory});
    await wait(()=>expect(window.document.querySelector(`[data-project="${other.id}"]`)).not.toBeNull());click(`[data-project="${other.id}"]`);
    expect(element('#task-selection-count').textContent).toBe('0 görev seçili');expect(element('#task-selection-controls').hidden).toBe(true);
  });

  it('keeps failed moves selected while moving the rest through the real API', async () => {
    await createProject();const projectId=server.service.snapshot().projects[0]!.id;
    // A task whose merge and cleanup are still running refuses every move except Done.
    const blocked=server.service.createTask({projectId,title:'Merging task'});
    server.service.store.state.tasks.find(task=>task.id===blocked.id)!.status='completing';
    const movable=server.service.createTask({projectId,title:'Movable task'});
    await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(2));
    selectTask(blocked.id);selectTask(movable.id);input('#bulk-task-status','ready');click('#move-selected-tasks');
    await wait(()=>expect(server.service.task(movable.id).status).toBe('ready'));
    await wait(()=>expect(element('#error-banner').textContent).toContain('Merging task'));
    await wait(()=>expect(element('#task-selection-count').textContent).toBe('1 görev seçili'));
    expect(element(`[data-open-task="${blocked.id}"]`).classList.contains('bulk-selected')).toBe(true);
    expect(server.service.task(blocked.id).status).toBe('completing');
    await wait(()=>expect(element<HTMLButtonElement>('#clear-task-selection').disabled).toBe(false));click('#clear-task-selection');expect(element('#task-selection-count').textContent).toBe('0 görev seçili');
  });

  it.each([['backlog','ready'],['ready','backlog']] as const)('keeps moving every selected task from %s to %s when state patches arrive mid bulk move', async (from,to) => {
    await createProject();const projectId=server.service.snapshot().projects[0]!.id;
    // An unfinished prerequisite keeps tasks in Ready instead of starting them.
    const blocker=server.service.createTask({projectId,title:'Prerequisite'});
    const items=['Bulk one','Bulk two','Bulk three'].map(title=>server.service.createTask({projectId,title,status:from,dependsOn:[blocker.id]}));
    await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(4));
    const transport=window.fetch;let release:(()=>void)|undefined;
    vi.spyOn(window,'fetch').mockImplementation((async(path: string | URL | Request,init?: RequestInit)=>{
      if(String(path)===`/api/tasks/${items[0]!.id}`&&init?.method==='PATCH'){
        const response=await transport(path as never,init as never);
        await new Promise<void>(resolve=>release=resolve);return response;
      }
      return transport(path as never,init as never);
    }) as never);
    try{
      for(const item of items)selectTask(item.id);
      input('#bulk-task-status',to);click('#move-selected-tasks');
      await wait(()=>expect(release).toBeDefined());
      const version=window.eval('stateVersion') as number;
      await wait(()=>expect(window.eval('stateVersion')).toBeGreaterThan(version));
      release!();
      await wait(()=>expect(items.map(item=>server.service.task(item.id).status)).toEqual([to,to,to]));
      await wait(()=>expect(items.every(item=>element(`[data-open-task="${item.id}"]`).closest('[data-drop-status]')?.getAttribute('data-drop-status')===to)).toBe(true));
    }finally{release?.();}
  });

  it('queues board moves when execution slots are occupied without showing a move error', async () => {
    await createProject(); const projectId=server.service.snapshot().projects[0]!.id;
    server.service.updateSettings({maxConcurrent:1});
    const occupied=server.service.createTask({projectId,title:'Delivering'});
    server.service.task(occupied.id).status='completing';
    const task=server.service.createTask({projectId,title:'Wait for capacity',provider:'command',command:{executable:process.execPath,args:['-e','console.log("queued")']}});
    await wait(()=>expect(window.document.querySelector(`[data-open-task="${task.id}"]`)).not.toBeNull());
    selectTask(task.id);input('#bulk-task-status','running');click('#move-selected-tasks');
    await wait(()=>expect(server.service.task(task.id).status).toBe('ready'));
    await wait(()=>expect(element('#toast').textContent).toContain('Hazır kuyruğuna alındı'));
    expect(element('#error-banner').hidden).toBe(true);
    expect(server.service.snapshot().runs).toHaveLength(0);
    await wait(()=>expect(element(`[data-drop-status="ready"] [data-open-task="${task.id}"]`)).toBeTruthy());
  });

  it('toggles selection with Ctrl/Command, clears with Escape, and starts bulk moves using runs', async () => {
    await createProject();const projectId=server.service.snapshot().projects[0]!.id;
    await mkdir(join(directory,'second-workspace'));const secondProject=server.service.createProject({name:'Second workspace',repositoryPath:join(directory,'second-workspace')});
    const items=['Run first','Run second'].map((title,index)=>server.service.createTask({projectId:index?secondProject.id:projectId,title,provider:'command',command:{executable:process.execPath,args:['-e','console.log("bulk run")']}}));
    click('#overview-nav');
    await wait(()=>expect(window.document.querySelectorAll('.task-card')).toHaveLength(2));
    const modifiedClick=(id:string,modifier:'ctrlKey'|'metaKey')=>element(`[data-open-task="${id}"]`).dispatchEvent(new window.MouseEvent('click',{bubbles:true,[modifier]:true}) as unknown as Event);
    modifiedClick(items[0]!.id,'ctrlKey');modifiedClick(items[1]!.id,'metaKey');expect(element('#task-selection-count').textContent).toBe('2 görev seçili');
    modifiedClick(items[0]!.id,'ctrlKey');expect(element('#task-selection-count').textContent).toBe('1 görev seçili');
    window.document.body.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}) as unknown as Event);expect(element('#task-selection-count').textContent).toBe('0 görev seçili');
    selectTask(items[0]!.id);selectTask(items[1]!.id);input('#bulk-task-status','running');click('#move-selected-tasks');click('#move-selected-tasks');
    await wait(()=>expect(server.service.snapshot().runs).toHaveLength(2));
    await wait(()=>expect(element('#task-selection-count').textContent).toBe('0 görev seçili'));
    expect(server.service.snapshot().runs.map(run=>run.taskId).sort()).toEqual(items.map(item=>item.id).sort());
  });

  it('moves tasks with drag/drop and keyboard-accessible status control', async () => {
    await createProject(); await createTask();
    const drag = new window.Event('dragstart', { bubbles: true });
    Object.defineProperty(drag, 'dataTransfer', { value: { setData: vi.fn(), effectAllowed: '' } });
    element('.task-card [data-task-drag]').dispatchEvent(drag as unknown as Event);
    const drop = new window.Event('drop', { bubbles: true, cancelable: true });
    element('[data-drop-status="ready"]').dispatchEvent(drop as unknown as Event);
    await wait(() => expect(server.service.snapshot().tasks[0]?.status).toBe('ready'));
    click('[data-detail-tab="info"]');input('#detail-status', 'review'); element('#detail-status').dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
    await wait(() => expect(server.service.snapshot().tasks[0]?.status).toBe('review'));
    await wait(() => expect(element('[data-drop-status="review"]').textContent).toContain('Implement renderer flow'));
  });
  it('notifies once across projects and opens the correct approval without stealing draft focus', async () => {
    await createProject();
    const other = server.service.createProject({name:'Other workspace',repositoryPath:directory});
    const task = server.service.createTask({projectId:other.id,title:'Permission task',provider:'command',command:{executable:process.execPath,args:['-e','setInterval(()=>{},1000)']}});
    const run = server.service.startTask(task.id);
    const notify = vi.fn().mockResolvedValue(true);
    (window as unknown as {aiwsDesktop:unknown}).aiwsDesktop={notifyQuestion:notify};window.document.hasFocus=()=>false;
    const request = server.service.ask(run.id,{text:'Allow deployment to staging?',kind:'approval'});
    await wait(()=>expect(notify).toHaveBeenCalledOnce());
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({id:request.id,taskId:task.id,title:'Onayın gerekiyor · Permission task',body:'Other workspace — Allow deployment to staging?'}));
    expect(element('.input-request-toast').textContent).toContain('Permission task');
    expect(element('#breadcrumb-project').textContent).toBe('Renderer QA');
    // The toast and the header's notifications react to the stream at once.
    expect(element('#notifications-list').textContent).toContain('Other workspace');
    expect(element('#notifications-badge').hidden).toBe(false);expect(element('#notifications-badge').textContent).toBe('1');
    window.eval('refresh()'); await new Promise(resolve=>setTimeout(resolve,100)); expect(notify).toHaveBeenCalledOnce();
    click('#input-request-toasts [data-open-question]');
    expect(element('#breadcrumb-project').textContent).toBe('Other workspace');
    await consoleMounted();expect(element('.cv-question').textContent).toContain('Onayın gerekiyor');
    expect(window.document.activeElement?.id).toBe(`answer-${request.id}`);
    // Opening the request fades its toast out and clears its badge.
    expect(element('#notifications-badge').hidden).toBe(true);
    await wait(()=>expect(window.document.querySelectorAll('.input-request-toast')).toHaveLength(0));
    input(`#answer-${request.id}`,'Only staging');click('.cv-question-dock [value="approve"]');
    await wait(()=>expect(server.service.snapshot().questions.find(item=>item.id===request.id)?.answer).toBe('Onaylandı.\n\nOnly staging'));
    await wait(()=>expect(element('.cv-question-dock').hidden).toBe(true));
    await wait(()=>expect(element('#notifications-list').children).toHaveLength(0));expect(element('#notifications-empty').hidden).toBe(false);
    expect(element('.cv-exchange .cv-answer').textContent).toContain('Only staging');
    await server.service.stop(run.id);
    await wait(()=>expect(window.document.querySelectorAll('.input-request-toast')).toHaveLength(0));
  });

  it('opens the waiting task from the header notifications and keeps its panel open', async () => {
    await createProject();
    const project = server.service.snapshot().projects[0]!;
    const task = server.service.createTask({projectId:project.id,title:'Waiting task',provider:'command',command:{executable:process.execPath,args:['-e','setInterval(()=>{},1000)']}});
    const run = server.service.startTask(task.id);
    expect(element('#notifications-badge').hidden).toBe(true);
    const request = server.service.ask(run.id,{text:'| Which | option?'});
    await wait(()=>expect(element('#notifications-badge').textContent).toBe('1'));
    expect(element('#notifications-badge').hidden).toBe(false);expect(element('#notifications-menu').hidden).toBe(true);expect(element('.input-request-toast').textContent).toContain('Waiting task');
    // Looking at the dropdown clears the badge and the request stays listed until it settles.
    click('#notifications-button');
    expect(element('#notifications-menu').hidden).toBe(false);expect(element('#notifications-button').getAttribute('aria-expanded')).toBe('true');expect(element('#notifications-badge').hidden).toBe(true);
    expect(element('#notifications-menu').textContent).toContain('Waiting task');expect(element('#notifications-menu').textContent).not.toContain('|');
    expect(element('#notifications-empty').hidden).toBe(true);expect(element('#notifications-foot').hidden).toBe(true);
    expect(window.document.activeElement).toBe(element(`#notifications-list [data-open-question="${request.id}"]`));
    element('#notifications').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    expect(element('#notifications-menu').hidden).toBe(true);expect(window.document.activeElement?.id).toBe('notifications-button');
    click('#notifications-button');click('#board');expect(element('#notifications-menu').hidden).toBe(true);
    click('#notifications-button');click(`#notifications-list [data-open-question="${request.id}"]`);
    expect(element('#notifications-menu').hidden).toBe(true);
    expect(element('#task-panel').hidden).toBe(false);expect(element('#task-detail-title').textContent).toBe('Waiting task');
    await consoleMounted();expect(window.document.activeElement?.id).toBe(`answer-${request.id}`);
    await server.service.stop(run.id);
  });

  it('streams questions, preserves typed commands, answers, pauses, resumes, and stops a real process', async () => {
    await createProject();
    const project = server.service.snapshot().projects[0]!;
    const task = server.service.createTask({ projectId: project.id, title: 'Controlled process', provider: 'command', terminalMode: 'stream', command: { executable: process.execPath, args: ['-e', 'console.log("live output");setInterval(()=>{},1000)'] } });
    await wait(() => expect(window.document.querySelectorAll('.task-card')).toHaveLength(1));
    click(`[data-open-task="${task.id}"]`); server.service.startTask(server.service.snapshot().tasks[0]!.id);
    click('[data-detail-tab="console"]');
    await wait(()=>expect(element('.header-run-action').textContent).toBe('Çalışıyor'));await wait(() => expect(window.document.querySelector('#task-message-form')).not.toBeNull());
    expect(window.document.querySelector('[data-action="edit-task"]')).toBeNull();click('[data-detail-tab="info"]');
    for(const selector of ['#info-model-trigger','#info-provider','#info-model-choice'])expect(element<HTMLSelectElement>(selector).disabled,selector).toBe(true);expect(element<HTMLSelectElement>('#detail-status').disabled).toBe(false);
    expect(element('[data-info-row="model"]').getAttribute('title')).toContain('Çalışma sürerken değiştirilemez');expect(element<HTMLInputElement>('#info-title').disabled).toBe(false);
    commit('#info-title','Controlled process renamed');await wait(()=>expect(server.service.task(task.id).title).toBe('Controlled process renamed'));click('[data-detail-tab="console"]');
    const run = server.service.snapshot().runs[0]!;
    click('[data-action="delete-task"]');submit('#modal form');await wait(()=>expect(element('.form-error').textContent).toMatch(/active|stop|running|clos/i));expect(server.service.snapshot().tasks).toHaveLength(1);click('[data-action="close-modal"]');
    await wait(() => expect(element('.cv-timeline').textContent).toContain('live output'));
    input('#task-message-input', 'Keep this draft'); element('#task-message-input').focus();
    const question = server.service.ask(run.id, { text: 'Which option should I choose?' });
    await wait(() => expect(element('.cv-question').textContent).toContain('Which option should I choose?'));
    expect((element('#task-message-input') as HTMLInputElement).value).toBe('Keep this draft');
    expect(element('#notifications-list').children).toHaveLength(1);
    // The open task docks the request itself, so no toast covers the panel and nothing is new.
    expect(window.document.querySelectorAll('.input-request-toast')).toHaveLength(0);expect(element('#notifications-badge').hidden).toBe(true);
    expect(element('#task-detail-title').textContent).toBe('Controlled process renamed');
    window.eval('refresh()');
    expect(window.document.activeElement?.id).toBe('task-message-input');
    click('.header-run-action[data-open-question]');
    expect(window.document.activeElement?.id).toBe(`answer-${question.id}`);
    input(`#answer-${question.id}`, 'Choose option A'); submit('[data-cv-question]');
    await wait(() => expect(server.service.snapshot().questions[0]?.answer).toBe('Choose option A'));
    await wait(() => expect(window.document.querySelector('[data-cv-question]')).toBeNull());
    expect(server.service.snapshot().questions[0]?.answer).toBe('Choose option A');
    await wait(() => expect(window.document.querySelectorAll('.input-request-toast')).toHaveLength(0));
    input('#task-message-input', 'Then verify tests'); submit('#task-message-form');
    await wait(() => expect(server.service.snapshot().runs[0]?.pendingCommands).toContain('Then verify tests'));
    click('[data-run-action="pause"]'); await wait(() => expect(server.service.snapshot().runs[0]?.status).toBe('paused'));
    await wait(() => expect(window.document.querySelector('[data-run-action="resume"]')).not.toBeNull());
    click('[data-run-action="resume"]'); await wait(() => expect(server.service.snapshot().runs[0]?.status).toBe('running'));
    await wait(() => expect(window.document.querySelector('[data-run-action="stop"]')).not.toBeNull());
    click('[data-run-action="stop"]'); await wait(() => expect(server.service.snapshot().runs[0]?.status).toBe('cancelled'));
    await wait(() => expect(element('.header-run-action').dataset.runAction).toBe('restart'));
  },20000);
  it('surfaces API validation errors, filters tasks, and safely renders task text', async () => {
    await createProject(); await createTask('<img src=x onerror=alert(1)>');
    expect(window.document.querySelector('.task-card h3 img')).toBeNull();
    expect(element('.task-card h3').textContent).toBe('<img src=x onerror=alert(1)>');
    input('#search', 'not found'); element('#search').dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    expect(window.document.querySelectorAll('.task-card')).toHaveLength(0);
    // A filtered empty board says nothing matched and clears the filters in one click.
    expect(element('.empty-column').textContent).toContain('Eşleşen görev yok');click('[data-clear-board-filters]');
    expect(element<HTMLInputElement>('#search').value).toBe('');expect(window.document.querySelectorAll('.task-card')).toHaveLength(1);
    // The search also matches the task key and label names, case-insensitively; Escape in the search clears it.
    const created = server.service.snapshot().tasks[0]!; server.service.updateTask(created.id, { tags: ['Frontend'] });
    for (const needle of [`aiws-${created.id.replace(/^task_/,'').slice(0,6)}`, 'frontend']) {
      await wait(() => { input('#search', needle); element('#search').dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event); expect(window.document.querySelectorAll('.task-card')).toHaveLength(1); });
    }
    element('#search').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }) as unknown as Event);
    expect(element<HTMLInputElement>('#search').value).toBe('');expect(window.document.querySelectorAll('.task-card')).toHaveLength(1);
    click('#project-tab-settings'); input('#settings-field-repositoryPath', 'relative/path'); submit('#project-settings-form');
    await wait(() => expect(element('#project-settings-form .form-error').textContent).toContain('absolute'));
    expect(element('#project-settings-save-state').textContent).toBe('Kaydedilemedi');expect(element<HTMLInputElement>('#settings-field-repositoryPath').value).toBe('relative/path');
  });
  it('shows retained PR changes and links after a task branch is removed', async () => {
    await createProject();
    vi.spyOn(ControlGitHub.prototype,'pullRequestChanges').mockResolvedValue({root:null,branch:null,base:null,files:[{path:'saved.txt',status:'added',additions:1,deletions:0}],patches:{'saved.txt':'@@ -0,0 +1 @@\n+retained change'},additions:1,deletions:0,truncated:false});
    const project=server.service.snapshot().projects[0]!;
    const item=server.service.createTask({projectId:project.id,title:'PR history',status:'done',pullRequest:{number:41,url:'https://github.com/owner/repo/pull/41',merged:true}});
    await wait(()=>expect(window.document.querySelector(`[data-open-task="${item.id}"]`)).not.toBeNull());
    click(`[data-open-task="${item.id}"]`);
    await wait(()=>expect(window.document.querySelector('[data-open-changes]')).not.toBeNull());
    expect(element('.issue-timestamps a').textContent).toContain('PR #41');
    click('[data-open-changes]');
    await wait(()=>expect(element('#child-changes-host').textContent).toContain('saved.txt'));
    expect(element('.changes-summary').textContent).toContain('Pull request değişiklikleri');
    expect(element('.changes-summary a').getAttribute('href')).toBe('https://github.com/owner/repo/pull/41');
    expect(window.document.querySelector('[data-changes-merge]')).toBeNull();
  });

  it('shows the pull request of each run in its summary', async () => {
    await createProject();
    const project=server.service.snapshot().projects[0]!,at=new Date().toISOString();
    const item=server.service.createTask({projectId:project.id,title:'Two deliveries',status:'done'});
    const addRun=(id:string,number?:number)=>server.service.store.state.runs.push({id,taskId:item.id,provider:'codex',status:'completed',startedAt:at,finishedAt:at,exitCode:0,executionMode:'native',pendingCommands:[],continuation:0,terminalMode:'stream',...(number?{pullRequest:{number,url:`https://github.com/owner/repo/pull/${number}`}}:{})} as never);
    addRun('run_first',41);addRun('run_second',42);addRun('run_none');
    server.service.emit('change',server.service.snapshot());
    await wait(()=>expect(window.document.querySelector(`[data-open-task="${item.id}"]`)).not.toBeNull());
    click(`[data-open-task="${item.id}"]`);
    await wait(()=>expect(window.document.querySelector('[data-run-summary="run_second"]')).not.toBeNull());
    expect(element('[data-run-summary="run_first"] > summary .run-summary-pull').getAttribute('href')).toBe('https://github.com/owner/repo/pull/41');
    expect(element('[data-run-summary="run_second"] > summary .run-summary-pull').textContent).toContain('PR #42');
    expect(window.document.querySelector('[data-run-summary="run_none"] .run-summary-pull')).toBeNull();
  });
  it('persists theme and execution settings and keeps completed runs separate from task approval', async () => {
    const original = window.document.documentElement.dataset.theme;
    click('#theme-button'); expect(window.document.documentElement.dataset.theme).not.toBe(original);expect(element('#theme-button').getAttribute('aria-label')).toBe(original==='dark'?'Koyu temaya geç':'Açık temaya geç');
    expect(window.localStorage.getItem('aiws.theme')).toBe(window.document.documentElement.dataset.theme);
    click('#settings-button'); expect(element('#modal').hasAttribute('open')).toBe(false); expect(element<HTMLSelectElement>('#field-defaultProvider').value).toBe('codex'); edit('#field-defaultProvider', 'claude'); edit('#field-maxConcurrent', '5'); click('#settings-tab-git'); edit('#field-taskMergeMode','pull-request'); click('#settings-tab-voice'); expect(element<HTMLSelectElement>('#field-voiceProvider').value).toBe('claude'); expect([...element<HTMLSelectElement>('#field-voiceProvider').options].map(option => option.value)).toEqual(['codex', 'claude']); edit('#field-voiceProvider', 'codex'); expect(element('#settings-tab-voice').classList.contains('has-changes')).toBe(true); expect(element('#voice-panel .voice-provider').getAttribute('data-provider')).toBe('claude'); click('#settings-tab-git'); edit('#field-autoSyncSeconds', '0'); submit('#settings-form');
    await wait(() => expect(server.service.snapshot().settings.maxConcurrent).toBe(5));
    expect(server.service.snapshot().settings).toMatchObject({ defaultProvider: 'claude', voiceProvider: 'codex', autoSyncSeconds: 0, taskMergeMode:'pull-request' });
    expect(element('#voice-panel .voice-provider').getAttribute('data-provider')).toBe('codex');
    expect(element<HTMLImageElement>('#voice-panel .voice-provider .provider-icon img').getAttribute('src')).toBe('/icons/codex.svg');
    await wait(()=>expect(element('#settings-save-status').textContent).toBe('Kaydedildi'));click('#settings-tab-general');expect(element<HTMLSelectElement>('#field-defaultProvider').value).toBe('claude');expect(element<HTMLInputElement>('#field-maxConcurrent').value).toBe('5');
    await createProject();
    const project = server.service.snapshot().projects[0]!;
    const task = server.service.createTask({ projectId: project.id, title: 'Finite process', provider: 'command', command: { executable: process.execPath, args: ['-e', 'console.log("done")'] } });
    await wait(() => expect(window.document.querySelectorAll('.task-card')).toHaveLength(1));
    click(`[data-open-task="${task.id}"]`); server.service.startTask(server.service.snapshot().tasks[0]!.id);
    await wait(() => expect(server.service.snapshot().runs[0]?.status).toBe('completed'));
    await wait(() => expect(element('[data-drop-status="review"]').textContent).toContain('Finite process'));
    expect(server.service.snapshot().tasks[0]?.status).toBe('review');
    expect(window.document.querySelector('#command-form')).toBeNull();
  });
  it('dictates without repeating revised phrases, stops cleanly on Escape, and does not carry text across fields', async () => {
    await createProject();
    const sockets: Array<{ url: string; onmessage: ((event: { data: string }) => void) | null; onclose: (() => void) | null; close: () => void; send: (data: unknown) => void; readyState: number }> = [];
    class FakeWebSocket {
      static OPEN = 1;
      url: string; binaryType = ''; readyState = 1;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(url: string) { this.url = url; sockets.push(this); }
      send() {}
      close() { this.readyState = 3; this.onclose?.(); }
    }
    Object.defineProperty(window.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
    (window as unknown as Record<string, unknown>).AudioContext = class { audioWorklet = { addModule: async () => {} }; createMediaStreamSource() { return { connect() {} }; } close() { return Promise.resolve(); } };
    (window as unknown as Record<string, unknown>).AudioWorkletNode = class { port = { onmessage: null }; };
    (window as unknown as Record<string, unknown>).WebSocket = FakeWebSocket;
    const popover = (selector: string) => {
      const target = element(selector) as HTMLElement & { showPopover?: () => void; hidePopover?: () => void };
      const state = { open: false };
      target.showPopover = () => { state.open = true; };
      target.hidePopover = () => { state.open = false; };
      const origMatches = target.matches.bind(target);
      target.matches = (query: string) => query === ':popover-open' ? state.open : origMatches(query);
      return state;
    };
    const panel = element('#voice-panel');
    popover('#voice-panel');
    const micButton = popover('#voice-button');
    // happy-dom lays nothing out; a field without a size counts as out of view and gets no button.
    const laidOut = (field: HTMLElement) => { field.getBoundingClientRect = () => ({ left: 20, top: 40, right: 320, bottom: 72, width: 300, height: 32, x: 20, y: 40, toJSON() { return this; } }) as DOMRect; };

    // Focusing a field offers the microphone button; the shortcut starts dictation and takes the button away.
    const search = element<HTMLInputElement>('#search');
    laidOut(search); search.focus();
    expect(micButton.open).toBe(true);
    expect(element('#voice-button svg')).toBeTruthy();
    expect(element('#voice-button').parentElement).toBe(window.document.body);
    search.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyM', key: 'M', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }) as unknown as Event);
    await wait(() => expect(sockets).toHaveLength(1));
    expect(micButton.open).toBe(false);
    expect(sockets[0]!.url).toContain('provider=claude');
    expect(element('#voice-panel .voice-provider').getAttribute('data-provider')).toBe('claude');
    expect(element<HTMLImageElement>('#voice-panel .voice-provider .provider-icon img').getAttribute('src')).toBe('/icons/claude.png');

    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'ready' }) });
    // First phrase is finalized, then a revised second phrase arrives and is re-punctuated without duplicating words.
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'transcript', text: 'merhaba dünya', final: true }) });
    expect(search.value).toBe('merhaba dünya');
    // Post-endpoint duplicate of the same phrase must be ignored.
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'transcript', text: 'Merhaba dünya.', final: true }) });
    expect(search.value).toBe('Merhaba dünya.');
    // Second utterance in the same session:
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'transcript', text: 'bu ikinci cümle', final: true }) });
    expect(search.value).toBe('Merhaba dünya. bu ikinci cümle');

    // Pressing Escape closes immediately without duplicating the text.
    search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }) as unknown as Event);
    expect(search.value).toBe('Merhaba dünya. bu ikinci cümle');
    expect(panel.dataset.state).toBeUndefined();
    expect(micButton.open).toBe(true);
    // Typing in the field fades the button out; pressing the mouse in a field brings it back.
    search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }) as unknown as Event);
    expect(element('#voice-button').classList.contains('is-away')).toBe(true);
    search.dispatchEvent(new window.MouseEvent('pointerdown', { button: 0, bubbles: true }) as unknown as Event);
    expect(element('#voice-button').classList.contains('is-away')).toBe(false);

    // Starting dictation in another field starts fresh and never pastes the previous field's text.
    click('#create-task');
    const title = element<HTMLInputElement>('#field-title');
    laidOut(title); title.focus();
    // Pressing the microphone button starts dictation in the field without taking its focus. A modal dialog makes everything
    // outside it inert, so the button and the panel move into the dialog holding the field.
    expect(micButton.open).toBe(true);
    expect(element('#voice-button').parentElement).toBe(element('#modal'));
    const press = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    element('#voice-button').dispatchEvent(press as unknown as Event);
    expect(press.defaultPrevented).toBe(true);
    click('#voice-button');
    await wait(() => expect(sockets).toHaveLength(2));
    expect(window.document.activeElement).toBe(title);
    expect(micButton.open).toBe(false);
    expect(panel.parentElement).toBe(element('#modal'));
    sockets[1]!.onmessage?.({ data: JSON.stringify({ type: 'ready' }) });
    sockets[1]!.onmessage?.({ data: JSON.stringify({ type: 'transcript', text: 'Yeni başlık', final: true }) });
    expect(title.value).toBe('Yeni başlık');
    title.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }) as unknown as Event);
    expect(title.value).toBe('Yeni başlık');

    // Shift + Enter leaves dictation running; Enter types what was heard, closes at once and still reaches the field.
    const shortcut = () => title.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyM', key: 'M', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }) as unknown as Event);
    shortcut();
    await wait(() => expect(sockets).toHaveLength(3));
    sockets[2]!.onmessage?.({ data: JSON.stringify({ type: 'ready' }) });
    title.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }) as unknown as Event);
    expect(panel.dataset.state).toBe('listening');
    sockets[2]!.onmessage?.({ data: JSON.stringify({ type: 'transcript', text: 'son kelimeler', final: false }) });
    let enterReached = false;
    title.addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Enter') enterReached = true; }, { once: true });
    title.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }) as unknown as Event);
    expect(title.value).toBe('Yeni başlık son kelimeler');
    expect(panel.dataset.state).toBeUndefined();
    expect(enterReached).toBe(true);
  });
  it('applies the global provider to inherited tasks, new profiles and template clones without pinning an edited inherited task', async () => {
    await createProject(); await createTask('Inherited task');
    const task=server.service.snapshot().tasks[0]!;
    click('#settings-button');input('#field-defaultProvider','opencode');submit('#settings-form');
    await wait(()=>expect(server.service.snapshot().settings.defaultProvider).toBe('opencode'));
    await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));
    expect(server.service.task(task.id).provider).toBe('opencode');
    // The detail panel names the inherited provider from the renderer's settings, which arrive after the server saves them.
    await wait(()=>expect(window.eval('state.settings.defaultProvider')).toBe('opencode'));click('[data-project]');
    click(`[data-open-task="${task.id}"]`);click('[data-detail-tab="info"]');
    expect(element<HTMLSelectElement>('#info-provider').value).toBe('');
    expect(element('#info-provider option[value=""]').textContent).toContain('OpenCode');
    commit('#info-title','Still inherited');
    await wait(()=>expect(server.service.task(task.id).title).toBe('Still inherited'));
    expect(server.service.task(task.id).providerOverride).toBeUndefined();
    await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));
    click('#agents-nav');click('#create-task');
    expect(element<HTMLSelectElement>('#field-provider').value).toBe('opencode');
    expect(element<HTMLSelectElement>('#field-terminalMode').value).toBe('stream');
    click('#close-modal');click('[data-agent-library="templates"]');
    await wait(()=>expect(window.document.querySelectorAll('.template-card').length).toBeGreaterThan(0));
    click('[data-preview-template]');click('#clone-agent-template');
    expect(element<HTMLSelectElement>('#field-provider').value).toBe('opencode');
  });
  it('saves provider CLI arguments one per line, preserves argv boundaries, and restores independent values on the settings page', async () => {
    const update=vi.spyOn(server.service,'updateSettings');click('#settings-button');click('#settings-tab-providers');
    expect(element<HTMLTextAreaElement>('#provider-args-codex').value).toBe('');expect(element<HTMLTextAreaElement>('#provider-args-codex').placeholder).toBe('--yolo');expect(element('[data-provider-args="codex"]').hasAttribute('open')).toBe(true);expect(element('[data-provider-args="claude"]').hasAttribute('open')).toBe(false);
    edit('#provider-args-codex','--yolo\n\n--config\nmodel_reasoning_effort="high"\n--model\n value with spaces \n   ');edit('#provider-args-claude','--verbose');edit('#provider-args-opencode','--log-level\nDEBUG');edit('#provider-args-copilot','--reasoning-effort\nhigh');click('#settings-tab-general');edit('#field-maxConcurrent','5');click('#settings-tab-git');edit('#field-autoSyncSeconds','0');
    expect(element('#settings-save-status').textContent).toBe('Kaydedilmemiş değişiklikler var');expect(element('#settings-tab-providers').classList.contains('has-changes')).toBe(true);submit('#settings-form');
    const expected={codex:['--yolo','--config','model_reasoning_effort="high"','--model',' value with spaces '],claude:['--verbose'],opencode:['--log-level','DEBUG'],agy:[],copilot:['--reasoning-effort','high']};
    await wait(()=>expect(server.service.snapshot().settings).toMatchObject({providerArgs:expected,maxConcurrent:5,autoSyncSeconds:0}));expect(update).toHaveBeenCalledWith(expect.objectContaining({providerArgs:expected}));expect(server.service.snapshot().runs).toHaveLength(0);expect(server.service.snapshot().tasks).toHaveLength(0);
    await wait(()=>expect(element('#settings-save-status').textContent).toBe('Kaydedildi'));click('#overview-nav');click('#settings-button');click('#settings-tab-providers');expect(element<HTMLTextAreaElement>('#provider-args-codex').value).toBe(expected.codex.join('\n'));expect(element<HTMLTextAreaElement>('#provider-args-claude').value).toBe('--verbose');expect(element<HTMLTextAreaElement>('#provider-args-opencode').value).toBe('--log-level\nDEBUG');click('#settings-tab-general');expect(element<HTMLInputElement>('#field-maxConcurrent').value).toBe('5');
    click('#settings-tab-providers');input('#provider-args-claude','');submit('#settings-form');await wait(()=>expect(server.service.snapshot().settings).toMatchObject({providerArgs:{...expected,claude:[]}}));
    await closeWindow(window, pageIdle);await mountRenderer();click('#settings-button');click('#settings-tab-providers');expect(element<HTMLTextAreaElement>('#provider-args-codex').value).toBe(expected.codex.join('\n'));expect(element<HTMLTextAreaElement>('#provider-args-claude').value).toBe('');expect(server.service.snapshot().runs).toHaveLength(0);
  });
  it('keeps provider CLI argument drafts on client or server validation errors', async () => {
    const update=vi.spyOn(server.service,'updateSettings');click('#settings-button');click('#settings-tab-providers');edit('#provider-args-codex',Array.from({length:65},()=> '--yolo').join('\n'));edit('#provider-args-claude','--verbose');submit('#settings-form');await wait(()=>expect(element('#settings-save-status').textContent).toContain('en fazla 64'));expect(update).not.toHaveBeenCalled();expect(element<HTMLTextAreaElement>('#provider-args-claude').value).toBe('--verbose');
    edit('#provider-args-codex','--resume\noriginal-session');submit('#settings-form');await wait(()=>expect(update).toHaveBeenCalledTimes(1));await wait(()=>expect(element('#settings-save-status').textContent).toMatch(/resume|session|reserved/i));expect(element('#settings-save-status').dataset.state).toBe('error');expect(element<HTMLTextAreaElement>('#provider-args-codex').value).toBe('--resume\noriginal-session');expect(element<HTMLTextAreaElement>('#provider-args-claude').value).toBe('--verbose');expect(element<HTMLButtonElement>('#settings-save').disabled).toBe(false);expect(server.service.snapshot().runs).toHaveLength(0);
  });
  it('names the header Settings button, hosts the language selector and returns to the previous screen', async () => {
    expect(element('#settings-button').getAttribute('aria-label')).toBe('Ayarlar');expect(window.document.querySelector('.topbar-right #settings-button')).not.toBeNull();expect(element('#running-label').textContent).toMatch(/^\d+\/\d+ agent çalışıyor$/);expect(window.document.querySelector('.sidebar #language-select')).toBeNull();
    click('#dashboard-nav');click('#settings-button');click('#settings-tab-general');
    expect(element<HTMLSelectElement>('#settings-page #language-select').value).toBe('tr');expect(element('#settings-back').textContent).toContain('Geri');
    click('#settings-back');expect(window.document.querySelector('#settings-page')).toBeNull();expect(element('#dashboard-nav').classList.contains('active')).toBe(true);expect(element('#settings-button').classList.contains('active')).toBe(false);
  });
  it('opens work settings as a page with keyboard tabs, detects providers, and persists provider toggles, the default and custom providers', async () => {
    await createProject();click('#settings-button');
    expect(element('#modal').hasAttribute('open')).toBe(false);expect(element('#settings-button').classList.contains('active')).toBe(true);expect(element('#settings-button').getAttribute('aria-current')).toBe('page');expect(element('#breadcrumb-project').textContent).toBe('Ayarlar');expect(element('#board-toolbar').hidden).toBe(true);expect(element('#create-task').hidden).toBe(true);
    expect(element('[role="tablist"].settings-tabs').getAttribute('aria-label')).toBe('Çalışma ayarları bölümleri');expect(element('#settings-tab-general').getAttribute('aria-selected')).toBe('true');expect(element('#settings-panel').getAttribute('role')).toBe('tabpanel');expect(element('#settings-panel').getAttribute('aria-labelledby')).toBe('settings-tab-general');expect(element('#settings-tab-providers').getAttribute('tabindex')).toBe('-1');
    expect([...window.document.querySelectorAll('#settings-panel [data-settings-subtab]')].map(tab=>tab.textContent)).toEqual(['Sistem','Görünüm']);expect(element('#settings-subpanel-work-general-system').hidden).toBe(false);expect(element('#settings-subpanel-work-general-appearance').hidden).toBe(true);
    element('#settings-subtab-work-general-system').focus();element('#settings-subtab-work-general-system').dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}) as unknown as Event);
    expect(element('#settings-subtab-work-general-appearance').getAttribute('aria-selected')).toBe('true');expect(window.document.activeElement?.id).toBe('settings-subtab-work-general-appearance');expect(element('#settings-subpanel-work-general-appearance').hidden).toBe(false);expect(element('#settings-subpanel-work-general-system').hidden).toBe(true);expect(JSON.parse(window.localStorage.getItem('aiws.settings-subtabs')||'{}')['work-general']).toBe('appearance');
    click('#settings-subtab-work-general-system');expect(element('#settings-subpanel-work-general-system').hidden).toBe(false);
    element('#settings-tab-general').focus();element('#settings-tab-general').dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}) as unknown as Event);
    expect(element('#settings-tab-providers').getAttribute('aria-selected')).toBe('true');expect(window.document.activeElement?.id).toBe('settings-tab-providers');expect(window.localStorage.getItem('aiws.settings-tab')).toBe('providers');
    element('#settings-tab-providers').dispatchEvent(new window.KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}) as unknown as Event);expect(element('#settings-tab-plugins').getAttribute('aria-selected')).toBe('true');
    element('#settings-tab-plugins').dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}) as unknown as Event);expect(element('#settings-tab-general').getAttribute('aria-selected')).toBe('true');
    click('#settings-tab-providers');
    await wait(()=>expect(element('[data-provider-detect="codex"]').textContent).toContain('Kurulu · codex-cli 9.9.9'));expect(element('[data-provider-detect="claude"]').textContent).toContain('PATH üzerinde bulunamadı');expect(element('#provider-detect-summary').textContent).toContain('1/5 sağlayıcı bulundu');
    expect(element<HTMLInputElement>('#provider-enabled-codex').disabled).toBe(true);
    // Unsaved edits survive a server push that changes other settings.
    edit('#provider-args-agy','--model\ngemini');server.service.updateSettings({maxConcurrent:7});await wait(()=>expect(element('#settings-save-status').textContent).toBe('Kaydedilmemiş değişiklikler var'));await new Promise(resolve=>setTimeout(resolve,100));expect(element<HTMLTextAreaElement>('#provider-args-agy').value).toBe('--model\ngemini');
    click('#provider-default-claude');expect(element('[data-provider-card="claude"] .default-badge')).not.toBeNull();expect(element<HTMLInputElement>('#provider-enabled-codex').disabled).toBe(false);
    const codexToggle=element<HTMLInputElement>('#provider-enabled-codex');codexToggle.checked=false;codexToggle.dispatchEvent(new window.Event('change',{bubbles:true}) as unknown as Event);
    expect(element('[data-provider-card="codex"]').classList.contains('is-disabled')).toBe(true);expect(element('#provider-default-codex').hasAttribute('disabled')).toBe(true);
    expect(element('#provider-auto-claude-hint').textContent).toContain('--permission-mode auto');const autoToggle=element<HTMLInputElement>('#provider-auto-claude');expect(autoToggle.checked).toBe(false);autoToggle.checked=true;autoToggle.dispatchEvent(new window.Event('change',{bubbles:true}) as unknown as Event);
    click('#add-custom-provider');expect(window.document.activeElement?.id).toBe('custom-provider-0-name');edit('#custom-provider-0-name','Echo agent');edit('#custom-provider-0-executable',process.execPath);edit('#custom-provider-0-args','-e\nprocess.stdin.pipe(process.stdout)');expect(element('#custom-provider-0-title').textContent).toBe('Echo agent');
    // Provider cards, icons, auto-mode flags and the board filter all come from the server's provider registry.
    expect([...window.document.querySelectorAll<HTMLElement>('[data-provider-card]')].map(card=>card.dataset.providerCard)).toEqual(['codex','claude','opencode','agy','copilot']);
    expect(element<HTMLImageElement>('[data-provider-card="copilot"] .provider-icon img').getAttribute('src')).toBe('/icons/copilot.svg');expect(element('#provider-auto-copilot-hint').textContent).toContain('--allow-all');
    expect([...window.document.querySelectorAll<HTMLOptionElement>('#provider-filter option')].map(option=>option.value)).toEqual(['','codex','claude','opencode','agy','copilot','command']);
    click('#settings-tab-general');expect([...window.document.querySelectorAll<HTMLOptionElement>('#field-defaultProvider option')].map(option=>option.value)).toEqual(['claude','opencode','agy','copilot']);expect(element<HTMLSelectElement>('#field-defaultProvider').value).toBe('claude');expect(element<HTMLInputElement>('#field-maxConcurrent').value).toBe('3');
    submit('#settings-form');
    await wait(()=>expect(server.service.snapshot().settings).toMatchObject({defaultProvider:'claude',disabledProviders:['codex'],autoModeProviders:['claude'],maxConcurrent:3,providerArgs:{agy:['--model','gemini']},customProviders:[{id:'echo-agent',name:'Echo agent',executable:process.execPath,args:['-e','process.stdin.pipe(process.stdout)'],enabled:true}]}));
    await wait(()=>expect(element('#settings-save-status').textContent).toBe('Kaydedildi'));expect(element('#settings-discard').hidden).toBe(true);expect(element<HTMLButtonElement>('#settings-save').disabled).toBe(true);
    click('[data-project]');click('#create-task');const options=[...window.document.querySelectorAll<HTMLOptionElement>('#field-provider option')].map(option=>option.value);expect(window.document.querySelector<HTMLOptionElement>('#field-provider option[value="codex"]')!.disabled).toBe(true);expect(element('#field-model-menu [data-provider-value="codex"]').hasAttribute('disabled')).toBe(true);expect(options).toContain('custom:echo-agent');
    input('#field-title','Custom provider task');input('#field-provider','custom:echo-agent');submit('#modal form');
    await wait(()=>expect(server.service.snapshot().tasks.find(task=>task.title==='Custom provider task')).toMatchObject({provider:'command',command:{executable:process.execPath,args:['-e','process.stdin.pipe(process.stdout)']}}));
    expect(()=>server.service.createTask({projectId:server.service.snapshot().projects[0]!.id,title:'Disabled',provider:'codex'})).toThrow('disabled');
    await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));click('#settings-button');click('#settings-tab-providers');edit('#provider-args-claude','--verbose');click('#settings-discard');expect(element<HTMLTextAreaElement>('#provider-args-claude').value).toBe('');expect(element('#settings-save-status').textContent).toBe('Tüm değişiklikler kaydedildi');
  });
  it('saves GitHub connection and custom status mappings without contacting GitHub', async () => {
    server.service.updateSettings({ autoSyncSeconds: 0 });
    await createProject();
    click('#project-tab-settings'); click('#settings-tab-git'); click('#settings-subtab-project-git-github');
    expect(element('#project-settings-github-status').textContent).toContain('Yerel proje');
    (element('#settings-github-enabled') as HTMLInputElement).checked = true;
    element('#settings-github-enabled').dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
    input('#settings-field-repository', 'qa-owner/qa-repo'); input('#settings-field-owner', 'qa-owner'); input('#settings-field-number', '7');
    input('#settings-field-statusField', 'Workflow'); input('#settings-field-statuses', '{"backlog":"Todo","running":"Doing"}'); submit('#project-settings-form');
    await wait(() => expect(server.service.snapshot().projects[0]?.github?.statusField).toBe('Workflow'));
    expect(server.service.snapshot().projects[0]?.github?.statuses).toEqual({ backlog: 'Todo', running: 'Doing' });
    expect(element('#sync-status').textContent).toBe('İlk eşitleme bekleniyor');
    await wait(() => expect(element('#sync-button').hidden).toBe(false));
    await wait(() => expect(element('#project-settings-github-status').textContent).toContain('GitHub · qa-owner/qa-repo'));
    expect((element('#settings-field-statuses') as HTMLTextAreaElement).value).toContain('Doing');
    click('#project-tab-board');
  });
  it('creates reusable agent instructions and skills in UI and executes the inherited frozen configuration', async () => {
    await withLibrary();
    click('#skills-nav'); click('#create-task'); input('#field-name', 'API review'); input('#field-description', 'Check contracts');
    input('#field-content', '# API review\nAlways verify compatibility.');
    click('#add-text-resource'); input('#skill-files input', 'references/checklist.md'); input('#skill-files textarea', 'Check response shape.'); submit('#modal form');
    await wait(() => expect(server.service.snapshot().skills).toHaveLength(1));
    const skill = server.service.snapshot().skills[0]!;
    await wait(() => expect(window.document.querySelector(`[data-edit-skill="${skill.id}"]`)).not.toBeNull());
    click('#agents-nav'); click('#create-task'); input('#field-name', 'Backend specialist'); input('#field-description', 'Owns API changes');
    input('#field-provider', 'command'); element('#field-provider').dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
    input('#field-model', 'profile-model'); input('#field-executable', process.execPath);
    const script = 'const fs=require("fs"),path=require("path");let prompt="";process.stdin.on("data",v=>prompt+=v);process.stdin.on("end",()=>{const root=process.env.AIWS_SKILLS_DIR;const id=fs.readdirSync(root)[0];console.log(JSON.stringify({prompt,agent:process.env.AIWS_AGENT_ID,resource:fs.readFileSync(path.join(root,id,"references/checklist.md"),"utf8")}))})';
    input('#field-args', JSON.stringify(['-e', script])); input('#field-instructions', 'Inspect first, then change.'); input('#field-context', 'The API supports v1 clients.');
    (element(`input[name="skillIds"][value="${skill.id}"]`) as HTMLInputElement).checked = true; submit('#modal form');
    await wait(() => expect(server.service.snapshot().agents).toHaveLength(1));
    const agent = server.service.snapshot().agents[0]!;
    await createProject(); click('#create-task'); input('#field-title', 'Use the reusable profile'); input('#field-agentId', agent.id);
    element('#field-agentId').dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
    expect((element('#field-provider') as HTMLSelectElement).value).toBe('');
    expect((element('#field-model') as HTMLInputElement).value).toBe('');
    (element(`input[name="skillIds"][value="${skill.id}"]`) as HTMLInputElement).checked = true;
    submit('#modal form');
    await wait(() => expect(server.service.snapshot().tasks).toHaveLength(1));
    const task = server.service.snapshot().tasks[0]!;
    expect(task.providerOverride).toBeUndefined(); expect(task.modelOverride).toBeUndefined(); expect(task.provider).toBe('command');
    await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));click(`[data-open-task="${task.id}"]`);
    server.service.startTask(server.service.snapshot().tasks[0]!.id);
    await wait(() => expect(server.service.snapshot().runs[0]?.status).toBe('completed'));
    const run = server.service.snapshot().runs[0]!;
    expect(run.executionSnapshot).toMatchObject({ provider: 'command', model: 'profile-model', instructions: 'Inspect first, then change.', context: 'The API supports v1 clients.', agent: { id: agent.id, revision: 1 } });
    expect(run.executionSnapshot?.skills.map(value => value.id)).toEqual([skill.id]);
    const output = server.service.snapshot().events.filter(value => value.type === 'stdout').map(value => value.message).join('');
    expect(output).toContain('Inspect first, then change.'); expect(output).toContain('The API supports v1 clients.'); expect(output).toContain('Always verify compatibility.'); expect(output).toContain('Check response shape.');
        click('#agents-nav'); click(`[data-edit-agent="${agent.id}"]`); input('#field-instructions', 'New instructions for future runs.'); submit('#modal form');
    await wait(() => expect(server.service.snapshot().agents[0]?.revision).toBe(2));
    expect(server.service.snapshot().runs[0]?.executionSnapshot?.instructions).toBe('Inspect first, then change.');
    click(`[data-project="${task.projectId}"]`); click(`[data-open-task="${task.id}"]`);
    expect(element('[data-detail-tab="console"]').getAttribute('aria-selected')).toBe('true');click('[data-detail-tab="info"]');
    expect(window.document.querySelector('.snapshot-details')).toBeNull();
  });
  it('manages Claude Code accounts in work settings, assigns one to a task and opens a terminal as it', async () => {
    const accounts=aiProviders.require('claude').accounts!,window5h=(usedPercent:number)=>({usedPercent,resetsAt:null,windowMinutes:300}),weekly=(usedPercent:number)=>({usedPercent,resetsAt:null,windowMinutes:10080});
    const listed:ProviderAccountsStatus={tool:{name:'claude-swap',command:'cswap',url:'https://github.com/realiti4/claude-swap',installed:true,installer:'uv'},checkedAt:new Date().toISOString(),accounts:[
      {id:'1',email:'a@example.com',label:'a@example.com',active:true,disabled:false,status:'ok',short:window5h(20),weekly:weekly(30),updatedAt:null},
      {id:'2',email:'b@example.com',label:'work',alias:'work',active:false,disabled:false,status:'relogin_required',short:window5h(85),weekly:weekly(40),updatedAt:null}]};
    vi.spyOn(accounts,'status').mockResolvedValue(listed);const addCurrent=vi.spyOn(accounts,'addCurrent').mockResolvedValue(listed);
    const remove=vi.spyOn(accounts,'remove').mockResolvedValue({...listed,accounts:[listed.accounts[0]!]});
    await createProject();const project=server.service.snapshot().projects.find(item=>item.name==='Renderer QA')!;
    click('#settings-button');click('#settings-tab-providers');
    await wait(()=>expect(element('[data-provider-accounts="claude"]').textContent).toContain('work'));
    expect(element('[data-provider-accounts="claude"]').textContent).toContain('claude-swap kurulu');
    expect(element('[data-account="1"]').textContent).toContain('Varsayılan giriş');expect(element('[data-account="2"]').textContent).toContain('Yeniden giriş gerekli');expect(element('[data-account="2"] [data-tone="needs"]')).not.toBeNull();
    expect(window.document.querySelectorAll('[data-provider-accounts]')).toHaveLength(1);
    click('[data-accounts-current="claude"]');await wait(()=>expect(addCurrent).toHaveBeenCalledTimes(1));
    // A task of the provider offers its accounts; choosing one saves it on the task.
    const task=server.service.createTask({projectId:project.id,title:'Run as work',provider:'claude'});
    click('#settings-back');await wait(()=>expect(element(`[data-open-task="${task.id}"]`)).not.toBeNull());
    click(`[data-open-task="${task.id}"]`);click('[data-detail-tab="info"]');
    await wait(()=>expect([...element<HTMLSelectElement>('#info-account').options].map(option=>[option.value,option.text])).toEqual([['','Varsayılan giriş'],['1','a@example.com · Varsayılan giriş'],['2','work']]));
    commit('#info-account','2');await wait(()=>expect(server.service.task(task.id).account).toBe('2'));
    // The account row opens an agent terminal as that account on the project's Terminal tab.
    const openTerminal=vi.fn(async()=>{});(window as any).openProjectTerminal=openTerminal;
    click('#settings-button');click('#settings-tab-providers');await wait(()=>expect(element('[data-accounts-terminal="claude:2"]')).not.toBeNull());
    click('[data-accounts-terminal="claude:2"]');expect(openTerminal).toHaveBeenCalledWith(project.id,{kind:'agent',provider:'claude',account:'2'});
    expect(window.localStorage.getItem(`aiws.project-tab.${project.id}`)).toBe('terminal');
    click('#settings-button');click('#settings-tab-providers');await wait(()=>expect(element('[data-accounts-login="claude"]')).not.toBeNull());
    click('[data-accounts-login="claude"]');expect(openTerminal).toHaveBeenLastCalledWith(project.id,{kind:'login',provider:'claude'});
    click('#settings-button');click('#settings-tab-providers');await wait(()=>expect(element('[data-accounts-remove="claude:2"]')).not.toBeNull());
    click('[data-accounts-remove="claude:2"]');await confirmDialog();await wait(()=>expect(remove).toHaveBeenCalledWith('2'));
    await wait(()=>expect(window.document.querySelector('[data-account="2"]')).toBeNull());
    const css=await uiStyleSource();expect(css).toContain('.provider-account-list{');
  },20000);

  it('imports browser SKILL.md and binary resources, edits them, and imports a server folder', async () => {
    click('#skills-nav'); click('#create-task'); input('#field-name', 'Uploaded skill');
    const markdown = new window.File(['# Uploaded instructions\nUse this skill.'], 'SKILL.md', { type: 'text/markdown' });
    Object.defineProperty(element('#skill-markdown-upload'), 'files', { value: [markdown] });
    element('#skill-markdown-upload').dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
    await wait(() => expect((element('#field-content') as HTMLTextAreaElement).value).toContain('Uploaded instructions'));
    const binary = new window.File([new Uint8Array([0, 255, 1, 2])], 'asset.bin');
    Object.defineProperty(element('#skill-resources-upload'), 'files', { value: [binary] });
    element('#skill-resources-upload').dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
    await wait(() => expect(window.document.querySelectorAll('[data-resource-index]')).toHaveLength(1));
    input('#skill-files input', 'assets/asset.bin'); submit('#modal form');
    await wait(() => expect(server.service.snapshot().skills).toHaveLength(1));
    const uploaded = server.service.snapshot().skills[0]!;
    expect(uploaded.files[0]).toMatchObject({ path: 'assets/asset.bin', content: 'AP8BAg==', encoding: 'base64' });
    await wait(() => expect(window.document.querySelector(`[data-edit-skill="${uploaded.id}"]`)).not.toBeNull());
    click(`[data-edit-skill="${uploaded.id}"]`); input('#field-content', '# Revised instructions'); submit('#modal form');
    await wait(() => expect(server.service.snapshot().skills[0]?.revision).toBe(2));
    const source = join(directory, 'importable-skill'); await mkdir(join(source, 'references'), { recursive: true });
    await writeFile(join(source, 'SKILL.md'), '# Server skill\nRead the reference.'); await writeFile(join(source, 'references', 'guide.txt'), 'server resource');
    click('[data-action="import-skill-folder"]'); input('#field-directory', source); input('#field-name', 'Server imported'); submit('#modal form');
    await wait(() => expect(server.service.snapshot().skills).toHaveLength(2));
    expect(server.service.snapshot().skills[1]?.files[0]?.path).toBe('references/guide.txt');
    const imported = server.service.snapshot().skills[1]!;
    await wait(() => expect(window.document.querySelector(`[data-edit-skill="${imported.id}"]`)).not.toBeNull());
    click(`[data-edit-skill="${imported.id}"]`); click(`[data-delete-skill="${imported.id}"]`); submit('#modal form');
    await wait(() => expect(server.service.snapshot().skills).toHaveLength(1));
  });
  it('lists discovered global and project skills by scope and shares, overwrites, removes and imports them', async () => {
    await mkdir(join(directory, 'claude-history', 'skills', 'alpha'), { recursive: true });
    await writeFile(join(directory, 'claude-history', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Global helper\n---\n# Alpha');
    await mkdir(join(directory, '.claude', 'skills', 'delta', 'references'), { recursive: true });
    await writeFile(join(directory, '.claude', 'skills', 'delta', 'SKILL.md'), '---\nname: Delta review\ndescription: Project review checklist\n---\n# Delta');
    await writeFile(join(directory, '.claude', 'skills', 'delta', 'references', 'list.md'), 'check');
    await createProject();
    const otherPath = join(directory, 'other-project'); await mkdir(otherPath);
    const other = server.service.createProject({ name: 'Other app', repositoryPath: otherPath });
    click('#skills-nav');
    await wait(() => expect(window.document.querySelector('[data-skill-key="delta"]')).not.toBeNull());
    const headers = [...window.document.querySelectorAll('.skill-matrix thead th')].map((cell) => cell.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Global', 'Renderer QA', 'Other app']));
    const delta = element('[data-skill-key="delta"]'); expect(delta.textContent).toContain('Delta review'); expect(delta.textContent).toContain('Project review checklist'); expect(delta.textContent).toContain('Proje');
    expect(element('[data-skill-key="alpha"]').textContent).toContain('Global');
    expect(window.document.querySelector('[data-action="import-skill-folder"]')).not.toBeNull();
    // Share into the other project's Codex folder.
    click('[data-share-skill="delta"]'); assertModalShell();
    const target = `project:${other.id}:codex`;
    (element(`#skill-share-targets input[value="${target}"]`) as HTMLInputElement).checked = true; submit('#modal form');
    const copied = join(otherPath, '.codex', 'skills', 'delta');
    await wait(() => expect(server.service.snapshot().projects).toHaveLength(2));
    await vi.waitFor(async () => expect(await readFile(join(copied, 'references', 'list.md'), 'utf8')).toBe('check'), { timeout: 10_000, interval: 25 });
    await wait(() => expect(element('[data-skill-key="delta"]').querySelectorAll('.skill-chip')).toHaveLength(2));
    // A locally different copy is protected until the user ticks "Üzerine yaz".
    await writeFile(join(copied, 'SKILL.md'), 'edited locally');
    click('[data-skill-discovery="refresh"]');
    await wait(() => expect(element('[data-skill-key="delta"]').textContent).toContain('Farklı sürümler'));
    click('[data-share-skill="delta"]');
    expect(element(`#skill-share-targets input[value="${target}"]`).closest('.skill-share-target')?.textContent).toContain('Kurulu · farklı');
    (element(`#skill-share-targets input[value="${target}"]`) as HTMLInputElement).checked = true; submit('#modal form');
    await wait(() => expect(element('#skill-share-conflicts').hidden).toBe(false));
    expect(element('#skill-share-conflicts').textContent).toContain('SKILL.md'); expect(element('#modal .form-error').textContent).toContain('Hiçbir şey kopyalanmadı');
    expect(await readFile(join(copied, 'SKILL.md'), 'utf8')).toBe('edited locally');
    (element(`#skill-share-conflicts input[name="overwrite"][value="${target}"]`) as HTMLInputElement).checked = true; submit('#modal form');
    await vi.waitFor(async () => expect(await readFile(join(copied, 'SKILL.md'), 'utf8')).toContain('Delta review'), { timeout: 10_000, interval: 25 });
    await wait(() => expect(element('[data-skill-key="delta"]').textContent).not.toContain('Farklı sürümler'));
    // Remove the shared copy again from the share dialog.
    click('[data-share-skill="delta"]'); click(`[data-remove-discovered="${target}/delta"]`); assertModalShell(); submit('#modal form');
    await vi.waitFor(async () => expect(await readFile(join(copied, 'SKILL.md'), 'utf8').catch(() => 'missing')).toBe('missing'), { timeout: 10_000, interval: 25 });
    // One click copies a discovered skill into the AIWS catalog.
    await wait(() => expect(element('[data-skill-key="delta"]').querySelectorAll('.skill-chip')).toHaveLength(1));
    click('[data-skill-key="delta"] [data-import-discovered]');
    await wait(() => expect(server.service.snapshot().skills.map((skill) => skill.name)).toEqual(['Delta review']));
    expect(server.service.snapshot().skills[0]?.files.map((file) => file.path)).toEqual(['references/list.md']);
    await wait(() => expect(element('[data-skill-key="delta"]').textContent).toContain('Katalogda'));
  });
  it('keeps rejected skill drafts and missing-reference errors visible and protects assigned profiles', async () => {
    await withLibrary();
    click('#skills-nav'); click('#create-task'); input('#field-name', 'Draft skill'); input('#field-content', '# Keep this draft');
    click('#add-text-resource'); input('#skill-files input', '../outside.txt'); input('#skill-files textarea', 'draft resource'); submit('#modal form');
    await wait(() => expect(element('.form-error').textContent).toContain('safe relative'));
    expect((element('#field-content') as HTMLTextAreaElement).value).toBe('# Keep this draft');
    input('#skill-files input', 'references/safe.txt'); submit('#modal form');
    await wait(() => expect(server.service.snapshot().skills).toHaveLength(1));
    const skill = server.service.snapshot().skills[0]!;
    click('#agents-nav'); click('#create-task'); input('#field-name', 'Persistent profile');
    const choice = element(`input[name="skillIds"][value="${skill.id}"]`) as HTMLInputElement; choice.checked = true;
    server.service.catalog.deleteSkill(skill.id); submit('#modal form');
    await wait(() => expect(element('.form-error').textContent).toContain('Unknown skill'));
    expect((element('#field-name') as HTMLInputElement).value).toBe('Persistent profile');
    choice.checked = false; submit('#modal form');
    await wait(() => expect(server.service.snapshot().agents).toHaveLength(1));
    const agent = server.service.snapshot().agents[0]!;
    await createProject();
    server.service.createTask({ projectId: server.service.snapshot().projects[0]!.id, title: 'Assigned task', agentId: agent.id });
    click('#agents-nav'); click(`[data-edit-agent="${agent.id}"]`); click(`[data-delete-agent="${agent.id}"]`); submit('#modal form');
    await wait(() => expect(element('.form-error').textContent).toContain('assigned'));
    expect(server.service.snapshot().agents).toHaveLength(1);
  });
  it('applies explicit task provider/model/command choices ahead of an agent profile', async () => {
    const agent = server.service.catalog.createAgent({ name: 'Command default', provider: 'command', terminalMode: 'stream', model: 'profile-model', instructions: 'Profile instruction', context: 'Profile context', command: { executable: process.execPath, args: ['-e', 'console.log("profile command")'] } });
    await createProject(); click('#create-task'); input('#field-title', 'Explicit task override'); input('#field-agentId', agent.id);
    element('#field-agentId').dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
    input('#field-provider', 'command'); element('#field-provider').dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
    input('#field-model', 'task-model'); input('#field-executable', process.execPath); input('#field-args', JSON.stringify(['-e', 'console.log("task override")'])); submit('#modal form');
    await wait(() => expect(server.service.snapshot().tasks).toHaveLength(1));
    expect(server.service.snapshot().tasks[0]).toMatchObject({ providerOverride: 'command', modelOverride: 'task-model' });
    await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));await wait(()=>element('[data-open-task]'));click('[data-open-task]');
    server.service.startTask(server.service.snapshot().tasks[0]!.id);
    await wait(() => expect(server.service.snapshot().runs[0]?.status).toBe('completed'));
    expect(server.service.snapshot().runs[0]?.executionSnapshot).toMatchObject({ provider: 'command', model: 'task-model', instructions: 'Profile instruction' });
    const output = server.service.snapshot().events.filter(value => value.type === 'stdout').map(value => value.message).join('');
    expect(output).toContain('task override'); expect(output).not.toContain('profile command');
  });
  it('starts ready tasks with an explicitly selected command profile and shows the real reason for queued work', async () => {
    const agent=server.service.catalog.createAgent({name:'Available worker',provider:'command',capabilities:['backend'],command:{executable:process.execPath,args:['-e','console.log("working");setInterval(()=>{},1000)']}});
    await createProject();click('#create-task');input('#field-title','Ready without extra checkboxes');input('#field-agentId',agent.id);element('#field-agentId').dispatchEvent(new window.Event('change',{bubbles:true}) as unknown as Event);input('#field-status','ready');input('#field-tags','backend');submit('#modal form');
    await wait(()=>expect(server.service.snapshot().runs).toHaveLength(1));
    const first=server.service.snapshot().tasks[0]!;expect(first.agentId).toBe(agent.id);expect(first.status).toBe('running');
    await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));click(`[data-open-task="${first.id}"]`);
    expect(window.document.querySelector('input[name="autoStart"]')).toBeNull();
    await wait(()=>expect(element('.task-card').textContent).toContain('Çalışıyor'));
    const queued=server.service.createTask({projectId:first.projectId,title:'Wait for the workspace',agentId:agent.id,status:'ready',tags:['backend']});
    await wait(()=>expect(server.service.snapshot().tasks.find(task=>task.id===queued.id)?.queueReason).toBeTruthy());
    await wait(()=>expect(element(`[data-open-task="${queued.id}"]`).textContent).toContain(server.service.snapshot().tasks.find(task=>task.id===queued.id)!.queueReason!));
    expect(window.document.querySelector('[data-run-timer]')).not.toBeNull();
    await server.service.stop(first.currentRunId!);
    await wait(()=>expect(server.service.snapshot().runs).toHaveLength(2));
    await server.service.stop(server.service.snapshot().tasks.find(task=>task.id===queued.id)!.currentRunId!);
  },20000);
  it('fills the AI workspace with a read-only provider draft and creates only on explicit action, keeping edit drafts', async () => {
    const reply={reply:'İsteğini görev taslağına dönüştürdüm.',drafts:[{key:'feature',title:'Build the requested feature',description:'Implement the feature and verify its acceptance criteria.',status:'ready'}]};
    // A local Codex protocol fixture exercises the real provider invocation and read-only flags without a cloud account.
    const bin=join(directory,'fixture-bin');await mkdir(bin);const script=`if(!process.argv.includes('read-only'))throw new Error('read-only planning is required');let p='';process.stdin.on('data',v=>p+=v);process.stdin.on('end',()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(reply))}}})));`;
    if(process.platform==='win32'){const shim=join(bin,'codex-fixture.cjs');await writeFile(shim,script);await writeFile(join(bin,'codex.cmd'),`@echo off\r\n"${process.execPath}" "${shim}" %*\r\n`);}else await writeFile(join(bin,'codex'),`#!/usr/bin/env node\n${script}`,{mode:0o755});
    vi.stubEnv('PATH',`${bin}${delimiter}${process.env.PATH||''}`);
    const planner=server.service.catalog.createAgent({name:'Planning fixture',provider:'codex'});
    await createProject();expect(window.document.querySelector('#planner-form')).toBeNull();click('#ai-create-task');input('#ai-agent',planner.id);element('#ai-agent').dispatchEvent(new window.Event('change',{bubbles:true}) as unknown as Event);sendAI('Yeni özelliği planla ve görev taslağını doldur.');
    await wait(()=>expect(element('#ai-chat-log').textContent).toContain(reply.reply));
    expect(server.service.snapshot().tasks).toHaveLength(0);expect(server.service.snapshot().runs).toHaveLength(0);expect(server.service.snapshot().plannerMessages).toHaveLength(0);
    expect(element('[data-ai-draft="feature"] [data-ai-title]').textContent).toBe(reply.drafts[0]!.title);
    click('[data-ai-draft="feature"] [data-ai-create]');await wait(()=>expect(server.service.snapshot().tasks).toHaveLength(1));expect(server.service.snapshot().tasks[0]!.status).toBe('backlog');expect(server.service.snapshot().runs).toHaveLength(0);
    await wait(()=>expect(element<HTMLButtonElement>('[data-ai-draft="feature"] [data-ai-open-task]').disabled).toBe(false));click('[data-ai-draft="feature"] [data-ai-open-task]');click('#close-panel');
    const task=server.service.snapshot().tasks[0]!;await wait(()=>expect(window.document.querySelector(`[data-open-task="${task.id}"]`)).not.toBeNull());click(`[data-open-task="${task.id}"]`);click('#detail-tab-console');await consoleMounted();
    input('#task-message-input','Bir sonraki adım için notum.');submit('#task-message-form');
    await wait(()=>expect(server.service.snapshot().messages.some(message=>message.text==='Bir sonraki adım için notum.')).toBe(true));
    server.service.postMessage(task.id,{authorType:'agent',agentId:planner.id,text:'Notunu aldım; önce testleri inceleyeceğim.'});
    await wait(()=>expect(element('.conversation-history').textContent).toContain('Notunu aldım'));
    input('#task-message-input','SSE sırasında kaybolmayan taslak');element('#task-message-input').focus();
    server.service.updateTask(task.id,{priority:7});
    await wait(()=>expect(element('.task-card').textContent).toContain('Build the requested feature'));
    expect((element('#task-message-input') as HTMLTextAreaElement).value).toBe('SSE sırasında kaybolmayan taslak');
    click('[data-detail-tab="info"]');expect(element<HTMLInputElement>('#info-title').value).toBe(task.title);click('[data-info-edit-description]');expect(element<HTMLTextAreaElement>('#info-description').value).toBe(task.description);
    input('#info-description','Updated instructions from the edit form');submit('#info-description-form');
    await wait(()=>expect(server.service.snapshot().tasks[0]?.description).toBe('Updated instructions from the edit form'));
    await wait(()=>expect(window.document.querySelector('#info-description')).toBeNull());expect(element('.task-description').textContent).toContain('Updated instructions from the edit form');
    click('[data-detail-tab="console"]');click('[data-action="fullscreen-session"]');expect(element('.app-shell').classList.contains('session-fullscreen')).toBe(true);
    click('[data-action="fullscreen-session"]');expect((element('#task-message-input') as HTMLTextAreaElement).value).toBe('SSE sırasında kaybolmayan taslak');
  },20000);
  it('creates an ordered named workflow in UI and runs the requested deployment agent after implementation', async () => {
    await withLibrary();
    const frontend=server.service.catalog.createAgent({name:'Frontend worker',provider:'command',capabilities:['frontend'],command:{executable:process.execPath,args:['-e','require("fs").appendFileSync("order.txt","frontend\\n")']}});
    const deploy=server.service.catalog.createAgent({name:'Deploy worker',provider:'command',capabilities:['deploy'],command:{executable:process.execPath,args:['-e','require("fs").appendFileSync("order.txt","deploy\\n")']}});
    await createProject();click('#workflows-nav');click('#create-task');input('#field-name','Frontend then deploy');
    click('#add-workflow-step');input('[data-step-name]','Implement');input('[data-step-agent]',frontend.id);
    click('#add-workflow-step');const rows=window.document.querySelectorAll('[data-workflow-step]');
    (rows[1]!.querySelector('[data-step-name]') as unknown as HTMLInputElement).value='Deploy';(rows[1]!.querySelector('[data-step-agent]') as unknown as HTMLSelectElement).value=deploy.id;(rows[1]!.querySelector('[data-step-condition]') as unknown as HTMLSelectElement).value='deploy_requested';submit('#modal form');
    await wait(()=>expect(server.service.snapshot().workflows).toHaveLength(1));
    const workflow=server.service.snapshot().workflows[0]!;expect(workflow.steps.map(step=>step.agentId)).toEqual([frontend.id,deploy.id]);
    // The form lists workflows from renderer state, which can trail the server snapshot.
    await wait(()=>expect(window.document.querySelector('#modal')?.hasAttribute('open')).toBe(false));
    click(`[data-project="${server.service.snapshot().projects[0]!.id}"]`);click('#create-task');
    await wait(()=>expect(window.document.querySelector(`#field-workflowId option[value="${workflow.id}"]`)).not.toBeNull());
    input('#field-title','Implement and deploy');input('#field-workflowId',workflow.id);input('#field-status','ready');
    (element('input[name="workflowRequested"]') as HTMLInputElement).checked=true;(element('input[name="deployRequested"]') as HTMLInputElement).checked=true;
    (element('input[name="autoMergeInherit"]') as HTMLInputElement).checked=false;(element('input[name="autoMerge"]') as HTMLInputElement).checked=true;submit('#modal form');
    await wait(()=>expect(server.service.snapshot().tasks[0]?.workflowProgress?.status).toBe('completed'));
    expect((await readFile(join(directory,'order.txt'),'utf8')).trim().split('\n')).toEqual(['frontend','deploy']);
    expect(server.service.snapshot().runs.map(run=>run.executionSnapshot?.agent?.id)).toEqual([frontend.id,deploy.id]);
    expect(server.service.snapshot().tasks[0]).toMatchObject({status:'done',workflowId:workflow.id,requestedActions:['deploy'],autoMerge:true});
    await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));click('[data-open-task]');
    await wait(()=>expect(window.document.querySelector('[data-detail-tab="info"]')).not.toBeNull());click('[data-detail-tab="info"]');
    expect((element('#info-workflowId') as HTMLSelectElement).value).toBe(workflow.id);expect((element('#info-workflowRequested') as HTMLInputElement).checked).toBe(true);expect((element('#info-deployRequested') as HTMLInputElement).checked).toBe(true);expect((element('#info-autoMerge') as HTMLInputElement).checked).toBe(true);
    element<HTMLInputElement>('#info-autoMerge').checked=false;commit('#info-autoMerge');await wait(()=>expect(server.service.snapshot().tasks[0]?.autoMerge).toBe(false));expect(server.service.snapshot().tasks[0]?.requestedActions).toEqual(['deploy']);
  },20000);
  it('opens a running task session from the project terminal menu in a pane with its title and task status', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;
    const task=server.service.createTask({projectId:project.id,title:'Menu session task',provider:'command',terminalMode:'stream',command:{executable:process.execPath,args:['-e','setInterval(()=>{},1000)']}});
    const run=server.service.startTask(task.id);
    click('#project-tab-terminal');await wait(()=>expect(element<HTMLElement>('[data-terminal-empty]').hidden).toBe(false));
    click('[data-terminal-menu]');
    const item=`[data-terminal-menu-list] [data-terminal-open="session:${run.id}"]`;
    await wait(()=>expect(window.document.querySelector(item)).not.toBeNull());
    expect(element(item).textContent).toContain('Menu session task');expect(element(`${item} .status-pill`)).not.toBeNull();expect(element(item).getAttribute('aria-current')).toBe('false');
    click(item);
    const pane=`.project-terminal [data-terminal-pane="${run.id}"]`;
    await wait(()=>expect(window.document.querySelector(`${pane} [data-agent-console]`)).not.toBeNull());
    expect(element(`${pane} .terminal-pane-title`).textContent).toContain('Menu session task');expect(element(`${pane} .terminal-pane-head .status-pill`)).not.toBeNull();
    expect(JSON.parse(window.localStorage.getItem(`aiws.terminal-sessions.${project.id}`)!)).toEqual([run.id]);
    // The session is open in one place; each side offers to bring it over.
    click(`${pane} [data-open-task]`);
    await wait(()=>expect(window.document.querySelector('#task-panel .session-elsewhere [data-session-to-detail]')).not.toBeNull());
    click('#task-panel [data-session-to-detail]');
    await wait(()=>expect(window.document.querySelector(`${pane} [data-session-to-terminal]`)).not.toBeNull());
    expect(window.document.querySelector('#task-panel .session-elsewhere')).toBeNull();
    click(`${pane} [data-session-to-terminal]`);
    await wait(()=>expect(window.document.querySelector(`${pane} [data-agent-console]`)).not.toBeNull());
    expect(window.document.querySelector(`${pane} .session-elsewhere`)).toBeNull();
    // Closing the pane only hides the session.
    click(`${pane} [data-terminal-close]`);
    expect(window.document.querySelector(pane)).toBeNull();expect(element<HTMLElement>('[data-terminal-empty]').hidden).toBe(false);
    expect(server.service.snapshot().runs.find(value=>value.id===run.id)?.status).toBe('running');
    await server.service.stop(run.id);
  },20000);
  it('lists an AIWS-started run in the live sessions overview and opens it in a pane when its card is clicked', async () => {
    await createProject();click('#overview-nav');click('#overview-tab-sessions');
    expect(element<HTMLElement>('[data-session-overview]').hidden).toBe(false);expect(element('#overview-tab-sessions').getAttribute('aria-selected')).toBe('true');
    expect(element('.session-empty').textContent).toContain('Çalışan oturum yok');
    const project=server.service.snapshot().projects[0]!;
    const task=server.service.createTask({projectId:project.id,title:'AIWS live arrival',provider:'command',terminalMode:'stream',command:{executable:process.execPath,args:['-e','console.log("LIVE_ARRIVAL");setInterval(()=>{},1000)']}});
    const run=server.service.startTask(task.id);
    expect(run.sessionId).toBeUndefined();
    // A new run is listed as a card; it opens only when the user picks it.
    await wait(()=>expect(window.document.querySelector(`[data-session-card="${run.id}"]`)).not.toBeNull());
    expect(element(`[data-session-card="${run.id}"]`).textContent).toContain('AIWS live arrival');
    expect(element('[data-session-filter="running"] strong').textContent).toBe('1');
    expect(element('#sessions-count').textContent).toBe('1');
    expect(window.document.querySelectorAll('.session-terminal [data-terminal-pane]')).toHaveLength(0);
    click(`[data-session-card="${run.id}"]`);
    expect(element('#overview-tab-terminal').getAttribute('aria-selected')).toBe('true');
    expect(window.document.querySelector(`.session-terminal [data-terminal-pane="${run.id}"]`)).not.toBeNull();
    // A stream run has no terminal output, so its pane shows the run's agent console.
    await wait(()=>expect(window.document.querySelector(`[data-terminal-pane="${run.id}"] [data-agent-console]`)).not.toBeNull());
    expect(element<HTMLElement>('.session-terminal [data-terminal-empty]').hidden).toBe(true);

    expect(element(`[data-terminal-pane="${run.id}"] .terminal-pane-title`).textContent).toContain('AIWS live arrival');

    await server.service.stop(run.id);
    // The ended session leaves the list; its pane stays until the user closes it.

    await wait(()=>expect(element<HTMLElement>(`[data-terminal-pane="${run.id}"] .terminal-exit-bar`).hidden).toBe(false));
    click(`[data-terminal-pane="${run.id}"] .terminal-exit-bar [data-terminal-close]`);
    expect(window.document.querySelectorAll('.session-terminal [data-terminal-pane]')).toHaveLength(0);

    // Back on the overview the run is listed among the ones that ended today and opens its task.
    await wait(()=>expect(element<HTMLElement>('.session-terminal [data-terminal-empty]').hidden).toBe(false));click('.session-terminal [data-terminal-empty] [data-overview-tab="sessions"]');
    expect(element<HTMLElement>('[data-session-overview]').hidden).toBe(false);
    await wait(()=>expect(window.document.querySelector(`.session-recent-row[data-open-task="${task.id}"]`)).not.toBeNull());
    click(`.session-recent-row[data-open-task="${task.id}"]`);
    await wait(()=>expect(element('#task-detail-title').textContent).toBe('AIWS live arrival'));
  });
  it('shows twelve sessions as filterable cards, opens chosen ones as panes, and keeps terminals across SSE updates', async () => {
    server.service.updateSettings({maxConcurrent:16});
    for(let index=0;index<12;index++){const workspace=join(directory,`workspace-${index}`);await mkdir(workspace);const project=server.service.createProject({name:`Project ${index}`,repositoryPath:workspace});const task=server.service.createTask({projectId:project.id,title:`Task ${index}`,provider:'command',terminalMode:'stream',command:{executable:process.execPath,args:['-e','console.log("session ready");setInterval(()=>{},1000)']}});server.service.startTask(task.id);}
    await wait(()=>expect(window.document.querySelectorAll('[data-project]')).toHaveLength(12));click('#overview-nav');click('#overview-tab-board');expect(window.document.querySelectorAll('.project-board-group')).toHaveLength(12);expect(window.document.querySelectorAll('.project-status-grid')).toHaveLength(12);
    // The overview shows every session as a card and opens nothing by itself.
    click('#overview-tab-sessions');await wait(()=>expect(window.document.querySelectorAll('[data-session-card]')).toHaveLength(12));
    const panes=()=>[...window.document.querySelectorAll('.session-terminal [data-terminal-pane]')].map(pane=>(pane as HTMLElement).dataset.terminalPane);
    expect(panes()).toHaveLength(0);expect(element('[data-session-filter="all"] strong').textContent).toBe('12');expect(element('[data-session-total]').textContent).toBe('12 aktif oturum');
    typeDraft('[data-session-search]','task 1');expect(window.document.querySelectorAll('[data-session-card]')).toHaveLength(3);
    click('[data-session-filter="needs"]');expect(element('[data-session-filter="needs"]').getAttribute('aria-pressed')).toBe('true');expect(window.document.querySelectorAll('[data-session-card]')).toHaveLength(0);expect(element('.session-filter-empty').textContent).toContain('Aramaya uyan oturum yok');
    click('[data-session-filter="needs"]');expect(element('[data-session-filter="all"]').getAttribute('aria-pressed')).toBe('true');typeDraft('[data-session-search]','');expect(window.document.querySelectorAll('[data-session-card]')).toHaveLength(12);
    const ids=server.service.snapshot().runs.map(run=>run.id);
    click(`[data-session-card="${ids[0]}"]`);expect(panes()).toEqual([ids[0]]);
    click('#overview-tab-sessions');click(`[data-session-card="${ids[1]}"]`);click('#overview-tab-sessions');click(`[data-session-card="${ids[2]}"]`);
    expect(panes()).toHaveLength(3);expect(element('.session-terminal .terminal-grid > .terminal-split')).not.toBeNull();
    await wait(()=>expect(window.document.querySelector(`[data-terminal-pane="${ids[0]}"] [data-agent-console]`)).not.toBeNull());const first=element(`[data-terminal-pane="${ids[0]}"] [data-agent-console]`);
    // Closing a pane only hides the session; it stays running and listed.
    click(`[data-terminal-pane="${ids[2]}"] [data-terminal-close]`);
    expect(panes()).not.toContain(ids[2]);expect(panes()).toHaveLength(2);

    expect(server.service.snapshot().runs.find(run=>run.id===ids[2])?.status).toBe('running');
    server.service.postMessage(server.service.snapshot().tasks[0]!.id,{text:'A state update'});
    await wait(()=>expect(server.service.snapshot().messages).toHaveLength(1));
    expect(panes()).not.toContain(ids[2]);expect(element(`[data-terminal-pane="${ids[0]}"] [data-agent-console]`)).toBe(first);
    // The overview keeps the panes' terminals and marks the open sessions.
    click('#overview-tab-sessions');expect(element(`[data-session-card="${ids[0]}"]`).classList.contains('is-open')).toBe(true);expect(element(`[data-session-card="${ids[2]}"]`).classList.contains('is-open')).toBe(false);
    click('#overview-tab-terminal');expect(element(`[data-terminal-pane="${ids[0]}"] [data-agent-console]`)).toBe(first);
    click('[data-terminal-menu]');expect(window.document.querySelector('[data-terminal-project]')).toBeNull();expect(window.document.querySelectorAll('[data-terminal-open^="session:"]')).toHaveLength(12);expect(element('[data-terminal-open="shell"]')).not.toBeNull();click('[data-terminal-menu]');
    const newWorkspace=join(directory,'new-arrival');await mkdir(newWorkspace);
    const project=server.service.createProject({name:'New arrival',repositoryPath:newWorkspace});
    const added=server.service.createTask({projectId:project.id,title:'New live arrival',provider:'command',command:{executable:process.execPath,args:['-e','setInterval(()=>{},1000)']}});
    const newRun=server.service.startTask(added.id);
    // A new session is listed but opens only when the user picks it.
    click('#overview-tab-sessions');await wait(()=>expect(window.document.querySelector(`[data-session-card="${newRun.id}"]`)).not.toBeNull());click('#overview-tab-terminal');
    expect(panes()).not.toContain(newRun.id);
    click('#overview-tab-sessions');click(`[data-session-card="${newRun.id}"]`);
    expect(panes()).toContain(newRun.id);expect(panes()).toHaveLength(3);

    expect(JSON.parse(window.localStorage.getItem('aiws.session-terminals')!)).toContain(newRun.id);
    expect(window.localStorage.getItem('aiws.session-terminal-layout')).toContain(newRun.id);
    expect(element(`[data-terminal-pane="${ids[0]}"] [data-agent-console]`)).toBe(first);
    click('[data-shortcuts-toggle]');expect(element<HTMLElement>('.session-terminal [data-shortcuts-pop]').hidden).toBe(false);
    await server.service.stop(newRun.id);

    await wait(()=>expect(element<HTMLElement>(`[data-terminal-pane="${newRun.id}"] .terminal-exit-bar`).hidden).toBe(false));
    click('.session-terminal [data-shell-close]');await wait(()=>expect(panes()).toHaveLength(0));

    click('#sidebar-toggle');expect(element('.app-shell').classList.contains('sidebar-collapsed')).toBe(true);
    for(const run of server.service.snapshot().runs.filter(run=>['running','waiting','paused'].includes(run.status)))await server.service.stop(run.id);
  },60000);
  it('detects GitHub repository projects without connecting until one is chosen', async () => {
    server.service.updateSettings({autoSyncSeconds:0});
    vi.spyOn(server.service,'detectRepository').mockResolvedValue({repository:'owner/repo',owner:'owner',ownerType:'user',defaultBranch:'main',projects:[{id:'PVT_test',number:12,title:'Engineering board',url:'https://github.com/users/owner/projects/12',owner:'owner',ownerType:'user',linked:true},{id:'PVT_other',number:12,title:'Other owner board',url:'https://github.com/orgs/other/projects/12',owner:'other',ownerType:'organization',linked:false}],suggestedProject:12});
    const connect=vi.spyOn(server.service,'connectProject').mockImplementation(async(id,options)=>{const value=options as {projectOwner:string;projectOwnerType:'user'|'organization'};return server.service.updateProject(id,{github:{repository:'owner/repo',owner:value.projectOwner,ownerType:value.projectOwnerType,number:12}});});
    click('#create-project');input('#field-name','Detected project');input('#field-repositoryPath',directory);click('#detect-repository');
    await wait(()=>expect(element('#connection-project').textContent).toContain('Engineering board'));
    expect((element('#connection-project') as HTMLSelectElement).value).toBe('');expect((element('#github-enabled') as HTMLInputElement).checked).toBe(false);input('#connection-project','PVT_other');submit('#modal form');
    await wait(()=>expect(connect).toHaveBeenCalledWith(expect.any(String),{importLabels:true,exportLabels:false,projectNumber:12,projectOwner:'other',projectOwnerType:'organization'}));
    expect(server.service.snapshot().projects[0]?.github).toMatchObject({repository:'owner/repo',number:12,owner:'other',ownerType:'organization'});
  });
  it('defaults managed native sessions to public conversation records and opens their actual CLI only from the terminal tab', async () => {
    const family=seedCodexAgentFamily(join(directory,'codex-history'),directory);
    const nodePty=createRequire(import.meta.url).resolve('node-pty');
    const launchPath=join(directory,'windows-launch.mjs');await writeFile(launchPath,ts.transpileModule(await readFile(new URL('../../control-server/windows-launch.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
    const helperSource=(await readFile(new URL('../../control-server/pty-host.ts',import.meta.url),'utf8')).replace("from 'node-pty'",`from '${pathToFileURL(nodePty).href}'`).replace("from './windows-launch.js'",`from '${pathToFileURL(launchPath).href}'`);
    const helperPath=join(directory,'native-pty-host.mjs');await writeFile(helperPath,ts.transpileModule(helperSource,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);vi.stubEnv('AIWS_CONTROL_PTY_HELPER',helperPath);
    const bin=join(directory,'native-default-bin');await mkdir(bin);
    const script=join(bin,'native.cjs');await writeFile(script,'console.log("RAW_NATIVE_DEFAULT");setInterval(()=>{},1000);');
    if(process.platform==='win32')await writeFile(join(bin,'codex.cmd'),'@echo off\r\n"'+process.execPath+'" "'+script+'"\r\n');
    else await writeFile(join(bin,'codex'),'#!/usr/bin/env node\nimport('+JSON.stringify(script)+');\n',{mode:0o755});
    const pathKey=Object.keys(process.env).find(key=>key.toLowerCase()==='path')||'PATH';vi.stubEnv(pathKey,bin+delimiter+(process.env[pathKey]||''));
    await createProject();const project=server.service.snapshot().projects[0]!;
    const task=server.service.createTask({projectId:project.id,title:'Native conversation default',provider:'codex',terminalMode:'pty'});
    const run=server.service.startTask(task.id);server.service.run(run.id).sessionId=family.rootId;
    server.service.postMessage(task.id,{text:'Visible native progress',authorType:'agent'});
    await wait(()=>expect(window.document.querySelector(`[data-open-task="${task.id}"]`)).not.toBeNull());click(`[data-open-task="${task.id}"]`);
    await wait(()=>expect(element('#task-panel .cv-timeline').textContent).toContain('ROOT_PUBLIC_ONLY'));
    expect(element('#task-panel .cv-timeline').textContent).not.toContain('CHILD_PUBLIC_1');
    expect(element<HTMLElement>('.cv-scroll').hidden).toBe(false);expect(element<HTMLElement>('.cv-native-terminal').hidden).toBe(true);
    expect(element<HTMLElement>('.cv-composer').hidden).toBe(false);
    const root=element('[data-agent-console]');input('#task-message-input','Preserve native draft');
    click('[data-detail-tab="terminal"]');expect(element<HTMLElement>('.cv-scroll').hidden).toBe(true);
    await wait(()=>expect(element('.cv-terminal-host').textContent).toContain('RAW_NATIVE_DEFAULT'));
    click('[data-detail-tab="console"]');expect(element('[data-agent-console]')).toBe(root);expect(element<HTMLTextAreaElement>('#task-message-input').value).toBe('Preserve native draft');
    click('[data-detail-tab="terminal"]');click('#close-panel');click(`[data-open-task="${task.id}"]`);
    expect(element('[data-detail-tab="console"]').getAttribute('aria-selected')).toBe('true');
    await server.service.stop(run.id);
  },15000);
  it('keeps a compact per-script argument history and restores the latest value, including an empty run', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;
    server.service.updateProject(project.id,{runScripts:[{name:'Deploy',command:'deploy',askArgs:true}]});
    await wait(()=>expect(element<HTMLElement>('#run-control').hidden).toBe(false));
    const script=server.service.snapshot().projects[0]!.runScripts![0]!;
    server.service.runScriptMemory.save(project.id,script.id,['--latest','--previous','--third','--fourth','--fifth']);
    click('#run-script-button');await wait(()=>expect(element<HTMLTextAreaElement>('#run-args-input').value).toBe('--latest'));expect(element<HTMLElement>('#run-args-popover').hidden).toBe(false);
    const args=element<HTMLTextAreaElement>('#run-args-input');args.value='';args.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}));
    expect(element<HTMLElement>('#run-args-history').hidden).toBe(false);expect(window.document.querySelectorAll('#run-args-history [data-run-args-history]')).toHaveLength(5);
    click('#run-args-history [data-run-args-history="1"]');expect(args.value).toBe('--previous');
    args.value='--new';submit('#run-args-form');
    await wait(()=>expect(server.service.runScriptMemory.history(project.id,script.id)).toEqual(['--new','--latest','--previous','--third','--fourth']));
    args.value='';submit('#run-args-form');
    await wait(()=>expect(server.service.runScriptMemory.history(project.id,script.id)[0]).toBe(''));
    click('#run-script-button');await wait(()=>expect(element<HTMLElement>('#run-args-popover').hidden).toBe(false));expect(element<HTMLTextAreaElement>('#run-args-input').value).toBe('');
  });
  it('removes script argument history without selecting or running it and keeps repeated runs distinct', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;
    server.service.updateProject(project.id,{runScripts:[{name:'Deploy',command:'deploy',askArgs:true}]});
    await wait(()=>expect(element<HTMLElement>('#run-control').hidden).toBe(false));
    const script=server.service.snapshot().projects[0]!.runScripts![0]!;
    server.service.runScriptMemory.save(project.id,script.id,['--latest','--previous']);
    click('#run-script-button');await wait(()=>expect(element<HTMLTextAreaElement>('#run-args-input').value).toBe('--latest'));
    input('#run-args-input','unsent draft');
    click('[data-remove-run-args-history="0"]');
    await wait(()=>expect(window.document.querySelectorAll('[data-run-args-history]')).toHaveLength(1));
    expect(server.service.runScriptMemory.history(project.id,script.id)).toEqual(['--previous']);
    expect(element<HTMLTextAreaElement>('#run-args-input').value).toBe('unsent draft');
    expect(element<HTMLElement>('#run-args-popover').hidden).toBe(false);
    expect(server.service.projectTerminals.list(project.id)).toHaveLength(0);
    element('#run-args-input').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    click('#run-script-button');await wait(()=>expect(element<HTMLTextAreaElement>('#run-args-input').value).toBe('--previous'));
    submit('#run-args-form');
    await wait(()=>expect(element<HTMLElement>('#run-args-popover').hidden).toBe(true));
    click('#run-script-button');await wait(()=>expect(element<HTMLElement>('#run-args-popover').hidden).toBe(false));
    expect(window.document.querySelectorAll('[data-run-args-history]')).toHaveLength(1);
    click('[data-remove-run-args-history="0"]');
    await wait(()=>expect(element<HTMLElement>('#run-args-history').hidden).toBe(true));
    expect(server.service.runScriptMemory.history(project.id,script.id)).toEqual([]);
    expect(element<HTMLElement>('#run-args-history-hint').hidden).toBe(true);
    expect(window.document.activeElement).toBe(element('#run-args-input'));
  });
  it('scans PowerShell parameters and stores run history as named values', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!,file=join(directory,'deploy.ps1');
    await writeFile(file,`param(
      # Ad çözülmezse güncel sunucu IP'sini -Ip ile verin.
      [Alias('Ip')]
      [string]$ServerHost = 'build-host',
      [string]$ServerUser = 'deploy',
      [string]$KeyPath = 'D:\\keys\\deploy-ed25519',
      [string]$RemoteDir = '/home/deploy/services/demo-app',
      [string[]]$Only = @(),
      [switch]$PreflightOnly,
      [switch]$ResetTestDatabase
    )
    Write-Output $ServerHost`);
    server.service.updateProject(project.id,{runScripts:[{name:'Deploy',path:'deploy.ps1',askArgs:true}]});
    await wait(()=>expect(element<HTMLElement>('#run-control').hidden).toBe(false));const script=server.service.snapshot().projects[0]!.runScripts![0]!;
    click('#run-script-button');await wait(()=>expect(element<HTMLElement>('#run-args-popover').hidden).toBe(false));await wait(()=>expect(element<HTMLElement>('#run-args-fields').hidden).toBe(false));
    expect(window.document.querySelectorAll('#run-args-fields [data-run-args-name]')).toHaveLength(7);
    const value=element<HTMLInputElement>('#run-args-fields [data-run-args-name="Ip"]');
    expect(value.value).toBe('build-host');
    expect(element<HTMLInputElement>('#run-args-fields [data-run-args-name="ServerUser"]').value).toBe('deploy');
    expect(element<HTMLInputElement>('#run-args-fields [data-run-args-name="KeyPath"]').value).toBe('D:\\keys\\deploy-ed25519');
    expect(element<HTMLInputElement>('#run-args-fields [data-run-args-name="RemoteDir"]').value).toBe('/home/deploy/services/demo-app');
    expect(element<HTMLInputElement>('#run-args-fields [data-run-args-name="Only"]').placeholder).toBe('@()');
    expect(element<HTMLInputElement>('#run-args-fields [data-run-args-name="PreflightOnly"]').checked).toBe(false);
    expect(element<HTMLInputElement>('#run-args-fields [data-run-args-name="ResetTestDatabase"]').checked).toBe(false);
    value.value='10.0.0.5';submit('#run-args-form');
    const expected={Ip:'10.0.0.5',ServerUser:'deploy',KeyPath:'D:\\keys\\deploy-ed25519',RemoteDir:'/home/deploy/services/demo-app',Only:'',PreflightOnly:false,ResetTestDatabase:false};
    await wait(()=>expect(server.service.runScriptMemory.history(project.id,script.id)[0]).toEqual(expected));
    await wait(()=>expect(server.service.projectTerminals.list(project.id).some(run=>run.scriptArgs==='-Ip 10.0.0.5 -ServerUser deploy -KeyPath D:\\keys\\deploy-ed25519 -RemoteDir /home/deploy/services/demo-app')).toBe(true));
    click('#run-script-button');await wait(()=>expect(element<HTMLElement>('#run-args-popover').hidden).toBe(false));await wait(()=>expect(element<HTMLElement>('#run-args-fields').hidden).toBe(false));
    expect(value.value).toBe('10.0.0.5');
    submit('#run-args-form');
    await wait(()=>expect(element<HTMLElement>('#run-args-popover').hidden).toBe(true));
    click('#run-script-button');await wait(()=>expect(element<HTMLElement>('#run-args-popover').hidden).toBe(false));await wait(()=>expect(element<HTMLElement>('#run-args-fields').hidden).toBe(false));
    expect(window.document.querySelectorAll('[data-run-args-history]')).toHaveLength(1);
    expect(server.service.runScriptMemory.history(project.id,script.id)).toEqual([expected]);
    click('[data-remove-run-args-history="0"]');
    await wait(()=>expect(element<HTMLElement>('#run-args-history').hidden).toBe(true));
    expect(server.service.runScriptMemory.history(project.id,script.id)).toEqual([]);
    expect(element<HTMLInputElement>('#run-args-fields [data-run-args-name="Ip"]').value).toBe('10.0.0.5');
  },20000);
  it('runs the selected project script from the header Run button in a terminal tab', async () => {
    class Probe { options={disableStdin:false}; target:HTMLElement|null=null; loadAddon(){} open(target:HTMLElement){this.target=target;} write(value:string){if(this.target)this.target.textContent=(this.target.textContent||'')+value;} reset(){} onData(){} onResize(){} dispose(){} focus(){} }
    (window as unknown as {Terminal:unknown}).Terminal=Probe;
    await usePtyHelper();
    const file=process.platform==='win32'?'build.ps1':'build.sh';await writeFile(join(directory,file),process.platform==='win32'?'Write-Output "RUN_SCRIPT_OK"':'echo RUN_SCRIPT_OK');
    await createProject();const project=server.service.snapshot().projects[0]!;
    expect(element<HTMLElement>('#run-control').hidden).toBe(true);
    server.service.updateProject(project.id,{runScripts:[{name:'Build',path:file}]});
    await wait(()=>expect(element<HTMLElement>('#run-control').hidden).toBe(false));
    // A single script is one button that names and runs it; a picker appears once there are more.
    expect(element<HTMLSelectElement>('#run-script-select').hidden).toBe(true);expect(element('#run-script-button').textContent).toBe("Run 'Build'");expect(element('#run-control').classList.contains('single')).toBe(true);
    server.service.updateProject(project.id,{runScripts:[{name:'Build',path:file},{name:'Lint',command:'echo lint'}]});
    await wait(()=>expect(element<HTMLSelectElement>('#run-script-select').hidden).toBe(false));
    expect(element('#run-script-select').textContent).toContain('Build');expect(element('#run-script-button').textContent).toBe('Run');expect(element('#run-control').classList.contains('single')).toBe(false);
    server.service.updateProject(project.id,{runScripts:[{name:'Build',path:file}]});
    await wait(()=>expect(element<HTMLSelectElement>('#run-script-select').hidden).toBe(true));
    click('#run-script-button');
    await wait(()=>expect(server.service.projectTerminals.list(project.id)).toHaveLength(1));
    expect(server.service.projectTerminals.list(project.id)[0]).toMatchObject({terminalKind:'script',title:'Build'});
    expect(element('#project-tab-terminal').getAttribute('aria-selected')).toBe('true');
    await wait(()=>expect(server.service.projectTerminals.get(project.id,server.service.projectTerminals.list(project.id)[0]!.id).run.terminalOutput).toContain('RUN_SCRIPT_OK'));
    const terminal=server.service.projectTerminals.list(project.id)[0]!,terminalView=element(`[data-terminal-pane="${terminal.id}"] .terminal-instance`);
    expect(element(`[data-terminal-pane="${terminal.id}"] .terminal-pane-head`).lastElementChild).toBe(element(`[data-terminal-pane="${terminal.id}"] [data-terminal-close]`));
    click(`[data-terminal-pane="${terminal.id}"] [data-terminal-restart]`);
    await wait(()=>expect(server.service.projectTerminals.get(project.id,terminal.id).run.terminalOutput!.split('RUN_SCRIPT_OK').length).toBe(3));
    expect(element(`[data-terminal-pane="${terminal.id}"] .terminal-instance`)).toBe(terminalView);
    await wait(()=>expect(terminalView.textContent!.split('RUN_SCRIPT_OK').length).toBeGreaterThan(2));
  },20000);
  it('adds, edits and removes run scripts, including custom commands, from a modal in project settings', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;
    click('#project-tab-settings');click('#settings-tab-execution');click('#settings-subtab-project-execution-scripts');expect(element('.run-scripts-empty').textContent).toContain('Henüz run scripti yok');
    click('#settings-add-run-script');expect(element('#modal').hasAttribute('open')).toBe(true);expect(element('#modal-title').textContent).toBe('Run scripti ekle');
    expect(element('#run-script-args').tagName).toBe('TEXTAREA');expect(element('[data-kind-panel="command"]').hidden).toBe(true);
    const custom=element<HTMLInputElement>('input[name="kind"][value="command"]');custom.checked=true;custom.dispatchEvent(new window.Event('change',{bubbles:true}));
    expect(element('[data-kind-panel="command"]').hidden).toBe(false);expect(element('[data-kind-panel="file"]').hidden).toBe(true);
    input('#run-script-name','Do something');input('#run-script-command','myapp dosomething');input('#run-script-args','--port 3000\n--verbose');element('#run-script-args').dispatchEvent(new window.Event('input',{bubbles:true}));
    expect(element('#run-script-preview').textContent).toBe('myapp dosomething --port 3000 --verbose');
    submit('#modal form');
    await wait(()=>expect(server.service.snapshot().projects[0]?.runScripts).toEqual([{id:expect.any(String),name:'Do something',command:'myapp dosomething',args:'--port 3000\n--verbose'}]));
    await wait(()=>expect(element('.run-script-card').textContent).toContain('myapp dosomething --port 3000 --verbose'));
    expect(element('#modal').hasAttribute('open')).toBe(false);
    click('[data-edit-run-script]');expect(element('#modal-title').textContent).toBe('Run scriptini düzenle');expect(element<HTMLInputElement>('#run-script-command').value).toBe('myapp dosomething');
    input('#run-script-name','Renamed');submit('#modal form');
    await wait(()=>expect(server.service.snapshot().projects[0]?.runScripts?.[0]?.name).toBe('Renamed'));
    expect(server.service.snapshot().projects[0]?.runScripts).toHaveLength(1);
    await wait(()=>expect(element('#run-script-button').textContent).toBe("Run 'Renamed'"));
    await wait(()=>expect(element('.run-script-card').textContent).toContain('Renamed'));click('[data-remove-run-script]');
    await wait(()=>expect(server.service.snapshot().projects.find(item=>item.id===project.id)?.runScripts).toEqual([]));
  },15000);
  it('opens a project shell, sends input, preserves it across tabs, and isolates and closes terminals', async () => {
    await loadFloatingConsoleStyles();
    let onInput!: (value:string)=>void, onResize!: (size:{cols:number;rows:number})=>void;
    let opens=0;
    class ShellProbe {
      target:HTMLElement|null=null;
      options={disableStdin:false};
      open(target:HTMLElement){this.target=target;opens++;}
      write(value:string){if(this.target)this.target.textContent=(this.target.textContent||'')+value;}
      reset(){if(this.target)this.target.textContent='';}
      onData(callback:typeof onInput){onInput=callback;}
      onResize(callback:typeof onResize){onResize=callback;}
      dispose(){} focus(){}
    }
    (window as unknown as {Terminal:unknown}).Terminal=ShellProbe;
    await usePtyHelper();
    await createProject();click('#project-tab-terminal');
    expect(element('#project-tab-terminal').getAttribute('aria-selected')).toBe('true');
    expect(element<HTMLElement>('#board-toolbar').hidden).toBe(true);
    expect(server.service.snapshot().runs).toHaveLength(0);
    click('[data-terminal-menu]');click('[data-terminal-open="shell"]');
    const project=server.service.snapshot().projects[0]!;
    await wait(()=>expect(server.service.projectTerminals.list(project.id)).toHaveLength(1));
    await wait(()=>expect(element('.project-shell-host .terminal-instance')).toBeTruthy());
    const run=server.service.projectTerminals.list(project.id)[0]!;
    const instance=element('.project-shell-host .terminal-instance');
    click('[data-terminal-float]');const floating=element('.floating-console');
    expect(floating.contains(instance)).toBe(true);click('#project-tab-board');
    expect(instance.isConnected).toBe(true);click('#project-tab-terminal');
    expect(floating.contains(instance)).toBe(true);click('[data-float="minimize"]');
    expect(element('.floating-console-body').hidden).toBe(true);click('[data-float="restore"]');


    expect(run.workspacePath).toBe(directory);
    const command=process.platform==='win32'?"Write-Output ('PROJECT_' + 'SHELL_OK'); (Get-Location).Path\r":"printf 'PROJECT_%s\\n' SHELL_OK; pwd\r";
    onInput(command);onResize({cols:120,rows:35});
    await wait(()=>expect(server.service.projectTerminals.get(project.id,run.id).run.terminalOutput).toContain('PROJECT_SHELL_OK'));
    await wait(()=>expect(element('.project-shell-host').textContent).toContain('PROJECT_SHELL_OK'));
    expect(element('.project-shell-host').textContent).toContain(directory);
    expect(floating.contains(instance)).toBe(true);click('[data-float="dock"]');expect(element('.project-shell-host .terminal-instance')).toBe(instance);
    expect(server.service.projectTerminals.get(project.id,run.id).run).toMatchObject({cols:120,rows:35});
    click('#project-tab-board');click('#project-tab-sessions');click('#project-tab-terminal');
    expect(element('.project-shell-host .terminal-instance')).toBe(instance);expect(opens).toBe(1);
    expect(server.service.snapshot().tasks).toHaveLength(0);expect(server.service.snapshot().runs).toHaveLength(0);
    const other=server.service.createProject({name:'Other project',repositoryPath:directory});
    const path=`/api/projects/${other.id}/terminals/${run.id}`;
    expect((await fetch(server.url+path)).status).toBe(404);
    expect((await fetch(server.url+path+'/input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:'bad'})})).status).toBe(404);
    const invalid=await fetch(`${server.url}/api/projects/${project.id}/terminals/${run.id}/resize`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cols:0,rows:30})});expect(invalid.status).toBe(400);
    await closeWindow(window, pageIdle);
    await mountRenderer({['aiws.project-tab.'+project.id]:'terminal'});
    await wait(()=>expect(element('.project-shell-host').textContent).toContain('PROJECT_SHELL_OK'));
    expect(server.service.projectTerminals.list(project.id)).toHaveLength(1);
    (window as unknown as {Terminal:unknown}).Terminal=ShellProbe;
    click('[data-shell-close]');await wait(()=>expect(element('#modal').textContent).toContain('Tüm terminaller kapatılsın mı?'));click('#modal [data-action="close-modal"]');await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));expect(server.service.projectTerminals.list(project.id)).toHaveLength(1);click('[data-shell-close]');await confirmDialog();await wait(()=>expect(server.service.projectTerminals.list(project.id)).toHaveLength(0));
    await wait(()=>expect(window.document.querySelector('.project-shell-host .terminal-instance')).toBeNull());
    click('[data-terminal-menu]');click('[data-terminal-open="shell"]');await wait(()=>expect(server.service.projectTerminals.list(project.id)).toHaveLength(1));
    await wait(()=>expect(element('.project-shell-host .terminal-instance')).toBeTruthy());
    const exitRun=server.service.projectTerminals.list(project.id)[0]!;onInput('exit\r');
    await wait(()=>expect(server.service.projectTerminals.get(project.id,exitRun.id).run.status).toBe('completed'));
    await wait(()=>expect(element('[data-shell-status]').textContent).toContain('Çıkış kodu: 0'));
  },30000);

  it('shows a project terminal in All projects only when picked from the + menu and hides it there without touching its project', async () => {
    class PaneProbe {
      target:HTMLElement|null=null;options={disableStdin:false};
      open(target:HTMLElement){this.target=target;}
      write(value:string){if(this.target)this.target.textContent=(this.target.textContent||'')+value;}
      reset(){if(this.target)this.target.textContent='';}
      onData(){} onResize(){} dispose(){} focus(){}
    }
    (window as unknown as {Terminal:unknown}).Terminal=PaneProbe;
    await usePtyHelper();
    await createProject();const project=server.service.snapshot().projects[0]!;click('#project-tab-terminal');
    click('[data-terminal-menu]');click('[data-terminal-open="shell"]');
    await wait(()=>expect(server.service.projectTerminals.list(project.id)).toHaveLength(1));
    const run=server.service.projectTerminals.list(project.id)[0]!;
    await wait(()=>expect(element(`.project-terminal:not(.session-terminal) [data-terminal-pane="${run.id}"] .terminal-instance`)).toBeTruthy());
    const projectInstance=element(`.project-terminal:not(.session-terminal) [data-terminal-pane="${run.id}"] .terminal-instance`);
    // All projects loads no terminal by itself.
    click('#overview-nav');click('#overview-tab-terminal');
    const panes=()=>[...window.document.querySelectorAll('.session-terminal [data-terminal-pane]')].map(pane=>(pane as HTMLElement).dataset.terminalPane);
    await wait(()=>expect(element<HTMLElement>('.session-terminal [data-terminal-empty]').hidden).toBe(false));
    expect(panes()).toHaveLength(0);
    // The + menu offers the project's terminal; picking it shows it in a pane.
    click('.session-terminal [data-terminal-menu]');
    const item=element(`.session-terminal [data-terminal-open="terminal:${run.id}"]`);expect(item.getAttribute('aria-current')).toBe('false');expect(item.textContent).toContain('Renderer QA');
    click(`.session-terminal [data-terminal-open="terminal:${run.id}"]`);
    expect(panes()).toEqual([run.id]);expect(JSON.parse(window.localStorage.getItem('aiws.session-terminals-shown')!)).toEqual([run.id]);
    await wait(()=>expect(element(`.session-terminal [data-terminal-pane="${run.id}"] .terminal-instance`)).toBeTruthy());
    // Hiding the pane leaves the terminal running and offers it again in the menu.
    click(`.session-terminal [data-terminal-pane="${run.id}"] [data-terminal-hide]`);
    expect(panes()).toHaveLength(0);expect(window.document.querySelector('#modal[open]')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem('aiws.session-terminals-shown')!)).toEqual([]);
    expect(server.service.projectTerminals.list(project.id)).toHaveLength(1);expect(server.service.projectTerminals.get(project.id,run.id).run.status).toBe('running');
    click('.session-terminal [data-terminal-menu]');expect(element(`.session-terminal [data-terminal-open="terminal:${run.id}"]`).getAttribute('aria-current')).toBe('false');click('.session-terminal [data-terminal-menu]');
    // The project's own workspace keeps its pane and terminal view.
    click(`[data-project="${project.id}"]`);click('#project-tab-terminal');
    expect(element(`.project-terminal:not(.session-terminal) [data-terminal-pane="${run.id}"] .terminal-instance`)).toBe(projectInstance);
    // A reload keeps it hidden in All projects.
    await closeWindow(window, pageIdle);await mountRenderer();
    click('#overview-nav');click('#overview-tab-terminal');
    await wait(()=>expect(element<HTMLElement>('.session-terminal [data-terminal-empty]').hidden).toBe(false));expect(panes()).toHaveLength(0);
    await server.service.projectTerminals.remove(project.id,run.id);
  },30000);

  it('opens shells and agent CLIs as grid panes, shows exits, restarts, renames, docks panes by dragging their headers and closes them', async () => {
    const inputs=new Map<HTMLElement,(value:string)=>void>();
    class TabProbe {
      target:HTMLElement|null=null;options={disableStdin:false};
      open(target:HTMLElement){this.target=target;}
      write(value:string){if(this.target)this.target.textContent=(this.target.textContent||'')+value;}
      reset(){if(this.target)this.target.textContent='';}
      onData(callback:(value:string)=>void){queueMicrotask(()=>{if(this.target)inputs.set(this.target.closest('[data-terminal-pane]') as HTMLElement,callback);});}
      onResize(){} dispose(){} focus(){}
    }
    (window as unknown as {Terminal:unknown}).Terminal=TabProbe;
    await usePtyHelper();
    const bin=join(directory,'agent-bin');await mkdir(bin);const script=join(bin,'agent.cjs');
    await writeFile(script,'process.stdin.setRawMode(true);process.stdout.write("CODEX_TUI_READY\\r\\n");process.stdin.on("data",d=>{if(d.toString().includes("q"))process.exit(4);process.stdout.write("HEARD:"+d.toString().trim()+"\\r\\n");});');
    if(process.platform==='win32')await writeFile(join(bin,'codex.cmd'),'@echo off\r\n"'+process.execPath+'" "'+script+'"\r\n');
    else await writeFile(join(bin,'codex'),'#!/bin/sh\nexec "'+process.execPath+'" "'+script+'"\n',{mode:0o755});
    const pathKey=Object.keys(process.env).find(key=>key.toLowerCase()==='path')||'PATH';vi.stubEnv(pathKey,bin+delimiter+(process.env[pathKey]||''));
    await server.service.projectTerminals.agents(true);
    await createProject();const project=server.service.snapshot().projects[0]!;click('#project-tab-terminal');
    await wait(()=>expect(element('[data-terminal-empty]').hidden).toBe(false));
    await wait(()=>expect(element('[data-terminal-empty] [data-terminal-open="agent:codex"]')).toBeTruthy());
    expect(window.document.querySelector('[data-terminal-tabs]')).toBeNull();expect(window.document.querySelector('[data-terminal-split]')).toBeNull();
    click('[data-terminal-empty] [data-terminal-open="shell"]');
    await wait(()=>expect(window.document.querySelectorAll('[data-terminal-title]')).toHaveLength(1));
    expect(element<HTMLElement>('[data-terminal-empty]').hidden).toBe(true);
    // The + menu lists the shell and the agent CLIs found on PATH.
    click('[data-terminal-menu]');expect(element<HTMLElement>('[data-terminal-menu-list]').hidden).toBe(false);expect(element('[data-terminal-menu]').getAttribute('aria-expanded')).toBe('true');
    expect(window.document.querySelectorAll('[data-terminal-menu-list] [role="menuitem"]').length).toBeGreaterThanOrEqual(3);
    click('[data-terminal-menu-list] [data-terminal-open="agent:codex"]');
    expect(element<HTMLElement>('[data-terminal-menu-list]').hidden).toBe(true);
    await wait(()=>expect(server.service.projectTerminals.list(project.id)).toHaveLength(2));
    const [shell,agent]=server.service.projectTerminals.list(project.id) as Array<{id:string;terminalKind:string;provider:string;title:string}>;
    expect(agent).toMatchObject({terminalKind:'agent',provider:'codex',title:'Codex'});expect(shell).toMatchObject({terminalKind:'shell'});
    await wait(()=>expect(element(`[data-terminal-title="${agent!.id}"]`).getAttribute('aria-current')).toBe('true'));
    expect(element(`[data-terminal-title="${agent!.id}"]`).textContent).toContain('Codex');
    // A running agent CLI can turn its conversation into a task; a shell cannot.
    expect(element(`[data-terminal-pane="${agent!.id}"] [data-terminal-task]`)).toBeTruthy();expect(window.document.querySelector(`[data-terminal-pane="${shell!.id}"] [data-terminal-task]`)).toBeNull();expect(element(`[data-terminal-title="${agent!.id}"] .terminal-icon img`)).toBeTruthy();
    await wait(()=>expect(element(`[data-terminal-pane="${agent!.id}"]`).textContent).toContain('CODEX_TUI_READY'));
    // A running terminal needs no status line; only loading, errors and exits are reported there.
    expect(element('[data-shell-status]').textContent).toBe('');
    // Every terminal is shown: the new one opens to the right of the focused one.
    expect(element<HTMLElement>(`[data-terminal-pane="${shell!.id}"]`).hidden).toBe(false);expect(element<HTMLElement>(`[data-terminal-pane="${agent!.id}"]`).hidden).toBe(false);
    expect([...element('[data-terminal-grid] > .terminal-split-row').children].map(child=>(child as HTMLElement).dataset.terminalPane||child.className)).toEqual([shell!.id,'terminal-resizer',agent!.id]);
    // Talk to the agent, then let it exit: the tab and pane show the exit code and offer a restart.
    const agentPane=element(`[data-terminal-pane="${agent!.id}"]`);await wait(()=>expect(inputs.get(agentPane)).toBeTruthy());
    inputs.get(agentPane)!('hello\r');await wait(()=>expect(agentPane.textContent).toContain('HEARD:hello'));
    inputs.get(agentPane)!('q');
    await wait(()=>expect(element<HTMLElement>(`[data-terminal-pane="${agent!.id}"] .terminal-exit-bar`).hidden).toBe(false));
    expect(element(`[data-terminal-pane="${agent!.id}"] .terminal-exit-bar`).textContent).toContain('Çıkış kodu: 4');
    expect(element(`[data-terminal-title="${agent!.id}"] .terminal-dot`).classList.contains('failed')).toBe(true);
    click(`[data-terminal-pane="${agent!.id}"] [data-terminal-restart]`);
    await wait(()=>expect(server.service.projectTerminals.get(project.id,agent!.id).run.status).toBe('running'));
    await wait(()=>expect(element<HTMLElement>(`[data-terminal-pane="${agent!.id}"] .terminal-exit-bar`).hidden).toBe(true));
    await wait(()=>expect(agentPane.textContent!.split('CODEX_TUI_READY').length).toBe(3));
    // Rename inline with F2-style editing.
    element(`[data-terminal-title="${agent!.id}"]`).dispatchEvent(new window.MouseEvent('dblclick',{bubbles:true}) as unknown as Event);
    const rename=element<HTMLInputElement>('.terminal-rename');rename.value='Reviewer';rename.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}) as unknown as Event);
    await wait(()=>expect(server.service.projectTerminals.get(project.id,agent!.id).run.title).toBe('Reviewer'));
    await wait(()=>expect(element(`[data-terminal-title="${agent!.id}"]`).textContent).toContain('Reviewer'));
    // Keyboard: Ctrl+PageUp moves to the previous terminal.
    window.document.body.dispatchEvent(new window.KeyboardEvent('keydown',{key:'PageUp',ctrlKey:true,bubbles:true,cancelable:true}) as unknown as Event);
    await wait(()=>expect(element(`[data-terminal-title="${shell!.id}"]`).getAttribute('aria-current')).toBe('true'));
    expect(element(`[data-terminal-pane="${shell!.id}"]`).classList.contains('focused')).toBe(true);expect(element(`[data-terminal-pane="${agent!.id}"]`).classList.contains('focused')).toBe(false);
    // Dragging the agent's header onto the lower half of the shell docks it below the shell.
    const stage=element('[data-terminal-stage]'),shellPane=element(`[data-terminal-pane="${shell!.id}"]`),agentHead=element(`[data-terminal-pane="${agent!.id}"] .terminal-pane-head`);
    const box=(left:number,top:number,width:number,height:number)=>()=>({left,top,width,height,right:left+width,bottom:top+height,x:left,y:top,toJSON(){}}) as DOMRect;
    stage.getBoundingClientRect=box(0,0,1000,600);shellPane.getBoundingClientRect=box(0,0,500,600);
    const elementFromPoint=vi.spyOn(window.document,'elementFromPoint').mockImplementation(((x:number)=>x<500?shellPane.querySelector('.terminal-host'):agentHead) as never);
    const drag=(type:string,clientX:number,clientY:number)=>agentHead.dispatchEvent(new window.PointerEvent(type,{pointerId:3,button:0,clientX,clientY,bubbles:true,cancelable:true}) as unknown as Event);
    drag('pointerdown',750,14);drag('pointermove',600,200);drag('pointermove',250,520);
    expect(element<HTMLElement>('[data-terminal-drop]').hidden).toBe(false);expect(element('[data-terminal-drop]').getAttribute('data-side')).toBe('bottom');
    expect(element<HTMLElement>('[data-terminal-drop]').style.transform).toContain('300px');expect(stage.classList.contains('dragging')).toBe(true);
    drag('pointerup',250,520);elementFromPoint.mockRestore();
    expect(element<HTMLElement>('[data-terminal-drop]').hidden).toBe(true);expect(stage.classList.contains('dragging')).toBe(false);
    expect([...element('[data-terminal-grid] > .terminal-split-column').children].map(child=>(child as HTMLElement).dataset.terminalPane||child.className)).toEqual([shell!.id,'terminal-resizer',agent!.id]);
    expect(element(`[data-terminal-title="${agent!.id}"]`).getAttribute('aria-current')).toBe('true');
    expect(JSON.parse(window.localStorage.getItem('aiws.terminal-layout.'+project.id)!)).toMatchObject({dir:'column',children:[{id:shell!.id},{id:agent!.id}]});
    // Escape cancels a drag without moving anything.
    drag('pointerdown',750,14);drag('pointermove',600,200);window.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}) as unknown as Event);drag('pointerup',600,200);
    expect(element('[data-terminal-grid] > .terminal-split').classList.contains('terminal-split-column')).toBe(true);
    // Closing a pane removes it at once and ends the agent's process.
    click(`[data-terminal-pane="${agent!.id}"] .terminal-pane-head [data-terminal-close]`);await confirmDialog();
    await wait(()=>expect(window.document.querySelector(`[data-terminal-pane="${agent!.id}"]`)).toBeNull());expect(window.document.querySelector('[data-terminal-grid] .terminal-split')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem('aiws.terminal-layout.'+project.id)!)).toEqual({id:shell!.id});
    await wait(()=>expect(server.service.projectTerminals.list(project.id)).toHaveLength(1));
    click('[data-shell-close]');await confirmDialog();await wait(()=>expect(server.service.projectTerminals.list(project.id)).toHaveLength(0));
    await wait(()=>expect(element<HTMLElement>('[data-terminal-empty]').hidden).toBe(false));
    expect(server.service.snapshot().tasks).toHaveLength(0);expect(server.service.snapshot().runs).toHaveLength(0);
  },40000);
  it('renders actual PTY output, accepts raw terminal input, and explicitly completes through the task UI', async () => {
    let onInput!: (value:string)=>void,onResize!: (size:{cols:number;rows:number})=>void,onTerminalScroll=()=>{},onWriteParsed=()=>{},opens=0,fits=0;const activeBuffer={viewportY:0,baseY:0};
    class TerminalProbe{target:HTMLElement|null=null;buffer={active:activeBuffer};constructor(readonly options:unknown){}open(target:HTMLElement){this.target=target;opens++;}write(value:string){if(this.target)this.target.textContent=(this.target.textContent||'')+value;queueMicrotask(()=>onWriteParsed());}reset(){if(this.target)this.target.textContent='';}onData(callback:(value:string)=>void){onInput=callback;}onResize(callback:(size:{cols:number;rows:number})=>void){onResize=callback;}onScroll(callback:()=>void){onTerminalScroll=callback;return {dispose(){}};}onWriteParsed(callback:()=>void){onWriteParsed=callback;return {dispose(){}};}scrollToBottom(){activeBuffer.viewportY=activeBuffer.baseY;onTerminalScroll();}dispose(){}focus(){}}
    (window as unknown as {Terminal:unknown}).Terminal=TerminalProbe;
    (window as unknown as {FitAddon:unknown}).FitAddon={FitAddon:class{fit(){fits++;}}};
    (TerminalProbe.prototype as unknown as {loadAddon:()=>void}).loadAddon=()=>{};
    await usePtyHelper();
    const agent=server.service.catalog.createAgent({name:'Interactive profile',provider:'command',terminalMode:'pty',command:{executable:process.execPath,args:['-e','process.stdin.setRawMode(true);console.log("PTY_READY");process.stdin.on("data",d=>{if(d.toString().includes("unique-input-42"))console.log("PTY_ACK_42")});setInterval(()=>{},1000)']}});
    await createProject();click('#create-task');input('#field-title','Interactive terminal fixture');input('#field-agentId',agent.id);element('#field-agentId').dispatchEvent(new window.Event('change',{bubbles:true}) as unknown as Event);
    submit('#modal form');
    await wait(()=>expect(server.service.snapshot().tasks).toHaveLength(1));const task=server.service.snapshot().tasks[0]!;
    expect(task.terminalMode).toBeUndefined();await wait(()=>expect(element('#modal').hasAttribute('open')).toBe(false));click(`[data-open-task="${task.id}"]`);server.service.startTask(server.service.snapshot().tasks[0]!.id);
    await wait(()=>expect(server.service.terminal(server.service.snapshot().runs[0]?.id??'missing').output).toContain('PTY_READY'));
    await wait(()=>expect(window.document.querySelector(`[data-open-task="${task.id}"]`)).not.toBeNull());click(`[data-open-task="${task.id}"]`);expect(element('[data-detail-tab="console"]').getAttribute('aria-selected')).toBe('true');await consoleMounted();expect(element<HTMLElement>('.cv-scroll').hidden).toBe(false);expect(element<HTMLElement>('.cv-native-terminal').hidden).toBe(true);click('[data-detail-tab="terminal"]');
    await wait(()=>expect(element('.cv-terminal-host').textContent).toContain('PTY_READY'));
    const run=server.service.snapshot().runs[0]!;
    const terminalInstance=element('.cv-terminal-host .terminal-instance');expect(opens).toBe(1);activeBuffer.baseY=40;activeBuffer.viewportY=5;onTerminalScroll();expect(element('.cv-unread').textContent).toBe('En alta in ↓');onInput('unique-input-42\r');onResize({cols:120,rows:35});await wait(()=>expect(server.service.terminal(run.id)).toMatchObject({cols:120,rows:35,interactive:true}));
    await wait(()=>expect(element('.cv-terminal-host').textContent).toContain('PTY_ACK_42'));
    await wait(()=>expect(element('.cv-unread').textContent).toMatch(/Yeni işlemler/));expect(activeBuffer.viewportY).toBe(5);click('.cv-unread');expect(activeBuffer.viewportY).toBe(40);expect(element<HTMLElement>('.cv-unread').hidden).toBe(true);expect(opens).toBe(1);
    const consoleRoot=element('[data-agent-console]'),beforeFits=fits,handle=element('#task-panel-resizer');handle.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}) as unknown as Event);await wait(()=>expect(fits).toBeGreaterThan(beforeFits));expect(element('[data-agent-console]')).toBe(consoleRoot);expect(element('.cv-terminal-host .terminal-instance')).toBe(terminalInstance);expect(opens).toBe(1);
    const terminalEscape=new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});terminalInstance.dispatchEvent(terminalEscape as unknown as Event);expect(terminalEscape.defaultPrevented).toBe(false);expect(element<HTMLElement>('#task-panel').hidden).toBe(false);
    click('[data-detail-tab="console"]');expect(element<HTMLElement>('.cv-scroll').hidden).toBe(false);expect(element<HTMLElement>('.cv-native-terminal').hidden).toBe(true);expect(element('.cv-scroll').textContent).not.toContain('PTY_READY');expect(element('.cv-scroll').textContent).not.toContain('PTY_ACK_42');click('[data-detail-tab="terminal"]');await wait(()=>expect(element('.cv-terminal-host').textContent).toContain('PTY_ACK_42'));expect(element('.cv-terminal-host .terminal-instance')).toBe(terminalInstance);expect(opens).toBe(1);
    expect(window.document.querySelector('[data-action="complete-run"]')).toBeNull();server.service.complete(server.service.snapshot().runs[0]!.id,{success:true,summary:'done'});await wait(()=>expect(server.service.snapshot().runs[0]?.status).toBe('completed'));
    expect(server.service.snapshot().tasks[0]?.status).toBe('review');
  },20000);
  it('merges bounded activity deltas without duplicating messages or replacing a mounted console', async () => {
    await createProject();const project=server.service.snapshot().projects[0]!;
    const task=server.service.createTask({projectId:project.id,title:'Delta terminal fixture',provider:'command',terminalMode:'stream',command:{executable:process.execPath,args:['-e','console.log("initial output");setInterval(()=>{},1000)']}});
    const run=server.service.startTask(task.id);await wait(()=>expect(window.document.querySelector(`[data-open-task="${task.id}"]`)).not.toBeNull());click(`[data-open-task="${task.id}"]`);click('[data-detail-tab="console"]');
    await wait(()=>expect(element('.cv-timeline').textContent).toContain('initial output'));
    const instance=element('[data-agent-console]'),now=new Date().toISOString();
    const delta={events:[{id:'delta-event',runId:run.id,taskId:task.id,type:'stdout',message:'bounded new activity',createdAt:now}],messages:[{id:'delta-message',taskId:task.id,runId:run.id,agentId:null,authorType:'agent',authorName:'Fixture worker',text:'Incremental progress message',createdAt:now}],runs:[{id:run.id,status:'running',lastActivityAt:now,activeMs:72000}]};
    server.service.emit('update',delta);server.service.emit('update',delta);
    await wait(()=>expect(element('.card-activity').textContent).toContain('bounded new activity'));
    expect(element('[data-agent-console]')).toBe(instance);
    expect(element('.cv-timeline').textContent).toContain('initial output');
    expect(element('.task-card').textContent).toContain('1:12');
    click('[data-detail-tab="console"]');expect(element('.conversation-history').textContent).toContain('Incremental progress message');
    expect(window.document.querySelectorAll('.cv-node.cv-assistant')).toHaveLength(1);
    await server.service.stop(run.id);
  },20000);
  it('creates a history fork through the closed task action without starting an agent', async () => {
    await createProject(); const project = server.service.snapshot().projects[0]!;
    const source = server.service.createTask({ projectId: project.id, title: 'Closed conversation', description: 'Original request', status: 'done' });
    server.service.postMessage(source.id, { text: 'Saved context', authorType: 'agent' });
    await wait(() => expect(window.document.querySelector(`[data-open-task="${source.id}"]`)).not.toBeNull());
    click(`[data-open-task="${source.id}"]`); click('[data-action="fork-task"]');
    input('#modal textarea[name="text"]', 'Explore another approach'); submit('#modal form');
    await wait(() => expect(server.service.snapshot().tasks).toHaveLength(2));
    const fork = server.service.snapshot().tasks.find(task => task.id !== source.id)!;
    expect(fork.forkedFromTaskId).toBe(source.id); expect(fork.conversationContext).toContain('Saved context');
    expect(fork.status).toBe('backlog'); expect(server.service.snapshot().runs).toHaveLength(0);
    expect(server.service.task(source.id).status).toBe('done');
  });

  it('shows the conversation of a task resumed for merge recovery, which has no history source to read', async () => {
    await createProject(); const project = server.service.snapshot().projects[0]!;
    const task = server.service.createTask({ projectId: project.id, title: 'Merged after recovery', status: 'done' });
    const resume = { sourceId: '', provider: 'claude' as const, sessionId: 'fe83d9b9-5c3f-41c6-8877-e49efdf4566e', initialMessage: 'Finish the requested merge.' }, at = new Date().toISOString();
    server.service.store.state.runs.push({ id: 'run_merge_recovery', taskId: task.id, status: 'completed', provider: 'claude', startedAt: at, finishedAt: at, exitCode: 0, executionMode: 'native', pendingCommands: [], continuation: 0, historyResume: resume });
    Object.assign(server.service.task(task.id), { historyResume: resume, currentRunId: 'run_merge_recovery' });
    server.service.postMessage(task.id, { text: 'Merge conflicts are queued for agent resolution.', authorType: 'agent' });
    const lookups = vi.spyOn(server.service.history, 'list');
    await wait(() => expect(window.document.querySelector(`[data-open-task="${task.id}"]`)).not.toBeNull()); click(`[data-open-task="${task.id}"]`);
    await wait(() => expect(element('.task-panel').textContent).toContain('Merge conflicts are queued for agent resolution.'));
    // The transcript request is asynchronous; give a wrong one time to fail before asserting it never happened.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // The board prefetches the session list (limit 30); the task transcript must not request it as if it were one session.
    expect(element('.task-panel').textContent).not.toContain('not iterable'); expect(lookups.mock.calls.some(([, query]) => (query as Record<string, string>).limit === '100')).toBe(false);
  });

  it('offers a new session with history instead of resuming a failed session', async () => {
    await createProject(); const project = server.service.snapshot().projects[0]!;
    const source = server.service.createTask({ projectId: project.id, title: 'Failed resume', status: 'failed' });
    const at = new Date().toISOString();
    server.service.store.state.runs.push({ id: 'run_resume_fixture', taskId: source.id, status: 'failed', provider: 'codex', startedAt: at, finishedAt: at, exitCode: 1, executionMode: 'native', pendingCommands: [], continuation: 0, historyResume: { sourceId: 'hist_missing', provider: 'codex', sessionId: '11111111-1111-4111-8111-111111111111', initialMessage: 'Resume instruction' } });
    server.service.task(source.id).currentRunId = 'run_resume_fixture';
    server.service.postMessage(source.id, { text: 'Saved history', authorType: 'agent' });
    const send = vi.spyOn(server.service, 'sendTaskMessage').mockImplementation(async (id, input: any) => server.service.postMessage(id, { text: input.text, authorType: 'user' }));
    await wait(() => expect(window.document.querySelector(`[data-open-task="${source.id}"]`)).not.toBeNull()); click(`[data-open-task="${source.id}"]`); click('[data-detail-tab="console"]');
    await wait(() => expect(element('#task-message-form [type=submit]').textContent).toBe('Geçmişle yeni oturum')); expect(send).not.toHaveBeenCalled();
    input('#task-message-input', 'Keep this instruction'); submit('#task-message-form');
    await wait(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[1]).toMatchObject({ text: 'Keep this instruction', continueSession: true, allowHistoryFallback: true });
  });

  it('requeues completed tasks and requires approval before starting a new session with saved history', async () => {
    await createProject(); const project = server.service.snapshot().projects[0]!;
    const source = server.service.createTask({ projectId: project.id, title: 'Reopen completed work', status: 'done', provider: 'codex' });
    const at = new Date().toISOString();
    server.service.store.state.runs.push({ id: 'run_requeue_fixture', taskId: source.id, status: 'completed', provider: 'codex', startedAt: at, finishedAt: at, exitCode: 0, executionMode: 'native', pendingCommands: [], continuation: 0 });
    server.service.task(source.id).currentRunId = 'run_requeue_fixture';
    server.service.postMessage(source.id, { text: 'Saved history', authorType: 'agent' });
    await wait(() => expect(window.document.querySelector(`[data-open-task="${source.id}"]`)).not.toBeNull());
    selectTask(source.id); input('#bulk-task-status', 'ready'); click('#move-selected-tasks');
    await wait(() => expect(server.service.task(source.id).status).toBe('ready'));
    // Live updates never pop a dialog; the open task shows the question as a notice in its console.
    await new Promise(resolve => setTimeout(resolve, 300)); expect(element('#modal').hasAttribute('open')).toBe(false);
    expect(server.service.snapshot().runs).toHaveLength(1);
    click(`[data-open-task="${source.id}"]`); click('[data-detail-tab="console"]');
    await wait(() => expect(element('.queued-history-notice').textContent).toContain('yeni bir oturum'));
    click('[data-queued-history-dismiss]'); await wait(() => expect(window.document.querySelector('.queued-history-notice')).toBeNull());
    await wait(() => expect(window.document.querySelector('[data-action="confirm-queued-history"]')).not.toBeNull());
    const start = vi.spyOn(server.service, 'startQueuedTask').mockImplementation(async (id, value: any) => {
      expect(id).toBe(source.id); expect(value.allowHistoryFallback).toBe(true);
      delete server.service.task(id).queuedContinuation;
      return server.service.run('run_requeue_fixture');
    });
    // The header button asks in the app's own dialog; declining starts nothing.
    click('[data-action="confirm-queued-history"]'); await wait(() => expect(element('#modal').textContent).toContain('yeni bir oturum'));
    click('#modal [data-action="close-modal"]'); await wait(() => expect(element('#modal').hasAttribute('open')).toBe(false)); expect(start).not.toHaveBeenCalled();
    click('[data-action="confirm-queued-history"]'); submit('#modal form');
    await wait(() => expect(start).toHaveBeenCalledTimes(1));
  });

  it('lists the general workspace first under the workspace label and manages recurring schedules there', async () => {
    await withLibrary();
    const workspace = server.service.snapshot().generalWorkspace!;
    expect(element('#project-list').firstElementChild?.id).toBe('workspace-nav');
    expect(element('#workspace-nav').textContent).toContain('Genel çalışma alanı');
    expect(element('.library-nav').textContent).not.toContain('Genel çalışma alanı');
    click('#workspace-nav');
    await wait(() => expect(element('#breadcrumb-project').textContent).toBe('Genel çalışma alanı'));
    expect(element('#workspace-nav').classList.contains('active')).toBe(true);
    expect(element('#project-tab-schedules').classList.contains('active')).toBe(true);
    expect(element('#project-tab-settings').hidden).toBe(true);
    expect(element('#board').textContent).toContain(workspace.repositoryPath);
    expect(element('#create-task').textContent).toContain('Yeni zamanlama');
    click('[data-action="new-schedule"]'); assertModalShell();
    // The essentials stay in view: name, instructions with compact agent pickers, repeat and time; the rest is under Advanced.
    for (const id of ['#field-agentId', '#field-provider', '#field-model-choice']) expect(element(`.schedule-composer-bar ${id}`)).toBeTruthy();
    expect(element('.schedule-when-row #field-scheduleKind')).toBeTruthy(); expect(element('.schedule-when-row #field-times')).toBeTruthy();
    expect(element<HTMLDetailsElement>('.schedule-advanced').open).toBe(false);
    for (const id of ['#field-timezone', '#field-startAt', '#field-overlap', '#field-catchUp', '#field-terminalMode', '#field-workflowId']) expect(element(`.schedule-advanced ${id}`)).toBeTruthy();
    expect(element('.modal-footer .schedule-enabled input[name="enabled"]')).toBeTruthy();
    expect(window.document.querySelector('#field-name')).toBeNull();
    input('#field-title', 'Haftalık rapor'); input('#field-description', 'Rapor yaz');
    edit('#field-scheduleKind', 'weekly');
    expect(element('[data-kind-panel="weekly"]').hidden).toBe(false); expect(element('[data-kind-panel="cron"]').hidden).toBe(true);
    for (const box of window.document.querySelectorAll<HTMLInputElement>('input[name="weekdays"]') as unknown as HTMLInputElement[]) box.checked = ['1', '3'].includes(box.value);
    edit('#field-times', '9:00, 18:30'); edit('#field-timezone', 'Europe/Istanbul');
    await wait(() => expect(element('#schedule-preview').querySelectorAll('li')).toHaveLength(3));
    expect(element('#schedule-preview .source-badge').textContent).toBe('Europe/Istanbul');
    edit('#field-provider', 'command'); input('#field-executable', process.execPath); input('#field-args', '["-e","1"]');
    submit('#modal form');
    await wait(() => expect(server.service.snapshot().schedules).toHaveLength(1));
    const schedule = server.service.snapshot().schedules[0]!;
    expect(schedule).toMatchObject({ projectId: workspace.id, name: 'Haftalık rapor', timezone: 'Europe/Istanbul', recurrence: { kind: 'daily', times: ['09:00', '18:30'], weekdays: [1, 3] }, task: { title: 'Haftalık rapor', description: 'Rapor yaz', provider: 'command', command: { executable: process.execPath, args: ['-e', '1'] } } });
    await wait(() => expect(element('.schedule-card').textContent).toContain('09:00, 18:30'));
    // Pausing from the card keeps the definition and drops the next run.
    (element(`[data-toggle-schedule="${schedule.id}"]`) as HTMLInputElement).checked = false; commit(`[data-toggle-schedule="${schedule.id}"]`);
    await wait(() => expect(server.service.snapshot().schedules[0]).toMatchObject({ enabled: false, nextRunAt: null }));
    await wait(() => expect(element('.schedule-card').classList.contains('is-disabled')).toBe(true));
    click(`[data-run-schedule="${schedule.id}"]`);
    await wait(() => expect(server.service.snapshot().tasks.filter((task) => task.scheduleId === schedule.id)).toHaveLength(1));
    // The workspace board lists its own tasks, marked with their schedule.
    click('#project-tab-board');
    await wait(() => expect(element('.card-schedule.recurring').textContent).toContain('Haftalık rapor'));
    click('#project-tab-schedules');
    await wait(() => expect(element(`[data-edit-schedule="${schedule.id}"]`)).toBeTruthy());
    click(`[data-edit-schedule="${schedule.id}"]`);
    expect(element<HTMLSelectElement>('#field-scheduleKind').value).toBe('weekly');
    edit('#field-scheduleKind', 'cron'); edit('#field-expression', '0 7 1 * *');
    submit('#modal form');
    await wait(() => expect(server.service.snapshot().schedules[0]!.recurrence).toEqual({ kind: 'cron', expression: '0 7 1 * *' }));
    // Renaming the schedule renames the task it creates.
    click(`[data-edit-schedule="${schedule.id}"]`); input('#field-title', 'Aylık rapor'); submit('#modal form');
    await wait(() => expect(server.service.snapshot().schedules[0]).toMatchObject({ name: 'Aylık rapor', task: { title: 'Aylık rapor' } }));
    const css = await uiStyleSource();
    expect(css).toContain('.schedules-board{display:block;width:100%;max-width:none}');
    click(`[data-edit-schedule="${schedule.id}"]`); click(`[data-delete-schedule="${schedule.id}"]`); submit('#modal form');
    await wait(() => expect(server.service.snapshot().schedules).toHaveLength(0));
    expect(server.service.snapshot().tasks).toHaveLength(1);
  });

  it('shows on the schedule card why its last task cannot start', async () => {
    await createProject(); const project = server.service.snapshot().projects[0]!;
    const schedule = server.service.schedules.create({ projectId: project.id, timezone: 'UTC', recurrence: { kind: 'interval', every: 1, unit: 'hours' }, task: { title: 'Saatlik not', provider: 'command', command: { executable: process.execPath, args: ['-e', '1'] } } });
    const dependency = server.service.createTask({ projectId: project.id, title: 'Bitmemiş bağımlılık', status: 'backlog' });
    const blocked = server.service.schedules.runNow(schedule.id);
    server.service.store.state.tasks.find((task) => task.id === blocked.id)!.dependsOn = [dependency.id];
    await wait(() => expect(server.service.task(blocked.id).queueReason).toBeTruthy());
    click('#project-tab-schedules');
    await wait(() => expect(element('.schedule-outcome.blocked').textContent).toContain(server.service.task(blocked.id).queueReason!));
    click(`.schedule-outcome.blocked [data-open-task="${blocked.id}"]`);
    await wait(() => expect(element('#task-panel').textContent).toContain('Saatlik not'));
  });

  it('schedules a project task for later and shows it in the schedules tab and details instead of on the board', async () => {
    await createProject(); const project = server.service.snapshot().projects[0]!;
    click('#create-task'); input('#field-title', 'Sonra başlat'); edit('#field-status', 'ready');
    const later = new Date(Date.now() + 3 * 3600_000); later.setSeconds(0, 0);
    const local = `${later.getFullYear()}-${String(later.getMonth() + 1).padStart(2, '0')}-${String(later.getDate()).padStart(2, '0')}T${String(later.getHours()).padStart(2, '0')}:${String(later.getMinutes()).padStart(2, '0')}`;
    edit('#field-scheduledAt', local);
    expect(element('#task-tab-triggers .task-option-count').textContent).toBe('1');
    submit('#modal form');
    await wait(() => expect(server.service.snapshot().tasks[0]).toMatchObject({ title: 'Sonra başlat', status: 'ready', scheduledAt: later.toISOString() }));
    const task = server.service.snapshot().tasks[0]!;
    // A task waiting for its start time stays off the board; the schedules tab lists it.
    expect(window.document.querySelector(`#board [data-open-task="${task.id}"]`)).toBeNull();
    expect(element('#task-count').textContent).toContain('0 görev');
    // It waits instead of starting.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(server.service.task(task.id)).toMatchObject({ status: 'ready', currentRunId: null });
    click('#project-tab-schedules');
    await wait(() => expect(element('.scheduled-task-row').textContent).toContain('Sonra başlat'));
    expect(element('.library-empty').textContent).toContain('Henüz zamanlama yok.');
    click(`.scheduled-task-row`);
    await wait(() => expect(element('[data-detail-tab="info"]')).toBeTruthy()); click('[data-detail-tab="info"]');
    await wait(() => expect(element<HTMLInputElement>('#info-scheduledAt').value).toBe(local));
    commit('#info-scheduledAt', '');
    await wait(() => expect(server.service.task(task.id).scheduledAt).toBeUndefined());
    click('#project-tab-board');
    await wait(() => expect(element(`#board [data-open-task="${task.id}"]`)).toBeTruthy());
    expect(project.id).toBe(task.projectId);
  });

});
